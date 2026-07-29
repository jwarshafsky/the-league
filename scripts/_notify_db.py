# Shared helpers used by the notification scripts. Reads scripts/.env for the
# Supabase service-role key and queries the public REST + Admin API.

import json
import os
import sys
import re
import urllib.request
import urllib.parse
import urllib.error
from datetime import datetime, timezone

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
ENV_FILE = os.path.join(ROOT, "scripts", ".env")
SUPABASE_URL = "https://fbllfkrtjsihrkwnbmlw.supabase.co"
APP_URL = "https://league.jwarshafsky.com/"

TEAM_NAMES = {
    "jeff": "Jeff", "matt": "Matt", "jesse": "Jesse", "sam": "Sam",
    "saxton": "Saxton", "aj": "AJ", "corey": "Corey", "dave": "Dave",
    "josh-doug": "Josh/Doug", "larry": "Larry", "zack": "Zack",
    "glicksman": "Glicksman",
}


def load_env():
    """Read scripts/.env if present, then overlay process environment so the
    same scripts work under cron (reading the file) and under GitHub Actions
    (where secrets arrive as env vars and no .env file exists)."""
    env = {}
    if os.path.exists(ENV_FILE):
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
    for k, v in os.environ.items():
        env.setdefault(k, v)
    if not env.get("SUPABASE_SERVICE_ROLE_KEY"):
        print(f"SUPABASE_SERVICE_ROLE_KEY not set (looked in {ENV_FILE} + process env)",
              file=sys.stderr)
        sys.exit(1)
    return env


def parse_ts(s):
    if not s: return None
    s = re.sub(r"\.\d+", "", s).replace("Z", "+00:00")
    try: return datetime.fromisoformat(s)
    except Exception: return None


def http_request(method, url, key, body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        text = resp.read().decode("utf-8")
        return json.loads(text) if text else None


def http_get(url, key): return http_request("GET", url, key)
def http_post(url, key, body): return http_request("POST", url, key, body)
def http_patch(url, key, body): return http_request("PATCH", url, key, body)


def team_name(t): return TEAM_NAMES.get(t, t or "?")


# scripts/test_rls_negative.py plants REAL trade proposals / messages between
# fake teams to prove RLS blocks third-party reads. Those inserts fire the
# ordinary triggers, so they mint activity_log rows carrying a fake team id --
# and until the teardown fix, a stale one reached the nightly digest as though
# it were league news. teardown() now purges them, but it runs seconds after
# the insert while notify_instant.py polls every minute, so a run can still be
# caught mid-flight. Notifications are the only consumer that must never see a
# fixture, so the guard lives here, on the one fetch all three notifiers share.
TEST_TEAM_PREFIX = "__rls_negtest"

# Applied SERVER-side, deliberately. Filtering the returned list in Python would
# shrink a full page and trip fetch_activity_paged()'s `len(page) < PAGE_SIZE`
# stop condition in weekly_report.py, silently truncating real activity. Keeping
# it in the query means `limit` counts post-filter rows.
#
# Each column needs the `is.null` arm: both are nullable (schema.sql), and
# `NULL NOT LIKE x` is NULL, not true -- a bare not.like would drop every
# null-team row. Note `_` is a LIKE single-char wildcard, so this is marginally
# broader than a literal prefix; no real team id can match `..rls_negtest%`.
_NOT_TEST_FIXTURE = (
    "and=("
    f"or(actor_team_id.is.null,actor_team_id.not.like.{TEST_TEAM_PREFIX}*),"
    f"or(target_team_id.is.null,target_team_id.not.like.{TEST_TEAM_PREFIX}*)"
    ")"
)


def fetch_activity_since(key, since_iso=None, since_id=None, limit=500):
    """Fetch activity_log rows newer than the given timestamp or id.

    Excludes RLS-test fixture rows — see _NOT_TEST_FIXTURE."""
    parts = [f"select=*", f"order=created_at.asc", f"limit={limit}",
             _NOT_TEST_FIXTURE]
    if since_iso:
        parts.append(f"created_at=gte.{urllib.parse.quote(since_iso)}")
    if since_id:
        # PostgREST string comparison on uuid works because uuids are stored
        # lexicographically — but easier to just use created_at.
        pass
    url = f"{SUPABASE_URL}/rest/v1/activity_log?" + "&".join(parts)
    return http_get(url, key)


def fetch_all_owners(key):
    # is_head_commissioner gates who may receive other teams' private trade
    # negotiations. Fall back to the narrower select if the column isn't
    # deployed yet — callers treat a missing flag as "not head commissioner",
    # which fails closed.
    cols = "id,team_id,is_commissioner,is_head_commissioner"
    try:
        return http_get(f"{SUPABASE_URL}/rest/v1/owners?select={cols}", key)
    except Exception:
        return http_get(f"{SUPABASE_URL}/rest/v1/owners?select=id,team_id,is_commissioner", key)


def fetch_emails_by_user_id(key):
    """Returns { user_id: email }. Uses the admin API to list all users."""
    out = {}
    page = 1
    while True:
        url = f"{SUPABASE_URL}/auth/v1/admin/users?per_page=200&page={page}"
        body = http_get(url, key) or {}
        users = body.get("users") if isinstance(body, dict) else body
        if not users: break
        for u in users:
            uid, email = u.get("id"), u.get("email")
            if uid and email: out[uid] = email
        if isinstance(body, dict) and len(users) < 200: break
        page += 1
        if page > 10: break  # safety
    return out


def fetch_notify_prefs(key):
    """Returns { team_id: { prefs, receive_all, email } }."""
    rows = http_get(f"{SUPABASE_URL}/rest/v1/notification_prefs?select=*", key) or []
    out = {}
    for r in rows:
        out[r["team_id"]] = {
            "prefs": r.get("prefs") or {},
            "receive_all": bool(r.get("receive_all")),
            "email": r.get("email"),
        }
    return out


def fetch_push_subs(key):
    return http_get(f"{SUPABASE_URL}/rest/v1/push_subscriptions?select=*", key) or []


def fetch_league_state_row(key, state_key):
    url = f"{SUPABASE_URL}/rest/v1/league_state?key=eq.{state_key}&select=state"
    rows = http_get(url, key) or []
    return rows[0]["state"] if rows else None


def fetch_league_state_row_v(key, state_key):
    """Like fetch_league_state_row but also returns the row's optimistic-
    concurrency version (0 if the row or column doesn't exist yet)."""
    url = f"{SUPABASE_URL}/rest/v1/league_state?key=eq.{state_key}&select=state,version"
    try:
        rows = http_get(url, key) or []
    except Exception:
        # version column not deployed yet — fall back to unversioned read.
        return fetch_league_state_row(key, state_key), 0
    if not rows: return None, 0
    return rows[0]["state"], rows[0].get("version") or 0


class LeagueStateConflict(Exception):
    """Raised when a CAS write loses to a concurrent writer."""


def save_league_state_row_cas(key, state_key, state, expected_version):
    """Compare-and-swap write via the save_league_state RPC so this script
    can never clobber a row a browser wrote after we read it (e.g. a draft
    pick submitted mid-run). Raises LeagueStateConflict on a lost race.
    Falls back to a blind upsert until the 2026-07-16 migration is applied."""
    body = json.dumps({
        "p_key": state_key, "p_state": state,
        "p_expected_version": expected_version,
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/rpc/save_league_state",
        method="POST", data=body, headers={
            "apikey": key, "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        })
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return int((resp.read() or b"0").decode("utf-8").strip() or 0)
    except urllib.error.HTTPError as e:
        detail = ""
        try: detail = e.read().decode("utf-8", "replace")
        except Exception: pass
        if "version_conflict" in detail or '"40001"' in detail:
            raise LeagueStateConflict(state_key)
        if e.code == 404 or "PGRST202" in detail:
            upsert_league_state_row(key, state_key, state)
            return (expected_version or 0) + 1
        raise


def fetch_trades(key):
    """All trades, chronological — needed to resolve trade-log pick ownership."""
    return http_get(f"{SUPABASE_URL}/rest/v1/trades?select=*&order=created_at.asc", key) or []


def upsert_league_state_row(key, state_key, state):
    url = f"{SUPABASE_URL}/rest/v1/league_state?on_conflict=key"
    req = urllib.request.Request(url, method="POST", data=json.dumps({
        "key": state_key, "state": state,
    }).encode("utf-8"), headers={
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates",
    })
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.read()


def event_category(activity_type):
    """Map an activity_log.type to a notification category key (matches
    NOTIFY_EVENTS keys in app.js). Returns None if the event isn't
    notification-bearing."""
    t = activity_type
    if t in ("proposal_created",): return "trade_proposal"
    if t in ("proposal_accepted", "proposal_rejected", "proposal_withdrawn", "proposal_countered"):
        return "trade_update"
    if t in ("proposal_message_sent", "trade_message"): return "trade_message"
    if t in ("trade_recorded",): return "trade_completed"
    if t in ("keeper_added", "keeper_removed", "minor_keeper_added", "minor_keeper_removed", "trade_block_added", "trade_block_removed"):
        return "keeper_protect"
    if t in ("rule5_added", "rule5_removed"): return "rule5_protect"
    if t in ("player_called_up",): return "callup"
    if t in ("player_sent_down",): return "send_down"
    if t in ("minors_pick_made", "minors_pick_passed", "minors_pick_auto_skipped", "rule5_pick_made", "rule5_pick_auto_skipped"):
        return "draft_picks"
    if t in ("message_posted",): return "board_post"
    if t in ("vote_initiated", "vote_ended"):
        return "league_vote"
    if t == "vote_result_broadcast":
        return "vote_result"
    return None


def _deal_text(p):
    """" — Jeff gets Sale; Saxton gets Reynolds, Yelich" for a proposal payload.

    Proposal payloads (written by the trade_proposals trigger) carry asset
    VALUES as plain strings, unlike trade_recorded whose payload holds full
    asset objects. Returns "" for payloads with no asset lists.
    """
    r1 = ", ".join(str(x) for x in (p.get("team1_receives") or []))
    r2 = ", ".join(str(x) for x in (p.get("team2_receives") or []))
    if not r1 and not r2:
        return ""
    t1, t2 = team_name(p.get("team1")), team_name(p.get("team2"))
    return f" — <strong>{t1}</strong> gets {r1 or '\u2014'}; <strong>{t2}</strong> gets {r2 or '\u2014'}"


def describe_activity(a):
    """Human-readable one-line summary of an activity_log row."""
    p = a.get("payload") or {}
    actor = team_name(a.get("actor_team_id"))
    target = team_name(a.get("target_team_id"))
    name = p.get("player_name") or ""
    t = a.get("type") or ""
    if t == "keeper_added":         return f"{actor} tagged {name} as a keeper"
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
        return f"<strong>{t1}</strong> ↔ <strong>{t2}</strong>: {t1} gets {r1}; {t2} gets {r2}"
    if t == "player_called_up":     return f"{actor} called up {name}"
    if t == "player_sent_down":     return f"{actor} sent {name} back to the minors"
    if t == "callup_price_set":     return f"{actor} set {name}'s call-up price to ${p.get('price')}"
    if t == "minors_pick_made":     return f"{target} picked {name} (R{p.get('round')}.{p.get('pick_in_round')})"
    if t == "minors_pick_passed":   return f"{target} passed at R{p.get('round')}.{p.get('pick_in_round')}"
    if t == "minors_pick_auto_skipped": return f"{target}'s pick auto-skipped at R{p.get('round')}.{p.get('pick_in_round')}"
    if t == "rule5_pick_made":      return f"{target} Rule 5–picked {name}"
    if t == "rule5_pick_auto_skipped": return f"{target}'s Rule 5 pick auto-skipped"
    if t.startswith("proposal_") and t != "proposal_message_sent":
        # The trade_proposals trigger flattens the asset arrays to plain player
        # names, so these render the actual deal. Previously every proposal
        # alert was a bare "X sent a trade proposal to Y" with no contents,
        # which forced a trip into the app just to find out if you cared.
        deal = _deal_text(p)
        if t == "proposal_created":   return f"{actor} sent a trade proposal to {target}{deal}"
        if t == "proposal_countered": return f"{actor} countered {target}'s proposal{deal}"
        if t == "proposal_accepted":  return f"{actor} accepted {target}'s proposal{deal}"
        if t == "proposal_rejected":  return f"{actor} rejected a proposal from {target}"
        if t == "proposal_withdrawn": return f"{actor} withdrew a proposal to {target}"
    if t == "proposal_message_sent":
        preview = p.get("preview") or ""
        return f"{actor} sent a message about a trade" + (f": \u201c{preview}\u201d" if preview else "")
    if t == "message_posted":
        preview = p.get("preview") or ""
        return f"{actor} posted to the message board" + (f": \u201c{preview}\u201d" if preview else "")
    if t == "vote_initiated":       return f"League vote initiated: {p.get('title') or '?'}"
    if t == "vote_ended":
        title = p.get("title") or "vote"
        winner = p.get("winning_option")
        breakdown = p.get("breakdown") or ""
        auto_marker = " (auto: majority reached)" if p.get("auto") else ""
        if winner:
            return f"Vote ended — \"{title}\"{auto_marker}: <strong>{winner}</strong> wins. {breakdown}"
        return f"Vote ended: {title}{auto_marker}"
    if t == "vote_result_broadcast":
        # Sanitized league-wide announcement — totals only, no voter names.
        title = p.get("title") or "vote"
        winner = p.get("winning_option")
        breakdown = p.get("breakdown") or ""  # sanitized form: "Yes: 7 | No: 5"
        total = p.get("total_votes")
        total_part = f" ({total} ballots)" if total else ""
        if winner:
            return f"League vote result — \"{title}\": <strong>{winner}</strong> wins{total_part}. {breakdown}"
        return f"League vote result: {title}{total_part}. {breakdown}"
    return f"{actor} {t}".strip()
