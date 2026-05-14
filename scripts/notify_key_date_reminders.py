#!/usr/bin/env python3
"""
Key-date reminder notifier — fires email reminders to every league member
1 week and 24 hours before each scheduled key date.

Reads league_state.key_dates and computes the windows around each date.
Tracks which (date_key, threshold) pairs have already been notified in
league_state.notify_key_date_marker so the same reminder doesn't fire
twice across cron invocations.

Schedule: every 30 minutes via pg_cron (or any frequency ≤ 6h — we have
±3h slop on the 7-day window so as long as the script runs at least
once in that window, the reminder lands).
"""

import json
import os
import sys
import urllib.request
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _notify_db import (
    SUPABASE_URL, APP_URL,
    load_env, fetch_all_owners, fetch_emails_by_user_id,
    fetch_notify_prefs, fetch_league_state_row, upsert_league_state_row,
    parse_ts,
)
from _email_template import render_alert
from _mail import send_email

MARKER_KEY = "notify_key_date_marker"

# UI labels per key. Match KEY_DATES_SCHEMA in js/app.js.
KEY_LABELS = {
    "rule5_deadline":  "Rule 5 Deadline",
    "rule5_draft":     "Rule 5 Draft",
    "keeper_deadline": "Keeper Deadline",
    "auction_draft":   "Auction Draft",
    "minors_draft":    "Minors Draft",
    "trade_deadline":  "Trade Deadline",
}

# Reminder windows (offset from the date, slack tolerance for cron jitter).
REMINDERS = [
    {"id": "1w", "label": "1 week",   "offset_hours": 7 * 24, "slack_hours": 6},
    {"id": "1d", "label": "24 hours", "offset_hours": 24,     "slack_hours": 3},
]


def _format_et(iso):
    """Return a human-readable ET string for the date."""
    if not iso: return "?"
    try:
        from zoneinfo import ZoneInfo
        d = datetime.fromtimestamp(parse_ts(iso).timestamp(), tz=timezone.utc).astimezone(ZoneInfo("America/New_York"))
        # Hide time if midnight ET.
        if d.hour == 0 and d.minute == 0:
            return d.strftime("%b %d, %Y") + " ET"
        return d.strftime("%b %d, %Y at %I:%M %p ET").lstrip("0").replace(" 0", " ")
    except Exception:
        # Fallback: display the raw ISO.
        return iso


def main():
    env = load_env()
    key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    smtp_user = env.get("SMTP_USER")
    smtp_pass = env.get("SMTP_PASS")
    if not key:
        print("SUPABASE_SERVICE_ROLE_KEY not set", file=sys.stderr); sys.exit(1)

    key_dates = fetch_league_state_row(key, "key_dates") or {}
    if not key_dates:
        print("No key_dates set."); return

    marker = fetch_league_state_row(key, MARKER_KEY) or {}
    # marker shape: { "<date_key>:<reminder_id>:<iso>": "<sent_at_iso>" }

    now = datetime.now(timezone.utc)
    pending = []
    for date_key, iso in key_dates.items():
        if not iso: continue
        try:
            d = parse_ts(iso)
            if not d: continue
        except Exception:
            continue
        for r in REMINDERS:
            window_start = d - timedelta(hours=r["offset_hours"])
            slack = timedelta(hours=r["slack_hours"])
            if window_start - slack <= now <= window_start + slack:
                marker_id = f"{date_key}:{r['id']}:{iso}"
                if marker_id in marker:
                    continue  # already sent for this exact date+reminder combo
                pending.append({
                    "date_key": date_key,
                    "reminder": r,
                    "iso": iso,
                    "marker_id": marker_id,
                })

    if not pending:
        print("No reminders due."); return

    owners = fetch_all_owners(key) or []
    emails_by_uid = fetch_emails_by_user_id(key)
    all_prefs = fetch_notify_prefs(key)
    # Fan out to every email associated with each team (covers co-managers).
    addresses = set()
    for o in owners:
        addr = emails_by_uid.get(o.get("id"))
        if addr: addresses.add(addr)
    for tid, row in (all_prefs or {}).items():
        broadcast = (row or {}).get("email")
        if broadcast: addresses.add(broadcast)

    if not addresses:
        print("No recipient addresses."); return

    sent = 0
    for p in pending:
        label = KEY_LABELS.get(p["date_key"], p["date_key"])
        when_str = _format_et(p["iso"])
        title = f"{p['reminder']['label']} reminder: {label}"
        body = (f"Heads-up: <strong>{label}</strong> is in {p['reminder']['label']} "
                f"(scheduled for {when_str}).")
        url = APP_URL + "?tab=rules"
        if smtp_user and smtp_pass:
            html, text = render_alert(title, body, url=url, cta_label="View League Rules")
            for addr in addresses:
                try:
                    send_email(smtp_user, smtp_pass, [addr], f"The League: {title}", html, text)
                    sent += 1
                except Exception as e:
                    print(f"  ! email failed for {addr}: {e}", file=sys.stderr)
        else:
            print(f"[preview] would email {len(addresses)} addresses for: {title}")
        marker[p["marker_id"]] = now.isoformat().replace("+00:00", "Z")

    # Garbage-collect marker entries older than 30 days so the row doesn't
    # grow forever as new key dates are scheduled and pass.
    cutoff = (now - timedelta(days=30)).isoformat()
    marker = {k: v for k, v in marker.items() if (v or "") >= cutoff}

    upsert_league_state_row(key, MARKER_KEY, marker)
    print(f"Sent {sent} reminder email(s) across {len(pending)} pending reminder(s).")


if __name__ == "__main__":
    main()
