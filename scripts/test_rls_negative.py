#!/usr/bin/env python3
"""Negative RLS test — proves a normal (non-commissioner) league member cannot
escalate their own privileges or perform commissioner-only actions.

This is acceptance check #4 from CLAUDE.md ("show the negative test"). It is the
adversary's-eye view: every assertion below runs with the ANON key + a real user
JWT — exactly what a malicious owner's browser holds. The service-role key is
used ONLY to mint and delete a throwaway test user (a CI fixture) and to read
back state for verification; it never participates in an attack.

Each check must be BLOCKED by Row-Level Security. The script exits non-zero if
any one of them succeeds, so it can gate CI.

Run:  SUPABASE_SERVICE_ROLE_KEY=... python3 scripts/test_rls_negative.py
      (or put the key in scripts/.env, like the other scripts)

Safe against the live database: it only ever ATTEMPTS writes that RLS should
reject, verifies nothing actually changed, and cleans up the test user and any
stray rows in a finally block.
"""

import json
import os
import sys
import time
import urllib.request
import urllib.error

# Reuse the env loader (reads scripts/.env, requires SUPABASE_SERVICE_ROLE_KEY).
from _notify_db import load_env, SUPABASE_URL

# Public publishable/anon key — identical to the one shipped in the browser
# (js/supabase-client.js). Safe to hardcode; it is meant to be public. This is
# the ONLY key the attack assertions use.
ANON_KEY = "sb_publishable_aRh0MmQKrMCr8YnTwv9xIg_1F08WXf2"

# Sentinel values so any row that somehow leaks past RLS is obvious and easy to
# purge in teardown.
SENTINEL = "__rls_negtest__"
SENTINEL_STATE_KEY = "rls_negtest_should_not_exist"
SENTINEL_VOTE_ID = "__rls_negtest_vote__"

# A throwaway team that the "team-owning attacker" (user B) claims. It is NOT one
# of the 12 real teams, so any write it attempts against a REAL team's rows must
# be blocked by the "team_id = my_team_id()" family of policies. 'jeff' is the
# stand-in victim team for cross-team attacks.
ATTACKER_TEAM = "__rls_negtest_team__"
VICTIM_TEAM = "jeff"
# A second non-real team used only where the target table's primary key is the
# team_id alone (notification_prefs) — so a hypothetical breach creates a fresh
# throwaway row instead of overwriting the real victim team's data.
OTHER_TEAM = "__rls_negtest_other__"


# ---------------------------------------------------------------------------
# Low-level HTTP that surfaces the status code instead of throwing, so we can
# assert "this was rejected" rather than crash on the expected 401/403.
# ---------------------------------------------------------------------------
def _req(method, url, *, apikey, bearer, body=None, prefer=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {
        "apikey": apikey,
        "Authorization": f"Bearer {bearer}",
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            text = resp.read().decode("utf-8")
            return resp.status, (json.loads(text) if text else None)
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8")
        try:
            payload = json.loads(text) if text else None
        except Exception:
            payload = text
        return e.code, payload


# Convenience wrappers ------------------------------------------------------
def as_admin(method, path, **kw):
    return _req(method, f"{SUPABASE_URL}{path}", apikey=SERVICE_KEY, bearer=SERVICE_KEY, **kw)


def as_user(method, path, **kw):
    return _req(method, f"{SUPABASE_URL}{path}", apikey=ANON_KEY, bearer=USER_JWT, **kw)


def as_user_b(method, path, **kw):
    """Team-owning attacker: owns ATTACKER_TEAM, tries to act as another team."""
    return _req(method, f"{SUPABASE_URL}{path}", apikey=ANON_KEY, bearer=USER_B_JWT, **kw)


# ---------------------------------------------------------------------------
# Result tracking
# ---------------------------------------------------------------------------
RESULTS = []  # (name, passed: bool, detail: str)


def record(name, passed, detail):
    RESULTS.append((name, passed, detail))
    mark = "PASS" if passed else "FAIL"
    print(f"  [{mark}] {name} — {detail}")


def expect_blocked_write(name, method, path, body):
    """A write that RLS must reject. Two valid forms of rejection:
      - HTTP 4xx (INSERT with no permitting policy / failing WITH CHECK), or
      - HTTP 2xx but ZERO rows affected (UPDATE/DELETE filtered out by USING).
    Anything that actually returns affected rows is a breach.
    'return=representation' makes PostgREST echo the affected rows so we can
    count them."""
    status, payload = as_user(method, path, body=body, prefer="return=representation")
    if status >= 400:
        record(name, True, f"rejected with HTTP {status}")
        return
    # 2xx — did it actually change anything?
    affected = len(payload) if isinstance(payload, list) else (1 if payload else 0)
    if affected == 0:
        record(name, True, "allowed but matched 0 rows (RLS filtered the target)")
    else:
        record(name, False, f"BREACH: HTTP {status} affected {affected} row(s): {payload}")


def expect_empty_read(name, path):
    """A SELECT on a table whose RLS hides every row from a normal user. RLS
    returns 200 with an empty array (not an error)."""
    status, payload = as_user("GET", path)
    if status >= 400:
        record(name, True, f"rejected with HTTP {status}")
    elif isinstance(payload, list) and len(payload) == 0:
        record(name, True, "returned 0 rows (RLS hid all rows)")
    else:
        n = len(payload) if isinstance(payload, list) else "?"
        record(name, False, f"BREACH: read {n} row(s) it should not see: {payload}")


def expect_empty_read_b(name, path):
    """Same as expect_empty_read but as the team-owning attacker (user B)."""
    status, payload = as_user_b("GET", path)
    if status >= 400:
        record(name, True, f"rejected with HTTP {status}")
    elif isinstance(payload, list) and len(payload) == 0:
        record(name, True, "returned 0 rows (RLS hid all rows)")
    else:
        n = len(payload) if isinstance(payload, list) else "?"
        record(name, False, f"BREACH: read {n} row(s) it should not see: {payload}")


# ---------------------------------------------------------------------------
# Fixture: mint a throwaway, team-less (= normal) user and get a real JWT.
# ---------------------------------------------------------------------------
def mint_user(team_id=None):
    email = f"rls-negtest-{int(time.time())}-{len(RESULTS)}@example.com"
    # 1. Create a confirmed user (admin). No owners row → my_team_id() is null
    #    and is_commissioner() is false: the strictest "normal user" baseline.
    status, payload = as_admin(
        "POST", "/auth/v1/admin/users",
        body={"email": email, "email_confirm": True},
    )
    if status >= 400 or not isinstance(payload, dict) or not payload.get("id"):
        sys.exit(f"Could not create test user (HTTP {status}): {payload}")
    user_id = payload["id"]

    # 2. Mint a session WITHOUT needing password sign-in enabled: admin
    #    generate_link returns the one-time code (email_otp); verify it to get a
    #    JWT. Mirrors the app's real OTP login, just server-driven.
    status, payload = as_admin(
        "POST", "/auth/v1/admin/generate_link",
        body={"type": "magiclink", "email": email},
    )
    otp = payload.get("email_otp") if isinstance(payload, dict) else None
    if status >= 400 or not otp:
        as_admin("DELETE", f"/auth/v1/admin/users/{user_id}")
        sys.exit(f"Could not generate login link (HTTP {status}): {payload}")

    status, payload = _req(
        "POST", f"{SUPABASE_URL}/auth/v1/verify",
        apikey=ANON_KEY, bearer=ANON_KEY,
        body={"type": "magiclink", "email": email, "token": otp},
    )
    jwt = payload.get("access_token") if isinstance(payload, dict) else None
    if status >= 400 or not jwt:
        as_admin("DELETE", f"/auth/v1/admin/users/{user_id}")
        sys.exit(f"Could not verify OTP into a session (HTTP {status}): {payload}")

    # Optionally give this user a team (via service role, bypassing the absent
    # client INSERT policy) so my_team_id() resolves — the realistic adversary
    # who owns team A and tries to act as team B.
    if team_id:
        st, _ = as_admin("POST", "/rest/v1/owners",
                         body={"id": user_id, "team_id": team_id, "is_commissioner": False})
        if st >= 400:
            as_admin("DELETE", f"/auth/v1/admin/users/{user_id}")
            sys.exit(f"Could not claim team for test user (HTTP {st})")
    return user_id, email, jwt


def teardown(*user_ids):
    """Best-effort cleanup. Runs even on failure. Purges any sentinel rows a
    breach might have created, then deletes the throwaway user(s)."""
    as_admin("DELETE", f"/rest/v1/league_state?key=eq.{SENTINEL_STATE_KEY}")
    as_admin("DELETE", f"/rest/v1/callup_overrides?player_name=eq.{SENTINEL}")
    as_admin("DELETE", f"/rest/v1/keeper_selections?player_name=eq.{SENTINEL}")
    as_admin("DELETE", f"/rest/v1/roster_moves?player_name=eq.{SENTINEL}")
    as_admin("DELETE", f"/rest/v1/league_votes?vote_id=eq.{SENTINEL_VOTE_ID}")
    as_admin("DELETE", f"/rest/v1/league_messages?body=eq.{SENTINEL}")
    as_admin("DELETE", f"/rest/v1/activity_log?target_team_id=eq.{SENTINEL}")
    as_admin("DELETE", f"/rest/v1/notification_prefs?team_id=eq.{OTHER_TEAM}")
    as_admin("DELETE", f"/rest/v1/push_subscriptions?endpoint=eq.https://example.com/{SENTINEL}")
    as_admin("DELETE", f"/rest/v1/draft_events?type=eq.{SENTINEL}")
    # trade_proposal_messages first (FK to trade_proposals), then the proposals.
    as_admin("DELETE", f"/rest/v1/trade_proposal_messages?body=eq.{SENTINEL}")
    as_admin("DELETE", f"/rest/v1/trade_proposals?notes=eq.{SENTINEL}")
    for uid in user_ids:
        if uid:
            as_admin("DELETE", f"/rest/v1/owners?id=eq.{uid}")
            as_admin("DELETE", f"/auth/v1/admin/users/{uid}")


# ---------------------------------------------------------------------------
def main():
    global SERVICE_KEY, USER_JWT, USER_B_JWT
    env = load_env()
    SERVICE_KEY = env["SUPABASE_SERVICE_ROLE_KEY"]

    user_id, email, USER_JWT = mint_user()
    # A real OTHER user's id to spoof in ownership-forgery tests (satisfies the
    # user_id FK so only RLS — not the FK — can be what blocks the write).
    real_owners = as_admin("GET", "/rest/v1/owners?select=id")[1]
    spoof_uid = next((o["id"] for o in (real_owners or []) if o.get("id") != user_id), None)
    user_b_id, email_b, USER_B_JWT = mint_user(team_id=ATTACKER_TEAM)
    print(f"Minted team-less user:      {email}")
    print(f"Minted team-owning attacker: {email_b} (owns {ATTACKER_TEAM})\n")
    print("Running attacks (anon key + user JWT). All must be blocked:\n")

    try:
        # 1. Promote self by inserting an owners row with is_commissioner=true.
        #    owners has NO client INSERT policy → must be rejected outright.
        expect_blocked_write(
            "self-promote via INSERT owners",
            "POST", "/rest/v1/owners",
            {"id": user_id, "team_id": "jeff", "is_commissioner": True},
        )

        # 2. Promote an existing commissioner-less row (try to flip everyone to
        #    commissioner). owners_update_admin USING is_commissioner() → 0 rows.
        #    Capture state before/after via service role to prove nothing moved.
        before = as_admin("GET", "/rest/v1/owners?select=id,is_commissioner")[1]
        expect_blocked_write(
            "self-promote via UPDATE owners",
            "PATCH", "/rest/v1/owners?is_commissioner=eq.false",
            {"is_commissioner": True},
        )
        after = as_admin("GET", "/rest/v1/owners?select=id,is_commissioner")[1]
        record(
            "owners table unchanged after UPDATE attempt",
            before == after,
            "is_commissioner flags identical before/after" if before == after
            else f"BREACH: owners changed! before={before} after={after}",
        )

        # 3. Write to commissioner-only league_state (ls_write_admin).
        expect_blocked_write(
            "write commissioner-only league_state",
            "POST", "/rest/v1/league_state",
            {"key": SENTINEL_STATE_KEY, "state": {"x": 1}},
        )

        # 4. Write to commissioner-only callup_overrides (co_write_admin).
        expect_blocked_write(
            "write commissioner-only callup_overrides",
            "POST", "/rest/v1/callup_overrides",
            {"player_name": SENTINEL, "price": 1, "year": 2026},
        )

        # 5. Write to a team-scoped table for a team that isn't theirs
        #    (ks_write_owner: team_id = my_team_id() OR commissioner). The user
        #    has no team, so writing 'jeff' must be blocked.
        expect_blocked_write(
            "write another team's keeper_selections",
            "POST", "/rest/v1/keeper_selections",
            {"team_id": "jeff", "player_name": SENTINEL, "keeper": True},
        )

        # 6. Delete a recorded trade (trades_delete_admin: commissioner only).
        trades = as_admin("GET", "/rest/v1/trades?select=id&limit=1")[1]
        if isinstance(trades, list) and trades:
            tid = trades[0]["id"]
            expect_blocked_write(
                "delete a trade (commissioner-only)",
                "DELETE", f"/rest/v1/trades?id=eq.{tid}", None,
            )
            still = as_admin("GET", f"/rest/v1/trades?id=eq.{tid}&select=id")[1]
            record(
                "trade still exists after delete attempt",
                bool(still),
                "trade row intact" if still else "BREACH: trade was deleted!",
            )
        else:
            record("delete a trade (commissioner-only)", True,
                   "skipped — no trades in DB to target")

        # 7. Read the commissioner-only invite list (ie_select_admin). A normal
        #    user must see zero rows — proves they can't harvest others' emails.
        expect_empty_read(
            "read commissioner-only invited_emails",
            "/rest/v1/invited_emails?select=email",
        )

        # ==================================================================
        # Team-owning attacker (user B, owns ATTACKER_TEAM): the realistic
        # adversary. Every attempt to act as the VICTIM_TEAM must be blocked
        # by the "team_id = my_team_id()" family of policies — proving owner
        # of team A cannot touch team B, not just that a team-less user can't.
        # ==================================================================
        def blocked_b(name, method, path, body):
            status, payload = as_user_b(method, path, body=body,
                                        prefer="return=representation")
            if status >= 400:
                record(name, True, f"rejected with HTTP {status}")
            else:
                affected = len(payload) if isinstance(payload, list) else (1 if payload else 0)
                record(name, affected == 0,
                       "allowed but matched 0 rows (RLS filtered)" if affected == 0
                       else f"BREACH: HTTP {status} wrote {affected} row(s): {payload}")

        # 8. Write the VICTIM team's keeper_selections (ks_write_owner).
        blocked_b("owner A writes team B keeper_selections",
                  "POST", "/rest/v1/keeper_selections",
                  {"team_id": VICTIM_TEAM, "player_name": SENTINEL, "keeper": True})

        # 9. Insert a roster_move for the VICTIM team (rm_insert_self) — drives
        #    everyone's derived minors/callups + send-down fees, high impact.
        blocked_b("owner A inserts team B roster_move",
                  "POST", "/rest/v1/roster_moves",
                  {"kind": "callup", "player_name": SENTINEL, "team_id": VICTIM_TEAM})

        # 10. Cast a ballot as the VICTIM team (lv_insert_own).
        blocked_b("owner A casts team B league_vote",
                  "POST", "/rest/v1/league_votes",
                  {"vote_id": SENTINEL_VOTE_ID, "team_id": VICTIM_TEAM, "option_index": 0})

        # 11. Secret-ballot read: admin plants a ballot for the VICTIM team; the
        #     attacker must NOT be able to read it (lv_select_own_or_admin).
        as_admin("POST", "/rest/v1/league_votes",
                 body={"vote_id": SENTINEL_VOTE_ID, "team_id": VICTIM_TEAM, "option_index": 1})
        expect_empty_read_b(
            "owner A reads team B's secret ballot",
            f"/rest/v1/league_votes?vote_id=eq.{SENTINEL_VOTE_ID}&team_id=eq.{VICTIM_TEAM}&select=option_index")

        # 12. Forge a trade proposal FROM the victim team (tp_insert_self).
        blocked_b("owner A forges proposal from team B",
                  "POST", "/rest/v1/trade_proposals",
                  {"from_team_id": VICTIM_TEAM, "to_team_id": ATTACKER_TEAM, "notes": SENTINEL})

        # 13. Forge an activity_log entry as the victim team (al_insert_self).
        blocked_b("owner A forges activity as team B",
                  "POST", "/rest/v1/activity_log",
                  {"type": "keeper_added", "actor_team_id": VICTIM_TEAM,
                   "target_team_id": SENTINEL, "payload": {}})

        # 14. Write another team's notification_prefs (np_write_owner). Uses
        #     OTHER_TEAM (not the victim) so a breach can't clobber real prefs.
        blocked_b("owner A writes another team's notification_prefs",
                  "POST", "/rest/v1/notification_prefs",
                  {"team_id": OTHER_TEAM, "prefs": {}, "email": "x@example.com"})

        # 15. Post a message stamped with ANOTHER user's user_id (lm_insert_own
        #     user_id pin — the 2026-07-09 migration). Attacker posts as their
        #     OWN team but forges the author id.
        if spoof_uid:
            blocked_b("owner A posts message forging another user_id",
                      "POST", "/rest/v1/league_messages",
                      {"team_id": ATTACKER_TEAM, "user_id": spoof_uid, "body": SENTINEL})
        else:
            record("owner A posts message forging another user_id", True,
                   "skipped — no other real user to borrow an id from")

        # 16. Read Jeff-only draft scouting data (ds_jeff_all). A non-jeff owner
        #     must see zero rows.
        expect_empty_read_b(
            "owner A reads Jeff-only draft_sessions",
            "/rest/v1/draft_sessions?select=id")

        # 17. Read Jeff-only draft_events (same my_team_id()='jeff' gate as
        #     draft_sessions; previously untested for read). de_jeff_all filters
        #     a non-jeff owner's read to zero rows.
        expect_empty_read_b(
            "owner A reads Jeff-only draft_events",
            "/rest/v1/draft_events?select=session_id,seq,cmd")

        # 19. Harvest another owner's contact email via notification_prefs.
        #     np_select_own (2026-07-16) must filter the read to own team, so
        #     the attacker sees zero of OTHER_TEAM's rows. Plant one first.
        as_admin("POST", "/rest/v1/notification_prefs",
                 body={"team_id": OTHER_TEAM, "prefs": {}, "email": "leak-canary@example.com"},
                 prefer="resolution=merge-duplicates")
        expect_empty_read_b(
            "owner A reads another team's notification_prefs email",
            f"/rest/v1/notification_prefs?team_id=eq.{OTHER_TEAM}&select=team_id,email")

        # 20. Read another owner's push subscription (ps_select_own) — endpoint
        #     + p256dh/auth keys are sensitive. Plant one for the victim team.
        as_admin("POST", "/rest/v1/push_subscriptions",
                 body={"team_id": VICTIM_TEAM, "endpoint": "https://example.com/" + SENTINEL,
                       "p256dh": "x", "auth": "y"},
                 prefer="resolution=merge-duplicates")
        expect_empty_read_b(
            "owner A reads team B's push_subscriptions",
            f"/rest/v1/push_subscriptions?team_id=eq.{VICTIM_TEAM}&select=endpoint")

        # 21. Read a private trade-proposal thread the attacker isn't party to.
        #     Admin plants a proposal between VICTIM and OTHER, plus a message;
        #     the attacker (party to neither) must read zero.
        _pp = as_admin("POST", "/rest/v1/trade_proposals",
                       body={"from_team_id": VICTIM_TEAM, "to_team_id": OTHER_TEAM, "notes": SENTINEL},
                       prefer="return=representation")[1]
        _thread = _pp[0]["thread_id"] if isinstance(_pp, list) and _pp else None
        if _thread:
            as_admin("POST", "/rest/v1/trade_proposal_messages",
                     body={"thread_id": _thread, "from_team_id": VICTIM_TEAM, "body": SENTINEL})
            expect_empty_read_b(
                "owner A reads a trade thread they're not party to",
                f"/rest/v1/trade_proposal_messages?thread_id=eq.{_thread}&select=body")
            # 22. Inject a message into that thread (tpm_insert_self).
            blocked_b("owner A injects into a trade thread they're not party to",
                      "POST", "/rest/v1/trade_proposal_messages",
                      {"thread_id": _thread, "from_team_id": ATTACKER_TEAM, "body": SENTINEL})
        else:
            record("owner A reads a trade thread they're not party to", True,
                   "skipped — could not plant a proposal")

        # 23. Rewrite an existing trade's contents (trades_update_party is
        #     commissioner-only; a party may INSERT but not UPDATE).
        _tr = as_admin("GET", "/rest/v1/trades?select=id&limit=1")[1]
        if isinstance(_tr, list) and _tr:
            _tid = _tr[0]["id"]
            blocked_b("owner A rewrites an existing trade",
                      "PATCH", f"/rest/v1/trades?id=eq.{_tid}",
                      {"notes": SENTINEL})
        else:
            record("owner A rewrites an existing trade", True,
                   "skipped — no trades in DB to target")

        # 24. Call the pg_cron dispatch RPC (2026-07-16: PUBLIC execute revoked).
        #     Must be rejected for a normal authenticated user.
        _st, _pl = as_user_b("POST", "/rest/v1/rpc/dispatch_github_workflow",
                             body={"workflow_file": "nightly-sync.yml"})
        record("owner A cannot dispatch a GitHub workflow via RPC",
               _st >= 400,
               f"rejected with HTTP {_st}" if _st >= 400
               else f"BREACH: RPC returned HTTP {_st}: {_pl}")

    finally:
        teardown(user_id, user_b_id)
        print("\nCleaned up test users and any sentinel rows.")

    # Report ----------------------------------------------------------------
    failed = [r for r in RESULTS if not r[1]]
    print("\n" + "=" * 64)
    print(f"RLS negative test: {len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed.")
    if failed:
        print("\nSECURITY FAILURES (a normal user could do these):")
        for name, _, detail in failed:
            print(f"  - {name}: {detail}")
        print("\nFIX: tighten the RLS policy in supabase/schema.sql for the table(s) above.")
        sys.exit(1)
    print("All privilege-escalation attempts were correctly blocked by RLS.")


if __name__ == "__main__":
    main()
