#!/usr/bin/env python3
"""
Invite a league member: pre-assign their team and email them a magic link.

Usage:
  python3 scripts/send_invite.py EMAIL TEAM_ID [--commish]

Examples:
  python3 scripts/send_invite.py matt.smith@gmail.com matt
  python3 scripts/send_invite.py dave.warshafsky@gmail.com dave --commish

What it does:
  1. Upserts an invited_emails row mapping EMAIL -> TEAM_ID (and commissioner
     status). When the recipient logs in for the first time, the auto-claim
     flow creates their owners row with that team.
  2. Calls Supabase's admin invite endpoint, which sends them a magic-link
     email through your configured SMTP.

Requires SUPABASE_SERVICE_ROLE_KEY in scripts/.env (Project Settings -> API
in the Supabase dashboard).
"""

import json
import os
import sys
import urllib.error
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
ENV_FILE = os.path.join(ROOT, "scripts", ".env")
SUPABASE_URL = "https://fbllfkrtjsihrkwnbmlw.supabase.co"
SUPABASE_ANON_KEY = "sb_publishable_aRh0MmQKrMCr8YnTwv9xIg_1F08WXf2"
APP_URL = "https://league.jwarshafsky.com/"

# Canonical 12-team list (matches LEAGUE_DATA.teams in js/data.js and
# claim_invited_team's known_teams in supabase/schema.sql). Validating here
# catches typos at invite time instead of waiting for the user's first claim.
KNOWN_TEAMS = {
    "jeff", "matt", "jesse", "sam", "saxton", "aj",
    "corey", "dave", "josh-doug", "larry", "zack", "glicksman",
}


def load_env():
    env = {}
    if not os.path.exists(ENV_FILE):
        print(f"Missing {ENV_FILE}. Add SUPABASE_SERVICE_ROLE_KEY to it.", file=sys.stderr)
        sys.exit(1)
    with open(ENV_FILE) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            # Strip one layer of matching quotes. NOTIFICATIONS_SETUP.md step 3 —
            # and generate_vapid.py's own printed output — tell you to store
            # VAPID_PRIVATE_KEY / VAPID_SUBJECT quoted. The quotes used to survive
            # into the value, so Vapid01.from_pem() died with an ASN.1 parse error
            # and py_vapid rejected the mailto: subject. GitHub Actions injects
            # secrets unquoted, so only cron / local runs ever hit this.
            _v = v.strip()
            if len(_v) >= 2 and _v[0] == _v[-1] and _v[0] in ("'", '"'):
                _v = _v[1:-1]
            env[k.strip()] = _v
    return env


def http_post(path, body, key, extra_headers=None):
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {key}",
        "apikey": key,
    }
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(
        f"{SUPABASE_URL}{path}",
        data=json.dumps(body).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read().decode("utf-8") or "{}"
            return json.loads(raw) if raw.strip().startswith(("{", "[")) else raw
    except urllib.error.HTTPError as e:
        body_text = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code} on {path}: {body_text}")


def main():
    if len(sys.argv) < 3:
        print(__doc__, file=sys.stderr)
        sys.exit(1)

    email = sys.argv[1].strip().lower()
    team_id = sys.argv[2].strip()
    is_commish = "--commish" in sys.argv

    if team_id not in KNOWN_TEAMS:
        print(f"Invalid team_id: {team_id!r}", file=sys.stderr)
        print(f"Must be one of: {', '.join(sorted(KNOWN_TEAMS))}", file=sys.stderr)
        sys.exit(1)

    env = load_env()
    key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not key:
        print("Set SUPABASE_SERVICE_ROLE_KEY in scripts/.env", file=sys.stderr)
        sys.exit(1)

    print(f"Inviting {email} -> {team_id}{' (commissioner)' if is_commish else ''}")

    # 1. Upsert invited_emails. PostgREST upsert via Prefer header.
    http_post(
        "/rest/v1/invited_emails?on_conflict=email",
        {"email": email, "team_id": team_id, "is_commissioner": is_commish},
        key,
        extra_headers={"Prefer": "resolution=merge-duplicates,return=representation"},
    )
    print("  ✓ Recorded in invited_emails")

    # 2. Send a magic link. Try the admin invite endpoint first (preferred for
    #    new users — uses the "Invite user" template). Fall back to the OTP
    #    endpoint for users that already exist in auth.users.
    sent_via = None
    try:
        http_post(
            "/auth/v1/invite",
            {"email": email, "data": {"redirect_to": APP_URL}},
            key,
        )
        sent_via = "invite"
    except RuntimeError as e:
        if "email_exists" in str(e) or "already been registered" in str(e):
            http_post(
                "/auth/v1/otp",
                {"email": email, "create_user": True,
                 "options": {"emailRedirectTo": APP_URL}},
                SUPABASE_ANON_KEY,
            )
            sent_via = "otp (existing user)"
        else:
            raise
    print(f"  ✓ Magic-link emailed to {email} (via {sent_via})")
    print()
    print("They should check their inbox (including spam) and click the link.")
    print("On first login they'll land directly in their team — no Pick Your Team screen.")


if __name__ == "__main__":
    main()
