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
APP_URL = "https://jwarshafsky.github.io/the-league/"

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
                env[k.strip()] = v.strip()
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


def fetch_activity_since(key, since_iso=None, since_id=None, limit=500):
    """Fetch activity_log rows newer than the given timestamp or id."""
    parts = [f"select=*", f"order=created_at.asc", f"limit={limit}"]
    if since_iso:
        parts.append(f"created_at=gte.{urllib.parse.quote(since_iso)}")
    if since_id:
        # PostgREST string comparison on uuid works because uuids are stored
        # lexicographically — but easier to just use created_at.
        pass
    url = f"{SUPABASE_URL}/rest/v1/activity_log?" + "&".join(parts)
    return http_get(url, key)


def fetch_all_owners(key):
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
    if t in ("vote_initiated", "vote_ended"):
        return "league_vote"
    if t == "vote_result_broadcast":
        return "vote_result"
    if t == "vote_result_broadcast_test":
        return "vote_result_test"
    return None


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
    if t == "proposal_created":     return f"{actor} sent a trade proposal to {target}"
    if t == "proposal_accepted":    return f"{actor} accepted {target}'s proposal"
    if t == "proposal_rejected":    return f"{actor} rejected a proposal from {target}"
    if t == "proposal_withdrawn":   return f"{actor} withdrew a proposal"
    if t == "proposal_countered":   return f"{actor} countered a proposal"
    if t == "vote_initiated":       return f"League vote initiated: {p.get('title') or '?'}"
    if t == "vote_ended":
        title = p.get("title") or "vote"
        winner = p.get("winning_option")
        breakdown = p.get("breakdown") or ""
        auto_marker = " (auto: majority reached)" if p.get("auto") else ""
        if winner:
            return f"Vote ended — \"{title}\"{auto_marker}: <strong>{winner}</strong> wins. {breakdown}"
        return f"Vote ended: {title}{auto_marker}"
    if t in ("vote_result_broadcast", "vote_result_broadcast_test"):
        # Sanitized league-wide announcement — totals only, no voter names.
        prefix = "[TEST PREVIEW] " if t == "vote_result_broadcast_test" else ""
        title = p.get("title") or "vote"
        winner = p.get("winning_option")
        breakdown = p.get("breakdown") or ""  # sanitized form: "Yes: 7 | No: 5"
        total = p.get("total_votes")
        total_part = f" ({total} ballots)" if total else ""
        if winner:
            return f"{prefix}League vote result — \"{title}\": <strong>{winner}</strong> wins{total_part}. {breakdown}"
        return f"{prefix}League vote result: {title}{total_part}. {breakdown}"
    return f"{actor} {t}".strip()
