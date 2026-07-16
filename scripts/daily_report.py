#!/usr/bin/env python3
"""
Daily league activity digest. Per-team, filtered by notification_prefs.

Each team gets the events they've opted into at frequency=daily (instant
events also flow into the digest if they want a daily summary on top).
Jeff (or anyone else with receive_all=true on their notification_prefs row)
gets an everything-feed regardless of category prefs.

Schedule: nightly 9pm via cron.
"""

import json
import os
import sys
from datetime import datetime, timedelta, timezone

try:
    from zoneinfo import ZoneInfo
    _ET = ZoneInfo("America/New_York")
except Exception:
    _ET = timezone.utc  # Fallback; runner without tzdata will see UTC labels.

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _notify_db import (  # noqa: E402
    load_env, fetch_activity_since, fetch_all_owners, fetch_emails_by_user_id,
    fetch_notify_prefs, fetch_league_state_row, upsert_league_state_row,
    event_category, describe_activity, team_name, parse_ts, APP_URL,
)
from _email_template import render_digest  # noqa: E402
from _mail import send_email  # noqa: E402


# Idempotency marker (league_state). Shape: {"lastSentThrough": "<iso>"}.
# The digest window is (lastSentThrough, now] so cron jitter and manual
# re-runs never drop or double-send events.
MARKER_KEY = "digest_daily_marker"
DEFAULT_WINDOW = timedelta(hours=24)
MIN_GAP = timedelta(hours=12)  # refuse to re-send sooner than this


def build_team_addresses(owners, all_prefs, emails_by_uid):
    """Per-team SET of recipient addresses: every owner's email plus the
    team-level broadcast address if set. Mirrors notify_instant.py — a
    broadcast address adds to (never replaces) individual owner emails, and
    the set dedupes co-manager teams like Josh/Doug."""
    emails_by_team = {}
    for o in owners:
        tid = o.get("team_id"); uid = o.get("id")
        if not tid or not uid: continue
        addr = emails_by_uid.get(uid)
        if addr:
            emails_by_team.setdefault(tid, set()).add(addr)
    for tid, row in (all_prefs or {}).items():
        broadcast = (row or {}).get("email")
        if broadcast:
            emails_by_team.setdefault(tid, set()).add(broadcast)
    return emails_by_team


# Sections shown in the per-team digest, in display order.
SECTION_ORDER = [
    ("trade_proposal", "Trade Proposals",     "?tab=trades&sub=inbox", "proposal"),
    ("trade_update",   "Trade Updates",        "?tab=trades&sub=inbox", "proposal"),
    ("trade_message",  "Trade Messages",       "?tab=trades&sub=inbox", "message"),
    ("trade_completed","Trades Completed",     "?tab=trades&sub=log",   "trade"),
    ("keeper_protect", "Keeper Protections",   "?tab=eligible",         "keeper"),
    ("rule5_protect",  "Rule 5 Protections",   "?tab=eligible",         "rule5"),
    ("callup",         "Call-ups",             "?tab=rosters",          "callup"),
    ("send_down",      "Send-downs",           "?tab=rosters",          "send-down"),
    ("draft_picks",    "Draft Picks",          "?tab=draft",            "draft"),
]


def group_by_category(activity):
    out = {key: [] for key, _, _, _ in SECTION_ORDER}
    for a in activity:
        cat = event_category(a.get("type"))
        if cat in out:
            out[cat].append(a)
    return out


def build_sections(grouped, prefs, *, receive_all, target_frequency="daily"):
    """For each category in SECTION_ORDER, include events if:
        - receive_all is True, OR
        - the team's prefs[cat].email == target_frequency
    The 'daily' digest also folds in 'instant' events from the same window so
    you get a recap of what already pinged you.
    """
    sections = []
    folded = {"instant", target_frequency}  # daily digest also recaps instant
    for cat_key, title, url_suffix, _tag in SECTION_ORDER:
        items = grouped.get(cat_key) or []
        if not items:
            continue
        if not receive_all:
            cur = prefs.get(cat_key) or {}
            if cur.get("email") not in folded:
                continue
        body_items = []
        for a in items:
            headline = describe_activity(a)
            tag_key = {
                "trade_proposal": "proposal", "trade_update": "proposal",
                "trade_message": "message",  "trade_completed": "trade",
                "keeper_protect": "keeper",  "rule5_protect": "rule5",
                "callup": "callup", "send_down": "send-down", "draft_picks": "draft",
            }.get(cat_key, "default")
            tag_label = {
                "trade_proposal": "PROPOSAL", "trade_update": "UPDATE",
                "trade_message": "MESSAGE",   "trade_completed": "TRADE",
                "keeper_protect": "KEEPER",   "rule5_protect": "RULE 5",
                "callup": "CALL-UP", "send_down": "SEND-DOWN", "draft_picks": "DRAFT",
            }.get(cat_key, "EVENT")
            ts = a.get("created_at") or ""
            sub = ""
            if ts:
                try:
                    from _notify_db import parse_ts
                    dt = parse_ts(ts)
                    if dt: sub = dt.astimezone().strftime("%I:%M %p")
                except Exception:
                    pass
            body_items.append({
                "headline": headline,
                "sub": sub,
                "tag": (tag_label, tag_key),
            })
        sections.append({
            "title": title,
            "url": APP_URL + url_suffix,
            "items": body_items,
        })
    return sections


def main():
    env = load_env()
    key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    smtp_user = env.get("SMTP_USER")
    smtp_pass = env.get("SMTP_PASS")
    if not key:
        print("SUPABASE_SERVICE_ROLE_KEY not set", file=sys.stderr); sys.exit(1)

    now_dt = datetime.now(timezone.utc)
    now_iso = now_dt.strftime("%Y-%m-%dT%H:%M:%SZ")

    marker = fetch_league_state_row(key, MARKER_KEY) or {}
    last_through = parse_ts(marker.get("lastSentThrough"))
    if last_through and now_dt - last_through < MIN_GAP:
        print(f"Daily digest already sent through {marker.get('lastSentThrough')} "
              f"(< {MIN_GAP} ago); skipping.")
        return
    since_dt = last_through or (now_dt - DEFAULT_WINDOW)

    since_iso = since_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    activity = fetch_activity_since(key, since_iso=since_iso, limit=1000) or []
    # Clamp to the (lastSentThrough, now] window — the fetch is >=, and events
    # landing while we run belong to the NEXT digest.
    def _in_window(a):
        ts = parse_ts(a.get("created_at"))
        return ts is not None and since_dt < ts <= now_dt
    activity = [a for a in activity if _in_window(a)]
    grouped = group_by_category(activity)

    owners = fetch_all_owners(key) or []
    emails_by_uid = fetch_emails_by_user_id(key)
    all_prefs = fetch_notify_prefs(key)
    emails_by_team = build_team_addresses(owners, all_prefs, emails_by_uid)

    # ET label so the digest matches recipients' calendars (cron fires at 01:07
    # UTC = 9:07 PM ET the prior day; using runner-local TZ would show the next
    # calendar day on GitHub Actions where the runner is UTC).
    now_label = datetime.now(timezone.utc).astimezone(_ET).strftime("%A, %b %d, %Y")
    today_subtitle = f"Daily digest · {now_label}"

    sent = []
    attempted = 0
    for team_id in sorted(emails_by_team):
        receive_all = bool((all_prefs.get(team_id) or {}).get("receive_all"))
        prefs = (all_prefs.get(team_id) or {}).get("prefs") or {}
        sections = build_sections(grouped, prefs, receive_all=receive_all, target_frequency="daily")
        if not sections:
            continue  # nothing to send this team today
        title = f"The League — daily digest"
        greeting = f"Hi {team_name(team_id)}, here's what happened in the league over the last 24 hours."
        if receive_all:
            greeting += " (You're set to receive every league event.)"
        html, text = render_digest(title, today_subtitle, sections, greeting=greeting)
        n = sum(len(s["items"]) for s in sections)
        subject = f"The League: Daily digest — {n} event{'s' if n != 1 else ''}"
        for addr in sorted(emails_by_team[team_id]):
            if smtp_user and smtp_pass:
                attempted += 1
                try:
                    send_email(smtp_user, smtp_pass, [addr], subject, html, text)
                    sent.append((team_id, addr, n))
                except Exception as e:
                    print(f"  ! failed for {team_id} {addr}: {e}", file=sys.stderr)
            else:
                # Print previews if SMTP isn't configured.
                print(f"[preview] would email {team_id} <{addr}> — {n} events")
    if sent:
        print(f"Sent {len(sent)} digest(s):")
        for t, a, n in sent:
            print(f"  {t} <{a}> ({n} events)")
    else:
        print("No digests sent.")

    # Advance the marker only AFTER sends complete. If every attempted send
    # failed (SMTP outage), hold the marker so the whole window retries next
    # run; a partial failure still advances (the alternative double-sends
    # everyone who already got theirs). Preview mode never advances.
    if attempted and not sent:
        print("  ! all sends failed; holding digest marker for retry.", file=sys.stderr)
        return
    if smtp_user and smtp_pass:
        upsert_league_state_row(key, MARKER_KEY, {"lastSentThrough": now_iso})


if __name__ == "__main__":
    main()
