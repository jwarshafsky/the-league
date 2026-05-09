#!/usr/bin/env python3
"""sync_minors_from_sheet.py — pull live minors + callups rosters from the
league's published Google Sheet, rewrite the `minors` and `callups` arrays
in js/data.js. Leaves `majors` arrays alone (those are keepers, edited by
hand and not in this sheet).

The sheet is the source of truth. Career AB/IP are NOT pulled from the
sheet (sometimes stale) — careerStat defaults to 0 and is overlaid at
runtime by applyLivePlayerStats() from PLAYER_STATS. statType comes from
PLAYER_STATS when available, else falls back to existing data.js, else
defaults to "AB".

Run:  python3 scripts/sync_minors_from_sheet.py
"""

import csv
import json
import re
import sys
import urllib.request
from pathlib import Path

CSV_URL = (
    "https://docs.google.com/spreadsheets/d/e/"
    "2PACX-1vQFC_MfVGEmcv1IAjKNYipNC5vKQRGbb-bYwSxE9R4DWSCtO9Qw8JVkUz2SJwzvYezbDGebvx2fsNCj"
    "/pub?output=csv"
)

# Order of team blocks in the sheet → local team_id used in data.js.
TEAM_ORDER = [
    ("Jeff", "jeff"),
    ("Matt", "matt"),
    ("Jesse", "jesse"),
    ("Sam", "sam"),
    ("Saxton", "saxton"),
    ("AJ", "aj"),
    ("Corey", "corey"),
    ("Dave", "dave"),
    ("Josh/Doug", "josh-doug"),
    ("Larry", "larry"),
    ("Zack", "zack"),
    ("Glicksman", "glicksman"),
]

ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_JS = ROOT_DIR / "js" / "data.js"
STATS_JS = ROOT_DIR / "js" / "player-stats-snapshot.js"


def load_player_stat_types():
    """Map of player name → "AB" or "IP" from player-stats-snapshot.js."""
    if not STATS_JS.exists():
        return {}
    text = STATS_JS.read_text()
    types = {}
    # Each player block: "Name": { "mlbId": ..., "statType": "AB", ... }
    for m in re.finditer(r'"([^"]+)":\s*\{[^{}]*?"statType":\s*"([^"]+)"', text):
        types[m.group(1)] = m.group(2)
    return types


def fetch_sheet_rows():
    with urllib.request.urlopen(CSV_URL) as r:
        body = r.read().decode("utf-8")
    return list(csv.reader(body.splitlines()))


def _year(cell):
    s = (cell or "").strip().rstrip("m").rstrip("M")
    return int(s) if s.isdigit() else None


def parse_team_blocks(rows):
    """Return {team_id: {"minors": [{"name", "yearAcquired"}, ...], "callups": [...]}}."""
    # Find the "Called up:" marker row that splits the two sections.
    callup_marker_idx = None
    for i, row in enumerate(rows):
        if any("called up" in (c or "").lower() for c in row):
            callup_marker_idx = i
            break

    teams = {}
    for team_idx, (_sheet_name, local_id) in enumerate(TEAM_ORDER):
        col_name = team_idx * 5 + 1
        col_year = team_idx * 5 + 2
        minors, callups = [], []
        for row_idx, row in enumerate(rows):
            if row_idx < 2:
                continue  # team header + subheader rows
            if row_idx == callup_marker_idx:
                continue  # "Called up:" marker itself
            if col_name >= len(row):
                continue
            name = (row[col_name] or "").strip()
            if not name:
                continue
            year = _year(row[col_year]) if col_year < len(row) else None
            if year is None:
                continue
            entry = {"name": name, "yearAcquired": year}
            if callup_marker_idx is not None and row_idx > callup_marker_idx:
                callups.append(entry)
            else:
                minors.append(entry)
        teams[local_id] = {"minors": minors, "callups": callups}
    return teams


def _extract_existing_array(team_block, key):
    """Parse the JS for {key}: [...] inside a team block, return list of dicts."""
    m = re.search(key + r":\s*\[([\s\S]*?)\n\s*\]", team_block)
    if not m:
        return []
    inner = m.group(1)
    out = []
    for ent in re.finditer(r"\{[^}]*\}", inner):
        e = ent.group(0)
        nm = re.search(r'name:\s*"([^"]+)"', e)
        sd = "sentDown: true" in e
        sdc = re.search(r"sendDownCount:\s*(\d+)", e)
        st = re.search(r'statType:\s*"([^"]+)"', e)
        out.append({
            "name": nm.group(1) if nm else None,
            "sentDown": sd,
            "sendDownCount": int(sdc.group(1)) if sdc else None,
            "statType": st.group(1) if st else None,
        })
    return out


def fmt_player(p, stat_types, existing):
    """Render `{ name: ..., yearAcquired: ..., careerStat: 0, statType: "..." }`."""
    name = p["name"]
    year = p["yearAcquired"]
    stype = stat_types.get(name) or (existing and existing.get("statType")) or "AB"
    parts = [
        f"name: {json.dumps(name)}",
        f"yearAcquired: {year}",
        "careerStat: 0",
        f"statType: {json.dumps(stype)}",
    ]
    if existing and existing.get("sentDown"):
        parts.append("sentDown: true")
        sdc = existing.get("sendDownCount")
        if sdc and sdc > 1:
            parts.append(f"sendDownCount: {sdc}")
    return "{ " + ", ".join(parts) + " }"


def replace_array(text, team_id, key, new_inner):
    """Replace the contents of `<key>: [...]` inside the team block keyed by team_id."""
    # Anchor on `id: "<team_id>"` and only touch the array within that team's block.
    # Team blocks end at `}` followed by `,` or `]`. Use a non-greedy search bounded
    # by the team's id so we don't bleed into another team's block.
    block_start_pat = r'\{\s*id:\s*"' + re.escape(team_id) + r'"'
    sub_pat = re.compile(
        r'(' + block_start_pat + r'[\s\S]*?' + re.escape(key) + r':\s*\[)[\s\S]*?(\n\s*\])',
        re.MULTILINE,
    )

    def _repl(m):
        return m.group(1) + "\n        " + new_inner + m.group(2)

    new_text, n = sub_pat.subn(_repl, text, count=1)
    if n != 1:
        raise RuntimeError(f"could not locate {team_id}.{key} array in data.js")
    return new_text


def main():
    print(f"Fetching {CSV_URL.split('/')[5][:24]}…")
    rows = fetch_sheet_rows()
    teams_data = parse_team_blocks(rows)
    stat_types = load_player_stat_types()
    print(f"  loaded {len(stat_types)} player stat types")

    text = DATA_JS.read_text()

    for team_id, d in teams_data.items():
        # Pull existing arrays (for sentDown / statType preservation).
        block_match = re.search(
            r'\{\s*id:\s*"' + re.escape(team_id) + r'"[\s\S]*?(?=,\s*\n?\s*\{|\n\s*\]\s*\})',
            text,
        )
        block = block_match.group(0) if block_match else ""
        existing_minors = _extract_existing_array(block, "minors")
        existing_callups = _extract_existing_array(block, "callups")
        existing_min_by_name = {p["name"]: p for p in existing_minors if p["name"]}
        existing_call_by_name = {p["name"]: p for p in existing_callups if p["name"]}

        # Build the new array bodies.
        minors_inner = ",\n        ".join(
            fmt_player(p, stat_types, existing_min_by_name.get(p["name"]))
            for p in d["minors"]
        )
        callups_inner = ",\n        ".join(
            fmt_player(p, stat_types, existing_call_by_name.get(p["name"]))
            for p in d["callups"]
        )

        text = replace_array(text, team_id, "callups", callups_inner)
        text = replace_array(text, team_id, "minors", minors_inner)

    DATA_JS.write_text(text)
    print(f"\nUpdated {DATA_JS}")
    for team_id, d in teams_data.items():
        print(f"  {team_id}: {len(d['minors'])} minors, {len(d['callups'])} callups")


if __name__ == "__main__":
    sys.exit(main())
