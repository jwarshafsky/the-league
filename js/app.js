// Fantasy League Manager - Main App

// CURRENT_SEASON defaults to 2026 but can be overridden by the commissioner
// via the Settings tab (stored in league_state.settings.currentSeason).
// Kept as a `let` so existing references pick up the new value automatically
// after the DB cache loads. _applySettingsFromCache() reconciles the override
// once the cache is populated.
let CURRENT_SEASON = 2026;
const DEFAULT_SEASON = 2026;

// data.js holds keeper prices baselined to 2026. When the commissioner sets
// the current season ahead (e.g., 2027), every keeper's contract bumps $2
// per year per the rules. We apply that bump in-memory so the rest of the
// codebase keeps reading `player.price` and gets the correct current-season
// value. The tracked shift makes the operation idempotent across re-runs
// and reversible if the year is set backward.
const DATA_JS_BASE_SEASON = 2026;
let _currentlyAppliedPriceShift = 0;

function _applyPriceShiftToData() {
  if (typeof LEAGUE_DATA === "undefined") return;
  const wantShift = CURRENT_SEASON - DATA_JS_BASE_SEASON;
  const delta = wantShift - _currentlyAppliedPriceShift;
  if (delta === 0) return;
  const dollarsDelta = delta * 2;
  for (const team of LEAGUE_DATA.teams) {
    for (const p of (team.majors || [])) {
      if (typeof p.price === "number") p.price += dollarsDelta;
    }
    for (const p of (team.callups || [])) {
      if (typeof p.price === "number") p.price += dollarsDelta;
    }
  }
  // Also adjust the captured snapshot so applyRosterAdjustments resets
  // callups to shifted values, not data.js originals.
  if (typeof _originalRosterSnapshot !== "undefined") {
    for (const snap of _originalRosterSnapshot.values()) {
      for (const p of (snap.callups || [])) {
        if (typeof p.price === "number") p.price += dollarsDelta;
      }
    }
  }
  _currentlyAppliedPriceShift = wantShift;
}

// Roster caps (league constitution).
const ML_ROSTER_MAX = 25;
const MIL_ROSTER_MAX = 10;

function getLeagueSettings() {
  if (typeof dbGetSettings === "function") return dbGetSettings();
  return {};
}

function _applySettingsFromCache() {
  const s = getLeagueSettings();
  if (s && typeof s.currentSeason === "number") {
    CURRENT_SEASON = s.currentSeason;
  } else {
    CURRENT_SEASON = DEFAULT_SEASON;
  }
  _applyPriceShiftToData();
  _updateSeasonInNav();
}

// Update the "2026 Keepers" nav button (and drawer item) to reflect the
// current season. The HTML hardcodes "2026 Keepers" — refresh it on each
// settings load so it tracks the commissioner's Set Year.
function _updateSeasonInNav() {
  document.querySelectorAll('[data-tab="keepers"]').forEach(el => {
    el.textContent = `${CURRENT_SEASON} Keepers`;
  });
}

function isRule5RosterEnforcementEnabled() {
  return !!getLeagueSettings().enforceRule5RosterSpot;
}
function isMinorsRosterEnforcementEnabled() {
  return !!getLeagueSettings().enforceMinorsRosterSpot;
}

// Default display order for "list every team" UIs: prior-year final
// standings (best to worst) from HISTORY_SNAPSHOT. Falls back to the
// data.js order if no prior-year standings are available. Used by
// dropdowns, the Draft Dollars panel, the Fees and Trade Block grids,
// etc. — anywhere a team list is shown without a domain-specific sort.
function getDisplayOrderedTeams() {
  if (typeof LEAGUE_DATA === "undefined") return [];
  let standings = null;
  if (typeof HISTORY_SNAPSHOT !== "undefined" && HISTORY_SNAPSHOT?.seasons?.length) {
    // Most recent completed season available; ideally CURRENT_SEASON - 1 but
    // any season works as a fallback so the order is stable.
    const target = (typeof CURRENT_SEASON === "number") ? CURRENT_SEASON - 1 : null;
    const exact = target ? HISTORY_SNAPSHOT.seasons.find(s => s.year === target) : null;
    standings = exact?.standings || HISTORY_SNAPSHOT.seasons[0]?.standings || null;
  }
  if (!standings) return LEAGUE_DATA.teams.slice();
  const rankByLocal = {};
  for (const row of standings) {
    const localId = (typeof trophyTeamLocalId === "function")
      ? trophyTeamLocalId({ abbrev: row.abbrev, espnId: row.espnId })
      : null;
    if (localId && rankByLocal[localId] == null) rankByLocal[localId] = row.rank;
  }
  return [...LEAGUE_DATA.teams].sort((a, b) => {
    const ra = rankByLocal[a.id] ?? 999;
    const rb = rankByLocal[b.id] ?? 999;
    return ra - rb;
  });
}

// Count current ML roster slots used by a team (majors + callups). After
// applyRosterAdjustments, these arrays already reflect Rule 5 picks (which
// are recorded as trades) and call-ups.
function getTeamMlCount(teamId) {
  const team = LEAGUE_DATA.teams.find(t => t.id === teamId);
  if (!team) return 0;
  return (team.majors || []).length + (team.callups || []).length;
}

// Count current MiL roster slots used by a team. Includes existing minors +
// minors-draft picks already made by this team (Minors Draft picks don't
// move players via the trade mechanism, so we count them explicitly).
function getTeamMilCount(teamId) {
  const team = LEAGUE_DATA.teams.find(t => t.id === teamId);
  if (!team) return 0;
  const draft = (typeof getDraft === "function") ? getDraft() : null;
  const minorsPicks = draft && Array.isArray(draft.picks)
    ? draft.picks.filter(p => p.team === teamId).length
    : 0;
  return (team.minors || []).length + minorsPicks;
}

// --- Contract Calculation Logic ---

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
  const yearsKept = currentSeason - yearAcquired;
  return currentPrice - (yearsKept * 2);
}

function getContractStatus(player, currentSeason) {
  const yearsKept = getContractYearsKept(player.yearAcquired, currentSeason);
  const originalPrice = getOriginalDraftPrice(player.price, player.yearAcquired, currentSeason);
  const maxYears = getMaxKeepYears(originalPrice, player.fromMinors);

  const yearsRemaining = maxYears - yearsKept;
  const nextYearPrice = player.price + 2;
  const canKeepNextYear = yearsRemaining > 0;

  let status, label;
  if (yearsRemaining <= 0) {
    status = "final";
    label = "Final Year";
  } else if (yearsRemaining === 1) {
    status = "expiring";
    label = "1 yr left";
  } else if (yearsKept === 0) {
    status = "new";
    label = `${yearsRemaining} yrs left`;
  } else {
    status = "mid";
    label = `${yearsRemaining} yrs left`;
  }

  return { yearsKept, yearsRemaining, originalPrice, maxYears, nextYearPrice, canKeepNextYear, status, label };
}

function getMinorLeagueContractStatus(player, currentSeason) {
  const yearDrafted = player.yearAcquired;
  const yearsHeld = currentSeason - yearDrafted;

  let maxYears, contractNote;
  if (yearDrafted < 2027) {
    maxYears = 4;
    contractNote = "4-yr contract";
  } else {
    maxYears = 99;
    contractNote = "Call-up + 3";
  }

  // "Yrs left" = seasons remaining AFTER the current one. So a 4-yr contract drafted in 2023,
  // viewed in 2026, has 0 yrs left (this is his final season).
  let yearsRemaining = Math.max(0, maxYears - yearsHeld - 1);

  const callUpYearLabel = `${currentSeason + 1} Must Call Up`;
  let eligibilityWarning = null;
  // Years remaining always reflects the raw contract length. The "must call
  // up" status is signaled via eligibilityWarning, displayed as a badge.
  if (
    (player.statType === "AB" && player.careerStat >= 200) ||
    (player.statType === "IP" && player.careerStat >= 50)
  ) {
    eligibilityWarning = callUpYearLabel;
  }

  return {
    yearsHeld,
    yearsRemaining: yearDrafted < 2027 ? yearsRemaining : null,
    contractNote,
    eligibilityWarning
  };
}


// --- Roster adjustments (trades + call-ups) ---
//
// data.js gives a static "anchor" snapshot of every team's minors + callups.
// Real moves happen via two sources after that:
//   1) The trades log — minor / callup -typed assets actually move ownership.
//   2) callup_overrides — when an owner has a callup price set for a player
//      that's still in their minors anchor, treat that as "this player has
//      been called up" and shift them from minors to callups.
//
// applyRosterAdjustments() rebuilds team.minors and team.callups in place
// from the snapshot every render so existing callers (renderMinorsTable,
// renderTeamAssetPicker, getEligiblePlayers, etc.) keep working unchanged.

const _originalRosterSnapshot = (typeof LEAGUE_DATA !== "undefined")
  ? new Map(LEAGUE_DATA.teams.map(t => [t.id, {
      minors: (t.minors || []).map(p => ({ ...p })),
      callups: (t.callups || []).map(p => ({ ...p })),
    }]))
  : new Map();

function _findOriginalMinorRecord(name) {
  if (!name) return null;
  for (const snap of _originalRosterSnapshot.values()) {
    const m = (snap.minors || []).find(p => p.name === name);
    if (m) return m;
    const c = (snap.callups || []).find(p => p.name === name);
    if (c) return c;
  }
  return null;
}

function _moveBetweenLists(map, fromTeamId, toTeamId, name) {
  const fromList = map.get(fromTeamId) || [];
  let player;
  const idx = fromList.findIndex(p => p.name === name);
  if (idx !== -1) {
    player = fromList.splice(idx, 1)[0];
    map.set(fromTeamId, fromList);
  } else {
    // Player not in from team's current list — pull their full record from
    // the original anchor so the destination team gets a complete entry.
    const orig = _findOriginalMinorRecord(name);
    if (!orig) return;
    player = { ...orig };
  }
  const toList = map.get(toTeamId) || [];
  if (!toList.find(p => p.name === player.name)) toList.push({ ...player });
  map.set(toTeamId, toList);
}

function _applyAssetMoves(teamMinors, teamCallups, fromTeamId, toTeamId, receives) {
  if (!receives || !receives.length) return;
  for (const asset of receives) {
    const name = asset.value || asset.name;
    if (!name) continue;
    if (asset.type === "minor")  _moveBetweenLists(teamMinors,  fromTeamId, toTeamId, name);
    else if (asset.type === "callup") _moveBetweenLists(teamCallups, fromTeamId, toTeamId, name);
  }
}

function applyRosterAdjustments() {
  if (typeof LEAGUE_DATA === "undefined") return;
  const teamMinors  = new Map();
  const teamCallups = new Map();
  for (const team of LEAGUE_DATA.teams) {
    const snap = _originalRosterSnapshot.get(team.id);
    teamMinors.set(team.id,  snap ? snap.minors.map(p => ({ ...p })) : []);
    teamCallups.set(team.id, snap ? snap.callups.map(p => ({ ...p })) : []);
  }
  // 1. Apply trade-log moves chronologically. team1Receives = what team1
  //    GETS (came from team2), so the asset moves team2 → team1.
  const trades = (typeof getTrades === "function") ? getTrades() : [];
  const sorted = [...trades].sort((a, b) =>
    new Date(a.createdAt || 0) - new Date(b.createdAt || 0)
  );
  for (const t of sorted) {
    _applyAssetMoves(teamMinors, teamCallups, t.team2, t.team1, t.team1Receives);
    _applyAssetMoves(teamMinors, teamCallups, t.team1, t.team2, t.team2Receives);
  }
  // 2. callup_overrides → minors→callups within the same team. Kept for
  //    back-compat with any historical price-set actions; the new Call Up
  //    flow uses roster_moves below.
  const overrides = (typeof dbGetCallupOverrides === "function") ? dbGetCallupOverrides() : {};
  for (const playerName of Object.keys(overrides)) {
    for (const team of LEAGUE_DATA.teams) {
      const minors = teamMinors.get(team.id) || [];
      const idx = minors.findIndex(p => p.name === playerName);
      if (idx !== -1) {
        const player = minors.splice(idx, 1)[0];
        teamMinors.set(team.id, minors);
        const callups = teamCallups.get(team.id) || [];
        if (!callups.find(p => p.name === player.name)) callups.push(player);
        teamCallups.set(team.id, callups);
        break;
      }
    }
  }
  // 3. roster_moves: explicit call-up (minors→callups) and demote
  //    (callups→minors) actions, processed in time order so the latest move
  //    wins. Demotes here override anything the callup_overrides loop did.
  const moves = (typeof dbGetRosterMoves === "function") ? dbGetRosterMoves() : [];
  const sortedMoves = [...moves].sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));
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
    }
  }
  // Mutate LEAGUE_DATA in place so existing call sites keep reading the
  // up-to-date arrays without code changes.
  for (const team of LEAGUE_DATA.teams) {
    team.minors  = teamMinors.get(team.id) || [];
    team.callups = teamCallups.get(team.id) || [];
  }
  // Re-apply the daily-refreshed careerAB / careerIP from PLAYER_STATS so
  // the rebuilt arrays don't fall back to the static (stale) careerStat
  // values captured in the snapshot at script-load time.
  if (typeof applyLivePlayerStats === "function") applyLivePlayerStats();
}


// --- Rendering: Team Grid (Home) ---

function renderTeamGrid() {
  const teams = LEAGUE_DATA.teams;
  return `
    <div class="team-grid">
      ${teams.map(team => `
        <div class="team-card" onclick="showTeamKeepers('${team.id}')">
          <div class="team-card-name">${team.name}</div>
          <div class="team-card-stats">
            <div class="team-stat">
              <div class="team-stat-value" style="color: var(--green)">$${team.totalKeeperCost}</div>
              <div class="team-stat-label">Keeper Cost</div>
            </div>
            <div class="team-stat">
              <div class="team-stat-value" style="color: var(--accent)">$${team.draftBudget}</div>
              <div class="team-stat-label">Draft $</div>
            </div>
            <div class="team-stat">
              <div class="team-stat-value" style="color: var(--text-bright)">$${team.teamMoney}</div>
              <div class="team-stat-label">Total $</div>
            </div>
          </div>
          <div class="team-card-roster">
            <span class="roster-badge badge-majors">${team.majors.length} Keepers</span>
            ${team.callups.length ? `<span class="roster-badge badge-callups">${team.callups.length} Call-ups</span>` : ""}
            <span class="roster-badge badge-minors">${team.minors.length} Minors</span>
          </div>
        </div>
      `).join("")}
    </div>
  `;
}


// --- Rendering: Keepers Tab (pre-draft keepers) ---

function renderKeepersView() {
  return `
    <div class="calc-team-selector">
      <select id="keepers-team-select" onchange="updateKeepersView()">
        <option value="">Select a team...</option>
        <option value="all">All Teams</option>
        ${getDisplayOrderedTeams().map(t => `<option value="${t.id}">${t.name}</option>`).join("")}
      </select>
    </div>
    <div id="keepers-content"></div>
  `;
}

function updateKeepersView() {
  const teamId = document.getElementById("keepers-team-select").value;
  if (typeof _lastTeamSel !== "undefined") _lastTeamSel.keepers = teamId;
  const container = document.getElementById("keepers-content");
  if (!teamId) { container.innerHTML = ""; return; }

  // After the commissioner advances the season past the data.js baseline
  // (e.g., 2026 → 2027), the locked-in keepers for the new season are the
  // players that were Keep-checked in Select Keepers. Pre-advance, this tab
  // shows the static rosters as-is.
  const sel = (typeof dbGetKeeperSelections === "function") ? dbGetKeeperSelections() : {};
  const isPostAdvance = CURRENT_SEASON > DATA_JS_BASE_SEASON;
  function teamMajorsForKeepersTab(team) {
    if (!isPostAdvance) return team.majors;
    const flags = sel[team.id] || {};
    return team.majors.filter(p => flags[p.name]?.keeper === true);
  }
  function teamMilForKeepersTab(team) {
    const merged = [
      ...(team.minors || []).map(p => ({ ...p, _calledUp: false })),
      ...(team.callups || []).map(p => ({ ...p, _calledUp: true })),
    ].filter(p => (p.yearAcquired ?? 0) < CURRENT_SEASON);
    if (!isPostAdvance) return merged;
    const flags = sel[team.id] || {};
    return merged.filter(p => flags[p.name]?.minorKeeper === true || flags[p.name]?.keeper === true);
  }

  if (teamId === "all") {
    container.innerHTML = getDisplayOrderedTeams().map(team => {
      const majors = teamMajorsForKeepersTab(team);
      const milKeepers = teamMilForKeepersTab(team);
      return `
      <div style="margin-bottom:24px">
        <h3 style="color:var(--text-bright);margin-bottom:8px;cursor:pointer" onclick="document.getElementById('keepers-team-select').value='${team.id}';updateKeepersView()">
          ${team.name} <span style="color:var(--green);font-size:0.85rem">$${team.totalKeeperCost}</span>
          <span style="color:var(--text-dim);font-size:0.85rem">/ Draft: $${team.draftBudget}</span>
        </h3>
        <div class="section-header">${CURRENT_SEASON} Major League Keepers <span class="section-count">${majors.length}/8</span></div>
        ${renderMajorsTable(majors)}
        <div class="section-header">${CURRENT_SEASON} Minor League Keepers <span class="section-count">${milKeepers.length}/10</span></div>
        ${renderMinorsKeepersTable(milKeepers)}
      </div>
    `;
    }).join("");
    return;
  }

  const team = LEAGUE_DATA.teams.find(t => t.id === teamId);
  if (!team) return;
  const majors = teamMajorsForKeepersTab(team);
  const milKeepers = teamMilForKeepersTab(team);

  container.innerHTML = `
    <div class="summary-bar">
      <div class="summary-item">
        <div class="summary-value" style="color:var(--green)">$${team.totalKeeperCost}</div>
        <div class="summary-label">Keeper Cost</div>
      </div>
      <div class="summary-item">
        <div class="summary-value" style="color:var(--accent)">$${team.draftBudget}</div>
        <div class="summary-label">Draft Budget</div>
      </div>
      <div class="summary-item">
        <div class="summary-value">$${team.teamMoney}</div>
        <div class="summary-label">Total Money</div>
      </div>
    </div>
    <div class="section-header">${CURRENT_SEASON} Major League Keepers <span class="section-count">${majors.length}/8</span></div>
    ${renderMajorsTable(majors)}
    <div class="section-header">${CURRENT_SEASON} Minor League Keepers <span class="section-count">${milKeepers.length}/10</span></div>
    ${renderMinorsKeepersTable(milKeepers)}
  `;
}

function renderMinorsKeepersTable(minors) {
  if (!minors.length) return '<p style="color:var(--text-dim)">No minor league keepers</p>';
  const sorted = [...minors].sort((a, b) => lastName(a.name).localeCompare(lastName(b.name)));
  return `
    <table class="player-table">
      <thead>
        <tr><th>Player</th><th>Drafted</th><th>AB/IP</th><th>Expiry</th></tr>
      </thead>
      <tbody>
        ${sorted.map(p => {
          const ms = getMinorLeagueContractStatus(p, CURRENT_SEASON);
          let statClass = "";
          if ((p.statType === "AB" && p.careerStat >= 200) || (p.statType === "IP" && p.careerStat >= 50)) statClass = "stat-warning";
          // Once a player is in the callups bucket, the "Must Call Up"
          // eligibility warning no longer applies — they've already been
          // called up. Show a "Called up" badge instead.
          const statusBadge = p._calledUp
            ? ` <span class="hide-on-mobile" style="color:var(--purple);font-size:0.7rem;font-weight:600">Called up</span>`
            : (ms.eligibilityWarning ? ` <span class="hide-on-mobile" style="color:var(--orange);font-size:0.7rem;font-weight:600">${escapeHtml(ms.eligibilityWarning)}</span>` : "");
          const milTag = (() => {
            if (ms.yearsRemaining === null) {
              return `<span class="contract-tag contract-new">${escapeHtml(ms.contractNote)}</span>`;
            }
            const yrs = ms.yearsRemaining;
            const cls = yrs === 0 ? "final" : yrs === 1 ? "expiring" : "mid";
            return `<span class="contract-tag contract-${cls}">${CURRENT_SEASON + yrs}</span>`;
          })();
          return `
            <tr>
              <td><span class="player-name">${escapeHtml(p.name)}</span>${statusBadge}</td>
              <td class="player-year">${p.yearAcquired}</td>
              <td class="${statClass}">${p.careerStat}</td>
              <td>${milTag}${p.sendDownCount ? ` <span style="color:var(--red);font-size:0.7rem;font-weight:600">($${p.sendDownCount * 10} send down fee)</span>` : ""}</td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
  `;
}

function showTeamKeepers(teamId) {
  switchTab("keepers");
  setTimeout(() => {
    document.getElementById("keepers-team-select").value = teamId;
    updateKeepersView();
  }, 0);
}


// --- Rendering: Rosters Tab (current minors + callups) ---

function renderRostersView() {
  return `
    <div class="calc-team-selector">
      <select id="rosters-team-select" onchange="updateRostersView()">
        <option value="">Select a team...</option>
        <option value="all">All Teams</option>
        ${getDisplayOrderedTeams().map(t => `<option value="${t.id}">${t.name}</option>`).join("")}
      </select>
    </div>
    <div id="rosters-content"></div>
  `;
}

function updateRostersView() {
  const teamId = document.getElementById("rosters-team-select").value;
  if (typeof _lastTeamSel !== "undefined") _lastTeamSel.rosters = teamId;
  const container = document.getElementById("rosters-content");
  if (!teamId) { container.innerHTML = ""; return; }

  if (teamId === "all") {
    container.innerHTML = getDisplayOrderedTeams().map(team => {
      const liveCount = getCurrentMinors(team).length;
      return `
      <div style="margin-bottom:24px">
        <h3 style="color:var(--text-bright);margin-bottom:8px;cursor:pointer" onclick="document.getElementById('rosters-team-select').value='${team.id}';updateRostersView()">
          ${team.name}
          <span style="color:var(--green);font-size:0.8rem">${liveCount} minors</span>
        </h3>
        ${renderMinorsCompactTable(team)}
      </div>
      `;
    }).join("");
    return;
  }

  const team = LEAGUE_DATA.teams.find(t => t.id === teamId);
  if (!team) return;

  // Tag each minor with their current ESPN status so the table can show
  // "Dropped" / "Traded" / "Active" appropriately.
  const minorsWithDropFlag = team.minors.map(p => ({
    ...p,
    _teamStatus: getMinorTeamStatus(p.name, team.id),
  }));
  container.innerHTML = `
    ${team.callups.length ? `
      <div class="section-header">
        Called Up to Majors <span class="section-count">${team.callups.length}</span>
      </div>
      ${renderCallupsTable(team.callups, team.id)}
    ` : ""}

    <div class="section-header">
      Minor League Roster <span class="section-count">${minorsWithDropFlag.length}/10</span>
    </div>
    ${renderMinorsTable(minorsWithDropFlag, team.id)}
  `;
}

// Re-render the rosters view in place after a roster move, preserving the
// team that's currently selected in the dropdown. Falls back to a full
// switchTab() when not on the rosters view.
function _refreshAfterRosterMove() {
  if (typeof applyRosterAdjustments === "function") applyRosterAdjustments();
  if (typeof _invalidatePriceMap === "function") _invalidatePriceMap();
  if (typeof currentView !== "undefined" && currentView === "rosters" && typeof updateRostersView === "function") {
    updateRostersView();
  } else if (typeof switchTab === "function" && typeof currentView !== "undefined") {
    switchTab(currentView);
  }
}

async function callUpMinorPlayer(playerName, teamId) {
  if (!canEditTeam(teamId)) {
    alert("Only the team owner or a commissioner can call up players on this team.");
    return;
  }
  if (!confirm(`Call up ${playerName}? (Salary will be set in the offseason.)`)) return;
  try {
    let moveId = null;
    if (typeof appendRosterMoveAsync === "function") {
      const move = await appendRosterMoveAsync({ kind: "callup", player_name: playerName, team_id: teamId });
      moveId = move?.id || null;
    }
    if (typeof logActivityAsync === "function") {
      logActivityAsync("player_called_up", { player_name: playerName, move_id: moveId }, { targetTeamId: teamId });
    }
    _refreshAfterRosterMove();
  } catch (e) {
    alert("Couldn't call up: " + (e.message || e));
  }
}

async function sendDownPlayer(playerName, teamId) {
  if (!canEditTeam(teamId)) {
    alert("Only the team owner or a commissioner can send down players on this team.");
    return;
  }
  if (!confirm(`Send ${playerName} back to the minors?`)) return;
  try {
    let moveId = null;
    if (typeof appendRosterMoveAsync === "function") {
      const move = await appendRosterMoveAsync({ kind: "demote", player_name: playerName, team_id: teamId });
      moveId = move?.id || null;
    }
    if (typeof logActivityAsync === "function") {
      logActivityAsync("player_sent_down", { player_name: playerName, move_id: moveId }, { targetTeamId: teamId });
    }
    _refreshAfterRosterMove();
  } catch (e) {
    alert("Couldn't send down: " + (e.message || e));
  }
}

async function undoActivityEntry(activityId) {
  if (!isCommissioner()) {
    alert("Only commissioners can undo activity entries.");
    return;
  }
  if (!activityId) return;
  const entry = _cache.activity?.find(a => a.id === activityId);
  if (!entry) {
    alert("Couldn't find this entry.");
    return;
  }
  if (!confirm("Undo this entry and remove it from the log?")) return;
  try {
    await _reverseActivityEffect(entry);
    const { error } = await supabaseClient.from("activity_log").delete().eq("id", activityId);
    if (error) throw error;
    if (_cache.activity) {
      const idx = _cache.activity.findIndex(a => a.id === activityId);
      if (idx !== -1) _cache.activity.splice(idx, 1);
    }
    _refreshAfterRosterMove();
  } catch (e) {
    alert("Couldn't undo: " + (e.message || e));
  }
}

async function _reverseActivityEffect(entry) {
  const p = entry.payload || {};
  const team = entry.target_team_id || entry.actor_team_id;
  const playerName = p.player_name;

  switch (entry.type) {
    case "player_called_up":
    case "player_sent_down": {
      if (p.move_id) {
        const { error } = await supabaseClient.from("roster_moves").delete().eq("id", p.move_id);
        if (error) throw error;
      }
      return;
    }
    case "keeper_added":
    case "keeper_removed":
    case "minor_keeper_added":
    case "minor_keeper_removed":
    case "rule5_added":
    case "rule5_removed":
    case "trade_block_added":
    case "trade_block_removed": {
      if (!team || !playerName) return;
      const flagMap = {
        keeper:       "keeper",
        minor_keeper: "minorKeeper",
        rule5:        "rule5",
        trade_block:  "tradeBlock",
      };
      const fieldKey = entry.type.replace(/_(added|removed)$/, "");
      const flagKey = flagMap[fieldKey];
      const wasAdded = entry.type.endsWith("_added");
      const current = _cache.keeperSel[team]?.[playerName] || {};
      const newFlags = {
        keeper:      !!current.keeper,
        minorKeeper: !!current.minorKeeper,
        rule5:       !!current.rule5,
        tradeBlock:  !!current.tradeBlock,
      };
      newFlags[flagKey] = !wasAdded;
      await setKeeperSelectionAsync(team, playerName, newFlags);
      return;
    }
    case "trade_recorded": {
      if (p.trade_id && typeof deleteTradeAsync === "function") {
        await deleteTradeAsync(p.trade_id);
      }
      return;
    }
    case "callup_price_set": {
      if (!playerName) return;
      const { error } = await supabaseClient.from("callup_overrides").delete().eq("player_name", playerName);
      if (error) throw error;
      if (_cache.callup) delete _cache.callup[playerName];
      return;
    }
    case "keepers_locked":
      await saveKeeperDeadlineAsync(null);
      return;
    case "keepers_unlocked":
      await saveKeeperDeadlineAsync({ locked: true });
      return;
    case "commish_override": {
      if (!playerName) return;
      const map = (typeof dbGetCommishOverrides === "function") ? dbGetCommishOverrides() : {};
      delete map[playerName];
      if (typeof saveCommishOverridesAsync === "function") await saveCommishOverridesAsync(map);
      return;
    }
    case "rule5_pick_made": {
      // Activity payload has 1-indexed idx; rule5 state stores 0-indexed.
      const state = (typeof getRule5State === "function") ? getRule5State() : null;
      if (!state || !state.picks) return;
      const targetIdx0 = (typeof p.idx === "number") ? p.idx - 1 : null;
      const match = state.picks.find(pick =>
        pick.round === p.round && pick.idx === targetIdx0 && pick.playerName === playerName
      );
      if (!match) return;
      if (match.tradeId && typeof deleteTradeAsync === "function") {
        try { await deleteTradeAsync(match.tradeId); } catch (e) { console.warn("Rule 5 trade delete failed:", e); }
      }
      state.picks = state.picks.filter(pick => pick !== match);
      if (typeof saveRule5Async === "function") await saveRule5Async(state);
      else if (typeof saveRule5State === "function") saveRule5State(state);
      return;
    }
    case "minors_pick_made":
    case "minors_pick_passed":
    case "minors_pick_auto_skipped": {
      const draft = (typeof getDraft === "function") ? getDraft() : null;
      if (!draft) return;
      const round = p.round;
      const pickInRound = p.pick_in_round;
      if (entry.type === "minors_pick_made" && Array.isArray(draft.picks)) {
        draft.picks = draft.picks.filter(pick =>
          !(pick.round === round && pick.pickInRound === pickInRound && pick.player === playerName)
        );
      } else if (Array.isArray(draft.passed)) {
        draft.passed = draft.passed.filter(pp => !(pp.round === round && pp.pickInRound === pickInRound));
      }
      if (typeof saveDraftAsync === "function") await saveDraftAsync(draft);
      else if (typeof saveDraft === "function") saveDraft(draft);
      return;
    }
    default:
      // Trade edits/deletes, draft resets, and existing pick-undo entries
      // aren't reversed automatically — only the log row is removed.
      return;
  }
}

// Returns "on-roster" | "traded" | "dropped" | null (null = not enough info / true prospect).
function getMinorTeamStatus(playerName, teamId) {
  const snap = getEspnSnapshot();
  if (!snap) return null;
  const espnTeam = snap.teams.find(t => ESPN_ABBREV_TO_LOCAL[t.abbrev] === teamId);
  if (!espnTeam) return null;
  if (espnTeam.roster.some(r => r.name === playerName)) return "on-roster";
  const onAnyEspnRoster = snap.teams.some(t => t.roster.some(r => r.name === playerName));
  if (!onAnyEspnRoster) return null;       // pure prospect, ESPN doesn't track

  const playerId = getPlayerIdByName(playerName, teamId);
  if (!playerId) return "dropped";

  // 1. If ESPN logged a TRADE event — that's the strongest signal.
  const teamEspnId = espnTeam.espnId;
  const teamEvents = (snap.events || [])
    .filter(e => e.playerId === playerId && (
      e.teamId === teamEspnId || e.fromTeamId === teamEspnId || e.toTeamId === teamEspnId
    ))
    .sort((a, b) => (b.date || 0) - (a.date || 0));
  for (const ev of teamEvents) {
    if (ev.type === "TRADE" && ev.fromTeamId === teamEspnId) return "traded";
    if (ev.type === "ADD"   && ev.toTeamId === teamEspnId)   return "on-roster";
    if (ev.type === "DROP"  && ev.teamId === teamEspnId)     break; // fall through to commish-add check
  }

  // 2. "Manual trade" workaround: commish drops the player on team A, then
  //    adds them to team B. classifyCommishAdd presumes that's a TRADE
  //    (unless within 24h of the drop, which is treated as FA reversal).
  const lastAdd = getMostRecentAddEvent(playerId);
  if (lastAdd && lastAdd.isCommishWorkaround) {
    let currentTeamId = null;
    for (const t of snap.teams) {
      if (t.roster.some(r => r.name === playerName)) {
        currentTeamId = ESPN_ABBREV_TO_LOCAL[t.abbrev];
        break;
      }
    }
    if (currentTeamId) {
      const cls = classifyCommishAdd(playerName, playerId, currentTeamId, lastAdd);
      if (cls && cls.decision === "trade") return "traded";
    }
  }

  return "dropped";
}

function getCurrentMinors(team) {
  // Filter out MILB players whose ESPN roster spot is now elsewhere (dropped
  // or traded away). True prospects with no MLB time aren't in ESPN at all
  // and stay visible.
  const snap = getEspnSnapshot();
  if (!snap) return team.minors;
  const espnTeamByPlayer = {};
  for (const t of snap.teams) {
    const localId = ESPN_ABBREV_TO_LOCAL[t.abbrev];
    if (!localId) continue;
    for (const r of t.roster) espnTeamByPlayer[r.name] = localId;
  }
  return team.minors.filter(p => {
    const tid = espnTeamByPlayer[p.name];
    if (!tid) return true;          // not on any ESPN roster → real prospect
    return tid === team.id;          // on ESPN → must match this team
  });
}

function renderMinorsCompactTable(team) {
  // All Teams view: only show MILB-roster players. Callups (already on MLB
  // roster) live on the Eligible Keepers / individual team pages instead.
  const allPlayers = getCurrentMinors(team)
    .map(p => ({ ...p, rosterType: "minors" }))
    .sort((a, b) => lastName(a.name).localeCompare(lastName(b.name)));
  if (!allPlayers.length) return "<p style='color:var(--text-dim)'>No minor league players</p>";
  return `
    <table class="player-table">
      <thead><tr><th>Player</th><th>Drafted</th><th>AB/IP</th></tr></thead>
      <tbody>
        ${allPlayers.map(p => {
          let statClass = "";
          if ((p.statType === "AB" && p.careerStat >= 200) || (p.statType === "IP" && p.careerStat >= 50)) statClass = "stat-warning";
          return `<tr>
            <td><span class="player-name">${escapeHtml(p.name)}</span></td>
            <td class="player-year">${p.yearAcquired}</td>
            <td class="${statClass}">${p.careerStat} ${p.statType}</td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>
  `;
}


// --- Rendering: Shared Tables ---

function renderMajorsTable(players) {
  if (!players.length) return "<p style='color:var(--text-dim)'>No major league keepers</p>";
  players = [...players].sort((a, b) => lastName(a.name).localeCompare(lastName(b.name)));
  return `
    <table class="player-table">
      <thead>
        <tr><th>Player</th><th>${CURRENT_SEASON} $</th><th>Acquired</th><th>Expiry</th></tr>
      </thead>
      <tbody>
        ${players.map(p => {
          const cs = getContractStatus(p, CURRENT_SEASON);
          const expiry = CURRENT_SEASON + cs.yearsRemaining;
          return `
            <tr>
              <td><span class="player-name">${escapeHtml(p.name)}</span></td>
              <td class="player-price">$${p.price}</td>
              <td class="player-year">${p.yearAcquired}${p.fromMinors ? ' <span class="from-minors-tag">MiLB</span>' : ""}</td>
              <td><span class="contract-tag contract-${escapeHtml(cs.status)}">${expiry}</span></td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
  `;
}

function renderCallupsTable(players, teamId) {
  if (!players.length) return "";
  players = [...players].sort((a, b) => lastName(a.name).localeCompare(lastName(b.name)));
  // Send Down is available to the team's owner OR any commissioner, and only
  // shown when the player is still below the "must call up" threshold
  // (200 AB / 50 IP).
  const showSendDown = teamId && canEditTeam(teamId);
  const headerActionCol = showSendDown ? "<th></th>" : "";
  return `
    <table class="player-table">
      <thead><tr><th>Player</th><th>Drafted</th><th>Career Stats</th><th>Status</th>${headerActionCol}</tr></thead>
      <tbody>
        ${players.map(p => {
          const ms = getMinorLeagueContractStatus(p, CURRENT_SEASON);
          const statDisplay = `${p.careerStat}`;
          let statClass = "";
          if ((p.statType === "AB" && p.careerStat >= 200) || (p.statType === "IP" && p.careerStat >= 50)) statClass = "stat-warning";
          const belowThreshold = (p.statType === "AB" && p.careerStat < 200) || (p.statType === "IP" && p.careerStat < 50);
          const onEspnRoster = typeof isPlayerDroppedFromEspn === "function" ? !isPlayerDroppedFromEspn(p.name) : true;
          const actionCell = showSendDown ? `
            <td style="text-align:right">
              ${belowThreshold && onEspnRoster ? `<button class="trade-btn" onclick="sendDownPlayer('${escapeJsString(p.name)}','${escapeJsString(teamId)}')"
                style="font-size:0.72rem;padding:3px 8px;background:var(--orange);color:#fff">Send Down</button>` : ""}
            </td>` : "";
          return `
            <tr>
              <td><span class="player-name">${escapeHtml(p.name)}</span></td>
              <td class="player-year">${p.yearAcquired}</td>
              <td class="${statClass}">${statDisplay}</td>
              <td><span style="color:var(--text-dim);font-size:0.8rem">${formatCallupStatus(p, ms)}</span></td>
              ${actionCell}
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
  `;
}

let _espnRosterNameCache = null;
function isPlayerDroppedFromEspn(playerName) {
  if (_espnRosterNameCache === null) {
    const snap = getEspnSnapshot();
    if (!snap) { _espnRosterNameCache = false; return false; }
    _espnRosterNameCache = new Set(snap.teams.flatMap(t => t.roster.map(r => r.name)));
  }
  if (_espnRosterNameCache === false) return false;
  return !_espnRosterNameCache.has(playerName);
}

function formatCallupStatus(player, ms) {
  if (player.dropped || isPlayerDroppedFromEspn(player.name)) {
    // Distinguish a fresh app-side call-up that hasn't synced to ESPN yet
    // (ESPN sync runs every 15min; commish may take longer to mirror the move
    // on the ESPN side) from a real drop. If the app's roster_moves table has
    // a callup for this player in the past 24h, show "Call Up Pending".
    const moves = (typeof dbGetRosterMoves === "function") ? dbGetRosterMoves() : [];
    const recent = moves.find(m =>
      m && m.kind === "callup" && m.player_name === player.name &&
      m.at && (Date.now() - new Date(m.at).getTime()) < 24 * 60 * 60 * 1000
    );
    return recent ? "Call Up Pending" : "Dropped";
  }
  const priceStr = (player.price !== undefined && player.price !== null) ? `$${player.price}` : "$TBD";
  if (ms.yearsRemaining !== null) {
    const yrs = ms.yearsRemaining;
    if (yrs === 0) return `Expires in ${CURRENT_SEASON}`;
    return `${yrs} yr${yrs === 1 ? "" : "s"} left, ${priceStr}`;
  }
  return `${ms.contractNote}, ${priceStr}`;
}

function renderMinorsTable(players, teamId) {
  if (!players.length) return "<p style='color:var(--text-dim)'>No minor league players</p>";
  players = [...players].sort((a, b) => lastName(a.name).localeCompare(lastName(b.name)));
  // Call Up is available to the team's owner OR any commissioner. RLS on
  // roster_moves enforces the same rule server-side.
  const showCallUp = teamId && canEditTeam(teamId);
  const headerActionCol = showCallUp ? "<th></th>" : "";
  return `
    <table class="player-table">
      <thead><tr><th>Player</th><th>Drafted</th><th>Career Stats</th><th>Expiry</th><th>Status</th>${headerActionCol}</tr></thead>
      <tbody>
        ${players.map(p => {
          const ms = getMinorLeagueContractStatus(p, CURRENT_SEASON);
          const statDisplay = `${p.careerStat}`;
          let statClass = "";
          if ((p.statType === "AB" && p.careerStat >= 200) || (p.statType === "IP" && p.careerStat >= 50)) statClass = "stat-warning";
          const actionCell = showCallUp ? `
            <td style="text-align:right">
              <button class="trade-btn" onclick="callUpMinorPlayer('${escapeJsString(p.name)}','${escapeJsString(teamId)}')"
                style="font-size:0.72rem;padding:3px 8px;background:var(--purple);color:#fff">Call Up</button>
            </td>` : "";
          const milTag = (() => {
            if (ms.yearsRemaining === null) {
              return ms.contractNote
                ? `<span class="contract-tag contract-new">${escapeHtml(ms.contractNote)}</span>`
                : '<span style="color:var(--text-dim);font-size:0.8rem">—</span>';
            }
            const yrs = ms.yearsRemaining;
            const cls = yrs === 0 ? "final" : yrs === 1 ? "expiring" : "mid";
            return `<span class="contract-tag contract-${cls}">${CURRENT_SEASON + yrs}</span>`;
          })();
          return `
            <tr>
              <td><span class="player-name">${escapeHtml(p.name)}</span>${p.sendDownCount ? ` <span style="color:var(--red);font-size:0.65rem;font-weight:700">$${p.sendDownCount * 10} fee</span>` : ''}</td>
              <td class="player-year">${p.yearAcquired}</td>
              <td class="${statClass}">${statDisplay}</td>
              <td>${milTag}</td>
              <td>${
                p._teamStatus === "dropped" ? '<span style="color:var(--orange);font-size:0.8rem">Dropped</span>' :
                p._teamStatus === "traded"  ? '<span style="color:var(--accent);font-size:0.8rem">Traded</span>' :
                ms.eligibilityWarning ? `<span class="hide-on-mobile" style="color:var(--orange);font-size:0.8rem">${ms.eligibilityWarning}</span>` :
                '<span style="color:var(--green);font-size:0.8rem">Active</span>'
              }</td>
              ${actionCell}
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
  `;
}


// --- Rendering: Overview Tab ---

function renderLeagueOverview() {
  const teams = [...LEAGUE_DATA.teams].sort((a, b) => b.totalKeeperCost - a.totalKeeperCost);
  return `
    <table class="league-table">
      <thead>
        <tr><th>Team</th><th>Keeper $</th><th>Draft $</th><th>Keepers</th><th>Call-ups</th><th>Minors</th><th>Total</th></tr>
      </thead>
      <tbody>
        ${teams.map(t => `
          <tr>
            <td><span class="team-link" onclick="showTeamKeepers('${t.id}')">${t.name}</span></td>
            <td class="player-price">$${t.totalKeeperCost}</td>
            <td style="color:var(--accent);font-weight:600">$${t.draftBudget}</td>
            <td>${t.majors.length}</td>
            <td>${t.callups.length || "—"}</td>
            <td>${t.minors.length}</td>
            <td>${t.majors.length + t.callups.length + t.minors.length}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}


// --- Rendering: Keeper Calculator ---

function renderKeeperCalculator() {
  return `
    <div class="calc-team-selector">
      <select id="calc-team-select" onchange="updateKeeperCalc()">
        <option value="">Select a team...</option>
        ${getDisplayOrderedTeams().map(t => `<option value="${t.id}">${t.name}</option>`).join("")}
      </select>
    </div>
    <div id="calc-results"></div>
  `;
}

function updateKeeperCalc() {
  const teamId = document.getElementById("calc-team-select").value;
  const container = document.getElementById("calc-results");
  if (!teamId) { container.innerHTML = ""; return; }

  const team = LEAGUE_DATA.teams.find(t => t.id === teamId);

  const keepableNextYear = team.majors
    .map(p => ({ ...p, contract: getContractStatus(p, CURRENT_SEASON) }))
    .filter(p => p.contract.canKeepNextYear)
    .sort((a, b) => a.contract.nextYearPrice - b.contract.nextYearPrice);

  const notKeepable = team.majors
    .map(p => ({ ...p, contract: getContractStatus(p, CURRENT_SEASON) }))
    .filter(p => !p.contract.canKeepNextYear);

  const NEXT_SEASON = CURRENT_SEASON + 1;
  container.innerHTML = `
    <div class="keeper-projection">
      <h3>Can Keep for ${NEXT_SEASON} (${keepableNextYear.length} players)</h3>
      ${keepableNextYear.length ? `
        <table class="player-table">
          <thead><tr><th>Player</th><th>${CURRENT_SEASON} Price</th><th>${NEXT_SEASON} Price</th><th>Expiry</th></tr></thead>
          <tbody>
            ${keepableNextYear.map(p => `
              <tr>
                <td><span class="player-name">${escapeHtml(p.name)}</span>${p.fromMinors ? '<span class="from-minors-tag">MiLB</span>' : ""}</td>
                <td class="player-price">$${p.price}</td>
                <td style="color:var(--yellow);font-weight:700">$${p.contract.nextYearPrice}</td>
                <td><span class="contract-tag contract-${p.contract.yearsRemaining === 1 ? 'expiring' : 'mid'}">${CURRENT_SEASON + p.contract.yearsRemaining}</span></td>
              </tr>
            `).join("")}
          </tbody>
        </table>
        <div style="margin-top:10px;padding:10px;background:var(--bg);border-radius:6px">
          <span style="color:var(--text-dim);font-size:0.82rem">Projected ${NEXT_SEASON} keeper cost (all eligible):</span>
          <span style="color:var(--yellow);font-weight:800;font-size:1.05rem"> $${keepableNextYear.reduce((s, p) => s + p.contract.nextYearPrice, 0)}</span>
          <span style="color:var(--text-dim);font-size:0.82rem"> / Draft budget:</span>
          <span style="color:var(--accent);font-weight:800;font-size:1.05rem"> $${260 - keepableNextYear.reduce((s, p) => s + p.contract.nextYearPrice, 0)}</span>
        </div>
      ` : "<p style='color:var(--text-dim)'>No players eligible to keep</p>"}
    </div>
    ${notKeepable.length ? `
      <div class="keeper-projection">
        <h3 style="color:var(--red)">Cannot Keep for ${NEXT_SEASON} (${notKeepable.length} players)</h3>
        <table class="player-table">
          <thead><tr><th>Player</th><th>${CURRENT_SEASON} Price</th><th>Reason</th></tr></thead>
          <tbody>
            ${notKeepable.map(p => `
              <tr>
                <td><span class="player-name">${escapeHtml(p.name)}</span></td>
                <td class="player-price">$${p.price}</td>
                <td><span class="contract-tag contract-final">Contract Expired</span></td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    ` : ""}
  `;
}


// --- Rendering: Trades Tab ---

function getTrades() {
  if (typeof dbGetTrades === "function") return dbGetTrades();
  try { return JSON.parse(localStorage.getItem("flm_trades") || "[]"); }
  catch { return []; }
}

// Legacy. New code path goes through addTradeAsync / deleteTradeAsync.
function saveTrades(trades) {
  localStorage.setItem("flm_trades", JSON.stringify(trades));
}

function renderTradeLogView() {
  const trades = getTrades();
  const commish = isCommissioner();
  const newTradeBtn = commish
    ? `<button class="trade-btn" onclick="showTradeForm()">New Trade</button>`
    : `<div style="color:var(--text-dim);font-size:0.82rem;font-style:italic">Managers: use Trade Inbox to propose trades. Only commissioners record final trades directly here.</div>`;
  return `
    <div style="display:flex;gap:10px;margin-bottom:16px;align-items:center">
      ${newTradeBtn}
    </div>
    <div id="trade-form-container"></div>
    <div class="section-header">Trade Log <span class="section-count">${trades.length}</span></div>
    <div id="trade-log">
      ${trades.length ? trades.slice().reverse().map((t, i) => renderTradeCard(t, trades.length - 1 - i)).join("") : '<p style="color:var(--text-dim)">No trades recorded yet.</p>'}
    </div>
  `;
}

// Combined Trades tab with sub-tabs: Block / Inbox / Log. Sub-tab choice is
// kept in module-level state so navigating away and back lands on the same
// view.
let _tradesSubTab = "inbox";
function setTradesSubTab(name) {
  _tradesSubTab = name;
  renderTradesShell();
  // Keep the parent "Trades" tab badge in sync — opening the inbox sub-tab
  // (and reading threads from there) marks them read in localStorage, but
  // the badge only re-paints when we explicitly call renderHeaderUser.
  if (typeof renderHeaderUser === "function") renderHeaderUser();
}
// Convenience for places that used to switchTab("trade-inbox") etc.
function goToTrades(sub) {
  _tradesSubTab = sub || _tradesSubTab;
  if (typeof switchTab === "function") switchTab("trades");
}
function renderTradesShell() {
  const content = document.getElementById("trades-tab-content");
  if (!content) return;
  document.querySelectorAll(".trades-subnav-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.sub === _tradesSubTab);
  });
  if (_tradesSubTab === "block") content.innerHTML = renderTradeBlockView();
  else if (_tradesSubTab === "log") content.innerHTML = renderTradeLogView();
  else content.innerHTML = renderTradeInboxView();
}
function renderTradesContainer() {
  const u = (typeof dbGetUnreadCounts === "function") ? dbGetUnreadCounts() : { total: 0 };
  const unreadBadge = u.total > 0
    ? ` <span style="color:var(--red);font-weight:800;margin-left:2px">(${u.total})</span>`
    : "";
  return `
    <div class="trades-subnav" style="display:flex;gap:6px;margin-bottom:14px;border-bottom:1px solid var(--border);padding-bottom:0">
      <button class="trades-subnav-btn" data-sub="block" onclick="setTradesSubTab('block')" style="background:none;border:none;border-bottom:3px solid transparent;color:var(--text-dim);padding:8px 14px;cursor:pointer;font-size:0.88rem;font-weight:600">Trade Block</button>
      <button class="trades-subnav-btn" data-sub="inbox" onclick="setTradesSubTab('inbox')" style="background:none;border:none;border-bottom:3px solid transparent;color:var(--text-dim);padding:8px 14px;cursor:pointer;font-size:0.88rem;font-weight:600">Trade Inbox${unreadBadge}</button>
      <button class="trades-subnav-btn" data-sub="log" onclick="setTradesSubTab('log')" style="background:none;border:none;border-bottom:3px solid transparent;color:var(--text-dim);padding:8px 14px;cursor:pointer;font-size:0.88rem;font-weight:600">Trade Log</button>
    </div>
    <div id="trades-tab-content"></div>
  `;
}

function renderTradeBlockView() {
  const sel = (typeof dbGetKeeperSelections === "function") ? dbGetKeeperSelections() : {};
  const byTeam = {};
  for (const teamId of Object.keys(sel)) {
    const blocked = Object.keys(sel[teamId] || {}).filter(name => sel[teamId][name]?.tradeBlock);
    if (blocked.length) byTeam[teamId] = blocked.sort((a, b) => lastName(a).localeCompare(lastName(b)));
  }
  const myTeamId = (typeof currentOwner !== "undefined" && currentOwner) ? currentOwner.team_id : null;
  // Always include the manager's own team in the grid (even with no blocked
  // players) so they have a clear path to edit their trade block.
  if (myTeamId && !byTeam[myTeamId]) byTeam[myTeamId] = [];
  const orderedTeams = getDisplayOrderedTeams().filter(t => byTeam[t.id]);
  if (!orderedTeams.length) {
    return `
      <div style="max-width:540px;margin:40px auto;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:24px;text-align:center;color:var(--text-dim);font-size:0.9rem">
        Nothing on the trade block right now.
        <div style="font-size:0.78rem;margin-top:8px">Players appear here when an owner toggles "On the Block" in Eligible Keepers.</div>
      </div>
    `;
  }
  return `
    <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(300px, 1fr));gap:14px">
      ${orderedTeams.map(t => {
        // Build the price map from the team's full reconciled roster (ESPN
        // snapshot + cost-basis resolution), not just the static majors list.
        // That's what catches auction/FA pickups + callups Jo Adell-style.
        const eligible = (typeof getEligiblePlayers === "function") ? getEligiblePlayers(t) : [];
        const priceMap = Object.fromEntries(eligible.map(p => [p.name, p.price]));
        const isMyTeam = t.id === myTeamId;
        const action = isMyTeam
          ? `<button class="trade-btn trade-btn-cancel" onclick="editMyTradeBlock()" style="font-size:0.78rem;padding:6px 14px;margin-top:12px">Edit my trade block</button>`
          : (myTeamId
              ? `<button class="trade-btn" onclick="proposeTradeWith('${escapeJsString(t.id)}')" style="font-size:0.78rem;padding:6px 14px;margin-top:12px">Propose Trade</button>`
              : "");
        const blockedHtml = byTeam[t.id].length
          ? byTeam[t.id].map(name => {
              const price = priceMap[name];
              const priceStr = price !== undefined ? ` $${price}` : "";
              return `<span style="font-size:0.78rem;background:rgba(249,115,22,0.15);color:var(--orange);padding:3px 9px;border-radius:10px;white-space:nowrap">${escapeHtml(name)}${priceStr}</span>`;
            }).join("")
          : `<span style="color:var(--text-dim);font-size:0.78rem;font-style:italic">No players on the block.</span>`;
        return `
          <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:14px">
            <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
              <span style="color:var(--text-bright);font-weight:700">${escapeHtml(t.name)}${isMyTeam ? '<span style="color:var(--text-dim);font-weight:500;font-size:0.78rem"> (you)</span>' : ''}</span>
              <span style="color:var(--text-dim);font-size:0.75rem">${byTeam[t.id].length} player${byTeam[t.id].length === 1 ? "" : "s"}</span>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:5px">
              ${blockedHtml}
            </div>
            ${action}
          </div>
        `;
      }).join("")}
    </div>
  `;
}

// Land on the manager's own team in Eligible Keepers (not the "All Teams"
// summary, which is what a fresh switchTab("eligible") would show).
function editMyTradeBlock() {
  const myTeamId = (typeof currentOwner !== "undefined" && currentOwner) ? currentOwner.team_id : null;
  if (myTeamId && typeof _lastTeamSel !== "undefined") {
    _lastTeamSel.eligible = myTeamId;
  }
  if (typeof switchTab === "function") switchTab("eligible");
}

function proposeTradeWith(otherTeamId) {
  showProposalComposer({ targetTeamId: otherTeamId });
}

// --- Trade Inbox UI ---

let _formMode = null; // null = normal trade; { kind: "proposal", counterOf? } in composer

function relativeTime(ts) {
  const ms = Date.now() - (typeof ts === "number" ? ts : new Date(ts).getTime());
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

// Display a timestamp as relative-time text with the full local date+time as
// a hover tooltip. Used everywhere a time appears in the UI so the format is
// consistent: "2h ago" (with "Wed May 8, 2026, 9:43 PM" on hover).
function timestampHTML(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const abs = d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  return `<span title="${escapeHtml(abs)}">${escapeHtml(relativeTime(ts))}</span>`;
}

function renderTradeInboxView() {
  if (typeof currentOwner === "undefined" || !currentOwner) {
    return '<p style="color:var(--text-dim)">Sign in to see your trade inbox.</p>';
  }
  const myTeam = currentOwner.team_id;
  const threads = (typeof dbGetThreads === "function") ? dbGetThreads() : [];
  const newButton = `
    <div style="margin-bottom:14px">
      <button class="trade-btn" onclick="showProposalComposer({})">New Proposal</button>
    </div>
  `;
  const inbox = [], sent = [], past = [];
  for (const t of threads) {
    const latest = t.latestProposal;
    const wasParty = t.proposals.some(p => p.from_team_id === myTeam || p.to_team_id === myTeam);
    if (!wasParty && !isCommissioner()) continue;
    if (latest.status === "pending") {
      if (latest.to_team_id === myTeam) inbox.push(t);
      else if (latest.from_team_id === myTeam) sent.push(t);
      else past.push(t); // commissioner viewing
    } else {
      past.push(t);
    }
  }
  const renderSection = (title, list, emptyMsg) => {
    if (!list.length) return `
      <div class="section-header">${title}</div>
      <div style="color:var(--text-dim);font-size:0.85rem;margin:6px 0 18px;font-style:italic">${emptyMsg}</div>
    `;
    return `
      <div class="section-header">${title} <span class="section-count">${list.length}</span></div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:18px">
        ${list.map(t => renderThreadCard(t)).join("")}
      </div>
    `;
  };
  return `
    ${newButton}
    ${renderSection("Inbox", inbox, "No incoming proposals.")}
    ${renderSection("Sent", sent, "No sent proposals awaiting response.")}
    ${past.length ? renderSection("Past", past, "") : ""}
  `;
}

function renderThreadCard(thread) {
  const myTeam = currentOwner.team_id;
  const latest = thread.latestProposal;
  const counterId = (latest.from_team_id === myTeam) ? latest.to_team_id : latest.from_team_id;
  const counterTeam = LEAGUE_DATA.teams.find(t => t.id === counterId);
  const counterName = counterTeam ? counterTeam.name : counterId;
  const isUnread = (typeof dbThreadHasUnread === "function") ? dbThreadHasUnread(thread) : (!dbIsThreadRead(thread.threadId) && latest.status === "pending" && latest.to_team_id === myTeam);
  const iAmFrom = latest.from_team_id === myTeam;
  const iGet  = iAmFrom ? (latest.team1_receives || []) : (latest.team2_receives || []);
  const iGive = iAmFrom ? (latest.team2_receives || []) : (latest.team1_receives || []);
  const statusColors = {
    pending: "var(--accent)", accepted: "var(--green)", rejected: "var(--red)",
    withdrawn: "var(--text-dim)", countered: "var(--yellow)",
  };
  const statusBg = statusColors[latest.status] || "var(--text-dim)";
  const fmt = (assets) => (!assets || !assets.length)
    ? '<span style="color:var(--text-dim)">Nothing</span>'
    : assets.map(formatTradeAsset).join(", ");
  return `
    <div onclick="openThreadDetail('${escapeJsString(thread.threadId)}')"
         style="background:var(--bg-card);border:1px solid ${isUnread ? 'var(--accent)' : 'var(--border)'};border-left:3px solid ${statusBg};border-radius:var(--radius);padding:12px 14px;cursor:pointer">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
        <div style="font-size:0.92rem;color:var(--text-bright)">
          <strong>${escapeHtml(counterName)}</strong>
          ${isUnread ? '<span style="background:var(--accent);color:#fff;font-size:0.62rem;padding:1px 6px;border-radius:8px;margin-left:6px;text-transform:uppercase;letter-spacing:0.04em">new</span>' : ''}
        </div>
        <div style="display:flex;gap:10px;align-items:baseline">
          ${thread.messages.length ? `<span style="color:var(--text-dim);font-size:0.72rem">${thread.messages.length} msg${thread.messages.length === 1 ? "" : "s"}</span>` : ""}
          <span style="color:${statusBg};font-size:0.7rem;text-transform:uppercase;letter-spacing:0.04em;font-weight:700">${escapeHtml(formatProposalStatus(latest.status))}</span>
          <span style="color:var(--text-dim);font-size:0.72rem">${timestampHTML(thread.lastActivityAt)}</span>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:0.82rem">
        <div>
          <div style="color:var(--text-dim);font-size:0.7rem;text-transform:uppercase;margin-bottom:2px">You get</div>
          <div style="color:var(--text)">${fmt(iGet)}</div>
        </div>
        <div>
          <div style="color:var(--text-dim);font-size:0.7rem;text-transform:uppercase;margin-bottom:2px">You give</div>
          <div style="color:var(--text)">${fmt(iGive)}</div>
        </div>
      </div>
    </div>
  `;
}

function openThreadDetail(threadId) {
  if (typeof dbMarkThreadRead === "function") dbMarkThreadRead(threadId);
  if (typeof renderHeaderUser === "function") renderHeaderUser();
  if (typeof currentView !== "undefined" && currentView === "trades" && _tradesSubTab === "inbox") {
    // Re-render in background so the unread badge clears immediately.
    renderTradesShell();
  }
  const thread = (typeof dbGetThreads === "function" ? dbGetThreads() : []).find(t => t.threadId === threadId);
  if (!thread) return;
  const existing = document.getElementById("thread-detail-modal");
  if (existing) existing.remove();
  const modal = document.createElement("div");
  modal.id = "thread-detail-modal";
  modal.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:1000;display:flex;align-items:flex-start;justify-content:center;padding:24px 16px;overflow-y:auto";
  modal.onclick = e => { if (e.target === modal) closeThreadDetail(); };
  modal.innerHTML = renderThreadDetailHTML(thread);
  document.body.appendChild(modal);
  // Don't auto-focus on touch devices — pops the keyboard immediately and
  // the modal scrolls in unexpected ways. Mouse users still get focus.
  if (window.matchMedia?.("(pointer: fine)").matches) {
    setTimeout(() => document.getElementById("thread-msg-input")?.focus(), 0);
  }
  // When the input gets focused (keyboard appears), scroll the input bar
  // into the visible area inside the modal so it sits above the keyboard.
  const inputEl = document.getElementById("thread-msg-input");
  if (inputEl) {
    inputEl.addEventListener("focus", () => {
      setTimeout(() => inputEl.scrollIntoView({ block: "center", behavior: "smooth" }), 200);
    });
  }
}

function closeThreadDetail() {
  const m = document.getElementById("thread-detail-modal");
  if (m) m.remove();
}

function renderThreadDetailHTML(thread) {
  const myTeam = currentOwner.team_id;
  const latest = thread.latestProposal;
  const isPending = latest.status === "pending";
  const iAmFrom = latest.from_team_id === myTeam;
  const iAmTo   = latest.to_team_id   === myTeam;
  const iGet  = iAmFrom ? (latest.team1_receives || []) : (latest.team2_receives || []);
  const iGive = iAmFrom ? (latest.team2_receives || []) : (latest.team1_receives || []);
  const counterId = iAmFrom ? latest.to_team_id : latest.from_team_id;
  const counterTeam = LEAGUE_DATA.teams.find(t => t.id === counterId);
  const counterName = counterTeam ? counterTeam.name : counterId;
  const fmt = (assets) => (!assets || !assets.length)
    ? '<span style="color:var(--text-dim)">Nothing</span>'
    : assets.map(formatTradeAsset).join(", ");
  let actions = "";
  if (isPending) {
    if (iAmTo) {
      actions = `
        <button class="trade-btn trade-btn-submit" onclick="acceptThreadProposal('${escapeJsString(latest.id)}')">Accept</button>
        <button class="trade-btn" style="background:var(--yellow);color:#000" onclick="openCounterComposer('${escapeJsString(latest.id)}')">Counter</button>
        <button class="trade-btn" style="background:var(--red)" onclick="rejectThreadProposal('${escapeJsString(latest.id)}')">Reject</button>
      `;
    } else if (iAmFrom) {
      actions = `<button class="trade-btn" style="background:var(--text-dim);color:#000" onclick="withdrawThreadProposal('${escapeJsString(latest.id)}')">Withdraw</button>`;
    }
  }
  const proposalHistory = thread.proposals.length > 1 ? `
    <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border)">
      <div style="color:var(--text-dim);font-size:0.7rem;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px">History</div>
      ${thread.proposals.slice(0, -1).map(p => {
        const fromTeam = LEAGUE_DATA.teams.find(t => t.id === p.from_team_id);
        return `<div style="font-size:0.78rem;color:var(--text-dim);margin-bottom:4px">
          ${escapeHtml(fromTeam ? fromTeam.name : p.from_team_id)} proposed${p.status === "pending" ? "" : ` (${escapeHtml(formatProposalStatus(p.status))})`} — ${timestampHTML(p.created_at)}
        </div>`;
      }).join("")}
    </div>
  ` : "";
  const messages = thread.messages.map(m => {
    const fromTeam = LEAGUE_DATA.teams.find(t => t.id === m.from_team_id);
    const isMe = m.from_team_id === myTeam;
    return `
      <div style="display:flex;${isMe ? 'justify-content:flex-end' : 'justify-content:flex-start'};margin-bottom:6px">
        <div style="max-width:80%;background:${isMe ? 'var(--accent)' : 'var(--bg)'};color:${isMe ? '#fff' : 'var(--text)'};padding:7px 11px;border-radius:12px;font-size:0.85rem">
          ${!isMe ? `<div style="font-size:0.7rem;color:var(--text-dim);margin-bottom:2px">${escapeHtml(fromTeam ? fromTeam.name : m.from_team_id)}</div>` : ""}
          <div>${escapeHtml(m.body)}</div>
          <div style="font-size:0.65rem;color:${isMe ? 'rgba(255,255,255,0.6)' : 'var(--text-dim)'};margin-top:2px">${timestampHTML(m.created_at)}</div>
        </div>
      </div>
    `;
  }).join("");
  return `
    <div style="max-width:640px;width:100%;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);padding:18px;margin-top:20px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px">
        <div>
          <h3 style="margin:0;color:var(--text-bright)">Trade with ${escapeHtml(counterName)}</h3>
          <div style="color:var(--text-dim);font-size:0.78rem;margin-top:2px">Status: <strong>${escapeHtml(formatProposalStatus(latest.status))}</strong></div>
        </div>
        <button onclick="closeThreadDetail()" style="background:none;border:none;color:var(--text-dim);font-size:1.4rem;cursor:pointer;padding:0 4px;line-height:1">×</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;background:var(--bg);padding:12px;border-radius:6px;margin-bottom:14px">
        <div>
          <div style="color:var(--text-dim);font-size:0.72rem;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:4px">You get</div>
          <div style="color:var(--text);font-size:0.9rem">${fmt(iGet)}</div>
        </div>
        <div>
          <div style="color:var(--text-dim);font-size:0.72rem;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:4px">You give</div>
          <div style="color:var(--text);font-size:0.9rem">${fmt(iGive)}</div>
        </div>
      </div>
      ${latest.notes ? `<div style="background:var(--bg);padding:10px;border-radius:6px;font-size:0.85rem;color:var(--text);margin-bottom:14px"><span style="color:var(--text-dim);font-size:0.72rem;text-transform:uppercase">Notes</span><br>${escapeHtml(latest.notes)}</div>` : ""}
      ${actions ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">${actions}</div>` : ""}
      ${proposalHistory}
      <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border)">
        <div style="color:var(--text-dim);font-size:0.7rem;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:8px">Messages</div>
        <div id="thread-messages" style="max-height:240px;overflow-y:auto;margin-bottom:10px">
          ${messages || '<div style="color:var(--text-dim);font-size:0.82rem;font-style:italic">No messages yet.</div>'}
        </div>
        <div style="display:flex;gap:6px">
          <input type="text" id="thread-msg-input" placeholder="Send a message..."
            style="flex:1;background:var(--bg);color:var(--text);border:1px solid var(--border);padding:8px 10px;border-radius:6px;font-size:0.85rem"
            onkeydown="if(event.key==='Enter'){event.preventDefault();sendThreadMessage('${escapeJsString(thread.threadId)}');}">
          <button class="trade-btn" onclick="sendThreadMessage('${escapeJsString(thread.threadId)}')">Send</button>
        </div>
      </div>
    </div>
  `;
}

async function sendThreadMessage(threadId) {
  const input = document.getElementById("thread-msg-input");
  if (!input) return;
  const body = input.value.trim();
  if (!body) return;
  input.disabled = true;
  try {
    await sendProposalMessageAsync(threadId, body);
    input.value = "";
    const thread = (dbGetThreads() || []).find(t => t.threadId === threadId);
    if (thread) {
      const modal = document.getElementById("thread-detail-modal");
      if (modal) modal.innerHTML = renderThreadDetailHTML(thread);
      // Re-focus only on devices with a fine pointer; touch users keep their keyboard up.
      if (window.matchMedia?.("(pointer: fine)").matches) {
        setTimeout(() => document.getElementById("thread-msg-input")?.focus(), 0);
      }
    }
  } catch (e) {
    alert("Couldn't send message: " + (e.message || e));
  } finally {
    input.disabled = false;
  }
}

async function acceptThreadProposal(proposalId) {
  const proposal = (dbGetProposals() || []).find(p => p.id === proposalId);
  if (!proposal) return;
  if (!confirm("Accept this trade? It will be recorded in the Trade Log.")) return;
  try {
    const acceptedTrade = await acceptProposalAsync(proposal);
    if (typeof logActivityAsync === "function") {
      logActivityAsync("trade_recorded", {
        trade_id: acceptedTrade?._id,
        team1: proposal.from_team_id, team2: proposal.to_team_id,
        team1_receives: proposal.team1_receives,
        team2_receives: proposal.team2_receives,
      }, { targetTeamId: proposal.from_team_id });
    }
    closeThreadDetail();
    if (typeof goToTrades === "function") goToTrades("inbox");
  } catch (e) {
    alert("Couldn't accept: " + (e.message || e));
  }
}

async function rejectThreadProposal(proposalId) {
  if (!confirm("Reject this proposal?")) return;
  try {
    await setProposalStatusAsync(proposalId, "rejected");
    closeThreadDetail();
    if (typeof goToTrades === "function") goToTrades("inbox");
  } catch (e) { alert("Couldn't reject: " + (e.message || e)); }
}

async function withdrawThreadProposal(proposalId) {
  if (!confirm("Withdraw this proposal?")) return;
  try {
    await setProposalStatusAsync(proposalId, "withdrawn");
    closeThreadDetail();
    if (typeof goToTrades === "function") goToTrades("inbox");
  } catch (e) { alert("Couldn't withdraw: " + (e.message || e)); }
}

function openCounterComposer(parentProposalId) {
  const proposal = (dbGetProposals() || []).find(p => p.id === parentProposalId);
  if (!proposal) return;
  closeThreadDetail();
  showProposalComposer({ counterOf: proposal });
}

function showProposalComposer(opts) {
  opts = opts || {};
  if (!currentOwner) { alert("Sign in to propose a trade."); return; }
  const myTeamId = currentOwner.team_id;
  const counterOf = opts.counterOf || null;
  const targetTeamId = opts.targetTeamId || (counterOf
    ? (counterOf.to_team_id === myTeamId ? counterOf.from_team_id : counterOf.to_team_id)
    : null);
  const existing = document.getElementById("proposal-composer-modal");
  if (existing) existing.remove();
  const modal = document.createElement("div");
  modal.id = "proposal-composer-modal";
  modal.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:1000;display:flex;align-items:flex-start;justify-content:center;padding:24px 16px;overflow-y:auto";
  modal.onclick = e => { if (e.target === modal) closeProposalComposer(); };
  modal.innerHTML = `
    <div style="max-width:780px;width:100%;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:18px;margin-top:20px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
        <h3 style="margin:0;color:var(--text-bright)">${counterOf ? "Counter Proposal" : "Propose Trade"}</h3>
        <button onclick="closeProposalComposer()" style="background:none;border:none;color:var(--text-dim);font-size:1.4rem;cursor:pointer;padding:0 4px;line-height:1">×</button>
      </div>
      <div id="trade-form-container"></div>
    </div>
  `;
  document.body.appendChild(modal);
  _formMode = { kind: "proposal", counterOf };
  showTradeForm(myTeamId, targetTeamId);
  // Lock the proposer's team — you can only propose from your own team.
  const sel1 = document.getElementById("trade-team1");
  if (sel1) sel1.disabled = true;
  // Counter: pre-fill the assets and notes from the parent.
  if (counterOf) {
    tradeAssets.t1 = JSON.parse(JSON.stringify(counterOf.team1_receives || []));
    tradeAssets.t2 = JSON.parse(JSON.stringify(counterOf.team2_receives || []));
    tradeAssets.teamIds.t1 = myTeamId;
    tradeAssets.teamIds.t2 = targetTeamId;
    if (typeof renderAssetList === "function") {
      renderAssetList("t1");
      renderAssetList("t2");
    }
    const notesEl = document.getElementById("trade-notes");
    if (notesEl) notesEl.value = counterOf.notes || "";
  }
  // Relabel the submit button.
  const submitBtn = modal.querySelector(".trade-btn-submit");
  if (submitBtn) submitBtn.textContent = counterOf ? "Send Counter" : "Send Proposal";
}

function closeProposalComposer() {
  _formMode = null;
  const m = document.getElementById("proposal-composer-modal");
  if (m) m.remove();
}

async function submitProposal() {
  const myTeamId = currentOwner.team_id;
  const team2 = document.getElementById("trade-team2").value;
  if (!team2) { alert("Select a recipient team"); return; }
  if (team2 === myTeamId) { alert("Choose a different team"); return; }
  if (!tradeAssets.t1.length && !tradeAssets.t2.length) { alert("Add at least one asset"); return; }
  if (!tradeAssets.t1.length || !tradeAssets.t2.length) {
    if (!confirm("This proposal is one-sided — one team gets nothing. Send anyway?")) return;
  }
  const notes = document.getElementById("trade-notes")?.value || "";
  const team1_receives = [...tradeAssets.t2]; // what I get (came from the recipient's picker)
  const team2_receives = [...tradeAssets.t1]; // what they get (came from my picker)
  const counterOf = _formMode?.counterOf || null;
  try {
    if (counterOf) {
      await counterProposalAsync(counterOf, { team1_receives, team2_receives, notes });
    } else {
      await createProposalAsync({
        from_team_id: myTeamId, to_team_id: team2,
        team1_receives, team2_receives, notes,
      });
    }
    tradeAssets.t1 = []; tradeAssets.t2 = [];
    closeProposalComposer();
    if (typeof goToTrades === "function") goToTrades("inbox");
  } catch (e) {
    alert("Couldn't send proposal: " + (e.message || e));
  }
}

// --- Draft Dollars (trade-adjusted) ---

function parseDraftDollarsAmount(asset) {
  if (asset && asset.amount != null) return Number(asset.amount) || 0;
  // Legacy formats: "$10 draft dollars" or "10 draft dollars".
  const v = String(asset?.value || "");
  const m = v.match(/\$?\s*(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

function getDraftDollarBalances() {
  const balances = Object.fromEntries(LEAGUE_DATA.teams.map(t => [t.id, 260]));
  const trades = (typeof dbGetTrades === "function")
    ? dbGetTrades()
    : (() => { try { return JSON.parse(localStorage.getItem("flm_trades") || "[]"); } catch { return []; } })();
  for (const trade of trades) {
    const sides = [
      { receives: trade.team1Receives, fromTeam: trade.team2, toTeam: trade.team1 },
      { receives: trade.team2Receives, fromTeam: trade.team1, toTeam: trade.team2 }
    ];
    for (const side of sides) {
      for (const asset of (side.receives || [])) {
        if (asset.type !== "draft_dollars") continue;
        const amount = parseDraftDollarsAmount(asset);
        if (balances[side.toTeam] != null) balances[side.toTeam] += amount;
        if (balances[side.fromTeam] != null) balances[side.fromTeam] -= amount;
      }
    }
  }
  return balances;
}

// --- Financials tab ---
//
// Sections: Draft Dollars (moved from old Trade Log right rail), Luxury Tax
// (placeholder), League & Call Up Fees (new). Fees are computed from
// roster_moves: $10 per demote ("send down") + a flat $300 league fee.
// Paid status lives in league_state.fees_paid; commissioner-only writes.

const LEAGUE_FEE = 300;
const SEND_DOWN_FEE = 10;
const LUXURY_TAX_CAP = 350;

// Compute a team's total salary for luxury-tax purposes.
// Rules: keepers and auction picks count at their stored price; free agents
// count at $1; minor-league call-ups count at $0. Reads the current
// ESPN-reconciled roster.
function getTeamLuxurySalary(team) {
  const players = (typeof getEligiblePlayers === "function") ? getEligiblePlayers(team) : [];
  let total = 0;
  for (const p of players) {
    // Keeper-Price Exception always wins — the commissioner has set the
    // player's "true" salary explicitly, so use it regardless of contractType.
    if (p.priceExceptionApplied && typeof p.price === "number") {
      total += p.price;
    } else if (p.contractType === "callup" || p.contractType === "fa") {
      // Both free agents and minor-league call-ups count at $1 flat.
      total += 1;
    } else if (typeof p.price === "number") {
      total += p.price;
    }
  }
  return total;
}

function renderLuxuryTaxTable() {
  const rows = LEAGUE_DATA.teams.map(team => {
    const players = (typeof getEligiblePlayers === "function") ? getEligiblePlayers(team) : [];
    const breakdown = players.map(p => {
      const isFa = p.contractType === "fa";
      const isCallup = p.contractType === "callup";
      const hasOverride = p.priceExceptionApplied && typeof p.price === "number";
      const counted = hasOverride
        ? p.price
        : (isCallup || isFa) ? 1
        : (typeof p.price === "number" ? p.price : 0);
      // A player drafted in a prior season's auction and still on the roster
      // is a "keeper" for display purposes; only current-season auction picks
      // get the "auction" badge.
      const yearAcquired = p.yearAcquired;
      const isKeeper = p.contractType === "auction" && yearAcquired != null && yearAcquired < CURRENT_SEASON;
      return { name: p.name, type: p.contractType, isKeeper, hasOverride, price: p.price, counted };
    });
    const salary = breakdown.reduce((s, b) => s + b.counted, 0);
    const over = salary > LUXURY_TAX_CAP;
    const remaining = over ? 0 : (LUXURY_TAX_CAP - salary);
    const surplus = over ? (salary - LUXURY_TAX_CAP) : 0;
    return { team, salary, remaining, surplus, over, breakdown };
  });
  // Highest salary first so over-cap teams jump out.
  rows.sort((a, b) => b.salary - a.salary);
  return `
    <div style="max-width:760px">
      <table class="player-table" style="font-size:0.88rem;width:100%;table-layout:fixed">
        <colgroup>
          <col style="width:140px">
          <col style="width:80px">
          <col style="width:100px">
          <col style="width:90px">
          <col style="width:90px">
        </colgroup>
        <thead>
          <tr>
            <th>Team</th>
            <th style="text-align:right">Players</th>
            <th style="text-align:right">Salary</th>
            <th style="text-align:right">Remaining</th>
            <th style="text-align:right">Surplus</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => {
            const breakdownRows = r.breakdown
              .slice()
              .sort((a, b) => b.counted - a.counted)
              .map(b => {
                const note = b.type === "fa" ? "FA"
                  : b.type === "callup" ? "call-up"
                  : b.isKeeper ? "keeper"
                  : "auction";
                const noteHtml = `<span style="color:var(--text-dim);font-size:0.72rem">${escapeHtml(note)}</span>`;
                return `<tr>
                  <td style="padding:3px 8px;color:var(--text)">${escapeHtml(b.name)}</td>
                  <td style="padding:3px 8px">${noteHtml}</td>
                  <td style="padding:3px 8px;text-align:right;color:var(--text-bright);font-weight:600">$${b.counted}</td>
                </tr>`;
              }).join("");
            return `
              <tr>
                <td style="padding:8px 10px">
                  <details>
                    <summary style="cursor:pointer;list-style:none">
                      <span style="font-weight:700;color:var(--text-bright)">${escapeHtml(r.team.name)}</span>
                      <span style="color:var(--text-dim);font-size:0.7rem;margin-left:6px">▶ show players</span>
                    </summary>
                    <div style="margin-top:6px;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:4px 0">
                      <table style="width:100%;border-collapse:collapse;font-size:0.78rem">
                        <tbody>${breakdownRows}</tbody>
                      </table>
                    </div>
                  </details>
                </td>
                <td style="text-align:right;padding:8px 6px;color:var(--text-dim)">${r.breakdown.length}</td>
                <td style="text-align:right;padding:8px 6px;color:${r.over ? 'var(--red)' : 'var(--text)'};font-weight:${r.over ? '700' : '400'}">$${r.salary}</td>
                <td style="text-align:right;padding:8px 6px;color:${r.remaining > 0 ? 'var(--green)' : 'var(--text-dim)'}">${r.remaining > 0 ? `$${r.remaining}` : '—'}</td>
                <td style="text-align:right;padding:8px 10px;color:${r.surplus > 0 ? 'var(--red)' : 'var(--text-dim)'};font-weight:${r.surplus > 0 ? '700' : '400'}">${r.surplus > 0 ? `$${r.surplus}` : '—'}</td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function getSendDownsByTeam() {
  const moves = (typeof dbGetRosterMoves === "function") ? dbGetRosterMoves() : [];
  const byTeam = {};
  for (const m of moves) {
    if (m && m.kind === "demote" && m.team_id) {
      if (!byTeam[m.team_id]) byTeam[m.team_id] = [];
      byTeam[m.team_id].push(m);
    }
  }
  return byTeam;
}

function renderFinancialsView() {
  const commish = isCommissioner();
  const paidMap = (typeof dbGetFeesPaid === "function") ? dbGetFeesPaid() : {};
  const sendDownsByTeam = getSendDownsByTeam();

  const feeRows = getDisplayOrderedTeams().map(team => {
    const sd = sendDownsByTeam[team.id] || [];
    const callupFees = sd.length * SEND_DOWN_FEE;
    const paid = paidMap[team.id] || {};
    const luxuryAmount = Number(paid.luxuryAmount || 0);
    const leagueOwed = paid.league ? 0 : LEAGUE_FEE;
    // If there are no callup fees, "paid" is irrelevant — owed is 0 either way.
    const callupOwed = (callupFees === 0 || paid.callup) ? 0 : callupFees;
    const luxuryOwed = (luxuryAmount === 0 || paid.luxury) ? 0 : luxuryAmount;
    const totalDue = leagueOwed + callupOwed + luxuryOwed;
    const allPaid = totalDue === 0;
    const sdSummary = sd.length
      ? sd.map(m => `<div style="font-size:0.72rem;color:var(--text-dim)">${escapeHtml(m.player_name)} — ${m.at ? new Date(m.at).toLocaleDateString() : ""}</div>`).join("")
      : '<div style="font-size:0.72rem;color:var(--text-dim);font-style:italic">No send-downs</div>';
    const leaguePaidCtl = commish
      ? `<input type="checkbox" ${paid.league ? "checked" : ""} onchange="toggleFeePaid('${escapeJsString(team.id)}','league',this.checked)" style="width:16px;height:16px;cursor:pointer;accent-color:var(--green)">`
      : (paid.league
          ? '<span style="color:var(--green);font-size:0.78rem;font-weight:700">PAID</span>'
          : '<span style="color:var(--red);font-size:0.78rem;font-weight:700">unpaid</span>');
    const callupPaidCtl = callupFees === 0
      ? '<span style="color:var(--text-dim);font-size:0.74rem">—</span>'
      : commish
        ? `<input type="checkbox" ${paid.callup ? "checked" : ""} onchange="toggleFeePaid('${escapeJsString(team.id)}','callup',this.checked)" style="width:16px;height:16px;cursor:pointer;accent-color:var(--green)">`
        : (paid.callup
            ? '<span style="color:var(--green);font-size:0.78rem;font-weight:700">PAID</span>'
            : '<span style="color:var(--red);font-size:0.78rem;font-weight:700">unpaid</span>');
    const luxuryAmountCtl = commish
      ? `<input type="number" min="0" step="1" value="${luxuryAmount || ''}" placeholder="0"
           onchange="setLuxuryFeeAmount('${escapeJsString(team.id)}', this.value)"
           style="width:70px;background:var(--bg);color:var(--text);border:1px solid var(--border);padding:4px 6px;border-radius:4px;font-size:0.82rem;text-align:right">`
      : `<span style="color:var(--text-bright);font-weight:600">$${luxuryAmount}</span>`;
    const luxuryPaidCtl = luxuryAmount === 0
      ? '<span style="color:var(--text-dim);font-size:0.74rem">—</span>'
      : commish
        ? `<input type="checkbox" ${paid.luxury ? "checked" : ""} onchange="toggleFeePaid('${escapeJsString(team.id)}','luxury',this.checked)" style="width:16px;height:16px;cursor:pointer;accent-color:var(--green)">`
        : (paid.luxury
            ? '<span style="color:var(--green);font-size:0.78rem;font-weight:700">PAID</span>'
            : '<span style="color:var(--red);font-size:0.78rem;font-weight:700">unpaid</span>');
    return `
      <tr style="${allPaid ? 'opacity:0.55' : ''}">
        <td style="font-weight:700;color:var(--text-bright);vertical-align:top;padding:8px 10px">${escapeHtml(team.name)}</td>
        <td style="text-align:right;vertical-align:top;padding:8px 6px">$${LEAGUE_FEE}</td>
        <td style="text-align:center;vertical-align:top;padding:8px 6px">${leaguePaidCtl}</td>
        <td style="vertical-align:top;padding:8px 10px">
          <div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline">
            <span style="color:var(--text);font-size:0.84rem">${sd.length} send-down${sd.length === 1 ? "" : "s"}</span>
            <span style="color:var(--text-bright);font-weight:600">$${callupFees}</span>
          </div>
          ${sdSummary}
        </td>
        <td style="text-align:center;vertical-align:top;padding:8px 6px">${callupPaidCtl}</td>
        <td style="text-align:right;vertical-align:top;padding:8px 6px">${luxuryAmountCtl}</td>
        <td style="text-align:center;vertical-align:top;padding:8px 6px">${luxuryPaidCtl}</td>
        <td style="text-align:right;font-weight:700;color:${totalDue === 0 ? 'var(--green)' : 'var(--text-bright)'};vertical-align:top;padding:8px 10px">$${totalDue}</td>
      </tr>
    `;
  }).join("");

  // Totals reflect what's actually owed (paid amounts subtracted).
  const totalLeague = LEAGUE_DATA.teams.length * LEAGUE_FEE;
  const totalCallup = LEAGUE_DATA.teams.reduce((s, t) => s + ((sendDownsByTeam[t.id] || []).length * SEND_DOWN_FEE), 0);
  const totalLuxury = LEAGUE_DATA.teams.reduce((s, t) => s + Number(paidMap[t.id]?.luxuryAmount || 0), 0);
  const owedLeague = LEAGUE_DATA.teams.reduce((s, t) => s + ((paidMap[t.id]?.league) ? 0 : LEAGUE_FEE), 0);
  const owedCallup = LEAGUE_DATA.teams.reduce((s, t) => {
    const f = (sendDownsByTeam[t.id] || []).length * SEND_DOWN_FEE;
    if (f === 0) return s;
    return s + ((paidMap[t.id]?.callup) ? 0 : f);
  }, 0);
  const owedLuxury = LEAGUE_DATA.teams.reduce((s, t) => {
    const amt = Number(paidMap[t.id]?.luxuryAmount || 0);
    if (amt === 0) return s;
    return s + ((paidMap[t.id]?.luxury) ? 0 : amt);
  }, 0);
  const totalOwed = owedLeague + owedCallup + owedLuxury;

  return `
    <h2 style="color:var(--text-bright);margin-bottom:6px">Financials</h2>
    <div style="color:var(--text-dim);font-size:0.82rem;margin-bottom:18px">League finances at a glance.</div>

    <div class="keeper-projection" style="margin-bottom:14px">
      <h3 style="margin-top:0">${CURRENT_SEASON + 1} Draft Dollars</h3>
      <div style="color:var(--text-dim);font-size:0.78rem;margin-bottom:10px">Starting balance is $260 per team; trades shift it.</div>
      ${renderDraftDollarsPanel()}
    </div>

    <div class="keeper-projection" style="margin-bottom:14px">
      <h3 style="margin-top:0">Luxury Tax</h3>
      <div style="color:var(--text-dim);font-size:0.82rem;margin-bottom:10px">
        Cap is $${LUXURY_TAX_CAP}. Keepers and auction picks count at their price; free agents and minor-league call-ups count at $1 each. Numbers reflect the current ESPN roster.
      </div>
      ${renderLuxuryTaxTable()}
    </div>

    <div class="keeper-projection" style="margin-bottom:14px">
      <h3 style="margin-top:0">Fees</h3>
      <div style="color:var(--text-dim);font-size:0.82rem;margin-bottom:10px">
        League fee is $${LEAGUE_FEE} per team. Each send-down costs $${SEND_DOWN_FEE}. Luxury tax is set manually by the commissioner per team.
        ${commish ? " Edit any amount and check the box to mark a team as paid." : " Only the commissioner can edit amounts and mark fees paid."}
      </div>
      <div style="max-width:880px;overflow-x:auto">
        <table class="player-table" style="font-size:0.85rem;width:100%;table-layout:fixed">
          <colgroup>
            <col style="width:110px">
            <col style="width:66px">
            <col style="width:50px">
            <col>
            <col style="width:50px">
            <col style="width:74px">
            <col style="width:50px">
            <col style="width:78px">
          </colgroup>
          <thead>
            <tr>
              <th>Team</th>
              <th style="text-align:right">League</th>
              <th style="text-align:center">Paid?</th>
              <th>Send-downs</th>
              <th style="text-align:center">Paid?</th>
              <th style="text-align:right">Luxury</th>
              <th style="text-align:center">Paid?</th>
              <th style="text-align:right">Total Due</th>
            </tr>
          </thead>
          <tbody>${feeRows}</tbody>
          <tfoot>
            <tr>
              <td style="font-weight:700;color:var(--text-bright);border-top:2px solid var(--border);padding:8px 10px">Totals</td>
              <td style="text-align:right;color:var(--text-dim);border-top:2px solid var(--border);padding:8px 6px">$${totalLeague}</td>
              <td style="border-top:2px solid var(--border)"></td>
              <td style="text-align:right;color:var(--text-dim);border-top:2px solid var(--border);padding:8px 10px">$${totalCallup}</td>
              <td style="border-top:2px solid var(--border)"></td>
              <td style="text-align:right;color:var(--text-dim);border-top:2px solid var(--border);padding:8px 6px">$${totalLuxury}</td>
              <td style="border-top:2px solid var(--border)"></td>
              <td style="text-align:right;font-weight:700;color:${totalOwed === 0 ? 'var(--green)' : 'var(--text-bright)'};border-top:2px solid var(--border);padding:8px 10px">$${totalOwed}<div style="font-weight:400;color:var(--text-dim);font-size:0.7rem">owed</div></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  `;
}

async function setLuxuryFeeAmount(teamId, raw) {
  if (!isCommissioner()) return;
  const parsed = parseFloat(raw);
  const amount = (Number.isFinite(parsed) && parsed >= 0) ? parsed : 0;
  const cur = (typeof dbGetFeesPaid === "function") ? dbGetFeesPaid() : {};
  const teamPaid = { ...(cur[teamId] || {}) };
  teamPaid.luxuryAmount = amount;
  // Setting/clearing the amount also clears the paid flag if there's nothing
  // owed — otherwise the row would lock to "PAID" with $0 amount.
  if (amount === 0) delete teamPaid.luxury;
  const next = { ...cur, [teamId]: teamPaid };
  try {
    await saveFeesPaidAsync(next);
    if (typeof logActivityAsync === "function") {
      logActivityAsync("luxury_fee_set", { team_id: teamId, amount }, { targetTeamId: teamId });
    }
    if (currentView === "financials") switchTab("financials");
  } catch (e) {
    alert("Couldn't save: " + (e.message || e));
  }
}

async function toggleFeePaid(teamId, kind, checked) {
  if (!isCommissioner()) { alert("Commissioners only."); return; }
  const cur = (typeof dbGetFeesPaid === "function") ? dbGetFeesPaid() : {};
  const teamPaid = { ...(cur[teamId] || {}) };
  teamPaid[kind] = !!checked;
  const next = { ...cur, [teamId]: teamPaid };
  try {
    await saveFeesPaidAsync(next);
    if (typeof logActivityAsync === "function") {
      logActivityAsync(checked ? "fee_marked_paid" : "fee_marked_unpaid", {
        team_id: teamId, kind,
      }, { targetTeamId: teamId });
    }
    if (currentView === "financials") switchTab("financials");
  } catch (e) {
    alert("Couldn't save: " + (e.message || e));
  }
}

function renderDraftDollarsPanel() {
  const balances = getDraftDollarBalances();
  const rows = getDisplayOrderedTeams().map(t => ({ ...t, balance: balances[t.id] ?? 260 }));
  // Grid of compact tiles — keeps the panel from stretching across the
  // wider Financials viewport while still listing every team.
  return `
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:6px">
      ${rows.map(t => {
        const diff = t.balance - 260;
        const diffStr = diff > 0 ? `+$${diff}` : diff < 0 ? `-$${Math.abs(diff)}` : "";
        const diffColor = diff > 0 ? "var(--green)" : diff < 0 ? "var(--red)" : "var(--text-dim)";
        return `<div style="display:flex;justify-content:space-between;align-items:baseline;padding:7px 10px;background:var(--bg);border:1px solid var(--border);border-radius:6px;font-size:0.85rem">
          <span style="color:var(--text)">${escapeHtml(t.name)}</span>
          <span style="display:flex;align-items:baseline;gap:6px">
            ${diffStr ? `<span style="color:${diffColor};font-size:0.72rem">${diffStr}</span>` : ""}
            <span style="color:var(--text-bright);font-weight:700">$${t.balance}</span>
          </span>
        </div>`;
      }).join("")}
    </div>
  `;
}

function renderTradeCard(trade, index) {
  const team1 = LEAGUE_DATA.teams.find(t => t.id === trade.team1);
  const team2 = LEAGUE_DATA.teams.find(t => t.id === trade.team2);
  return `
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:14px;margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <span style="color:var(--text-dim);font-size:0.75rem">${trade.createdAt ? timestampHTML(trade.createdAt) : escapeHtml(trade.date || "")}</span>
        ${isCommissioner() ? `<div style="display:flex;gap:10px">
          <button onclick="editTrade(${index})" style="background:none;border:none;color:var(--accent);cursor:pointer;font-size:0.75rem">Edit</button>
          <button onclick="deleteTrade(${index})" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:0.75rem">Delete</button>
        </div>` : ''}
      </div>
      <div style="display:grid;grid-template-columns:1fr auto 1fr;gap:10px;align-items:start">
        <div>
          <div style="font-weight:700;color:var(--accent);margin-bottom:6px">${team1 ? team1.name : trade.team1} receives:</div>
          ${renderTradeAssets(trade.team1Receives)}
        </div>
        <div style="color:var(--text-dim);font-size:1.2rem;align-self:center">&#8644;</div>
        <div>
          <div style="font-weight:700;color:var(--accent);margin-bottom:6px">${team2 ? team2.name : trade.team2} receives:</div>
          ${renderTradeAssets(trade.team2Receives)}
        </div>
      </div>
      ${trade.notes ? `<div style="margin-top:8px;color:var(--text-dim);font-size:0.8rem;font-style:italic">${escapeHtml(trade.notes)}</div>` : ''}
    </div>
  `;
}

function renderTradeAssets(assets) {
  if (!assets || !assets.length) return '<span style="color:var(--text-dim);font-size:0.85rem">Nothing</span>';
  return assets.map(a => {
    let icon = '', color = 'var(--text)';
    switch (a.type) {
      case 'major': icon = ''; color = 'var(--text-bright)'; break;
      case 'minor': icon = ''; color = 'var(--green)'; break;
      case 'callup': icon = ''; color = 'var(--purple)'; break;
      case 'draft_dollars': icon = ''; color = 'var(--yellow)'; break;
      case 'faab': icon = ''; color = 'var(--orange)'; break;
      case 'milb_pick': icon = ''; color = 'var(--accent)'; break;
    }
    const typeLabel = { major: 'MLB', minor: 'MiLB', callup: 'MiLB', draft_dollars: 'Draft $', faab: 'FAAB $', milb_pick: 'Pick' }[a.type] || '';
    return `<div style="font-size:0.85rem;margin-bottom:3px">
      <span style="color:${color};font-weight:600">${escapeHtml(a.value)}</span>
      <span style="color:var(--text-dim);font-size:0.7rem;margin-left:4px">${typeLabel}</span>
    </div>`;
  }).join('');
}

function showTradeForm(team1Id, team2Id) {
  // _formMode null = the direct "New Trade" entry in the Trade Log, which
  // records a final trade and is commissioner-only. Proposal and edit flows
  // set _formMode before calling this and have their own permission gating.
  if (_formMode === null && !isCommissioner()) {
    alert("Only the commissioner records final trades. Use the Trade Inbox to propose a trade to another manager.");
    return;
  }
  // Fresh form = fresh asset state
  tradeAssets.t1 = [];
  tradeAssets.t2 = [];
  tradeAssets.teamIds.t1 = null;
  tradeAssets.teamIds.t2 = null;

  const container = document.getElementById("trade-form-container");
  const teamOptions = LEAGUE_DATA.teams.map(t => `<option value="${t.id}">${t.name}</option>`).join("");
  container.innerHTML = `
    <div class="keeper-projection" style="margin-bottom:16px">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
        <div>
          <label style="font-size:0.8rem;color:var(--text-dim);display:block;margin-bottom:4px">Team 1</label>
          <select id="trade-team1" class="trade-select" onchange="updateTradePlayerOptions()">
            <option value="">Select team...</option>
            ${teamOptions}
          </select>
          <div id="trade-team1-assets"></div>
        </div>
        <div>
          <label style="font-size:0.8rem;color:var(--text-dim);display:block;margin-bottom:4px">Team 2</label>
          <select id="trade-team2" class="trade-select" onchange="updateTradePlayerOptions()">
            <option value="">Select team...</option>
            ${teamOptions}
          </select>
          <div id="trade-team2-assets"></div>
        </div>
      </div>
      <div style="margin-top:12px">
        <label style="font-size:0.8rem;color:var(--text-dim);display:block;margin-bottom:4px">Notes (optional)</label>
        <input type="text" id="trade-notes" placeholder="Additional trade terms, context..." style="width:100%;background:var(--bg);color:var(--text);border:1px solid var(--border);padding:8px 10px;border-radius:6px;font-size:0.9rem">
      </div>
      <div style="margin-top:14px;display:flex;gap:10px">
        <button class="trade-btn trade-btn-submit" onclick="submitTrade()">Save Trade</button>
        <button class="trade-btn trade-btn-cancel" onclick="cancelTrade()">Cancel</button>
      </div>
    </div>
  `;

  // Pre-fill team selectors when the form is opened from a "Propose Trade"
  // entry point (e.g., the Trade Block view).
  if (team1Id) {
    const sel1 = document.getElementById("trade-team1");
    if (sel1) sel1.value = team1Id;
  }
  if (team2Id) {
    const sel2 = document.getElementById("trade-team2");
    if (sel2) sel2.value = team2Id;
  }
  if (team1Id || team2Id) updateTradePlayerOptions();
}

function updateTradePlayerOptions() {
  renderTeamAssetPicker("trade-team1", "trade-team1-assets", "t1");
  renderTeamAssetPicker("trade-team2", "trade-team2-assets", "t2");
}

function renderTeamAssetPicker(selectId, containerId, prefix) {
  const teamId = document.getElementById(selectId).value;
  const container = document.getElementById(containerId);
  if (!teamId) {
    container.innerHTML = "";
    tradeAssets[prefix] = [];
    tradeAssets.teamIds[prefix] = null;
    return;
  }

  // If team selection changed, reset that side's assets
  if (tradeAssets.teamIds[prefix] !== teamId) {
    tradeAssets[prefix] = [];
    tradeAssets.teamIds[prefix] = teamId;
  }

  const team = LEAGUE_DATA.teams.find(t => t.id === teamId);
  if (!team) return;

  // Pull majors from the live ESPN roster (includes in-season pickups + callups).
  // Fall back to data.js keepers + callups if no snapshot is loaded.
  const snap = getEspnSnapshot();
  const espnTeam = snap ? snap.teams.find(t => ESPN_ABBREV_TO_LOCAL[t.abbrev] === teamId) : null;
  const priceByName = Object.fromEntries(team.majors.map(p => [p.name, p.price]));
  const mlbRoster = espnTeam
    ? [...espnTeam.roster].sort((a, b) => lastName(a.name).localeCompare(lastName(b.name)))
    : [...team.majors, ...(team.callups || [])].sort((a, b) => lastName(a.name).localeCompare(lastName(b.name)));
  const majorOptions = mlbRoster.map(p => {
    const price = priceByName[p.name];
    const label = price !== undefined ? `${p.name} ($${price})` : p.name;
    return `<option value="major:${escapeHtml(p.name)}">${escapeHtml(label)}</option>`;
  }).join("");
  const minorOptions = [...team.minors]
    .sort((a, b) => lastName(a.name).localeCompare(lastName(b.name)))
    .map(p => `<option value="minor:${escapeHtml(p.name)}">${escapeHtml(p.name)}</option>`)
    .join("");

  // Compute the picks this team currently owns (after applying base order +
  // trade-log overrides), excluding any already queued in this trade form.
  const draft = getDraft();
  const queuedPicks = new Set(
    (tradeAssets[prefix] || [])
      .filter(a => a.type === "milb_pick" && a.pickRound != null)
      .map(a => `R${a.pickRound}P${a.pickInRound}`)
  );
  const ownedPicks = [];
  for (let round = 1; round <= draft.rounds; round++) {
    for (let pickInRound = 1; pickInRound <= draft.baseOrder.length; pickInRound++) {
      if (queuedPicks.has(`R${round}P${pickInRound}`)) continue;
      if (getPickOwner(draft, round, pickInRound) !== teamId) continue;
      ownedPicks.push({ round, pickInRound, baseOwner: getBaseOwner(draft, round, pickInRound) });
    }
  }
  const pickOptions = ownedPicks.map(p => {
    const baseTeam = LEAGUE_DATA.teams.find(t => t.id === p.baseOwner);
    const baseName = baseTeam ? baseTeam.name : p.baseOwner;
    const label = p.baseOwner === teamId
      ? `${draft.year} Round ${p.round}`
      : `${draft.year} Round ${p.round} (orig. ${baseName})`;
    return `<option value="milb_pick:R${p.round}P${p.pickInRound}">${label}</option>`;
  }).join("");

  container.innerHTML = `
    <div style="margin-top:8px">
      <label style="font-size:0.75rem;color:var(--text-dim)">Sends:</label>
      <select id="${prefix}-player-select" class="trade-select" style="margin-top:2px">
        <option value="">Add player/asset...</option>
        <optgroup label="Major Leaguers">${majorOptions}</optgroup>
        <optgroup label="Minor Leaguers">${minorOptions}</optgroup>
        ${pickOptions ? `<optgroup label="Minor League Picks">${pickOptions}</optgroup>` : ''}
        <optgroup label="Other Assets">
          <option value="draft_dollars">Draft Dollars</option>
          <option value="faab">FAAB Dollars</option>
        </optgroup>
      </select>
      <div style="display:flex;gap:6px;margin-top:6px">
        <input type="text" id="${prefix}-asset-detail" placeholder="Dollar amount" style="flex:1;background:var(--bg);color:var(--text);border:1px solid var(--border);padding:6px 8px;border-radius:4px;font-size:0.85rem;display:none">
        <button onclick="addTradeAsset('${prefix}')" class="trade-btn" style="font-size:0.8rem;padding:6px 12px">Add</button>
      </div>
      <div id="${prefix}-asset-list" style="margin-top:6px"></div>
    </div>
  `;

  // Show/hide detail input based on selection (only $ amounts need it now).
  document.getElementById(`${prefix}-player-select`).addEventListener("change", function() {
    const detail = document.getElementById(`${prefix}-asset-detail`);
    if (this.value === "draft_dollars" || this.value === "faab") {
      detail.style.display = "block";
      detail.placeholder = "Dollar amount";
    } else {
      detail.style.display = "none";
    }
  });

  // Re-render any already-added assets so they don't disappear from view when the picker is rebuilt
  renderAssetList(prefix);
}

// Store trade assets in memory during form entry, scoped to the current team selection
const tradeAssets = { t1: [], t2: [], teamIds: { t1: null, t2: null } };

function addTradeAsset(prefix) {
  const select = document.getElementById(`${prefix}-player-select`);
  const detail = document.getElementById(`${prefix}-asset-detail`);
  const val = select.value;
  if (!val) return;

  let asset;
  let isPick = false;
  if (val.startsWith("major:") || val.startsWith("minor:") || val.startsWith("callup:")) {
    const [type, name] = [val.split(":")[0], val.substring(val.indexOf(":") + 1)];
    asset = { type, value: name };
  } else if (val === "draft_dollars") {
    const amount = parseInt(detail.value || "0", 10) || 0;
    asset = { type: "draft_dollars", value: `$${amount} draft dollars`, amount };
  } else if (val === "faab") {
    const amount = parseInt(detail.value || "0", 10) || 0;
    asset = { type: "faab", value: `$${amount} FAAB`, amount };
  } else if (val.startsWith("milb_pick:R")) {
    const m = val.match(/^milb_pick:R(\d+)P(\d+)$/);
    if (m) {
      const round = parseInt(m[1]);
      const pickInRound = parseInt(m[2]);
      const draft = getDraft();
      const baseOwner = getBaseOwner(draft, round, pickInRound);
      const baseTeam = LEAGUE_DATA.teams.find(t => t.id === baseOwner);
      const baseName = baseTeam ? baseTeam.name : baseOwner;
      const ownerLabel = baseOwner === tradeAssets.teamIds[prefix]
        ? ""
        : ` (orig. ${baseName})`;
      asset = {
        type: "milb_pick",
        value: `${draft.year} Round ${round}${ownerLabel}`,
        pickRound: round,
        pickInRound,
        pickOriginalOwner: baseOwner,
        pickYear: draft.year,
      };
      isPick = true;
    }
  }

  if (asset) {
    tradeAssets[prefix].push(asset);
    select.value = "";
    detail.value = "";
    detail.style.display = "none";
    renderAssetList(prefix);
    // For picks, re-render the picker so the just-added pick drops off the dropdown.
    if (isPick) {
      const selectId = prefix === "t1" ? "trade-team1" : "trade-team2";
      const containerId = prefix === "t1" ? "trade-team1-assets" : "trade-team2-assets";
      renderTeamAssetPicker(selectId, containerId, prefix);
    }
  }
}

function removeTradeAsset(prefix, index) {
  const removed = tradeAssets[prefix][index];
  tradeAssets[prefix].splice(index, 1);
  renderAssetList(prefix);
  // If a pick was removed, re-render the picker so it reappears in the dropdown.
  if (removed && removed.type === "milb_pick" && removed.pickRound != null) {
    const selectId = prefix === "t1" ? "trade-team1" : "trade-team2";
    const containerId = prefix === "t1" ? "trade-team1-assets" : "trade-team2-assets";
    renderTeamAssetPicker(selectId, containerId, prefix);
  }
}

function renderAssetList(prefix) {
  const container = document.getElementById(`${prefix}-asset-list`);
  if (!container) return;
  container.innerHTML = tradeAssets[prefix].map((a, i) => {
    const typeLabel = { major: 'MLB', minor: 'MiLB', callup: 'MiLB', draft_dollars: '$', faab: 'FAAB', milb_pick: 'Pick' }[a.type];
    return `<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 8px;background:var(--bg);border-radius:4px;margin-bottom:3px;font-size:0.82rem">
      <span><span style="color:var(--text-dim);font-size:0.7rem">${typeLabel}</span> ${escapeHtml(a.value)}</span>
      <button onclick="removeTradeAsset('${prefix}',${i})" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:0.8rem">x</button>
    </div>`;
  }).join("");
}

function submitTrade() {
  // The composer reuses this trade form for proposal entry; route through.
  if (_formMode && _formMode.kind === "proposal") return submitProposal();
  if (_formMode && _formMode.kind === "edit") return submitTradeEdit();
  const team1 = document.getElementById("trade-team1").value;
  const team2 = document.getElementById("trade-team2").value;
  const notes = document.getElementById("trade-notes").value;

  if (!team1 || !team2) { alert("Select both teams"); return; }
  if (team1 === team2) { alert("Teams must be different"); return; }
  if (!tradeAssets.t1.length && !tradeAssets.t2.length) { alert("Add at least one asset"); return; }
  // One-sided trade (gift / salary dump) — confirm to catch accidents.
  if (!tradeAssets.t1.length || !tradeAssets.t2.length) {
    const giver = !tradeAssets.t1.length ? team2 : team1;
    const receiver = !tradeAssets.t1.length ? team1 : team2;
    if (!confirm(`This trade is one-sided — ${giver} is giving to ${receiver} for nothing. Save anyway?`)) return;
  }

  const trade = {
    date: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
    team1,
    team2,
    team1Receives: [...tradeAssets.t2], // team1 receives what team2 sends
    team2Receives: [...tradeAssets.t1], // team2 receives what team1 sends
    notes
  };

  if (typeof addTradeAsync === "function") {
    addTradeAsync(trade)
      .then(tradeId => {
        // Only clear the form on a successful save — preserves queued assets
        // if the network/RLS rejects the write.
        tradeAssets.t1 = [];
        tradeAssets.t2 = [];
        if (typeof logActivityAsync === "function") {
          logActivityAsync("trade_recorded", {
            trade_id: tradeId,
            team1: trade.team1, team2: trade.team2,
            team1_receives: trade.team1Receives,
            team2_receives: trade.team2Receives,
            notes: trade.notes,
          }, { targetTeamId: trade.team2 });
        }
        goToTrades("log");
      })
      .catch(err => alert("Trade save failed: " + err.message));
  } else {
    const trades = getTrades();
    trades.push(trade);
    saveTrades(trades);
    tradeAssets.t1 = [];
    tradeAssets.t2 = [];
    goToTrades("log");
  }
}

function cancelTrade() {
  tradeAssets.t1 = [];
  tradeAssets.t2 = [];
  _formMode = null;
  document.getElementById("trade-form-container").innerHTML = "";
}

function editTrade(index) {
  const trades = getTrades();
  const target = trades[index];
  if (!target || !target._id) return;
  if (!isCommissioner()) return;
  // Open the trade form in edit mode pre-filled with the existing trade.
  _formMode = { kind: "edit", tradeId: target._id };
  showTradeForm(target.team1, target.team2);
  // Pre-fill assets and notes. tradeAssets t1 = what team1 GIVES (= team2_receives).
  tradeAssets.t1 = JSON.parse(JSON.stringify(target.team2Receives || []));
  tradeAssets.t2 = JSON.parse(JSON.stringify(target.team1Receives || []));
  tradeAssets.teamIds.t1 = target.team1;
  tradeAssets.teamIds.t2 = target.team2;
  if (typeof renderAssetList === "function") {
    renderAssetList("t1");
    renderAssetList("t2");
  }
  const notesEl = document.getElementById("trade-notes");
  if (notesEl) notesEl.value = target.notes || "";
  // Relabel the submit button so it's clear this is an edit.
  const submitBtn = document.querySelector("#trade-form-container .trade-btn-submit");
  if (submitBtn) submitBtn.textContent = "Save Changes";
  // Scroll the form into view so the user sees it on page.
  document.getElementById("trade-form-container")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function submitTradeEdit() {
  const tradeId = _formMode?.tradeId;
  if (!tradeId) return;
  const team1 = document.getElementById("trade-team1").value;
  const team2 = document.getElementById("trade-team2").value;
  const notes = document.getElementById("trade-notes").value;
  if (!team1 || !team2) { alert("Select both teams"); return; }
  if (team1 === team2) { alert("Teams must be different"); return; }
  if (!tradeAssets.t1.length && !tradeAssets.t2.length) { alert("Add at least one asset"); return; }
  try {
    await editTradeAsync(tradeId, {
      team1, team2,
      team1Receives: [...tradeAssets.t2],
      team2Receives: [...tradeAssets.t1],
      notes,
    });
    if (typeof logActivityAsync === "function") {
      logActivityAsync("trade_edited", {
        team1, team2,
        team1_receives: [...tradeAssets.t2],
        team2_receives: [...tradeAssets.t1],
        notes,
      }, { targetTeamId: team2 });
    }
    tradeAssets.t1 = []; tradeAssets.t2 = [];
    _formMode = null;
    goToTrades("log");
  } catch (e) {
    alert("Couldn't save edits: " + (e.message || e));
  }
}

function deleteTrade(index) {
  if (!confirm("Delete this trade?")) return;
  const trades = getTrades();
  const target = trades[index];
  if (!target) return;
  if (target._id && typeof deleteTradeAsync === "function") {
    deleteTradeAsync(target._id)
      .then(() => {
        if (typeof logActivityAsync === "function") {
          logActivityAsync("trade_deleted", {
            team1: target.team1, team2: target.team2,
          }, { targetTeamId: target.team2 });
        }
        goToTrades("log");
      })
      .catch(err => alert("Delete failed: " + err.message));
  } else {
    trades.splice(index, 1);
    saveTrades(trades);
    goToTrades("log");
  }
}


// --- Rendering: Eligible Keepers Tab ---

function getEligibleKeeperSelections() {
  if (typeof dbGetKeeperSelections === "function") return dbGetKeeperSelections();
  try { return JSON.parse(localStorage.getItem("flm_eligible_keepers") || "{}"); }
  catch { return {}; }
}

// Legacy bulk save — only used in the localStorage-only fallback path.
function saveEligibleKeeperSelections(data) {
  localStorage.setItem("flm_eligible_keepers", JSON.stringify(data));
}

// Map ESPN team abbreviation -> local team id (must match data.js ids)
const ESPN_ABBREV_TO_LOCAL = {
  "MV3": "matt", "SHAR": "saxton", "S+A": "sam", "GLIX": "glicksman",
  "Jeff": "jeff", "AJ": "aj", "CORE": "corey", "JD": "josh-doug",
  "WEIN": "larry", "KLIN": "zack", "Dave": "dave", "JTL": "jesse"
};

function getEspnSnapshot() {
  return typeof ESPN_SNAPSHOT !== "undefined" ? ESPN_SNAPSHOT : null;
}

function getCallupPriceOverrides() {
  if (typeof dbGetCallupOverrides === "function") return dbGetCallupOverrides();
  try { return JSON.parse(localStorage.getItem("flm_callup_prices") || "{}"); }
  catch { return {}; }
}

function setCallupPriceOverride(playerName, price, year) {
  if (typeof saveCallupOverrideAsync === "function") {
    saveCallupOverrideAsync(playerName, Number(price), Number(year))
      .catch(err => alert("Save failed: " + err.message));
  } else {
    const all = JSON.parse(localStorage.getItem("flm_callup_prices") || "{}");
    all[playerName] = { price: Number(price), year: Number(year) };
    localStorage.setItem("flm_callup_prices", JSON.stringify(all));
  }
  if (typeof logActivityAsync === "function") {
    logActivityAsync("callup_price_set", {
      player_name: playerName, price: Number(price), year: Number(year),
    });
  }
}

// Find a player's prior cost basis by name across every team's keeper sheet.
function findKeeperCostBasis(playerName) {
  for (const team of LEAGUE_DATA.teams) {
    const m = team.majors.find(p => p.name === playerName);
    if (m) return { source: "keeper", originTeamId: team.id, price: m.price, yearAcquired: m.yearAcquired, fromMinors: m.fromMinors };
  }
  return null;
}

function findCallupRecord(playerName) {
  for (const team of LEAGUE_DATA.teams) {
    const c = team.callups.find(p => p.name === playerName);
    if (c) return { originTeamId: team.id, ...c };
  }
  return null;
}

function findInMinors(playerName) {
  for (const team of LEAGUE_DATA.teams) {
    const m = team.minors.find(p => p.name === playerName);
    if (m) return { teamId: team.id, ...m };
  }
  return null;
}

function findDraftPick(playerName) {
  const snap = getEspnSnapshot();
  if (!snap) return null;
  const espnRoster = snap.teams.flatMap(t => t.roster.map(r => ({ ...r, espnId: t.espnId })));
  const espnPlayer = espnRoster.find(p => p.name === playerName);
  if (!espnPlayer) return null;
  const pick = snap.draftPicks.find(d => d.playerId === espnPlayer.playerId);
  return pick || null;
}

// --- Commissioner role + workaround override storage ---
// (isCommissioner() — the real, auth-based version — is defined later. The
// legacy localStorage flag has been retired.)

function getWorkaroundOverrides() {
  if (typeof dbGetWorkaroundOverrides === "function") return dbGetWorkaroundOverrides();
  try { return JSON.parse(localStorage.getItem("flm_workaround_overrides") || "{}"); }
  catch { return {}; }
}

function setWorkaroundOverride(playerId, decision) {
  if (typeof isCommissioner === "function" && !isCommissioner()) return;
  const all = { ...getWorkaroundOverrides() };
  if (!decision || decision === "auto") delete all[String(playerId)];
  else all[String(playerId)] = decision;
  if (typeof saveWorkaroundOverridesAsync === "function") {
    saveWorkaroundOverridesAsync(all).catch(err => alert("Save failed: " + err.message));
  } else {
    localStorage.setItem("flm_workaround_overrides", JSON.stringify(all));
  }
}

// Returns { presumption, override, needsConfirmation } if the add is a commish workaround,
// or null otherwise.
function classifyCommishAdd(playerName, playerId, currentTeamLocalId, lastAdd) {
  if (!lastAdd || !lastAdd.isCommishWorkaround) return null;

  const callupRecord = findCallupRecord(playerName);
  let presumption;
  if (callupRecord && callupRecord.originTeamId === currentTeamLocalId) {
    presumption = "callup";
  } else if (lastAdd.recentDropWithin24h) {
    presumption = "fa";
  } else {
    presumption = "trade";
  }

  const override = getWorkaroundOverrides()[String(playerId)] || null;
  return {
    presumption,
    override,
    decision: override || presumption,
    needsConfirmation: !override,
  };
}

function getPlayerIdByName(playerName, preferredTeamId) {
  const snap = getEspnSnapshot();
  if (!snap) return null;
  const matches = [];
  for (const t of snap.teams) {
    const p = t.roster.find(r => r.name === playerName);
    if (p) matches.push({ playerId: p.playerId, teamLocalId: ESPN_ABBREV_TO_LOCAL[t.abbrev] });
  }
  if (!matches.length) return null;
  if (matches.length === 1) return matches[0].playerId;
  if (preferredTeamId) {
    const onPreferred = matches.find(m => m.teamLocalId === preferredTeamId);
    if (onPreferred) return onPreferred.playerId;
  }
  // Ambiguous — multiple players share this name and we can't tell which.
  // Returning null is safer than guessing wrong (would produce spurious tags).
  return null;
}

// Returns the most recent in-season ADD event (FA or waiver) for a player.
// Ignores pre-draft administrative events (ESPN's roster setup before the auction).
// Returns null if the player has been on a roster since the draft (no real adds).
function getMostRecentAddEvent(playerId) {
  const snap = getEspnSnapshot();
  if (!snap || !snap.events || playerId == null) return null;
  const draftCutoff = snap.draftDate || 0;
  const adds = snap.events.filter(e =>
    e.type === "ADD" &&
    e.playerId === playerId &&
    e.date >= draftCutoff
  );
  if (!adds.length) return null;
  return adds.reduce((latest, ev) => ev.date > latest.date ? ev : latest, adds[0]);
}

function getTradeDeadline() {
  const snap = getEspnSnapshot();
  return snap?.tradeDeadline || null;
}

// Resolve original cost basis (before drop/add overrides).
function getOriginalCostBasis(playerName, currentTeamLocalId) {
  // 1. Existing keeper (price/year known from prior-year sheet)
  const keeper = findKeeperCostBasis(playerName);
  if (keeper) {
    return {
      price: keeper.price,
      yearAcquired: keeper.yearAcquired,
      fromMinors: keeper.fromMinors,
      source: keeper.originTeamId === currentTeamLocalId ? "keeper" : "keeper-via-trade",
      contractType: "auction",
    };
  }

  // 2. Was a minor leaguer last year, called up this season
  const callup = findCallupRecord(playerName);
  if (callup) {
    const overrides = getCallupPriceOverrides();
    const o = overrides[playerName];
    return {
      price: o?.price ?? null,
      yearAcquired: o?.year ?? CURRENT_SEASON,
      originalDraftYear: callup.yearAcquired, // when they were originally drafted (minor league)
      fromMinors: true,
      source: callup.originTeamId === currentTeamLocalId ? "callup" : "callup-via-trade",
      contractType: "callup",
    };
  }

  // 3. Drafted in 2026 auction (non-keeper)
  const pick = findDraftPick(playerName);
  if (pick && !pick.keeper) {
    return {
      price: pick.bidAmount,
      yearAcquired: CURRENT_SEASON,
      fromMinors: false,
      source: "auction",
      contractType: "auction",
    };
  }

  // 4. No prior history — pure FA pickup this season (never drafted, never on a sheet)
  return null;
}

// Full cost-basis resolution applying:
//   - Trade preserves contract (handled by name-lookup across all teams)
//   - Drop + re-add resets to FA $6 (unless already in final keeper year — final year is final year)
//   - FA add after trade deadline = not keepable at all
function resolveCostBasis(playerName, currentTeamLocalId) {
  const original = getOriginalCostBasis(playerName, currentTeamLocalId);
  const playerId = getPlayerIdByName(playerName, currentTeamLocalId);
  const lastAdd = getMostRecentAddEvent(playerId);
  const deadline = getTradeDeadline();

  // If no ADD event in season, player has been on a roster since season start.
  if (!lastAdd) {
    if (original) return original;
    return {
      price: 6, yearAcquired: CURRENT_SEASON + 1, fromMinors: false,
      source: "fa", contractType: "fa",
    };
  }

  // Check if this is a commish-initiated add — could be trade workaround, FA reversal, or call-up
  const workaround = classifyCommishAdd(playerName, playerId, currentTeamLocalId, lastAdd);

  if (workaround) {
    if (workaround.decision === "trade") {
      // Treat as trade — preserve original cost basis if any
      if (original) {
        return { ...original, workaround };
      }
      // No prior contract — fall through to FA $6
      return {
        price: 6, yearAcquired: CURRENT_SEASON + 1, fromMinors: false,
        source: "fa", contractType: "fa", workaround,
      };
    }
    if (workaround.decision === "callup") {
      const callup = findCallupRecord(playerName);
      const overrides = getCallupPriceOverrides();
      const o = overrides[playerName];
      return {
        price: o?.price ?? null,
        yearAcquired: o?.year ?? CURRENT_SEASON,
        fromMinors: true,
        source: callup?.originTeamId === currentTeamLocalId ? "callup" : "callup-via-trade",
        contractType: "callup",
        workaround,
      };
    }
    // decision === "fa" → fall through to FA logic below
  }

  // Final-year-keeper exception: a player in their final original keeper year stays un-keepable
  // even if dropped + re-added.
  if (original && original.contractType === "auction") {
    const fake = { name: playerName, price: original.price, yearAcquired: original.yearAcquired, fromMinors: original.fromMinors };
    const cs = getContractStatus(fake, CURRENT_SEASON);
    if (!cs.canKeepNextYear) {
      return {
        ...original,
        droppedDuringSeason: true,
        droppedAndPostDeadline: deadline && lastAdd.date > deadline,
        workaround,
      };
    }
  }

  // FA add (drop+re-add or fresh pickup)
  const isPostDeadline = deadline && lastAdd.date > deadline;
  return {
    price: 6,
    yearAcquired: CURRENT_SEASON + 1,
    fromMinors: false,
    source: original ? "fa-after-drop" : "fa",
    contractType: "fa",
    addDate: lastAdd.date,
    addType: lastAdd.msgType === 178 ? "FA" : "Waiver",
    isPostDeadline,
    workaround,
  };
}

// Build the eligible-keeper list for a team using ESPN roster + data.js minors.
function getEligiblePlayers(team) {
  const players = [];
  const snap = getEspnSnapshot();
  // Keeper-Price Exceptions: commissioner-set overrides for the "true" salary
  // when ESPN's displayed price has been manually inflated/deflated to fake
  // a draft-dollars trade. The override replaces basis.price before any
  // contract math runs, so yearsRemaining / nextYearPrice / luxury tax all
  // use the true salary downstream.
  const priceExceptions = (typeof dbGetKeeperPriceExceptions === "function")
    ? dbGetKeeperPriceExceptions() : {};

  // 1. Major league players currently on this team's ESPN roster
  if (snap) {
    const espnTeam = snap.teams.find(t => ESPN_ABBREV_TO_LOCAL[t.abbrev] === team.id);
    if (espnTeam) {
      espnTeam.roster.forEach(r => {
        const basis = resolveCostBasis(r.name, team.id);
        if (priceExceptions[r.name] != null && typeof basis.price === "number") {
          basis.price = Number(priceExceptions[r.name]);
        }

        // For FA-add: contract starts in CURRENT_SEASON+1, so "yearsKept"=0 next year
        const fakePlayer = {
          name: r.name,
          price: basis.price ?? 0,
          yearAcquired: basis.yearAcquired,
          fromMinors: basis.fromMinors,
        };

        let cs;
        if (basis.isPostDeadline) {
          cs = {
            yearsKept: 0,
            yearsRemaining: 0,
            nextYearPrice: null,
            canKeepNextYear: false,
            status: "final",
            label: "Ineligible",
          };
        } else if (basis.contractType === "fa") {
          // FA: $6 in first keepable year (CURRENT_SEASON+1), then +$2/year, max 3 keeper years
          cs = {
            yearsKept: 0,
            yearsRemaining: 3,
            originalPrice: 6,
            maxYears: 3,
            nextYearPrice: 6,
            canKeepNextYear: true,
            status: "new",
            label: "FA — $6",
          };
        } else if (basis.contractType === "callup" && basis.price == null) {
          // A callup without an MLB price still rides their MILB contract,
          // which started when they were originally drafted to MiLB — not
          // when they were called up.
          const draftYear = basis.originalDraftYear ?? basis.yearAcquired;
          const milbYearsHeld = CURRENT_SEASON - draftYear;
          const milbMaxYears = draftYear < 2027 ? 4 : 99;
          const milbYrsAfterThisSeason = Math.max(0, milbMaxYears - milbYearsHeld - 1);
          if (milbYrsAfterThisSeason > 0 || draftYear >= 2027) {
            cs = {
              yearsKept: 0,
              yearsRemaining: basis.yearAcquired < 2027 ? milbYrsAfterThisSeason : null,
              nextYearPrice: null,
              canKeepNextYear: true,
              status: "new",
              label: "Call-up (price TBD)",
            };
          } else {
            cs = {
              yearsKept: 0,
              yearsRemaining: 0,
              nextYearPrice: null,
              canKeepNextYear: false,
              status: "final",
              label: "Final Year",
            };
          }
        } else {
          cs = getContractStatus(fakePlayer, CURRENT_SEASON);
          // If they were dropped this season AND already had a non-final-year contract,
          // that's a different case (handled in resolveCostBasis). The "stays final year"
          // case still has canKeepNextYear=false from getContractStatus, so we just amend the label:
          if (basis.droppedDuringSeason && !cs.canKeepNextYear) {
            cs = { ...cs, label: cs.label + " (dropped)" };
          }
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
          injuryStatus: r.injuryStatus,
          contractStatus: cs.status,
          contractLabel: cs.label,
          nextYearPrice: cs.canKeepNextYear ? cs.nextYearPrice : null,
          canKeepNextYear: cs.canKeepNextYear,
          yearsRemaining: cs.yearsRemaining,
          workaround: basis.workaround || null,
          priceExceptionApplied: priceExceptions[r.name] != null,
        });
      });
    }
  } else {
    // No ESPN snapshot — fall back to data.js majors
    team.majors.forEach(p => {
      const cs = getContractStatus(p, CURRENT_SEASON);
      players.push({
        name: p.name, type: "major", price: p.price, yearAcquired: p.yearAcquired,
        fromMinors: p.fromMinors, contractType: "auction", source: "keeper",
        contractStatus: cs.status, contractLabel: cs.label,
        nextYearPrice: cs.canKeepNextYear ? cs.nextYearPrice : null,
        canKeepNextYear: cs.canKeepNextYear, yearsRemaining: cs.yearsRemaining,
      });
    });
  }

  return players.map(applyPlayerOverride);
}

function isKeeperLockoutActive() {
  const lock = (typeof dbGetKeeperDeadline === "function") ? dbGetKeeperDeadline() : null;
  return !!(lock && lock.locked);
}
function renderKeeperLockBanner() {
  if (!isKeeperLockoutActive()) return "";
  return `<div style="background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.4);color:var(--red);padding:10px 12px;border-radius:6px;font-size:0.85rem;margin-bottom:10px">
    <strong>Keepers locked.</strong> Only commissioners can change keeper selections right now.
  </div>`;
}
function renderKeeperLockCommishControls() {
  if (!isCommissioner()) return "";
  const locked = isKeeperLockoutActive();
  return `
    <div style="margin-bottom:10px">
      <button class="trade-btn ${locked ? '' : 'trade-btn-cancel'}" onclick="toggleKeeperLock()"
        style="font-size:0.78rem;${locked ? 'background:var(--red)' : ''}">
        ${locked ? '🔒 Keepers Locked — Click to Unlock' : 'Lock Keepers (commish only)'}
      </button>
    </div>
  `;
}
async function toggleKeeperLock() {
  const wasLocked = isKeeperLockoutActive();
  if (wasLocked && !confirm("Unlock keepers? Owners will be able to edit again.")) return;
  if (!wasLocked && !confirm("Lock keeper selections for everyone except commissioners?")) return;
  try {
    await saveKeeperDeadlineAsync(wasLocked ? null : { locked: true });
    if (typeof logActivityAsync === "function") {
      logActivityAsync(wasLocked ? "keepers_unlocked" : "keepers_locked", {});
    }
    if (typeof switchTab === "function") switchTab("eligible");
  } catch (e) {
    alert("Couldn't toggle lock: " + (e.message || e));
  }
}

function renderEligibleKeepersView() {
  const snap = getEspnSnapshot();
  let syncBanner = "";
  if (snap) {
    const ageHours = Math.round((Date.now() - new Date(snap.syncedAt).getTime()) / 3600000);
    const ageText = ageHours < 1 ? "just now" : ageHours < 24 ? `${ageHours}h ago` : `${Math.floor(ageHours/24)}d ago`;
    syncBanner = `<div style="font-size:0.75rem;color:var(--text-dim);margin-bottom:10px">ESPN data synced ${ageText} (season ${snap.season}).</div>`;
  } else {
    syncBanner = `<div style="font-size:0.8rem;color:var(--orange);margin-bottom:10px;padding:8px;background:rgba(249,115,22,0.1);border-radius:6px">No ESPN snapshot loaded. Run <code style="color:var(--accent)">bash scripts/sync_espn.sh</code> from the project root to populate eligible keepers from ESPN.</div>`;
  }
  const editToggle = isCommissioner() ? `
    <div style="margin-bottom:10px;display:flex;align-items:center;gap:10px">
      <button onclick="toggleCommishEdit()" class="trade-btn ${isCommishEditMode() ? 'trade-btn-submit' : 'trade-btn-cancel'}" style="font-size:0.78rem">
        ${isCommishEditMode() ? '✓ Commissioner Edit ON' : 'Commissioner Edit'}
      </button>
      ${isCommishEditMode() ? `<span style="color:var(--text-dim);font-size:0.75rem">Click ✏︎ on any row to override.</span>` : ""}
    </div>
  ` : "";
  return `
    ${syncBanner}
    ${renderKeeperLockBanner()}
    ${renderKeeperLockCommishControls()}
    ${editToggle}
    <div class="calc-team-selector">
      <select id="eligible-team-select" onchange="updateEligibleKeepersView()">
        <option value="">Select a team...</option>
        <option value="all">All Teams Summary</option>
        ${getDisplayOrderedTeams().map(t => `<option value="${t.id}">${t.name}</option>`).join("")}
      </select>
    </div>
    <div id="eligible-keepers-content"></div>
  `;
}

// --- Commissioner edit overrides ---

// Real commissioner status from the auth payload — doesn't honor the
// "view as manager" preview toggle. Used for places where we need to know
// "should this person be ABLE to flip the toggle?" rather than "are they
// currently acting as commish in the UI?".
function isRealCommissioner() {
  return !!(typeof currentOwner !== "undefined" && currentOwner && currentOwner.is_commissioner);
}
function isCommishViewSuppressed() {
  return localStorage.getItem("flm_commish_view_suppressed") === "true";
}
function isCommissioner() {
  if (isCommishViewSuppressed()) return false;
  return isRealCommissioner();
}
function toggleCommishView() {
  if (!isRealCommissioner()) return; // only real commissioners can toggle
  const suppressed = isCommishViewSuppressed();
  if (!suppressed) {
    if (!confirm("Switch to regular manager view? You'll lose commissioner controls until you toggle back. (Permissions on the server are unchanged.)")) return;
    localStorage.setItem("flm_commish_view_suppressed", "true");
  } else {
    localStorage.removeItem("flm_commish_view_suppressed");
  }
  // Re-render header + current main view so commish-gated UI updates.
  if (typeof renderHeaderUser === "function") renderHeaderUser();
  if (typeof switchTab === "function" && typeof currentView !== "undefined") switchTab(currentView);
}

function isCommishEditMode() {
  return localStorage.getItem("flm_commish_edit_mode") === "true";
}

function toggleCommishEdit() {
  const next = !isCommishEditMode();
  localStorage.setItem("flm_commish_edit_mode", next ? "true" : "false");
  switchTab("eligible");
}

function getCommishOverrides() {
  if (typeof dbGetCommishOverrides === "function") return dbGetCommishOverrides();
  try { return JSON.parse(localStorage.getItem("flm_commish_overrides") || "{}"); }
  catch { return {}; }
}

function saveCommishOverrides(o) {
  if (typeof saveCommishOverridesAsync === "function") {
    saveCommishOverridesAsync(o).catch(err => alert("Save failed: " + err.message));
  } else {
    localStorage.setItem("flm_commish_overrides", JSON.stringify(o));
  }
}

function applyPlayerOverride(player) {
  const o = getCommishOverrides()[player.name];
  if (!o) return player;
  const out = { ...player, _commishOverridden: true };
  if (o.nextYearPrice !== undefined) out.nextYearPrice = o.nextYearPrice;
  if (o.canKeepNextYear !== undefined) out.canKeepNextYear = o.canKeepNextYear;
  if (o.contractLabel !== undefined) out.contractLabel = o.contractLabel;
  if (o.contractStatus !== undefined) out.contractStatus = o.contractStatus;
  return out;
}

function openCommishEditor(playerName) {
  const overrides = getCommishOverrides();
  const o = overrides[playerName] || {};
  // Find a sample player object from any team to show defaults.
  let baseline = null;
  for (const team of LEAGUE_DATA.teams) {
    const players = getEligiblePlayers(team);
    const p = players.find(x => x.name === playerName);
    if (p) { baseline = p; break; }
  }
  const existing = document.getElementById("commish-editor-modal");
  if (existing) existing.remove();
  const modal = document.createElement("div");
  modal.id = "commish-editor-modal";
  modal.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px";
  modal.onclick = e => { if (e.target === modal) modal.remove(); };
  const baseLine = (label, value) =>
    `<div style="color:var(--text-dim);font-size:0.7rem;margin-top:2px">Default: ${value === undefined || value === null ? '—' : escapeHtml(value)}</div>`;
  modal.innerHTML = `
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:18px;max-width:440px;width:100%;box-shadow:var(--shadow)">
      <h3 style="margin:0 0 12px;color:var(--text-bright)">Edit ${escapeHtml(playerName)}</h3>
      <p style="color:var(--text-dim);font-size:0.78rem;margin:0 0 14px">Override any field below. Leave blank to keep the default.</p>
      <label style="display:block;margin-bottom:10px">
        <div style="color:var(--text-dim);font-size:0.8rem">${CURRENT_SEASON + 1} price ($)</div>
        <input type="number" id="ce-nextprice" value="${escapeHtml(o.nextYearPrice ?? "")}" placeholder="${escapeHtml(baseline?.nextYearPrice ?? "")}" style="width:100%;background:var(--bg);color:var(--text);border:1px solid var(--border);padding:8px;border-radius:6px">
        ${baseline ? baseLine(`${CURRENT_SEASON + 1} price`, baseline.nextYearPrice) : ""}
      </label>
      <label style="display:flex;align-items:center;gap:8px;margin-bottom:10px;color:var(--text)">
        <input type="checkbox" id="ce-cankeep" ${(o.canKeepNextYear ?? baseline?.canKeepNextYear) ? "checked" : ""} style="width:16px;height:16px">
        Can be kept next year
      </label>
      <label style="display:block;margin-bottom:10px">
        <div style="color:var(--text-dim);font-size:0.8rem">Contract label</div>
        <input type="text" id="ce-label" value="${escapeHtml(o.contractLabel ?? "")}" placeholder="${escapeHtml(baseline?.contractLabel ?? "")}" style="width:100%;background:var(--bg);color:var(--text);border:1px solid var(--border);padding:8px;border-radius:6px">
        ${baseline ? baseLine("contract label", baseline.contractLabel) : ""}
      </label>
      <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
        <button class="trade-btn trade-btn-submit" onclick="saveCommishEditor('${escapeJsString(playerName)}')">Save</button>
        <button class="trade-btn trade-btn-cancel" onclick="document.getElementById('commish-editor-modal').remove()">Cancel</button>
        ${overrides[playerName] ? `<button class="trade-btn" style="background:var(--red);margin-left:auto" onclick="clearCommishOverride('${escapeJsString(playerName)}')">Reset to Default</button>` : ""}
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

function saveCommishEditor(playerName) {
  const overrides = getCommishOverrides();
  const np = document.getElementById("ce-nextprice").value;
  const ck = document.getElementById("ce-cankeep").checked;
  const lbl = document.getElementById("ce-label").value.trim();
  const o = {};
  if (np !== "") o.nextYearPrice = parseInt(np, 10);
  o.canKeepNextYear = ck;
  if (lbl) o.contractLabel = lbl;
  overrides[playerName] = o;
  saveCommishOverrides(overrides);
  if (typeof logActivityAsync === "function") {
    logActivityAsync("commish_override", { player_name: playerName, fields: Object.keys(o) });
  }
  document.getElementById("commish-editor-modal").remove();
  updateEligibleKeepersView();
}

function clearCommishOverride(playerName) {
  const overrides = getCommishOverrides();
  delete overrides[playerName];
  saveCommishOverrides(overrides);
  if (typeof logActivityAsync === "function") {
    logActivityAsync("commish_override", { player_name: playerName, cleared: true });
  }
  document.getElementById("commish-editor-modal").remove();
  updateEligibleKeepersView();
}

function updateEligibleKeepersView() {
  const teamId = document.getElementById("eligible-team-select").value;
  if (typeof _lastTeamSel !== "undefined") _lastTeamSel.eligible = teamId;
  const container = document.getElementById("eligible-keepers-content");
  if (!teamId) { container.innerHTML = ""; return; }

  if (teamId === "all") {
    renderAllTeamsEligibleSummary(container);
    return;
  }

  const team = LEAGUE_DATA.teams.find(t => t.id === teamId);
  if (!team) return;

  const players = getEligiblePlayers(team);
  const selections = getEligibleKeeperSelections();
  const teamSelections = selections[teamId] || {};

  const selectedKeepers = players.filter(p => teamSelections[p.name]?.keeper);
  // Keeper cost reflects 2027 price (next year's keeper budget impact).
  const totalKeeperCost = selectedKeepers.reduce((s, p) => s + (p.nextYearPrice || 0), 0);
  // Draft Dollars are static: $260 ± net trades. Keeper cost is shown separately.
  const draftDollars = getDraftDollarBalances()[teamId] ?? 260;
  const minorKeeperCount = Object.values(teamSelections).filter(s => s.minorKeeper).length;
  const rule5Count = Object.values(teamSelections).filter(s => s.rule5).length;

  const colorForCap = (cur, cap) => cur > cap ? 'var(--red)' : cur === cap ? 'var(--green)' : 'var(--yellow)';

  container.innerHTML = `
    <div class="summary-bar">
      <div class="summary-item">
        <div class="summary-value" id="ek-keeper-count" style="color:${colorForCap(selectedKeepers.length, 8)}">${selectedKeepers.length}/8</div>
        <div class="summary-label">ML Keepers</div>
      </div>
      <div class="summary-item">
        <div class="summary-value" id="ek-minor-count" style="color:${colorForCap(minorKeeperCount, 10)}">${minorKeeperCount}/10</div>
        <div class="summary-label">MiL Keepers</div>
      </div>
      <div class="summary-item">
        <div class="summary-value" id="ek-rule5-count" style="color:${colorForCap(rule5Count, 25)}">${rule5Count}/25</div>
        <div class="summary-label">Rule 5</div>
      </div>
      <div class="summary-item">
        <div class="summary-value" id="ek-keeper-cost" style="color:var(--green)">$${totalKeeperCost}</div>
        <div class="summary-label">Keeper Cost</div>
      </div>
      <div class="summary-item">
        <div class="summary-value" id="ek-draft-budget" style="color:var(--accent)">$${draftDollars}</div>
        <div class="summary-label">Draft Dollars</div>
      </div>
    </div>

    <div class="section-header">ESPN MLB Roster <span class="section-count">${players.length}</span></div>
    ${players.length
      ? renderEligibleTable(sortPlayersByCategory(players), teamId, teamSelections)
      : '<p style="color:var(--text-dim);font-size:0.85rem">No ESPN roster data — run the sync script.</p>'}

    <div class="section-header">Minor League Roster <span class="section-count">${team.minors.length}</span></div>
    ${renderMinorsEligibleTable([...team.minors].sort((a, b) => lastName(a.name).localeCompare(lastName(b.name))), teamId, teamSelections)}
  `;
}

function lastName(fullName) {
  // Strip trailing suffix like Jr./Sr./III, then take the last whitespace-delimited token.
  const stripped = String(fullName).replace(/\s+(Jr\.|Sr\.|II|III|IV)$/i, "").trim();
  const parts = stripped.split(/\s+/);
  return parts[parts.length - 1] || stripped;
}

function sortPlayersByCategory(players) {
  const order = {
    "keeper": 0, "keeper-via-trade": 0,
    "callup": 1, "callup-via-trade": 1,
    "auction": 2,
    "fa": 3, "fa-after-drop": 3,
  };
  return [...players].sort((a, b) => {
    const oa = order[a.source] ?? 99;
    const ob = order[b.source] ?? 99;
    if (oa !== ob) return oa - ob;
    return lastName(a.name).localeCompare(lastName(b.name));
  });
}

function sourceBadge(player) {
  const source = typeof player === "string" ? player : player.source;
  const yearAcq = typeof player === "object" ? player.yearAcquired : null;
  const origYear = typeof player === "object" ? (player.originalDraftYear || player.yearAcquired) : null;
  const fromMinors = typeof player === "object" ? player.fromMinors : false;
  const yearTag = origYear ? ` (${origYear}${fromMinors ? "m" : ""})` : "";
  switch (source) {
    case "keeper":          return `<span class="from-minors-tag" style="background:rgba(59,130,246,0.2);color:var(--accent)">Keeper${yearTag}</span>`;
    case "keeper-via-trade": return `<span class="from-minors-tag" style="background:rgba(59,130,246,0.2);color:var(--accent)">Keeper (trade)${yearTag}</span>`;
    case "callup":          return `<span class="from-minors-tag" style="background:rgba(168,85,247,0.2);color:var(--purple)">Call-up${origYear ? ` (${origYear}m)` : ""}</span>`;
    case "callup-via-trade": return `<span class="from-minors-tag" style="background:rgba(168,85,247,0.2);color:var(--purple)">Call-up (trade)${origYear ? ` (${origYear}m)` : ""}</span>`;
    case "auction":         return '<span class="from-minors-tag" style="background:rgba(34,197,94,0.2);color:var(--green)">Auction \'26</span>';
    case "fa":              return '<span class="from-minors-tag" style="background:rgba(234,179,8,0.2);color:var(--yellow)">FA</span>';
    case "fa-after-drop":   return '<span class="from-minors-tag" style="background:rgba(234,179,8,0.2);color:var(--yellow)">FA</span>';
    default: return "";
  }
}

function workaroundBadgeHtml(p) {
  if (!p.workaround) return '';
  const w = p.workaround;
  const playerIdEsc = String(p.playerId);
  const decisionLabels = { trade: "Trade", fa: "FA $6", callup: "Call-up" };
  const presumptionLabel = decisionLabels[w.presumption] || w.presumption;
  const decisionLabel = decisionLabels[w.decision] || w.decision;

  if (!isCommissioner()) return '';

  if (w.needsConfirmation) {
    // Show badge + 3 buttons; presumed value is highlighted
    const btn = (val, label, color) => `
      <button onclick="setWorkaroundOverride(${playerIdEsc}, '${val}'); updateEligibleKeepersView()"
              style="background:${val === w.presumption ? color : 'transparent'};
                     color:${val === w.presumption ? '#fff' : color};
                     border:1px solid ${color};
                     border-radius:4px;font-size:0.66rem;padding:2px 6px;margin-right:3px;cursor:pointer">
        ${label}
      </button>`;
    return `
      <div style="margin-top:4px;font-size:0.7rem;color:var(--orange)">
        ⚠ Commish add — confirm:
        ${btn('trade', 'Trade', 'var(--accent)')}
        ${btn('fa', 'FA', 'var(--yellow)')}
        ${btn('callup', 'Call-up', 'var(--purple)')}
        <span style="color:var(--text-dim);margin-left:4px">(presumed ${presumptionLabel})</span>
      </div>
    `;
  }
  // Confirmed
  return `
    <div style="margin-top:4px;font-size:0.7rem;color:var(--text-dim)">
      ✓ Confirmed ${decisionLabel}
      <button onclick="setWorkaroundOverride(${playerIdEsc}, null); updateEligibleKeepersView()"
              style="background:none;border:none;color:var(--accent);cursor:pointer;font-size:0.7rem;text-decoration:underline">
        change
      </button>
    </div>
  `;
}

function canEditTeam(teamId) {
  if (typeof currentOwner === "undefined" || !currentOwner) return false;
  return currentOwner.team_id === teamId || !!currentOwner.is_commissioner;
}

function renderEligibleTable(players, teamId, teamSelections) {
  const viewOnly = !canEditTeam(teamId) || (isKeeperLockoutActive() && !isCommissioner());
  return `
    <table class="player-table eligible-keepers-table">
      <thead>
        <tr>
          <th>Player</th>
          <th>Source</th>
          <th>${CURRENT_SEASON} $</th>
          <th>${CURRENT_SEASON + 1} $</th>
          <th>Expiry</th>
          <th style="text-align:center">Rule 5</th>
          <th style="text-align:center">Keep</th>
          <th style="text-align:center">On the Block</th>
        </tr>
      </thead>
      <tbody>
        ${players.map(p => {
          const sel = teamSelections[p.name] || {};
          const isKeeper = sel.keeper || false;
          const isTradeBlock = sel.tradeBlock || false;
          const isRule5 = sel.rule5 || false;
          const priceCell = p.price != null ? `$${p.price}` : '<span style="color:var(--text-dim)">—</span>';
          const nextPriceCell = !p.canKeepNextYear
            ? '<span style="color:var(--text-dim)">—</span>'
            : p.nextYearPrice != null
              ? `<span class="player-price">$${p.nextYearPrice}</span>`
              : (p.contractType === 'callup'
                  ? `<button onclick="promptCallupPrice('${escapeJsString(p.name)}',${teamId ? `'${escapeJsString(teamId)}'` : 'null'})" style="background:none;border:1px dashed var(--border);color:var(--yellow);font-size:0.72rem;padding:2px 8px;border-radius:4px;cursor:pointer">Set price</button>`
                  : '<span style="color:var(--text-dim)">—</span>');
          const injuryTag = '';  // IL status removed — was eating row space
          const rowBg = p.workaround && p.workaround.needsConfirmation
            ? 'background:rgba(249,115,22,0.12)'
            : (isKeeper ? 'background:rgba(34,197,94,0.08)'
                : isRule5 ? 'background:rgba(59,130,246,0.08)'
                : isTradeBlock ? 'background:rgba(249,115,22,0.08)'
                : '');
          const nameEsc = escapeJsString(p.name);
          const blocked = !p.canKeepNextYear || viewOnly;
          const nameStyle = blocked ? 'color:var(--text-dim)' : '';
          const blockedAttr = blocked ? 'disabled' : '';
          const blockedCursor = blocked ? 'not-allowed' : 'pointer';
          const editBtn = isCommishEditMode() && isCommissioner()
            ? ` <button onclick="openCommishEditor('${nameEsc}')" title="Override" style="background:none;border:none;color:var(--accent);cursor:pointer;font-size:0.85rem;padding:0 4px">✏︎</button>`
            : "";
          const overrideBadge = p._commishOverridden
            ? ` <span title="Commish override applied" style="font-size:0.62rem;color:var(--yellow);text-transform:uppercase;font-weight:700">edited</span>`
            : "";
          return `
            <tr style="${rowBg}">
              <td>
                <span class="player-name" style="${nameStyle}">${escapeHtml(p.name)}</span>${injuryTag}${overrideBadge}${editBtn}
                ${workaroundBadgeHtml(p)}
              </td>
              <td>${sourceBadge(p)}</td>
              <td>${priceCell}</td>
              <td>${nextPriceCell}</td>
              <td><span class="contract-tag contract-${escapeHtml(p.contractStatus)}">${p.yearsRemaining != null ? (CURRENT_SEASON + p.yearsRemaining) : escapeHtml(p.contractLabel)}</span></td>
              <td style="text-align:center">
                <input type="checkbox" ${isRule5 ? 'checked' : ''} ${blockedAttr} onchange="toggleEligibleKeeper('${teamId}','${nameEsc}','rule5',this.checked)" style="width:18px;height:18px;cursor:${blockedCursor};accent-color:var(--accent)">
              </td>
              <td style="text-align:center">
                <input type="checkbox" ${isKeeper ? 'checked' : ''} ${blockedAttr} onchange="toggleEligibleKeeper('${teamId}','${nameEsc}','keeper',this.checked)" style="width:18px;height:18px;cursor:${blockedCursor};accent-color:var(--green)">
              </td>
              <td style="text-align:center">
                <input type="checkbox" ${isTradeBlock ? 'checked' : ''} ${blockedAttr} onchange="toggleEligibleKeeper('${teamId}','${nameEsc}','tradeBlock',this.checked)" style="width:18px;height:18px;cursor:${blockedCursor};accent-color:var(--orange)">
              </td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
  `;
}

function promptCallupPrice(playerName, teamId) {
  const yearStr = prompt(`Year ${playerName} was called up?`, String(CURRENT_SEASON));
  if (!yearStr) return;
  const year = parseInt(yearStr);
  if (isNaN(year)) { alert("Invalid year"); return; }
  const priceStr = prompt(`Call-up price for ${playerName}? (top-200 ranked: 1=$1, 2=$3, 3=$5, 4=$10, 5=$15, or enter custom)`, "5");
  if (!priceStr) return;
  let price = parseInt(priceStr);
  if (isNaN(price)) { alert("Invalid price"); return; }
  if (price === 1) price = 1;
  else if (price === 2) price = 3;
  else if (price === 3) price = 5;
  else if (price === 4) price = 10;
  else if (price === 5) price = 15;
  setCallupPriceOverride(playerName, price, year);
  if (teamId) updateEligibleKeepersView();
}

function renderMinorsEligibleTable(minors, teamId, teamSelections) {
  if (!minors.length) return '<p style="color:var(--text-dim)">No minor league players</p>';
  const viewOnly = !canEditTeam(teamId) || (isKeeperLockoutActive() && !isCommissioner());
  return `
    <table class="player-table eligible-keepers-table">
      <thead>
        <tr>
          <th>Player</th>
          <th>Source</th>
          <th>${CURRENT_SEASON} $</th>
          <th>${CURRENT_SEASON + 1} $</th>
          <th>Expiry</th>
          <th style="text-align:center">Rule 5</th>
          <th style="text-align:center">Keep</th>
          <th style="text-align:center">On the Block</th>
        </tr>
      </thead>
      <tbody>
        ${minors.map(p => {
          const sel = teamSelections[p.name] || {};
          const isMinorKeeper = sel.minorKeeper || false;
          const isRule5 = sel.rule5 || false;
          const isTradeBlock = sel.tradeBlock || false;
          let statClass = "";
          if ((p.statType === "AB" && p.careerStat >= 200) || (p.statType === "IP" && p.careerStat >= 50)) statClass = "stat-warning";
          const rowBg = isMinorKeeper ? 'background:rgba(34,197,94,0.08)'
            : isRule5 ? 'background:rgba(59,130,246,0.08)'
            : isTradeBlock ? 'background:rgba(249,115,22,0.08)'
            : '';
          const nameEsc = escapeJsString(p.name);
          // Contract reflects raw years left. "Must Call Up" is shown as a
          // separate badge next to the player's career stat.
          const ms = getMinorLeagueContractStatus(p, CURRENT_SEASON);
          const isKeepable = ms.yearsRemaining === null || ms.yearsRemaining > 0;
          let contractLabel, contractStatusClass;
          if (ms.yearsRemaining !== null) {
            const yrs = ms.yearsRemaining;
            contractLabel = String(CURRENT_SEASON + yrs);
            contractStatusClass = yrs === 0 ? "final" : yrs === 1 ? "expiring" : "mid";
          } else {
            contractLabel = "Call-up + 3";
            contractStatusClass = "new";
          }
          const sourceTag = `<span class="from-minors-tag" style="background:rgba(34,197,94,0.2);color:var(--green)">MiLB (${p.yearAcquired})</span>`;
          const blocked = !isKeepable || viewOnly;
          const nameStyle = blocked ? 'color:var(--text-dim)' : '';
          const blockedAttr = blocked ? 'disabled' : '';
          const blockedCursor = blocked ? 'not-allowed' : 'pointer';
          return `
            <tr style="${rowBg}">
              <td>
                <span class="player-name" style="${nameStyle}">${escapeHtml(p.name)}</span>
                ${p.sendDownCount ? ` <span style="color:var(--red);font-size:0.65rem;font-weight:700">$${p.sendDownCount * 10} fee</span>` : ''}
                <div style="font-size:0.7rem;color:var(--text-dim);margin-top:2px">
                  <span class="${statClass}">${p.careerStat} ${p.statType}</span>
                  ${ms.eligibilityWarning ? ` <span class="hide-on-mobile" style="color:var(--orange);font-weight:700;margin-left:4px">${escapeHtml(ms.eligibilityWarning)}</span>` : ''}
                </div>
              </td>
              <td>${sourceTag}</td>
              <td><span style="color:var(--text-dim)">—</span></td>
              <td><span style="color:var(--text-dim)">—</span></td>
              <td><span class="contract-tag contract-${contractStatusClass}">${contractLabel}</span></td>
              <td style="text-align:center">
                <input type="checkbox" ${isRule5 ? 'checked' : ''} ${blockedAttr} onchange="toggleEligibleKeeper('${teamId}','${nameEsc}','rule5',this.checked)" style="width:18px;height:18px;cursor:${blockedCursor};accent-color:var(--accent)">
              </td>
              <td style="text-align:center">
                <input type="checkbox" ${isMinorKeeper ? 'checked' : ''} ${blockedAttr} onchange="toggleEligibleKeeper('${teamId}','${nameEsc}','minorKeeper',this.checked)" style="width:18px;height:18px;cursor:${blockedCursor};accent-color:var(--green)">
              </td>
              <td style="text-align:center">
                <input type="checkbox" ${isTradeBlock ? 'checked' : ''} ${blockedAttr} onchange="toggleEligibleKeeper('${teamId}','${nameEsc}','tradeBlock',this.checked)" style="width:18px;height:18px;cursor:${blockedCursor};accent-color:var(--orange)">
              </td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
    <div style="font-size:0.72rem;color:var(--text-dim);margin-top:6px">Pressing Keep auto-protects via Rule 5. Unchecking Rule 5 unkeeps.</div>
  `;
}

function toggleEligibleKeeper(teamId, playerName, field, checked) {
  // Defense in depth: UI hides edit controls for non-owners but a stray click /
  // dev tools tweak shouldn't be able to corrupt another team's selections.
  if (typeof canEditTeam === "function" && !canEditTeam(teamId)) {
    if (typeof updateEligibleKeepersView === "function") updateEligibleKeepersView();
    return;
  }
  // Lockout enforcement: past the keeper deadline, only commish can edit.
  if (typeof isKeeperLockoutActive === "function" && isKeeperLockoutActive() && !isCommissioner()) {
    if (typeof showToast === "function") showToast("Keepers are locked. Contact a commissioner to make changes.", "warn");
    if (typeof updateEligibleKeepersView === "function") updateEligibleKeepersView();
    return;
  }
  const selections = getEligibleKeeperSelections();
  if (!selections[teamId]) selections[teamId] = {};
  if (!selections[teamId][playerName]) selections[teamId][playerName] = {};

  const wasRule5 = !!selections[teamId][playerName].rule5;
  selections[teamId][playerName][field] = checked;

  // Keep ↔ Rule 5 cascade for ML and MILB alike:
  //   - Pressing any Keep box auto-protects via Rule 5
  //   - Unchecking Rule 5 also unkeeps (both ML and MILB)
  // Caps (8 ML / 10 MiL / 25 Rule 5) are enforced visually (red number in
  // the summary bar) rather than by blocking selections.
  if ((field === 'keeper' || field === 'minorKeeper') && checked) {
    selections[teamId][playerName].rule5 = true;
  }
  if (field === 'rule5' && !checked) {
    selections[teamId][playerName].keeper = false;
    selections[teamId][playerName].minorKeeper = false;
  }

  // Activity logging — fire-and-forget.
  if (typeof logActivityAsync === "function") {
    const fieldToType = {
      keeper:       checked ? "keeper_added" : "keeper_removed",
      minorKeeper:  checked ? "minor_keeper_added" : "minor_keeper_removed",
      rule5:        checked ? "rule5_added" : "rule5_removed",
      tradeBlock:   checked ? "trade_block_added" : "trade_block_removed",
    };
    const evtType = fieldToType[field];
    if (evtType) {
      logActivityAsync(evtType, { player_name: playerName }, { targetTeamId: teamId });
    }
    // If Rule 5 auto-flipped on a keeper press, log that too (so the cascade is visible).
    if ((field === "keeper" || field === "minorKeeper") && checked && !wasRule5) {
      logActivityAsync("rule5_added", { player_name: playerName, via_cascade: true }, { targetTeamId: teamId });
    }
  }

  const flags = { ...(selections[teamId][playerName] || {}) };
  const allEmpty = !flags.keeper && !flags.minorKeeper && !flags.tradeBlock && !flags.rule5;
  if (allEmpty) delete selections[teamId][playerName];

  if (typeof setKeeperSelectionAsync === "function") {
    setKeeperSelectionAsync(teamId, playerName, allEmpty ? {} : flags)
      .catch(err => {
        alert("Save failed: " + err.message);
        // setKeeperSelectionAsync reverted the cache — re-render to match.
        if (typeof updateEligibleKeepersView === "function") updateEligibleKeepersView();
      });
  } else {
    saveEligibleKeeperSelections(selections);
  }

  if (typeof updateEligibleKeepersView === "function") updateEligibleKeepersView();
}

function renderAllTeamsEligibleSummary(container) {
  const selections = getEligibleKeeperSelections();

  const dollarBalances = getDraftDollarBalances();
  container.innerHTML = getDisplayOrderedTeams().map(team => {
    const players = getEligiblePlayers(team);
    const teamSel = selections[team.id] || {};
    // Only count players who CAN actually be kept next year.
    const keepers = players.filter(p => p.canKeepNextYear && teamSel[p.name]?.keeper);
    const tradeBlock = [...players, ...team.minors].filter(p => teamSel[p.name]?.tradeBlock);
    const rule5 = team.minors.filter(p => teamSel[p.name]?.rule5);
    const keeperCost = keepers.reduce((s, p) => s + (p.nextYearPrice || 0), 0);
    const draftDollars = dollarBalances[team.id] ?? 260;

    return `
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:14px;margin-bottom:10px;cursor:pointer" onclick="document.getElementById('eligible-team-select').value='${team.id}';updateEligibleKeepersView()">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <span style="font-weight:700;color:var(--text-bright);font-size:1.05rem">${team.name}</span>
          <span style="color:${keepers.length === 8 ? 'var(--green)' : keepers.length === 0 ? 'var(--text-dim)' : 'var(--yellow)'};font-weight:700">${keepers.length}/8 keepers</span>
        </div>
        ${keepers.length ? `
          <div style="font-size:0.82rem;color:var(--text-dim);margin-bottom:4px">
            <span style="color:var(--green);font-weight:600">$${keeperCost}</span> keeper cost
            &middot; <span style="color:var(--accent);font-weight:600">$${draftDollars}</span> draft dollars
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin-top:6px">
            <span style="font-size:0.7rem;color:var(--text-dim);font-weight:700;text-transform:uppercase;letter-spacing:0.05em">Keepers:</span>
            ${keepers.map(p => `<span style="font-size:0.75rem;background:rgba(34,197,94,0.15);color:var(--green);padding:2px 8px;border-radius:10px">${escapeHtml(p.name)} ${p.nextYearPrice != null ? `$${p.nextYearPrice}` : '$TBD'}</span>`).join('')}
          </div>
        ` : '<div style="font-size:0.82rem;color:var(--text-dim)">No keepers selected yet</div>'}
        ${tradeBlock.length ? `
          <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px;align-items:center">
            <span style="font-size:0.7rem;color:var(--text-dim);font-weight:700;text-transform:uppercase;letter-spacing:0.05em">Trade Block:</span>
            ${tradeBlock.map(p => `<span style="font-size:0.72rem;background:rgba(249,115,22,0.15);color:var(--orange);padding:2px 7px;border-radius:10px">${escapeHtml(p.name)}</span>`).join('')}
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}


// --- Minor League Draft ---

const DRAFT_YEAR = 2027;
const DRAFT_ROUNDS = 7;
// Default draft order: lowest 2026 keeper cost picks first (proxy for worst finish - editable).
const DEFAULT_DRAFT_ORDER = [
  "glicksman", "zack", "matt", "saxton", "corey", "dave",
  "aj", "josh-doug", "sam", "larry", "jesse", "jeff"
];

// --- Draft clock ---
//
// 4-hour clock per pick that only ticks during active ET hours (8 AM to
// midnight). Overnight (midnight to 8 AM ET) is automatically paused.
// Commissioners can also pause/resume manually.
const DRAFT_CLOCK_MS = 4 * 60 * 60 * 1000;
const DRAFT_ACTIVE_START_HOUR = 8;  // 8 AM ET
const DRAFT_ACTIVE_END_HOUR = 24;   // midnight ET (exclusive)
let _draftClockInterval = null;
let _draftAutoPassAttemptedAt = null; // throttle commish auto-pass attempts

// Get the wall-clock date/time in America/New_York for a given UTC ms.
function _getETParts(utcMs) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", second: "numeric",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(utcMs));
  const get = (t) => parseInt(parts.find(p => p.type === t).value, 10);
  let hour = get("hour");
  // Some locales report midnight as 24 instead of 0 when hour12:false.
  if (hour === 24) hour = 0;
  return {
    year: get("year"),
    month: get("month"),  // 1-indexed
    day: get("day"),
    hour,
    minute: get("minute"),
    second: get("second"),
  };
}

// Convert an ET wall-clock date+time to a UTC ms. DST-aware via fixed-point
// iteration: build a naive UTC, check what ET it represents, adjust by the
// difference, repeat. Converges in 1-2 iterations.
function _etMsAt(year, month, day, hour, minute) {
  let utc = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 3; i++) {
    const et = _getETParts(utc);
    const etUtcEquiv = Date.UTC(et.year, et.month - 1, et.day, et.hour, et.minute);
    const diff = Date.UTC(year, month - 1, day, hour, minute) - etUtcEquiv;
    if (diff === 0) break;
    utc += diff;
  }
  return utc;
}

// Active draft time elapsed between two UTC ms, skipping overnight blackout
// (midnight to 8 AM ET).
function activeDraftElapsedMs(fromMs, toMs) {
  if (toMs <= fromMs) return 0;
  let total = 0;
  let cursor = fromMs;
  for (let iter = 0; iter < 40 && cursor < toMs; iter++) {
    const et = _getETParts(cursor);
    const isActive = et.hour >= DRAFT_ACTIVE_START_HOUR && et.hour < DRAFT_ACTIVE_END_HOUR;
    const segmentEnd = isActive
      ? _etMsAt(et.year, et.month, et.day + 1, 0, 0)  // next midnight ET
      : _etMsAt(et.year, et.month, et.day, DRAFT_ACTIVE_START_HOUR, 0);  // today's 8 AM ET
    const effectiveEnd = Math.min(segmentEnd, toMs);
    if (isActive) total += effectiveEnd - cursor;
    cursor = effectiveEnd;
  }
  return total;
}

// Returns true if `nowMs` is in the overnight blackout window (midnight–8 AM ET).
function isDraftOvernightBlackout(nowMs) {
  const et = _getETParts(nowMs);
  return et.hour < DRAFT_ACTIVE_START_HOUR;
}

// Snapshot of clock state at a moment in time.
function computeDraftClockState(draft, nowMs) {
  const clock = draft && draft.clock;
  if (!clock || !clock.startedAt) {
    return { running: false, started: false, paused: false, remainingMs: DRAFT_CLOCK_MS, expired: false };
  }
  const startedAt = new Date(clock.startedAt).getTime();
  const paused = !!clock.paused;
  const pausedAt = clock.pausedAt ? new Date(clock.pausedAt).getTime() : null;
  const referenceMs = paused && pausedAt ? pausedAt : nowMs;
  const elapsed = activeDraftElapsedMs(startedAt, referenceMs);
  const remainingMs = Math.max(0, DRAFT_CLOCK_MS - elapsed);
  const overnight = !paused && isDraftOvernightBlackout(nowMs);
  return {
    started: true,
    paused,
    overnight,
    running: !paused && !overnight && remainingMs > 0,
    expired: remainingMs <= 0,
    remainingMs,
    startedAt,
    pausedAt,
  };
}

function _normalizeDraft(stored) {
  stored.rounds = DRAFT_ROUNDS;
  stored.picks = (stored.picks || []).filter(p => p.round <= DRAFT_ROUNDS);
  stored.passed = (stored.passed || []).filter(p => p.round <= DRAFT_ROUNDS);
  Object.keys(stored.tradedPicks || {}).forEach(k => {
    if (parseInt(k.split("p")[0], 10) > DRAFT_ROUNDS) delete stored.tradedPicks[k];
  });
  if (!stored.clock) stored.clock = { startedAt: null, paused: false, pausedAt: null };
  return stored;
}

function getDraft() {
  let stored = null;
  if (typeof dbGetDraft === "function") {
    stored = dbGetDraft();
  } else {
    try { stored = JSON.parse(localStorage.getItem("flm_draft_2027") || "null"); } catch {}
  }
  if (stored && stored.baseOrder && stored.baseOrder.length === 12) return _normalizeDraft(stored);
  return {
    year: DRAFT_YEAR,
    rounds: DRAFT_ROUNDS,
    type: "straight",
    baseOrder: DEFAULT_DRAFT_ORDER.slice(),
    tradedPicks: {},
    picks: [],
    passed: [],
    clock: { startedAt: null, paused: false, pausedAt: null },
  };
}

function saveDraft(draft) {
  if (typeof saveDraftAsync === "function") {
    saveDraftAsync(draft).catch(err => alert("Save failed: " + err.message));
  } else {
    localStorage.setItem("flm_draft_2027", JSON.stringify(draft));
  }
}

function getBaseOwner(draft, round, pickInRound) {
  if (draft.type === "snake" && round % 2 === 0) {
    return draft.baseOrder[draft.baseOrder.length - pickInRound];
  }
  return draft.baseOrder[pickInRound - 1];
}

// Parse a trade-log milb_pick value like "2027 1st round" → { year, round }.
// Returns null if a round number can't be extracted.
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

// Walk the trade log and apply chained transfers of the round-R pick that
// originally belonged to baseOwner. Returns the final owner (== baseOwner if untouched).
function getTradeLogOwner(round, draftYear, baseOwner) {
  const trades = (typeof dbGetTrades === "function")
    ? dbGetTrades()
    : (() => { try { return JSON.parse(localStorage.getItem("flm_trades") || "[]"); } catch { return []; } })();
  let owner = baseOwner;
  for (const trade of trades) {
    const sides = [
      { receives: trade.team1Receives, fromTeam: trade.team2, toTeam: trade.team1 },
      { receives: trade.team2Receives, fromTeam: trade.team1, toTeam: trade.team2 }
    ];
    for (const side of sides) {
      for (const asset of (side.receives || [])) {
        if (asset.type !== "milb_pick") continue;
        // New trades store structured pickRound/pickOriginalOwner/pickYear. Older trades fall back to parsing.
        const pickRound = asset.pickRound ?? parseMilbPickValue(asset.value)?.round;
        const pickYear  = asset.pickYear  ?? parseMilbPickValue(asset.value)?.year;
        const pickOriginalOwner = asset.pickOriginalOwner;
        if (!pickRound || pickRound !== round) continue;
        // Require an explicit year match — apply only to the matching draft.
        if (!pickYear || pickYear !== draftYear) continue;
        // Structured trades pinpoint exactly which slot — only apply to the matching baseOwner.
        if (pickOriginalOwner && pickOriginalOwner !== baseOwner) continue;
        if (side.fromTeam === owner) owner = side.toTeam;
      }
    }
  }
  return owner;
}

function getPickOwner(draft, round, pickInRound) {
  const key = `${round}p${pickInRound}`;
  if (draft.tradedPicks[key]) return draft.tradedPicks[key];
  const base = getBaseOwner(draft, round, pickInRound);
  return getTradeLogOwner(round, draft.year, base);
}

function getCurrentPickInfo(draft) {
  const teamsCount = draft.baseOrder.length;
  const totalSlots = draft.rounds * teamsCount;
  const passed = draft.passed || [];
  const isMade = (r, p) => draft.picks.some(x => x.round === r && x.pickInRound === p);
  const isPassed = (r, p) => passed.some(x => x.round === r && x.pickInRound === p);
  for (let i = 0; i < totalSlots; i++) {
    const round = Math.floor(i / teamsCount) + 1;
    const pickInRound = (i % teamsCount) + 1;
    if (!isMade(round, pickInRound) && !isPassed(round, pickInRound)) {
      return { round, pickInRound, team: getPickOwner(draft, round, pickInRound), overall: i + 1 };
    }
  }
  return null;
}

function renderDraftView() {
  const commish = isCommissioner();
  const setupBtn = commish
    ? `<button class="trade-btn trade-btn-cancel" id="dv-btn-setup" onclick="showDraftOrderSetup()">Order / Traded Picks</button>`
    : "";
  const resetBtn = commish
    ? `<button class="trade-btn trade-btn-cancel" onclick="resetDraftConfirm()" style="margin-left:auto">Reset</button>`
    : "";
  return `
    <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
      <button class="trade-btn" id="dv-btn-board" onclick="showDraftBoard()">Draft Board</button>
      ${setupBtn}
      ${resetBtn}
    </div>
    <div id="prospect-status" style="font-size:0.75rem;color:var(--text-dim);margin-bottom:14px"></div>
    <div id="draft-content"></div>
  `;
}

function renderProspectStatus() {
  const el = document.getElementById("prospect-status");
  if (!el) return;
  const meta = getProspectCacheMeta();
  if (!meta) {
    el.innerHTML = `<span style="color:var(--yellow)">No prospect list cached.</span> <button onclick="kickOffProspectRefresh()" style="background:none;border:none;color:var(--accent);cursor:pointer;text-decoration:underline;font-size:0.75rem">Load from MLB Stats API</button>`;
    return;
  }
  const ageHours = Math.round((Date.now() - meta.fetchedAt) / 3600000);
  const ageText = ageHours < 1 ? "just now" : ageHours < 24 ? `${ageHours}h ago` : `${Math.floor(ageHours/24)}d ago`;
  const staleBadge = meta.isStale ? ' <span style="color:var(--orange)">(stale)</span>' : '';
  const c = meta.counts || {};
  const breakdown = c.milb != null ? ` · ${c.milb} MiLB · ${c.mlbEligible} MLB-eligible · ${(c.draftCurrent || 0) + (c.draftNext || 0) + (c.draftPrev || 0)} draft` : '';
  el.innerHTML = `<span>${c.total || 0} prospects loaded (${ageText}${staleBadge})${breakdown}</span> <button onclick="kickOffProspectRefresh()" style="background:none;border:none;color:var(--accent);cursor:pointer;text-decoration:underline;font-size:0.75rem;margin-left:6px">Refresh</button>`;
}

async function kickOffProspectRefresh() {
  const el = document.getElementById("prospect-status");
  const update = msg => { if (el) el.innerHTML = `<span style="color:var(--accent)">${msg}</span>`; };
  update("Fetching prospects from MLB Stats API...");
  try {
    await refreshProspectCache(update);
    renderProspectStatus();
    // Refresh current view so datalist picks up the new names
    if (currentView === "draft") {
      const active = document.getElementById("dv-btn-setup")?.classList.contains("trade-btn-cancel") ? "board" : "setup";
      if (active === "board") showDraftBoard();
    }
  } catch (e) {
    if (el) el.innerHTML = `<span style="color:var(--red)">Failed to load prospects: ${escapeHtml(String(e.message || e))}</span> <button onclick="kickOffProspectRefresh()" style="background:none;border:none;color:var(--accent);cursor:pointer;text-decoration:underline;font-size:0.75rem">Retry</button>`;
  }
}

function resetDraftConfirm() {
  if (!isCommissioner()) {
    alert("Only a commissioner can reset the draft.");
    return;
  }
  if (!confirm("Reset the entire 2027 draft? All picks and order customizations will be lost.")) return;
  if (typeof saveDraftAsync === "function") {
    saveDraftAsync(null)
      .then(() => {
        if (typeof logActivityAsync === "function") logActivityAsync("minors_draft_reset", {});
        switchTab("draft");
      })
      .catch(err => alert("Reset failed: " + err.message));
  } else {
    localStorage.removeItem("flm_draft_2027");
    switchTab("draft");
  }
}

function setDraftButtonActive(which) {
  const b = document.getElementById("dv-btn-board");
  const s = document.getElementById("dv-btn-setup");
  if (!b || !s) return;
  b.classList.toggle("trade-btn-cancel", which !== "board");
  s.classList.toggle("trade-btn-cancel", which !== "setup");
}

function showDraftBoard() {
  setDraftButtonActive("board");
  const draft = getDraft();
  const container = document.getElementById("draft-content");
  const current = getCurrentPickInfo(draft);
  const teamsCount = draft.baseOrder.length;
  const totalPicks = draft.rounds * teamsCount;

  let html = "";

  if (current) {
    const team = LEAGUE_DATA.teams.find(t => t.id === current.team);
    const myTeam = (typeof currentOwner !== "undefined" && currentOwner) ? currentOwner.team_id : null;
    const canSubmit = current.team === myTeam || isCommissioner();
    const commish = isCommissioner();
    const inputBlock = canSubmit ? `
        <input type="text" id="draft-player-name" placeholder="Player name (type to search, or enter a new name)" autocomplete="off" list="prospect-suggestions"
          style="width:100%;background:var(--bg);color:var(--text);border:1px solid var(--border);padding:10px;border-radius:6px;font-size:0.95rem;margin-top:10px">
        <datalist id="prospect-suggestions">
          ${getAvailableProspects().map(n => `<option value="${escapeHtml(n)}"></option>`).join("")}
        </datalist>
        <input type="text" id="draft-player-notes" placeholder="Notes: position, school/team, age, org (e.g. SS, HS, 18)"
          style="width:100%;background:var(--bg);color:var(--text);border:1px solid var(--border);padding:8px;border-radius:6px;font-size:0.85rem;margin-top:6px">
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
          <button class="trade-btn trade-btn-submit" onclick="makeDraftPick()">Submit Pick</button>
          ${commish ? `<button class="trade-btn trade-btn-cancel" onclick="passCurrentPick()" style="font-size:0.85rem">Pass</button>` : ""}
          ${commish && draft.picks.length ? `<button class="trade-btn trade-btn-cancel" onclick="undoLastPick()" style="font-size:0.85rem">Undo Last Pick</button>` : ""}
        </div>
    ` : `
        <div style="margin-top:10px;color:var(--text-dim);font-size:0.85rem;font-style:italic">
          Waiting on ${team ? escapeHtml(team.name) : escapeHtml(current.team)} to make a pick.
        </div>
    `;
    html += `
      <div class="keeper-projection" style="background:rgba(59,130,246,0.1);border-color:var(--accent);margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px">
          <h3 style="margin:0">On the Clock: <span style="color:var(--accent)">${team ? escapeHtml(team.name) : escapeHtml(current.team)}</span></h3>
          <span style="color:var(--text-dim);font-size:0.82rem">Round ${current.round} &middot; Pick ${current.pickInRound} (Overall #${current.overall})</span>
        </div>
        ${renderDraftClockBlock(draft, commish)}
        ${inputBlock}
      </div>
    `;
  } else {
    const pendingPasses = (draft.passed || []).length;
    html += `
      <div class="keeper-projection" style="background:rgba(34,197,94,0.1);border-color:var(--green);margin-bottom:14px">
        <h3 style="margin:0;color:var(--green)">${pendingPasses ? "Regular Rounds Complete" : "Draft Complete"}</h3>
        <div style="color:var(--text-dim);font-size:0.85rem;margin-top:6px">All ${totalPicks} regular slots filled${pendingPasses ? `. ${pendingPasses} passed pick${pendingPasses === 1 ? "" : "s"} still pending below.` : "."}</div>
        ${draft.picks.length ? `<button class="trade-btn trade-btn-cancel" onclick="undoLastPick()" style="font-size:0.85rem;margin-top:10px">Undo Last Pick</button>` : ""}
      </div>
    `;
  }

  html += `<div class="section-header">Draft Board <span class="section-count">${draft.picks.length}/${totalPicks}</span></div>`;
  html += renderDraftBoard(draft);
  html += renderPassedPicksSection(draft);

  container.innerHTML = html;

  const input = document.getElementById("draft-player-name");
  // Auto-focus only on devices with a fine pointer (mouse). On touch devices,
  // focusing pops the keyboard + autocomplete dropdown immediately on view
  // load, which is jarring.
  if (input && window.matchMedia?.("(pointer: fine)").matches) input.focus();
  if (input) input.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); makeDraftPick(); }
  });

  _startDraftClockTicker();
}

// Renders the clock area inside the "On the Clock" card. The remaining-time
// number has id="draft-clock-time" so the per-second tick can update it
// without re-rendering the whole board.
function renderDraftClockBlock(draft, isCommish) {
  const state = computeDraftClockState(draft, Date.now());
  const controls = isCommish ? renderDraftClockControls(state) : "";
  if (!state.started) {
    return `
      <div style="margin-top:10px;padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:6px;display:flex;flex-wrap:wrap;align-items:center;gap:10px">
        <span id="draft-clock-time" style="color:var(--text-dim);font-size:0.88rem">Clock not started</span>
        <span style="color:var(--text-dim);font-size:0.72rem;flex:1;min-width:140px">4 hour pick clock, pauses overnight (midnight–8 AM ET)</span>
        ${controls}
      </div>`;
  }
  return `
    <div style="margin-top:10px;padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:6px;display:flex;flex-wrap:wrap;align-items:center;gap:10px">
      <span id="draft-clock-time" style="font-size:1rem;font-weight:700;min-width:160px">${formatDraftClockText(state)}</span>
      <span id="draft-clock-status" style="color:var(--text-dim);font-size:0.72rem;flex:1;min-width:120px">${draftClockStatusText(state)}</span>
      ${controls}
    </div>`;
}

function renderDraftClockControls(state) {
  if (!state.started) {
    return `<button class="trade-btn" onclick="startDraftClock()" style="font-size:0.78rem;padding:5px 10px">Start Clock</button>`;
  }
  if (state.paused) {
    return `<button class="trade-btn" onclick="resumeDraftClock()" style="font-size:0.78rem;padding:5px 10px">Resume</button>`;
  }
  return `<button class="trade-btn trade-btn-cancel" onclick="pauseDraftClock()" style="font-size:0.78rem;padding:5px 10px">Pause</button>`;
}

function formatDraftClockText(state) {
  if (!state.started) return "Clock not started";
  const totalSec = Math.max(0, Math.floor(state.remainingMs / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return `${h}:${mm}:${ss}`;
}

function draftClockStatusText(state) {
  if (!state.started) return "Clock not started";
  if (state.expired) return "Expired — auto-skipping…";
  if (state.paused) return "Paused by commissioner";
  if (state.overnight) return "Overnight pause — resumes 8 AM ET";
  return "Time remaining";
}

function _startDraftClockTicker() {
  if (_draftClockInterval) { clearInterval(_draftClockInterval); _draftClockInterval = null; }
  // Only run while the user is on the draft tab.
  if (typeof currentView !== "undefined" && currentView !== "draft") return;
  _draftClockInterval = setInterval(_tickDraftClock, 1000);
}

function _stopDraftClockTicker() {
  if (_draftClockInterval) { clearInterval(_draftClockInterval); _draftClockInterval = null; }
}

function _tickDraftClock() {
  const timeEl = document.getElementById("draft-clock-time");
  const statusEl = document.getElementById("draft-clock-status");
  if (!timeEl) {
    // DOM not present (different tab / no current pick) — stop ticking.
    _stopDraftClockTicker();
    return;
  }
  const draft = getDraft();
  const current = getCurrentPickInfo(draft);
  if (!current) {
    _stopDraftClockTicker();
    return;
  }
  const state = computeDraftClockState(draft, Date.now());
  timeEl.textContent = formatDraftClockText(state);
  if (statusEl) statusEl.textContent = draftClockStatusText(state);
  // Color the time text: red when expired, orange under 30min, default otherwise.
  if (state.expired) timeEl.style.color = "var(--red)";
  else if (state.remainingMs < 30 * 60 * 1000) timeEl.style.color = "var(--orange)";
  else timeEl.style.color = "var(--text-bright)";

  if (state.expired) _maybeAutoPassExpiredPick();
}

function renderDraftBoard(draft) {
  const teamsCount = draft.baseOrder.length;
  const picksMap = {};
  draft.picks.forEach(p => { picksMap[`${p.round}p${p.pickInRound}`] = p; });
  const passedSet = new Set((draft.passed || []).map(p => `${p.round}p${p.pickInRound}`));
  const current = getCurrentPickInfo(draft);
  const commishCanEdit = isCommissioner();

  // Mobile vertical layout — one row per pick, top to bottom (1.1, 1.2, 1.3, ...).
  // CSS hides this on desktop and the matrix table on mobile.
  let mobileHtml = '<div class="draft-list-mobile">';
  for (let round = 1; round <= draft.rounds; round++) {
    for (let pickInRound = 1; pickInRound <= teamsCount; pickInRound++) {
      const ownerId = getPickOwner(draft, round, pickInRound);
      const owner = LEAGUE_DATA.teams.find(t => t.id === ownerId);
      const pick = picksMap[`${round}p${pickInRound}`];
      const isPassed = passedSet.has(`${round}p${pickInRound}`);
      const isCurrent = current && current.round === round && current.pickInRound === pickInRound;
      const isTraded = ownerId !== getBaseOwner(draft, round, pickInRound);
      let rowClass = "draft-pick-row";
      if (isCurrent) rowClass += " current";
      else if (pick) rowClass += " made";
      else if (isPassed) rowClass += " passed";
      const clickAttr = commishCanEdit ? `onclick="openPickEditor(${round},${pickInRound})" style="cursor:pointer"` : "";
      const playerCell = pick
        ? `<span class="pick-player">${escapeHtml(pick.player)}</span>${pick.notes ? `<span class="pick-notes">${escapeHtml(pick.notes)}</span>` : ""}`
        : isCurrent
          ? '<span class="pick-status current">On clock</span>'
          : isPassed
            ? '<span class="pick-status passed">PASSED</span>'
            : '<span class="pick-status">—</span>';
      mobileHtml += `<div class="${rowClass}" ${clickAttr}>
        <span class="pick-id">${round}.${pickInRound}</span>
        <span class="pick-team">${owner ? owner.name : ownerId}${isTraded ? ' <span class="pick-traded">(T)</span>' : ''}</span>
        <span class="pick-content">${playerCell}</span>
      </div>`;
    }
  }
  mobileHtml += '</div>';

  // Fixed table layout + 100% width lets the 12 team columns flex to fit the
  // viewport (no horizontal scroll on PC). Cells wrap long player names.
  const teamColPct = (100 / teamsCount).toFixed(2);
  let html = mobileHtml + `<div class="draft-board-desktop" style="overflow-x:auto;-webkit-overflow-scrolling:touch">
    <table class="player-table" style="width:100%;table-layout:fixed;font-size:0.76rem">
    <colgroup><col style="width:34px">${Array.from({length:teamsCount}, () => `<col style="width:${teamColPct}%">`).join("")}</colgroup>
    <thead><tr>
      <th style="position:sticky;left:0;background:var(--bg);z-index:2;text-align:center;padding:5px 2px">Rd</th>`;
  for (let i = 1; i <= teamsCount; i++) {
    html += `<th style="font-size:0.62rem;padding:5px 4px;text-align:center">#${i}</th>`;
  }
  html += `</tr></thead><tbody>`;

  for (let round = 1; round <= draft.rounds; round++) {
    html += `<tr>
      <td style="position:sticky;left:0;background:var(--bg-card);z-index:1;font-weight:700;color:var(--text-bright);text-align:center;padding:4px 2px">R${round}</td>`;
    for (let pickInRound = 1; pickInRound <= teamsCount; pickInRound++) {
      const ownerId = getPickOwner(draft, round, pickInRound);
      const owner = LEAGUE_DATA.teams.find(t => t.id === ownerId);
      const pick = picksMap[`${round}p${pickInRound}`];
      const isPassed = passedSet.has(`${round}p${pickInRound}`);
      const isCurrent = current && current.round === round && current.pickInRound === pickInRound;
      const isTraded = ownerId !== getBaseOwner(draft, round, pickInRound);

      let cellStyle = "padding:4px 5px;vertical-align:top;word-wrap:break-word;overflow-wrap:break-word";
      if (commishCanEdit) cellStyle += ";cursor:pointer";
      if (isCurrent) cellStyle += ";background:rgba(59,130,246,0.2);outline:2px solid var(--accent)";
      else if (pick) cellStyle += ";background:rgba(34,197,94,0.06)";
      else if (isPassed) cellStyle += ";background:rgba(249,115,22,0.08)";

      const cellClickAttr = commishCanEdit ? `onclick="openPickEditor(${round},${pickInRound})" title="Click to edit"` : "";
      html += `<td style="${cellStyle}" ${cellClickAttr}>
        <div style="color:var(--accent);font-weight:600;font-size:0.68rem;line-height:1.15">${owner ? owner.name : ownerId}${isTraded ? ' <span style="color:var(--orange);font-size:0.58rem">(T)</span>' : ''}</div>
        ${pick
          ? `<div style="color:var(--text-bright);margin-top:2px;font-weight:600;font-size:0.74rem;line-height:1.2">${escapeHtml(pick.player)}</div>${pick.notes ? `<div style="color:var(--text-dim);font-size:0.62rem;margin-top:1px;line-height:1.15">${escapeHtml(pick.notes)}</div>` : ""}`
          : isCurrent
            ? '<div style="color:var(--text-dim);font-style:italic;margin-top:2px;font-size:0.7rem">On clock</div>'
            : isPassed
              ? '<div style="color:var(--orange);font-size:0.66rem;margin-top:2px;font-weight:600">PASSED</div>'
              : '<div style="color:var(--text-dim);margin-top:2px">—</div>'}
      </td>`;
    }
    html += `</tr>`;
  }
  html += `</tbody></table></div>`;
  return html;
}

function renderPassedPicksSection(draft) {
  const passed = draft.passed || [];
  if (!passed.length) return "";
  const commish = isCommissioner();
  const rows = passed.map(p => {
    const owner = LEAGUE_DATA.teams.find(t => t.id === p.team);
    return `<div style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--bg);border:1px solid var(--border);border-radius:6px;margin-bottom:6px">
      <span style="color:var(--orange);font-size:0.7rem;font-weight:700;min-width:50px">R${p.round}.${p.pickInRound}</span>
      <span style="color:var(--text-bright);font-weight:600;flex:1">${escapeHtml(owner ? owner.name : p.team)}</span>
      ${commish ? `<button class="trade-btn" style="font-size:0.78rem;padding:5px 10px" onclick="activatePassedPick(${p.round},${p.pickInRound})">Activate</button>` : ""}
    </div>`;
  }).join("");
  return `<div class="section-header">Passed Picks <span class="section-count">${passed.length}</span></div>
    <div style="margin-bottom:14px">${rows}</div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

function escapeJsString(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/</g, "\\x3c").replace(/>/g, "\\x3e").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}

function showToast(message, type) {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    container.style.cssText = "position:fixed;top:14px;right:14px;z-index:2000;display:flex;flex-direction:column;gap:6px;pointer-events:none";
    document.body.appendChild(container);
  }
  const toast = document.createElement("div");
  const bg = type === "error" ? "var(--red)" : type === "warn" ? "var(--orange)" : "var(--accent)";
  toast.style.cssText = `background:${bg};color:#fff;padding:10px 14px;border-radius:6px;box-shadow:var(--shadow);font-size:0.85rem;max-width:340px;pointer-events:auto;cursor:pointer;opacity:0;transition:opacity 180ms`;
  toast.textContent = String(message);
  toast.onclick = () => toast.remove();
  container.appendChild(toast);
  requestAnimationFrame(() => { toast.style.opacity = "1"; });
  setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 200);
  }, type === "error" ? 6000 : 3500);
}

function openPickEditor(round, pickInRound) {
  if (!isCommissioner()) {
    // Silent no-op for non-commish; the cell click is no longer wired for them
    // but a stray call (dev tools / direct invocation) shouldn't open the modal.
    return;
  }
  const draft = getDraft();
  const pickKey = `${round}p${pickInRound}`;
  const pickRecord = draft.picks.find(p => p.round === round && p.pickInRound === pickInRound);
  const isPassed = (draft.passed || []).some(p => p.round === round && p.pickInRound === pickInRound);
  const currentOwner = getPickOwner(draft, round, pickInRound);
  const originalOwner = draft.baseOrder[draft.type === "snake" && round % 2 === 0 ? draft.baseOrder.length - pickInRound : pickInRound - 1];
  const showPlayerInput = !!pickRecord || isPassed;

  // Remove any existing modal
  const existing = document.getElementById("pick-editor-modal");
  if (existing) existing.remove();

  const modal = document.createElement("div");
  modal.id = "pick-editor-modal";
  modal.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px";
  modal.onclick = e => { if (e.target === modal) modal.remove(); };

  const teamOpts = LEAGUE_DATA.teams.map(t =>
    `<option value="${t.id}" ${t.id === currentOwner ? "selected" : ""}>${t.name}</option>`
  ).join("");

  const headerLabel = pickRecord ? "Edit Pick" : isPassed ? "Activate Passed Pick" : "Edit Pick";

  modal.innerHTML = `
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:18px;max-width:440px;width:100%;box-shadow:var(--shadow)">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:12px">
        <h3 style="margin:0;color:var(--text-bright)">${headerLabel}</h3>
        <span style="color:var(--text-dim);font-size:0.82rem">Round ${round} &middot; Pick ${pickInRound}</span>
      </div>

      <label style="display:block;margin-bottom:10px">
        <div style="color:var(--text-dim);font-size:0.8rem;margin-bottom:4px">Pick owner</div>
        <select id="pe-team" class="trade-select">${teamOpts}</select>
        <div style="color:var(--text-dim);font-size:0.72rem;margin-top:4px">Original owner: <span style="color:var(--text)">${LEAGUE_DATA.teams.find(t => t.id === originalOwner)?.name || originalOwner}</span></div>
      </label>

      ${showPlayerInput ? `
        <datalist id="pe-prospect-suggestions">
          ${getAvailableProspects().map(n => `<option value="${escapeHtml(n)}"></option>`).join("")}
        </datalist>
        <label style="display:block;margin-bottom:10px">
          <div style="color:var(--text-dim);font-size:0.8rem;margin-bottom:4px">Player</div>
          <input type="text" id="pe-player" list="pe-prospect-suggestions" value="${escapeHtml(pickRecord ? pickRecord.player : "")}"
            placeholder="${pickRecord ? '' : 'Enter player name'}"
            style="width:100%;background:var(--bg);color:var(--text);border:1px solid var(--border);padding:8px;border-radius:6px">
        </label>
        <label style="display:block;margin-bottom:10px">
          <div style="color:var(--text-dim);font-size:0.8rem;margin-bottom:4px">Notes</div>
          <input type="text" id="pe-notes" value="${escapeHtml(pickRecord ? (pickRecord.notes || "") : "")}"
            style="width:100%;background:var(--bg);color:var(--text);border:1px solid var(--border);padding:8px;border-radius:6px">
        </label>
      ` : `
        <div style="color:var(--text-dim);font-size:0.82rem;font-style:italic;margin-bottom:10px">This pick has not been made yet.</div>
      `}

      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px">
        <button class="trade-btn trade-btn-submit" onclick="savePickEditor(${round},${pickInRound})">${isPassed && !pickRecord ? "Submit Pick" : "Save"}</button>
        <button class="trade-btn trade-btn-cancel" onclick="document.getElementById('pick-editor-modal').remove()">Cancel</button>
        ${pickRecord ? `<button class="trade-btn" style="background:var(--red);margin-left:auto" onclick="deletePickFromEditor(${round},${pickInRound})">Delete Pick</button>` : ""}
        ${isPassed && !pickRecord ? `<button class="trade-btn trade-btn-cancel" style="margin-left:auto" onclick="unpassPickFromEditor(${round},${pickInRound})">Un-pass</button>` : ""}
        ${currentOwner !== originalOwner ? `<button class="trade-btn trade-btn-cancel" style="margin-left:auto" onclick="clearPickOverride(${round},${pickInRound})">Reset to Original Owner</button>` : ""}
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

function savePickEditor(round, pickInRound) {
  const draft = getDraft();
  const pickKey = `${round}p${pickInRound}`;
  const newTeam = document.getElementById("pe-team").value;
  const originalOwner = draft.baseOrder[draft.type === "snake" && round % 2 === 0 ? draft.baseOrder.length - pickInRound : pickInRound - 1];

  if (newTeam === originalOwner) {
    delete draft.tradedPicks[pickKey];
  } else {
    draft.tradedPicks[pickKey] = newTeam;
  }

  const pickRecord = draft.picks.find(p => p.round === round && p.pickInRound === pickInRound);
  const passedIndex = (draft.passed || []).findIndex(p => p.round === round && p.pickInRound === pickInRound);
  const playerEl = document.getElementById("pe-player");
  const notesEl = document.getElementById("pe-notes");
  const newPlayer = playerEl ? playerEl.value.trim() : "";
  const newNotes = notesEl ? notesEl.value.trim() : "";

  if (pickRecord) {
    if (newPlayer) {
      pickRecord.player = newPlayer;
      if (typeof addCustomProspect === "function") addCustomProspect(newPlayer);
    }
    pickRecord.notes = newNotes;
    pickRecord.team = newTeam;
  } else if (passedIndex !== -1) {
    if (!newPlayer) { alert("Enter a player name to activate this pick"); return; }
    if (typeof addCustomProspect === "function") addCustomProspect(newPlayer);
    draft.picks.push({
      round, pickInRound,
      overall: (round - 1) * draft.baseOrder.length + pickInRound,
      team: newTeam,
      player: newPlayer,
      notes: newNotes,
      timestamp: Date.now()
    });
    draft.passed.splice(passedIndex, 1);
  }

  saveDraft(draft);
  document.getElementById("pick-editor-modal").remove();
  showDraftBoard();
}

function unpassPickFromEditor(round, pickInRound) {
  const draft = getDraft();
  if (!draft.passed) return;
  draft.passed = draft.passed.filter(p => !(p.round === round && p.pickInRound === pickInRound));
  saveDraft(draft);
  document.getElementById("pick-editor-modal").remove();
  showDraftBoard();
}

function clearPickOverride(round, pickInRound) {
  const draft = getDraft();
  const pickKey = `${round}p${pickInRound}`;
  const originalOwner = draft.baseOrder[draft.type === "snake" && round % 2 === 0 ? draft.baseOrder.length - pickInRound : pickInRound - 1];
  // Force the pick back to its original owner. We write an explicit override
  // (rather than delete) because trade-log-derived ownership would otherwise
  // re-route the pick on the next render.
  draft.tradedPicks[pickKey] = originalOwner;
  const pickRecord = draft.picks.find(p => p.round === round && p.pickInRound === pickInRound);
  if (pickRecord) pickRecord.team = originalOwner;
  saveDraft(draft);
  document.getElementById("pick-editor-modal").remove();
  showDraftBoard();
}

function deletePickFromEditor(round, pickInRound) {
  if (!confirm("Delete this pick? Subsequent picks will stay the same, but this slot will be open again.")) return;
  const draft = getDraft();
  draft.picks = draft.picks.filter(p => !(p.round === round && p.pickInRound === pickInRound));
  saveDraft(draft);
  document.getElementById("pick-editor-modal").remove();
  showDraftBoard();
}

function makeDraftPick() {
  const draft = getDraft();
  const current = getCurrentPickInfo(draft);
  if (!current) return;
  // Only the team currently on the clock OR a commissioner can submit a pick.
  const myTeam = (typeof currentOwner !== "undefined" && currentOwner) ? currentOwner.team_id : null;
  if (current.team !== myTeam && !isCommissioner()) {
    alert("Only the team on the clock (or a commissioner) can submit this pick.");
    return;
  }
  const nameEl = document.getElementById("draft-player-name");
  const notesEl = document.getElementById("draft-player-notes");
  const player = (nameEl.value || "").trim();
  const notes = (notesEl.value || "").trim();
  if (!player) { alert("Enter a player name"); nameEl.focus(); return; }

  // Roster spot enforcement (toggle in Settings). A Minors Draft pick fills
  // a 10-man MiL slot; the team must have an open one. Trades or call-ups
  // mid-draft can open a slot.
  if (isMinorsRosterEnforcementEnabled() && getTeamMilCount(current.team) >= MIL_ROSTER_MAX) {
    alert(`No open minors spot (${MIL_ROSTER_MAX}-man cap). Open one via trade or by calling up a minor leaguer, or commissioner can pass.`);
    return;
  }

  // Remember any new name the user typed so it appears in future suggestions
  if (typeof addCustomProspect === "function") addCustomProspect(player);

  draft.picks.push({
    round: current.round,
    pickInRound: current.pickInRound,
    overall: current.overall,
    team: current.team,
    player,
    notes,
    timestamp: Date.now()
  });
  _resetDraftClock(draft);
  saveDraft(draft);
  if (typeof logActivityAsync === "function") {
    logActivityAsync("minors_pick_made", {
      round: current.round, pick_in_round: current.pickInRound,
      player_name: player, notes,
    }, { targetTeamId: current.team });
  }
  showDraftBoard();
}

function passCurrentPick(opts) {
  const auto = !!(opts && opts.auto);
  if (!auto && !isCommissioner()) {
    alert("Only a commissioner can pass a pick. Ask a commish to do it for you.");
    return;
  }
  const draft = getDraft();
  const current = getCurrentPickInfo(draft);
  if (!current) return;
  if (!draft.passed) draft.passed = [];
  draft.passed.push({ round: current.round, pickInRound: current.pickInRound, team: current.team });
  _resetDraftClock(draft);
  saveDraft(draft);
  if (typeof logActivityAsync === "function") {
    logActivityAsync(auto ? "minors_pick_auto_skipped" : "minors_pick_passed", {
      round: current.round, pick_in_round: current.pickInRound,
    }, { targetTeamId: current.team });
  }
  showDraftBoard();
}

// Reset clock to start ticking for the next pick.
function _resetDraftClock(draft) {
  if (!draft.clock) draft.clock = {};
  draft.clock.startedAt = new Date().toISOString();
  draft.clock.paused = false;
  draft.clock.pausedAt = null;
}

function startDraftClock() {
  if (!isCommissioner()) { alert("Commissioners only."); return; }
  const draft = getDraft();
  _resetDraftClock(draft);
  saveDraft(draft);
  if (typeof logActivityAsync === "function") {
    logActivityAsync("minors_clock_started", {});
  }
  showDraftBoard();
}

function pauseDraftClock() {
  if (!isCommissioner()) { alert("Commissioners only."); return; }
  const draft = getDraft();
  if (!draft.clock || !draft.clock.startedAt || draft.clock.paused) return;
  draft.clock.paused = true;
  draft.clock.pausedAt = new Date().toISOString();
  saveDraft(draft);
  if (typeof logActivityAsync === "function") {
    logActivityAsync("minors_clock_paused", {});
  }
  showDraftBoard();
}

function resumeDraftClock() {
  if (!isCommissioner()) { alert("Commissioners only."); return; }
  const draft = getDraft();
  if (!draft.clock || !draft.clock.paused || !draft.clock.pausedAt) return;
  // Shift startedAt forward by the active time elapsed during the pause so
  // remaining time is preserved. activeDraftElapsedMs handles overnight.
  const pausedAtMs = new Date(draft.clock.pausedAt).getTime();
  const nowMs = Date.now();
  const pauseActiveMs = activeDraftElapsedMs(pausedAtMs, nowMs);
  const startedAtMs = new Date(draft.clock.startedAt).getTime();
  draft.clock.startedAt = new Date(startedAtMs + pauseActiveMs).toISOString();
  draft.clock.paused = false;
  draft.clock.pausedAt = null;
  saveDraft(draft);
  if (typeof logActivityAsync === "function") {
    logActivityAsync("minors_clock_resumed", {});
  }
  showDraftBoard();
}

// Called by the per-second clock tick when expiry is detected. Only
// commissioners attempt this; the others wait for the realtime echo of the
// pass. A throttle prevents multiple concurrent attempts from one commish if
// the network is slow.
function _maybeAutoPassExpiredPick() {
  if (!isCommissioner()) return;
  const now = Date.now();
  if (_draftAutoPassAttemptedAt && (now - _draftAutoPassAttemptedAt) < 5000) return;
  const draft = getDraft();
  const current = getCurrentPickInfo(draft);
  if (!current) return;
  const state = computeDraftClockState(draft, now);
  if (!state.started || !state.expired || state.paused) return;
  _draftAutoPassAttemptedAt = now;
  passCurrentPick({ auto: true });
}

function activatePassedPick(round, pickInRound) {
  if (!isCommissioner()) {
    alert("Only a commissioner can activate a passed pick.");
    return;
  }
  openPickEditor(round, pickInRound);
}

function undoLastPick() {
  if (!isCommissioner()) {
    alert("Only a commissioner can undo picks. Ask a commish to fix it for you.");
    return;
  }
  const draft = getDraft();
  if (!draft.picks.length) return;
  if (!confirm("Undo last pick?")) return;
  const last = draft.picks.pop();
  saveDraft(draft);
  if (last && typeof logActivityAsync === "function") {
    logActivityAsync("minors_pick_undone", {
      round: last.round, pick_in_round: last.pickInRound, player_name: last.player,
    }, { targetTeamId: last.team });
  }
  showDraftBoard();
}

function showDraftOrderSetup() {
  if (!isCommissioner()) {
    alert("Only the commissioner can change the order or record traded picks.");
    showDraftBoard();
    return;
  }
  setDraftButtonActive("setup");
  const draft = getDraft();
  const container = document.getElementById("draft-content");

  container.innerHTML = `
    <div class="keeper-projection">
      <h3>Round 1 Order</h3>
      <div style="color:var(--text-dim);font-size:0.82rem;margin-bottom:10px">
        Reorder teams for round 1 (used as base for all rounds).
      </div>
      <div id="draft-order-list"></div>
      <label style="display:block;margin-top:14px">
        <div style="color:var(--text-dim);font-size:0.82rem;margin-bottom:4px">Draft Type</div>
        <select class="trade-select" id="draft-type-select" onchange="updateDraftType(this.value)">
          <option value="straight" ${draft.type === "straight" ? "selected" : ""}>Straight (same order every round)</option>
          <option value="snake" ${draft.type === "snake" ? "selected" : ""}>Snake (reverse order on even rounds)</option>
        </select>
      </label>
    </div>

    <div class="keeper-projection" style="margin-top:12px">
      <h3>Traded Picks</h3>
      <div style="color:var(--text-dim);font-size:0.82rem;margin-bottom:10px">
        Override ownership of individual picks. The "(T)" badge will appear on traded picks in the draft board.
      </div>
      <div id="traded-picks-list"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr 2fr;gap:6px;margin-top:10px">
        <select id="tp-round" class="trade-select">
          ${Array.from({ length: draft.rounds }, (_, i) => `<option value="${i + 1}">Round ${i + 1}</option>`).join("")}
        </select>
        <select id="tp-pick" class="trade-select">
          ${draft.baseOrder.map((_, i) => `<option value="${i + 1}">Pick ${i + 1}</option>`).join("")}
        </select>
        <select id="tp-team" class="trade-select">
          ${LEAGUE_DATA.teams.map(t => `<option value="${t.id}">${t.name}</option>`).join("")}
        </select>
      </div>
      <div style="margin-top:8px">
        <button class="trade-btn" onclick="addTradedPick()">Record Traded Pick</button>
      </div>
    </div>
  `;

  renderDraftOrderList();
  renderTradedPicksList();
}

function renderDraftOrderList() {
  const draft = getDraft();
  const container = document.getElementById("draft-order-list");
  if (!container) return;
  container.innerHTML = draft.baseOrder.map((teamId, i) => {
    const team = LEAGUE_DATA.teams.find(t => t.id === teamId);
    return `
      <div style="display:flex;align-items:center;gap:8px;padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:6px;margin-bottom:4px">
        <span style="color:var(--text-dim);font-weight:700;min-width:28px">${i + 1}.</span>
        <span style="flex:1;color:var(--text-bright);font-weight:600">${team ? team.name : teamId}</span>
        <button onclick="moveDraftOrder(${i},-1)" ${i === 0 ? "disabled" : ""} style="background:var(--bg-card);border:1px solid var(--border);color:var(--text);padding:4px 10px;border-radius:4px;cursor:pointer${i === 0 ? ";opacity:0.3;cursor:not-allowed" : ""}">&uarr;</button>
        <button onclick="moveDraftOrder(${i},1)" ${i === draft.baseOrder.length - 1 ? "disabled" : ""} style="background:var(--bg-card);border:1px solid var(--border);color:var(--text);padding:4px 10px;border-radius:4px;cursor:pointer${i === draft.baseOrder.length - 1 ? ";opacity:0.3;cursor:not-allowed" : ""}">&darr;</button>
      </div>
    `;
  }).join("");
}

function moveDraftOrder(index, direction) {
  const draft = getDraft();
  const newIndex = index + direction;
  if (newIndex < 0 || newIndex >= draft.baseOrder.length) return;
  [draft.baseOrder[index], draft.baseOrder[newIndex]] = [draft.baseOrder[newIndex], draft.baseOrder[index]];
  saveDraft(draft);
  renderDraftOrderList();
}

function updateDraftType(type) {
  const draft = getDraft();
  draft.type = type;
  saveDraft(draft);
}

function renderTradedPicksList() {
  const draft = getDraft();
  const container = document.getElementById("traded-picks-list");
  if (!container) return;

  const entries = [];

  // Manual overrides from draft.tradedPicks (commissioner-entered).
  for (const [key, teamId] of Object.entries(draft.tradedPicks)) {
    const match = key.match(/^(\d+)p(\d+)$/);
    if (!match) continue;
    entries.push({
      round: parseInt(match[1]),
      pickInRound: parseInt(match[2]),
      owner: teamId,
      source: "manual",
      key,
    });
  }

  // Trade-log-derived overrides (skip slots that have a manual override).
  for (let round = 1; round <= draft.rounds; round++) {
    for (let pickInRound = 1; pickInRound <= draft.baseOrder.length; pickInRound++) {
      const key = `${round}p${pickInRound}`;
      if (draft.tradedPicks[key]) continue;
      const baseOwner = getBaseOwner(draft, round, pickInRound);
      const tradeLogOwner = getTradeLogOwner(round, draft.year, baseOwner);
      if (tradeLogOwner !== baseOwner) {
        entries.push({
          round, pickInRound, owner: tradeLogOwner, source: "tradelog",
        });
      }
    }
  }

  if (!entries.length) {
    container.innerHTML = '<div style="color:var(--text-dim);font-size:0.82rem;font-style:italic">No traded picks recorded.</div>';
    return;
  }

  entries.sort((a, b) => a.round - b.round || a.pickInRound - b.pickInRound);

  container.innerHTML = entries.map(e => {
    const baseOwner = getBaseOwner(draft, e.round, e.pickInRound);
    const original = LEAGUE_DATA.teams.find(t => t.id === baseOwner);
    const newOwner = LEAGUE_DATA.teams.find(t => t.id === e.owner);
    const trailing = e.source === "manual"
      ? `<button onclick="removeTradedPick('${e.key}')" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:0.85rem">x</button>`
      : `<span style="color:var(--text-dim);font-size:0.7rem;font-style:italic" title="Auto-derived from a trade in the Trades tab">trade log</span>`;
    return `
      <div style="display:flex;align-items:center;gap:8px;padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:6px;margin-bottom:4px;font-size:0.85rem">
        <span style="color:var(--accent);font-weight:600;min-width:84px">R${e.round} Pick ${e.pickInRound}</span>
        <span style="color:var(--text-dim)">${original ? original.name : baseOwner}</span>
        <span style="color:var(--text-dim)">&rarr;</span>
        <span style="color:var(--text-bright);font-weight:600;flex:1">${newOwner ? newOwner.name : e.owner}</span>
        ${trailing}
      </div>
    `;
  }).join("");
}

function addTradedPick() {
  const round = parseInt(document.getElementById("tp-round").value);
  const pick = parseInt(document.getElementById("tp-pick").value);
  const team = document.getElementById("tp-team").value;
  const draft = getDraft();
  draft.tradedPicks[`${round}p${pick}`] = team;
  saveDraft(draft);
  renderTradedPicksList();
}

function removeTradedPick(key) {
  const draft = getDraft();
  delete draft.tradedPicks[key];
  saveDraft(draft);
  renderTradedPicksList();
}


// --- Navigation ---

let currentView = "eligible";
// Remembers the last team picked in each per-team-selector view so that
// re-renders (realtime echoes, etc.) don't reset the dropdown to "All Teams".
const _lastTeamSel = { eligible: null, keepers: null, rosters: null };

function switchTab(tab) {
  // Pick up the commish-set season (and other settings) before any render
  // computes contract math.
  if (typeof _applySettingsFromCache === "function") _applySettingsFromCache();
  // Re-derive each team's current minors/callups from the static anchor +
  // trade log + callup overrides before any render reads them.
  if (typeof applyRosterAdjustments === "function") applyRosterAdjustments();
  // Reset the asset-price memo so any view that renders trade assets
  // picks up fresh prices (after a callup, FA pickup, override, etc.).
  if (typeof _invalidatePriceMap === "function") _invalidatePriceMap();
  // Sync active state on both the desktop tab row and the mobile drawer items.
  document.querySelectorAll(".nav-tab, .nav-drawer-item").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(`[data-tab="${tab}"]`).forEach(el => el.classList.add("active"));

  const content = document.getElementById("main-content");
  const backBtn = document.getElementById("back-btn");
  const title = document.getElementById("header-title");
  title.innerHTML = '<a href="https://fantasy.espn.com/baseball/league?leagueId=1200" target="_blank" rel="noopener">The League</a>';

  // Draft grid needs more horizontal room than other views.
  content.classList.toggle("wide", tab === "draft");

  // The same interval handle is shared between the Minors Draft and Rule 5
  // clocks (only one is active at a time). Stop it when leaving either tab.
  if (tab !== "draft" && tab !== "rule5" && typeof _stopDraftClockTicker === "function") _stopDraftClockTicker();

  backBtn.classList.remove("visible");

  switch (tab) {
    case "teams":
      currentView = "teams";
      content.innerHTML = renderTeamGrid();
      break;
    case "eligible":
      currentView = "eligible";
      content.innerHTML = renderEligibleKeepersView();
      document.getElementById("eligible-team-select").value = _lastTeamSel.eligible || "all";
      updateEligibleKeepersView();
      break;
    case "keepers":
      currentView = "keepers";
      content.innerHTML = renderKeepersView();
      document.getElementById("keepers-team-select").value = _lastTeamSel.keepers || "all";
      updateKeepersView();
      break;
    case "rosters":
      currentView = "rosters";
      content.innerHTML = renderRostersView();
      document.getElementById("rosters-team-select").value = _lastTeamSel.rosters || "all";
      updateRostersView();
      break;
    case "trades":
      currentView = "trades";
      content.innerHTML = renderTradesContainer();
      renderTradesShell();
      break;
    case "financials":
      currentView = "financials";
      content.innerHTML = renderFinancialsView();
      break;
    case "draft":
      currentView = "draft";
      content.innerHTML = renderDraftView();
      renderProspectStatus();
      showDraftBoard();
      if (!getCachedProspects()) kickOffProspectRefresh();
      break;
    case "rule5":
      currentView = "rule5";
      content.innerHTML = renderRule5View();
      _startRule5ClockTicker();
      break;
    case "trophy-room":
      currentView = "trophy-room";
      content.innerHTML = renderTrophyRoomView();
      break;
    case "activity":
      currentView = "activity";
      content.innerHTML = renderActivityView();
      break;
    case "rules":
      currentView = "rules";
      content.innerHTML = renderRulesView();
      break;
    case "settings":
      currentView = "settings";
      if (!isCommissioner()) {
        content.innerHTML = '<div style="padding:30px;color:var(--text-dim);text-align:center">Commissioner Tools are commissioner-only.</div>';
        break;
      }
      content.innerHTML = renderSettingsView();
      // Snapshots come from a fresh DB query (not the regular cache) — load
      // them after the container is in the DOM.
      if (typeof _refreshSnapshotList === "function") _refreshSnapshotList();
      break;
    case "user-settings":
      currentView = "user-settings";
      content.innerHTML = renderUserSettingsView();
      // Update the per-device Web Push state asynchronously (needs SW ready).
      if (typeof _refreshPushStateLabel === "function") _refreshPushStateLabel();
      break;
  }
}

// ============================================================================
// User Settings page — notification preferences (everyone)
// ============================================================================

// ---------- PWA install prompt ----------
//
// Chrome and Edge fire `beforeinstallprompt` when the PWA is eligible to
// install. We stash the event so a click on the "Install" button can call
// prompt() on it later. Safari (iOS + desktop) doesn't fire this event;
// for those we show step-by-step instructions instead.
let _deferredInstallPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();          // suppress the auto-banner so we control the moment
  _deferredInstallPrompt = e;
  // Re-render the settings install section if it's currently visible.
  if (typeof currentView !== "undefined" && currentView === "user-settings" && typeof _refreshInstallSection === "function") {
    _refreshInstallSection();
  }
});
window.addEventListener("appinstalled", () => {
  _deferredInstallPrompt = null;
  if (typeof currentView !== "undefined" && currentView === "user-settings" && typeof _refreshInstallSection === "function") {
    _refreshInstallSection();
  }
  if (typeof showToast === "function") showToast("Installed! Open The League from your home screen.");
});

function isPwaInstalled() {
  if (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) return true;
  if ("standalone" in navigator && navigator.standalone) return true;  // iOS legacy
  return false;
}

function detectInstallPlatform() {
  const ua = navigator.userAgent || "";
  const isIOS = /iPhone|iPad|iPod/.test(ua) && !window.MSStream;
  const isAndroid = /Android/.test(ua);
  const isSafari = /^((?!chrome|android|crios|fxios|edgios).)*safari/i.test(ua);
  const isFirefox = /Firefox/i.test(ua);
  if (isIOS && isSafari) return "ios-safari";
  if (isIOS) return "ios-other";   // Chrome on iOS, Edge on iOS — same install gesture
  if (isAndroid) return "android";
  if (isSafari) return "macos-safari";
  if (isFirefox) return "firefox";
  return "chromium";
}

async function tapInstallButton() {
  if (!_deferredInstallPrompt) return;
  _deferredInstallPrompt.prompt();
  const choice = await _deferredInstallPrompt.userChoice.catch(() => null);
  _deferredInstallPrompt = null;
  if (typeof _refreshInstallSection === "function") _refreshInstallSection();
  if (choice && choice.outcome === "accepted" && typeof showToast === "function") {
    showToast("Installing — open from your home screen when done.");
  }
}

function _refreshInstallSection() {
  const el = document.getElementById("settings-install-section");
  if (el) el.outerHTML = renderInstallSection();
}

function renderInstallSection() {
  // SVG icons re-used in the iOS / macOS instruction blocks.
  const shareIconSvg = '<svg viewBox="0 0 24 24" width="18" height="18" style="vertical-align:middle;margin:0 3px" aria-hidden="true"><path fill="currentColor" d="M12 3l-4 4h3v6h2V7h3l-4-4zm-6 9H4v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8h-2v8H6v-8z"/></svg>';
  const platform = detectInstallPlatform();
  const installed = isPwaInstalled();
  let body;
  if (installed) {
    body = `<div style="color:var(--green);font-weight:600">✓ The League is installed on this device.</div>
      <div style="color:var(--text-dim);font-size:0.82rem;margin-top:6px">Open it from your home screen for the full app experience (push notifications, no URL bar).</div>`;
  } else if (_deferredInstallPrompt) {
    body = `<div style="color:var(--text);font-size:0.9rem;margin-bottom:10px">Install The League as an app on this device for push notifications and faster access.</div>
      <button class="trade-btn trade-btn-submit" onclick="tapInstallButton()" style="font-size:0.9rem">Install The League</button>`;
  } else if (platform === "ios-safari") {
    body = `<div style="color:var(--text);font-size:0.9rem;line-height:1.6;margin-bottom:10px">To install on your iPhone / iPad:</div>
      <ol style="margin:0;padding-left:22px;color:var(--text);font-size:0.88rem;line-height:1.8">
        <li>Tap the Share button ${shareIconSvg} in Safari's bottom toolbar.</li>
        <li>Scroll down and tap <strong>Add to Home Screen</strong>.</li>
        <li>Tap <strong>Add</strong> in the top right.</li>
      </ol>
      <div style="color:var(--text-dim);font-size:0.78rem;margin-top:10px;line-height:1.5">Once installed, open The League from your home screen — that's the only way push notifications work on iOS.</div>`;
  } else if (platform === "ios-other") {
    body = `<div style="color:var(--text);font-size:0.9rem;line-height:1.55;margin-bottom:8px">On iPhone / iPad, the install option is only available in <strong>Safari</strong>.</div>
      <div style="color:var(--text-dim);font-size:0.82rem;line-height:1.5">Open this site in Safari, then tap Share ${shareIconSvg} → <strong>Add to Home Screen</strong>.</div>`;
  } else if (platform === "macos-safari") {
    body = `<div style="color:var(--text);font-size:0.9rem;line-height:1.55;margin-bottom:8px">To install on Mac Safari (macOS Sonoma+):</div>
      <ol style="margin:0;padding-left:22px;color:var(--text);font-size:0.88rem;line-height:1.8">
        <li>Click <strong>File</strong> in the menu bar, then <strong>Add to Dock…</strong></li>
        <li>Confirm the name and click <strong>Add</strong>.</li>
      </ol>`;
  } else if (platform === "android") {
    body = `<div style="color:var(--text);font-size:0.9rem;line-height:1.55">Chrome should offer an "Install" prompt when you visit. If you don't see it, tap the <strong>⋮</strong> menu in Chrome and look for <strong>Install app</strong> or <strong>Add to Home screen</strong>.</div>`;
  } else if (platform === "firefox") {
    body = `<div style="color:var(--text);font-size:0.9rem;line-height:1.55">Firefox doesn't support installing web apps on desktop. Try Chrome, Edge, or Brave for an installable version.</div>`;
  } else {
    body = `<div style="color:var(--text);font-size:0.9rem;line-height:1.55">Tap your browser's menu and look for <strong>Install app</strong> or <strong>Add to Home Screen</strong>.</div>`;
  }
  return `<div id="settings-install-section" class="keeper-projection" style="margin-bottom:14px">
    <h3 style="margin-top:0">Install on this device</h3>
    ${body}
  </div>`;
}

// VAPID public key (urlsafe base64). Pair lives in scripts/.env as
// VAPID_PRIVATE_KEY. Generated once via scripts/generate_vapid.py.
const VAPID_PUBLIC_KEY = "BNgnBnVKWKd39EOdA5UJNhCaOnzgGAtspFtXtJ8r_qnaQQXrz_E9UVodUMQZuaySxdE5sg5DPlDvaW8D7g2fk_Y";

// Notification event taxonomy: each row defines its label and which channels
// it supports. `email` = list of allowed frequencies. `push` = whether the
// per-row push checkbox is shown.
const NOTIFY_EVENTS = [
  { key: "trade_proposal",   label: "Trade proposal received",      email: ["instant","daily","weekly","never"], push: true,  defaults: { email: "instant", push: true } },
  { key: "trade_update",     label: "Trade proposal updates",        email: ["instant","daily","weekly","never"], push: true,  defaults: { email: "instant", push: true } },
  { key: "trade_message",    label: "Trade thread message",          email: ["instant","daily","weekly","never"], push: true,  defaults: { email: "instant", push: true } },
  { key: "trade_completed",  label: "Trade completed (any league trade)", email: ["instant","daily","weekly","never"], push: true,  defaults: { email: "daily", push: false } },
  { key: "keeper_protect",   label: "Keeper protection changes",     email: ["daily","weekly","never"],            push: false, defaults: { email: "daily" } },
  { key: "rule5_protect",    label: "Rule 5 protection changes",     email: ["daily","weekly","never"],            push: false, defaults: { email: "daily" } },
  { key: "callup",           label: "Call-ups",                       email: ["daily","weekly","never"],            push: false, defaults: { email: "daily" } },
  { key: "send_down",        label: "Send-downs",                     email: ["daily","weekly","never"],            push: false, defaults: { email: "daily" } },
  { key: "draft_picks",      label: "Other teams' draft picks",       email: ["daily","weekly","never"],            push: false, defaults: { email: "daily" } },
];

const DRAFT_CLOCK_STATES = [
  { key: "in_hole",  label: "In the hole" },
  { key: "on_deck",  label: "On deck" },
  { key: "on_clock", label: "On the clock" },
];

function getDefaultNotifyPrefs() {
  const out = {};
  for (const e of NOTIFY_EVENTS) {
    out[e.key] = { email: e.defaults.email, push: e.push ? !!e.defaults.push : false };
  }
  out.draft_clock = { in_hole: { email: true, push: true }, on_deck: { email: true, push: true }, on_clock: { email: true, push: true } };
  return out;
}

function getMyNotifyPrefs() {
  if (typeof currentOwner === "undefined" || !currentOwner) return getDefaultNotifyPrefs();
  const row = (typeof dbGetNotifyPrefs === "function") ? dbGetNotifyPrefs(currentOwner.team_id) : null;
  if (!row) return getDefaultNotifyPrefs();
  // Merge with defaults so newly-added event types pick up sensible values.
  const defaults = getDefaultNotifyPrefs();
  const merged = { ...defaults };
  for (const k of Object.keys(row.prefs || {})) merged[k] = row.prefs[k];
  return merged;
}

function renderUserSettingsView() {
  if (typeof currentOwner === "undefined" || !currentOwner) {
    return '<div style="padding:30px;color:var(--text-dim);text-align:center">Sign in to manage your notification preferences.</div>';
  }
  const teamId = currentOwner.team_id;
  const teamName = LEAGUE_DATA.teams.find(t => t.id === teamId)?.name || teamId;
  const prefs = getMyNotifyPrefs();
  const myEmail = (currentUser && currentUser.email) || "";

  // Push state — checked client-side, since this is per-device (subscription
  // endpoint stored in DB). Will be filled in by setupSettingsPagePushUi().
  const pushStateInitial = '<span id="settings-push-state" style="color:var(--text-dim);font-size:0.82rem">checking…</span>';

  // Every event row gets the same 4 columns (Instant / Daily / Weekly / Never)
  // so the radios line up vertically. Cells for unsupported frequencies show
  // a dash instead of the radio.
  const FREQS = ["instant", "daily", "weekly", "never"];
  const eventRowsHtml = NOTIFY_EVENTS.map(e => {
    const cur = prefs[e.key] || {};
    const cells = FREQS.map(freq => {
      if (!e.email.includes(freq)) {
        return `<td style="padding:9px 6px;text-align:center;color:var(--text-dim);font-size:0.74rem">—</td>`;
      }
      const id = `np-${e.key}-${freq}`;
      const checked = cur.email === freq ? "checked" : "";
      return `<td style="padding:9px 6px;text-align:center">
        <input type="radio" name="np-${e.key}" id="${id}" value="${freq}" ${checked} onchange="setNotifyEmail('${e.key}', '${freq}')" style="accent-color:var(--accent);cursor:pointer">
      </td>`;
    }).join("");
    const pushCol = e.push
      ? `<input type="checkbox" ${cur.push ? "checked" : ""} onchange="setNotifyPush('${e.key}', this.checked)" style="accent-color:var(--accent);cursor:pointer">`
      : `<span style="color:var(--text-dim);font-size:0.74rem">—</span>`;
    return `<tr>
      <td style="padding:9px 10px;color:var(--text);vertical-align:middle">${escapeHtml(e.label)}</td>
      ${cells}
      <td style="padding:9px 10px;text-align:center;vertical-align:middle">${pushCol}</td>
    </tr>`;
  }).join("");

  const dc = prefs.draft_clock || {};
  const dcRowsHtml = DRAFT_CLOCK_STATES.map(s => {
    const c = dc[s.key] || {};
    return `<tr>
      <td style="padding:8px 10px;color:var(--text)">${escapeHtml(s.label)}</td>
      <td style="padding:8px 10px;text-align:center">
        <input type="checkbox" ${c.email ? "checked" : ""} onchange="setDraftClockChannel('${s.key}','email',this.checked)" style="accent-color:var(--accent)">
      </td>
      <td style="padding:8px 10px;text-align:center">
        <input type="checkbox" ${c.push ? "checked" : ""} onchange="setDraftClockChannel('${s.key}','push',this.checked)" style="accent-color:var(--accent)">
      </td>
    </tr>`;
  }).join("");

  return `
    <div style="max-width:840px">
      <h2 style="color:var(--text-bright);margin-bottom:6px">Settings</h2>
      <div style="color:var(--text-dim);font-size:0.82rem;margin-bottom:18px">
        Manager preferences for <strong>${escapeHtml(teamName)}</strong>${myEmail ? ` · emails go to <code>${escapeHtml(myEmail)}</code>` : ""}.
      </div>

      <div class="keeper-projection" style="margin-bottom:14px">
        <h3 style="margin-top:0">Notifications</h3>
        <div style="color:var(--text-dim);font-size:0.82rem;margin-bottom:10px">
          Choose how you want to hear about each kind of event. Email frequency for keeper-protection / Rule 5 / call-up / send-down / other teams' picks tops out at Daily. Push is only available for event types that fire in real time.
        </div>
        <div style="overflow-x:auto">
          <table class="player-table" style="font-size:0.85rem;width:100%;max-width:760px">
            <colgroup>
              <col>
              <col style="width:64px">
              <col style="width:64px">
              <col style="width:64px">
              <col style="width:64px">
              <col style="width:72px">
            </colgroup>
            <thead>
              <tr>
                <th style="text-align:left">Event</th>
                <th style="text-align:center">Instant</th>
                <th style="text-align:center">Daily</th>
                <th style="text-align:center">Weekly</th>
                <th style="text-align:center">Never</th>
                <th style="text-align:center">Push</th>
              </tr>
            </thead>
            <tbody>${eventRowsHtml}</tbody>
          </table>
        </div>
      </div>

      <div class="keeper-projection" style="margin-bottom:14px">
        <h3 style="margin-top:0">Draft alerts (your team)</h3>
        <div style="color:var(--text-dim);font-size:0.82rem;margin-bottom:10px">
          Get notified when your team's pick is coming up. (No per-pick spam — just these three states.)
        </div>
        <table class="player-table" style="font-size:0.85rem;width:100%;max-width:520px">
          <thead>
            <tr>
              <th style="text-align:left">State</th>
              <th style="text-align:center;width:90px">Email</th>
              <th style="text-align:center;width:90px">Push</th>
            </tr>
          </thead>
          <tbody>${dcRowsHtml}</tbody>
        </table>
      </div>

      <div class="keeper-projection" style="margin-bottom:14px">
        <h3 style="margin-top:0">Web Push on this device</h3>
        <div style="color:var(--text-dim);font-size:0.82rem;margin-bottom:10px">
          Push notifications work per-device. Enable on each phone or browser you want to receive them on. Push delivery requires HTTPS — already in place.
        </div>
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          ${pushStateInitial}
          <button class="trade-btn" onclick="enablePushOnThisDevice()" style="font-size:0.85rem">Enable Push on this device</button>
          <button class="trade-btn trade-btn-cancel" onclick="disablePushOnThisDevice()" style="font-size:0.85rem">Disable</button>
          <button class="trade-btn" onclick="sendTestNotification()" style="font-size:0.85rem;background:var(--purple);color:#fff">Send test notification</button>
        </div>
        <div id="settings-push-error" style="color:var(--red);font-size:0.78rem;margin-top:8px;display:none"></div>
        <div style="color:var(--text-dim);font-size:0.72rem;margin-top:10px;line-height:1.5">
          <strong>If the test doesn't appear:</strong> notifications can be blocked at the OS level even when the browser is allowed. Check:
          <span style="display:block;margin-top:3px">• <strong>macOS</strong>: System Settings → Notifications → Chrome (or your browser) → Allow notifications, banner style: Banners or Alerts.</span>
          <span style="display:block">• <strong>Windows</strong>: Settings → System → Notifications → ensure your browser is on, and Focus Assist isn't blocking.</span>
          <span style="display:block">• <strong>Browser site settings</strong>: click the lock icon in the URL bar → Notifications → Allow for this site.</span>
          <span style="display:block">• <strong>iOS</strong>: install the app to the Home Screen first (Share → Add to Home Screen), then open from there.</span>
        </div>
      </div>

      ${renderInstallSection()}
    </div>
  `;
}

async function setNotifyEmail(eventKey, freq) {
  if (!currentOwner) return;
  const prefs = getMyNotifyPrefs();
  if (!prefs[eventKey]) prefs[eventKey] = {};
  prefs[eventKey].email = freq;
  await _saveMyNotifyPrefs(prefs);
}

async function setNotifyPush(eventKey, on) {
  if (!currentOwner) return;
  const prefs = getMyNotifyPrefs();
  if (!prefs[eventKey]) prefs[eventKey] = {};
  prefs[eventKey].push = !!on;
  await _saveMyNotifyPrefs(prefs);
}

async function setDraftClockChannel(stateKey, channel, on) {
  if (!currentOwner) return;
  const prefs = getMyNotifyPrefs();
  if (!prefs.draft_clock) prefs.draft_clock = {};
  if (!prefs.draft_clock[stateKey]) prefs.draft_clock[stateKey] = {};
  prefs.draft_clock[stateKey][channel] = !!on;
  await _saveMyNotifyPrefs(prefs);
}

async function _saveMyNotifyPrefs(prefs) {
  if (typeof saveNotifyPrefsAsync !== "function" || !currentOwner) return;
  try {
    await saveNotifyPrefsAsync({
      teamId: currentOwner.team_id,
      prefs,
      receiveAll: !!(dbGetNotifyPrefs?.(currentOwner.team_id)?.receiveAll),
      email: (currentUser && currentUser.email) || null,
    });
    if (typeof showToast === "function") showToast("Saved");
  } catch (e) {
    alert("Couldn't save: " + (e.message || e));
  }
}

// ---------- Web Push subscribe / unsubscribe / test ----------

function _urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i);
  return out;
}

function _setPushStateLabel(text, color) {
  const el = document.getElementById("settings-push-state");
  if (el) { el.textContent = text; el.style.color = color || "var(--text-dim)"; }
}

function _showPushError(msg) {
  const el = document.getElementById("settings-push-error");
  if (el) { el.textContent = msg; el.style.display = msg ? "block" : "none"; }
}

async function _refreshPushStateLabel() {
  _showPushError("");
  if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
    _setPushStateLabel("This browser doesn't support push notifications.", "var(--text-dim)");
    return;
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) {
    _setPushStateLabel("Not enabled on this device.", "var(--text-dim)");
    return;
  }
  const known = (typeof dbHasPushSubForEndpoint === "function") ? dbHasPushSubForEndpoint(sub.endpoint) : true;
  _setPushStateLabel(known ? "Enabled on this device." : "Subscribed locally but not synced to server.", known ? "var(--green)" : "var(--orange)");
}

async function enablePushOnThisDevice() {
  _showPushError("");
  try {
    if (!("Notification" in window)) throw new Error("Notifications not supported in this browser.");
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) throw new Error("Service Worker / Push API not available.");
    if (!VAPID_PUBLIC_KEY || VAPID_PUBLIC_KEY.startsWith("BPLACEHOLDER")) {
      throw new Error("Web Push isn't set up yet — the commissioner needs to generate VAPID keys (see scripts/generate_vapid.py).");
    }
    let perm = Notification.permission;
    if (perm === "default") perm = await Notification.requestPermission();
    if (perm !== "granted") throw new Error("Notification permission denied.");
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: _urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }
    const json = sub.toJSON();
    if (typeof savePushSubscriptionAsync === "function" && currentOwner) {
      try {
        await savePushSubscriptionAsync({
          teamId: currentOwner.team_id,
          userId: currentUser.id,
          endpoint: sub.endpoint,
          p256dh: json.keys?.p256dh || "",
          authKey: json.keys?.auth || "",
          userAgent: navigator.userAgent,
        });
      } catch (e) {
        if (!/duplicate/i.test(e.message || "")) throw e;
      }
    }
    await _refreshPushStateLabel();
    if (typeof showToast === "function") showToast("Push enabled on this device");
  } catch (e) {
    _showPushError(e.message || String(e));
  }
}

async function disablePushOnThisDevice() {
  _showPushError("");
  try {
    if (!("serviceWorker" in navigator)) return;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      const endpoint = sub.endpoint;
      await sub.unsubscribe();
      if (typeof deletePushSubscriptionAsync === "function") {
        try { await deletePushSubscriptionAsync(endpoint); } catch {}
      }
    }
    await _refreshPushStateLabel();
    if (typeof showToast === "function") showToast("Push disabled on this device");
  } catch (e) {
    _showPushError(e.message || String(e));
  }
}

// Local-only notification — no server needed. Useful for previewing how push
// notifications will look on this device.
async function sendTestNotification() {
  _showPushError("");
  try {
    if (!("Notification" in window)) throw new Error("Notifications not supported in this browser.");
    let perm = Notification.permission;
    if (perm === "denied") {
      throw new Error("Notification permission was denied earlier. Open your browser's site settings for this page and switch notifications to Allow, then refresh and try again.");
    }
    if (perm === "default") {
      perm = await Notification.requestPermission();
      if (perm !== "granted") throw new Error("You didn't grant notification permission.");
    }
    if (!("serviceWorker" in navigator)) throw new Error("Service Worker not available.");
    const reg = await navigator.serviceWorker.ready;
    // Use relative paths — they resolve against the page's base URL so this
    // works on both jwarshafsky.github.io/the-league/ and any other host.
    await reg.showNotification("The League — test notification", {
      body: "If you can see this, notifications work on this device. 🎉",
      icon: "icons/icon-192.png",
      badge: "icons/icon-64.png",
      tag: "the-league-test",
      renotify: true,
      requireInteraction: false,
      data: { url: "./?tab=user-settings" },
    });
    // The call resolves silently — give the user a confirmation in case the
    // OS suppressed the visible banner (Focus mode, DND, etc.).
    if (typeof showToast === "function") showToast("Test notification dispatched. If you didn't see a banner, check OS notification settings (macOS: System Settings → Notifications → your browser; Windows: Settings → Notifications).");
  } catch (e) {
    _showPushError(e.message || String(e));
  }
}

function renderSettingsView() {
  const settings = getLeagueSettings();
  const enforceR5 = !!settings.enforceRule5RosterSpot;
  const enforceMiL = !!settings.enforceMinorsRosterSpot;
  const season = (typeof settings.currentSeason === "number") ? settings.currentSeason : DEFAULT_SEASON;
  return `
    <div style="max-width:720px">
      <h2 style="color:var(--text-bright);margin-bottom:4px">Commissioner Tools</h2>
      <div style="color:var(--text-dim);font-size:0.82rem;margin-bottom:18px">Commissioner-only. Changes apply league-wide for everyone.</div>

      <div class="keeper-projection" style="margin-bottom:14px">
        <h3 style="margin-top:0">Season</h3>
        <div style="color:var(--text-dim);font-size:0.84rem;margin-bottom:10px">
          The current season drives contract math everywhere (Expiry years, keeper eligibility, etc.). Set this once at the start of each year.
        </div>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <label style="color:var(--text);font-size:0.88rem">Current season:</label>
          <input type="number" id="settings-season" value="${season}" min="2020" max="2100" style="background:var(--bg);color:var(--text);border:1px solid var(--border);padding:8px 10px;border-radius:6px;font-size:0.95rem;width:110px">
          <button class="trade-btn trade-btn-submit" onclick="submitSetSeason()" style="font-size:0.85rem">Set Year</button>
          <span style="color:var(--text-dim);font-size:0.72rem">(currently ${CURRENT_SEASON})</span>
        </div>
      </div>

      <div class="keeper-projection" style="margin-bottom:14px">
        <h3 style="margin-top:0">Draft Roster Limits</h3>
        <div style="color:var(--text-dim);font-size:0.84rem;margin-bottom:10px">
          When enabled, the on-the-clock team can only submit a pick if they have an open roster spot. They can open a spot via trade (or calling up a minor leaguer, for minors) and try again. Commissioner can always pass.
        </div>
        <label style="display:flex;align-items:center;gap:10px;padding:10px;background:var(--bg);border:1px solid var(--border);border-radius:6px;cursor:pointer;margin-bottom:6px">
          <input type="checkbox" id="settings-enforce-rule5" ${enforceR5 ? "checked" : ""} onchange="toggleEnforceRule5RosterSpot(this.checked)" style="width:18px;height:18px;cursor:pointer;accent-color:var(--accent)">
          <span style="color:var(--text);font-size:0.9rem">Rule 5 Draft: enforce open 25-man ML spot</span>
        </label>
        <label style="display:flex;align-items:center;gap:10px;padding:10px;background:var(--bg);border:1px solid var(--border);border-radius:6px;cursor:pointer">
          <input type="checkbox" id="settings-enforce-mil" ${enforceMiL ? "checked" : ""} onchange="toggleEnforceMinorsRosterSpot(this.checked)" style="width:18px;height:18px;cursor:pointer;accent-color:var(--accent)">
          <span style="color:var(--text);font-size:0.9rem">Minors Draft: enforce open 10-man MiL spot</span>
        </label>
      </div>

      <div class="keeper-projection" style="margin-bottom:14px">
        <h3 style="margin-top:0">Keeper Price Exceptions</h3>
        <div style="color:var(--text-dim);font-size:0.84rem;margin-bottom:10px">
          ESPN doesn't let us trade draft dollars, so the workaround is to bump a keeper's ESPN price up or down to absorb the swing. Enter the player's <em>true</em> salary here and the app will use that everywhere instead of the inflated ESPN value — Keepers tab, Eligible Keepers, Luxury Tax, and all contract math (years remaining, next-year price, etc.).
        </div>
        ${renderKeeperPriceExceptionsEditor()}
      </div>

      <div class="keeper-projection" style="margin-bottom:14px">
        <h3 style="margin-top:0">Exports</h3>
        <div style="color:var(--text-dim);font-size:0.84rem;margin-bottom:10px">
          Download a snapshot of every team's roster with contract details (year acquired, salary, expiry, source).
        </div>
        <button class="trade-btn" onclick="exportContractsCsv()" style="font-size:0.85rem">Export contracts (.csv)</button>
      </div>

      <div class="keeper-projection" style="margin-bottom:14px">
        <h3 style="margin-top:0">Rollback League State</h3>
        <div style="color:var(--text-dim);font-size:0.84rem;margin-bottom:10px">
          Take a snapshot of the entire league (trades, keeper selections, draft state, settings, etc.) so you can experiment — set the year, mess with rosters — and restore later if needed. A safety snapshot is taken automatically before any restore.
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
          <input type="text" id="settings-snapshot-label" placeholder="Optional label (e.g. 'before year advance test')" style="flex:1;min-width:240px;background:var(--bg);color:var(--text);border:1px solid var(--border);padding:8px 10px;border-radius:6px;font-size:0.9rem">
          <button class="trade-btn trade-btn-submit" onclick="submitTakeSnapshot()" style="font-size:0.85rem">Take Snapshot</button>
        </div>
        <div id="settings-snapshot-list" style="font-size:0.85rem;color:var(--text-dim)">Loading snapshots…</div>
      </div>
    </div>
  `;
}

function renderKeeperPriceExceptionsEditor() {
  const ex = (typeof dbGetKeeperPriceExceptions === "function") ? dbGetKeeperPriceExceptions() : {};
  const entries = Object.keys(ex).sort((a, b) => lastName(a).localeCompare(lastName(b)));
  // Build a datalist of all players currently on any ESPN roster so the
  // commissioner can autocomplete names instead of typing them exactly.
  const allNames = new Set();
  for (const team of LEAGUE_DATA.teams) {
    for (const p of getEligiblePlayers(team)) allNames.add(p.name);
  }
  const optionsHtml = [...allNames].sort().map(n => `<option value="${escapeHtml(n)}"></option>`).join("");
  const rowsHtml = entries.length
    ? entries.map(name => {
        // Find the team holding this player so the commish can see whose roster it affects.
        let teamName = "—";
        let espnPrice = null;
        for (const team of LEAGUE_DATA.teams) {
          const p = getEligiblePlayers(team).find(x => x.name === name);
          if (p) { teamName = team.name; espnPrice = p.price; break; }
        }
        return `
          <tr>
            <td style="padding:6px 8px;color:var(--text-bright)">${escapeHtml(name)}</td>
            <td style="padding:6px 8px;color:var(--text-dim);font-size:0.82rem">${escapeHtml(teamName)}</td>
            <td style="padding:6px 8px;text-align:right;color:var(--text)">$${escapeHtml(String(ex[name]))}</td>
            <td style="padding:6px 8px;text-align:right">
              <button class="trade-btn trade-btn-cancel" onclick="removeKeeperPriceException('${escapeJsString(name)}')" style="font-size:0.74rem;padding:3px 8px">Remove</button>
            </td>
          </tr>
        `;
      }).join("")
    : `<tr><td colspan="4" style="padding:10px;color:var(--text-dim);font-style:italic;text-align:center">No exceptions set. ESPN-displayed prices are used as-is.</td></tr>`;
  return `
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:12px">
      <label style="flex:1;min-width:200px">
        <div style="color:var(--text-dim);font-size:0.78rem;margin-bottom:3px">Player</div>
        <input type="text" id="settings-kpe-name" list="settings-kpe-player-list" placeholder="Type a name…" style="width:100%;background:var(--bg);color:var(--text);border:1px solid var(--border);padding:8px 10px;border-radius:6px;font-size:0.9rem">
        <datalist id="settings-kpe-player-list">${optionsHtml}</datalist>
      </label>
      <label style="width:120px">
        <div style="color:var(--text-dim);font-size:0.78rem;margin-bottom:3px">True salary ($)</div>
        <input type="number" id="settings-kpe-price" min="1" placeholder="e.g. 10" style="width:100%;background:var(--bg);color:var(--text);border:1px solid var(--border);padding:8px 10px;border-radius:6px;font-size:0.9rem">
      </label>
      <button class="trade-btn trade-btn-submit" onclick="submitKeeperPriceException()" style="font-size:0.85rem;height:36px">Add / Update</button>
    </div>
    <table class="player-table" style="width:100%;max-width:600px;font-size:0.85rem">
      <thead>
        <tr>
          <th>Player</th>
          <th>Team</th>
          <th style="text-align:right">True $</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  `;
}

async function submitKeeperPriceException() {
  if (!isCommissioner()) return;
  const nameEl = document.getElementById("settings-kpe-name");
  const priceEl = document.getElementById("settings-kpe-price");
  const name = (nameEl?.value || "").trim();
  const priceRaw = (priceEl?.value || "").trim();
  if (!name) { alert("Enter a player name."); nameEl?.focus(); return; }
  const price = parseInt(priceRaw, 10);
  if (!Number.isFinite(price) || price < 1) { alert("Enter a valid salary (≥ 1)."); priceEl?.focus(); return; }
  const cur = (typeof dbGetKeeperPriceExceptions === "function") ? dbGetKeeperPriceExceptions() : {};
  const next = { ...cur, [name]: price };
  try {
    await saveKeeperPriceExceptionsAsync(next);
    if (typeof logActivityAsync === "function") {
      logActivityAsync("keeper_price_exception_set", { player_name: name, price });
    }
    if (nameEl) nameEl.value = "";
    if (priceEl) priceEl.value = "";
    if (currentView === "settings") switchTab("settings");
    showToast(`Set ${name} to $${price}`);
  } catch (e) {
    alert("Couldn't save: " + (e.message || e));
  }
}

async function removeKeeperPriceException(name) {
  if (!isCommissioner()) return;
  if (!confirm(`Remove keeper-price exception for ${name}? The ESPN-displayed price will be used.`)) return;
  const cur = (typeof dbGetKeeperPriceExceptions === "function") ? dbGetKeeperPriceExceptions() : {};
  const next = { ...cur };
  delete next[name];
  try {
    await saveKeeperPriceExceptionsAsync(next);
    if (typeof logActivityAsync === "function") {
      logActivityAsync("keeper_price_exception_removed", { player_name: name });
    }
    if (currentView === "settings") switchTab("settings");
    showToast(`Removed ${name} exception`);
  } catch (e) {
    alert("Couldn't save: " + (e.message || e));
  }
}

async function submitTakeSnapshot() {
  if (!isCommissioner()) return;
  const labelEl = document.getElementById("settings-snapshot-label");
  const label = (labelEl?.value || "").trim();
  const btn = event?.target;
  if (btn) { btn.disabled = true; btn.textContent = "Taking…"; }
  try {
    await takeLeagueSnapshotAsync(label);
    if (labelEl) labelEl.value = "";
    if (typeof logActivityAsync === "function") logActivityAsync("snapshot_taken", { label });
    await _refreshSnapshotList();
    showToast("Snapshot saved");
  } catch (e) {
    alert("Couldn't take snapshot: " + (e.message || e));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Take Snapshot"; }
  }
}

async function _refreshSnapshotList() {
  const container = document.getElementById("settings-snapshot-list");
  if (!container) return;
  try {
    const snaps = await listLeagueSnapshotsAsync();
    if (!snaps.length) {
      container.innerHTML = `<div style="color:var(--text-dim);font-style:italic">No snapshots yet.</div>`;
      return;
    }
    container.innerHTML = snaps.map(s => {
      const when = new Date(s.takenAt).toLocaleString();
      const counts = s.counts;
      return `
        <div style="display:flex;align-items:center;gap:8px;padding:10px;background:var(--bg);border:1px solid var(--border);border-radius:6px;margin-bottom:6px;flex-wrap:wrap">
          <div style="flex:1;min-width:200px">
            <div style="color:var(--text-bright);font-weight:600;font-size:0.9rem">${escapeHtml(s.label)}</div>
            <div style="color:var(--text-dim);font-size:0.74rem;margin-top:2px">${escapeHtml(when)} — ${counts.trades} trades, ${counts.keeperSel} keeper rows, ${counts.rosterMoves} roster moves, ${counts.leagueState} state rows</div>
          </div>
          <button class="trade-btn" onclick="submitRestoreSnapshot('${escapeJsString(s.key)}', '${escapeJsString(s.label)}')" style="font-size:0.78rem;padding:5px 10px">Restore</button>
          <button class="trade-btn trade-btn-cancel" onclick="submitDeleteSnapshot('${escapeJsString(s.key)}', '${escapeJsString(s.label)}')" style="font-size:0.78rem;padding:5px 10px">Delete</button>
        </div>
      `;
    }).join("");
  } catch (e) {
    container.innerHTML = `<div style="color:var(--red)">Couldn't load snapshots: ${escapeHtml(String(e.message || e))}</div>`;
  }
}

async function submitRestoreSnapshot(key, label) {
  if (!isCommissioner()) return;
  if (!confirm(`Restore "${label}"? This wipes all current league data (trades, keepers, draft, settings) and replaces it with the snapshot. A safety snapshot of the current state will be saved first so you can undo this.`)) return;
  try {
    await restoreLeagueSnapshotAsync(key);
    if (typeof logActivityAsync === "function") logActivityAsync("snapshot_restored", { key, label });
    _applySettingsFromCache();
    if (typeof applyRosterAdjustments === "function") applyRosterAdjustments();
    if (typeof switchTab === "function") switchTab("settings");
    showToast("Snapshot restored");
  } catch (e) {
    alert("Restore failed: " + (e.message || e));
  }
}

async function submitDeleteSnapshot(key, label) {
  if (!isCommissioner()) return;
  if (!confirm(`Delete snapshot "${label}"? This can't be undone.`)) return;
  try {
    await deleteLeagueSnapshotAsync(key);
    await _refreshSnapshotList();
    showToast("Snapshot deleted");
  } catch (e) {
    alert("Delete failed: " + (e.message || e));
  }
}

function exportContractsCsv() {
  if (!isCommissioner()) { alert("Commissioners only."); return; }
  if (typeof applyRosterAdjustments === "function") applyRosterAdjustments();
  const sel = (typeof dbGetKeeperSelections === "function") ? dbGetKeeperSelections() : {};
  const priceExceptions = (typeof dbGetKeeperPriceExceptions === "function") ? dbGetKeeperPriceExceptions() : {};
  const yn = (b) => b ? "Y" : "";
  const rows = [];
  rows.push([
    "Team","Roster","Player","Year Acquired","Salary","Expiry",
    "Contract Status","Contract Label","Source","Contract Type",
    "Keeper Flag","Minor Keeper Flag","Rule 5 Flag","Trade Block Flag",
    "Price Exception Applied","ESPN Player ID","Injury Status","Notes",
  ]);

  for (const team of LEAGUE_DATA.teams) {
    const teamFlags = sel[team.id] || {};
    const majors = (typeof getEligiblePlayers === "function") ? getEligiblePlayers(team) : [];
    for (const p of majors) {
      const flags = teamFlags[p.name] || {};
      const expiry = (p.yearsRemaining != null) ? (CURRENT_SEASON + p.yearsRemaining) : "";
      rows.push([
        team.name,
        "ML",
        p.name,
        p.yearAcquired ?? "",
        p.price != null ? `$${p.price}` : "",
        String(expiry),
        p.contractStatus || "",
        p.contractLabel || "",
        p.source || "",
        p.contractType || "",
        yn(flags.keeper),
        yn(flags.minorKeeper),
        yn(flags.rule5),
        yn(flags.tradeBlock),
        yn(p.priceExceptionApplied),
        p.playerId ?? "",
        p.injuryStatus || "",
        "",
      ]);
    }
    for (const p of (team.callups || [])) {
      const flags = teamFlags[p.name] || {};
      const ms = getMinorLeagueContractStatus(p, CURRENT_SEASON);
      const expiry = (ms.yearsRemaining != null) ? (CURRENT_SEASON + ms.yearsRemaining) : (ms.contractNote || "");
      rows.push([
        team.name,
        "Call-up",
        p.name,
        p.yearAcquired ?? "",
        p.price != null ? `$${p.price}` : "",
        String(expiry),
        ms.eligibilityWarning ? "must-call-up" : "active",
        ms.eligibilityWarning ? `Must Call Up by ${ms.eligibilityWarning}` : "Active",
        "callup",
        "callup",
        yn(flags.keeper),
        yn(flags.minorKeeper),
        yn(flags.rule5),
        yn(flags.tradeBlock),
        yn(priceExceptions[p.name] != null),
        "",
        "",
        p.sendDownCount ? `${p.sendDownCount} prior send-down(s)` : "",
      ]);
    }
    for (const p of (team.minors || [])) {
      const flags = teamFlags[p.name] || {};
      const ms = getMinorLeagueContractStatus(p, CURRENT_SEASON);
      const expiry = (ms.yearsRemaining != null) ? (CURRENT_SEASON + ms.yearsRemaining) : (ms.contractNote || "");
      rows.push([
        team.name,
        "MiL",
        p.name,
        p.yearAcquired ?? "",
        "",
        String(expiry),
        ms.eligibilityWarning ? "must-call-up" : "active",
        ms.eligibilityWarning ? `Must Call Up by ${ms.eligibilityWarning}` : "Active",
        "minors",
        "minors",
        yn(flags.keeper),
        yn(flags.minorKeeper),
        yn(flags.rule5),
        yn(flags.tradeBlock),
        yn(priceExceptions[p.name] != null),
        "",
        "",
        p.sendDownCount ? `${p.sendDownCount} prior send-down(s)` : "",
      ]);
    }
  }

  const csv = rows.map(row => row.map(_csvEscapeCell).join(",")).join("\n");
  const dateStr = new Date().toISOString().slice(0, 10);
  const filename = `the-league-contracts-${CURRENT_SEASON}-${dateStr}.csv`;
  _downloadBlob(csv, filename, "text/csv;charset=utf-8");
}

function _csvEscapeCell(v) {
  const s = String(v == null ? "" : v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function _downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function submitSetSeason() {
  if (!isCommissioner()) { alert("Commissioners only."); return; }
  const el = document.getElementById("settings-season");
  const n = parseInt(el?.value || "", 10);
  if (!Number.isFinite(n) || n < 2020 || n > 2100) {
    alert("Enter a valid year between 2020 and 2100.");
    return;
  }
  if (n === CURRENT_SEASON) return;
  if (!confirm(`Set the current season to ${n}? This changes Expiry calculations league-wide.`)) return;
  const prev = CURRENT_SEASON;
  const settings = { ...getLeagueSettings(), currentSeason: n };
  try {
    await saveSettingsAsync(settings);
    _applySettingsFromCache();
    if (typeof logActivityAsync === "function") logActivityAsync("season_set", { from: prev, to: n });
    switchTab("settings");
  } catch (e) {
    alert("Couldn't save: " + (e.message || e));
  }
}

async function toggleEnforceRule5RosterSpot(checked) {
  if (!isCommissioner()) return;
  const settings = { ...getLeagueSettings(), enforceRule5RosterSpot: !!checked };
  try {
    await saveSettingsAsync(settings);
    if (typeof logActivityAsync === "function") logActivityAsync("settings_changed", { key: "enforceRule5RosterSpot", value: !!checked });
  } catch (e) {
    alert("Couldn't save: " + (e.message || e));
    switchTab("settings");
  }
}

async function toggleEnforceMinorsRosterSpot(checked) {
  if (!isCommissioner()) return;
  const settings = { ...getLeagueSettings(), enforceMinorsRosterSpot: !!checked };
  try {
    await saveSettingsAsync(settings);
    if (typeof logActivityAsync === "function") logActivityAsync("settings_changed", { key: "enforceMinorsRosterSpot", value: !!checked });
  } catch (e) {
    alert("Couldn't save: " + (e.message || e));
    switchTab("settings");
  }
}

// --- Rendering: Activity Feed ---

// Pairs of toggle events that should fold together when the same actor
// flips the same player's same flag rapidly. Each entry maps event type to
// the abstract "category" so flips are grouped regardless of direction.
const TOGGLE_CATEGORIES = {
  keeper_added:         { category: "keeper",       label: "keeper status" },
  keeper_removed:       { category: "keeper",       label: "keeper status" },
  minor_keeper_added:   { category: "minor_keeper", label: "MiLB keeper status" },
  minor_keeper_removed: { category: "minor_keeper", label: "MiLB keeper status" },
  rule5_added:          { category: "rule5",        label: "Rule 5 protection" },
  rule5_removed:        { category: "rule5",        label: "Rule 5 protection" },
  trade_block_added:    { category: "trade_block",  label: "trade block status" },
  trade_block_removed:  { category: "trade_block",  label: "trade block status" },
};

function collapseRepeatedToggles(items) {
  const WINDOW_MS = 5 * 60 * 1000;
  // Process in chronological order so we can fold forward; don't mutate the
  // shared cache items — clone any object that gets _collapsed metadata.
  const asc = [...items].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const out = [];
  for (const a of asc) {
    const meta = TOGGLE_CATEGORIES[a.type];
    if (!meta) { out.push(a); continue; }
    const last = out.length ? out[out.length - 1] : null;
    const lastMeta = last && TOGGLE_CATEGORIES[last.type];
    const sameActor = last && last.actor_team_id === a.actor_team_id;
    const samePlayer = last && (last.payload?.player_name || "") === (a.payload?.player_name || "");
    const inWindow = last && (new Date(a.created_at) - new Date(last.created_at)) <= WINDOW_MS;
    if (last && last._collapsed && last._collapsed.category === meta.category && sameActor && samePlayer && inWindow) {
      // Extend an in-progress collapsed group.
      out[out.length - 1] = {
        ...last,
        created_at: a.created_at,
        _collapsed: { ...last._collapsed, count: last._collapsed.count + 1, lastType: a.type },
      };
      continue;
    }
    if (last && lastMeta && lastMeta.category === meta.category && sameActor && samePlayer && inWindow) {
      // Convert the previous single event into a 2-count collapsed group.
      out[out.length - 1] = {
        ...last,
        created_at: a.created_at,
        _collapsed: { category: meta.category, label: meta.label, count: 2, firstType: last.type, lastType: a.type },
      };
      continue;
    }
    out.push(a);
  }
  // Re-sort newest-first to match the input order.
  return out.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

// When a draft pick is undone, hide both the original pick AND the undo
// from the activity feed — the user wants the trail to look like the pick
// just never happened. Same for Rule 5 picks.
function _filterUndonePicks(items) {
  const undoneR5 = new Set(); // round:idx:player_name keys
  const undoneMD = new Set(); // round:pick_in_round:player_name keys
  for (const a of items) {
    const p = a.payload || {};
    if (a.type === "rule5_pick_undone") {
      undoneR5.add(`${p.round}|${p.idx}|${p.player_name || ""}`);
    } else if (a.type === "minors_pick_undone") {
      undoneMD.add(`${p.round}|${p.pick_in_round}|${p.player_name || ""}`);
    }
  }
  return items.filter(a => {
    if (a.type === "rule5_pick_undone" || a.type === "minors_pick_undone") return false;
    const p = a.payload || {};
    if (a.type === "rule5_pick_made") return !undoneR5.has(`${p.round}|${p.idx}|${p.player_name || ""}`);
    if (a.type === "minors_pick_made") return !undoneMD.has(`${p.round}|${p.pick_in_round}|${p.player_name || ""}`);
    return true;
  });
}

function renderActivityView() {
  const raw = (typeof dbGetActivity === "function") ? dbGetActivity() : [];
  if (!raw.length) return '<p style="color:var(--text-dim)">No activity recorded yet.</p>';
  const items = collapseRepeatedToggles(_filterUndonePicks(raw));
  // Group by date label (Today / Yesterday / Mon May 6 etc.)
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86400000).toDateString();
  const groups = {};
  for (const a of items) {
    const d = new Date(a.created_at);
    let label = d.toDateString();
    if (label === today) label = "Today";
    else if (label === yesterday) label = "Yesterday";
    else label = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    if (!groups[label]) groups[label] = [];
    groups[label].push(a);
  }
  return Object.entries(groups).map(([label, rows]) => `
    <div class="section-header">${label} <span class="section-count">${rows.length}</span></div>
    <div style="margin-bottom:14px">
      ${rows.map(r => renderActivityItem(r)).join("")}
    </div>
  `).join("");
}

function renderActivityItem(a) {
  let undoBtn = "";
  if (isCommissioner()) {
    undoBtn = `<button onclick="undoActivityEntry('${escapeJsString(a.id)}')"
      title="Undo this entry"
      style="background:none;border:none;color:var(--text-dim);font-size:0.7rem;cursor:pointer;padding:2px 6px;margin-left:6px;text-decoration:underline">undo</button>`;
  }
  return `
    <div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);font-size:0.85rem;align-items:center">
      <div style="color:var(--text-dim);font-size:0.72rem;min-width:64px">${timestampHTML(a.created_at)}</div>
      <div style="flex:1;color:var(--text)">${describeActivity(a)}${undoBtn}</div>
    </div>
  `;
}

function _teamName(teamId) {
  if (!teamId) return "?";
  const t = LEAGUE_DATA.teams.find(x => x.id === teamId);
  return t ? t.name : teamId;
}

function describeActivity(a) {
  const actor = `<strong style="color:var(--text-bright)">${_teamName(a.actor_team_id)}</strong>`;
  const target = `<strong style="color:var(--text-bright)">${_teamName(a.target_team_id)}</strong>`;
  const p = a.payload || {};
  const player = p.player_name ? `<span style="color:var(--accent);font-weight:600">${escapeHtml(p.player_name)}</span>` : "this player";
  if (a._collapsed) {
    const c = a._collapsed;
    const currentlyOn = c.lastType.endsWith("_added");
    const stateColor = currentlyOn ? "var(--green)" : "var(--text-dim)";
    return `${actor} toggled ${player}'s ${c.label} <strong>${c.count}×</strong> <span style="color:${stateColor}">(currently ${currentlyOn ? "on" : "off"})</span>`;
  }
  switch (a.type) {
    case "keeper_added":
      return `${actor} tagged ${player} as a keeper${p.next_year_price != null ? ` <span style="color:var(--text-dim)">($${p.next_year_price})</span>` : ""}`;
    case "keeper_removed":
      return `${actor} removed ${player} as a keeper`;
    case "minor_keeper_added":
      return `${actor} tagged ${player} as a MiLB keeper`;
    case "minor_keeper_removed":
      return `${actor} removed ${player} as a MiLB keeper`;
    case "rule5_added":
      return `${actor} Rule 5–protected ${player}`;
    case "rule5_removed":
      return `${actor} unprotected ${player} (Rule 5)`;
    case "trade_block_added":
      return `${actor} put ${player} on the trade block`;
    case "trade_block_removed":
      return `${actor} removed ${player} from the trade block`;
    case "trade_recorded": {
      const t1 = _teamName(p.team1), t2 = _teamName(p.team2);
      const r1 = (p.team1_receives || []).map(formatTradeAsset).join(", ") || "—";
      const r2 = (p.team2_receives || []).map(formatTradeAsset).join(", ") || "—";
      return `${actor} recorded a trade — <strong>${t1}</strong> gets ${r1}; <strong>${t2}</strong> gets ${r2}`;
    }
    case "trade_deleted":
      return `${actor} deleted a trade between ${_teamName(p.team1)} and ${_teamName(p.team2)}`;
    case "minors_pick_made":
      return `${target} picked ${player} <span style="color:var(--text-dim)">(R${p.round}.${p.pick_in_round})</span>`;
    case "minors_pick_passed":
      return `${target} passed at <span style="color:var(--text-dim)">R${p.round}.${p.pick_in_round}</span>`;
    case "minors_pick_auto_skipped":
      return `${target}'s pick was auto-skipped (clock expired) at <span style="color:var(--text-dim)">R${p.round}.${p.pick_in_round}</span>`;
    case "minors_pick_undone":
      return `${actor} undid pick: ${player} (R${p.round}.${p.pick_in_round})`;
    case "minors_draft_reset":
      return `${actor} reset the Minors Draft`;
    case "minors_clock_started":
      return `${actor} started the draft clock`;
    case "minors_clock_paused":
      return `${actor} paused the draft clock`;
    case "minors_clock_resumed":
      return `${actor} resumed the draft clock`;
    case "rule5_draft_reset":
      return `${actor} reset the Rule 5 Draft`;
    case "callup_price_set":
      return `${actor} set ${player}'s call-up price to <strong>$${escapeHtml(p.price)}</strong> (${escapeHtml(p.year)})`;
    case "player_called_up":
      return `${actor} called up ${player}`;
    case "player_sent_down":
      return `${actor} sent ${player} back to the minors`;
    case "rule5_pick_made": {
      const fromTeam = p.from_team ? _teamName(p.from_team) : null;
      const fromHtml = fromTeam ? ` from <strong>${escapeHtml(fromTeam)}</strong>` : "";
      return `${target} Rule 5–picked ${player}${fromHtml} <span style="color:var(--text-dim)">(R${escapeHtml(p.round)}.${escapeHtml(p.idx)})</span>`;
    }
    case "rule5_pick_auto_skipped":
      return `${target}'s Rule 5 pick was auto-skipped (clock expired) at <span style="color:var(--text-dim)">R${escapeHtml(p.round)}.${escapeHtml(p.idx)}</span>`;
    case "rule5_clock_started":
      return `${actor} started the Rule 5 clock`;
    case "rule5_clock_paused":
      return `${actor} paused the Rule 5 clock`;
    case "rule5_clock_resumed":
      return `${actor} resumed the Rule 5 clock`;
    case "season_set":
      return `${actor} set the current season to <strong>${escapeHtml(p.to)}</strong> (was ${escapeHtml(p.from)})`;
    case "settings_changed":
      return `${actor} ${p.value ? "enabled" : "disabled"} <code>${escapeHtml(p.key)}</code>`;
    case "snapshot_taken":
      return `${actor} took a league snapshot${p.label ? `: <strong>${escapeHtml(p.label)}</strong>` : ""}`;
    case "snapshot_restored":
      return `${actor} restored the league to snapshot <strong>${escapeHtml(p.label || "")}</strong>`;
    case "fee_marked_paid": {
      const kindLabel = p.kind === "callup" ? "call-up" : p.kind === "luxury" ? "luxury tax" : "league";
      return `${actor} marked ${target}'s ${escapeHtml(kindLabel)} fee as paid`;
    }
    case "fee_marked_unpaid": {
      const kindLabel = p.kind === "callup" ? "call-up" : p.kind === "luxury" ? "luxury tax" : "league";
      return `${actor} marked ${target}'s ${escapeHtml(kindLabel)} fee as unpaid`;
    }
    case "luxury_fee_set":
      return `${actor} set ${target}'s luxury tax fee to <strong>$${escapeHtml(p.amount)}</strong>`;
    case "keeper_price_exception_set":
      return `${actor} set ${player}'s true salary to <strong>$${escapeHtml(p.price)}</strong>`;
    case "keeper_price_exception_removed":
      return `${actor} removed the keeper-price exception for ${player}`;
    case "commish_override":
      return `${actor} overrode ${player}'s contract <span style="color:var(--text-dim)">(${(p.fields || []).map(f => escapeHtml(f)).join(", ")})</span>`;
    case "constitution_edited":
      return `${actor} updated the league constitution`;
    default:
      return `${actor} did <code>${a.type}</code>`;
  }
}

// Player-name → contract-price lookup, built from every team's reconciled
// roster (auction, callup, FA pickup) via getEligiblePlayers. Memoized at
// module level; switchTab() invalidates so prices stay current.
let _playerPriceMapMemo = null;
function _invalidatePriceMap() { _playerPriceMapMemo = null; }
function _getPlayerPriceMap() {
  if (_playerPriceMapMemo) return _playerPriceMapMemo;
  const map = {};
  for (const team of LEAGUE_DATA.teams) {
    const eligible = (typeof getEligiblePlayers === "function") ? getEligiblePlayers(team) : [];
    for (const p of eligible) {
      // First team wins for ambiguous names (rare). Skip 0/null prices since
      // those carry no useful info.
      if (!(p.name in map) && typeof p.price === "number" && p.price > 0) {
        map[p.name] = p.price;
      }
    }
  }
  _playerPriceMapMemo = map;
  return map;
}

function formatTradeAsset(asset) {
  if (!asset) return "?";
  if (asset.type === "milb_pick") return `<span style="color:var(--accent)">${escapeHtml(asset.value || "MiLB pick")}</span>`;
  if (asset.type === "draft_dollars" || asset.type === "faab") return escapeHtml(asset.value);
  const name = asset.value || asset.name || "?";
  const priceMap = _getPlayerPriceMap();
  let suffix = "";
  if (asset.type === "minor") suffix = " (MiLB)";
  else if (priceMap[name] !== undefined) suffix = ` ($${priceMap[name]})`;
  return `<span style="color:var(--accent)">${escapeHtml(name)}${suffix}</span>`;
}

// Display label for a proposal status. The DB stores raw enum values
// ('pending' / 'accepted' / etc.) but the inbox UI surfaces "proposed" for
// pending offers since that's how owners think about them.
function formatProposalStatus(status) {
  if (status === "pending") return "proposed";
  return status;
}

// --- Rendering: Trophy Room ---

function renderTrophyRoomView() {
  if (typeof HISTORY_SNAPSHOT === "undefined" || !HISTORY_SNAPSHOT.seasons?.length) {
    return '<p style="color:var(--text-dim)">No history loaded. Run <code>python3 scripts/sync_history.py</code> to populate.</p>';
  }
  return HISTORY_SNAPSHOT.seasons.map((s, i) => renderTrophyRow(s, i)).join("");
}

// Historical abbrevs that don't match the current ESPN_ABBREV_TO_LOCAL map.
const HISTORICAL_ABBREV_OVERRIDES = {
  "WAR":  "dave",   // 2021 third place
  "BUST": "matt",   // 2019 third place
  "ROTB": "matt",   // Matt Rotbart, 2017–2018 (Rotbart Means Red Beard / Yu Maeda Me Do It)
  "#416": "dave",   // David Warshafsky, 2018 (The Yanger Bombs)
  "KFP":  "sam",    // Samuel Rotbart, 2017 (Team Kung Froe Panda)
  "ES":   "sam",    // Samuel Rotbart, 2018 (Team Eaton Sanoas)
  "JRAM": "dave",   // David Warshafsky, 2019 (also stored in some seasons as "JRam")
  "HADR": "matt",   // Matt Rotbart, 2021–2023
  "SDJ":  "sam",    // Samuel Rotbart, 2021–2023
};

// Case-insensitive lookups. The history snapshot has mixed-case abbrevs
// like "JRam" that wouldn't match an upper-case-only key map.
const _historicalAbbrevByUpper = (() => {
  const out = {};
  for (const [k, v] of Object.entries(HISTORICAL_ABBREV_OVERRIDES)) out[k.toUpperCase()] = v;
  return out;
})();
const _espnAbbrevByUpper = (() => {
  const out = {};
  for (const [k, v] of Object.entries(ESPN_ABBREV_TO_LOCAL)) out[k.toUpperCase()] = v;
  return out;
})();

const _trophyAbbrevWarned = new Set();
function trophyTeamLocalId(team) {
  const u = (team.abbrev || "").toUpperCase();
  return _historicalAbbrevByUpper[u] || _espnAbbrevByUpper[u] || null;
}
function trophyTeamLabel(team) {
  const localId = trophyTeamLocalId(team);
  if (localId) {
    const t = LEAGUE_DATA.teams.find(x => x.id === localId);
    if (t) return t.name;
  }
  if (team.abbrev && !_trophyAbbrevWarned.has(team.abbrev)) {
    _trophyAbbrevWarned.add(team.abbrev);
    console.warn(`[trophy] Unmapped historical abbrev "${team.abbrev}" — add it to HISTORICAL_ABBREV_OVERRIDES.`);
  }
  return team.name || team.abbrev || "?";
}
// Clickable label: if the historical team maps to a current LEAGUE_DATA team,
// wrap the name in a button that opens the manager-history modal.
function trophyTeamClickableLabel(team) {
  const label = trophyTeamLabel(team);
  const localId = trophyTeamLocalId(team);
  if (!localId) return escapeHtml(label);
  return `<span onclick="openManagerHistory('${escapeJsString(localId)}')" style="cursor:pointer;text-decoration:underline;text-decoration-color:rgba(255,255,255,0.25);text-underline-offset:3px" title="Click for finish history">${escapeHtml(label)}</span>`;
}

function renderTrophyRow(season, idx) {
  const ranks = { 1: [], 2: [], 3: [] };
  for (const t of season.standings) {
    if (ranks[t.rank]) ranks[t.rank].push(t);
  }
  const slot = (rank, color, accent, label, emoji) => {
    const teams = ranks[rank];
    return `
      <div style="flex:1;min-width:140px;background:linear-gradient(135deg, ${color}1f 0%, ${color}0a 100%);border:1px solid ${color}55;border-radius:12px;padding:14px;text-align:center;box-shadow:inset 0 1px 0 ${color}22">
        <div style="font-size:2.4rem;line-height:1">${emoji}</div>
        <div style="font-size:0.65rem;font-weight:800;color:${accent};letter-spacing:0.12em;text-transform:uppercase;margin-top:6px">${label}</div>
        <div style="margin-top:8px;color:var(--text-bright);font-weight:700;font-size:1rem;line-height:1.35">
          ${teams.length ? teams.map(t => {
            const pts = t.points != null ? ` <span style="color:var(--text-dim);font-weight:500;font-size:0.85rem">(${Number.isInteger(t.points) ? t.points : t.points.toFixed(1)})</span>` : "";
            return `${trophyTeamClickableLabel(t)}${pts}`;
          }).join("<br>") : '<span style="color:var(--text-dim);font-weight:400">—</span>'}
        </div>
      </div>
    `;
  };
  return `
    <div style="margin-bottom:22px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px">
        <div style="font-size:1.5rem;font-weight:800;color:var(--text-bright);letter-spacing:0.02em">${season.year}</div>
        <button onclick="openTrophyDetail(${idx})" style="background:none;border:1px solid var(--border);color:var(--accent);font-size:0.78rem;padding:5px 12px;border-radius:6px;cursor:pointer">Full standings</button>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        ${slot(1, '#FFD700', '#D4AF37', 'Champion', '🥇')}
        ${slot(2, '#C0C0C0', '#A0A0A0', 'Runner-up', '🥈')}
        ${slot(3, '#CD7F32', '#B5651D', 'Third', '🥉')}
      </div>
    </div>
  `;
}

function openTrophyDetail(seasonIdx) {
  if (typeof HISTORY_SNAPSHOT === "undefined") return;
  const season = HISTORY_SNAPSHOT.seasons[seasonIdx];
  if (!season) return;
  const existing = document.getElementById("trophy-detail-modal");
  if (existing) existing.remove();
  const modal = document.createElement("div");
  modal.id = "trophy-detail-modal";
  modal.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:1000;display:flex;align-items:flex-start;justify-content:center;padding:24px 16px;overflow-y:auto";
  modal.onclick = e => { if (e.target === modal) modal.remove(); };
  const sorted = [...season.standings].sort((a, b) => a.rank - b.rank);
  modal.innerHTML = `
    <div style="max-width:520px;width:100%;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:18px;margin-top:20px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px">
        <h3 style="margin:0;color:var(--text-bright)">${escapeHtml(String(season.year))} Final Standings</h3>
        <button onclick="document.getElementById('trophy-detail-modal').remove()" style="background:none;border:none;color:var(--text-dim);font-size:1.4rem;cursor:pointer;padding:0 4px;line-height:1">×</button>
      </div>
      <table class="player-table">
        <thead><tr><th style="text-align:left;width:60px">Rank</th><th style="text-align:left">Team</th><th style="text-align:right">Points</th></tr></thead>
        <tbody>
          ${sorted.map(t => {
            const medal = t.rank === 1 ? "🥇" : t.rank === 2 ? "🥈" : t.rank === 3 ? "🥉" : "";
            const pts = t.points != null ? (Number.isInteger(t.points) ? t.points : t.points.toFixed(1)) : "—";
            return `<tr>
              <td style="text-align:left">${t.rank}</td>
              <td><span class="player-name">${trophyTeamClickableLabel(t)}</span>${medal ? ` ${medal}` : ""}</td>
              <td style="text-align:right;color:var(--text-bright);font-weight:600">${pts}</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
  document.body.appendChild(modal);
}

// Manager finish history modal — line chart of year-over-year rank for the
// given current-team id. Only invoked from clickable team labels in trophy
// view (which already filtered to teams that map to a current LEAGUE_DATA team).
function openManagerHistory(teamId) {
  if (typeof HISTORY_SNAPSHOT === "undefined") return;
  const team = LEAGUE_DATA.teams.find(t => t.id === teamId);
  if (!team) return;

  // Walk every season; find this manager's row by mapping each historical
  // standings entry's abbrev → localId via trophyTeamLocalId.
  const points = [];
  for (const season of HISTORY_SNAPSHOT.seasons) {
    const row = (season.standings || []).find(t => trophyTeamLocalId(t) === teamId);
    if (row) {
      points.push({ year: season.year, rank: row.rank, score: row.points });
    }
  }
  // Sort oldest → newest left-to-right.
  points.sort((a, b) => a.year - b.year);

  // Find the maximum rank ever (so the y-axis covers all finishes — rank 12
  // most years but used to be 11 in earlier expansion eras).
  let maxRank = 12;
  for (const s of HISTORY_SNAPSHOT.seasons) {
    for (const t of (s.standings || [])) {
      if (t.rank > maxRank) maxRank = t.rank;
    }
  }

  const existing = document.getElementById("manager-history-modal");
  if (existing) existing.remove();
  const modal = document.createElement("div");
  modal.id = "manager-history-modal";
  modal.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:1000;display:flex;align-items:flex-start;justify-content:center;padding:24px 16px;overflow-y:auto";
  modal.onclick = e => { if (e.target === modal) modal.remove(); };

  const W = 560;          // SVG width
  const H = 320;          // SVG height
  const PADL = 36;        // left axis padding
  const PADR = 24;
  const PADT = 24;
  const PADB = 36;
  const innerW = W - PADL - PADR;
  const innerH = H - PADT - PADB;

  let chart = "";
  if (points.length === 0) {
    chart = `<div style="color:var(--text-dim);text-align:center;padding:30px 0">No history found for ${escapeHtml(team.name)} yet.</div>`;
  } else {
    const years = points.map(p => p.year);
    const minY = Math.min(...years);
    const maxY = Math.max(...years);
    const yearSpan = Math.max(1, maxY - minY);
    const xFor = (year) => PADL + (yearSpan === 0 ? innerW / 2 : ((year - minY) / yearSpan) * innerW);
    const yFor = (rank) => PADT + ((rank - 1) / (maxRank - 1)) * innerH; // rank 1 → top

    // Y-axis grid lines for ranks 1, mid, max
    const gridRanks = [1, Math.ceil(maxRank / 2), maxRank];
    let grid = "";
    for (const r of gridRanks) {
      const y = yFor(r);
      grid += `<line x1="${PADL}" y1="${y}" x2="${W - PADR}" y2="${y}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>`;
      grid += `<text x="${PADL - 8}" y="${y + 4}" fill="rgba(255,255,255,0.45)" font-size="11" text-anchor="end">${r}</text>`;
    }
    // X-axis year labels
    let yearLabels = "";
    for (const p of points) {
      const x = xFor(p.year);
      yearLabels += `<text x="${x}" y="${H - PADB + 18}" fill="rgba(255,255,255,0.55)" font-size="11" text-anchor="middle">'${String(p.year).slice(-2)}</text>`;
    }
    // Connect points
    let line = "";
    if (points.length > 1) {
      const d = points.map((p, i) => `${i === 0 ? "M" : "L"} ${xFor(p.year).toFixed(1)} ${yFor(p.rank).toFixed(1)}`).join(" ");
      line = `<path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
    }
    // Points
    let dots = "";
    for (const p of points) {
      const cx = xFor(p.year);
      const cy = yFor(p.rank);
      const isGold = p.rank === 1;
      const isPodium = p.rank <= 3;
      const fill = isGold ? "#FFD700" : isPodium ? "#C0C0C0" : "var(--accent)";
      dots += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${isGold ? 6 : 5}" fill="${fill}" stroke="var(--bg-card)" stroke-width="2"/>`;
      dots += `<text x="${cx.toFixed(1)}" y="${(cy - 10).toFixed(1)}" fill="var(--text-bright)" font-size="11" font-weight="700" text-anchor="middle">${p.rank}</text>`;
    }
    chart = `
      <div style="overflow-x:auto">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;display:block;min-width:320px">
          ${grid}
          ${line}
          ${dots}
          ${yearLabels}
          <text x="${PADL - 28}" y="${PADT + 12}" fill="rgba(255,255,255,0.55)" font-size="10" text-anchor="start" transform="rotate(-90 ${PADL - 28} ${PADT + 12})">Finish</text>
        </svg>
      </div>
    `;
  }

  // Mini summary stats
  const champs = points.filter(p => p.rank === 1).length;
  const podiums = points.filter(p => p.rank <= 3).length;
  const avgRank = points.length ? (points.reduce((s, p) => s + p.rank, 0) / points.length) : null;
  const yearsList = points.map(p => `${p.year}: <strong style="color:var(--text-bright)">#${p.rank}</strong>`).join(" · ");

  modal.innerHTML = `
    <div style="max-width:640px;width:100%;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:18px;margin-top:20px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px">
        <h3 style="margin:0;color:var(--text-bright)">${escapeHtml(team.name)} — Finish History</h3>
        <button onclick="document.getElementById('manager-history-modal').remove()" style="background:none;border:none;color:var(--text-dim);font-size:1.4rem;cursor:pointer;padding:0 4px;line-height:1">×</button>
      </div>
      ${points.length ? `
        <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:12px;font-size:0.82rem;color:var(--text-dim)">
          <span><strong style="color:#FFD700">${champs}</strong> championship${champs === 1 ? "" : "s"}</span>
          <span><strong style="color:var(--text-bright)">${podiums}</strong> podium${podiums === 1 ? "" : "s"}</span>
          <span>Avg finish: <strong style="color:var(--text-bright)">${avgRank.toFixed(1)}</strong></span>
          <span>Seasons: <strong style="color:var(--text-bright)">${points.length}</strong></span>
        </div>
      ` : ""}
      ${chart}
      ${points.length ? `<div style="margin-top:12px;font-size:0.78rem;color:var(--text-dim);line-height:1.6">${yearsList}</div>` : ""}
    </div>
  `;
  document.body.appendChild(modal);
}

// --- Rendering: League Rules ---

const DEFAULT_CONSTITUTION = `# The League Constitution

## 1) General Settings

### a) 26 Round Auction-style Draft
- Nomination order is randomly assigned by ESPN
- $260 budget per team
- Positions: C, 1B, 2B, SS, 3B, MI, CI, 5 OF, Util, 9 P, 4 Bench
- 7 IL spots are available during the season, but cannot be filled until after the draft

### b) Trading Draft Dollars
- Trading draft dollars is permitted only for the next upcoming draft — not for other future drafts
- No manager can acquire more than $30 for any draft (on top of the standard $260 budget — i.e., $290 max). A manager can trade away as many draft dollars as they want, but they do so at their own peril for the next season. If a manager wishes to trade away more than $10, he must pay a $200 security to the Commissioner, which he will get back upon returning to the league the next year. If the manager leaves the league following a season in which he traded away more than $10, he will forfeit the $200 security, which goes into the next season's prize pool
  - *(1/31/20 MVR Clarification: A manager may collect more than $290 prior to a given auction draft, but may not enter the draft with more than $290. Any amount above $290 is forfeited.)*
- Trading draft dollars has no effect on the process for determining keeper values for drafted players

### c) 5 × 5 Rotisserie
- **Batting Categories:** Runs, HR, RBI, SB, OBP
- **Pitching Categories:** Quality Starts, K's, Saves+Holds, ERA, WHIP

### d) Rosters
- Daily Roster Changes
- 200 Game Start limit for pitchers
- 2106 Game Start limit for hitters
- 1000 IP min to qualify for ERA and WHIP

### e) ESPN Settings
- Additional settings can be found on the league's ESPN page (use the "The League" header link)

## 2) Keeper Rules

### a) Keeper Limits
- As of the keeper submission date (a week before draft day), managers can keep up to **8 players** on their major league roster, and up to **10 players** on their minor league roster

### b) Major League Keepers (max 8)
- Minimum cost = $1. Non-integer keeper values are rounded up
- Players drafted can be kept for up to 3 additional years at their draft value. Each year, the price to keep a player increases by $2
  - *Example: If Rotbart drafts Tulowitzki for $60, he can keep Tulo for the following season at $62 or return him to the draft pool. After Year 2, he again decides — keep for $64 or return.*
- Players who are traded keep their cost basis if they are kept (see also: Trade Deadline rules)
- Players picked up via free agency who are kept will cost **$6** to keep the first year they are eligible to be kept. FA can be kept for three years following the pickup year, with the price increasing by $2 each year
  - *Example: Player A added off waivers in 2017 → keepable for $6 in 2018, $8 in 2019, $10 in 2020, then must be returned to FA pool*
- If a player playing in the final year of his contract is dropped and subsequently added via FA/waivers, he is **not eligible to be kept**. He will return to the draft regardless

### c) Post-Keeper-Deadline Drops (Injury / Legal News)
- After the keeper deadline and up to 3 hours before the auction draft, a team can drop a keeper (without replacing them) if it is announced or reported that the player has suffered an injury, there is concern that an injury may have occurred, or there is news of disciplinary or criminal legal proceedings
- Only applies to news first reported **after** the keeper deadline. If a player was already known to be injured at the time of keeper selection, you cannot change your decision based on regret or new reporting about severity

### d) Newly-Drafted Player Caps (since 2019)
- Players whose auction price exceeds **$40** may be kept for a max of **2 additional years** beyond the year drafted
- Players whose auction price exceeds **$50** may be kept for a max of **1 additional year** beyond the year drafted
- All other players are subject to the existing 3-year rule

### e) Minor League Keepers (max 10)
- A player may be kept on the minor league roster — no major league keeper spots are used and the owner does not pay any real or draft dollars
- **Pre-2027 drafted:** minor leaguers are drafted to 4-year contracts. Drafted in 2017 (year 1) → keepable through 2020
- **2027+ drafted:** "call up + 3 year" contracts — kept up to 3 years after call-up to the major league roster. Drafted 2027, called up 2030 → keepable through 2033
- In the first year a former minor league keeper is kept, his price is based on ESPN's roto rankings on March 1:
  - Outside top 200: **$1**
  - 100–199: **$3**
  - 50–99: **$5**
  - 20–49: **$10**
  - Top 19: **$15**
  - Then **+$2/year** after that
  - *Example: David Dahl drafted to minors 2015, called up 2016, ranked 138 on March 1 → $3 in 2017, $5 in 2018, returned to draft 2019. Spreadsheet keeper values update March 1; before then, "TBD".*
- If a Minor League player drafted in the League's Minor League draft is called up to their MLB team, **NO ONE** is allowed to pick that player up in FA should they appear on ESPN's "Available Players" queue. A Minor League restricted list is kept as a Google Doc and updated as needed. Undrafted call-ups are fair game through Waivers (see also: Waivers Auction)

## 3) Minor Leagues

### a) Minor League Draft
- 7 rounds, run in **reverse standings order** from the previous season (not auction, not snake)
- Tiebreaker: team with the lower keeper standings position drafts first
- **Anti-tanking:** any team scoring under 45 rotisserie points moves to the bottom of the order for the next year's minor league draft. Does not impact picks already traded prior to the season's trade deadline
  - *Example: If Matt traded his 1st round pick to Jeff in May, but finishes with 40 total roto points (11th), Matt picks last — but Jeff still has the original pick (first overall).*
  - If multiple teams score below 45 roto points, the higher-scoring team gets the higher spot
- **February 2025 Amendment:** Picks traded **after May 15** are not locked in place if the trading team finishes below 45 points. Only picks traded on or before May 15 are protected
- Teams continue to draft in order until the earlier of (a) the team has filled a 10-man minor league roster, or (b) has used all of their picks
- No team is ever permitted to hold more than 10 minor league players at keeper deadline or at the conclusion of the minor league draft. If a trade gives a manager more than 10 minor leaguers mid-season, they may hold all players, but may keep no more than 10 the following offseason
- **Beginning in 2027:** the only way to exceed 10 minor leaguers is via trade — the limit cannot be exceeded by sending a player from majors down to minors
- Managers forfeit any remaining draft picks that would put their minor league roster above 10 players
- Managers can drop players from their Minor League roster at any point (except during the minors draft), but are never allowed to add to their minor league rosters via free agency — only via the draft and/or trades
- Managers may trade minor league draft picks but only for the next draft — no further-out drafts in the future

### b) Minor League Transactions
- Minor leaguers can be called up to a manager's major league roster at any point without cost. The manager must create an open roster spot by moving a player to the DL or dropping a player; the commissioner will then add the player
- You **can't** waive a minor league player during the minor league draft to draft someone new (otherwise you could block people from picking your minors guy with no consequence)
- You **can** call a minor leaguer up to the majors during the minor league draft by dropping someone from your major league roster
- After keepers are selected but before the major league draft, you may drop someone from your minors (without dropping a major league player) by announcing it to the league — the player then becomes available in the minor league draft
- **$10 send-down fee:** Players recalled from a minors roster previously can be returned to the minors if still eligible for a fee of **$10 (REAL MONEY)**, at any time. These fees go into the season's prize pool
- **As of Jan 30, 2026:** Managers can call up minor leaguers after the keeper deadline and before the major league draft. The minor leaguer would cost **$0** in the major league draft. No limit on the number of players that can be called up. Call-ups must happen at least **24 hours** prior to the majors draft

### c) Eligibility
- To be eligible to be drafted in the minor leagues, players must not have surpassed either of the following in their MLB regular-season career:
  - **200 at-bats**, or
  - **50 innings pitched**
- If a player was drafted in the minor league draft and is currently in the final three years of his contract, he is "grandfathered" in and may be kept through the life of his contract
- Players on a roster at the start of the minor league draft are not eligible to be selected in the draft
- No free agent pickups or major league draft selections may be placed on the Minor League roster, even if a slot is available

### d) Drop Restrictions for Pre-MLB Auction Draftees
- Players who have not played any MLB games as of the auction draft date (excluding international FA signed in that prior offseason) drafted in the auction may not be dropped until **April 15** unless:
  - They are placed on the major league or minor league DL, or
  - They are acquired for more than $1 in the auction
- The expectation/honor rule: owners will not nominate players during the auction for the purpose of preventing them from being selected in the minor league draft
- **As of March 2026:** A grace period immediately following the auction allows a player subject to the above rule to be dropped prior to the minor league draft and then not need to be kept until April 15. Players dropped during the grace period are still eligible for the minor league draft

### e) FAAB Restrictions on Outside-Top-300 Minor Eligible Players
- **As of March 2026:** Players who are eligible for the minor league draft and ranked outside the ESPN top 300 as of March 1 may not be added via FAAB prior to or during the minor league draft. Once the minor league draft ends, these players may be added via FAAB

### f) Mandatory Call-Up or Drop on AB/IP Threshold
- **As of Jan 30, 2026:** Minor league players must be either called up or dropped from your minors roster by the end of the minor league draft following the season where the player achieves either **75 IP** or **300 AB**. Drops can only happen during the offseason prior to the keeper deadline
  - *Example: Jackson Holliday reached his 300th MLB AB during the 2025 season. He must be either dropped during keeper selection or called up to the majors prior to the completion of the 2026 minor league draft.*

## 4) Trades

### a) Deadline
- The trade deadline for each season is set on ESPN
- No trades involving major league players are permitted after this deadline
- No players picked up on FA after this deadline may be kept
- After the deadline, trades involving draft dollars, draft picks, and minor leaguers are still permitted — but any traded minor leaguer is **not eligible** to be called up until the following offseason

### b) Vetoes
- Trades can only be vetoed by the league commissioner. League members may contact the commissioners to lodge a protest
- The only acceptable reasons to veto a trade are: potential **collusion or unfair play**, **mistakenly accepted trades**, or **mutual agreement** among parties involved
- These can be subjective. Trades cannot be vetoed out of personal disdain, fear of a rival improving, or bad sportsmanship

### c) Trade Acceptance
- All trades must be proposed and accepted on the ESPN platform. Additional terms (picks, draft $) should be announced by email or on the league Slack page
- **No conditional trades** — all terms of the trade must be finalized when the trade is announced
- If no protest is presented within **24 hours** of the trade, it processes automatically

## 5) Rule 5 Draft

*The purpose of the Rule 5 draft is to encourage off-season trading and activity.*

- By **January 31st at midnight** (modifiable by commissioner if there are new teams joining), teams must shrink their full roster (Majors plus Minors) to **25 guys**. Failure to do so → commissioner drops players based on whoever the commissioner deems least valuable. All released/non-protected players are available for a Rule 5 draft maintaining their existing contract status
- The Rule 5 draft begins on a date selected by the commissioner and is conducted in **snake fashion** in **reverse standings order**
- If a player is drafted, the team selecting that player must pay the team from which the player originated **$1** for the upcoming season
- There is no obligation to make any selections during the Rule 5 draft. There is no obligation to drop any player upon adding one in the Rule 5 draft
- Rule 5 drafted players are eligible to be kept or traded by the team that drafts them. They maintain their prior contract status
- Teams may only select players in the Rule 5 draft if they have an open spot on their **25-man roster**
  - *Enter Rule 5 with 24 players → make 1 selection. Enter with 23 → up to 2. Etc.*
- Players not protected in the Rule 5 draft who are not selected by another team are **not eligible** to be kept or traded by the original team who chose not to protect them

## 6) Waiver Process (FAAB)

- A free agent auction (FAAB) is held **tri-weekly**. Each week, managers can submit bids until **11am** on the days waivers process: **Tuesdays, Thursdays, and Sundays**
- Managers begin each season with a **$1000 budget**. Winning bids do **NOT** determine the cost basis for keeper purposes — all FA keepers cost **$6**. Zero-dollar bids are permitted
- Managers are expected to know all prohibited players (anyone on minors rosters), made public in the spreadsheet at all times. If a bid is processed for a player on another team's minors roster:
  - The player is dropped from the manager's team
  - No FAAB dollars are recovered
  - No dropped player is returned
  - **CHECK THE MINOR LEAGUE ROSTERS BEFORE SUBMITTING A CLAIM**
- Players dropped in the **fourth and final year** of their contract are eligible to be added via free agency for the remainder of the season but **may not be kept**
- Players may not be dropped and re-added with the intention to reset their contract status. The commissioner makes the final ruling in any dispute over intent
- **Trading FAAB dollars is allowed (as of 2026)**

## 7) Fees / Prizes

- League entry fee is **$300 each season**, payable at or before the keeper deadline. **NO EXCEPTIONS**
- Cost to return a player to the Minor League roster is **$10**. Minor League transaction fees are collected following the end of the season. Offseason send-down fees count toward the previous season's pot
- **Payouts:**
  - **1st place:** $2,300 + any other league fees collected for that year (minor league fees, forfeited security fees) + decides draft location for the next season (within geographical reason)
  - **2nd place:** $1,000
  - **3rd place:** $300
- At the end of each season, **"keeper standings"** are posted to the league spreadsheet — total roto points each team has accumulated for the entirety of the league, and roto points per year. The point: show which teams and owners are best over time. Bragging rights ensure teams don't bottom out in any individual year. Expansion teams use roto points per year for missing seasons; their per-year value updates each season

## 8) Expansion Draft Rules

- **Protection counts:**
  - Finished 1–3 prior year: protect up to **6 ML / 7 MiL**
  - Finished 4–8: protect up to **7 ML / 8 MiL**
  - Bottom three (9–11): protect up to **8 ML / 9 MiL**
- All other players are available for the expansion team to select. The expansion team may choose **up to 25 players total**
- If the expansion team takes more than two players from any team, it pays the owner of that team **$5 for the third** player selected and **$10 for each subsequent** player selected
- The expansion team gets the **#4 overall pick** in the minor league draft and starts at **$260** draft dollars (pre-expansion draft)
- League members get **at least two weeks' notice** of the expansion draft so teams can make trades in anticipation (e.g., to consolidate keepers)
- The expansion draft runs for a few days (exact timing TBD); during that period the expansion drafter may trade with other teams (including in exchange for not selecting a player)

## 9) Disputes

- Any and all disputes are decided by a **league vote** (except for trade issues)
- The trade veto rules, disputes rules, and this Constitution exist to prevent scenarios that could cause ill-will or tension. This is Fantasy Baseball, and like all Fantasies, it is meant to be fun. If a manager is attempting to **cheat, bribe, collude, or betray the good spirit** of the League, that manager may be kicked out and forfeit league fees already paid
- Any **significant changes** to the constitution require a **majority vote**. The commissioner determines what constitutes a significant change and notifies the league of all changes. The commissioner also decides whether any rule changes should be delayed before being implemented to account for reliance on past rules in connection with decisions that could impact the value of keepers, picks, etc.

## 10) Luxury Tax

- Teams are taxed for every dollar of salary they exceed the luxury threshold of **$350** upon the conclusion of the trade deadline. The luxury tax is determined by a calculator in The League Google Sheet
  - *Example: Total salary post-deadline of $450 → taxed $100*
- The luxury tax pool is available for the **4th and 5th place teams**, split **60:40** to 4th and 5th
  - Maximum 4th place can win is **$300**; any excess goes to **3rd place**
  - *Example (2025): pool would have been $569 → 5th place wins $228, 4th place wins $300, 3rd place wins $341*
`;

function getConstitutionMarkdown() {
  const stored = (typeof dbGetConstitution === "function") ? dbGetConstitution() : null;
  return stored && stored.trim() ? stored : DEFAULT_CONSTITUTION;
}

// Lightweight markdown→HTML for the constitution. Intentionally narrow: handles
// h1/h2/h3, bullets (incl. one level of nesting via 2-space indent), bold, italic,
// inline code, and paragraphs. Anything else gets escaped.
function renderConstitutionHTML(md) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let listStack = []; // array of indent levels
  const closeListsTo = (target) => {
    while (listStack.length > target) {
      out.push("</ul>");
      listStack.pop();
    }
  };
  const inline = (s) => {
    let t = escapeHtml(s);
    t = t.replace(/`([^`]+)`/g, '<code style="background:rgba(255,255,255,0.06);padding:1px 5px;border-radius:4px;font-size:0.9em">$1</code>');
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong style="color:var(--text-bright)">$1</strong>');
    t = t.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
    return t;
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) { closeListsTo(0); continue; }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      closeListsTo(0);
      const level = h[1].length;
      const text = inline(h[2]);
      if (level === 1) out.push(`<h2 style="color:var(--text-bright);margin:24px 0 10px;font-size:1.5rem">${text}</h2>`);
      else if (level === 2) out.push(`<h3 style="color:var(--accent);margin:20px 0 8px;font-size:1.1rem;border-bottom:1px solid var(--border);padding-bottom:4px">${text}</h3>`);
      else out.push(`<h4 style="color:var(--text-bright);margin:14px 0 6px;font-size:0.95rem">${text}</h4>`);
      continue;
    }
    const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (bullet) {
      const indent = Math.floor(bullet[1].length / 2);
      while (listStack.length <= indent) {
        out.push('<ul style="margin:6px 0 6px 18px;padding:0;line-height:1.65">');
        listStack.push(listStack.length);
      }
      closeListsTo(indent + 1);
      out.push(`<li style="margin:3px 0">${inline(bullet[2])}</li>`);
      continue;
    }
    closeListsTo(0);
    out.push(`<p style="margin:8px 0;line-height:1.6">${inline(line)}</p>`);
  }
  closeListsTo(0);
  return out.join("\n");
}

function renderRulesView() {
  const md = getConstitutionMarkdown();
  const editBtn = isCommissioner()
    ? `<button class="trade-btn" onclick="enterRulesEdit()" style="font-size:0.78rem">Edit</button>`
    : "";
  return `
    <div id="rules-view-container">
      ${editBtn ? `<div style="display:flex;justify-content:flex-end;margin-bottom:14px">${editBtn}</div>` : ""}
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:18px 22px;box-shadow:var(--shadow);max-width:780px">
        ${renderConstitutionHTML(md)}
      </div>
    </div>
  `;
}

function enterRulesEdit() {
  if (!isCommissioner()) return;
  const md = getConstitutionMarkdown();
  const main = document.getElementById("main-content");
  if (!main) return;
  main.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px">
      <div style="font-size:0.78rem;color:var(--text-dim)">Markdown. Use <code>#</code>/<code>##</code> for headings, <code>-</code> for bullets, <code>**bold**</code>, <code>*italic*</code>.</div>
      <div style="display:flex;gap:8px">
        <button class="trade-btn trade-btn-cancel" onclick="switchTab('rules')">Cancel</button>
        <button class="trade-btn trade-btn-submit" onclick="saveRulesEdit()">Save</button>
      </div>
    </div>
    <textarea id="rules-edit-textarea"
      style="width:100%;min-height:62vh;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:0.85rem;line-height:1.5"
    >${escapeHtml(md)}</textarea>
  `;
}

async function saveRulesEdit() {
  if (!isCommissioner()) return;
  const ta = document.getElementById("rules-edit-textarea");
  if (!ta) return;
  const next = ta.value;
  try {
    if (typeof saveConstitutionAsync === "function") await saveConstitutionAsync(next);
    if (typeof logActivityAsync === "function") logActivityAsync("constitution_edited", {});
    if (typeof switchTab === "function") switchTab("rules");
  } catch (e) {
    alert("Save failed: " + (e.message || e));
  }
}

// --- Rule 5 Draft ---

function getRule5State() {
  if (typeof dbGetRule5 === "function") return dbGetRule5();
  try { return JSON.parse(localStorage.getItem("flm_rule5") || "null"); }
  catch { return null; }
}

async function resetRule5Draft() {
  if (!confirm("Reset entire Rule 5 draft?")) return;
  // Sweep the auto-recorded $1 Rule 5 trades alongside the state. Match by
  // a structured marker we attach when the trade is inserted, falling back
  // to the legacy notes prefix for older entries.
  if (typeof deleteTradeAsync === "function" && typeof getTrades === "function") {
    const rule5Trades = (getTrades() || []).filter(t =>
      t.rule5 === true
      || t.rule5PickClientId
      || (t.notes && /^Rule 5 pick \(Round /.test(t.notes))
    );
    for (const t of rule5Trades) {
      if (t._id) {
        try { await deleteTradeAsync(t._id); }
        catch (e) { console.warn("rule5 trade cleanup failed:", e); }
      }
    }
  }
  if (typeof saveRule5Async === "function") {
    saveRule5Async(null)
      .then(() => {
        if (typeof logActivityAsync === "function") logActivityAsync("rule5_draft_reset", {});
        switchTab("rule5");
      })
      .catch(err => alert("Reset failed: " + err.message));
  } else {
    localStorage.removeItem("flm_rule5");
    switchTab("rule5");
  }
}

function saveRule5State(state) {
  if (typeof saveRule5Async === "function") {
    saveRule5Async(state).catch(err => alert("Save failed: " + err.message));
  } else {
    localStorage.setItem("flm_rule5", JSON.stringify(state));
  }
}

function buildRule5Pool() {
  // Pool = every eligible keeper across the league who is keepable (canKeepNextYear),
  // not marked as keeper (ML or MiL), and not Rule-5-protected.
  const selections = getEligibleKeeperSelections();
  const pool = [];

  LEAGUE_DATA.teams.forEach(team => {
    const teamSel = selections[team.id] || {};
    const players = getEligiblePlayers(team);

    // ML roster
    players.forEach(p => {
      const sel = teamSel[p.name] || {};
      if (sel.keeper || sel.rule5 || !p.canKeepNextYear) return;
      if (p.yearsRemaining === 0) return;     // contract is up at end of season — not Rule 5 eligible
      pool.push({
        name: p.name,
        playerId: p.playerId,
        type: "major",
        originTeamId: team.id,
        originTeamName: team.name,
        source: p.source,
        price: p.price,
        nextYearPrice: p.nextYearPrice,
        contractLabel: p.contractLabel,
        yearsRemaining: p.yearsRemaining,
        originalDraftYear: p.originalDraftYear,
        fromMinors: p.fromMinors,
      });
    });

    // Minors
    team.minors.forEach(p => {
      const sel = teamSel[p.name] || {};
      if (sel.minorKeeper || sel.rule5) return;
      // Minors are "unkeepable" if they've passed the 4-year window or hit ML cap
      const yearsHeld = CURRENT_SEASON - p.yearAcquired;
      const overContractWindow = p.yearAcquired < 2027 && yearsHeld >= 4;
      const hitsCap = (p.statType === "AB" && p.careerStat >= 300) || (p.statType === "IP" && p.careerStat >= 75);
      if (overContractWindow || hitsCap) return;
      const yearsRemaining = p.yearAcquired < 2027
        ? Math.max(0, p.yearAcquired + 3 - CURRENT_SEASON)
        : null; // post-2027 is "call-up + 3" — open ended
      if (yearsRemaining === 0) return;       // contract expires after this season
      pool.push({
        name: p.name,
        type: "minor",
        originTeamId: team.id,
        originTeamName: team.name,
        source: "MiLB",
        price: null,
        nextYearPrice: null,
        contractLabel: `MiLB drafted ${p.yearAcquired}`,
        yearsRemaining,
        originalDraftYear: p.yearAcquired,
        fromMinors: true,
        careerStat: p.careerStat,
        statType: p.statType,
      });
    });
  });

  return pool.sort((a, b) => lastName(a.name).localeCompare(lastName(b.name)));
}

function renderRule5View() {
  const state = getRule5State();
  const commish = isCommissioner();

  if (!state) {
    return `
      <div style="padding:24px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);text-align:center">
        <h3 style="margin-bottom:10px;color:var(--text-bright)">Rule 5 Draft Pool</h3>
        <p style="color:var(--text-dim);font-size:0.9rem;margin-bottom:14px">
          Pool will include every eligible keeper across the league who is not<br>
          marked as a keeper, not Rule 5 protected, and is keepable next year.
        </p>
        ${commish
          ? `<button class="trade-btn trade-btn-submit" onclick="loadRule5Pool()">Load Rule 5 Pool</button>`
          : `<p style="color:var(--text-dim);font-size:0.85rem;font-style:italic">Only the commissioner can load the pool.</p>`}
      </div>
    `;
  }

  // Enrich pool entries with derived fields in case the snapshot is older than current code.
  const enrichPoolEntry = (p) => {
    let yearsRemaining = p.yearsRemaining;
    if (yearsRemaining == null) {
      if (p.type === "minor" && p.originalDraftYear != null && p.originalDraftYear < 2027) {
        yearsRemaining = Math.max(0, p.originalDraftYear + 3 - CURRENT_SEASON);
      } else if (p.type === "major") {
        // Re-resolve from current eligible-player data
        const team = LEAGUE_DATA.teams.find(t => t.id === p.originTeamId);
        if (team) {
          const players = getEligiblePlayers(team);
          const match = players.find(x => x.name === p.name);
          if (match) yearsRemaining = match.yearsRemaining;
        }
      }
    }
    return { ...p, yearsRemaining };
  };

  const pool = (state.pool || []).map(enrichPoolEntry);
  const picks = state.picks || [];
  const pickedNames = new Set(picks.filter(p => !p.pass).map(p => p.playerName));
  const remaining = pool.filter(p => !pickedNames.has(p.name));
  const teamName = id => LEAGUE_DATA.teams.find(t => t.id === id)?.name || id;

  // Phase 1: order setup
  if (!state.started) {
    return `
      <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">
        <span style="color:var(--text-dim);font-size:0.8rem;align-self:center">Pool loaded ${new Date(state.loadedAt).toLocaleString()} · ${pool.length} players</span>
        ${commish ? `
          <button class="trade-btn" style="margin-left:auto;font-size:0.78rem" onclick="refreshRule5Pool()">Refresh Pool</button>
          <button class="trade-btn trade-btn-cancel" style="font-size:0.78rem" onclick="resetRule5Draft()">Reset</button>
        ` : ''}
      </div>
      <div class="keeper-projection">
        <h3>Draft Order (Round 1)</h3>
        <div style="color:var(--text-dim);font-size:0.82rem;margin-bottom:10px">
          Snake order — round 2 reverses, round 3 reverses again, etc. Reorder to reflect reverse standings.
        </div>
        ${state.order.map((id, i) => `
          <div style="display:flex;align-items:center;gap:8px;padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:6px;margin-bottom:4px">
            <span style="color:var(--text-dim);font-weight:700;min-width:28px">${i + 1}.</span>
            <span style="flex:1;color:var(--text-bright);font-weight:600">${teamName(id)}</span>
            ${commish ? `
              <button onclick="moveRule5Order(${i},-1)" ${i === 0 ? 'disabled' : ''} style="background:var(--bg-card);border:1px solid var(--border);color:var(--text);padding:4px 10px;border-radius:4px;cursor:${i === 0 ? 'not-allowed' : 'pointer'};${i === 0 ? 'opacity:0.3;' : ''}">↑</button>
              <button onclick="moveRule5Order(${i},1)" ${i === state.order.length - 1 ? 'disabled' : ''} style="background:var(--bg-card);border:1px solid var(--border);color:var(--text);padding:4px 10px;border-radius:4px;cursor:${i === state.order.length - 1 ? 'not-allowed' : 'pointer'};${i === state.order.length - 1 ? 'opacity:0.3;' : ''}">↓</button>
            ` : ''}
          </div>
        `).join("")}
        ${commish ? `<button class="trade-btn trade-btn-submit" style="margin-top:14px" onclick="startRule5Draft()">Start Draft</button>` : ''}
      </div>
    `;
  }

  // Phase 2: live draft
  const cur = getRule5CurrentPick(state);
  const draftComplete = cur === null;

  let onClockHtml = "";
  if (draftComplete) {
    onClockHtml = `
      <div class="keeper-projection" style="background:rgba(34,197,94,0.1);border-color:var(--green);margin-bottom:14px">
        <h3 style="color:var(--green);margin:0">Rule 5 Draft Complete</h3>
        <div style="color:var(--text-dim);font-size:0.85rem;margin-top:4px">All teams passed in the last round (or pool exhausted).</div>
      </div>
    `;
  } else {
    const team = LEAGUE_DATA.teams.find(t => t.id === cur.teamId);
    const sortedRemaining = [...remaining].sort((a, b) => lastName(a.name).localeCompare(lastName(b.name)));
    const myTeam = (typeof currentOwner !== "undefined" && currentOwner) ? currentOwner.team_id : null;
    const onTheClock = cur.teamId === myTeam;
    const canPick = commish || onTheClock;
    const pickerBlock = canPick ? `
          <select id="rule5-pick-select" class="trade-select" style="margin-top:8px">
            <option value="">Select player to pick...</option>
            ${sortedRemaining.map(p => {
              const yrs = p.yearsRemaining != null ? `, exp ${CURRENT_SEASON + p.yearsRemaining}` : '';
              const price = p.nextYearPrice != null ? `, $${p.nextYearPrice}` : '';
              return `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)} (${escapeHtml(p.originTeamName)}${yrs}${price})</option>`;
            }).join("")}
          </select>
          <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
            <button class="trade-btn trade-btn-submit" onclick="(() => { const v = document.getElementById('rule5-pick-select').value; if (!v) { alert('Choose a player'); return; } makeRule5Pick(v); })()">Pick</button>
            ${commish ? `<button class="trade-btn trade-btn-cancel" onclick="passRule5Pick()">Pass</button>` : ""}
            ${commish && state.picks.length ? `<button class="trade-btn trade-btn-cancel" style="margin-left:auto" onclick="undoRule5Pick()">Undo Last</button>` : ""}
          </div>
        ` : `<div style="color:var(--text-dim);font-size:0.85rem;font-style:italic;margin-top:8px">Waiting on ${team ? escapeHtml(team.name) : escapeHtml(cur.teamId)} to make their pick.</div>`;
    onClockHtml = `
      <div class="keeper-projection" style="background:rgba(59,130,246,0.1);border-color:var(--accent);margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px;margin-bottom:8px">
          <h3 style="margin:0">On the Clock: <span style="color:var(--accent)">${team ? team.name : cur.teamId}</span></h3>
          <span style="color:var(--text-dim);font-size:0.82rem">Round ${cur.round} · Pick ${cur.idx + 1}</span>
        </div>
        ${renderRule5ClockBlock(state, commish)}
        ${pickerBlock}
      </div>
    `;
  }

  return `
    <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">
      <span style="color:var(--text-dim);font-size:0.8rem;align-self:center">Pool loaded ${new Date(state.loadedAt).toLocaleString()}</span>
      ${commish ? `<button class="trade-btn trade-btn-cancel" style="margin-left:auto" onclick="resetRule5Draft()">Reset</button>` : ''}
    </div>
    <div class="summary-bar">
      <div class="summary-item">
        <div class="summary-value">${pool.length}</div>
        <div class="summary-label">Pool</div>
      </div>
      <div class="summary-item">
        <div class="summary-value" style="color:var(--green)">${picks.filter(p => !p.pass).length}</div>
        <div class="summary-label">Picked</div>
      </div>
      <div class="summary-item">
        <div class="summary-value" style="color:var(--text-dim)">${picks.filter(p => p.pass).length}</div>
        <div class="summary-label">Passes</div>
      </div>
      <div class="summary-item">
        <div class="summary-value" style="color:var(--accent)">${remaining.length}</div>
        <div class="summary-label">Remaining</div>
      </div>
    </div>

    ${onClockHtml}

    ${picks.length ? `
      <div class="section-header">Pick History <span class="section-count">${picks.length}</span></div>
      <table class="player-table">
        <thead><tr><th>Rd.Pk</th><th>Team</th><th>Player</th><th>From</th></tr></thead>
        <tbody>
          ${picks.map(pk => `
            <tr style="${pk.pass ? 'opacity:0.5' : ''}">
              <td>${pk.round}.${pk.idx + 1}</td>
              <td><span class="team-link" style="color:var(--accent)">${teamName(pk.teamId)}</span></td>
              <td>${pk.pass ? '<span style="color:var(--text-dim);font-style:italic">— pass —</span>' : `<span class="player-name">${escapeHtml(pk.playerName)}</span>`}</td>
              <td>${pk.pass ? '' : `<span style="color:var(--text-dim);font-size:0.82rem">${teamName(pk.fromTeamId)} (paid $1)</span>`}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    ` : ''}

    <div class="section-header">Available Players <span class="section-count">${remaining.length}</span></div>
    <table class="player-table">
      <thead>
        <tr><th>Player</th><th>Origin</th><th>Expiry</th><th>${CURRENT_SEASON + 1} $</th></tr>
      </thead>
      <tbody>
        ${[...remaining].sort((a, b) => lastName(a.name).localeCompare(lastName(b.name))).map(p => `
          <tr>
            <td><span class="player-name">${escapeHtml(p.name)}</span></td>
            <td><span class="team-link" style="color:var(--accent)">${p.originTeamName}</span></td>
            <td>${p.yearsRemaining != null ? `<span class="contract-tag contract-${p.yearsRemaining === 0 ? 'final' : p.yearsRemaining === 1 ? 'expiring' : 'mid'}">${CURRENT_SEASON + p.yearsRemaining}</span>` : '<span style="color:var(--text-dim)">—</span>'}</td>
            <td>${
              p.type === "minor"
                ? '<span class="from-minors-tag" style="background:rgba(34,197,94,0.2);color:var(--green)">MiLB</span>'
                : p.nextYearPrice != null ? `<span class="player-price">$${p.nextYearPrice}</span>` : '<span style="color:var(--text-dim)">—</span>'
            }</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function loadRule5Pool() {
  const pool = buildRule5Pool();
  const state = {
    loadedAt: Date.now(),
    pool,
    picks: [],
    order: LEAGUE_DATA.teams.map(t => t.id), // commissioner can reorder before starting
    started: false,
  };
  saveRule5State(state);
  switchTab("rule5");
}

// Rebuild the pool without wiping picks/order/started — useful when the
// stored pool was created before a roster change (e.g., a minor leaguer
// was traded or sent down) so the picker reflects current state.
function refreshRule5Pool() {
  const state = getRule5State();
  if (!state) return;
  if (!confirm("Rebuild the Rule 5 pool from current rosters? Picks already made will be kept.")) return;
  state.pool = buildRule5Pool();
  state.loadedAt = Date.now();
  saveRule5State(state);
  switchTab("rule5");
}

function moveRule5Order(idx, dir) {
  const state = getRule5State();
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= state.order.length) return;
  [state.order[idx], state.order[newIdx]] = [state.order[newIdx], state.order[idx]];
  saveRule5State(state);
  switchTab("rule5");
}

function startRule5Draft() {
  const state = getRule5State();
  state.started = true;
  saveRule5State(state);
  switchTab("rule5");
}

function getRule5CurrentPick(state) {
  const order = state.order || [];
  const numTeams = order.length;
  if (numTeams === 0) return null;
  const N = state.picks.length;
  const round = Math.floor(N / numTeams) + 1;
  const idx = N % numTeams;
  const teamIdx = (round % 2 === 0) ? (numTeams - 1 - idx) : idx;
  const teamId = order[teamIdx];

  // End if previous full round was all passes
  if (N >= numTeams) {
    const prevRoundPicks = state.picks.slice(N - numTeams, N);
    if (prevRoundPicks.every(p => p.pass)) return null;
  }
  return { round, idx, teamId };
}

function makeRule5Pick(playerName) {
  const state = getRule5State();
  const cur = getRule5CurrentPick(state);
  if (!cur) return;
  const myTeam = (typeof currentOwner !== "undefined" && currentOwner) ? currentOwner.team_id : null;
  if (cur.teamId !== myTeam && !isCommissioner()) {
    alert("Only the team on the clock (or a commissioner) can submit this pick.");
    return;
  }
  const poolEntry = state.pool.find(p => p.name === playerName);
  if (!poolEntry) { alert("Player not in pool"); return; }
  const pickedAlready = state.picks.some(p => p.playerName === playerName);
  if (pickedAlready) { alert("Already picked"); return; }
  // Roster spot enforcement (toggle in Settings). Rule 5 picks of MLB-eligible
  // players add to the 25-man ML roster; picks of MiLB-eligible players add to
  // the 10-man MiL roster. Check whichever bucket the player would land in.
  if (isRule5RosterEnforcementEnabled()) {
    if (poolEntry.type === "minor") {
      if (getTeamMilCount(cur.teamId) >= MIL_ROSTER_MAX) {
        alert(`No open minors spot (${MIL_ROSTER_MAX}-man cap). Make a trade, call up a minor leaguer, or commissioner can pass.`);
        return;
      }
    } else {
      if (getTeamMlCount(cur.teamId) >= ML_ROSTER_MAX) {
        alert(`No open ML spot (${ML_ROSTER_MAX}-man cap). Make a trade or commissioner can pass.`);
        return;
      }
    }
  }

  // Use a stable client-side ID to correlate the pick with its trade row,
  // independent of the server-issued UUID and array index.
  const pickClientId = `${cur.round}.${cur.idx}.${Date.now()}`;
  state.picks.push({
    pickClientId,
    round: cur.round,
    idx: cur.idx,
    teamId: cur.teamId,
    playerName: playerName,
    fromTeamId: poolEntry.originTeamId,
    pass: false,
    timestamp: Date.now(),
    tradeId: null,
  });
  _resetRule5Clock(state);
  saveRule5State(state);

  const trade = {
    date: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
    team1: poolEntry.originTeamId,
    team2: cur.teamId,
    team1Receives: [{ type: "draft_dollars", value: "$1 draft dollars", amount: 1 }],
    team2Receives: [{ type: poolEntry.type === "minor" ? "minor" : "major", value: playerName }],
    notes: `Rule 5 pick (Round ${cur.round}.${cur.idx + 1})`,
    rule5: true,
    rule5PickClientId: pickClientId,
  };

  if (typeof addTradeAsync === "function") {
    addTradeAsync(trade)
      .then(id => {
        // Re-read the latest state and patch by stable client ID so concurrent
        // picks / realtime overwrites don't clobber the wrong row.
        const fresh = getRule5State();
        if (!fresh) return;
        const target = (fresh.picks || []).find(p => p.pickClientId === pickClientId);
        if (target) {
          target.tradeId = id;
          saveRule5State(fresh);
        }
      })
      .catch(err => alert("Trade log save failed: " + err.message));
  } else {
    const trades = getTrades();
    trades.push(trade);
    saveTrades(trades);
  }
  if (typeof logActivityAsync === "function") {
    logActivityAsync("rule5_pick_made", {
      round: cur.round, idx: cur.idx + 1, player_name: playerName,
      from_team: poolEntry.originTeamId,
    }, { targetTeamId: cur.teamId });
  }

  switchTab("rule5");
}

function passRule5Pick(opts) {
  const auto = !!(opts && opts.auto);
  if (!auto && !isCommissioner()) {
    alert("Only the commissioner can pass a Rule 5 pick.");
    return;
  }
  const state = getRule5State();
  const cur = getRule5CurrentPick(state);
  if (!cur) return;
  state.picks.push({
    round: cur.round,
    idx: cur.idx,
    teamId: cur.teamId,
    pass: true,
    timestamp: Date.now(),
    auto: auto || undefined,
  });
  _resetRule5Clock(state);
  saveRule5State(state);
  if (auto && typeof logActivityAsync === "function") {
    logActivityAsync("rule5_pick_auto_skipped", {
      round: cur.round, idx: cur.idx + 1,
    }, { targetTeamId: cur.teamId });
  }
  switchTab("rule5");
}

// --- Rule 5 clock (mirrors the Minors Draft clock) ---
let _rule5AutoPassAttemptedAt = null;

function _resetRule5Clock(state) {
  if (!state.clock) state.clock = {};
  state.clock.startedAt = new Date().toISOString();
  state.clock.paused = false;
  state.clock.pausedAt = null;
}

function startRule5Clock() {
  if (!isCommissioner()) { alert("Commissioners only."); return; }
  const state = getRule5State();
  if (!state) return;
  _resetRule5Clock(state);
  saveRule5State(state);
  if (typeof logActivityAsync === "function") logActivityAsync("rule5_clock_started", {});
  switchTab("rule5");
}

function pauseRule5Clock() {
  if (!isCommissioner()) { alert("Commissioners only."); return; }
  const state = getRule5State();
  if (!state || !state.clock || !state.clock.startedAt || state.clock.paused) return;
  state.clock.paused = true;
  state.clock.pausedAt = new Date().toISOString();
  saveRule5State(state);
  if (typeof logActivityAsync === "function") logActivityAsync("rule5_clock_paused", {});
  switchTab("rule5");
}

function resumeRule5Clock() {
  if (!isCommissioner()) { alert("Commissioners only."); return; }
  const state = getRule5State();
  if (!state || !state.clock || !state.clock.paused || !state.clock.pausedAt) return;
  const pausedAtMs = new Date(state.clock.pausedAt).getTime();
  const nowMs = Date.now();
  const pauseActiveMs = activeDraftElapsedMs(pausedAtMs, nowMs);
  const startedAtMs = new Date(state.clock.startedAt).getTime();
  state.clock.startedAt = new Date(startedAtMs + pauseActiveMs).toISOString();
  state.clock.paused = false;
  state.clock.pausedAt = null;
  saveRule5State(state);
  if (typeof logActivityAsync === "function") logActivityAsync("rule5_clock_resumed", {});
  switchTab("rule5");
}

function renderRule5ClockBlock(state, isCommish) {
  const cs = computeDraftClockState({ clock: state.clock }, Date.now());
  let controls = "";
  if (isCommish) {
    if (!cs.started) controls = `<button class="trade-btn" onclick="startRule5Clock()" style="font-size:0.78rem;padding:5px 10px">Start Clock</button>`;
    else if (cs.paused) controls = `<button class="trade-btn" onclick="resumeRule5Clock()" style="font-size:0.78rem;padding:5px 10px">Resume</button>`;
    else controls = `<button class="trade-btn trade-btn-cancel" onclick="pauseRule5Clock()" style="font-size:0.78rem;padding:5px 10px">Pause</button>`;
  }
  if (!cs.started) {
    return `
      <div style="margin-top:10px;padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:6px;display:flex;flex-wrap:wrap;align-items:center;gap:10px">
        <span id="rule5-clock-time" style="color:var(--text-dim);font-size:0.88rem">Clock not started</span>
        <span style="color:var(--text-dim);font-size:0.72rem;flex:1;min-width:140px">4 hour pick clock, pauses overnight (midnight–8 AM ET)</span>
        ${controls}
      </div>`;
  }
  return `
    <div style="margin-top:10px;padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:6px;display:flex;flex-wrap:wrap;align-items:center;gap:10px">
      <span id="rule5-clock-time" style="font-size:1rem;font-weight:700;min-width:160px">${formatDraftClockText(cs)}</span>
      <span id="rule5-clock-status" style="color:var(--text-dim);font-size:0.72rem;flex:1;min-width:120px">${draftClockStatusText(cs)}</span>
      ${controls}
    </div>`;
}

function _startRule5ClockTicker() {
  if (_draftClockInterval) { clearInterval(_draftClockInterval); _draftClockInterval = null; }
  if (typeof currentView !== "undefined" && currentView !== "rule5") return;
  _draftClockInterval = setInterval(_tickRule5Clock, 1000);
}

function _tickRule5Clock() {
  const timeEl = document.getElementById("rule5-clock-time");
  const statusEl = document.getElementById("rule5-clock-status");
  if (!timeEl) { _stopDraftClockTicker(); return; }
  const state = getRule5State();
  if (!state) { _stopDraftClockTicker(); return; }
  const cur = getRule5CurrentPick(state);
  if (!cur) { _stopDraftClockTicker(); return; }
  const cs = computeDraftClockState({ clock: state.clock }, Date.now());
  timeEl.textContent = formatDraftClockText(cs);
  if (statusEl) statusEl.textContent = draftClockStatusText(cs);
  if (cs.expired) timeEl.style.color = "var(--red)";
  else if (cs.remainingMs < 30 * 60 * 1000) timeEl.style.color = "var(--orange)";
  else timeEl.style.color = "var(--text-bright)";

  if (cs.expired) _maybeAutoPassExpiredRule5Pick();
}

function _maybeAutoPassExpiredRule5Pick() {
  if (!isCommissioner()) return;
  const now = Date.now();
  if (_rule5AutoPassAttemptedAt && (now - _rule5AutoPassAttemptedAt) < 5000) return;
  const state = getRule5State();
  if (!state) return;
  const cur = getRule5CurrentPick(state);
  if (!cur) return;
  const cs = computeDraftClockState({ clock: state.clock }, now);
  if (!cs.started || !cs.expired || cs.paused) return;
  _rule5AutoPassAttemptedAt = now;
  passRule5Pick({ auto: true });
}

function undoRule5Pick() {
  const state = getRule5State();
  if (!state.picks.length) return;
  if (!confirm("Undo last pick?")) return;
  const last = state.picks.pop();
  saveRule5State(state);

  // Remove the corresponding trade log entry, if any.
  if (last && last.tradeId) {
    if (typeof deleteTradeAsync === "function") {
      deleteTradeAsync(last.tradeId).catch(err => console.warn("Trade undo failed:", err));
    } else {
      const trades = getTrades().filter(t => t._id !== last.tradeId && t.id !== last.tradeId);
      saveTrades(trades);
    }
  }
  if (typeof logActivityAsync === "function") {
    logActivityAsync("rule5_pick_undone", {
      round: last?.round, idx: (last?.idx ?? 0) + 1, player_name: last?.playerName,
    }, { targetTeamId: last?.teamId });
  }
  switchTab("rule5");
}

// Mobile slide-out nav drawer. Pass force=true|false to set state, or omit to toggle.
function toggleNavDrawer(force) {
  const drawer = document.getElementById("nav-drawer");
  const backdrop = document.getElementById("nav-drawer-backdrop");
  const btn = document.getElementById("menu-btn");
  if (!drawer || !backdrop) return;
  const willOpen = typeof force === "boolean" ? force : !drawer.classList.contains("open");
  drawer.classList.toggle("open", willOpen);
  backdrop.classList.toggle("open", willOpen);
  drawer.setAttribute("aria-hidden", willOpen ? "false" : "true");
  if (btn) btn.setAttribute("aria-expanded", willOpen ? "true" : "false");
}
// Esc closes the drawer.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") toggleNavDrawer(false);
});

function goBack() {
  switchTab("eligible");
}

// Override hardcoded careerStat with live MLB Stats API values when available.
function applyLivePlayerStats() {
  if (typeof PLAYER_STATS === "undefined" || !PLAYER_STATS.players) return;
  const stats = PLAYER_STATS.players;
  LEAGUE_DATA.teams.forEach(team => {
    [...(team.callups || []), ...(team.minors || [])].forEach(p => {
      const live = stats[p.name];
      if (!live) return;
      if (p.statType === "AB") p.careerStat = live.careerAB || 0;
      else if (p.statType === "IP") p.careerStat = Math.round(live.careerIP || 0);
    });
  });
}

// --- Auth UI ---

function renderLoginScreen(message = "") {
  const main = document.getElementById("main-content");
  document.querySelector(".nav-tabs").style.display = "none";
  document.getElementById("back-btn").style.display = "none";
  document.getElementById("header-title").textContent = "Sign In";
  // Carry over an auth error from OAuth callback (e.g. "not on allowlist").
  if (window.__leagueAuthError) { message = window.__leagueAuthError; window.__leagueAuthError = null; }
  const messageHtml = message
    ? `<div id="login-msg" style="margin-top:12px;padding:10px;border-radius:6px;background:rgba(239,68,68,0.12);color:var(--red);font-size:0.85rem">${message}</div>`
    : `<div id="login-msg" style="display:none;margin-top:12px;padding:10px;border-radius:6px;font-size:0.85rem"></div>`;
  main.innerHTML = `
    <div style="max-width:420px;margin:40px auto;padding:24px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius)">
      <h2 style="margin:0 0 8px;color:var(--text-bright)">Fantasy League Manager</h2>
      <p style="color:var(--text-dim);font-size:0.9rem;margin:0 0 18px">
        Sign in with your Google account.
      </p>
      <button id="login-google-btn" onclick="submitGoogleSignIn()" style="width:100%;display:flex;align-items:center;justify-content:center;gap:10px;background:#fff;color:#3c4043;border:1px solid #dadce0;padding:11px 14px;border-radius:6px;font-size:0.95rem;font-weight:500;cursor:pointer">
        <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg"><path d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/><path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853"/><path d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/><path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/></svg>
        Sign in with Google
      </button>
      <div style="display:flex;align-items:center;gap:10px;margin:20px 0;color:var(--text-dim);font-size:0.75rem">
        <div style="flex:1;height:1px;background:var(--border)"></div>
        <span>or use email</span>
        <div style="flex:1;height:1px;background:var(--border)"></div>
      </div>
      <label style="display:block;margin-bottom:10px">
        <div style="color:var(--text-dim);font-size:0.8rem;margin-bottom:4px">Email</div>
        <input type="email" id="login-email" autocomplete="email" placeholder="you@example.com"
          style="width:100%;background:var(--bg);color:var(--text);border:1px solid var(--border);padding:10px;border-radius:6px;font-size:0.95rem">
      </label>
      <button id="login-btn" class="trade-btn trade-btn-cancel" style="width:100%;margin-top:8px" onclick="submitMagicLink()">Send Magic Link</button>
      ${messageHtml}
      <div id="login-code-block" style="display:none;margin-top:14px;padding-top:14px;border-top:1px solid var(--border)">
        <div style="color:var(--text-dim);font-size:0.78rem;margin-bottom:6px">
          Email link not working? Enter the numeric code from the same email.
        </div>
        <div style="display:flex;gap:8px">
          <input type="text" id="login-code" inputmode="numeric" maxlength="8" pattern="[0-9]*" placeholder="Code" autocomplete="one-time-code"
            style="flex:1;background:var(--bg);color:var(--text);border:1px solid var(--border);padding:10px;border-radius:6px;font-size:1.05rem;letter-spacing:0.2em;text-align:center">
          <button id="login-code-btn" class="trade-btn trade-btn-submit" onclick="submitEmailCode()">Verify</button>
        </div>
      </div>
    </div>
  `;
  setTimeout(() => document.getElementById("login-email")?.focus(), 0);
  document.getElementById("login-email")?.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); submitMagicLink(); }
  });
  document.getElementById("login-code")?.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); submitEmailCode(); }
  });
}

async function submitMagicLink() {
  const emailEl = document.getElementById("login-email");
  const btn = document.getElementById("login-btn");
  const msg = document.getElementById("login-msg");
  const email = (emailEl?.value || "").trim();
  if (!email) { emailEl?.focus(); return; }
  btn.disabled = true;
  btn.textContent = "Sending...";
  msg.style.display = "block";
  msg.style.background = "rgba(148,163,184,0.12)";
  msg.style.color = "var(--text-dim)";
  msg.textContent = "";
  try {
    await sendMagicLink(email);
    msg.style.background = "rgba(34,197,94,0.12)";
    msg.style.color = "var(--green)";
    msg.innerHTML =
      "Check your email. Click the link <em>or</em> enter the numeric code below.";
    btn.textContent = "Resend";
    btn.disabled = false;
    // Reveal the code-entry form.
    const codeBlock = document.getElementById("login-code-block");
    if (codeBlock) {
      codeBlock.style.display = "block";
      document.getElementById("login-code")?.focus();
    }
  } catch (err) {
    msg.style.background = "rgba(239,68,68,0.12)";
    msg.style.color = "var(--red)";
    msg.textContent = err.message || "Couldn't send link. Try again.";
    btn.disabled = false;
    btn.textContent = "Send Magic Link";
  }
}

async function submitGoogleSignIn() {
  const btn = document.getElementById("login-google-btn");
  const msg = document.getElementById("login-msg");
  btn.disabled = true;
  btn.style.opacity = "0.6";
  try {
    await signInWithGoogle();
    // Browser will redirect to Google; nothing more to do here.
  } catch (err) {
    msg.style.display = "block";
    msg.style.background = "rgba(239,68,68,0.12)";
    msg.style.color = "var(--red)";
    msg.textContent = err.message || "Couldn't start Google sign-in.";
    btn.disabled = false;
    btn.style.opacity = "1";
  }
}

async function submitEmailCode() {
  const emailEl = document.getElementById("login-email");
  const codeEl = document.getElementById("login-code");
  const btn = document.getElementById("login-code-btn");
  const msg = document.getElementById("login-msg");
  const email = (emailEl?.value || "").trim();
  const code = (codeEl?.value || "").trim();
  if (!email || !code) { codeEl?.focus(); return; }
  btn.disabled = true;
  btn.textContent = "Verifying...";
  try {
    await verifyEmailCode(email, code);
    msg.style.background = "rgba(34,197,94,0.12)";
    msg.style.color = "var(--green)";
    msg.textContent = "Signed in. Loading…";
    // refreshAuthState fires onAuthStateChange which reroutes through authGate.
  } catch (err) {
    msg.style.display = "block";
    msg.style.background = "rgba(239,68,68,0.12)";
    msg.style.color = "var(--red)";
    msg.textContent = err.message || "Invalid code.";
    btn.disabled = false;
    btn.textContent = "Verify Code";
  }
}

function renderClaimTeamScreen() {
  const main = document.getElementById("main-content");
  document.querySelector(".nav-tabs").style.display = "none";
  document.getElementById("back-btn").style.display = "none";
  document.getElementById("header-title").textContent = "Pick Your Team";
  const opts = LEAGUE_DATA.teams.map(t => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`).join("");
  main.innerHTML = `
    <div style="max-width:420px;margin:40px auto;padding:24px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius)">
      <h2 style="margin:0 0 8px;color:var(--text-bright)">Welcome, ${escapeHtml(currentUser.email)}</h2>
      <p style="color:var(--text-dim);font-size:0.9rem;margin:0 0 18px">
        Pick the team you own. (A commissioner can override this later.)
      </p>
      <select id="claim-team" class="trade-select" style="width:100%;margin-bottom:12px">${opts}</select>
      <button id="claim-btn" class="trade-btn trade-btn-submit" style="width:100%" onclick="submitClaimTeam()">Claim Team</button>
      <div id="claim-msg" style="display:none;margin-top:12px;padding:10px;border-radius:6px;font-size:0.85rem"></div>
      <button class="trade-btn trade-btn-cancel" style="width:100%;margin-top:14px" onclick="signOut()">Sign Out</button>
    </div>
  `;
  // Async-fetch the claimed-team set and grey out unavailable options.
  // The select renders immediately so there's no perceived delay.
  supabaseClient.from("owners").select("team_id").then(({ data, error }) => {
    if (error || !data) return;
    const claimed = new Set(data.map(r => r.team_id));
    const select = document.getElementById("claim-team");
    if (!select) return;
    for (const opt of select.options) {
      if (claimed.has(opt.value)) {
        opt.disabled = true;
        opt.textContent = `${opt.textContent} (claimed)`;
      }
    }
    // If the currently-selected option is now disabled, jump to the first available.
    if (select.options[select.selectedIndex]?.disabled) {
      const firstAvail = [...select.options].find(o => !o.disabled);
      if (firstAvail) select.value = firstAvail.value;
    }
  });
}

async function submitClaimTeam() {
  const teamId = document.getElementById("claim-team").value;
  const btn = document.getElementById("claim-btn");
  const msg = document.getElementById("claim-msg");
  btn.disabled = true; btn.textContent = "Claiming...";
  // Use the security-definer RPC: validates team_id is one of the 12 known
  // teams AND not already claimed before inserting. Direct INSERT into
  // owners is denied by RLS to prevent race-window team theft.
  const { error } = await supabaseClient.rpc("claim_specific_team", { team_id_to_claim: teamId });
  if (error) {
    msg.style.display = "block";
    msg.style.background = "rgba(239,68,68,0.12)";
    msg.style.color = "var(--red)";
    msg.textContent = /already claimed/i.test(error.message)
      ? `${LEAGUE_DATA.teams.find(t => t.id === teamId)?.name || teamId} is already claimed. Pick a different team or contact a commissioner.`
      : `Couldn't claim team: ${error.message}`;
    btn.disabled = false; btn.textContent = "Claim Team";
    return;
  }
  await refreshAuthState();
  // Kick the data layer in case the auth-change listener already fired with
  // owner=null and never came back around.
  if (typeof initDb === "function" && currentOwner) initDb();
}

function renderHeaderUser() {
  let userBar = document.getElementById("user-bar");
  if (!userBar) {
    userBar = document.createElement("div");
    userBar.id = "user-bar";
    userBar.style.cssText = "position:absolute;top:8px;right:12px;display:flex;align-items:center;gap:10px;font-size:0.72rem;color:rgba(255,255,255,0.85)";
    document.querySelector(".app-header").appendChild(userBar);
  }
  // Show/hide commissioner-only tabs (Settings) based on current owner.
  const showCommish = isRealCommissioner() && !isCommishViewSuppressed();
  document.querySelectorAll(".commish-only-tab").forEach(el => {
    el.style.display = showCommish ? "" : "none";
  });
  if (!currentUser) { userBar.style.display = "none"; return; }
  userBar.style.display = "flex";
  const teamName = currentOwner
    ? (LEAGUE_DATA.teams.find(t => t.id === currentOwner.team_id)?.name || currentOwner.team_id)
    : "—";

  // Commish status decoration. Real commissioners get the gold star ★ when
  // viewing as commish, or an eye icon 👁 when viewing as a regular manager
  // (preview mode). Clicking the name toggles between the two.
  const realCommish = isRealCommissioner();
  const previewMode = realCommish && isCommishViewSuppressed();
  let nameHtml;
  if (realCommish) {
    const icon = previewMode
      ? '<span title="Click to switch back to Commissioner view" style="color:var(--text-dim);margin-left:4px">👁</span>'
      : '<span title="Click to switch to Regular Manager view" style="color:var(--yellow);font-weight:700;margin-left:4px">★</span>';
    nameHtml = `<span onclick="toggleCommishView()" style="cursor:pointer;${previewMode ? 'color:#fbbf24' : ''}">${escapeHtml(teamName)}${icon}</span>`;
  } else {
    nameHtml = `<span>${escapeHtml(teamName)}</span>`;
  }

  // Online indicator (excludes self).
  const online = (typeof dbGetOnlineTeams === "function") ? dbGetOnlineTeams() : [];
  const others = online.filter(t => t.teamId !== currentOwner?.team_id);
  const onlineHtml = others.length
    ? `<span title="Online: ${others.map(t => t.teamName).join(", ")}" style="display:flex;align-items:center;gap:4px"><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#22c55e;box-shadow:0 0 6px rgba(34,197,94,0.7)"></span>${others.length} online</span>`
    : `<span style="color:rgba(255,255,255,0.45)" title="No other owners online">no one else online</span>`;

  // Optional preview-mode banner so it's obvious commish controls are hidden.
  const previewTag = previewMode
    ? '<span title="Viewing as a regular manager — click your name to switch back" style="background:#fbbf24;color:#000;font-size:0.62rem;font-weight:800;padding:1px 6px;border-radius:8px;text-transform:uppercase;letter-spacing:0.04em">Manager view</span>'
    : "";

  userBar.innerHTML = `
    ${onlineHtml}
    ${previewTag}
    ${nameHtml}
    <button onclick="signOut()" style="background:rgba(0,0,0,0.25);border:1px solid rgba(255,255,255,0.2);color:white;padding:3px 8px;border-radius:4px;font-size:0.7rem;cursor:pointer">Sign Out</button>
  `;

  // Mirror the same info into the bottom of the mobile drawer (CSS shows
  // this only on small screens; the in-header copy is hidden there).
  const drawerBar = document.getElementById("drawer-user-bar");
  if (drawerBar) {
    const drawerOnlineHtml = others.length
      ? `<span class="user-online" title="Online: ${others.map(t => t.teamName).join(", ")}"><span class="dot"></span>${others.length} online</span>`
      : `<span class="user-online" style="color:rgba(255,255,255,0.45)" title="No other owners online">no one else online</span>`;
    drawerBar.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span class="user-name">${escapeHtml(teamName)}</span>
        ${realCommish ? (previewMode
          ? '<span title="Click your name to switch back" onclick="toggleCommishView()" style="color:var(--text-dim);cursor:pointer">👁 Manager view</span>'
          : '<span title="Click to switch to Manager view" onclick="toggleCommishView()" style="color:var(--yellow);cursor:pointer">★ Commish</span>') : ""}
      </div>
      ${drawerOnlineHtml}
      <button class="signout" onclick="signOut()">Sign Out</button>
    `;
  }

  // Inbox unread badge — re-paint on every header update so it stays current
  // as proposals/messages flow in via realtime. The count covers BOTH new
  // pending proposals to you AND new messages from someone else, with a
  // hover tooltip breaking down the two.
  const u = (typeof dbGetUnreadCounts === "function") ? dbGetUnreadCounts() : { proposals: 0, messages: 0, total: 0 };
  const badgeHtml = u.total > 0
    ? ` <span title="${escapeHtml(`${u.proposals} new proposal${u.proposals === 1 ? "" : "s"}, ${u.messages} new message${u.messages === 1 ? "" : "s"}`)}" style="color:var(--red);font-weight:800;margin-left:2px">(${u.total})</span>`
    : "";
  const tradesNav = document.getElementById("nav-trades");
  if (tradesNav) tradesNav.innerHTML = "Trades" + badgeHtml;
  const drawerTrades = document.getElementById("drawer-trades");
  if (drawerTrades) drawerTrades.innerHTML = "Trades" + badgeHtml;
}

// Re-render the header bar whenever someone joins or leaves.
if (typeof onPresenceChange === "function") {
  onPresenceChange(() => renderHeaderUser());
}

function showAppForAuthedUser() {
  document.querySelector(".nav-tabs").style.display = "";
  renderHeaderUser();
  switchTab(currentView || "eligible");
}

function authGate(user, owner) {
  // While the first refreshAuthState() is still in flight, currentUser may
  // be set but currentOwner not yet fetched — rendering the claim screen
  // here would briefly flash for an already-claimed user. Show a neutral
  // splash until auth has resolved at least once.
  if (typeof isAuthResolved === "function" && !isAuthResolved()) {
    document.querySelector(".nav-tabs").style.display = "none";
    document.getElementById("main-content").innerHTML =
      '<div style="text-align:center;padding:60px;color:var(--text-dim)">Loading…</div>';
    return;
  }
  renderHeaderUser();
  if (!user) {
    renderLoginScreen();
    return;
  }
  if (!owner) {
    renderClaimTeamScreen();
    return;
  }
  if (typeof onDbReady === "function") {
    // Block UI until the league data is loaded from Supabase.
    document.querySelector(".nav-tabs").style.display = "none";
    document.getElementById("main-content").innerHTML =
      '<div style="text-align:center;padding:60px;color:var(--text-dim)">Loading league data…</div>';
    onDbReady(() => showAppForAuthedUser());
  } else {
    showAppForAuthedUser();
  }
}

// --- Init ---
document.addEventListener("DOMContentLoaded", () => {
  applyLivePlayerStats();
  if (typeof onAuthChange === "function") {
    onAuthChange(authGate);
  } else {
    // Supabase client failed to load; fall back to no-auth mode for safety.
    switchTab("eligible");
  }
});
