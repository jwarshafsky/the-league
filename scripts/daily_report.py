#!/usr/bin/env python3
"""
Sends a daily league activity digest to commissioners.

Usage:  python3 scripts/daily_report.py
Schedule: add to crontab to run once daily.

Reads activity_log rows from the last 24h and sends a plain-text email
summary via the same Gmail SMTP configured in Supabase. Reuses the
SUPABASE_SERVICE_ROLE_KEY in scripts/.env to query the DB and to look up
commissioner email addresses from auth.users.

Email transport: uses Supabase's /auth/v1/admin/generate_link with type=magiclink
won't work since we need a custom email. Easier: call Supabase's auth API to
identify commissioners, then send the email through the same SMTP server using
the SMTP creds. We don't have the SMTP password directly — but the user has
it set in Supabase. As a workaround, write the digest to a file and have
the user invoke an email send manually OR just rely on the commissioner
opening the in-app Activity tab.

For now this script writes the digest to /tmp/league-daily-<date>.txt and
prints it to stdout. To actually email it, set SMTP_USER and SMTP_PASS in
scripts/.env (Gmail address + App Password) and the script will send it.
"""

import json
import os
import sys
import re
import smtplib
import urllib.request
import urllib.error
from datetime import datetime, timedelta, timezone


def _parse_ts(s):
    # Python 3.9's fromisoformat is picky; strip sub-second precision and
    # normalize Z to +00:00 so it always parses.
    s = re.sub(r"\.\d+", "", s).replace("Z", "+00:00")
    return datetime.fromisoformat(s)
from email.message import EmailMessage

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
ENV_FILE = os.path.join(ROOT, "scripts", ".env")
SUPABASE_URL = "https://fbllfkrtjsihrkwnbmlw.supabase.co"
APP_URL = "https://jwarshafsky.github.io/the-league/"

# Local-team-id → display name (kept in sync with LEAGUE_DATA in js/data.js).
TEAM_NAMES = {
    "jeff": "Jeff", "matt": "Matt", "jesse": "Jesse", "sam": "Sam",
    "saxton": "Saxton", "aj": "AJ", "corey": "Corey", "dave": "Dave",
    "josh-doug": "Josh/Doug", "larry": "Larry", "zack": "Zack",
    "glicksman": "Glicksman",
}


def load_env():
    env = {}
    if not os.path.exists(ENV_FILE):
        print(f"Missing {ENV_FILE}", file=sys.stderr); sys.exit(1)
    with open(ENV_FILE) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line: continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env


def http_get(url, key):
    req = urllib.request.Request(url, headers={
        "apikey": key, "Authorization": f"Bearer {key}",
    })
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8") or "[]")


def fetch_activity(key):
    since = (datetime.now(timezone.utc) - timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%SZ")
    url = (
        f"{SUPABASE_URL}/rest/v1/activity_log"
        f"?select=*&created_at=gte.{since}&order=created_at.asc"
    )
    return http_get(url, key)


def fetch_commissioner_emails(key):
    owners = http_get(f"{SUPABASE_URL}/rest/v1/owners?select=id,team_id,is_commissioner&is_commissioner=eq.true", key)
    emails = []
    for o in owners:
        users = http_get(f"{SUPABASE_URL}/auth/v1/admin/users?id={o['id']}", key)
        for u in (users.get("users") if isinstance(users, dict) else users) or []:
            if u.get("id") == o["id"] and u.get("email"):
                emails.append(u["email"])
    return list(dict.fromkeys(emails))


def team_name(t): return TEAM_NAMES.get(t, t or "?")


def describe(a):
    p = a.get("payload") or {}
    actor = team_name(a.get("actor_team_id"))
    target = team_name(a.get("target_team_id"))
    name = p.get("player_name") or ""
    t = a.get("type")
    if t == "keeper_added":         return f"{actor} tagged {name} as a keeper" + (f" (${p.get('next_year_price')})" if p.get('next_year_price') is not None else "")
    if t == "keeper_removed":       return f"{actor} removed {name} as a keeper"
    if t == "minor_keeper_added":   return f"{actor} tagged {name} as a MiLB keeper"
    if t == "minor_keeper_removed": return f"{actor} removed {name} as a MiLB keeper"
    if t == "rule5_added":          return f"{actor} Rule 5–protected {name}"
    if t == "rule5_removed":        return f"{actor} unprotected {name} (Rule 5)"
    if t == "trade_block_added":    return f"{actor} put {name} on the trade block"
    if t == "trade_block_removed":  return f"{actor} removed {name} from the trade block"
    if t == "trade_recorded":
        t1, t2 = team_name(p.get("team1")), team_name(p.get("team2"))
        r1 = ", ".join(asset.get("value", "?") for asset in (p.get("team1_receives") or [])) or "—"
        r2 = ", ".join(asset.get("value", "?") for asset in (p.get("team2_receives") or [])) or "—"
        return f"{actor} recorded a trade: {t1} gets [{r1}]; {t2} gets [{r2}]"
    if t == "trade_deleted":
        return f"{actor} deleted a trade between {team_name(p.get('team1'))} and {team_name(p.get('team2'))}"
    if t == "minors_pick_made":     return f"{target} picked {name} (R{p.get('round')}.{p.get('pick_in_round')})"
    if t == "minors_pick_passed":   return f"{target} passed at R{p.get('round')}.{p.get('pick_in_round')}"
    if t == "minors_pick_undone":   return f"{actor} undid pick: {name} (R{p.get('round')}.{p.get('pick_in_round')})"
    if t == "minors_draft_reset":   return f"{actor} reset the Minors Draft"
    if t == "rule5_draft_reset":    return f"{actor} reset the Rule 5 Draft"
    if t == "callup_price_set":     return f"{actor} set {name}'s call-up price to ${p.get('price')} ({p.get('year')})"
    if t == "commish_override":     return f"{actor} overrode {name}'s contract"
    return f"{actor} did {t}"


def build_digest(activity):
    if not activity:
        return ("No league activity in the last 24 hours.", "League quiet today")
    now_pacific = datetime.now()
    lines = [f"League activity for {now_pacific.strftime('%A, %B %d, %Y')}:", ""]
    by_actor = {}
    for a in activity:
        by_actor.setdefault(team_name(a.get("actor_team_id")), []).append(a)
    for actor in sorted(by_actor):
        rows = by_actor[actor]
        lines.append(f"{actor} ({len(rows)} action{'s' if len(rows) != 1 else ''})")
        for a in rows:
            ts = _parse_ts(a["created_at"]).astimezone()
            lines.append(f"  {ts.strftime('%I:%M %p')}  {describe(a)}")
        lines.append("")
    lines.append(f"View full activity: {APP_URL}")
    body = "\n".join(lines)
    subject = f"League digest: {len(activity)} action{'s' if len(activity) != 1 else ''} in the last 24h"
    return body, subject


def send_email(subject, body, recipients, smtp_user, smtp_pass):
    msg = EmailMessage()
    msg["From"] = smtp_user
    msg["To"] = ", ".join(recipients)
    msg["Subject"] = subject
    msg.set_content(body)
    with smtplib.SMTP("smtp.gmail.com", 587) as s:
        s.starttls()
        s.login(smtp_user, smtp_pass)
        s.send_message(msg)


def main():
    env = load_env()
    key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not key:
        print("SUPABASE_SERVICE_ROLE_KEY not set", file=sys.stderr); sys.exit(1)

    activity = fetch_activity(key)
    body, subject = build_digest(activity)

    # Always print the digest to stdout (visible in cron logs).
    print(subject)
    print()
    print(body)

    # Write to a dated file as a fallback if SMTP isn't configured.
    out_path = f"/tmp/league-daily-{datetime.now().strftime('%Y-%m-%d')}.txt"
    with open(out_path, "w") as f:
        f.write(f"{subject}\n\n{body}")
    print(f"\nWrote {out_path}")

    smtp_user = env.get("SMTP_USER")
    smtp_pass = env.get("SMTP_PASS")
    if not smtp_user or not smtp_pass:
        print("SMTP_USER / SMTP_PASS not set in scripts/.env — digest not emailed.")
        print("Add your Gmail address and 16-char App Password to email it.")
        return

    try:
        recipients = fetch_commissioner_emails(key)
    except Exception as e:
        print(f"Couldn't look up commissioner emails: {e}", file=sys.stderr)
        recipients = [smtp_user]
    if not recipients:
        recipients = [smtp_user]
    send_email(subject, body, recipients, smtp_user, smtp_pass)
    print(f"Emailed digest to: {', '.join(recipients)}")


if __name__ == "__main__":
    main()
