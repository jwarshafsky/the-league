#!/usr/bin/env python3
"""
Builds js/record-book-snapshot.js — the per-season "Record Book" shown in the
Trophy Room — from a full ESPN season archive (the one written by
~/backups/espn-league-<id>-<year>/dump.py on the Beelink).

Usage:  python3 scripts/build_record_book.py [ARCHIVE_DIR] [YEAR]
        default ARCHIVE_DIR = ~/backups/espn-league-1200-2026, YEAR = 2026

Everything is derived from the day-by-day lineups: a team is credited with a
player's stats for a day only if he was in an active slot (not BE / IL) that
day, which is how ESPN scores it. Reconstructed season totals land within ~1%
of ESPN's official numbers (mid-day lineup swaps and games/starts caps are the
gap), so the Race section is labelled "reconstructed".

Existing seasons in the output file are kept; only YEAR is replaced.
"""

import collections
import datetime
import glob
import gzip
import json
import os
import sys
from datetime import timezone

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT_FILE = os.path.join(ROOT_DIR, "js", "record-book-snapshot.js")
ARCHIVE = os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else "~/backups/espn-league-1200-2026")
YEAR = int(sys.argv[2]) if len(sys.argv) > 2 else 2026
RAW = os.path.join(ARCHIVE, "raw")

BENCH, IL = 16, 17
# ESPN flb stat ids used here.
AB, H, DBL, TRP, SGL, TB, BB, HBP, SF, R, RBI, HR, SB = 0, 1, 3, 4, 7, 8, 10, 12, 13, 20, 21, 5, 23
OUTS, P_H, P_BB, ER, K, QS, SVHD = 34, 37, 39, 45, 48, 63, 83
TOP_N = 3


def L(rel):
    with gzip.open(os.path.join(RAW, rel)) as f:
        return json.load(f)


core = L("league/core.json.gz")
teams = {t["id"]: t for t in core["teams"]}
abbrev = {tid: t["abbrev"] for tid, t in teams.items()}
cats = [(i["statId"], i.get("isReverseItem", False)) for i in core["settings"]["scoringSettings"]["scoringItems"]]

# ---------------------------------------------------------------------------
# Day-by-day lineups
# ---------------------------------------------------------------------------
day_files = sorted(glob.glob(os.path.join(RAW, "daily/*/rosters.json.gz")))
team_day = collections.defaultdict(collections.Counter)      # (tid, sp) -> stats (active)
bench_day = collections.defaultdict(collections.Counter)     # (tid, sp) -> stats (BE only)
player_day = []                                              # (tid, sp, pid, slot, stats)
player_team_active = collections.defaultdict(collections.Counter)  # (tid, pid) -> stats
owners_of = collections.defaultdict(list)                    # pid -> [tid by day]
pname = {}
ppos = {}
special = []                                                 # (sp, tid, pid, label) per game

for path in day_files:
    sp = int(path.split(os.sep)[-2])
    with gzip.open(path) as f:
        d = json.load(f)
    for t in d.get("teams", []):
        tid = t["id"]
        for e in t.get("roster", {}).get("entries", []):
            pl = e["playerPoolEntry"]["player"]
            pid, slot = e["playerId"], e.get("lineupSlotId")
            pname[pid] = pl.get("fullName", str(pid))
            ppos[pid] = pl.get("defaultPositionId")
            if not owners_of[pid] or owners_of[pid][-1] != tid:
                owners_of[pid].append(tid)
            st = collections.Counter()
            for s in pl.get("stats", []):
                if s.get("statSplitTypeId") == 5 and s.get("statSourceId") == 0 and s.get("scoringPeriodId") == sp:
                    g = {int(k): v for k, v in s["stats"].items()}
                    st.update(g)
                    # Per-game feats, checked on the raw box line (a doubleheader
                    # day must not add up to a fake cycle). Active slots only.
                    if slot not in (BENCH, IL):
                        if all(g.get(k, 0) >= 1 for k in (SGL, DBL, TRP, HR)):
                            special.append((sp, tid, pid, "hit for the cycle"))
                        if g.get(OUTS, 0) >= 27 and g.get(P_H, 0) == 0:
                            special.append((sp, tid, pid, "threw a no-hitter"))
            if not st:
                continue
            player_day.append((tid, sp, pid, slot, st))
            if slot == BENCH:
                bench_day[(tid, sp)].update(st)
            elif slot != IL:
                team_day[(tid, sp)].update(st)
                player_team_active[(tid, pid)].update(st)

last_sp = max(sp for _, sp in team_day)

# Scoring period -> calendar date. Periods are consecutive days; anchor on the
# most common (date - period) offset among same-day lineup moves.
offsets = collections.Counter()
tx_all = {}
for path in glob.glob(os.path.join(RAW, "daily/*/transactions.json.gz")):
    with gzip.open(path) as f:
        for t in json.load(f).get("transactions", []):
            tx_all[t["id"]] = t
            if t["type"] == "ROSTER" and t.get("proposedDate") and t.get("scoringPeriodId"):
                dt = datetime.datetime.fromtimestamp(t["proposedDate"] / 1000, datetime.timezone(datetime.timedelta(hours=-4))).date()
                offsets[dt.toordinal() - t["scoringPeriodId"]] += 1
base = offsets.most_common(1)[0][0]
day_date = lambda sp: datetime.date.fromordinal(base + sp)
fmt_day = lambda sp: day_date(sp).strftime("%b %-d")


def ip(outs):
    return f"{int(outs) // 3}.{int(outs) % 3}"


def entry(tid, value, text, when="", who="", detail=""):
    return {"espnId": tid, "abbrev": abbrev.get(tid, str(tid)), "value": value, "text": text,
            "when": when, "who": who, "detail": detail}


def top(rows, n=TOP_N, reverse=True):
    """rows: list of (sortkey, tiebreak, entry). Keeps everything tied with the Nth place."""
    rows = sorted(rows, key=lambda r: ((-r[0] if reverse else r[0]), r[1]))
    if not rows:
        return []
    cutoff = rows[min(n, len(rows)) - 1][0]
    keep = [r for r in rows if (r[0] >= cutoff if reverse else r[0] <= cutoff)]
    return [r[2] for r in keep[: n + 3]]


def record(icon, title, blurb, entries):
    return {"icon": icon, "title": title, "blurb": blurb, "entries": entries} if entries else None


def ordinal(n):
    n = int(n)
    return f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"


def plural(n, word):
    n = int(n) if float(n).is_integer() else n
    # Stat abbreviations (HR, RBI, K, QS, SV+HLD) don't take an "s".
    return f"{n} {word}" + ("" if n == 1 or word.isupper() or "+" in word else "s")


sections = []

# ---------------------------------------------------------------------------
# Single-day team records
# ---------------------------------------------------------------------------
def team_day_record(icon, title, blurb, stat, word, reverse=True, filt=None, keyfn=None, textfn=None):
    rows = []
    for (tid, sp), st in team_day.items():
        if filt and not filt(st):
            continue
        v = keyfn(st) if keyfn else st[stat]
        if reverse and v <= 0:
            continue
        rows.append((v, sp, entry(tid, v, textfn(st) if textfn else plural(v, word), fmt_day(sp))))
    return record(icon, title, blurb, top(rows, reverse=reverse))


sections.append({"title": "Single-Day Team Records", "subtitle": "Best (and worst) days from a team's active lineup",
                 "records": [r for r in [
    team_day_record("💣", "Home Run Derby", "Most home runs by one lineup in a single day.", HR, "HR"),
    team_day_record("🏃", "Track Meet", "Most runs scored in a day.", R, "run"),
    team_day_record("🎯", "Ducks on the Pond", "Most RBI in a day.", RBI, "RBI"),
    team_day_record("💨", "Grand Theft Base", "Most stolen bases in a day.", SB, "steal"),
    team_day_record("🔥", "Punchout Party", "Most pitcher strikeouts in a day.", K, "K"),
    team_day_record("✅", "Quality Control", "Most quality starts in a day.", QS, "QS"),
    team_day_record("🔒", "Lockdown", "Most saves + holds in a day.", SVHD, "SV+HLD"),
    team_day_record("🧊", "Zero Hour", "Most innings thrown in a day without allowing an earned run.", OUTS, "",
                    filt=lambda st: st[ER] == 0, textfn=lambda st: f"{ip(st[OUTS])} IP, 0 ER"),
    team_day_record("💥", "Meltdown", "Most earned runs allowed in a day. Somebody had to.", ER, "ER",
                    textfn=lambda st: f"{int(st[ER])} ER in {ip(st[OUTS])} IP"),
] if r]})

# ---------------------------------------------------------------------------
# Individual performances (active slots only)
# ---------------------------------------------------------------------------
def player_record(icon, title, blurb, keyfn, textfn, slots="active", reverse=True, filt=None):
    rows = []
    for tid, sp, pid, slot, st in player_day:
        if slots == "active" and slot in (BENCH, IL):
            continue
        if slots == "bench" and slot != BENCH:
            continue
        if filt and not filt(pid, st):
            continue
        v = keyfn(st)
        if v <= 0:
            continue
        rows.append((v, sp, entry(tid, v, textfn(st), fmt_day(sp), pname[pid])))
    return record(icon, title, blurb, top(rows, reverse=reverse))


hitter_line = lambda st: f"{int(st[H])}-for-{int(st[AB])}, {plural(st[HR], 'HR')}, {int(st[RBI])} RBI"
pitch_line = lambda st: f"{int(st[K])} K in {ip(st[OUTS])} IP, {int(st[ER])} ER"

special.sort()

sections.append({"title": "Individual Performances", "subtitle": "Biggest single days by a player in someone's active lineup",
                 "records": [r for r in [
    player_record("🚀", "Multi-Homer Madness", "Most home runs by one player in a day.",
                  lambda st: st[HR] + st[RBI] / 100, hitter_line),
    player_record("🧨", "RBI Machine", "Most RBI by one player in a day.", lambda st: st[RBI] + st[HR] / 100, hitter_line),
    player_record("🧱", "Total Bases", "Most total bases by one player in a day.", lambda st: st[TB], lambda st: f"{int(st[TB])} TB — {hitter_line(st)}"),
    player_record("🐆", "Wheels", "Most stolen bases by one player in a day.", lambda st: st[SB], lambda st: plural(st[SB], "steal")),
    player_record("🌀", "Strikeout Artist", "Most strikeouts by one pitcher in a day.", lambda st: st[K] - st[ER] / 100, pitch_line),
    player_record("🗿", "Gem of the Year", "Longest scoreless start (most innings, 0 ER).",
                  lambda st: st[OUTS] + st[K] / 100 if st[ER] == 0 and st[OUTS] >= 18 else 0, pitch_line),
    record("📜", "History Made", "Cycles and complete-game no-hitters while in a fantasy lineup.",
           [entry(tid, 1, label, fmt_day(sp), pname[pid]) for sp, tid, pid, label in special]),
] if r]})

# ---------------------------------------------------------------------------
# Bench blunders
# ---------------------------------------------------------------------------
def season_team_record(icon, title, blurb, source, keyfn, textfn, reverse=True):
    tot = collections.defaultdict(collections.Counter)
    for (tid, _), st in source.items():
        tot[tid].update(st)
    rows = [(keyfn(st), 0, entry(tid, keyfn(st), textfn(st))) for tid, st in tot.items() if keyfn(st) > 0 or not reverse]
    return record(icon, title, blurb, top(rows, reverse=reverse))


sections.append({"title": "Bench Blunders", "subtitle": "Production that happened on the bench — and didn't count",
                 "records": [r for r in [
    player_record("🪑", "Benched Bomb", "Biggest day by a hitter sitting on the bench.",
                  lambda st: st[HR] * 4 + st[RBI] + st[R] + st[SB] * 2 if st[AB] else 0, hitter_line, slots="bench",
                  filt=lambda pid, st: ppos.get(pid) not in (1, 11)),
    player_record("😩", "Benched Ace", "Most strikeouts by a pitcher sitting on the bench.",
                  lambda st: st[K] - st[ER] / 100, pitch_line, slots="bench"),
    season_team_record("🏚️", "Bench Home Runs", "Season total of home runs hit by benched players.",
                       bench_day, lambda st: st[HR], lambda st: plural(st[HR], "HR") + f" · {int(st[RBI])} RBI"),
    season_team_record("🧯", "Bench Strikeouts", "Season total of strikeouts thrown from the bench.",
                       bench_day, lambda st: st[K], lambda st: f"{int(st[K])} K · {plural(st[QS], 'QS')}"),
] if r]})

# ---------------------------------------------------------------------------
# Weekly records (Mon–Sun calendar weeks)
# ---------------------------------------------------------------------------
week_tot = collections.defaultdict(collections.Counter)
for (tid, sp), st in team_day.items():
    monday = day_date(sp) - datetime.timedelta(days=day_date(sp).weekday())
    week_tot[(tid, monday)].update(st)


def week_record(icon, title, blurb, stat, word):
    rows = [(st[stat], wk.toordinal(), entry(tid, st[stat], plural(st[stat], word),
                                              f"Week of {wk.strftime('%b %-d')}"))
            for (tid, wk), st in week_tot.items() if st[stat] > 0]
    return record(icon, title, blurb, top(rows))


sections.append({"title": "Best Weeks", "subtitle": "Monday–Sunday totals",
                 "records": [r for r in [
    week_record("📅", "Power Week", "Most home runs in a week.", HR, "HR"),
    week_record("🏎️", "Speed Week", "Most stolen bases in a week.", SB, "steal"),
    week_record("⚡", "Strikeout Week", "Most pitcher strikeouts in a week.", K, "K"),
    week_record("🧱", "Bullpen Week", "Most saves + holds in a week.", SVHD, "SV+HLD"),
] if r]})

# ---------------------------------------------------------------------------
# The race — standings reconstructed day by day
# ---------------------------------------------------------------------------
def roto_ranks(cum):
    tids = list(cum)
    pts = collections.Counter()
    for sid, rev in cats:
        def val(st):
            if sid == 17:   # OBP
                den = st[AB] + st[BB] + st[HBP] + st[SF]
                return (st[H] + st[BB] + st[HBP]) / den if den else 0
            if sid == 47:   # ERA
                return st[ER] * 27 / st[OUTS] if st[OUTS] else 99
            if sid == 41:   # WHIP
                return (st[P_H] + st[P_BB]) * 3 / st[OUTS] if st[OUTS] else 99
            return st[sid]
        vals = {t: val(cum[t]) for t in tids}
        for t in tids:
            better = sum(1 for u in tids if (vals[u] < vals[t] if rev else vals[u] > vals[t]))
            same = sum(1 for u in tids if vals[u] == vals[t])
            # 12 points for 1st … 1 for last; ties split
            pts[t] += len(tids) - better - (same - 1) / 2
    order = sorted(tids, key=lambda t: -pts[t])
    rank = {}
    for t in order:
        rank[t] = 1 + sum(1 for u in tids if pts[u] > pts[t])
    return rank, pts


cum = {tid: collections.Counter() for tid in teams}
first_days = collections.Counter()
rank_hist = collections.defaultdict(dict)
leader_by_day = {}
for sp in range(1, last_sp + 1):
    for tid in teams:
        cum[tid].update(team_day.get((tid, sp), {}))
    if sp < 7:   # first week is noise
        continue
    rank, pts = roto_ranks(cum)
    leaders = [t for t in teams if rank[t] == 1]
    leader_by_day[sp] = tuple(sorted(leaders))
    for t in leaders:
        first_days[t] += 1
    for t in teams:
        rank_hist[t][sp] = rank[t]

final_rank = {t["id"]: t.get("rankCalculatedFinal") for t in core["teams"]}
race = []
race.append(record("👑", "Days in First Place", "Days spent alone or tied atop the (reconstructed) standings, from the second week on.",
                   top([(n, 0, entry(t, n, plural(n, "day"))) for t, n in first_days.items()], n=5)))
cutoff = 45  # measure comebacks/collapses from mid-May on
come, coll = [], []
for t, hist in rank_hist.items():
    later = {sp: r for sp, r in hist.items() if sp >= cutoff}
    worst_sp = max(later, key=lambda sp: (later[sp], sp))
    best_sp = min(later, key=lambda sp: (later[sp], -sp))
    fr = final_rank.get(t) or hist[max(hist)]
    if later[worst_sp] - fr > 0:
        come.append((later[worst_sp] - fr, 0, entry(t, later[worst_sp] - fr,
                     f"{ordinal(later[worst_sp])} → {ordinal(fr)}", f"low point {fmt_day(worst_sp)}")))
    if fr - later[best_sp] > 0:
        coll.append((fr - later[best_sp], 0, entry(t, fr - later[best_sp],
                     f"{ordinal(later[best_sp])} → {ordinal(fr)}", f"high point {fmt_day(best_sp)}")))
race.append(record("📈", "Comeback Kid", "Biggest climb from a low point (mid-May on) to the final standings.", top(come)))
race.append(record("📉", "Free Fall", "Biggest drop from a high point (mid-May on) to the final standings.", top(coll)))
changes = [sp for sp in sorted(leader_by_day) if sp > min(leader_by_day) and leader_by_day[sp] != leader_by_day[sp - 1]]
if changes:
    last = changes[-1]
    lead = leader_by_day[last]
    race.append(record("🏁", "Last Lead Change", f"First place changed hands {plural(len(changes), 'time')} after the first week. The last one:",
                       [entry(lead[0], last, "took over first place" + (" (tied)" if len(lead) > 1 else ""), fmt_day(last))]))
sections.append({"title": "The Race", "subtitle": "Standings reconstructed day by day from active lineups (within ~1% of ESPN's official totals)",
                 "records": [r for r in race if r]})

# ---------------------------------------------------------------------------
# Front office — FAAB, trades, roster churn
# ---------------------------------------------------------------------------
tx = list(tx_all.values())
waivers = [t for t in tx if t["type"] == "WAIVER" and t.get("status") and t.get("status") != "PENDING"]
by_claim = collections.defaultdict(list)   # (player, day) -> claims in that waiver run
for t in waivers:
    add = next((i for i in t.get("items", []) if i["type"] == "ADD"), None)
    if add and t.get("processDate"):
        by_claim[(add["playerId"], t.get("scoringPeriodId"))].append(t)

big_bid, overbid, war, contested = [], [], [], []
for (pid, _), claims in by_claim.items():
    wins = [c for c in claims if c["status"] == "EXECUTED"]
    if not wins:
        continue
    w = wins[0]
    pdate = w["processDate"]
    when = datetime.datetime.fromtimestamp(pdate / 1000).strftime("%b %-d")
    name = pname.get(pid) or str(pid)
    bid = w.get("bidAmount", 0)
    if bid > 0:
        big_bid.append((bid, pdate, entry(w["teamId"], bid, f"${bid}", when, name)))
    # A competing bid is one that lost *because* the player was taken — not
    # one that failed on the bidder's own roster limit or a dropped player.
    losers = [c for c in claims if c["status"] == "FAILED_INVALIDPLAYERSOURCE" and c["teamId"] != w["teamId"]]
    if losers and bid > 0:
        second = max(c.get("bidAmount", 0) for c in losers)
        n = 1 + len({c["teamId"] for c in losers})
        overbid.append((bid - second, pdate, entry(w["teamId"], bid - second, f"${bid} vs next-best ${second}", when, name)))
        contested.append((n, -bid, entry(w["teamId"], n, f"{n} teams bid · won at ${bid}", when, name)))
        if bid - second <= 1:
            war.append((bid, pdate, entry(w["teamId"], bid, f"${bid} beat ${second}" + (" (tiebreak)" if bid == second else ""), when, name)))

spent = {t["id"]: (t.get("transactionCounter") or {}).get("acquisitionBudgetSpent", 0) for t in core["teams"]}
placed = collections.Counter(t["teamId"] for t in waivers if t["status"] != "CANCELED")
lost = collections.Counter(t["teamId"] for t in waivers if t["status"].startswith("FAILED"))
adds = collections.Counter(t["teamId"] for t in tx if t["type"] in ("WAIVER", "FREEAGENT") and t.get("status") == "EXECUTED")

# Trades: the transaction log keeps only the approvals, so read the activity
# feed, where each trade is one topic of "player X: team A -> team B" lines.
trades, blockbuster = collections.Counter(), []
for path in glob.glob(os.path.join(RAW, "communication/ACTIVITY_TRANSACTIONS_*.json.gz")):
    with gzip.open(path) as f:
        for tp in json.load(f).get("topics", []):
            lines = [m for m in tp.get("messages", []) if m.get("messageTypeId") == 244]
            if not lines:
                continue
            sides = sorted({m["from"] for m in lines} | {m["to"] for m in lines})
            for tid in sides:
                trades[tid] += 1
            when = datetime.datetime.fromtimestamp(tp["date"] / 1000).strftime("%b %-d")
            got = {tid: [pname.get(m["targetId"], str(m["targetId"])) for m in lines if m["to"] == tid] for tid in sides}
            e = entry(sides[0], len(lines), f"{len(lines)} players changed hands", when)
            # Two-sided entry: the page renders "A ⇄ B" and "A got …" with team names.
            e["got"] = [{"espnId": t, "abbrev": abbrev.get(t, str(t)), "players": v} for t, v in got.items()]
            blockbuster.append((len(lines), tp["date"], e))

# Best pickups: active-lineup production for the claiming team after a waiver/FA add.
pickup_team = {}
for t in tx:
    if t["type"] in ("WAIVER", "FREEAGENT") and t.get("status") == "EXECUTED":
        for i in t.get("items", []):
            if i["type"] == "ADD":
                pickup_team.setdefault((i["toTeamId"], i["playerId"]), t.get("bidAmount", 0))
bat, sp_arm, rp_arm = [], [], []
for (tid, pid), cost in pickup_team.items():
    st = player_team_active.get((tid, pid))
    if not st:
        continue
    if ppos.get(pid) in (1, 11):
        line = f"{int(st[K])} K · {plural(st[QS], 'QS')} · {int(st[SVHD])} SV+HLD"
        if st[SVHD] > st[QS]:
            rp_arm.append((st[SVHD], st[K], entry(tid, st[SVHD], line, f"${cost}", pname[pid])))
        elif st[K] > 0:
            sp_arm.append((st[K], st[QS], entry(tid, st[K], line, f"${cost}", pname[pid])))
    else:
        v = st[R] + st[HR] + st[RBI] + st[SB]
        if v > 0:
            bat.append((v, 0, entry(tid, v, f"{int(st[R])} R · {int(st[HR])} HR · {int(st[RBI])} RBI · {int(st[SB])} SB", f"${cost}", pname[pid])))

potato = [(len(o), 0, entry(o[-1], len(o), f"{len(set(o))} teams, {len(o) - 1} moves",
                            "", pname[pid], " → ".join(abbrev.get(x, "FA") for x in o)))
          for pid, o in owners_of.items() if len(set(o)) >= 3]

draft = L("league/draft.json.gz")["draftDetail"].get("picks", [])
pricey = [(p["bidAmount"], p["overallPickNumber"], entry(p["teamId"], p["bidAmount"], f"${p['bidAmount']}",
                                                         "", pname.get(p["playerId"], str(p["playerId"]))))
          for p in draft if not p.get("keeper") and p.get("bidAmount")]

sections.append({"title": "Front Office", "subtitle": "FAAB, trades and roster churn",
                 "records": [r for r in [
    record("💰", "Big Spender", "Largest winning FAAB bid.", top(big_bid)),
    record("😬", "Overpay of the Year", "Biggest gap between the winning bid and the next-best bid.", top(overbid)),
    record("🤏", "Photo Finish", "Largest FAAB claim won by $1 or less.", top(war)),
    record("🥊", "Most Wanted", "Most teams bidding on one player in one waiver run.", top(contested)),
    record("🦅", "Best Waiver Bat", "Most R+HR+RBI+SB a pickup produced for the team that added him.", top(bat)),
    record("🎣", "Best Waiver Starter", "Most strikeouts a pitcher pickup delivered for the team that added him.", top(sp_arm)),
    record("🚒", "Best Waiver Reliever", "Most saves + holds from a bullpen pickup.", top(rp_arm)),
    record("🪙", "Budget Burned", "Most FAAB spent over the season.", top([(v, 0, entry(t, v, f"${v}")) for t, v in spent.items() if v])),
    record("📝", "Bid Machine", "Most waiver bids placed.", top([(v, 0, entry(t, v, plural(v, "bid"))) for t, v in placed.items()])),
    record("💔", "Always the Bridesmaid", "Most waiver bids that didn't go through.", top([(v, 0, entry(t, v, plural(v, "failed bid"))) for t, v in lost.items()])),
    record("🔄", "Churn & Burn", "Most players added (waivers + free agents).", top([(v, 0, entry(t, v, plural(v, "add"))) for t, v in adds.items()])),
    record("🤝", "Wheeler-Dealer", "Most completed trades.", top([(v, 0, entry(t, v, plural(v, "trade"))) for t, v in trades.items()])),
    record("💼", "Blockbuster", "Most players moved in a single trade.", top(blockbuster)),
    record("🥔", "Hot Potato", "Player who bounced between the most fantasy teams. Credited to his last team.", top(potato)),
    record("🏷️", "Sticker Shock", "Priciest non-keeper buys at the auction.", top(pricey)),
] if r]})

# ---------------------------------------------------------------------------
season = {
    "year": YEAR,
    "generatedAt": datetime.datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "days": last_sp,
    "firstDay": day_date(1).isoformat(),
    "lastDay": day_date(last_sp).isoformat(),
    "sections": sections,
}

book = {"seasons": {}}
if os.path.exists(OUT_FILE):
    s = open(OUT_FILE).read()
    try:
        book = json.loads(s[s.index("{"):s.rindex("}") + 1])
    except ValueError:
        pass
book["seasons"][str(YEAR)] = season
with open(OUT_FILE, "w") as f:
    f.write("// Auto-generated by scripts/build_record_book.py - do not edit by hand.\n")
    f.write("// Source: full-season ESPN archive (see the script header).\n")
    f.write(f"const RECORD_BOOK = {json.dumps(book, ensure_ascii=False, indent=1)};\n")
print(f"Wrote {OUT_FILE}: {YEAR}, {sum(len(s['records']) for s in sections)} records, days 1..{last_sp} "
      f"({season['firstDay']} → {season['lastDay']})")
