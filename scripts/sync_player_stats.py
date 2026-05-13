#!/usr/bin/env python3
"""
Fetches live MLB career hitting/pitching stats for every callup and MiLB player
in js/data.js, then writes js/player-stats-snapshot.js. Run nightly via cron.

Usage:  python3 scripts/sync_player_stats.py
"""

import json
import os
import re
import shutil
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DATA_FILE = os.path.join(ROOT_DIR, "js", "data.js")
IDS_FILE = os.path.join(ROOT_DIR, "scripts", "mlb_ids.json")
OUT_FILE = os.path.join(ROOT_DIR, "js", "player-stats-snapshot.js")
TMP_DIR = "/tmp/fantasy-league/js"

API_BASE = "https://statsapi.mlb.com/api/v1"
USER_AGENT = "fantasy-league-sync/1.0"
SLEEP = 0.15  # seconds between API calls


def http_get(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


def parse_players_from_data():
    """Extract (name, statType) for every callup + minor in data.js."""
    with open(DATA_FILE) as f:
        content = f.read()
    # Player object always has name + statType; majors don't have statType so they're skipped.
    pattern = r'\{\s*name:\s*"([^"]+)"[^}]*?statType:\s*"([^"]+)"[^}]*?\}'
    seen = {}
    for name, stat_type in re.findall(pattern, content):
        if name not in seen:
            seen[name] = stat_type
    return seen


def load_ids_cache():
    if os.path.exists(IDS_FILE):
        with open(IDS_FILE) as f:
            return json.load(f)
    return {}


def save_ids_cache(ids):
    with open(IDS_FILE, "w") as f:
        json.dump(ids, f, indent=2, sort_keys=True)


def search_mlb_id(name):
    encoded = urllib.parse.quote(name)
    try:
        data = http_get(f"{API_BASE}/people/search?names={encoded}")
    except Exception as e:
        print(f"  search error for {name}: {e}", file=sys.stderr)
        return None
    people = data.get("people", [])
    if not people:
        return None
    for p in people:
        if p.get("isPlayer", True):
            return p.get("id")
    return people[0].get("id")


def load_prev_snapshot():
    """Parse the previous player-stats-snapshot.js so a transient API failure
    can preserve last-known stats instead of clobbering them with zeros (which
    would otherwise clear the "Must Call Up" eligibility warning displayed by
    the app)."""
    if not os.path.exists(OUT_FILE):
        return {}
    try:
        text = open(OUT_FILE).read()
        # File body looks like `const PLAYER_STATS = {…};\n`
        m = re.search(r"=\s*(\{[\s\S]*\});?\s*$", text)
        if not m:
            return {}
        data = json.loads(m.group(1))
        return data.get("players", {}) or {}
    except Exception as e:
        print(f"  could not parse previous snapshot: {e}", file=sys.stderr)
        return {}


_PREV_SNAPSHOT = None


def fetch_career_stats(player_id, player_name=None):
    global _PREV_SNAPSHOT
    if _PREV_SNAPSHOT is None:
        _PREV_SNAPSHOT = load_prev_snapshot()

    def _fallback():
        # Preserve the previous snapshot's value if we have one — better than
        # zeroing out and falsely clearing a player's threshold warning.
        prev = _PREV_SNAPSHOT.get(player_name) if player_name else None
        if prev:
            return {
                "careerAB": int(prev.get("careerAB") or 0),
                "careerIP": float(prev.get("careerIP") or 0),
                "_stale": True,
            }
        return {"careerAB": 0, "careerIP": 0.0}

    # One retry on transient errors before giving up. MLB Stats API
    # occasionally returns 5xx during scheduled maintenance windows.
    last_err = None
    for attempt in range(2):
        try:
            data = http_get(
                f"{API_BASE}/people/{player_id}/stats?stats=career&group=hitting,pitching&sportId=1"
            )
            break
        except Exception as e:
            last_err = e
            if attempt == 0:
                time.sleep(0.5)
    else:
        print(f"  stats error for id={player_id} ({player_name}): {last_err}", file=sys.stderr)
        return _fallback()

    career_ab = 0
    career_ip = 0.0
    for block in data.get("stats", []):
        group = block.get("group", {}).get("displayName", "")
        splits = block.get("splits", [])
        if not splits:
            continue
        s = splits[0].get("stat", {})
        if group == "hitting":
            try:
                career_ab = int(s.get("atBats", 0) or 0)
            except (TypeError, ValueError):
                pass
        elif group == "pitching":
            try:
                career_ip = float(s.get("inningsPitched", "0") or 0)
            except (TypeError, ValueError):
                pass
    return {"careerAB": career_ab, "careerIP": career_ip}


def main():
    print(f"Reading {DATA_FILE}...")
    players = parse_players_from_data()
    print(f"Found {len(players)} unique callup + minor players")

    ids = load_ids_cache()

    new_ids = 0
    missing = []
    for name in sorted(players):
        if name in ids:
            continue
        mlb_id = search_mlb_id(name)
        time.sleep(SLEEP)
        if mlb_id is not None:
            ids[name] = mlb_id
            new_ids += 1
            print(f"  Resolved {name} -> {mlb_id}")
        else:
            missing.append(name)
            print(f"  No MLB ID for {name}")

    save_ids_cache(ids)
    if new_ids:
        print(f"Cached {new_ids} new player IDs")
    if missing:
        print(f"Could not resolve {len(missing)} players "
              f"(app falls back to careerStat from data.js for these)")

    print(f"Fetching career stats for {sum(1 for n in players if n in ids)} players...")
    out_players = {}
    stale_count = 0
    for name, stat_type in players.items():
        if name not in ids:
            continue
        mlb_id = ids[name]
        stats = fetch_career_stats(mlb_id, name)
        if stats.get("_stale"):
            stale_count += 1
        out_players[name] = {
            "mlbId": mlb_id,
            "statType": stat_type,
            "careerAB": stats["careerAB"],
            "careerIP": stats["careerIP"],
        }
        time.sleep(SLEEP)
    if stale_count:
        print(f"  ! {stale_count} player(s) preserved at previous values (API errors)", file=sys.stderr)

    synced_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    snapshot = {"syncedAt": synced_at, "players": out_players}

    with open(OUT_FILE, "w") as f:
        f.write("// Auto-generated by scripts/sync_player_stats.py - do not edit by hand.\n")
        f.write("// Run `python3 scripts/sync_player_stats.py` to refresh.\n")
        f.write(f"const PLAYER_STATS = {json.dumps(snapshot, indent=2)};\n")

    print(f"\nWrote {OUT_FILE}")
    print(f"  {len(out_players)} player stats entries")

    if os.path.isdir(TMP_DIR):
        shutil.copy(OUT_FILE, os.path.join(TMP_DIR, "player-stats-snapshot.js"))
        print(f"  Mirrored to {TMP_DIR}/")


if __name__ == "__main__":
    main()
