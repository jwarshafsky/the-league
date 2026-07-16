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
    upsert_league_state_row, team_name, parse_ts,
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


# --- Clock math (Python port of js/app.js activeDraftElapsedMs) ---
# Active hours are 8 AM – midnight ET. The draft clock is 4 hours of active
# time. Overnight (midnight–8 AM ET) is automatically excluded.

DRAFT_CLOCK_MS = 4 * 60 * 60 * 1000
ACTIVE_START_HOUR = 8
ACTIVE_END_HOUR = 24


def _et_parts(utc_ms):
    """Return {year,month,day,hour,minute} in America/New_York for a UTC ms."""
    try:
        from zoneinfo import ZoneInfo
        dt = datetime.fromtimestamp(utc_ms / 1000, tz=timezone.utc).astimezone(ZoneInfo("America/New_York"))
    except Exception:
        # Fallback for systems without zoneinfo — assume EST/EDT manually.
        # Conservative: assume EDT (UTC-4) Mar-Nov, EST (UTC-5) otherwise.
        from datetime import timedelta as _td
        m = datetime.fromtimestamp(utc_ms / 1000, tz=timezone.utc).month
        offset = -4 if 3 <= m <= 11 else -5
        dt = datetime.fromtimestamp(utc_ms / 1000, tz=timezone.utc) + _td(hours=offset)
    return dt.year, dt.month, dt.day, dt.hour, dt.minute


def _et_ms_at(year, month, day, hour, minute):
    """UTC ms representing the given wall-clock time in America/New_York."""
    try:
        from zoneinfo import ZoneInfo
        # Normalize: handle day rollover (day+1 etc.)
        from datetime import timedelta as _td
        base = datetime(year, month, 1, tzinfo=ZoneInfo("America/New_York"))
        dt = base + _td(days=day - 1, hours=hour, minutes=minute)
        return int(dt.timestamp() * 1000)
    except Exception:
        m = month
        offset = -4 if 3 <= m <= 11 else -5
        dt = datetime(year, month, day, hour, minute, tzinfo=timezone.utc)
        # subtract the ET offset to get back to UTC
        from datetime import timedelta as _td
        dt = dt - _td(hours=offset)
        return int(dt.timestamp() * 1000)


def active_elapsed_ms(from_ms, to_ms):
    """Active draft time (excluding 12am–8am ET) between two UTC ms values."""
    if to_ms <= from_ms: return 0
    total = 0
    cursor = from_ms
    for _ in range(60):  # safety cap
        if cursor >= to_ms: break
        y, mo, d, h, _ = _et_parts(cursor)
        is_active = ACTIVE_START_HOUR <= h < ACTIVE_END_HOUR
        if is_active:
            seg_end = _et_ms_at(y, mo, d + 1, 0, 0)  # next midnight ET
        else:
            seg_end = _et_ms_at(y, mo, d, ACTIVE_START_HOUR, 0)  # today 8am ET
        eff_end = min(seg_end, to_ms)
        if is_active: total += (eff_end - cursor)
        cursor = eff_end
    return total


def clock_state(draft, now_ms):
    """Returns (started, paused, expired, remaining_ms)."""
    clk = draft.get("clock") or {}
    started_at = clk.get("startedAt")
    if not started_at: return False, False, False, DRAFT_CLOCK_MS
    started_ms = int(parse_ts(started_at).timestamp() * 1000)
    paused = bool(clk.get("paused"))
    paused_at = clk.get("pausedAt")
    ref_ms = int(parse_ts(paused_at).timestamp() * 1000) if (paused and paused_at) else now_ms
    elapsed = active_elapsed_ms(started_ms, ref_ms)
    remaining = max(0, DRAFT_CLOCK_MS - elapsed)
    return True, paused, remaining <= 0, remaining


def current_pick_info(draft):
    """Find the next un-made, un-passed pick."""
    # Commish-ended draft: no current pick (mirrors getCurrentPickInfo in app.js).
    if draft.get("endedAt"): return None
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


def rule5_current_pick(state):
    """Mirror of getRule5CurrentPick in app.js — snake order, end-of-round termination."""
    if state.get("endedAt"): return None  # commish-ended draft
    order = state.get("order") or []
    n = len(order)
    if n == 0: return None
    picks = state.get("picks") or []
    N = len(picks)
    rnd = (N // n) + 1
    idx = N % n
    team_idx = (n - 1 - idx) if (rnd % 2 == 0) else idx
    team_id = order[team_idx] if 0 <= team_idx < n else None
    # End if previous full round was all passes.
    if N >= n:
        prev_round = picks[N - n:N]
        if all(p.get("pass") for p in prev_round):
            return None
    return {"round": rnd, "idx": idx, "teamId": team_id}


def auto_skip_rule5(key, state):
    """Push pass entries for expired Rule 5 picks and persist."""
    skipped = 0
    for _ in range(50):
        cur = rule5_current_pick(state)
        if not cur: break
        started, paused, expired, _rem = clock_state(state, int(datetime.now(timezone.utc).timestamp() * 1000))
        if not started or paused or not expired: break
        picks = state.setdefault("picks", [])
        # Idempotency guard, matches the client-side check.
        if any(p.get("round") == cur["round"] and p.get("idx") == cur["idx"] and p.get("pass") for p in picks):
            break
        picks.append({
            "round": cur["round"], "idx": cur["idx"], "teamId": cur["teamId"],
            "pass": True, "timestamp": int(datetime.now(timezone.utc).timestamp() * 1000),
            "auto": True,
        })
        state["clock"] = {
            "startedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "paused": False, "pausedAt": None,
        }
        try:
            urllib.request.urlopen(urllib.request.Request(
                f"{SUPABASE_URL}/rest/v1/activity_log",
                method="POST",
                data=json.dumps({
                    "type": "rule5_pick_auto_skipped",
                    "actor_team_id": None,
                    "target_team_id": cur["teamId"],
                    "payload": {"round": cur["round"], "idx": cur["idx"] + 1},
                }).encode("utf-8"),
                headers={
                    "apikey": key, "Authorization": f"Bearer {key}",
                    "Content-Type": "application/json",
                },
            ), timeout=10)
        except Exception as e:
            print(f"  ! rule5 activity_log insert failed: {e}", file=sys.stderr)
        skipped += 1
    if skipped:
        upsert_league_state_row(key, "rule5", state)
        print(f"Auto-skipped {skipped} expired Rule 5 pick(s).")
    return skipped


def main():
    env = load_env()
    key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    smtp_user = env.get("SMTP_USER")
    smtp_pass = env.get("SMTP_PASS")
    vapid_priv = (env.get("VAPID_PRIVATE_KEY") or "").replace("\\n", "\n")
    vapid_sub  = env.get("VAPID_SUBJECT") or "mailto:jwarshafsky@gmail.com"
    if not key:
        print("SUPABASE_SERVICE_ROLE_KEY not set", file=sys.stderr); sys.exit(1)

    # ------------------------------------------------------------------
    # Auto-START drafts at scheduled times. Reads key_dates and starts
    # the relevant draft if its scheduled time has passed and the draft
    # isn't already running. Commissioner can still manually start
    # earlier (or stop) at any time — we only auto-start, we don't
    # auto-stop a started draft.
    # ------------------------------------------------------------------
    key_dates = fetch_league_state_row(key, "key_dates") or {}
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    # Only auto-start within a week of the scheduled time. key_dates keeps
    # last season's dates until the commish updates them, and a year-old
    # "passed" date must not start next season's draft (that's how the
    # 2027 Minors Draft clock started itself in May 2026).
    AUTO_START_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
    def _date_passed(iso):
        if not iso: return False
        try:
            sched_ms = int(parse_ts(iso).timestamp() * 1000)
            return sched_ms <= now_ms <= sched_ms + AUTO_START_WINDOW_MS
        except Exception:
            return False

    rule5_state = fetch_league_state_row(key, "rule5")
    rule5_scheduled = key_dates.get("rule5_draft")
    if rule5_state and rule5_state.get("order") and not rule5_state.get("started") and not rule5_state.get("endedAt"):
        if _date_passed(rule5_scheduled):
            try:
                rule5_state["started"] = True
                rule5_state["clock"] = {
                    "startedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                    "paused": False, "pausedAt": None,
                }
                upsert_league_state_row(key, "rule5", rule5_state)
                print(f"Auto-started Rule 5 draft (scheduled {rule5_scheduled}).")
            except Exception as e:
                print(f"  ! rule5 auto-start failed: {e}", file=sys.stderr)

    # Rule 5 auto-skip (after potentially auto-starting).
    if rule5_state and rule5_state.get("started") and rule5_state.get("order"):
        try:
            auto_skip_rule5(key, rule5_state)
        except Exception as e:
            print(f"  ! rule5 auto-skip failed: {e}", file=sys.stderr)

    draft = fetch_league_state_row(key, "draft_2027")
    if not draft:
        print("No draft state."); return
    if not (draft.get("baseOrder") and len(draft["baseOrder"]) == 12):
        print("Draft not initialized."); return
    if draft.get("endedAt"):
        # Commish ended the draft — no clock, no auto-skips, no alerts.
        print(f"Minors Draft ended at {draft['endedAt']}; nothing to do.")
        return

    # Auto-START Minors Draft clock at the scheduled auction-draft time
    # (the Minors Draft conventionally runs immediately after the auction).
    minors_scheduled = key_dates.get("auction_draft")
    if not (draft.get("clock") and draft["clock"].get("startedAt")):
        if _date_passed(minors_scheduled):
            try:
                draft["clock"] = {
                    "startedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                    "paused": False, "pausedAt": None,
                }
                upsert_league_state_row(key, "draft_2027", draft)
                print(f"Auto-started Minors Draft clock (scheduled {minors_scheduled}).")
            except Exception as e:
                print(f"  ! minors auto-start failed: {e}", file=sys.stderr)

    # ------------------------------------------------------------------
    # Auto-skip expired picks. The browser-side ticker only auto-skips
    # when a commish has the draft tab open — if nobody does, the clock
    # runs out but the pick never gets passed. This cron-side loop closes
    # that gap. Loops in case multiple picks have stacked up as expired.
    # ------------------------------------------------------------------
    skipped = 0
    for _ in range(50):  # safety cap
        cur = current_pick_info(draft)
        if not cur: break
        started, paused, expired, _rem = clock_state(draft, int(datetime.now(timezone.utc).timestamp() * 1000))
        if not started or paused or not expired: break
        # Insert into passed; advance the clock for the next pick.
        if "passed" not in draft or draft["passed"] is None:
            draft["passed"] = []
        draft["passed"].append({
            "round": cur["round"], "pickInRound": cur["pickInRound"], "team": cur["team"], "auto": True,
        })
        draft["clock"] = {
            "startedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "paused": False, "pausedAt": None,
        }
        # Log activity (best-effort; failure here shouldn't block the skip).
        try:
            urllib.request.urlopen(urllib.request.Request(
                f"{SUPABASE_URL}/rest/v1/activity_log",
                method="POST",
                data=json.dumps({
                    "type": "minors_pick_auto_skipped",
                    "actor_team_id": None,
                    "target_team_id": cur["team"],
                    "payload": {"round": cur["round"], "pick_in_round": cur["pickInRound"]},
                }).encode("utf-8"),
                headers={
                    "apikey": key, "Authorization": f"Bearer {key}",
                    "Content-Type": "application/json",
                },
            ), timeout=10)
        except Exception as e:
            print(f"  ! activity_log insert failed: {e}", file=sys.stderr)
        skipped += 1
    if skipped:
        upsert_league_state_row(key, "draft_2027", draft)
        print(f"Auto-skipped {skipped} expired pick(s).")
        # Re-load to make sure we work on the saved version below.
        draft = fetch_league_state_row(key, "draft_2027") or draft

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

    # Be defensive about the new notification tables — they only exist after
    # the commissioner runs the schema additions. Auto-skip above runs
    # whether or not these tables are reachable.
    def _safe(fn, default):
        try: return fn() or default
        except Exception as e:
            print(f"  ! {fn.__name__} skipped: {e}", file=sys.stderr); return default

    owners = _safe(lambda: fetch_all_owners(key), [])
    emails_by_uid = _safe(lambda: fetch_emails_by_user_id(key), {})
    all_prefs = _safe(lambda: fetch_notify_prefs(key), {})
    push_subs = _safe(lambda: fetch_push_subs(key), [])
    push_by_team = {}
    for s in push_subs:
        push_by_team.setdefault(s["team_id"], []).append(s)
    # Co-managers: fan out to every owner record for the team.
    emails_by_team = {}
    for o in owners:
        addr = emails_by_uid.get(o["id"])
        if addr:
            emails_by_team.setdefault(o["team_id"], set()).add(addr)
    for tid, row in (all_prefs or {}).items():
        broadcast = row.get("email")
        if broadcast:
            emails_by_team.setdefault(tid, set()).add(broadcast)

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
            addrs = emails_by_team.get(team_id) or set()
            for addr in addrs:
                if smtp_user and smtp_pass:
                    try:
                        html, text = render_alert(title, body, url=url, cta_label="Open Minors Draft")
                        send_email(smtp_user, smtp_pass, [addr], f"The League: Draft alert — {title}", html, text)
                        notify_count += 1
                    except Exception as e:
                        print(f"  ! email failed for {team_id} <{addr}>: {e}", file=sys.stderr)
                else:
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
