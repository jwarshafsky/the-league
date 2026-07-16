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
import re
import sys
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _notify_db import (
    SUPABASE_URL, APP_URL,
    load_env, fetch_all_owners, fetch_emails_by_user_id,
    fetch_notify_prefs, fetch_push_subs, fetch_league_state_row,
    fetch_league_state_row_v, save_league_state_row_cas, LeagueStateConflict,
    fetch_trades, upsert_league_state_row, team_name, parse_ts,
)
from _email_template import render_alert
from _mail import send_email
from _push import send_push, to_subscription_info, is_gone


MARKER_KEY = "notify_draft_marker"
STATE_LABELS = {"on_clock": "On the clock", "on_deck": "On deck", "in_hole": "In the hole"}


def parse_milb_pick_value(value):
    """Mirror of parseMilbPickValue in app.js — '2027 1st round' → {year, round}."""
    if not isinstance(value, str): return None
    v = value.lower()
    year_m = re.search(r"\b(20\d{2})\b", v)
    cleaned = v.replace(year_m.group(1), " ", 1) if year_m else v
    round_n = None
    for pat in (r"(\d+)\s*(?:st|nd|rd|th)", r"round\s+(\d+)", r"\b(\d+)\b"):
        m = re.search(pat, cleaned)
        if m:
            round_n = int(m.group(1)); break
    if not round_n or round_n < 1 or round_n > 20: return None
    return {"year": int(year_m.group(1)) if year_m else None, "round": round_n}


def trade_log_owner(trades, round_num, draft_year, base_owner):
    """Mirror of getTradeLogOwner in app.js: walk milb_pick trade assets
    chronologically and apply chained ownership transfers."""
    owner = base_owner
    for t in trades:
        for receives, from_team, to_team in (
            (t.get("team1_receives") or [], t.get("team2"), t.get("team1")),
            (t.get("team2_receives") or [], t.get("team1"), t.get("team2")),
        ):
            for asset in receives:
                if asset.get("type") != "milb_pick": continue
                parsed = parse_milb_pick_value(asset.get("value")) or {}
                pick_round = asset.get("pickRound") if asset.get("pickRound") is not None else parsed.get("round")
                pick_year  = asset.get("pickYear")  if asset.get("pickYear")  is not None else parsed.get("year")
                orig = asset.get("pickOriginalOwner")
                if not pick_round or pick_round != round_num: continue
                if not pick_year or pick_year != draft_year: continue
                if orig and orig != base_owner: continue
                if from_team == owner: owner = to_team
    return owner


def get_pick_owner(draft, round_num, pick_in_round, trades):
    """Mirror of getPickOwner in app.js, INCLUDING the trade-log walk —
    without it, picks traded via the in-app Trade Log alert the old owner."""
    traded = (draft.get("tradedPicks") or {})
    key = f"{round_num}p{pick_in_round}"
    if key in traded: return traded[key]
    base_list = draft.get("baseOrder") or []
    if draft.get("type") == "snake" and round_num % 2 == 0:
        base = base_list[len(base_list) - pick_in_round] if 0 <= len(base_list) - pick_in_round < len(base_list) else None
    else:
        base = base_list[pick_in_round - 1] if 0 <= pick_in_round - 1 < len(base_list) else None
    if base is None: return None
    return trade_log_owner(trades, round_num, draft.get("year"), base)


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
    started_dt = parse_ts(started_at)
    if started_dt is None:
        # Malformed timestamp: treat as not-started instead of crashing the
        # whole run (which would also kill auto-skip every 5 min).
        print(f"  ! malformed clock.startedAt {started_at!r}; treating clock as not started", file=sys.stderr)
        return False, False, False, DRAFT_CLOCK_MS
    started_ms = int(started_dt.timestamp() * 1000)
    paused = bool(clk.get("paused"))
    paused_at_dt = parse_ts(clk.get("pausedAt")) if (paused and clk.get("pausedAt")) else None
    ref_ms = int(paused_at_dt.timestamp() * 1000) if paused_at_dt else now_ms
    # bankedMs: active time consumed before the current startedAt segment
    # (accumulated by pause/resume — mirrors computeDraftClockState).
    banked = int(clk.get("bankedMs") or 0)
    elapsed = banked + active_elapsed_ms(started_ms, ref_ms)
    remaining = max(0, DRAFT_CLOCK_MS - elapsed)
    return True, paused, remaining <= 0, remaining


DRAFT_ROUNDS = 7  # mirrors DRAFT_ROUNDS/_normalizeDraft in app.js


def normalize_draft(draft):
    """Mirror of _normalizeDraft in app.js: rounds are pinned to 7 and
    out-of-range picks/passes are ignored, so the cron can't keep passing
    through phantom rounds the app doesn't recognize."""
    draft["rounds"] = DRAFT_ROUNDS
    draft["picks"] = [p for p in (draft.get("picks") or []) if (p.get("round") or 0) <= DRAFT_ROUNDS]
    draft["passed"] = [p for p in (draft.get("passed") or []) if (p.get("round") or 0) <= DRAFT_ROUNDS]
    return draft


def current_pick_info(draft, trades):
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
                "team": get_pick_owner(draft, r, pir, trades), "key": k,
            }
    return None


def neighbor_pick(draft, current, offset, trades):
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
                    "team": get_pick_owner(draft, r, pir, trades), "key": k,
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
    # End if the previous FULL round was all passes — only test at round
    # boundaries (idx == 0). A rolling last-N window can span two rounds and,
    # with snake reversal, end the draft mid-round (mirrors app.js fix).
    if N >= n and idx == 0:
        prev_round = picks[N - n:N]
        if all(p.get("pass") for p in prev_round):
            return None
    return {"round": rnd, "idx": idx, "teamId": team_id}


def auto_skip_rule5(key, state, version):
    """Push pass entries for expired Rule 5 picks and persist (CAS-guarded)."""
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
            "paused": False, "pausedAt": None, "bankedMs": 0,
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
        try:
            save_league_state_row_cas(key, "rule5", state, version)
        except LeagueStateConflict:
            # Someone (a browser) wrote rule5 while we worked — drop our
            # changes rather than clobber theirs; next run re-evaluates.
            print("  ! rule5 changed mid-run; auto-skip abandoned this tick.")
            return 0
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

    rule5_state, rule5_ver = fetch_league_state_row_v(key, "rule5")
    rule5_scheduled = key_dates.get("rule5_draft")
    if rule5_state and rule5_state.get("order") and not rule5_state.get("started") and not rule5_state.get("endedAt"):
        if _date_passed(rule5_scheduled):
            try:
                rule5_state["started"] = True
                rule5_state["clock"] = {
                    "startedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                    "paused": False, "pausedAt": None, "bankedMs": 0,
                }
                rule5_ver = save_league_state_row_cas(key, "rule5", rule5_state, rule5_ver)
                print(f"Auto-started Rule 5 draft (scheduled {rule5_scheduled}).")
            except LeagueStateConflict:
                print("  ! rule5 changed mid-run; auto-start skipped this tick.")
                rule5_state = None  # don't act on a stale copy below
            except Exception as e:
                print(f"  ! rule5 auto-start failed: {e}", file=sys.stderr)

    # Rule 5 auto-skip (after potentially auto-starting).
    if rule5_state and rule5_state.get("started") and rule5_state.get("order"):
        try:
            auto_skip_rule5(key, rule5_state, rule5_ver)
        except Exception as e:
            print(f"  ! rule5 auto-skip failed: {e}", file=sys.stderr)

    draft, draft_ver = fetch_league_state_row_v(key, "draft_2027")
    if not draft:
        print("No draft state."); return
    if not (draft.get("baseOrder") and len(draft["baseOrder"]) == 12):
        print("Draft not initialized."); return
    if draft.get("endedAt"):
        # Commish ended the draft — no clock, no auto-skips, no alerts.
        print(f"Minors Draft ended at {draft['endedAt']}; nothing to do.")
        return
    normalize_draft(draft)

    # Trade-log pick ownership needs the trades table. If it can't be read we
    # must not guess owners (wrong-team alerts + wrong auto-pass attribution).
    try:
        trades = fetch_trades(key)
    except Exception as e:
        print(f"  ! trades fetch failed ({e}); skipping this run.", file=sys.stderr)
        return

    # Auto-START Minors Draft clock at the scheduled auction-draft time
    # (the Minors Draft conventionally runs immediately after the auction).
    minors_scheduled = key_dates.get("auction_draft")
    if not (draft.get("clock") and draft["clock"].get("startedAt")):
        if _date_passed(minors_scheduled):
            try:
                draft["clock"] = {
                    "startedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                    "paused": False, "pausedAt": None, "bankedMs": 0,
                }
                draft_ver = save_league_state_row_cas(key, "draft_2027", draft, draft_ver)
                print(f"Auto-started Minors Draft clock (scheduled {minors_scheduled}).")
            except LeagueStateConflict:
                print("  ! draft_2027 changed mid-run; auto-start skipped this tick.")
                return
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
        cur = current_pick_info(draft, trades)
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
            "paused": False, "pausedAt": None, "bankedMs": 0,
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
        try:
            save_league_state_row_cas(key, "draft_2027", draft, draft_ver)
        except LeagueStateConflict:
            # A pick landed (or the commish acted) while we worked. Abort the
            # whole run rather than notify off a stale board; the next 5-min
            # tick re-evaluates from fresh state.
            print("  ! draft_2027 changed mid-run; auto-skip abandoned this tick.")
            return
        print(f"Auto-skipped {skipped} expired pick(s).")
        # Re-load to make sure we work on the saved version below.
        fresh, _v = fetch_league_state_row_v(key, "draft_2027")
        if fresh: draft = normalize_draft(fresh)

    cur = current_pick_info(draft, trades)
    if not cur:
        print("Draft complete."); return
    on_deck = neighbor_pick(draft, cur, 1, trades)
    in_hole = neighbor_pick(draft, cur, 2, trades)
    slots = []
    if cur:     slots.append(("on_clock", cur))
    if on_deck: slots.append(("on_deck",  on_deck))
    if in_hole: slots.append(("in_hole",  in_hole))

    marker = fetch_league_state_row(key, MARKER_KEY) or {}
    # marker structure: { "<team_id>": { "on_clock": "<pick-key>", "on_deck": "...", "in_hole": "..." } }

    # Distinguish "fetch failed" (None) from "fetched, legitimately empty".
    # A transient failure here must NOT record markers — that would treat
    # every team as opted out and permanently suppress this pick's alerts.
    def _safe(fn, default):
        try:
            got = fn()
            return default if got is None else got
        except Exception as e:
            print(f"  ! {fn.__name__} failed: {e}", file=sys.stderr); return None

    owners = _safe(lambda: fetch_all_owners(key), [])
    emails_by_uid = _safe(lambda: fetch_emails_by_user_id(key), {})
    all_prefs = _safe(lambda: fetch_notify_prefs(key), {})
    push_subs = _safe(lambda: fetch_push_subs(key), [])
    if owners is None or emails_by_uid is None or all_prefs is None:
        print("  ! prefs/owner fetch failed — skipping notifications this run (no markers recorded).", file=sys.stderr)
        return
    if push_subs is None: push_subs = []
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
        attempted = delivered = 0
        if wants_email:
            addrs = emails_by_team.get(team_id) or set()
            for addr in addrs:
                if smtp_user and smtp_pass:
                    attempted += 1
                    try:
                        html, text = render_alert(title, body, url=url, cta_label="Open Minors Draft")
                        send_email(smtp_user, smtp_pass, [addr], f"The League: Draft alert — {title}", html, text)
                        notify_count += 1; delivered += 1
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
                attempted += 1
                try:
                    send_push(to_subscription_info(sub), payload, vapid_priv, vapid_sub)
                    notify_count += 1; delivered += 1
                except Exception as e:
                    if is_gone(e):
                        push_failed_endpoints.append(sub["endpoint"])
                        attempted -= 1  # dead sub, not a transient failure
                    else: print(f"  ! push failed for {team_id}: {e}", file=sys.stderr)
        if attempted > 0 and delivered == 0:
            # Every send failed (SMTP outage, push service down): leave the
            # marker unset so the next run retries instead of dropping the
            # alert forever. Nothing was delivered, so no duplicate risk.
            print(f"  ! all sends failed for {team_id}/{state_key}; will retry next run.", file=sys.stderr)
            continue
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
