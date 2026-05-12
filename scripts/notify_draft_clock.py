#!/usr/bin/env python3
"""
Draft clock notifier — runs every 2-3 minutes via cron.

Reads the current minors-draft state and identifies which team is
"on the clock", "on deck" (next pick), and "in the hole" (two picks away).
For each, if that team's notification_prefs.draft_clock[state].{email,push}
is enabled AND we haven't already notified them about this specific
pick-slot, fires the notification and records it in
league_state.notify_draft_marker.
"""

import json
import os
import sys
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _notify_db import (
    SUPABASE_URL, APP_URL,
    load_env, fetch_all_owners, fetch_emails_by_user_id,
    fetch_notify_prefs, fetch_push_subs, fetch_league_state_row,
    upsert_league_state_row, team_name,
)
from _email_template import render_alert
from _mail import send_email
from _push import send_push, to_subscription_info, is_gone


MARKER_KEY = "notify_draft_marker"
STATE_LABELS = {"on_clock": "On the clock", "on_deck": "On deck", "in_hole": "In the hole"}


def get_pick_owner(draft, round_num, pick_in_round):
    """Mirror of getPickOwner in app.js."""
    traded = (draft.get("tradedPicks") or {})
    key = f"{round_num}p{pick_in_round}"
    if key in traded: return traded[key]
    base = draft.get("baseOrder") or []
    if draft.get("type") == "snake" and round_num % 2 == 0:
        return base[len(base) - pick_in_round] if 0 <= len(base) - pick_in_round < len(base) else None
    return base[pick_in_round - 1] if 0 <= pick_in_round - 1 < len(base) else None


def current_pick_info(draft):
    """Find the next un-made, un-passed pick."""
    picks = draft.get("picks") or []
    passed = draft.get("passed") or []
    made_keys = {f"{p['round']}p{p['pickInRound']}" for p in picks}
    passed_keys = {f"{p['round']}p{p['pickInRound']}" for p in passed}
    rounds = draft.get("rounds") or 0
    teams_n = len(draft.get("baseOrder") or [])
    overall = 0
    for r in range(1, rounds + 1):
        for pir in range(1, teams_n + 1):
            overall += 1
            k = f"{r}p{pir}"
            if k in made_keys or k in passed_keys:
                continue
            return {
                "round": r, "pickInRound": pir, "overall": overall,
                "team": get_pick_owner(draft, r, pir), "key": k,
            }
    return None


def neighbor_pick(draft, current, offset):
    """The pick `offset` slots after current (offset=1 → on deck, 2 → in hole)."""
    if not current: return None
    rounds = draft.get("rounds") or 0
    teams_n = len(draft.get("baseOrder") or [])
    overall = current["overall"] + offset
    if overall > rounds * teams_n: return None
    # Walk forward, skipping passed/made picks.
    picks = draft.get("picks") or []
    passed = draft.get("passed") or []
    made_keys = {f"{p['round']}p{p['pickInRound']}" for p in picks}
    passed_keys = {f"{p['round']}p{p['pickInRound']}" for p in passed}
    seen = current["overall"]
    for r in range(current["round"], rounds + 1):
        start_pir = current["pickInRound"] + 1 if r == current["round"] else 1
        for pir in range(start_pir, teams_n + 1):
            k = f"{r}p{pir}"
            if k in made_keys or k in passed_keys:
                continue
            seen += 1
            if (seen - current["overall"]) == offset:
                return {
                    "round": r, "pickInRound": pir,
                    "team": get_pick_owner(draft, r, pir), "key": k,
                }
    return None


def main():
    env = load_env()
    key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    smtp_user = env.get("SMTP_USER")
    smtp_pass = env.get("SMTP_PASS")
    vapid_priv = (env.get("VAPID_PRIVATE_KEY") or "").replace("\\n", "\n")
    vapid_sub  = env.get("VAPID_SUBJECT") or "mailto:jwarshafsky@gmail.com"
    if not key:
        print("SUPABASE_SERVICE_ROLE_KEY not set", file=sys.stderr); sys.exit(1)

    draft = fetch_league_state_row(key, "draft_2027")
    if not draft:
        print("No draft state."); return
    if not (draft.get("baseOrder") and len(draft["baseOrder"]) == 12):
        print("Draft not initialized."); return

    cur = current_pick_info(draft)
    if not cur:
        print("Draft complete."); return
    on_deck = neighbor_pick(draft, cur, 1)
    in_hole = neighbor_pick(draft, cur, 2)
    slots = []
    if cur:     slots.append(("on_clock", cur))
    if on_deck: slots.append(("on_deck",  on_deck))
    if in_hole: slots.append(("in_hole",  in_hole))

    marker = fetch_league_state_row(key, MARKER_KEY) or {}
    # marker structure: { "<team_id>": { "on_clock": "<pick-key>", "on_deck": "...", "in_hole": "..." } }

    owners = fetch_all_owners(key) or []
    emails_by_uid = fetch_emails_by_user_id(key)
    all_prefs = fetch_notify_prefs(key)
    push_subs = fetch_push_subs(key)
    push_by_team = {}
    for s in push_subs:
        push_by_team.setdefault(s["team_id"], []).append(s)
    email_by_team = {}
    for o in owners:
        addr = (all_prefs.get(o["team_id"]) or {}).get("email") or emails_by_uid.get(o["id"])
        if addr: email_by_team[o["team_id"]] = addr

    notify_count = 0
    push_failed_endpoints = []
    for state_key, pick in slots:
        team_id = pick["team"]
        if not team_id: continue
        # Idempotency: did we already notify this team about this pick-slot?
        prev = (marker.get(team_id) or {}).get(state_key)
        if prev == pick["key"]:
            continue
        prefs_row = all_prefs.get(team_id) or {}
        prefs = prefs_row.get("prefs") or {}
        dc = (prefs.get("draft_clock") or {}).get(state_key) or {}
        wants_email = bool(dc.get("email"))
        wants_push  = bool(dc.get("push"))
        if not (wants_email or wants_push):
            # Record marker even if nothing to send, so we don't re-evaluate
            # next run (the team has actively opted out of this slot).
            marker.setdefault(team_id, {})[state_key] = pick["key"]
            continue
        title = f"{STATE_LABELS[state_key]} — R{pick['round']}.{pick['pickInRound']}"
        body = f"Your team ({team_name(team_id)}) is {STATE_LABELS[state_key].lower()} for the Minors Draft (Round {pick['round']}, Pick {pick['pickInRound']})."
        url = APP_URL + "?tab=draft"
        if wants_email:
            addr = email_by_team.get(team_id)
            if addr and smtp_user and smtp_pass:
                try:
                    html, text = render_alert(title, body, url=url, cta_label="Open Minors Draft")
                    send_email(smtp_user, smtp_pass, [addr], f"Draft alert: {title}", html, text)
                    notify_count += 1
                except Exception as e:
                    print(f"  ! email failed for {team_id}: {e}", file=sys.stderr)
            elif addr:
                print(f"[preview] would email {team_id} <{addr}> — {title}")
        if wants_push and vapid_priv:
            for sub in push_by_team.get(team_id, []):
                payload = {
                    "title": title,
                    "body": body,
                    "url": url,
                    "tag": f"the-league-draftclock-{state_key}-{pick['key']}",
                }
                try:
                    send_push(to_subscription_info(sub), payload, vapid_priv, vapid_sub)
                    notify_count += 1
                except Exception as e:
                    if is_gone(e): push_failed_endpoints.append(sub["endpoint"])
                    else: print(f"  ! push failed for {team_id}: {e}", file=sys.stderr)
        marker.setdefault(team_id, {})[state_key] = pick["key"]

    # Prune dead push subs.
    if push_failed_endpoints:
        import urllib.parse
        for endpoint in set(push_failed_endpoints):
            try:
                url = f"{SUPABASE_URL}/rest/v1/push_subscriptions?endpoint=eq.{urllib.parse.quote(endpoint, safe='')}"
                req = urllib.request.Request(url, method="DELETE", headers={
                    "apikey": key, "Authorization": f"Bearer {key}",
                })
                urllib.request.urlopen(req, timeout=10)
            except Exception: pass

    upsert_league_state_row(key, MARKER_KEY, marker)
    print(f"Draft clock: {notify_count} notification(s) sent.")


if __name__ == "__main__":
    main()
