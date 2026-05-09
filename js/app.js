// Fantasy League Manager - Main App

const CURRENT_SEASON = 2026;

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
        // Demotions during the season trigger the $10 send-down fee, which
        // shows up in the Keepers tab next to the contract.
        if (!minors.find(p => p.name === player.name)) minors.push({ ...player, sentDown: true });
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
        ${LEAGUE_DATA.teams.map(t => `<option value="${t.id}">${t.name}</option>`).join("")}
      </select>
    </div>
    <div id="keepers-content"></div>
  `;
}

function updateKeepersView() {
  const teamId = document.getElementById("keepers-team-select").value;
  const container = document.getElementById("keepers-content");
  if (!teamId) { container.innerHTML = ""; return; }

  if (teamId === "all") {
    container.innerHTML = LEAGUE_DATA.teams.map(team => `
      <div style="margin-bottom:24px">
        <h3 style="color:var(--text-bright);margin-bottom:8px;cursor:pointer" onclick="document.getElementById('keepers-team-select').value='${team.id}';updateKeepersView()">
          ${team.name} <span style="color:var(--green);font-size:0.85rem">$${team.totalKeeperCost}</span>
          <span style="color:var(--text-dim);font-size:0.85rem">/ Draft: $${team.draftBudget}</span>
        </h3>
        <div class="section-header">${CURRENT_SEASON} Major League Keepers <span class="section-count">${team.majors.length}/8</span></div>
        ${renderMajorsTable(team.majors)}
        <div class="section-header">${CURRENT_SEASON} Minor League Keepers <span class="section-count">${team.minors.length}/10</span></div>
        ${renderMinorsKeepersTable(team.minors)}
      </div>
    `).join("");
    return;
  }

  const team = LEAGUE_DATA.teams.find(t => t.id === teamId);
  if (!team) return;

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
    <div class="section-header">${CURRENT_SEASON} Major League Keepers <span class="section-count">${team.majors.length}/8</span></div>
    ${renderMajorsTable(team.majors)}
    <div class="section-header">${CURRENT_SEASON} Minor League Keepers <span class="section-count">${team.minors.length}/10</span></div>
    ${renderMinorsKeepersTable(team.minors)}
  `;
}

function renderMinorsKeepersTable(minors) {
  if (!minors.length) return '<p style="color:var(--text-dim)">No minor league keepers</p>';
  const sorted = [...minors].sort((a, b) => lastName(a.name).localeCompare(lastName(b.name)));
  return `
    <table class="player-table">
      <thead>
        <tr><th>Player</th><th>Drafted</th><th>Career</th><th>Contract</th></tr>
      </thead>
      <tbody>
        ${sorted.map(p => {
          const ms = getMinorLeagueContractStatus(p, CURRENT_SEASON);
          let statClass = "";
          if ((p.statType === "AB" && p.careerStat >= 300) || (p.statType === "IP" && p.careerStat >= 75)) statClass = "stat-warning";
          else if ((p.statType === "AB" && p.careerStat >= 200) || (p.statType === "IP" && p.careerStat >= 50)) statClass = "stat-caution";
          return `
            <tr>
              <td><span class="player-name">${escapeHtml(p.name)}</span>${ms.eligibilityWarning ? ` <span style="color:var(--orange);font-size:0.7rem;font-weight:600">${escapeHtml(ms.eligibilityWarning)}</span>` : ""}</td>
              <td class="player-year">${p.yearAcquired}</td>
              <td class="${statClass}">${p.careerStat} ${p.statType}</td>
              <td><span style="color:var(--text-dim);font-size:0.8rem">${ms.contractNote}${ms.yearsRemaining !== null ? ` (${ms.yearsRemaining} yrs)` : ""}</span>${p.sentDown ? ` <span style="color:var(--red);font-size:0.7rem;font-weight:600">($10 send down fee)</span>` : ""}</td>
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
        ${LEAGUE_DATA.teams.map(t => `<option value="${t.id}">${t.name}</option>`).join("")}
      </select>
    </div>
    <div id="rosters-content"></div>
  `;
}

function updateRostersView() {
  const teamId = document.getElementById("rosters-team-select").value;
  const container = document.getElementById("rosters-content");
  if (!teamId) { container.innerHTML = ""; return; }

  if (teamId === "all") {
    container.innerHTML = LEAGUE_DATA.teams.map(team => {
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

async function callUpMinorPlayer(playerName, teamId) {
  if (!canEditTeam(teamId)) {
    alert("Only the team owner or a commissioner can call up players on this team.");
    return;
  }
  if (!confirm(`Call up ${playerName}? (Salary will be set in the offseason.)`)) return;
  try {
    if (typeof appendRosterMoveAsync === "function") {
      await appendRosterMoveAsync({ kind: "callup", player_name: playerName, team_id: teamId });
    }
    if (typeof logActivityAsync === "function") {
      logActivityAsync("player_called_up", { player_name: playerName }, { targetTeamId: teamId });
    }
    if (typeof switchTab === "function") switchTab(currentView);
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
    if (typeof appendRosterMoveAsync === "function") {
      await appendRosterMoveAsync({ kind: "demote", player_name: playerName, team_id: teamId });
    }
    if (typeof logActivityAsync === "function") {
      logActivityAsync("player_sent_down", { player_name: playerName }, { targetTeamId: teamId });
    }
    if (typeof switchTab === "function") switchTab(currentView);
  } catch (e) {
    alert("Couldn't send down: " + (e.message || e));
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
      <thead><tr><th>Player</th><th>Drafted</th><th>Career</th></tr></thead>
      <tbody>
        ${allPlayers.map(p => {
          let statClass = "";
          if ((p.statType === "AB" && p.careerStat >= 300) || (p.statType === "IP" && p.careerStat >= 75)) statClass = "stat-warning";
          else if ((p.statType === "AB" && p.careerStat >= 200) || (p.statType === "IP" && p.careerStat >= 50)) statClass = "stat-caution";
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
        <tr><th>Player</th><th>Price</th><th>Acquired</th><th>Contract</th><th>2027 Price</th></tr>
      </thead>
      <tbody>
        ${players.map(p => {
          const cs = getContractStatus(p, CURRENT_SEASON);
          return `
            <tr>
              <td><span class="player-name">${escapeHtml(p.name)}</span></td>
              <td class="player-price">$${p.price}</td>
              <td class="player-year">${p.yearAcquired}${p.fromMinors ? ' <span class="from-minors-tag">MiLB</span>' : ""}</td>
              <td><span class="contract-tag contract-${escapeHtml(cs.status)}">${escapeHtml(cs.label)}</span></td>
              <td>${cs.canKeepNextYear ? `<span class="player-price">$${cs.nextYearPrice}</span>` : '<span style="color:var(--text-dim)">—</span>'}</td>
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
          const statDisplay = `${p.careerStat} ${p.statType}`;
          let statClass = "";
          if ((p.statType === "AB" && p.careerStat >= 300) || (p.statType === "IP" && p.careerStat >= 75)) statClass = "stat-warning";
          else if ((p.statType === "AB" && p.careerStat >= 200) || (p.statType === "IP" && p.careerStat >= 50)) statClass = "stat-caution";
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
  if (player.dropped || isPlayerDroppedFromEspn(player.name)) return "Dropped";
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
      <thead><tr><th>Player</th><th>Drafted</th><th>Career Stats</th><th>Yrs Left</th><th>Status</th>${headerActionCol}</tr></thead>
      <tbody>
        ${players.map(p => {
          const ms = getMinorLeagueContractStatus(p, CURRENT_SEASON);
          const statDisplay = `${p.careerStat} ${p.statType}`;
          let statClass = "";
          if ((p.statType === "AB" && p.careerStat >= 300) || (p.statType === "IP" && p.careerStat >= 75)) statClass = "stat-warning";
          else if ((p.statType === "AB" && p.careerStat >= 200) || (p.statType === "IP" && p.careerStat >= 50)) statClass = "stat-caution";
          const actionCell = showCallUp ? `
            <td style="text-align:right">
              <button class="trade-btn" onclick="callUpMinorPlayer('${escapeJsString(p.name)}','${escapeJsString(teamId)}')"
                style="font-size:0.72rem;padding:3px 8px;background:var(--purple);color:#fff">Call Up</button>
            </td>` : "";
          return `
            <tr>
              <td><span class="player-name">${escapeHtml(p.name)}</span>${p.sentDown ? ' <span style="color:var(--red);font-size:0.65rem;font-weight:700">$10 fee</span>' : ''}</td>
              <td class="player-year">${p.yearAcquired}</td>
              <td class="${statClass}">${statDisplay}</td>
              <td><span style="color:var(--text-dim);font-size:0.8rem">${ms.yearsRemaining !== null ? ms.yearsRemaining : '—'}</span></td>
              <td>${
                p._teamStatus === "dropped" ? '<span style="color:var(--orange);font-size:0.8rem">Dropped</span>' :
                p._teamStatus === "traded"  ? '<span style="color:var(--accent);font-size:0.8rem">Traded</span>' :
                ms.eligibilityWarning ? `<span style="color:var(--orange);font-size:0.8rem">${ms.eligibilityWarning}</span>` :
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
        ${LEAGUE_DATA.teams.map(t => `<option value="${t.id}">${t.name}</option>`).join("")}
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

  container.innerHTML = `
    <div class="keeper-projection">
      <h3>Can Keep for 2027 (${keepableNextYear.length} players)</h3>
      ${keepableNextYear.length ? `
        <table class="player-table">
          <thead><tr><th>Player</th><th>2026 Price</th><th>2027 Price</th><th>Yrs Left</th></tr></thead>
          <tbody>
            ${keepableNextYear.map(p => `
              <tr>
                <td><span class="player-name">${escapeHtml(p.name)}</span>${p.fromMinors ? '<span class="from-minors-tag">MiLB</span>' : ""}</td>
                <td class="player-price">$${p.price}</td>
                <td style="color:var(--yellow);font-weight:700">$${p.contract.nextYearPrice}</td>
                <td><span class="contract-tag contract-${p.contract.yearsRemaining === 1 ? 'expiring' : 'mid'}">${p.contract.yearsRemaining} yr${p.contract.yearsRemaining > 1 ? 's' : ''}</span></td>
              </tr>
            `).join("")}
          </tbody>
        </table>
        <div style="margin-top:10px;padding:10px;background:var(--bg);border-radius:6px">
          <span style="color:var(--text-dim);font-size:0.82rem">Projected 2027 keeper cost (all eligible):</span>
          <span style="color:var(--yellow);font-weight:800;font-size:1.05rem"> $${keepableNextYear.reduce((s, p) => s + p.contract.nextYearPrice, 0)}</span>
          <span style="color:var(--text-dim);font-size:0.82rem"> / Draft budget:</span>
          <span style="color:var(--accent);font-weight:800;font-size:1.05rem"> $${260 - keepableNextYear.reduce((s, p) => s + p.contract.nextYearPrice, 0)}</span>
        </div>
      ` : "<p style='color:var(--text-dim)'>No players eligible to keep</p>"}
    </div>
    ${notKeepable.length ? `
      <div class="keeper-projection">
        <h3 style="color:var(--red)">Cannot Keep for 2027 (${notKeepable.length} players)</h3>
        <table class="player-table">
          <thead><tr><th>Player</th><th>2026 Price</th><th>Reason</th></tr></thead>
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

function renderTradesView() {
  const trades = getTrades();
  return `
    <div style="display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start">
      <div style="flex:1 1 320px;min-width:280px">
        <div style="display:flex;gap:10px;margin-bottom:16px">
          <button class="trade-btn" onclick="showTradeForm()">New Trade</button>
        </div>
        <div id="trade-form-container"></div>
        <div class="section-header">Trade Log <span class="section-count">${trades.length}</span></div>
        <div id="trade-log">
          ${trades.length ? trades.slice().reverse().map((t, i) => renderTradeCard(t, trades.length - 1 - i)).join("") : '<p style="color:var(--text-dim)">No trades recorded yet.</p>'}
        </div>
      </div>
      <div style="flex:0 1 220px;min-width:200px">
        ${renderDraftDollarsPanel()}
      </div>
    </div>
  `;
}

function renderTradeBlockView() {
  const sel = (typeof dbGetKeeperSelections === "function") ? dbGetKeeperSelections() : {};
  const byTeam = {};
  for (const teamId of Object.keys(sel)) {
    const blocked = Object.keys(sel[teamId] || {}).filter(name => sel[teamId][name]?.tradeBlock);
    if (blocked.length) byTeam[teamId] = blocked.sort((a, b) => lastName(a).localeCompare(lastName(b)));
  }
  const orderedTeams = LEAGUE_DATA.teams.filter(t => byTeam[t.id]);
  if (!orderedTeams.length) {
    return `
      <div style="max-width:540px;margin:40px auto;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:24px;text-align:center;color:var(--text-dim);font-size:0.9rem">
        Nothing on the trade block right now.
        <div style="font-size:0.78rem;margin-top:8px">Players appear here when an owner toggles "On the Block" in Eligible Keepers.</div>
      </div>
    `;
  }
  const myTeamId = (typeof currentOwner !== "undefined" && currentOwner) ? currentOwner.team_id : null;
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
          ? '<div style="font-size:0.72rem;color:var(--text-dim);font-style:italic;margin-top:12px">(your team)</div>'
          : (myTeamId
              ? `<button class="trade-btn" onclick="proposeTradeWith('${escapeJsString(t.id)}')" style="font-size:0.78rem;padding:6px 14px;margin-top:12px">Propose Trade</button>`
              : "");
        return `
          <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:14px">
            <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
              <span style="color:var(--text-bright);font-weight:700">${escapeHtml(t.name)}</span>
              <span style="color:var(--text-dim);font-size:0.75rem">${byTeam[t.id].length} player${byTeam[t.id].length === 1 ? "" : "s"}</span>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:5px">
              ${byTeam[t.id].map(name => {
                const price = priceMap[name];
                const priceStr = price !== undefined ? ` $${price}` : "";
                return `<span style="font-size:0.78rem;background:rgba(249,115,22,0.15);color:var(--orange);padding:3px 9px;border-radius:10px;white-space:nowrap">${escapeHtml(name)}${priceStr}</span>`;
              }).join("")}
            </div>
            ${action}
          </div>
        `;
      }).join("")}
    </div>
  `;
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
  if (typeof currentView !== "undefined" && currentView === "trade-inbox") {
    // Re-render in background so the unread badge clears immediately.
    document.getElementById("main-content").innerHTML = renderTradeInboxView();
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
  setTimeout(() => document.getElementById("thread-msg-input")?.focus(), 0);
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
      setTimeout(() => document.getElementById("thread-msg-input")?.focus(), 0);
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
    await acceptProposalAsync(proposal);
    if (typeof logActivityAsync === "function") {
      // Notes intentionally omitted — the proposal's negotiation context
      // stays in the inbox; the Trade Log + activity feed record just the
      // swap.
      logActivityAsync("trade_recorded", {
        team1: proposal.from_team_id, team2: proposal.to_team_id,
        team1_receives: proposal.team1_receives,
        team2_receives: proposal.team2_receives,
      }, { targetTeamId: proposal.from_team_id });
    }
    closeThreadDetail();
    if (typeof switchTab === "function") switchTab("trade-inbox");
  } catch (e) {
    alert("Couldn't accept: " + (e.message || e));
  }
}

async function rejectThreadProposal(proposalId) {
  if (!confirm("Reject this proposal?")) return;
  try {
    await setProposalStatusAsync(proposalId, "rejected");
    closeThreadDetail();
    if (typeof switchTab === "function") switchTab("trade-inbox");
  } catch (e) { alert("Couldn't reject: " + (e.message || e)); }
}

async function withdrawThreadProposal(proposalId) {
  if (!confirm("Withdraw this proposal?")) return;
  try {
    await setProposalStatusAsync(proposalId, "withdrawn");
    closeThreadDetail();
    if (typeof switchTab === "function") switchTab("trade-inbox");
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
    if (typeof switchTab === "function") switchTab("trade-inbox");
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

function renderDraftDollarsPanel() {
  const balances = getDraftDollarBalances();
  const rows = LEAGUE_DATA.teams.map(t => ({ ...t, balance: balances[t.id] ?? 260 }));
  // Same display order as the league teams list (reads naturally).
  return `
    <div class="section-header">Draft Dollars</div>
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:8px 10px">
      ${rows.map(t => {
        const diff = t.balance - 260;
        const diffStr = diff > 0 ? `+$${diff}` : diff < 0 ? `-$${Math.abs(diff)}` : "";
        const diffColor = diff > 0 ? "var(--green)" : diff < 0 ? "var(--red)" : "var(--text-dim)";
        return `<div style="display:flex;justify-content:space-between;align-items:baseline;padding:5px 0;border-bottom:1px solid var(--border);font-size:0.85rem">
          <span style="color:var(--text)">${t.name}</span>
          <span>${diffStr ? `<span style="color:${diffColor};font-size:0.72rem;margin-right:8px">${diffStr}</span>` : ""}<span style="color:var(--text-bright);font-weight:600">$${t.balance}</span></span>
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
      .then(() => {
        // Only clear the form on a successful save — preserves queued assets
        // if the network/RLS rejects the write.
        tradeAssets.t1 = [];
        tradeAssets.t2 = [];
        if (typeof logActivityAsync === "function") {
          logActivityAsync("trade_recorded", {
            team1: trade.team1, team2: trade.team2,
            team1_receives: trade.team1Receives,
            team2_receives: trade.team2Receives,
            notes: trade.notes,
          }, { targetTeamId: trade.team2 });
        }
        switchTab("trades");
      })
      .catch(err => alert("Trade save failed: " + err.message));
  } else {
    const trades = getTrades();
    trades.push(trade);
    saveTrades(trades);
    tradeAssets.t1 = [];
    tradeAssets.t2 = [];
    switchTab("trades");
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
    switchTab("trades");
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
        switchTab("trades");
      })
      .catch(err => alert("Delete failed: " + err.message));
  } else {
    trades.splice(index, 1);
    saveTrades(trades);
    switchTab("trades");
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

  // 1. Major league players currently on this team's ESPN roster
  if (snap) {
    const espnTeam = snap.teams.find(t => ESPN_ABBREV_TO_LOCAL[t.abbrev] === team.id);
    if (espnTeam) {
      espnTeam.roster.forEach(r => {
        const basis = resolveCostBasis(r.name, team.id);

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
        ${LEAGUE_DATA.teams.map(t => `<option value="${t.id}">${t.name}</option>`).join("")}
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
        <div style="color:var(--text-dim);font-size:0.8rem">2027 price ($)</div>
        <input type="number" id="ce-nextprice" value="${escapeHtml(o.nextYearPrice ?? "")}" placeholder="${escapeHtml(baseline?.nextYearPrice ?? "")}" style="width:100%;background:var(--bg);color:var(--text);border:1px solid var(--border);padding:8px;border-radius:6px">
        ${baseline ? baseLine("2027 price", baseline.nextYearPrice) : ""}
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
    <table class="player-table">
      <thead>
        <tr>
          <th>Player</th>
          <th>Source</th>
          <th>2026 $</th>
          <th>2027 $</th>
          <th>Contract</th>
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
          const injuryTag = p.injuryStatus && p.injuryStatus !== 'ACTIVE' && p.injuryStatus !== 'NORMAL'
            ? ` <span style="font-size:0.62rem;color:var(--red);text-transform:uppercase">${escapeHtml(p.injuryStatus)}</span>`
            : '';
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
              <td><span class="contract-tag contract-${escapeHtml(p.contractStatus)}">${escapeHtml(p.contractLabel)}</span></td>
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
    <table class="player-table">
      <thead>
        <tr>
          <th>Player</th>
          <th>Source</th>
          <th>2026 $</th>
          <th>2027 $</th>
          <th>Contract</th>
          <th style="text-align:center">Rule 5</th>
          <th style="text-align:center">Keep*</th>
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
          if ((p.statType === "AB" && p.careerStat >= 300) || (p.statType === "IP" && p.careerStat >= 75)) statClass = "stat-warning";
          else if ((p.statType === "AB" && p.careerStat >= 200) || (p.statType === "IP" && p.careerStat >= 50)) statClass = "stat-caution";
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
            contractLabel = yrs === 0 ? "Final yr" : `${yrs} yr${yrs === 1 ? "" : "s"} left`;
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
                ${p.sentDown ? ' <span style="color:var(--red);font-size:0.65rem;font-weight:700">$10 fee</span>' : ''}
                <div style="font-size:0.7rem;color:var(--text-dim);margin-top:2px">
                  <span class="${statClass}">${p.careerStat} ${p.statType}</span>
                  ${ms.eligibilityWarning ? ` <span style="color:var(--orange);font-weight:700;margin-left:4px">${escapeHtml(ms.eligibilityWarning)}</span>` : ''}
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
    <div style="font-size:0.72rem;color:var(--text-dim);margin-top:6px">* Pressing Keep auto-protects via Rule 5. Unchecking Rule 5 unkeeps.</div>
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
  container.innerHTML = LEAGUE_DATA.teams.map(team => {
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

function _normalizeDraft(stored) {
  stored.rounds = DRAFT_ROUNDS;
  stored.picks = (stored.picks || []).filter(p => p.round <= DRAFT_ROUNDS);
  stored.passed = (stored.passed || []).filter(p => p.round <= DRAFT_ROUNDS);
  Object.keys(stored.tradedPicks || {}).forEach(k => {
    if (parseInt(k.split("p")[0], 10) > DRAFT_ROUNDS) delete stored.tradedPicks[k];
  });
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
    passed: []
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
  return `
    <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
      <button class="trade-btn" id="dv-btn-board" onclick="showDraftBoard()">Draft Board</button>
      <button class="trade-btn trade-btn-cancel" id="dv-btn-setup" onclick="showDraftOrderSetup()">Order / Traded Picks</button>
      <button class="trade-btn trade-btn-cancel" onclick="resetDraftConfirm()" style="margin-left:auto">Reset</button>
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
  if (input) input.focus();
  if (input) input.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); makeDraftPick(); }
  });
}

function renderDraftBoard(draft) {
  const teamsCount = draft.baseOrder.length;
  const picksMap = {};
  draft.picks.forEach(p => { picksMap[`${p.round}p${p.pickInRound}`] = p; });
  const passedSet = new Set((draft.passed || []).map(p => `${p.round}p${p.pickInRound}`));
  const current = getCurrentPickInfo(draft);

  let html = `<div style="overflow-x:auto;-webkit-overflow-scrolling:touch">
    <table class="player-table" style="min-width:100%;font-size:0.78rem">
    <thead><tr>
      <th style="position:sticky;left:0;background:var(--bg);z-index:2;min-width:40px">Rd</th>`;
  for (let i = 1; i <= teamsCount; i++) {
    html += `<th style="min-width:110px;font-size:0.65rem">#${i}</th>`;
  }
  html += `</tr></thead><tbody>`;

  for (let round = 1; round <= draft.rounds; round++) {
    html += `<tr>
      <td style="position:sticky;left:0;background:var(--bg-card);z-index:1;font-weight:700;color:var(--text-bright);text-align:center">R${round}</td>`;
    for (let pickInRound = 1; pickInRound <= teamsCount; pickInRound++) {
      const ownerId = getPickOwner(draft, round, pickInRound);
      const owner = LEAGUE_DATA.teams.find(t => t.id === ownerId);
      const pick = picksMap[`${round}p${pickInRound}`];
      const isPassed = passedSet.has(`${round}p${pickInRound}`);
      const isCurrent = current && current.round === round && current.pickInRound === pickInRound;
      const isTraded = ownerId !== getBaseOwner(draft, round, pickInRound);

      const commishCanEdit = isCommissioner();
      let cellStyle = "padding:5px 6px;vertical-align:top";
      if (commishCanEdit) cellStyle += ";cursor:pointer";
      if (isCurrent) cellStyle += ";background:rgba(59,130,246,0.2);outline:2px solid var(--accent)";
      else if (pick) cellStyle += ";background:rgba(34,197,94,0.06)";
      else if (isPassed) cellStyle += ";background:rgba(249,115,22,0.08)";

      const cellClickAttr = commishCanEdit ? `onclick="openPickEditor(${round},${pickInRound})" title="Click to edit"` : "";
      html += `<td style="${cellStyle}" ${cellClickAttr}>
        <div style="color:var(--accent);font-weight:600;font-size:0.72rem">${owner ? owner.name : ownerId}${isTraded ? ' <span style="color:var(--orange);font-size:0.6rem">(T)</span>' : ''}</div>
        ${pick
          ? `<div style="color:var(--text-bright);margin-top:2px;font-weight:600">${escapeHtml(pick.player)}</div>${pick.notes ? `<div style="color:var(--text-dim);font-size:0.65rem;margin-top:1px">${escapeHtml(pick.notes)}</div>` : ""}`
          : isCurrent
            ? '<div style="color:var(--text-dim);font-style:italic;margin-top:2px">On clock</div>'
            : isPassed
              ? '<div style="color:var(--orange);font-size:0.7rem;margin-top:2px;font-weight:600">PASSED</div>'
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
        ${draft.tradedPicks[pickKey] ? `<button class="trade-btn trade-btn-cancel" style="margin-left:auto" onclick="clearPickOverride(${round},${pickInRound})">Reset to Original Owner</button>` : ""}
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
  delete draft.tradedPicks[`${round}p${pickInRound}`];
  const pickRecord = draft.picks.find(p => p.round === round && p.pickInRound === pickInRound);
  if (pickRecord) {
    pickRecord.team = draft.baseOrder[draft.type === "snake" && round % 2 === 0 ? draft.baseOrder.length - pickInRound : pickInRound - 1];
  }
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
  saveDraft(draft);
  if (typeof logActivityAsync === "function") {
    logActivityAsync("minors_pick_made", {
      round: current.round, pick_in_round: current.pickInRound,
      player_name: player, notes,
    }, { targetTeamId: current.team });
  }
  showDraftBoard();
}

function passCurrentPick() {
  if (!isCommissioner()) {
    alert("Only a commissioner can pass a pick. Ask a commish to do it for you.");
    return;
  }
  const draft = getDraft();
  const current = getCurrentPickInfo(draft);
  if (!current) return;
  if (!draft.passed) draft.passed = [];
  draft.passed.push({ round: current.round, pickInRound: current.pickInRound, team: current.team });
  saveDraft(draft);
  if (typeof logActivityAsync === "function") {
    logActivityAsync("minors_pick_passed", {
      round: current.round, pick_in_round: current.pickInRound,
    }, { targetTeamId: current.team });
  }
  showDraftBoard();
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

function switchTab(tab) {
  // Re-derive each team's current minors/callups from the static anchor +
  // trade log + callup overrides before any render reads them.
  if (typeof applyRosterAdjustments === "function") applyRosterAdjustments();
  // Reset the asset-price memo so any view that renders trade assets
  // picks up fresh prices (after a callup, FA pickup, override, etc.).
  if (typeof _invalidatePriceMap === "function") _invalidatePriceMap();
  document.querySelectorAll(".nav-tab").forEach(t => t.classList.remove("active"));
  const tabEl = document.querySelector(`[data-tab="${tab}"]`);
  if (tabEl) tabEl.classList.add("active");

  const content = document.getElementById("main-content");
  const backBtn = document.getElementById("back-btn");
  const title = document.getElementById("header-title");

  backBtn.classList.remove("visible");

  switch (tab) {
    case "teams":
      currentView = "teams";
      title.textContent = "Fantasy League Manager";
      content.innerHTML = renderTeamGrid();
      break;
    case "eligible":
      currentView = "eligible";
      title.textContent = "Select Keepers";
      content.innerHTML = renderEligibleKeepersView();
      document.getElementById("eligible-team-select").value = "all";
      updateEligibleKeepersView();
      break;
    case "keepers":
      currentView = "keepers";
      title.textContent = "2026 Keepers";
      content.innerHTML = renderKeepersView();
      document.getElementById("keepers-team-select").value = "all";
      updateKeepersView();
      break;
    case "rosters":
      currentView = "rosters";
      title.textContent = "Current Rosters";
      content.innerHTML = renderRostersView();
      document.getElementById("rosters-team-select").value = "all";
      updateRostersView();
      break;
    case "trades":
      currentView = "trades";
      title.textContent = "Trade Log";
      content.innerHTML = renderTradesView();
      break;
    case "trade-block":
      currentView = "trade-block";
      title.textContent = "Trade Block";
      content.innerHTML = renderTradeBlockView();
      break;
    case "trade-inbox":
      currentView = "trade-inbox";
      title.textContent = "Trade Inbox";
      content.innerHTML = renderTradeInboxView();
      break;
    case "draft":
      currentView = "draft";
      title.textContent = "2027 Minor League Draft";
      content.innerHTML = renderDraftView();
      renderProspectStatus();
      showDraftBoard();
      // Auto-fetch if no cache exists
      if (!getCachedProspects()) kickOffProspectRefresh();
      break;
    case "rule5":
      currentView = "rule5";
      title.textContent = "Rule 5 Draft";
      content.innerHTML = renderRule5View();
      break;
    case "trophy-room":
      currentView = "trophy-room";
      title.textContent = "Trophy Room";
      content.innerHTML = renderTrophyRoomView();
      break;
    case "activity":
      currentView = "activity";
      title.textContent = "Activity";
      content.innerHTML = renderActivityView();
      break;
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
  return `
    <div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);font-size:0.85rem">
      <div style="color:var(--text-dim);font-size:0.72rem;min-width:64px;padding-top:2px">${timestampHTML(a.created_at)}</div>
      <div style="flex:1;color:var(--text)">${describeActivity(a)}</div>
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
    case "minors_pick_undone":
      return `${actor} undid pick: ${player} (R${p.round}.${p.pick_in_round})`;
    case "minors_draft_reset":
      return `${actor} reset the Minors Draft`;
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
    case "commish_override":
      return `${actor} overrode ${player}'s contract <span style="color:var(--text-dim)">(${(p.fields || []).map(f => escapeHtml(f)).join(", ")})</span>`;
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
  "JRAM": "dave",   // David Warshafsky, 2019
  "HADR": "matt",   // Matt Rotbart, 2021–2023
  "SDJ":  "sam",    // Samuel Rotbart, 2021–2023
};

const _trophyAbbrevWarned = new Set();
function trophyTeamLabel(team) {
  const localId = HISTORICAL_ABBREV_OVERRIDES[team.abbrev] || ESPN_ABBREV_TO_LOCAL[team.abbrev];
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
            return `${trophyTeamLabel(t)}${pts}`;
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
              <td><span class="player-name">${escapeHtml(trophyTeamLabel(t))}</span>${medal ? ` ${medal}` : ""}</td>
              <td style="text-align:right;color:var(--text-bright);font-weight:600">${pts}</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
  document.body.appendChild(modal);
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
    onClockHtml = `
      <div class="keeper-projection" style="background:rgba(59,130,246,0.1);border-color:var(--accent);margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px;margin-bottom:8px">
          <h3 style="margin:0">On the Clock: <span style="color:var(--accent)">${team ? team.name : cur.teamId}</span></h3>
          <span style="color:var(--text-dim);font-size:0.82rem">Round ${cur.round} · Pick ${cur.idx + 1}</span>
        </div>
        ${commish ? `
          <select id="rule5-pick-select" class="trade-select" style="margin-top:8px">
            <option value="">Select player to pick...</option>
            ${sortedRemaining.map(p => {
              const yrs = p.yearsRemaining != null ? `, ${p.yearsRemaining}yr` : '';
              const price = p.nextYearPrice != null ? `, $${p.nextYearPrice}` : '';
              return `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)} (${escapeHtml(p.originTeamName)}${yrs}${price})</option>`;
            }).join("")}
          </select>
          <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
            <button class="trade-btn trade-btn-submit" onclick="(() => { const v = document.getElementById('rule5-pick-select').value; if (!v) { alert('Choose a player'); return; } makeRule5Pick(v); })()">Pick</button>
            <button class="trade-btn trade-btn-cancel" onclick="passRule5Pick()">Pass</button>
            ${state.picks.length ? `<button class="trade-btn trade-btn-cancel" style="margin-left:auto" onclick="undoRule5Pick()">Undo Last</button>` : ''}
          </div>
        ` : `<div style="color:var(--text-dim);font-size:0.85rem;font-style:italic;margin-top:8px">Only the commissioner can record picks.</div>`}
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
        <tr><th>Player</th><th>Origin</th><th>Yrs Left</th><th>2027 $</th></tr>
      </thead>
      <tbody>
        ${[...remaining].sort((a, b) => lastName(a.name).localeCompare(lastName(b.name))).map(p => `
          <tr>
            <td><span class="player-name">${escapeHtml(p.name)}</span></td>
            <td><span class="team-link" style="color:var(--accent)">${p.originTeamName}</span></td>
            <td>${p.yearsRemaining != null ? `<span class="contract-tag contract-${p.yearsRemaining === 0 ? 'final' : p.yearsRemaining === 1 ? 'expiring' : 'mid'}">${p.yearsRemaining} yr${p.yearsRemaining === 1 ? '' : 's'}</span>` : '<span style="color:var(--text-dim)">—</span>'}</td>
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
  const poolEntry = state.pool.find(p => p.name === playerName);
  if (!poolEntry) { alert("Player not in pool"); return; }
  const pickedAlready = state.picks.some(p => p.playerName === playerName);
  if (pickedAlready) { alert("Already picked"); return; }

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

function passRule5Pick() {
  const state = getRule5State();
  const cur = getRule5CurrentPick(state);
  if (!cur) return;
  state.picks.push({
    round: cur.round,
    idx: cur.idx,
    teamId: cur.teamId,
    pass: true,
    timestamp: Date.now(),
  });
  saveRule5State(state);
  switchTab("rule5");
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
          Email link not working? Enter the 6-digit code from the same email.
        </div>
        <div style="display:flex;gap:8px">
          <input type="text" id="login-code" inputmode="numeric" maxlength="6" placeholder="123456" autocomplete="one-time-code"
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
      "Check your email. Click the link <em>or</em> enter the 6-digit code below.";
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

  // Inbox unread badge — re-paint on every header update so it stays current
  // as proposals/messages flow in via realtime. The count covers BOTH new
  // pending proposals to you AND new messages from someone else, with a
  // hover tooltip breaking down the two.
  const inboxNav = document.getElementById("nav-trade-inbox");
  if (inboxNav) {
    const u = (typeof dbGetUnreadCounts === "function") ? dbGetUnreadCounts() : { proposals: 0, messages: 0, total: 0 };
    if (u.total > 0) {
      const tip = `${u.proposals} new proposal${u.proposals === 1 ? "" : "s"}, ${u.messages} new message${u.messages === 1 ? "" : "s"}`;
      inboxNav.innerHTML = `Trade Inbox <span title="${escapeHtml(tip)}" style="color:var(--red);font-weight:800;margin-left:2px">(${u.total})</span>`;
    } else {
      inboxNav.innerHTML = "Trade Inbox";
    }
  }
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
