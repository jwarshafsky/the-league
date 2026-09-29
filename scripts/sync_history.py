#!/usr/bin/env python3
"""
Fetches final standings from past seasons via the ESPN fantasy API and writes
js/history-snapshot.js with each year's top-three finishers (and full
standings).

Usage:  python3 scripts/sync_history.py
Reads ESPN cookies from scripts/.env (same as sync_espn.sh).
"""

import json
import os
import shutil
import sys
import urllib.request
from datetime import datetime, timezone

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
ENV_FILE = os.path.join(ROOT_DIR, "scripts", ".env")
OUT_FILE = os.path.join(ROOT_DIR, "js", "history-snapshot.js")
TMP_DIR = "/tmp/fantasy-league/js"

# Years to fetch. 2020 is excluded (COVID-shortened, doesn't count).
# Earlier years (2017-2018) typically return 401/404 from the modern ESPN
# API — fall back to MANUAL_HISTORY below for those years.
# Through the current calendar year, so a finished 2027+ season is picked up
# without a code edit (an in-progress season has no rankCalculatedFinal yet
# and a not-yet-renewed one 404s — both are skipped, not written as empty).
YEARS = [y for y in range(2017, datetime.now(timezone.utc).year + 1) if y != 2020]
LEAGUE_ID = "1200"
BASE_URL = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/flb"

# Manually-entered standings for years the API won't return. Format matches
# what extract_standings() would produce. abbrev is what the trophy room maps
# via HISTORICAL_ABBREV_OVERRIDES in app.js — keep them consistent.
MANUAL_HISTORY = {
    2017: [
        {"rank": 1, "abbrev": "Jeff", "name": "Acuña Matata", "points": 96},
        {"rank": 2, "abbrev": "SHAR", "name": "Now Yu Cano", "points": 89},
        {"rank": 3, "abbrev": "GOLD", "name": "Goldschmidt Happens", "points": 87.5},
        {"rank": 4, "abbrev": "$$$$", "name": "Team Big Mike", "points": 86},
        {"rank": 5, "abbrev": "LLC", "name": "Quintanamo Bay LLC", "points": 69},
        {"rank": 6, "abbrev": "ROTB", "name": "Rotbart Means Red Beard", "points": 64},
        {"rank": 7, "abbrev": "KFP", "name": "Team Kung Froe Panda", "points": 60},
        {"rank": 8, "abbrev": "EISE", "name": "Team Eisenman", "points": 56.5},
        {"rank": 9, "abbrev": "Team Levy", "name": "Team Levy", "points": 50},
        {"rank": 10, "abbrev": "PIFE", "name": "Silver Bullet Band", "points": 48},
        {"rank": 11, "abbrev": "Team Weintraub", "name": "Team Weintraub", "points": 47},
        {"rank": 12, "abbrev": "KESS", "name": "Team Kessler", "points": 27},
    ],
    # 2018: Saxton and Heller tied for 2nd at 83 — no 3rd place finisher.
    2018: [
        {"rank": 1, "abbrev": "Jeff", "name": "Acuña Matata", "points": 118.5},
        {"rank": 2, "abbrev": "SHAR", "name": "Drapes Match The Carpenter", "points": 83},
        {"rank": 2, "abbrev": "Shanghai Leavings", "name": "Shanghai Leavings", "points": 83},
        {"rank": 4, "abbrev": "HD", "name": "Hitting Display", "points": 79.5},
        {"rank": 5, "abbrev": "ROTB", "name": "Yu Maeda Me Do It", "points": 78.5},
        {"rank": 6, "abbrev": "PIFE", "name": "Spring the Bell Jesus Saves", "points": 61.5},
        {"rank": 7, "abbrev": "LLC", "name": "Shohei The Money", "points": 57},
        {"rank": 8, "abbrev": "KESS", "name": "Team Kessler", "points": 50.5},
        {"rank": 9, "abbrev": "#416", "name": "The Yanger Bombs", "points": 48.5},
        {"rank": 10, "abbrev": "ES", "name": "Team Eaton Sanoas", "points": 47.5},
        {"rank": 11, "abbrev": "$$$$", "name": "Team Big Mike", "points": 37},
        {"rank": 12, "abbrev": "GOLD", "name": "Goldschmidt Happens", "points": 35.5},
    ],
}


def load_env():
    env = {}
    if not os.path.exists(ENV_FILE):
        print(f"Missing {ENV_FILE}. Copy scripts/.env.example to scripts/.env and fill it in.", file=sys.stderr)
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


def fetch_year(year, swid, s2):
    url = f"{BASE_URL}/seasons/{year}/segments/0/leagues/{LEAGUE_ID}?view=mTeam"
    req = urllib.request.Request(url, headers={
        "Cookie": f"SWID={swid}; espn_s2={s2}",
        "User-Agent": "fantasy-league-history-sync/1.0",
    })
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        print(f"  {year}: fetch failed — {e}", file=sys.stderr)
        return None


def extract_standings(data):
    teams = data.get("teams", []) if data else []
    out = []
    for t in teams:
        rank = t.get("rankCalculatedFinal")
        if not rank or rank <= 0:
            continue
        full = (t.get("location", "") + " " + t.get("nickname", "")).strip()
        out.append({
            "rank": rank,
            "abbrev": t.get("abbrev", ""),
            "name": full or t.get("abbrev", ""),
            "espnId": t.get("id"),
            "points": t.get("points"),  # total roto points
        })
    out.sort(key=lambda r: r["rank"])
    return out


def load_prev_seasons():
    """Standings from the current history-snapshot.js, keyed by year. Used to
    keep a season when its fetch fails — previously a single failed request
    (expired cookie, ESPN blip) silently deleted that year's champions from
    the Trophy Room on the next write."""
    if not os.path.exists(OUT_FILE):
        return {}
    try:
        text = open(OUT_FILE).read()
        body = text[text.index("{"):text.rindex("}") + 1]
        return {s["year"]: s["standings"] for s in json.loads(body).get("seasons", [])}
    except Exception as e:
        print(f"  could not parse previous {OUT_FILE}: {e}", file=sys.stderr)
        return {}


def main():
    env = load_env()
    swid = env.get("ESPN_SWID")
    s2 = env.get("ESPN_S2")
    if not swid or not s2:
        print("ESPN_SWID and ESPN_S2 must be set in scripts/.env", file=sys.stderr)
        sys.exit(1)

    prev = load_prev_seasons()
    seasons = []
    for year in YEARS:
        print(f"Fetching {year}...")
        data = fetch_year(year, swid, s2)
        standings = extract_standings(data)
        if not standings and year in prev:
            standings = prev[year]
            print(f"  {year}: no fresh standings — keeping previous snapshot's entry")
        if not standings and year in MANUAL_HISTORY:
            standings = MANUAL_HISTORY[year]
            print(f"  {year}: using MANUAL_HISTORY entry")
        if not standings:
            print(f"  {year}: no standings — skipping")
            continue
        seasons.append({"year": year, "standings": standings})

    # Newest first in the rendered output.
    seasons.sort(key=lambda s: s["year"], reverse=True)

    snapshot = {
        "syncedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "seasons": seasons,
    }

    with open(OUT_FILE, "w") as f:
        f.write("// Auto-generated by scripts/sync_history.py - do not edit by hand.\n")
        f.write("// Run `python3 scripts/sync_history.py` to refresh.\n")
        f.write(f"const HISTORY_SNAPSHOT = {json.dumps(snapshot, indent=2)};\n")

    print(f"\nWrote {OUT_FILE}")
    print(f"  {len(seasons)} seasons")

    if os.path.isdir(TMP_DIR):
        shutil.copy(OUT_FILE, os.path.join(TMP_DIR, "history-snapshot.js"))
        print(f"  Mirrored to {TMP_DIR}/")


if __name__ == "__main__":
    main()
