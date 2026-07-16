// Server-side build of the Google Sheets export payload, plus POST to the
// saved Apps Script Web App URL. Runs from GitHub Actions on a schedule so
// the sheet stays current without needing the commish to have the app open.
//
// This is a careful Node port of the relevant slice of js/app.js +
// js/db.js. Any change to the export shape on the browser side needs to be
// mirrored here. The Sheet uploader (Apps Script) is the contract between
// them.
//
// Required env:
//   SUPABASE_SERVICE_ROLE_KEY  — for Supabase REST access
//
// Optional env:
//   SHEETS_DEBUG=1             — log full payload sizes per tab

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const SUPABASE_URL = "https://fbllfkrtjsihrkwnbmlw.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY not set");
  process.exit(1);
}

const DEBUG = !!process.env.SHEETS_DEBUG;

// ---------------------------------------------------------------------------
// Load static JS files (data.js, snapshots) into Node by wrapping with
// `new Function`. Each file declares its const at the top level — wrapping
// in a function makes those consts accessible via the trailing `return`.
// ---------------------------------------------------------------------------
function loadJsVar(file, varName) {
  const src = readFileSync(join(ROOT, file), "utf8");
  return new Function(`${src}\nreturn ${varName};`)();
}

const LEAGUE_DATA   = loadJsVar("js/data.js",                  "LEAGUE_DATA");
const ESPN_SNAPSHOT = loadJsVar("js/espn-snapshot.js",         "ESPN_SNAPSHOT");
const PLAYER_STATS  = loadJsVar("js/player-stats-snapshot.js", "PLAYER_STATS");
let HISTORY_SNAPSHOT;
try { HISTORY_SNAPSHOT = loadJsVar("js/history-snapshot.js", "HISTORY_SNAPSHOT"); }
catch { HISTORY_SNAPSHOT = { seasons: [] }; }

// ---------------------------------------------------------------------------
// Supabase REST helpers
// ---------------------------------------------------------------------------
async function supaGet(path) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const r = await fetch(url, { headers: {
    apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
  }});
  if (!r.ok) throw new Error(`GET ${path} → HTTP ${r.status}`);
  return r.json();
}

async function fetchAll() {
  const [trades, ksRows, lsRows, coRows, rmRows] = await Promise.all([
    supaGet("trades?select=*&order=created_at.asc"),
    supaGet("keeper_selections?select=*"),
    supaGet("league_state?select=*"),
    supaGet("callup_overrides?select=*"),
    supaGet("roster_moves?select=*&order=at.asc"),
  ]);
  // Note: commish_overrides and workaround_overrides live inside league_state.

  // Trades: same shape transform db.js does in _rowToTrade.
  const tradesOut = trades.map(r => ({
    _id: r.id,
    date: r.date,
    createdAt: r.created_at,
    team1: r.team1,
    team2: r.team2,
    team1Receives: r.team1_receives || [],
    team2Receives: r.team2_receives || [],
    notes: r.notes || "",
    rule5: !!r.rule5,
    rule5PickClientId: r.rule5_pick_client_id || null,
  }));

  // Keeper selections: nested by team → name → flags
  const keeperSel = {};
  for (const r of ksRows) {
    if (!keeperSel[r.team_id]) keeperSel[r.team_id] = {};
    keeperSel[r.team_id][r.player_name] = {
      keeper: !!r.keeper, minorKeeper: !!r.minor_keeper,
      rule5: !!r.rule5, tradeBlock: !!r.trade_block,
    };
  }

  // Callup overrides: { player_name: { price, year } }
  const callup = {};
  for (const r of coRows) callup[r.player_name] = { price: r.price, year: r.year };

  // league_state buckets
  const buckets = {};
  for (const r of lsRows) buckets[r.key] = r.state;

  return {
    trades: tradesOut,
    keeperSel,
    callup,
    rosterMoves: rmRows,
    draft: buckets.draft_2027 || null,
    rule5: buckets.rule5 || null,
    commishOverrides: buckets.commish_overrides || {},
    workaroundOverrides: buckets.workaround_overrides || {},
    settings: buckets.settings || {},
    feesPaid: buckets.fees_paid || {},
    keeperPriceExceptions: buckets.keeper_price_exceptions || {},
    googleSheetsWebAppUrl: (buckets.settings || {}).googleSheetsWebAppUrl || "",
  };
}

// ---------------------------------------------------------------------------
// Constants mirroring app.js
// ---------------------------------------------------------------------------
const DEFAULT_SEASON = 2026;
const DATA_JS_BASE_SEASON = 2026;
const ML_CONTRACT_YEARS = 3;
const MIL_CONTRACT_YEARS = 3;

const ESPN_ABBREV_TO_LOCAL = {
  "MV3": "matt", "SHAR": "saxton", "S+A": "sam", "GLIX": "glicksman",
  "Jeff": "jeff", "AJ": "aj", "CORE": "corey", "JD": "josh-doug",
  "WEIN": "larry", "KLIN": "zack", "Dave": "dave", "JTL": "jesse",
};

// ---------------------------------------------------------------------------
// Roster reconciliation — Node port of applyRosterAdjustments.
// Walks trades (chronologically) + callup_overrides + roster_moves to
// produce the up-to-date minors / callups arrays for each team.
// Mutates teams in place (matching app.js behavior).
// ---------------------------------------------------------------------------
function applyRosterAdjustments(teams, trades, callupOverrides, rosterMoves, draft) {
  // Capture original anchors from data.js before any mutation. Recompute
  // each call so re-runs in the same process produce identical output.
  const original = new Map(teams.map(t => [t.id, {
    minors: (t.minors || []).map(p => ({ ...p })),
    callups: (t.callups || []).map(p => ({ ...p })),
  }]));
  const teamMinors = new Map();
  const teamCallups = new Map();
  for (const t of teams) {
    const snap = original.get(t.id);
    teamMinors.set(t.id, snap.minors.map(p => ({ ...p })));
    teamCallups.set(t.id, snap.callups.map(p => ({ ...p })));
  }

  const findOriginal = (name) => {
    if (!name) return null;
    for (const snap of original.values()) {
      const m = (snap.minors || []).find(p => p.name === name);
      if (m) return m;
      const c = (snap.callups || []).find(p => p.name === name);
      if (c) return c;
    }
    return null;
  };

  const moveBetween = (map, fromId, toId, name) => {
    const fromList = map.get(fromId) || [];
    let player;
    const idx = fromList.findIndex(p => p.name === name);
    if (idx !== -1) {
      player = fromList.splice(idx, 1)[0];
      map.set(fromId, fromList);
    } else {
      // Scan other current lists first (chained-trade case where the recorded
      // fromTeam is stale). Only fall back to the anchor as a last resort, to
      // avoid duplicating a player who's still alive on some other team.
      let actualFromId = null;
      for (const [tid, list] of map.entries()) {
        if (list.some(p => p.name === name)) { actualFromId = tid; break; }
      }
      if (actualFromId) {
        const list = map.get(actualFromId);
        const j = list.findIndex(p => p.name === name);
        player = list.splice(j, 1)[0];
        map.set(actualFromId, list);
      } else {
        const orig = findOriginal(name);
        if (!orig) return;
        player = { ...orig };
      }
    }
    const toList = map.get(toId) || [];
    if (!toList.find(p => p.name === player.name)) toList.push({ ...player });
    map.set(toId, toList);
  };

  const applyAssets = (fromId, toId, receives) => {
    for (const a of (receives || [])) {
      const name = a.value || a.name;
      if (!name) continue;
      if (a.type === "minor")  moveBetween(teamMinors,  fromId, toId, name);
      if (a.type === "callup") moveBetween(teamCallups, fromId, toId, name);
    }
  };

  // 1. Trades chronologically. team1Receives moves team2 → team1.
  const sorted = [...trades].sort((a, b) =>
    new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
  for (const t of sorted) {
    applyAssets(t.team2, t.team1, t.team1Receives);
    applyAssets(t.team1, t.team2, t.team2Receives);
  }

  // 2. Legacy callup_overrides → promote minors to callups. These rows are keyed
  //    by player_name ALONE (no team), so a name appearing in two teams' minors
  //    is ambiguous — promoting the first match could promote the wrong player.
  //    Only promote when exactly one team owns the name; otherwise defer to the
  //    team-scoped roster_moves below.
  for (const playerName of Object.keys(callupOverrides || {})) {
    const matches = teams.filter(t =>
      (teamMinors.get(t.id) || []).some(p => p.name === playerName));
    if (matches.length !== 1) {
      if (matches.length > 1) {
        console.warn(`callup_override for "${playerName}" is ambiguous across ` +
          `${matches.length} teams; deferring to roster_moves.`);
      }
      continue;
    }
    const t = matches[0];
    const minors = teamMinors.get(t.id) || [];
    const idx = minors.findIndex(p => p.name === playerName);
    const player = minors.splice(idx, 1)[0];
    teamMinors.set(t.id, minors);
    const callups = teamCallups.get(t.id) || [];
    if (!callups.find(p => p.name === player.name)) callups.push(player);
    teamCallups.set(t.id, callups);
  }

  // 3. roster_moves: explicit callup / demote / drop, time-ordered
  const sortedMoves = [...rosterMoves].sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));
  for (const m of sortedMoves) {
    if (!m || !m.player_name || !m.team_id) continue;
    if (m.kind === "callup") {
      const minors = teamMinors.get(m.team_id) || [];
      const idx = minors.findIndex(p => p.name === m.player_name);
      if (idx !== -1) {
        const player = minors.splice(idx, 1)[0];
        teamMinors.set(m.team_id, minors);
        const callups = teamCallups.get(m.team_id) || [];
        if (!callups.find(p => p.name === player.name)) callups.push(player);
        teamCallups.set(m.team_id, callups);
      }
    } else if (m.kind === "demote") {
      const callups = teamCallups.get(m.team_id) || [];
      const idx = callups.findIndex(p => p.name === m.player_name);
      if (idx !== -1) {
        const player = callups.splice(idx, 1)[0];
        teamCallups.set(m.team_id, callups);
        const minors = teamMinors.get(m.team_id) || [];
        const existing = minors.find(p => p.name === player.name);
        if (existing) {
          existing.sendDownCount = (existing.sendDownCount || 0) + 1;
        } else {
          minors.push({ ...player, sentDown: true, sendDownCount: (player.sendDownCount || 0) + 1 });
        }
        teamMinors.set(m.team_id, minors);
      }
    } else if (m.kind === "drop") {
      // Drop from MiL: remove from minors AND callups (covers dropping a
      // player whether they're in MiL or already promoted to MLB).
      const minors = teamMinors.get(m.team_id) || [];
      const mIdx = minors.findIndex(p => p.name === m.player_name);
      if (mIdx !== -1) {
        minors.splice(mIdx, 1);
        teamMinors.set(m.team_id, minors);
      }
      const callups = teamCallups.get(m.team_id) || [];
      const cIdx = callups.findIndex(p => p.name === m.player_name);
      if (cIdx !== -1) {
        callups.splice(cIdx, 1);
        teamCallups.set(m.team_id, callups);
      }
    }
  }

  // 4. Minors-draft picks → add to picking team's minors with
  //    yearAcquired = draft.year. Skip players already on any roster so
  //    we don't double-count if data.js was previously updated by hand.
  if (draft && Array.isArray(draft.picks) && draft.year) {
    const onAnyRoster = new Set();
    for (const arr of teamMinors.values()) for (const p of arr) onAnyRoster.add(p.name);
    for (const arr of teamCallups.values()) for (const p of arr) onAnyRoster.add(p.name);
    const picksInOrder = [...draft.picks].sort((a, b) =>
      (a.round - b.round) || (a.pickInRound - b.pickInRound) || ((a.timestamp || 0) - (b.timestamp || 0)));
    for (const pick of picksInOrder) {
      if (!pick.team || !pick.player) continue;
      if (onAnyRoster.has(pick.player)) continue;
      const stats = PLAYER_STATS?.players?.[pick.player];
      const minors = teamMinors.get(pick.team) || [];
      minors.push({
        name: pick.player,
        yearAcquired: draft.year,
        careerStat: 0,                      // applyLivePlayerStats overlays this
        statType: stats?.statType || "AB",
        fromDraft: true,
      });
      teamMinors.set(pick.team, minors);
      onAnyRoster.add(pick.player);
    }
  }

  for (const t of teams) {
    t.minors  = teamMinors.get(t.id) || [];
    t.callups = teamCallups.get(t.id) || [];
  }
}

// ---------------------------------------------------------------------------
// Apply daily MLB Stats career AB/IP onto callups + minors. Mirrors
// applyLivePlayerStats in app.js.
// ---------------------------------------------------------------------------
function applyLivePlayerStats(teams) {
  if (!PLAYER_STATS || !PLAYER_STATS.players) return;
  const stats = PLAYER_STATS.players;
  for (const t of teams) {
    for (const p of [...(t.callups || []), ...(t.minors || [])]) {
      const live = stats[p.name];
      if (!live) continue;
      if (p.statType === "AB") p.careerStat = live.careerAB || 0;
      else if (p.statType === "IP") p.careerStat = Math.round(live.careerIP || 0);
    }
  }
}

// ---------------------------------------------------------------------------
// Price-shift major keeper salaries to current season ($2/yr).
// ---------------------------------------------------------------------------
function applyPriceShift(teams, currentSeason) {
  const dollarsDelta = (currentSeason - DATA_JS_BASE_SEASON) * 2;
  if (dollarsDelta === 0) return;
  for (const t of teams) {
    for (const p of (t.majors || []))  if (typeof p.price === "number") p.price += dollarsDelta;
    for (const p of (t.callups || [])) if (typeof p.price === "number") p.price += dollarsDelta;
  }
}

// ---------------------------------------------------------------------------
// Contract status helpers — port of getContractStatus + getMinorLeagueContractStatus.
// ---------------------------------------------------------------------------
function getMajorContractStatus(player, currentSeason) {
  const startYear = player.yearAcquired;
  if (!startYear) return { yearsRemaining: null };
  const yearsHeld = currentSeason - startYear;
  const yearsRemaining = Math.max(0, ML_CONTRACT_YEARS - yearsHeld);
  return { yearsRemaining };
}

function getMinorLeagueContractStatus(player, currentSeason) {
  // Minor league contracts run 3 yrs from draft year (the year-suffix value),
  // but we treat yearAcquired the same as in app.js: years held since first
  // appearance on a roster.
  const start = player.yearAcquired;
  if (!start) return { yearsRemaining: null };
  const yearsHeld = currentSeason - start;
  const yearsRemaining = MIL_CONTRACT_YEARS - yearsHeld;
  if (yearsRemaining <= 0) return { yearsRemaining: null, eligibilityWarning: "Expired" };
  return { yearsRemaining };
}

// ---------------------------------------------------------------------------
// Send-downs by team (for Minor Leagues "Fees" row).
// ---------------------------------------------------------------------------
function getSendDownsByTeam(rosterMoves) {
  const out = {};
  for (const m of (rosterMoves || [])) {
    if (m && m.kind === "demote" && m.team_id) {
      if (!out[m.team_id]) out[m.team_id] = [];
      out[m.team_id].push(m);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Draft-dollar balances. Each team starts at $260; trades shift $.
// Port of getDraftDollarBalances.
// ---------------------------------------------------------------------------
function parseDraftDollarsAmount(a) {
  if (a && a.amount != null) return Number(a.amount) || 0;
  // Legacy rows without the numeric amount field — parse "$10 draft dollars".
  const v = String(a?.value || "");
  const m = v.match(/\$?\s*(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

function getDraftDollarBalances(teams, trades) {
  const out = {};
  for (const t of teams) out[t.id] = 260;
  for (const tr of (trades || [])) {
    for (const a of (tr.team1Receives || [])) {
      if (a.type === "draft_dollars") {
        const amt = parseDraftDollarsAmount(a);
        out[tr.team1] = (out[tr.team1] || 260) + amt;
        out[tr.team2] = (out[tr.team2] || 260) - amt;
      }
    }
    for (const a of (tr.team2Receives || [])) {
      if (a.type === "draft_dollars") {
        const amt = parseDraftDollarsAmount(a);
        out[tr.team2] = (out[tr.team2] || 260) + amt;
        out[tr.team1] = (out[tr.team1] || 260) - amt;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Prior-year finish ordering — port of getDisplayOrderedTeams.
// Falls back to data.js order when history is unavailable.
// ---------------------------------------------------------------------------
function getDisplayOrderedTeams(teams) {
  if (!HISTORY_SNAPSHOT?.seasons?.length) return [...teams];
  // Find the most recent prior season
  const seasons = [...HISTORY_SNAPSHOT.seasons].sort((a, b) => b.year - a.year);
  const last = seasons[0];
  if (!last?.standings) return [...teams];
  const rankByAbbrev = {};
  for (const s of last.standings) rankByAbbrev[s.abbrev?.toLowerCase()] = s.rank;
  const teamRank = (t) => {
    // app.js uses ESPN_ABBREV_TO_LOCAL + HISTORICAL_ABBREV_OVERRIDES; we
    // approximate by matching team.id against the lowercased abbrev. Good
    // enough for ordering — exact tiebreaks aren't critical here.
    const candidates = [t.id, t.name?.toLowerCase()?.split(" ")?.[0]];
    for (const c of candidates) {
      if (c && rankByAbbrev[c] != null) return rankByAbbrev[c];
    }
    return 999;
  };
  return [...teams].sort((a, b) => teamRank(a) - teamRank(b));
}

// ---------------------------------------------------------------------------
// Draft pick ownership — port of getBaseOwner / getPickOwner.
// ---------------------------------------------------------------------------
function getBaseOwner(draft, round, pickInRound) {
  const order = draft.baseOrder || [];
  if (draft.type === "snake" && round % 2 === 0) {
    return order[order.length - pickInRound] ?? null;
  }
  return order[pickInRound - 1] ?? null;
}
// Parse a trade-log milb_pick value like "2027 1st round" → { year, round }.
// Port of app.js parseMilbPickValue. Returns null if a round can't be extracted.
function parseMilbPickValue(value) {
  if (typeof value !== "string") return null;
  const v = value.toLowerCase();
  const yearMatch = v.match(/\b(20\d{2})\b/);
  // Remove the year from the string before searching for round, otherwise "2027" parses as round 2027.
  const cleaned = yearMatch ? v.replace(yearMatch[1], " ") : v;
  let round = null;
  const ordinal = cleaned.match(/(\d+)\s*(?:st|nd|rd|th)/);
  const roundWord = cleaned.match(/round\s+(\d+)/);
  const standalone = cleaned.match(/\b(\d+)\b/);
  if (ordinal) round = parseInt(ordinal[1], 10);
  else if (roundWord) round = parseInt(roundWord[1], 10);
  else if (standalone) round = parseInt(standalone[1], 10);
  if (!round || round < 1 || round > 20) return null;
  return { year: yearMatch ? parseInt(yearMatch[1], 10) : null, round };
}
function getPickOwner(draft, round, pickInRound, trades) {
  const key = `${round}p${pickInRound}`;
  if (draft.tradedPicks && draft.tradedPicks[key]) return draft.tradedPicks[key];
  const base = getBaseOwner(draft, round, pickInRound);
  // Apply trade-log moves of milb_pick assets in chronological order — port
  // of app.js getTradeLogOwner (structured pickRound/pickYear/
  // pickOriginalOwner fields, with parseMilbPickValue as the legacy-string
  // fallback).
  let owner = base;
  const sorted = [...(trades || [])].sort((a, b) =>
    new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
  for (const t of sorted) {
    const sides = [
      { receives: t.team1Receives, fromTeam: t.team2, toTeam: t.team1 },
      { receives: t.team2Receives, fromTeam: t.team1, toTeam: t.team2 },
    ];
    for (const side of sides) {
      for (const a of (side.receives || [])) {
        if (a.type !== "milb_pick") continue;
        // New trades store structured pickRound/pickOriginalOwner/pickYear. Older trades fall back to parsing.
        const pickRound = a.pickRound ?? parseMilbPickValue(a.value)?.round;
        const pickYear  = a.pickYear  ?? parseMilbPickValue(a.value)?.year;
        const pickOriginalOwner = a.pickOriginalOwner;
        if (!pickRound || pickRound !== round) continue;
        // Require an explicit year match — apply only to the matching draft.
        if (!pickYear || pickYear !== draft.year) continue;
        // Structured trades pinpoint exactly which slot — only apply to the matching baseOwner.
        if (pickOriginalOwner && pickOriginalOwner !== base) continue;
        if (side.fromTeam === owner) owner = side.toTeam;
      }
    }
  }
  return owner;
}

// ---------------------------------------------------------------------------
// Full cost-basis + eligible-players resolution — port of resolveCostBasis +
// getEligiblePlayers from app.js. Reads ESPN roster + draft + events to
// figure out each player's contract origin (keeper / auction / FA / callup /
// post-deadline drop), then computes contract status from that.
// ---------------------------------------------------------------------------
function getContractYearsKept(yearAcquired, currentSeason) {
  return currentSeason - yearAcquired;
}
function getMaxKeepYears(originalPrice, fromMinors) {
  if (fromMinors) return 3;
  if (originalPrice > 50) return 1;
  if (originalPrice > 40) return 2;
  return 3;
}
function getOriginalDraftPrice(currentPrice, yearAcquired, currentSeason) {
  return currentPrice - (currentSeason - yearAcquired) * 2;
}
function getContractStatus(player, currentSeason) {
  // Mirror of js/app.js getContractStatus. FA pickup case (yearAcquired =
  // currentSeason+1) has the salary clock not started yet — clamp yearsKept
  // to 0 and use price as-is for nextYearPrice (already first kept-year salary).
  const rawYearsKept = getContractYearsKept(player.yearAcquired, currentSeason);
  const preContract = rawYearsKept < 0;
  const yearsKept = preContract ? 0 : rawYearsKept;
  const originalPrice = preContract
    ? player.price
    : getOriginalDraftPrice(player.price, player.yearAcquired, currentSeason);
  const maxYears = getMaxKeepYears(originalPrice, player.fromMinors);
  const yearsRemaining = maxYears - yearsKept;
  const nextYearPrice = preContract ? player.price : player.price + 2;
  const canKeepNextYear = yearsRemaining > 0;
  let status, label;
  if (yearsRemaining <= 0) { status = "final";    label = "Final Year"; }
  else if (yearsRemaining === 1) { status = "expiring"; label = "1 yr left"; }
  else if (yearsKept === 0) { status = "new"; label = `${yearsRemaining} yrs left`; }
  else { status = "mid"; label = `${yearsRemaining} yrs left`; }
  return { yearsKept, yearsRemaining, originalPrice, maxYears, nextYearPrice, canKeepNextYear, status, label };
}

// Lookup helpers across every team's snapshot. preferredTeamId disambiguates
// when two MLB players share a name (the caller's team wins); falls back to
// cross-team scan for the trade-via-keeper case.
function findKeeperCostBasis(teams, name, preferredTeamId) {
  if (preferredTeamId) {
    const own = teams.find(t => t.id === preferredTeamId);
    const m = own?.majors?.find(p => p.name === name);
    if (m) return { source: "keeper", originTeamId: own.id, price: m.price, yearAcquired: m.yearAcquired, fromMinors: m.fromMinors };
  }
  for (const t of teams) {
    if (t.id === preferredTeamId) continue;
    const m = (t.majors || []).find(p => p.name === name);
    if (m) return { source: "keeper", originTeamId: t.id, price: m.price, yearAcquired: m.yearAcquired, fromMinors: m.fromMinors };
  }
  return null;
}
function findCallupRecord(teams, name, preferredTeamId) {
  if (preferredTeamId) {
    const own = teams.find(t => t.id === preferredTeamId);
    const c = own?.callups?.find(p => p.name === name);
    if (c) return { originTeamId: own.id, ...c };
  }
  for (const t of teams) {
    if (t.id === preferredTeamId) continue;
    const c = (t.callups || []).find(p => p.name === name);
    if (c) return { originTeamId: t.id, ...c };
  }
  return null;
}
function findDraftPick(name) {
  if (!ESPN_SNAPSHOT) return null;
  const roster = (ESPN_SNAPSHOT.teams || []).flatMap(t => t.roster.map(r => ({ ...r, espnId: t.espnId })));
  const espnPlayer = roster.find(p => p.name === name);
  if (!espnPlayer) return null;
  const pick = (ESPN_SNAPSHOT.draftPicks || []).find(d => d.playerId === espnPlayer.playerId);
  return pick || null;
}
function getPlayerIdByName(name, preferredTeamId) {
  if (!ESPN_SNAPSHOT) return null;
  const matches = [];
  for (const t of (ESPN_SNAPSHOT.teams || [])) {
    const p = t.roster.find(r => r.name === name);
    if (p) matches.push({ playerId: p.playerId, teamLocalId: ESPN_ABBREV_TO_LOCAL[t.abbrev] });
  }
  if (!matches.length) return null;
  if (matches.length === 1) return matches[0].playerId;
  if (preferredTeamId) {
    const onPreferred = matches.find(m => m.teamLocalId === preferredTeamId);
    if (onPreferred) return onPreferred.playerId;
  }
  return null;
}
function getMostRecentAddEvent(playerId) {
  if (!ESPN_SNAPSHOT?.events || playerId == null) return null;
  const draftCutoff = ESPN_SNAPSHOT.draftDate || 0;
  const adds = ESPN_SNAPSHOT.events.filter(e =>
    e.type === "ADD" && e.playerId === playerId && e.date >= draftCutoff);
  if (!adds.length) return null;
  return adds.reduce((latest, ev) => ev.date > latest.date ? ev : latest, adds[0]);
}
function getTradeDeadline() { return ESPN_SNAPSHOT?.tradeDeadline || null; }

function classifyCommishAdd(teams, name, playerId, currentTeamLocalId, lastAdd, workaroundOverrides) {
  if (!lastAdd || !lastAdd.isCommishWorkaround) return null;
  const callup = findCallupRecord(teams, name, currentTeamLocalId);
  let presumption;
  if (callup && callup.originTeamId === currentTeamLocalId) presumption = "callup";
  else if (lastAdd.recentDropWithin24h) presumption = "fa";
  else presumption = "trade";
  const override = (workaroundOverrides || {})[String(playerId)] || null;
  return { presumption, override, decision: override || presumption, needsConfirmation: !override };
}

function getOriginalCostBasis(teams, name, currentTeamLocalId, callupOverrides, currentSeason) {
  const keeper = findKeeperCostBasis(teams, name, currentTeamLocalId);
  if (keeper) {
    return {
      price: keeper.price, yearAcquired: keeper.yearAcquired, fromMinors: keeper.fromMinors,
      source: keeper.originTeamId === currentTeamLocalId ? "keeper" : "keeper-via-trade",
      contractType: "auction",
    };
  }
  const callup = findCallupRecord(teams, name, currentTeamLocalId);
  if (callup) {
    const o = callupOverrides[name];
    return {
      price: o?.price ?? null,
      yearAcquired: o?.year ?? currentSeason,
      originalDraftYear: callup.yearAcquired,
      fromMinors: true,
      source: callup.originTeamId === currentTeamLocalId ? "callup" : "callup-via-trade",
      contractType: "callup",
    };
  }
  const pick = findDraftPick(name);
  if (pick && !pick.keeper) {
    return {
      price: pick.bidAmount, yearAcquired: currentSeason, fromMinors: false,
      source: "auction", contractType: "auction",
    };
  }
  return null;
}

function resolveCostBasis(teams, name, currentTeamLocalId, callupOverrides, workaroundOverrides, currentSeason) {
  const original = getOriginalCostBasis(teams, name, currentTeamLocalId, callupOverrides, currentSeason);
  const playerId = getPlayerIdByName(name, currentTeamLocalId);
  const lastAdd = getMostRecentAddEvent(playerId);
  const deadline = getTradeDeadline();

  if (!lastAdd) {
    if (original) return original;
    return { price: 6, yearAcquired: currentSeason + 1, fromMinors: false, source: "fa", contractType: "fa" };
  }

  const workaround = classifyCommishAdd(teams, name, playerId, currentTeamLocalId, lastAdd, workaroundOverrides);

  if (workaround) {
    if (workaround.decision === "trade") {
      if (original) return { ...original, workaround };
      return { price: 6, yearAcquired: currentSeason + 1, fromMinors: false, source: "fa", contractType: "fa", workaround };
    }
    if (workaround.decision === "callup") {
      const callup = findCallupRecord(teams, name, currentTeamLocalId);
      const o = callupOverrides[name];
      return {
        price: o?.price ?? null,
        yearAcquired: o?.year ?? currentSeason,
        fromMinors: true,
        source: callup?.originTeamId === currentTeamLocalId ? "callup" : "callup-via-trade",
        contractType: "callup",
        workaround,
      };
    }
    // decision === "fa" → fall through
  }

  if (original && original.contractType === "auction") {
    const fake = { name, price: original.price, yearAcquired: original.yearAcquired, fromMinors: original.fromMinors };
    const cs = getContractStatus(fake, currentSeason);
    if (!cs.canKeepNextYear) {
      return {
        ...original,
        droppedDuringSeason: true,
        droppedAndPostDeadline: deadline && lastAdd.date > deadline,
        workaround,
      };
    }
  }

  const isPostDeadline = deadline && lastAdd.date > deadline;
  return {
    price: 6, yearAcquired: currentSeason + 1, fromMinors: false,
    source: original ? "fa-after-drop" : "fa",
    contractType: "fa",
    addDate: lastAdd.date,
    addType: lastAdd.msgType === 178 ? "FA" : "Waiver",
    isPostDeadline,
    workaround,
  };
}

function applyPlayerOverride(player, commishOverrides) {
  const o = (commishOverrides || {})[player.name];
  if (!o) return player;
  const out = { ...player, _commishOverridden: true };
  if (o.nextYearPrice    !== undefined) out.nextYearPrice    = o.nextYearPrice;
  if (o.canKeepNextYear  !== undefined) out.canKeepNextYear  = o.canKeepNextYear;
  if (o.contractLabel    !== undefined) out.contractLabel    = o.contractLabel;
  if (o.contractStatus   !== undefined) out.contractStatus   = o.contractStatus;
  return out;
}

// Returns each team's eligible-keeper list — every player currently on
// their MLB roster (via ESPN snapshot) with full contract-status resolution.
// Matches the browser's getEligiblePlayers(team) output.
function getEligiblePlayers(team, teams, callupOverrides, workaroundOverrides, commishOverrides, priceExceptions, currentSeason) {
  const players = [];
  if (!ESPN_SNAPSHOT) {
    // Same fallback the browser uses when no snapshot is loaded.
    for (const p of (team.majors || [])) {
      const cs = getContractStatus(p, currentSeason);
      players.push({
        name: p.name, type: "major", price: p.price, yearAcquired: p.yearAcquired,
        fromMinors: p.fromMinors, contractType: "auction", source: "keeper",
        contractStatus: cs.status, contractLabel: cs.label,
        nextYearPrice: cs.canKeepNextYear ? cs.nextYearPrice : null,
        canKeepNextYear: cs.canKeepNextYear, yearsRemaining: cs.yearsRemaining,
      });
    }
    return players.map(p => applyPlayerOverride(p, commishOverrides));
  }
  const espnTeam = ESPN_SNAPSHOT.teams.find(t => ESPN_ABBREV_TO_LOCAL[t.abbrev] === team.id);
  if (!espnTeam) return [];
  for (const r of (espnTeam.roster || [])) {
    const basis = resolveCostBasis(teams, r.name, team.id, callupOverrides, workaroundOverrides, currentSeason);
    if (priceExceptions[r.name] != null && typeof basis.price === "number") {
      basis.price = Number(priceExceptions[r.name]);
    }
    const fake = { name: r.name, price: basis.price ?? 0, yearAcquired: basis.yearAcquired, fromMinors: basis.fromMinors };
    let cs;
    if (basis.isPostDeadline) {
      cs = { yearsKept: 0, yearsRemaining: 0, nextYearPrice: null, canKeepNextYear: false, status: "final", label: "Ineligible" };
    } else if (basis.contractType === "fa") {
      cs = { yearsKept: 0, yearsRemaining: 3, originalPrice: 6, maxYears: 3, nextYearPrice: 6, canKeepNextYear: true, status: "new", label: "FA — $6" };
    } else if (basis.contractType === "callup" && basis.price == null) {
      const draftYear = basis.originalDraftYear ?? basis.yearAcquired;
      const milbYearsHeld = currentSeason - draftYear;
      const milbMaxYears = draftYear < 2027 ? 4 : 99;
      const milbYrsAfter = Math.max(0, milbMaxYears - milbYearsHeld - 1);
      if (milbYrsAfter > 0 || draftYear >= 2027) {
        cs = { yearsKept: 0, yearsRemaining: basis.yearAcquired < 2027 ? milbYrsAfter : null, nextYearPrice: null, canKeepNextYear: true, status: "new", label: "Call-up (price TBD)" };
      } else {
        cs = { yearsKept: 0, yearsRemaining: 0, nextYearPrice: null, canKeepNextYear: false, status: "final", label: "Final Year" };
      }
    } else {
      cs = getContractStatus(fake, currentSeason);
      if (basis.droppedDuringSeason && !cs.canKeepNextYear) cs = { ...cs, label: cs.label + " (dropped)" };
    }
    players.push({
      name: r.name,
      playerId: r.playerId,
      type: "major",
      price: basis.price,
      yearAcquired: basis.yearAcquired,
      originalDraftYear: basis.originalDraftYear || basis.yearAcquired,
      fromMinors: basis.fromMinors,
      contractType: basis.contractType,
      source: basis.source,
      contractStatus: cs.status,
      contractLabel: cs.label,
      nextYearPrice: cs.canKeepNextYear ? cs.nextYearPrice : null,
      canKeepNextYear: cs.canKeepNextYear,
      yearsRemaining: cs.yearsRemaining,
      workaround: basis.workaround || null,
      priceExceptionApplied: priceExceptions[r.name] != null,
    });
  }
  return players.map(p => applyPlayerOverride(p, commishOverrides));
}

// ---------------------------------------------------------------------------
// AoA builders — ports of _xlsx*Aoa in app.js. The shape must match what
// the Apps Script writeSheet expects, so cross-reference app.js when
// changing these.
// ---------------------------------------------------------------------------
function yearMStr(year) { return year != null ? `${year}m` : ""; }

function aoaMinorLeagues(teams, sendDownsByTeam) {
  const blockCols = 5;
  const totalCols = teams.length * blockCols;
  const blank = () => Array(totalCols).fill("");
  const aoa = [];

  // Row 1: team name + placeholder digit
  const r1 = blank();
  teams.forEach((t, i) => { r1[i * blockCols + 1] = t.name; r1[i * blockCols + 2] = 0; });
  aoa.push(r1);

  // Row 2: column labels
  const r2 = blank();
  teams.forEach((_t, i) => { r2[i * blockCols + 1] = "Minors"; r2[i * blockCols + 2] = "Year"; });
  aoa.push(r2);

  // Rows 3-12: 10 numbered slots
  const minorsByTeam = teams.map(t => t.minors || []);
  for (let row = 0; row < 10; row++) {
    const r = blank();
    teams.forEach((_t, i) => {
      const p = minorsByTeam[i][row];
      r[i * blockCols + 0] = row + 1;
      if (p) {
        r[i * blockCols + 1] = p.name;
        r[i * blockCols + 2] = yearMStr(p.yearAcquired);
        r[i * blockCols + 3] = 0;
      }
    });
    aoa.push(r);
  }

  // Overflow minors
  const maxMinors = Math.max(10, ...minorsByTeam.map(m => m.length));
  for (let row = 10; row < maxMinors; row++) {
    const r = blank();
    teams.forEach((_t, i) => {
      const p = minorsByTeam[i][row];
      if (p) {
        r[i * blockCols + 1] = p.name;
        r[i * blockCols + 2] = yearMStr(p.yearAcquired);
      }
    });
    aoa.push(r);
  }

  // Spacer rows
  for (let i = 0; i < 6; i++) aoa.push(blank());

  // Called up: header
  const rCallHdr = blank();
  teams.forEach((_t, i) => { rCallHdr[i * blockCols + 1] = "Called up:"; });
  aoa.push(rCallHdr);

  // Callup slots
  const callupsByTeam = teams.map(t => t.callups || []);
  const maxCallups = Math.max(7, ...callupsByTeam.map(c => c.length));
  for (let row = 0; row < maxCallups; row++) {
    const r = blank();
    teams.forEach((_t, i) => {
      const p = callupsByTeam[i][row];
      r[i * blockCols + 0] = row + 1;
      if (p) {
        r[i * blockCols + 1] = p.name;
        r[i * blockCols + 2] = yearMStr(p.yearAcquired);
        r[i * blockCols + 3] = 0;
      }
    });
    aoa.push(r);
  }

  // Spacers
  for (let i = 0; i < 3; i++) aoa.push(blank());

  // Fees row + names of triggering players
  const teamFees = teams.map(t => (sendDownsByTeam[t.id] || []).map(m => m.player_name));
  const rFees = blank();
  teams.forEach((_t, i) => {
    rFees[i * blockCols + 1] = "Fees";
    rFees[i * blockCols + 2] = `$${teamFees[i].length * 10}`;
  });
  aoa.push(rFees);
  const maxFees = Math.max(0, ...teamFees.map(f => f.length));
  for (let row = 0; row < maxFees; row++) {
    const r = blank();
    teams.forEach((_t, i) => {
      const name = teamFees[i][row];
      if (name) r[i * blockCols + 1] = name;
    });
    aoa.push(r);
  }

  return aoa;
}

function aoaKeepers(teams, currentSeason) {
  const blockCols = 5;
  const totalCols = teams.length * blockCols;
  const blank = () => Array(totalCols).fill("");
  const aoa = [];

  const r1 = blank();
  teams.forEach((t, i) => { r1[i * blockCols + 1] = t.name; });
  aoa.push(r1);

  const r2 = blank();
  teams.forEach((_t, i) => {
    r2[i * blockCols + 1] = "Majors";
    r2[i * blockCols + 2] = `${currentSeason} Price`;
    r2[i * blockCols + 3] = "Year";
    r2[i * blockCols + 4] = "Expiry";
  });
  aoa.push(r2);

  for (let row = 0; row < 8; row++) {
    const r = blank();
    teams.forEach((t, i) => {
      const p = (t.majors || [])[row];
      r[i * blockCols + 0] = row + 1;
      if (p) {
        const cs = getMajorContractStatus(p, currentSeason);
        r[i * blockCols + 1] = p.name;
        r[i * blockCols + 2] = p.price != null ? p.price : "";
        r[i * blockCols + 3] = p.yearAcquired ?? "";
        r[i * blockCols + 4] = cs.yearsRemaining != null ? currentSeason + cs.yearsRemaining : "";
      }
    });
    aoa.push(r);
  }

  const rCost = blank(), rTeam = blank(), rDraft = blank();
  teams.forEach((t, i) => {
    const keeperCost = (t.majors || []).reduce((s, p) => s + (p.price || 0), 0);
    rCost[i * blockCols + 1]  = "Total Keepers Cost";
    rCost[i * blockCols + 2]  = keeperCost;
    rTeam[i * blockCols + 1]  = "Total Team Money";
    rTeam[i * blockCols + 2]  = 260;
    rDraft[i * blockCols + 1] = "Total Draft $ Available";
    rDraft[i * blockCols + 2] = Math.max(0, 260 - keeperCost);
  });
  aoa.push(rCost, rTeam, rDraft);
  aoa.push(blank());

  // Pre-Draft Call Ups header
  const rPreHdr = blank();
  teams.forEach((_t, i) => { rPreHdr[i * blockCols + 1] = "Pre-Draft Call Ups"; });
  aoa.push(rPreHdr);

  const rPreCols = blank();
  teams.forEach((_t, i) => {
    rPreCols[i * blockCols + 1] = "Minors";
    rPreCols[i * blockCols + 2] = "Year";
  });
  aoa.push(rPreCols);

  for (let row = 0; row < 10; row++) {
    const r = blank();
    teams.forEach((t, i) => {
      const p = (t.callups || [])[row];
      r[i * blockCols + 0] = row + 1;
      if (p) {
        r[i * blockCols + 1] = p.name;
        r[i * blockCols + 2] = yearMStr(p.yearAcquired);
        r[i * blockCols + 3] = 0;
      }
    });
    aoa.push(r);
  }

  aoa.push(blank());

  const rMinHdr = blank();
  teams.forEach((_t, i) => {
    rMinHdr[i * blockCols + 1] = "Minors";
    rMinHdr[i * blockCols + 2] = "Year";
    rMinHdr[i * blockCols + 3] = "Career ABs/IP";
  });
  aoa.push(rMinHdr);

  for (let row = 0; row < 10; row++) {
    const r = blank();
    teams.forEach((t, i) => {
      const p = (t.minors || [])[row];
      r[i * blockCols + 0] = row + 1;
      if (p) {
        r[i * blockCols + 1] = p.name;
        r[i * blockCols + 2] = yearMStr(p.yearAcquired);
        r[i * blockCols + 3] = p.careerStat ?? 0;
      } else {
        r[i * blockCols + 3] = 0;
      }
    });
    aoa.push(r);
  }

  return aoa;
}

// Eligible Keepers — full reconciliation. Uses getEligiblePlayers to walk
// each team's CURRENT MLB roster (via ESPN snapshot) and apply contract
// math (keeper / auction / FA / callup / post-deadline-drop / commish
// override). Matches the browser export.
function aoaEligibleKeepers(teams, keeperSel, balances, currentSeason, allTeams, callupOverrides, workaroundOverrides, commishOverrides, priceExceptions) {
  const blockCols = 9;
  const totalCols = teams.length * blockCols;
  const blank = () => Array(totalCols).fill("");
  const aoa = [];

  const r1 = blank();
  teams.forEach((t, i) => { r1[i * blockCols + 2] = t.name; });
  aoa.push(r1);

  const r2 = blank();
  teams.forEach((t, i) => {
    r2[i * blockCols + 2] = `${currentSeason} Draft Dollars:`;
    r2[i * blockCols + 3] = balances[t.id] != null ? balances[t.id] : 260;
  });
  aoa.push(r2);

  const r3 = blank();
  teams.forEach((t, i) => {
    const cost = (t.majors || []).reduce((s, p) => s + (p.price || 0), 0);
    r3[i * blockCols + 2] = `${currentSeason} Keeper Costs:`;
    r3[i * blockCols + 3] = cost;
  });
  aoa.push(r3);

  const r4 = blank();
  teams.forEach((t, i) => {
    const flags = keeperSel[t.id] || {};
    // Filter to players actually on this team's current roster so a stale
    // rule5-flagged row (player traded away) doesn't inflate the count.
    const rosterNames = new Set([
      ...((t.majors || []).map(p => p.name)),
      ...((t.minors || []).map(p => p.name)),
      ...((t.callups || []).map(p => p.name)),
    ]);
    const r5Count = Object.entries(flags)
      .filter(([name, f]) => f && f.rule5 && rosterNames.has(name)).length;
    r4[i * blockCols + 2] = "Rule 5 Protections:";
    r4[i * blockCols + 3] = r5Count;
  });
  aoa.push(r4);

  const r5 = blank();
  teams.forEach((_t, i) => { r5[i * blockCols + 2] = "Keepers:"; });
  aoa.push(r5);

  const r6 = blank();
  teams.forEach((t, i) => {
    const flags = keeperSel[t.id] || {};
    const majorsKept = (t.majors || []).filter(p => (flags[p.name] || {}).keeper).length;
    r6[i * blockCols + 2] = "    Majors:";
    r6[i * blockCols + 3] = majorsKept;
  });
  aoa.push(r6);

  const r7 = blank();
  teams.forEach((t, i) => {
    const flags = keeperSel[t.id] || {};
    const minorsKept = [...(t.minors || []), ...(t.callups || [])]
      .filter(p => { const f = flags[p.name] || {}; return f.minorKeeper || f.keeper; }).length;
    r7[i * blockCols + 2] = "    Minors:";
    r7[i * blockCols + 3] = minorsKept;
  });
  aoa.push(r7);

  aoa.push(blank()); // spacer

  // Header row
  const rHdr = blank();
  teams.forEach((_t, i) => {
    rHdr[i * blockCols + 0] = "Rule 5 #";
    rHdr[i * blockCols + 1] = "Keeper #";
    rHdr[i * blockCols + 2] = "Majors";
    rHdr[i * blockCols + 3] = `${currentSeason} Price`;
    rHdr[i * blockCols + 4] = "1st Year";
    rHdr[i * blockCols + 5] = "Final Year";
    rHdr[i * blockCols + 6] = "Rule 5 Protection";
    rHdr[i * blockCols + 7] = "Keeper?";
    rHdr[i * blockCols + 8] = "Trading Block";
  });
  aoa.push(rHdr);

  const r5Counters = Array(teams.length).fill(0);
  const kpCounters = Array(teams.length).fill(0);
  // Full reconciliation: walks ESPN roster + trade log + workaround
  // overrides to assemble each team's keeper-eligible majors.
  const perTeamPlayers = teams.map(t =>
    getEligiblePlayers(t, allTeams, callupOverrides, workaroundOverrides, commishOverrides, priceExceptions, currentSeason));
  const maxPlayers = Math.max(0, ...perTeamPlayers.map(arr => arr.length));

  for (let row = 0; row < maxPlayers; row++) {
    const r = blank();
    teams.forEach((t, i) => {
      const p = perTeamPlayers[i][row];
      if (!p) return;
      const flags = (keeperSel[t.id] || {})[p.name] || {};
      const yearsRemaining = p.yearsRemaining;
      const isEligible = p.canKeepNextYear !== false && yearsRemaining != null;
      const isCallup = p.contractType === "callup";
      const priceCell = isEligible
        ? (p.price == null && isCallup ? "TBD" : (p.price ?? ""))
        : (p.contractStatus === "expired" ? "Expired" : "Ineligible");
      const firstYearCell = isEligible ? (p.yearAcquired ?? "")
        : (p.contractStatus === "expired" ? (p.yearAcquired ?? "") : "Ineligible");
      const finalYear = isEligible ? currentSeason + yearsRemaining
        : (p.contractStatus === "expired" ? "Expired" : "Ineligible");
      if (flags.rule5) r5Counters[i] += 1;
      if (flags.keeper) kpCounters[i] += 1;
      r[i * blockCols + 0] = flags.rule5 ? r5Counters[i] : "";
      r[i * blockCols + 1] = flags.keeper ? kpCounters[i] : "";
      r[i * blockCols + 2] = p.name;
      r[i * blockCols + 3] = priceCell;
      r[i * blockCols + 4] = firstYearCell;
      r[i * blockCols + 5] = finalYear;
      r[i * blockCols + 6] = flags.rule5 ? 1 : 0;
      r[i * blockCols + 7] = flags.keeper ? 1 : 0;
      r[i * blockCols + 8] = flags.tradeBlock ? 1 : 0;
    });
    aoa.push(r);
  }

  aoa.push(blank());

  const rMinLabel = blank();
  teams.forEach((_t, i) => { rMinLabel[i * blockCols + 2] = "Minors"; });
  aoa.push(rMinLabel);

  // Minors-only here. Callups have been promoted to MLB and belong in
  // the Majors section (sourced from ESPN roster). Including callups
  // here would re-list them as minors and would surface
  // dropped-from-MLB callups (e.g. a player called up then released)
  // that aren't on any roster at all.
  const minorsLists = teams.map(t => (t.minors || []));
  const maxMinorsAll = Math.max(0, ...minorsLists.map(l => l.length));
  for (let row = 0; row < maxMinorsAll; row++) {
    const r = blank();
    teams.forEach((t, i) => {
      const p = minorsLists[i][row];
      if (!p) return;
      const flags = (keeperSel[t.id] || {})[p.name] || {};
      const ms = getMinorLeagueContractStatus(p, currentSeason);
      r[i * blockCols + 2] = p.name;
      r[i * blockCols + 4] = yearMStr(p.yearAcquired);
      r[i * blockCols + 5] = ms.yearsRemaining != null ? currentSeason + ms.yearsRemaining : "";
      r[i * blockCols + 6] = flags.rule5 ? 1 : 0;
      r[i * blockCols + 7] = (flags.minorKeeper || flags.keeper) ? 1 : 0;
      r[i * blockCols + 8] = flags.tradeBlock ? 1 : 0;
    });
    aoa.push(r);
  }

  return aoa;
}

function aoaTradeRegistry(trades) {
  const teamName = id => {
    const t = LEAGUE_DATA.teams.find(t => t.id === id);
    return t ? t.name : (id || "");
  };
  const isPlayer = a => a && (a.type === "major" || a.type === "minor" || a.type === "callup");
  const isPick   = a => a && a.type === "milb_pick";
  const isCash   = a => a && (a.type === "draft_dollars" || a.type === "faab");
  const fmtList = (assets, pred) =>
    (assets || []).filter(pred).map(a => a.value).filter(Boolean).join(", ");
  const toExcelDate = isoOrLabel => {
    if (!isoOrLabel) return "";
    const ms = new Date(isoOrLabel).getTime();
    if (!Number.isFinite(ms)) return isoOrLabel;
    return Math.round(ms / 86400000 + 25569);
  };
  const rows = [[
    "Trade #", "Date", "Team 1", "Team 2",
    "Plyrs Traded by T1", "Plyrs Traded by T2",
    "Picks Traded by T1", "Picks Traded by T2",
    "$ Traded by T1", "$ Traded by T2",
    "Notes", "Implemented",
  ]];
  trades.forEach((t, i) => {
    const t1gives = t.team2Receives || [];
    const t2gives = t.team1Receives || [];
    rows.push([
      i + 1,
      toExcelDate(t.createdAt || t.date),
      teamName(t.team1), teamName(t.team2),
      fmtList(t1gives, isPlayer), fmtList(t2gives, isPlayer),
      fmtList(t1gives, isPick),   fmtList(t2gives, isPick),
      fmtList(t1gives, isCash),   fmtList(t2gives, isCash),
      t.notes || "", 0,
    ]);
  });
  return rows;
}

function aoaMinorLeagueDraft(draft, trades) {
  const teamName = id => {
    const t = LEAGUE_DATA.teams.find(t => t.id === id);
    return t ? t.name : (id || "");
  };
  const rows = [["Round", "Pick #", "Original Pick Owner", "Team with Pick", "Player"]];
  if (!draft || !draft.baseOrder || !draft.rounds) return rows;
  const made = new Map();
  for (const p of (draft.picks || [])) made.set(`${p.round}p${p.pickInRound}`, p);
  const passed = new Set((draft.passed || []).map(p => `${p.round}p${p.pickInRound}`));
  for (let round = 1; round <= draft.rounds; round++) {
    for (let pickInRound = 1; pickInRound <= draft.baseOrder.length; pickInRound++) {
      const base = getBaseOwner(draft, round, pickInRound);
      const current = getPickOwner(draft, round, pickInRound, trades);
      const key = `${round}p${pickInRound}`;
      let player = "";
      if (made.has(key)) {
        const pk = made.get(key);
        player = pk.player || pk.playerName || "";
      } else if (passed.has(key)) {
        player = "Pass";
      }
      rows.push([round, pickInRound, teamName(base), teamName(current), player]);
    }
  }
  return rows;
}

function aoaExceptions(exceptions) {
  const entries = Object.entries(exceptions || {})
    .map(([name, price]) => ({ name, price: Number(price) || 0 }))
    .sort((a, b) => a.price - b.price);
  const rows = [["Player", "Salary"]];
  for (const e of entries) rows.push([e.name, e.price]);
  return rows;
}

function aoaRule5(teams, rule5State) {
  const picks = (rule5State && rule5State.picks) || [];
  const order = (rule5State && rule5State.order) || teams.map(t => t.id);
  const teamName = id => {
    const t = LEAGUE_DATA.teams.find(t => t.id === id);
    return t ? t.name : (id || "");
  };
  const teamCols = order.map(id => teamName(id));
  const aoa = [["Rd", "Pick #", "Team", "Player", "Taken From", "", "", ...teamCols]];
  const rounds = {};
  for (const pk of picks) {
    if (!rounds[pk.round]) rounds[pk.round] = [];
    rounds[pk.round].push(pk);
  }
  const maxRound = Math.max(0, ...Object.keys(rounds).map(Number), (rule5State?.currentRound || 0)) || 1;
  for (let rd = 1; rd <= maxRound; rd++) {
    const rdPicks = (rounds[rd] || []).slice().sort((a, b) => a.idx - b.idx);
    const teamPicks = {};
    for (const pk of rdPicks) teamPicks[pk.teamId] = pk.pass ? "Pass" : pk.playerName;
    for (let i = 0; i < order.length; i++) {
      const pk = rdPicks[i];
      const row = [
        rd, i + 1,
        pk ? teamName(pk.teamId) : teamName(order[i]),
        pk ? (pk.pass ? "Pass" : pk.playerName) : "",
        pk ? (pk.pass ? "" : teamName(pk.fromTeamId)) : "",
      ];
      if (i === 0) {
        row.push("", i + 1);
        for (const tid of order) row.push(teamPicks[tid] != null ? teamPicks[tid] : "");
      }
      aoa.push(row);
    }
    const spent = {}, gained = {};
    for (const tid of order) { spent[tid] = 0; gained[tid] = 0; }
    for (const pk of rdPicks) {
      if (pk.pass) continue;
      spent[pk.teamId] = (spent[pk.teamId] || 0) + 1;
      if (pk.fromTeamId) gained[pk.fromTeamId] = (gained[pk.fromTeamId] || 0) + 1;
    }
    const spentRow = ["", "", "", "", "", "$ Spent", ""];
    const gainedRow = ["", "", "", "", "", "$ Gained", ""];
    for (const tid of order) { spentRow.push(spent[tid]); gainedRow.push(gained[tid]); }
    aoa.push(spentRow, gainedRow);
  }
  return aoa;
}

// ---------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------
async function main() {
  const state = await fetchAll();
  const url = state.googleSheetsWebAppUrl;
  if (!url) {
    console.log("No googleSheetsWebAppUrl saved in settings; skipping sync.");
    return;
  }
  if (!/^https:\/\/script\.google(?:usercontent)?\.com\/macros\/.+\/exec/.test(url)) {
    console.error(`Saved URL doesn't match expected pattern: ${url}`);
    process.exit(1);
  }

  const currentSeason = state.settings.currentSeason || DEFAULT_SEASON;
  const teams = LEAGUE_DATA.teams.map(t => ({
    ...t,
    majors:  (t.majors  || []).map(p => ({ ...p })),
    minors:  (t.minors  || []).map(p => ({ ...p })),
    callups: (t.callups || []).map(p => ({ ...p })),
  }));

  applyPriceShift(teams, currentSeason);
  applyRosterAdjustments(teams, state.trades, state.callup, state.rosterMoves, state.draft);
  applyLivePlayerStats(teams);

  const ordered = getDisplayOrderedTeams(teams);
  const sendDownsByTeam = getSendDownsByTeam(state.rosterMoves);
  const balances = getDraftDollarBalances(teams, state.trades);

  const payload = {
    tabs: [
      { name: `${currentSeason} Minor Leagues`,             rows: aoaMinorLeagues(ordered, sendDownsByTeam) },
      { name: `${currentSeason + 1} Pre-Draft Trade Registry`, rows: aoaTradeRegistry(state.trades) },
      { name: `${currentSeason} Minor League Draft`,        rows: aoaMinorLeagueDraft(state.draft, state.trades) },
      { name: `${currentSeason} Keepers`,                   rows: aoaKeepers(ordered, currentSeason) },
      { name: "Exceptions",                                  rows: aoaExceptions(state.keeperPriceExceptions) },
      { name: `${currentSeason + 1} Eligible Keepers`,      rows: aoaEligibleKeepers(ordered, state.keeperSel, balances, currentSeason, teams, state.callup, state.workaroundOverrides, state.commishOverrides, state.keeperPriceExceptions) },
      { name: `Rule 5 Draft ${currentSeason}`,              rows: aoaRule5(ordered, state.rule5) },
    ],
  };

  if (DEBUG) {
    for (const t of payload.tabs) {
      console.log(`  ${t.name}: ${t.rows.length} rows`);
    }
  }

  // Apps Script /exec returns a 302 pointing at a googleusercontent.com URL
  // whose GET body is the doPost response. Browsers downgrade POST→GET on
  // 302 (legacy behavior); Node's fetch preserves POST per WHATWG spec,
  // which would hit a Drive 405. Handle the redirect ourselves.
  //
  // Apps Script Web Apps occasionally serve transient 404/500 pages from
  // googleusercontent.com — retry a few times before failing the workflow
  // (the next 5-min cron tick almost always succeeds).
  const MAX_ATTEMPTS = 3;
  const RETRY_DELAY_MS = 5000;
  let attempt = 0;
  let lastFailure = null;
  while (attempt < MAX_ATTEMPTS) {
    attempt++;
    const postResp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
      redirect: "manual",
    });
    let resp = postResp;
    if (postResp.status >= 300 && postResp.status < 400) {
      const location = postResp.headers.get("location");
      if (!location) throw new Error(`Apps Script redirect missing Location header (HTTP ${postResp.status})`);
      resp = await fetch(location, { method: "GET" });
    }
    const text = await resp.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    if (data && data.ok) {
      if (attempt > 1) console.log(`(succeeded on attempt ${attempt})`);
      console.log(`Synced ${data.tabs} tab(s) to Google Sheets.`);
      return;
    }
    if (data && data.error) {
      // Application-level error from the Apps Script — not transient.
      console.error(`Apps Script error: ${data.error}`);
      process.exit(1);
    }
    // HTML response or empty body — Google infra hiccup. Retry.
    lastFailure = `HTTP ${resp.status}: ${text.slice(0, 200)}`;
    console.warn(`Attempt ${attempt}/${MAX_ATTEMPTS} failed (${lastFailure}); retrying in ${RETRY_DELAY_MS / 1000}s…`);
    if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
  }
  console.error(`Unexpected response after ${MAX_ATTEMPTS} attempts: ${lastFailure}`);
  process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
