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
              <td><span class="player-name">${p.name}</span>${p.sentDown ? ' <span style="color:var(--red);font-size:0.65rem;font-weight:700">$10 fee</span>' : ''}</td>
              <td class="player-year">${p.yearAcquired}</td>
              <td class="${statClass}">${p.careerStat} ${p.statType}</td>
              <td><span style="color:var(--text-dim);font-size:0.8rem">${ms.contractNote}${ms.yearsRemaining !== null ? ` (${ms.yearsRemaining} yrs)` : ""}</span>${ms.eligibilityWarning ? ` <span style="color:var(--orange);font-size:0.75rem">${ms.eligibilityWarning}</span>` : ""}</td>
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
    container.innerHTML = LEAGUE_DATA.teams.map(team => `
      <div style="margin-bottom:24px">
        <h3 style="color:var(--text-bright);margin-bottom:8px;cursor:pointer" onclick="document.getElementById('rosters-team-select').value='${team.id}';updateRostersView()">
          ${team.name}
          <span style="color:var(--purple);font-size:0.8rem">${team.callups.length} call-ups</span>
          <span style="color:var(--green);font-size:0.8rem">${team.minors.length} minors</span>
        </h3>
        ${renderMinorsCompactTable(team)}
      </div>
    `).join("");
    return;
  }

  const team = LEAGUE_DATA.teams.find(t => t.id === teamId);
  if (!team) return;

  container.innerHTML = `
    ${team.callups.length ? `
      <div class="section-header">
        Called Up to Majors <span class="section-count">${team.callups.length}</span>
      </div>
      ${renderCallupsTable(team.callups)}
    ` : ""}

    <div class="section-header">
      Minor League Roster <span class="section-count">${team.minors.length}/10</span>
    </div>
    ${renderMinorsTable(team.minors)}
  `;
}

function renderMinorsCompactTable(team) {
  const allPlayers = [
    ...team.callups.map(p => ({ ...p, rosterType: "callup" })),
    ...team.minors.map(p => ({ ...p, rosterType: "minors" }))
  ].sort((a, b) => lastName(a.name).localeCompare(lastName(b.name)));
  if (!allPlayers.length) return "<p style='color:var(--text-dim)'>No minor league players</p>";
  return `
    <table class="player-table">
      <thead><tr><th>Player</th><th>Type</th><th>Drafted</th><th>Career</th></tr></thead>
      <tbody>
        ${allPlayers.map(p => {
          let statClass = "";
          if ((p.statType === "AB" && p.careerStat >= 300) || (p.statType === "IP" && p.careerStat >= 75)) statClass = "stat-warning";
          else if ((p.statType === "AB" && p.careerStat >= 200) || (p.statType === "IP" && p.careerStat >= 50)) statClass = "stat-caution";
          return `<tr>
            <td><span class="player-name">${p.name}</span>${p.sentDown ? ' <span style="color:var(--red);font-size:0.65rem">$10</span>' : ''}</td>
            <td><span class="roster-badge ${p.rosterType === 'callup' ? 'badge-callups' : 'badge-minors'}" style="font-size:0.65rem">${p.rosterType === 'callup' ? 'Called Up' : 'Minors'}</span></td>
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
              <td>
                <span class="player-name">${p.name}</span>
                ${p.fromMinors ? '<span class="from-minors-tag">MiLB</span>' : ""}
              </td>
              <td class="player-price">$${p.price}</td>
              <td class="player-year">${p.yearAcquired}</td>
              <td><span class="contract-tag contract-${cs.status}">${cs.label}</span></td>
              <td>${cs.canKeepNextYear ? `<span class="player-price">$${cs.nextYearPrice}</span>` : '<span style="color:var(--text-dim)">—</span>'}</td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
  `;
}

function renderCallupsTable(players) {
  if (!players.length) return "";
  players = [...players].sort((a, b) => lastName(a.name).localeCompare(lastName(b.name)));
  return `
    <table class="player-table">
      <thead><tr><th>Player</th><th>Drafted</th><th>Career Stats</th><th>Status</th></tr></thead>
      <tbody>
        ${players.map(p => {
          const ms = getMinorLeagueContractStatus(p, CURRENT_SEASON);
          const statDisplay = `${p.careerStat} ${p.statType}`;
          let statClass = "";
          if ((p.statType === "AB" && p.careerStat >= 300) || (p.statType === "IP" && p.careerStat >= 75)) statClass = "stat-warning";
          else if ((p.statType === "AB" && p.careerStat >= 200) || (p.statType === "IP" && p.careerStat >= 50)) statClass = "stat-caution";
          return `
            <tr>
              <td><span class="player-name">${p.name}</span></td>
              <td class="player-year">${p.yearAcquired}</td>
              <td class="${statClass}">${statDisplay}</td>
              <td><span style="color:var(--text-dim);font-size:0.8rem">${formatCallupStatus(p, ms)}</span></td>
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

function renderMinorsTable(players) {
  if (!players.length) return "<p style='color:var(--text-dim)'>No minor league players</p>";
  players = [...players].sort((a, b) => lastName(a.name).localeCompare(lastName(b.name)));
  return `
    <table class="player-table">
      <thead><tr><th>Player</th><th>Drafted</th><th>Career Stats</th><th>Yrs Left</th><th>Status</th></tr></thead>
      <tbody>
        ${players.map(p => {
          const ms = getMinorLeagueContractStatus(p, CURRENT_SEASON);
          const statDisplay = `${p.careerStat} ${p.statType}`;
          let statClass = "";
          if ((p.statType === "AB" && p.careerStat >= 300) || (p.statType === "IP" && p.careerStat >= 75)) statClass = "stat-warning";
          else if ((p.statType === "AB" && p.careerStat >= 200) || (p.statType === "IP" && p.careerStat >= 50)) statClass = "stat-caution";
          return `
            <tr>
              <td><span class="player-name">${p.name}</span>${p.sentDown ? ' <span style="color:var(--red);font-size:0.65rem;font-weight:700">$10 fee</span>' : ''}</td>
              <td class="player-year">${p.yearAcquired}</td>
              <td class="${statClass}">${statDisplay}</td>
              <td><span style="color:var(--text-dim);font-size:0.8rem">${ms.yearsRemaining !== null ? ms.yearsRemaining : '—'}</span></td>
              <td>${ms.eligibilityWarning ? `<span style="color:var(--orange);font-size:0.8rem">${ms.eligibilityWarning}</span>` : '<span style="color:var(--green);font-size:0.8rem">Active</span>'}</td>
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
                <td><span class="player-name">${p.name}</span>${p.fromMinors ? '<span class="from-minors-tag">MiLB</span>' : ""}</td>
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
                <td><span class="player-name">${p.name}</span></td>
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
  try {
    return JSON.parse(localStorage.getItem("flm_trades") || "[]");
  } catch { return []; }
}

function saveTrades(trades) {
  localStorage.setItem("flm_trades", JSON.stringify(trades));
}

function renderTradesView() {
  const trades = getTrades();
  return `
    <div style="display:flex;gap:10px;margin-bottom:16px">
      <button class="trade-btn" onclick="showTradeForm()">New Trade</button>
    </div>
    <div id="trade-form-container"></div>
    <div class="section-header">Trade Log <span class="section-count">${trades.length}</span></div>
    <div id="trade-log">
      ${trades.length ? trades.slice().reverse().map((t, i) => renderTradeCard(t, trades.length - 1 - i)).join("") : '<p style="color:var(--text-dim)">No trades recorded yet.</p>'}
    </div>
  `;
}

function renderTradeCard(trade, index) {
  const team1 = LEAGUE_DATA.teams.find(t => t.id === trade.team1);
  const team2 = LEAGUE_DATA.teams.find(t => t.id === trade.team2);
  return `
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:14px;margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <span style="color:var(--text-dim);font-size:0.75rem">${trade.date}</span>
        <button onclick="deleteTrade(${index})" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:0.75rem">Delete</button>
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
      ${trade.notes ? `<div style="margin-top:8px;color:var(--text-dim);font-size:0.8rem;font-style:italic">${trade.notes}</div>` : ''}
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
      <span style="color:${color};font-weight:600">${a.value}</span>
      <span style="color:var(--text-dim);font-size:0.7rem;margin-left:4px">${typeLabel}</span>
    </div>`;
  }).join('');
}

function showTradeForm() {
  // Fresh form = fresh asset state
  tradeAssets.t1 = [];
  tradeAssets.t2 = [];
  tradeAssets.teamIds.t1 = null;
  tradeAssets.teamIds.t2 = null;

  const container = document.getElementById("trade-form-container");
  const teamOptions = LEAGUE_DATA.teams.map(t => `<option value="${t.id}">${t.name}</option>`).join("");
  container.innerHTML = `
    <div class="keeper-projection" style="margin-bottom:16px">
      <h3>Record a Trade</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:12px">
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
    return `<option value="major:${p.name}">${label}</option>`;
  }).join("");
  const minorOptions = [...team.minors]
    .sort((a, b) => lastName(a.name).localeCompare(lastName(b.name)))
    .map(p => `<option value="minor:${p.name}">${p.name}</option>`)
    .join("");

  container.innerHTML = `
    <div style="margin-top:8px">
      <label style="font-size:0.75rem;color:var(--text-dim)">Sends:</label>
      <select id="${prefix}-player-select" class="trade-select" style="margin-top:2px">
        <option value="">Add player/asset...</option>
        <optgroup label="Major Leaguers">${majorOptions}</optgroup>
        <optgroup label="Minor Leaguers">${minorOptions}</optgroup>
        <optgroup label="Other Assets">
          <option value="draft_dollars">Draft Dollars</option>
          <option value="faab">FAAB Dollars</option>
          <option value="milb_pick">Minor League Pick</option>
        </optgroup>
      </select>
      <div style="display:flex;gap:6px;margin-top:6px">
        <input type="text" id="${prefix}-asset-detail" placeholder="Amount or pick details" style="flex:1;background:var(--bg);color:var(--text);border:1px solid var(--border);padding:6px 8px;border-radius:4px;font-size:0.85rem;display:none">
        <button onclick="addTradeAsset('${prefix}')" class="trade-btn" style="font-size:0.8rem;padding:6px 12px">Add</button>
      </div>
      <div id="${prefix}-asset-list" style="margin-top:6px"></div>
    </div>
  `;

  // Show/hide detail input based on selection
  document.getElementById(`${prefix}-player-select`).addEventListener("change", function() {
    const detail = document.getElementById(`${prefix}-asset-detail`);
    if (["draft_dollars", "faab", "milb_pick"].includes(this.value)) {
      detail.style.display = "block";
      detail.placeholder = this.value === "milb_pick" ? "e.g. 2027 1st round" : "Dollar amount";
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
  if (val.startsWith("major:") || val.startsWith("minor:") || val.startsWith("callup:")) {
    const [type, name] = [val.split(":")[0], val.substring(val.indexOf(":") + 1)];
    asset = { type, value: name };
  } else if (val === "draft_dollars") {
    asset = { type: "draft_dollars", value: `$${detail.value || "0"} draft dollars` };
  } else if (val === "faab") {
    asset = { type: "faab", value: `$${detail.value || "0"} FAAB` };
  } else if (val === "milb_pick") {
    asset = { type: "milb_pick", value: detail.value || "MiLB pick" };
  }

  if (asset) {
    tradeAssets[prefix].push(asset);
    select.value = "";
    detail.value = "";
    detail.style.display = "none";
    renderAssetList(prefix);
  }
}

function removeTradeAsset(prefix, index) {
  tradeAssets[prefix].splice(index, 1);
  renderAssetList(prefix);
}

function renderAssetList(prefix) {
  const container = document.getElementById(`${prefix}-asset-list`);
  if (!container) return;
  container.innerHTML = tradeAssets[prefix].map((a, i) => {
    const typeLabel = { major: 'MLB', minor: 'MiLB', callup: 'MiLB', draft_dollars: '$', faab: 'FAAB', milb_pick: 'Pick' }[a.type];
    return `<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 8px;background:var(--bg);border-radius:4px;margin-bottom:3px;font-size:0.82rem">
      <span><span style="color:var(--text-dim);font-size:0.7rem">${typeLabel}</span> ${a.value}</span>
      <button onclick="removeTradeAsset('${prefix}',${i})" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:0.8rem">x</button>
    </div>`;
  }).join("");
}

function submitTrade() {
  const team1 = document.getElementById("trade-team1").value;
  const team2 = document.getElementById("trade-team2").value;
  const notes = document.getElementById("trade-notes").value;

  if (!team1 || !team2) { alert("Select both teams"); return; }
  if (team1 === team2) { alert("Teams must be different"); return; }
  if (!tradeAssets.t1.length && !tradeAssets.t2.length) { alert("Add at least one asset"); return; }

  const trade = {
    date: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
    team1,
    team2,
    team1Receives: [...tradeAssets.t2], // team1 receives what team2 sends
    team2Receives: [...tradeAssets.t1], // team2 receives what team1 sends
    notes
  };

  const trades = getTrades();
  trades.push(trade);
  saveTrades(trades);

  // Reset
  tradeAssets.t1 = [];
  tradeAssets.t2 = [];
  switchTab("trades");
}

function cancelTrade() {
  tradeAssets.t1 = [];
  tradeAssets.t2 = [];
  document.getElementById("trade-form-container").innerHTML = "";
}

function deleteTrade(index) {
  if (!confirm("Delete this trade?")) return;
  const trades = getTrades();
  trades.splice(index, 1);
  saveTrades(trades);
  switchTab("trades");
}


// --- Rendering: Eligible Keepers Tab ---

function getEligibleKeeperSelections() {
  try {
    return JSON.parse(localStorage.getItem("flm_eligible_keepers") || "{}");
  } catch { return {}; }
}

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
  try { return JSON.parse(localStorage.getItem("flm_callup_prices") || "{}"); }
  catch { return {}; }
}

function setCallupPriceOverride(playerName, price, year) {
  const all = getCallupPriceOverrides();
  all[playerName] = { price: Number(price), year: Number(year) };
  localStorage.setItem("flm_callup_prices", JSON.stringify(all));
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

function isCommissioner() {
  // For now, simple localStorage flag (default true since the only user is currently the commish).
  // Once Supabase is wired up, this comes from auth role.
  const v = localStorage.getItem("flm_is_commissioner");
  return v === null ? true : v === "true";
}

function setCommissioner(flag) {
  localStorage.setItem("flm_is_commissioner", flag ? "true" : "false");
}

function getWorkaroundOverrides() {
  try { return JSON.parse(localStorage.getItem("flm_workaround_overrides") || "{}"); }
  catch { return {}; }
}

function setWorkaroundOverride(playerId, decision) {
  const all = getWorkaroundOverrides();
  if (!decision || decision === "auto") delete all[String(playerId)];
  else all[String(playerId)] = decision;
  localStorage.setItem("flm_workaround_overrides", JSON.stringify(all));
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

function getPlayerIdByName(playerName) {
  const snap = getEspnSnapshot();
  if (!snap) return null;
  for (const t of snap.teams) {
    const p = t.roster.find(r => r.name === playerName);
    if (p) return p.playerId;
  }
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
  const playerId = getPlayerIdByName(playerName);
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
            label: basis.source === "fa-after-drop" ? "Dropped → FA $6" : "FA — $6 next yr",
          };
        } else if (basis.contractType === "callup" && basis.price == null) {
          // A callup without an MLB price still rides their MILB contract.
          // Pre-2027 picks have a 4-yr MILB contract; once it ends, they're not keepable.
          const milbYearsHeld = CURRENT_SEASON - basis.yearAcquired;
          const milbMaxYears = basis.yearAcquired < 2027 ? 4 : 99;
          const milbYrsAfterThisSeason = Math.max(0, milbMaxYears - milbYearsHeld - 1);
          if (milbYrsAfterThisSeason > 0 || basis.yearAcquired >= 2027) {
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
              label: `Expires in ${CURRENT_SEASON}`,
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

  return players;
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
  return `
    ${syncBanner}
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
  const draftBudget = 260 - totalKeeperCost;
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
        <div class="summary-value" id="ek-draft-budget" style="color:var(--accent)">$${draftBudget}</div>
        <div class="summary-label">Draft Budget</div>
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

function renderEligibleTable(players, teamId, teamSelections) {
  return `
    <table class="player-table">
      <thead>
        <tr>
          <th>Player</th>
          <th>Source</th>
          <th>2026 $</th>
          <th>2027 $</th>
          <th>Contract</th>
          <th style="text-align:center">Keep</th>
          <th style="text-align:center">Rule 5</th>
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
          const nextPriceCell = p.nextYearPrice != null
            ? `<span class="player-price">$${p.nextYearPrice}</span>`
            : (p.contractType === 'callup'
                ? `<button onclick="promptCallupPrice('${p.name.replace(/'/g,"\\'")}',${teamId ? `'${teamId}'` : 'null'})" style="background:none;border:1px dashed var(--border);color:var(--yellow);font-size:0.72rem;padding:2px 8px;border-radius:4px;cursor:pointer">Set price</button>`
                : '<span style="color:var(--text-dim)">—</span>');
          const injuryTag = p.injuryStatus && p.injuryStatus !== 'ACTIVE' && p.injuryStatus !== 'NORMAL'
            ? ` <span style="font-size:0.62rem;color:var(--red);text-transform:uppercase">${p.injuryStatus}</span>`
            : '';
          const rowBg = p.workaround && p.workaround.needsConfirmation
            ? 'background:rgba(249,115,22,0.12)'
            : (isKeeper ? 'background:rgba(34,197,94,0.08)'
                : isRule5 ? 'background:rgba(59,130,246,0.08)'
                : isTradeBlock ? 'background:rgba(249,115,22,0.08)'
                : '');
          const nameEsc = p.name.replace(/'/g, "\\'");
          const blocked = !p.canKeepNextYear;
          const nameStyle = blocked ? 'color:var(--text-dim)' : '';
          const blockedAttr = blocked ? 'disabled' : '';
          const blockedCursor = blocked ? 'not-allowed' : 'pointer';
          return `
            <tr style="${rowBg}">
              <td>
                <span class="player-name" style="${nameStyle}">${p.name}</span>${injuryTag}
                ${workaroundBadgeHtml(p)}
              </td>
              <td>${sourceBadge(p)}</td>
              <td>${priceCell}</td>
              <td>${nextPriceCell}</td>
              <td><span class="contract-tag contract-${p.contractStatus}">${p.contractLabel}</span></td>
              <td style="text-align:center">
                <input type="checkbox" ${isKeeper ? 'checked' : ''} ${blockedAttr} onchange="toggleEligibleKeeper('${teamId}','${nameEsc}','keeper',this.checked)" style="width:18px;height:18px;cursor:${blockedCursor};accent-color:var(--green)">
              </td>
              <td style="text-align:center">
                <input type="checkbox" ${isRule5 ? 'checked' : ''} ${blockedAttr} onchange="toggleEligibleKeeper('${teamId}','${nameEsc}','rule5',this.checked)" style="width:18px;height:18px;cursor:${blockedCursor};accent-color:var(--accent)">
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
  return `
    <table class="player-table">
      <thead>
        <tr>
          <th>Player</th>
          <th>Source</th>
          <th>2026 $</th>
          <th>2027 $</th>
          <th>Contract</th>
          <th style="text-align:center">Keep</th>
          <th style="text-align:center">Rule 5</th>
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
          const nameEsc = p.name.replace(/'/g, "\\'");
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
          const blocked = !isKeepable;
          const nameStyle = blocked ? 'color:var(--text-dim)' : '';
          const blockedAttr = blocked ? 'disabled' : '';
          const blockedCursor = blocked ? 'not-allowed' : 'pointer';
          return `
            <tr style="${rowBg}">
              <td>
                <span class="player-name" style="${nameStyle}">${p.name}</span>
                ${p.sentDown ? ' <span style="color:var(--red);font-size:0.65rem;font-weight:700">$10 fee</span>' : ''}
                <div style="font-size:0.7rem;color:var(--text-dim);margin-top:2px">
                  <span class="${statClass}">${p.careerStat} ${p.statType}</span>
                  ${ms.eligibilityWarning ? ` <span style="color:var(--orange);font-weight:700;margin-left:4px">${ms.eligibilityWarning}</span>` : ''}
                </div>
              </td>
              <td>${sourceTag}</td>
              <td><span style="color:var(--text-dim)">—</span></td>
              <td><span style="color:var(--text-dim)">—</span></td>
              <td><span class="contract-tag contract-${contractStatusClass}">${contractLabel}</span></td>
              <td style="text-align:center">
                <input type="checkbox" ${isMinorKeeper ? 'checked' : ''} ${blockedAttr} onchange="toggleEligibleKeeper('${teamId}','${nameEsc}','minorKeeper',this.checked)" style="width:18px;height:18px;cursor:${blockedCursor};accent-color:var(--green)">
              </td>
              <td style="text-align:center">
                <input type="checkbox" ${isRule5 ? 'checked' : ''} ${blockedAttr} onchange="toggleEligibleKeeper('${teamId}','${nameEsc}','rule5',this.checked)" style="width:18px;height:18px;cursor:${blockedCursor};accent-color:var(--accent)">
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

function toggleEligibleKeeper(teamId, playerName, field, checked) {
  const selections = getEligibleKeeperSelections();
  if (!selections[teamId]) selections[teamId] = {};
  if (!selections[teamId][playerName]) selections[teamId][playerName] = {};

  // Caps per league rules: 8 ML keepers, 10 MiL keepers
  if (field === 'keeper' && checked) {
    const teamSel = selections[teamId];
    const currentKeepers = Object.values(teamSel).filter(s => s.keeper).length;
    if (currentKeepers >= 8) {
      alert("Maximum 8 major-league keepers allowed. Deselect a keeper first.");
      event.target.checked = false;
      return;
    }
  }
  if (field === 'minorKeeper' && checked) {
    const teamSel = selections[teamId];
    const currentMinorKeepers = Object.values(teamSel).filter(s => s.minorKeeper).length;
    if (currentMinorKeepers >= 10) {
      alert("Maximum 10 minor-league keepers allowed. Deselect one first.");
      event.target.checked = false;
      return;
    }
  }
  if (field === 'rule5' && checked) {
    const teamSel = selections[teamId];
    const currentRule5 = Object.values(teamSel).filter(s => s.rule5).length;
    if (currentRule5 >= 25) {
      alert("Maximum 25 Rule 5 protections allowed. Deselect one first.");
      event.target.checked = false;
      return;
    }
  }

  selections[teamId][playerName][field] = checked;

  // Clean up empty entries
  const s = selections[teamId][playerName];
  if (!s.keeper && !s.minorKeeper && !s.tradeBlock && !s.rule5) {
    delete selections[teamId][playerName];
  }

  saveEligibleKeeperSelections(selections);

  // Update summary bar without full re-render (to preserve scroll)
  const team = LEAGUE_DATA.teams.find(t => t.id === teamId);
  const players = getEligiblePlayers(team);
  const teamSel = selections[teamId] || {};
  const selectedKeepers = players.filter(p => teamSel[p.name]?.keeper);
  const totalCost = selectedKeepers.reduce((s, p) => s + (p.price || 0), 0);
  const budget = 260 - totalCost;
  const minorKeeperCount = Object.values(teamSel).filter(x => x.minorKeeper).length;
  const rule5Count = Object.values(teamSel).filter(x => x.rule5).length;
  const colorFor = (cur, cap) => cur > cap ? 'var(--red)' : cur === cap ? 'var(--green)' : 'var(--yellow)';

  const countEl = document.getElementById("ek-keeper-count");
  const minorEl = document.getElementById("ek-minor-count");
  const rule5El = document.getElementById("ek-rule5-count");
  const costEl = document.getElementById("ek-keeper-cost");
  const budgetEl = document.getElementById("ek-draft-budget");
  if (countEl) { countEl.textContent = `${selectedKeepers.length}/8`; countEl.style.color = colorFor(selectedKeepers.length, 8); }
  if (minorEl) { minorEl.textContent = `${minorKeeperCount}/10`; minorEl.style.color = colorFor(minorKeeperCount, 10); }
  if (rule5El) { rule5El.textContent = `${rule5Count}/25`; rule5El.style.color = colorFor(rule5Count, 25); }
  if (costEl) costEl.textContent = `$${totalCost}`;
  if (budgetEl) budgetEl.textContent = `$${budget}`;
}

function renderAllTeamsEligibleSummary(container) {
  const selections = getEligibleKeeperSelections();

  container.innerHTML = LEAGUE_DATA.teams.map(team => {
    const players = getEligiblePlayers(team);
    const teamSel = selections[team.id] || {};
    const keepers = players.filter(p => teamSel[p.name]?.keeper);
    const tradeBlock = [...players, ...team.minors].filter(p => teamSel[p.name]?.tradeBlock);
    const rule5 = team.minors.filter(p => teamSel[p.name]?.rule5);
    const keeperCost = keepers.reduce((s, p) => s + p.price, 0);

    return `
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:14px;margin-bottom:10px;cursor:pointer" onclick="document.getElementById('eligible-team-select').value='${team.id}';updateEligibleKeepersView()">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <span style="font-weight:700;color:var(--text-bright);font-size:1.05rem">${team.name}</span>
          <span style="color:${keepers.length === 8 ? 'var(--green)' : keepers.length === 0 ? 'var(--text-dim)' : 'var(--yellow)'};font-weight:700">${keepers.length}/8 keepers</span>
        </div>
        ${keepers.length ? `
          <div style="font-size:0.82rem;color:var(--text-dim);margin-bottom:4px">
            <span style="color:var(--green);font-weight:600">$${keeperCost}</span> keeper cost
            &middot; <span style="color:var(--accent);font-weight:600">$${260 - keeperCost}</span> draft budget
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px">
            ${keepers.map(p => `<span style="font-size:0.75rem;background:rgba(34,197,94,0.15);color:var(--green);padding:2px 8px;border-radius:10px">${p.name} $${p.price}</span>`).join('')}
          </div>
        ` : '<div style="font-size:0.82rem;color:var(--text-dim)">No keepers selected yet</div>'}
        ${tradeBlock.length ? `
          <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px">
            ${tradeBlock.map(p => `<span style="font-size:0.72rem;background:rgba(249,115,22,0.15);color:var(--orange);padding:2px 7px;border-radius:10px">${p.name}</span>`).join('')}
            <span style="font-size:0.7rem;color:var(--text-dim);align-self:center">trade block</span>
          </div>
        ` : ''}
        ${rule5.length ? `
          <div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:4px">
            ${rule5.map(p => `<span style="font-size:0.72rem;background:rgba(59,130,246,0.15);color:var(--accent);padding:2px 7px;border-radius:10px">${p.name}</span>`).join('')}
            <span style="font-size:0.7rem;color:var(--text-dim);align-self:center">Rule 5 protected</span>
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

function getDraft() {
  try {
    const stored = JSON.parse(localStorage.getItem("flm_draft_2027") || "null");
    if (stored && stored.baseOrder && stored.baseOrder.length === 12) {
      // Normalize to current rounds; drop anything beyond.
      stored.rounds = DRAFT_ROUNDS;
      stored.picks = (stored.picks || []).filter(p => p.round <= DRAFT_ROUNDS);
      stored.passed = (stored.passed || []).filter(p => p.round <= DRAFT_ROUNDS);
      Object.keys(stored.tradedPicks || {}).forEach(k => {
        if (parseInt(k.split("p")[0], 10) > DRAFT_ROUNDS) delete stored.tradedPicks[k];
      });
      return stored;
    }
  } catch {}
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
  localStorage.setItem("flm_draft_2027", JSON.stringify(draft));
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
  let trades = [];
  try { trades = JSON.parse(localStorage.getItem("flm_trades") || "[]"); } catch {}
  let owner = baseOwner;
  for (const trade of trades) {
    const sides = [
      { receives: trade.team1Receives, fromTeam: trade.team2, toTeam: trade.team1 },
      { receives: trade.team2Receives, fromTeam: trade.team1, toTeam: trade.team2 }
    ];
    for (const side of sides) {
      for (const asset of (side.receives || [])) {
        if (asset.type !== "milb_pick") continue;
        const parsed = parseMilbPickValue(asset.value);
        if (!parsed || parsed.round !== round) continue;
        if (parsed.year && parsed.year !== draftYear) continue;
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
    if (el) el.innerHTML = `<span style="color:var(--red)">Failed to load prospects: ${String(e.message || e)}</span> <button onclick="kickOffProspectRefresh()" style="background:none;border:none;color:var(--accent);cursor:pointer;text-decoration:underline;font-size:0.75rem">Retry</button>`;
  }
}

function resetDraftConfirm() {
  if (!confirm("Reset the entire 2027 draft? All picks and order customizations will be lost.")) return;
  localStorage.removeItem("flm_draft_2027");
  switchTab("draft");
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
    html += `
      <div class="keeper-projection" style="background:rgba(59,130,246,0.1);border-color:var(--accent);margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px">
          <h3 style="margin:0">On the Clock: <span style="color:var(--accent)">${team ? team.name : current.team}</span></h3>
          <span style="color:var(--text-dim);font-size:0.82rem">Round ${current.round} &middot; Pick ${current.pickInRound} (Overall #${current.overall})</span>
        </div>
        <input type="text" id="draft-player-name" placeholder="Player name (type to search, or enter a new name)" autocomplete="off" list="prospect-suggestions"
          style="width:100%;background:var(--bg);color:var(--text);border:1px solid var(--border);padding:10px;border-radius:6px;font-size:0.95rem;margin-top:10px">
        <datalist id="prospect-suggestions">
          ${getAvailableProspects().map(n => `<option value="${escapeHtml(n)}"></option>`).join("")}
        </datalist>
        <input type="text" id="draft-player-notes" placeholder="Notes: position, school/team, age, org (e.g. SS, HS, 18)"
          style="width:100%;background:var(--bg);color:var(--text);border:1px solid var(--border);padding:8px;border-radius:6px;font-size:0.85rem;margin-top:6px">
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
          <button class="trade-btn trade-btn-submit" onclick="makeDraftPick()">Submit Pick</button>
          <button class="trade-btn trade-btn-cancel" onclick="passCurrentPick()" style="font-size:0.85rem">Pass</button>
          ${draft.picks.length ? `<button class="trade-btn trade-btn-cancel" onclick="undoLastPick()" style="font-size:0.85rem">Undo Last Pick</button>` : ""}
        </div>
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

      let cellStyle = "padding:5px 6px;vertical-align:top;cursor:pointer";
      if (isCurrent) cellStyle += ";background:rgba(59,130,246,0.2);outline:2px solid var(--accent)";
      else if (pick) cellStyle += ";background:rgba(34,197,94,0.06)";
      else if (isPassed) cellStyle += ";background:rgba(249,115,22,0.08)";

      html += `<td style="${cellStyle}" onclick="openPickEditor(${round},${pickInRound})" title="Click to edit">
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
  const rows = passed.map(p => {
    const owner = LEAGUE_DATA.teams.find(t => t.id === p.team);
    return `<div style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--bg);border:1px solid var(--border);border-radius:6px;margin-bottom:6px">
      <span style="color:var(--orange);font-size:0.7rem;font-weight:700;min-width:50px">R${p.round}.${p.pickInRound}</span>
      <span style="color:var(--text-bright);font-weight:600;flex:1">${owner ? owner.name : p.team}</span>
      <button class="trade-btn" style="font-size:0.78rem;padding:5px 10px" onclick="activatePassedPick(${p.round},${p.pickInRound})">Activate</button>
    </div>`;
  }).join("");
  return `<div class="section-header">Passed Picks <span class="section-count">${passed.length}</span></div>
    <div style="margin-bottom:14px">${rows}</div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

function openPickEditor(round, pickInRound) {
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
  showDraftBoard();
}

function passCurrentPick() {
  const draft = getDraft();
  const current = getCurrentPickInfo(draft);
  if (!current) return;
  if (!draft.passed) draft.passed = [];
  draft.passed.push({ round: current.round, pickInRound: current.pickInRound, team: current.team });
  saveDraft(draft);
  showDraftBoard();
}

function activatePassedPick(round, pickInRound) {
  openPickEditor(round, pickInRound);
}

function undoLastPick() {
  const draft = getDraft();
  if (!draft.picks.length) return;
  if (!confirm("Undo last pick?")) return;
  draft.picks.pop();
  saveDraft(draft);
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
  const entries = Object.entries(draft.tradedPicks);
  if (!entries.length) {
    container.innerHTML = '<div style="color:var(--text-dim);font-size:0.82rem;font-style:italic">No traded picks recorded.</div>';
    return;
  }
  container.innerHTML = entries.map(([key, teamId]) => {
    const match = key.match(/^(\d+)p(\d+)$/);
    if (!match) return "";
    const round = parseInt(match[1]);
    const pickInRound = parseInt(match[2]);
    const origDraft = { ...draft, tradedPicks: {} };
    const originalOwnerId = getPickOwner(origDraft, round, pickInRound);
    const original = LEAGUE_DATA.teams.find(t => t.id === originalOwnerId);
    const newOwner = LEAGUE_DATA.teams.find(t => t.id === teamId);
    return `
      <div style="display:flex;align-items:center;gap:8px;padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:6px;margin-bottom:4px;font-size:0.85rem">
        <span style="color:var(--accent);font-weight:600;min-width:84px">R${round} Pick ${pickInRound}</span>
        <span style="color:var(--text-dim)">${original ? original.name : originalOwnerId}</span>
        <span style="color:var(--text-dim)">&rarr;</span>
        <span style="color:var(--text-bright);font-weight:600;flex:1">${newOwner ? newOwner.name : teamId}</span>
        <button onclick="removeTradedPick('${key}')" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:0.85rem">x</button>
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
let currentTeamId = null;

function switchTab(tab) {
  document.querySelectorAll(".nav-tab").forEach(t => t.classList.remove("active"));
  const tabEl = document.querySelector(`[data-tab="${tab}"]`);
  if (tabEl) tabEl.classList.add("active");

  const content = document.getElementById("main-content");
  const backBtn = document.getElementById("back-btn");
  const title = document.getElementById("header-title");

  backBtn.classList.remove("visible");
  currentTeamId = null;

  switch (tab) {
    case "teams":
      currentView = "teams";
      title.textContent = "Fantasy League Manager";
      content.innerHTML = renderTeamGrid();
      break;
    case "eligible":
      currentView = "eligible";
      title.textContent = "Eligible Keepers";
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
      title.textContent = "Trades";
      content.innerHTML = renderTradesView();
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
  }
}

// --- Rule 5 Draft ---

function getRule5State() {
  try { return JSON.parse(localStorage.getItem("flm_rule5") || "null"); }
  catch { return null; }
}

function saveRule5State(state) {
  localStorage.setItem("flm_rule5", JSON.stringify(state));
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
        ${commish ? `<button class="trade-btn trade-btn-cancel" style="margin-left:auto" onclick="if(confirm('Reload Rule 5 pool? This wipes setup.')){localStorage.removeItem('flm_rule5');switchTab('rule5')}">Reload</button>` : ''}
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
      ${commish ? `<button class="trade-btn trade-btn-cancel" style="margin-left:auto" onclick="if(confirm('Reset entire Rule 5 draft?')){localStorage.removeItem('flm_rule5');switchTab('rule5')}">Reset</button>` : ''}
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
            <td><span class="player-name">${p.name}</span></td>
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

  const tradeId = `rule5-${cur.round}-${cur.idx}-${Date.now()}`;
  state.picks.push({
    round: cur.round,
    idx: cur.idx,
    teamId: cur.teamId,
    playerName: playerName,
    fromTeamId: poolEntry.originTeamId,
    pass: false,
    timestamp: Date.now(),
    tradeId, // back-reference into the trade log
  });
  saveRule5State(state);

  // Auto-record in trade log: $1 draft dollars from picker -> original team, player from original team -> picker.
  const trades = getTrades();
  trades.push({
    id: tradeId,
    date: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
    team1: poolEntry.originTeamId,         // original team (gives up player, gets $1)
    team2: cur.teamId,                      // picking team (gives up $1, gets player)
    team1Receives: [{ type: "draft_dollars", value: "$1 draft dollars" }],
    team2Receives: [{ type: poolEntry.type === "minor" ? "minor" : "major", value: playerName }],
    notes: `Rule 5 pick (Round ${cur.round}.${cur.idx + 1})`,
    rule5: true,
  });
  saveTrades(trades);

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

  // Remove the corresponding trade log entry, if any
  if (last && last.tradeId) {
    const trades = getTrades().filter(t => t.id !== last.tradeId);
    saveTrades(trades);
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
  const messageHtml = message
    ? `<div id="login-msg" style="margin-top:12px;padding:10px;border-radius:6px;background:rgba(59,130,246,0.12);color:var(--accent);font-size:0.85rem">${message}</div>`
    : `<div id="login-msg" style="display:none;margin-top:12px;padding:10px;border-radius:6px;font-size:0.85rem"></div>`;
  main.innerHTML = `
    <div style="max-width:420px;margin:40px auto;padding:24px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius)">
      <h2 style="margin:0 0 8px;color:var(--text-bright)">Fantasy League Manager</h2>
      <p style="color:var(--text-dim);font-size:0.9rem;margin:0 0 18px">
        Private beta. Enter your email and we'll send you a magic link.
      </p>
      <label style="display:block;margin-bottom:10px">
        <div style="color:var(--text-dim);font-size:0.8rem;margin-bottom:4px">Email</div>
        <input type="email" id="login-email" autocomplete="email" placeholder="you@example.com"
          style="width:100%;background:var(--bg);color:var(--text);border:1px solid var(--border);padding:10px;border-radius:6px;font-size:0.95rem">
      </label>
      <button id="login-btn" class="trade-btn trade-btn-submit" style="width:100%;margin-top:8px" onclick="submitMagicLink()">Send Magic Link</button>
      ${messageHtml}
    </div>
  `;
  setTimeout(() => document.getElementById("login-email")?.focus(), 0);
  document.getElementById("login-email")?.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); submitMagicLink(); }
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
    msg.textContent = "Check your email for a sign-in link. You can close this tab.";
    btn.textContent = "Link Sent";
  } catch (err) {
    msg.style.background = "rgba(239,68,68,0.12)";
    msg.style.color = "var(--red)";
    msg.textContent = err.message || "Couldn't send link. Try again.";
    btn.disabled = false;
    btn.textContent = "Send Magic Link";
  }
}

function renderClaimTeamScreen() {
  const main = document.getElementById("main-content");
  document.querySelector(".nav-tabs").style.display = "none";
  document.getElementById("back-btn").style.display = "none";
  document.getElementById("header-title").textContent = "Pick Your Team";
  const opts = LEAGUE_DATA.teams.map(t => `<option value="${t.id}">${t.name}</option>`).join("");
  main.innerHTML = `
    <div style="max-width:420px;margin:40px auto;padding:24px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius)">
      <h2 style="margin:0 0 8px;color:var(--text-bright)">Welcome, ${currentUser.email}</h2>
      <p style="color:var(--text-dim);font-size:0.9rem;margin:0 0 18px">
        Pick the team you own. (A commissioner can override this later.)
      </p>
      <select id="claim-team" class="trade-select" style="width:100%;margin-bottom:12px">${opts}</select>
      <button id="claim-btn" class="trade-btn trade-btn-submit" style="width:100%" onclick="submitClaimTeam()">Claim Team</button>
      <div id="claim-msg" style="display:none;margin-top:12px;padding:10px;border-radius:6px;font-size:0.85rem"></div>
      <button class="trade-btn trade-btn-cancel" style="width:100%;margin-top:14px" onclick="signOut()">Sign Out</button>
    </div>
  `;
}

async function submitClaimTeam() {
  const teamId = document.getElementById("claim-team").value;
  const btn = document.getElementById("claim-btn");
  const msg = document.getElementById("claim-msg");
  btn.disabled = true; btn.textContent = "Claiming...";
  const { error } = await supabaseClient.from("owners").insert({
    id: currentUser.id,
    team_id: teamId,
    is_commissioner: false,
  });
  if (error) {
    msg.style.display = "block";
    msg.style.background = "rgba(239,68,68,0.12)";
    msg.style.color = "var(--red)";
    msg.textContent = error.message.includes("duplicate") || error.message.includes("unique")
      ? `${LEAGUE_DATA.teams.find(t => t.id === teamId)?.name || teamId} is already claimed. Pick a different team or contact a commissioner.`
      : `Couldn't claim team: ${error.message}`;
    btn.disabled = false; btn.textContent = "Claim Team";
    return;
  }
  await refreshAuthState();
}

function renderHeaderUser() {
  let userBar = document.getElementById("user-bar");
  if (!userBar) {
    userBar = document.createElement("div");
    userBar.id = "user-bar";
    userBar.style.cssText = "position:absolute;top:8px;right:12px;display:flex;align-items:center;gap:8px;font-size:0.72rem;color:rgba(255,255,255,0.85)";
    document.querySelector(".app-header").appendChild(userBar);
  }
  if (!currentUser) { userBar.style.display = "none"; return; }
  userBar.style.display = "flex";
  const teamName = currentOwner
    ? (LEAGUE_DATA.teams.find(t => t.id === currentOwner.team_id)?.name || currentOwner.team_id)
    : "—";
  const adminTag = currentOwner?.is_commissioner ? ' <span style="color:var(--yellow);font-weight:700">★</span>' : "";
  userBar.innerHTML = `
    <span>${teamName}${adminTag}</span>
    <button onclick="signOut()" style="background:rgba(0,0,0,0.25);border:1px solid rgba(255,255,255,0.2);color:white;padding:3px 8px;border-radius:4px;font-size:0.7rem;cursor:pointer">Sign Out</button>
  `;
}

function showAppForAuthedUser() {
  document.querySelector(".nav-tabs").style.display = "";
  renderHeaderUser();
  switchTab(currentView || "eligible");
}

function authGate(user, owner) {
  renderHeaderUser();
  if (!user) {
    renderLoginScreen();
    return;
  }
  if (!owner) {
    renderClaimTeamScreen();
    return;
  }
  showAppForAuthedUser();
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
