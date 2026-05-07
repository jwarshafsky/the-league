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
            env[k.strip()] = v.strip()
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

    # 2. Send the magic-link invite via Auth admin API.
    http_post("/auth/v1/invite", {"email": email}, key)
    print(f"  ✓ Magic-link invite emailed to {email}")
    print()
    print("They should check their inbox (including spam) and click the link.")
    print("On first login they'll land directly in their team — no Pick Your Team screen.")


if __name__ == "__main__":
    main()
