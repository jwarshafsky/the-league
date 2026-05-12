#!/usr/bin/env python3
"""
Weekly league activity digest. Same shape as daily_report.py but covers 7 days
and only sends to teams whose pref for a given category is "weekly".

Schedule: Sundays 9pm ET.
"""

import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _notify_db import (
    load_env, fetch_activity_since, fetch_all_owners, fetch_emails_by_user_id,
    fetch_notify_prefs, team_name,
)
from _email_template import render_digest
from _mail import send_email
from daily_report import group_by_category, build_sections, SECTION_ORDER  # noqa: F401


def main():
    env = load_env()
    key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    smtp_user = env.get("SMTP_USER")
    smtp_pass = env.get("SMTP_PASS")
    if not key:
        print("SUPABASE_SERVICE_ROLE_KEY not set", file=sys.stderr); sys.exit(1)

    since_dt = datetime.now(timezone.utc) - timedelta(days=7)
    since_iso = since_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    activity = fetch_activity_since(key, since_iso=since_iso, limit=5000) or []
    grouped = group_by_category(activity)

    owners = fetch_all_owners(key) or []
    emails_by_uid = fetch_emails_by_user_id(key)
    all_prefs = fetch_notify_prefs(key)

    label = datetime.now(timezone.utc).astimezone().strftime("week ending %b %d, %Y")

    sent = []
    for owner in owners:
        team_id = owner.get("team_id"); uid = owner.get("id")
        if not team_id or not uid: continue
        addr = (all_prefs.get(team_id) or {}).get("email") or emails_by_uid.get(uid)
        if not addr: continue
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
        subject = f"League weekly digest: {n} event{'s' if n != 1 else ''}"
        if smtp_user and smtp_pass:
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


if __name__ == "__main__":
    main()
