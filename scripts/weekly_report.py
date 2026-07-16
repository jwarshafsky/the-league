#!/usr/bin/env python3
"""
Weekly league activity digest. Same shape as daily_report.py but covers 7 days
and only sends to teams whose pref for a given category is "weekly".

Schedule: Sundays 9pm ET.
"""

import os
import sys
from datetime import datetime, timedelta, timezone

try:
    from zoneinfo import ZoneInfo
    _ET = ZoneInfo("America/New_York")
except Exception:
    _ET = timezone.utc  # Fallback; runner without tzdata will see UTC labels.

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _notify_db import (
    load_env, fetch_activity_since, fetch_all_owners, fetch_emails_by_user_id,
    fetch_notify_prefs, fetch_league_state_row, upsert_league_state_row,
    team_name, parse_ts,
)
from _email_template import render_digest
from _mail import send_email
from daily_report import (  # noqa: F401
    group_by_category, build_sections, build_team_addresses, SECTION_ORDER,
)


# Idempotency marker (league_state). Shape: {"lastSentThrough": "<iso>"}.
# Window is (lastSentThrough, now] — see daily_report.py.
MARKER_KEY = "digest_weekly_marker"
DEFAULT_WINDOW = timedelta(days=7)
MIN_GAP = timedelta(days=3)  # refuse to re-send sooner than this

PAGE_SIZE = 1000  # PostgREST max-rows caps a single response at 1000


def fetch_activity_paged(key, since_iso):
    """Fetch ALL activity rows since since_iso. A single limit=5000 request
    silently truncates at PostgREST's max-rows (default 1000), so page by
    advancing since_iso to the last row seen (the fetch is >=, so boundary
    rows repeat across pages — dedupe by id)."""
    out = []
    seen_ids = set()
    page_since = since_iso
    while True:
        page = fetch_activity_since(key, since_iso=page_since, limit=PAGE_SIZE) or []
        fresh = [a for a in page if a.get("id") not in seen_ids]
        for a in fresh:
            seen_ids.add(a.get("id"))
        out.extend(fresh)
        if len(page) < PAGE_SIZE or not fresh:
            break
        page_since = fresh[-1].get("created_at") or page_since
    return out


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
        print(f"Weekly digest already sent through {marker.get('lastSentThrough')} "
              f"(< {MIN_GAP} ago); skipping.")
        return
    since_dt = last_through or (now_dt - DEFAULT_WINDOW)

    since_iso = since_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    activity = fetch_activity_paged(key, since_iso)
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

    # ET label so "week ending" matches recipients' calendars (cron fires at
    # 01:07 UTC Monday = 9:07 PM ET Sunday).
    label = datetime.now(timezone.utc).astimezone(_ET).strftime("week ending %b %d, %Y")

    sent = []
    attempted = 0
    for team_id in sorted(emails_by_team):
        receive_all = bool((all_prefs.get(team_id) or {}).get("receive_all"))
        prefs = (all_prefs.get(team_id) or {}).get("prefs") or {}
        # Weekly digest pulls in only "weekly" (and "instant"/"daily" recap
        # for receive_all). For non-receive_all teams, target_frequency=weekly
        # narrows the section list precisely.
        sections = build_sections(grouped, prefs, receive_all=receive_all, target_frequency="weekly")
        if not sections:
            continue
        title = "The League — weekly digest"
        greeting = f"Hi {team_name(team_id)}, here's your weekly digest of league activity."
        if receive_all:
            greeting += " (You're set to receive every league event.)"
        html, text = render_digest(title, f"Weekly digest · {label}", sections, greeting=greeting)
        n = sum(len(s['items']) for s in sections)
        subject = f"The League: Weekly digest — {n} event{'s' if n != 1 else ''}"
        for addr in sorted(emails_by_team[team_id]):
            if smtp_user and smtp_pass:
                attempted += 1
                try:
                    send_email(smtp_user, smtp_pass, [addr], subject, html, text)
                    sent.append((team_id, addr, n))
                except Exception as e:
                    print(f"  ! failed for {team_id} {addr}: {e}", file=sys.stderr)
            else:
                print(f"[preview] would email {team_id} <{addr}> — {n} events")
    if sent:
        print(f"Sent {len(sent)} weekly digest(s).")
    else:
        print("No weekly digests sent.")

    # Advance the marker only AFTER sends complete. Hold it if every attempted
    # send failed so the whole window retries next run; a partial failure still
    # advances. Preview mode never advances. (See daily_report.py.)
    if attempted and not sent:
        print("  ! all sends failed; holding digest marker for retry.", file=sys.stderr)
        return
    if smtp_user and smtp_pass:
        upsert_league_state_row(key, MARKER_KEY, {"lastSentThrough": now_iso})


if __name__ == "__main__":
    main()
