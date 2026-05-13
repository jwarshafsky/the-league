#!/usr/bin/env python3
"""
Record the result of the ESPN sync in league_state.espn_sync_status, and on
a fresh failure send a push to every commissioner's devices.

Usage (from the espn-sync GitHub Actions workflow):
  python3 scripts/_sync_status.py --success
  python3 scripts/_sync_status.py --failure --error-file /tmp/sync_log.txt

State shape stored in league_state.state for key='espn_sync_status':
  { "lastSuccessAt": ISO, "lastFailureAt": ISO, "lastError": str, "pushedAt": ISO }

Push suppression: we only push when there hasn't been a push since the last
successful sync. On success we clear pushedAt so the next failure spell
triggers a new push.
"""

import argparse
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _notify_db import load_env, http_get, SUPABASE_URL  # noqa: E402

STATE_KEY = "espn_sync_status"


def _patch_state(key, state):
    url = f"{SUPABASE_URL}/rest/v1/league_state?on_conflict=key"
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    body = json.dumps([{"key": STATE_KEY, "state": state}]).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST", headers=headers)
    with urllib.request.urlopen(req, timeout=10) as r:
        r.read()


def _read_state(key):
    rows = http_get(f"{SUPABASE_URL}/rest/v1/league_state?key=eq.{STATE_KEY}&select=state", key)
    if not rows:
        return {}
    state = rows[0].get("state") or {}
    return state if isinstance(state, dict) else {}


def _push_commissioners(env, message):
    """Best-effort push to every commish's registered devices. Doesn't raise."""
    # Late import — push deps only needed in the failure path.
    try:
        from _push import send_push, to_subscription_info, is_gone
    except ImportError as e:
        print(f"push deps not installed: {e}", file=sys.stderr)
        return
    key = env["SUPABASE_SERVICE_ROLE_KEY"]
    vapid_priv = env.get("VAPID_PRIVATE_KEY")
    vapid_sub = env.get("VAPID_SUBJECT")
    if not vapid_priv or not vapid_sub:
        print("VAPID_PRIVATE_KEY / VAPID_SUBJECT missing, skipping push", file=sys.stderr)
        return
    owners = http_get(f"{SUPABASE_URL}/rest/v1/owners?is_commissioner=eq.true&select=id", key) or []
    if not owners:
        print("no commissioners found", file=sys.stderr)
        return
    commish_ids = ",".join(f'"{o["id"]}"' for o in owners)
    subs = http_get(
        f"{SUPABASE_URL}/rest/v1/push_subscriptions?user_id=in.({commish_ids})&select=*",
        key,
    ) or []
    if not subs:
        print("commissioners have no push subs", file=sys.stderr)
        return
    payload = {
        "title": "The League — ESPN sync failing",
        "body": message,
        "data": {"url": "./"},
        "tag": "espn-sync-failed",
    }
    sent = 0
    for s in subs:
        try:
            send_push(
                to_subscription_info(s),
                payload,
                vapid_private_key=vapid_priv,
                vapid_subject=vapid_sub,
            )
            sent += 1
        except Exception as e:
            print(f"push failed for {s['endpoint'][:60]}...: {e}", file=sys.stderr)
    print(f"pushed to {sent}/{len(subs)} commissioner device(s)")


def main():
    p = argparse.ArgumentParser()
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--success", action="store_true")
    g.add_argument("--failure", action="store_true")
    p.add_argument("--error", default="")
    p.add_argument("--error-file", default=None)
    args = p.parse_args()

    env = load_env()
    key = env["SUPABASE_SERVICE_ROLE_KEY"]
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    state = _read_state(key)

    if args.success:
        state["lastSuccessAt"] = now
        state.pop("pushedAt", None)  # arm push for the next failure spell
        _patch_state(key, state)
        print(f"recorded SUCCESS at {now}")
        return 0

    # Failure path
    err = args.error
    if args.error_file and os.path.exists(args.error_file):
        try:
            with open(args.error_file) as f:
                err = f.read()[-600:]
        except Exception:
            pass
    state["lastFailureAt"] = now
    state["lastError"] = (err or "Unknown error").strip()

    last_success = state.get("lastSuccessAt")
    pushed = state.get("pushedAt")
    should_push = (not pushed) or (last_success and pushed < last_success)
    if should_push:
        try:
            _push_commissioners(
                env,
                "Your ESPN cookies probably need refreshing. The 15-min sync just failed.",
            )
            state["pushedAt"] = now
        except Exception as e:
            print(f"push attempt errored: {e}", file=sys.stderr)

    _patch_state(key, state)
    print(f"recorded FAILURE at {now}: {state['lastError'][:160]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
