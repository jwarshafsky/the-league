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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _notify_db import (  # noqa: E402
    load_env, fetch_activity_since, fetch_all_owners, fetch_emails_by_user_id,
    fetch_notify_prefs, event_category, describe_activity, team_name, APP_URL,
)
from _email_template import render_digest  # noqa: E402
from _mail import send_email  # noqa: E402


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

    since_dt = datetime.now(timezone.utc) - timedelta(hours=24)
    since_iso = since_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    activity = fetch_activity_since(key, since_iso=since_iso, limit=1000) or []
    grouped = group_by_category(activity)

    owners = fetch_all_owners(key) or []
    emails_by_uid = fetch_emails_by_user_id(key)
    all_prefs = fetch_notify_prefs(key)

    now_label = datetime.now(timezone.utc).astimezone().strftime("%A, %b %d, %Y")
    today_subtitle = f"Daily digest · {now_label}"

    sent = []
    for owner in owners:
        team_id = owner.get("team_id"); uid = owner.get("id")
        if not team_id or not uid: continue
        addr = (all_prefs.get(team_id) or {}).get("email") or emails_by_uid.get(uid)
        if not addr: continue
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
        subject = f"League digest: {n} event{'s' if n != 1 else ''}"
        if smtp_user and smtp_pass:
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


if __name__ == "__main__":
    main()
