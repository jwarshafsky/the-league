// Supabase-backed data layer with an in-memory cache.
// Existing app.js code calls sync getters (getTrades(), getDraft(), etc.)
// which read from the cache. Writes are async and update both Supabase and
// the cache.
//
// Loaded after supabase-client.js. Depends on `supabaseClient` and the auth
// state set by that file (currentUser, currentOwner).

const _cache = {
  trades: [],          // array of { _id, date, team1, team2, team1Receives, team2Receives, notes }
  keeperSel: {},       // { teamId: { playerName: { keeper, minorKeeper, rule5, tradeBlock } } }
  draft: null,         // draft state (jsonb)
  rule5: null,         // rule 5 state (jsonb)
  callup: {},          // { playerName: { price, year } }
  commishOverrides: {},     // { playerName: { ... } }
  workaroundOverrides: {},  // { playerId: decision }
};
let _dbReady = false;
const _readyListeners = [];

function onDbReady(fn) {
  if (_dbReady) { try { fn(); } catch (e) { console.error(e); } return; }
  _readyListeners.push(fn);
}

async function _fetchAll() {
  const [trades, ks, ls, co] = await Promise.all([
    supabaseClient.from("trades").select("*").order("created_at", { ascending: true }),
    supabaseClient.from("keeper_selections").select("*"),
    supabaseClient.from("league_state").select("*"),
    supabaseClient.from("callup_overrides").select("*"),
  ]);

  _cache.trades = (trades.data || []).map(_rowToTrade);

  _cache.keeperSel = {};
  for (const r of (ks.data || [])) {
    if (!_cache.keeperSel[r.team_id]) _cache.keeperSel[r.team_id] = {};
    _cache.keeperSel[r.team_id][r.player_name] = {
      keeper: !!r.keeper,
      minorKeeper: !!r.minor_keeper,
      rule5: !!r.rule5,
      tradeBlock: !!r.trade_block,
    };
  }

  _cache.draft = null;
  _cache.rule5 = null;
  _cache.commishOverrides = {};
  _cache.workaroundOverrides = {};
  for (const r of (ls.data || [])) {
    if (r.key === "draft_2027") _cache.draft = r.state;
    else if (r.key === "rule5") _cache.rule5 = r.state;
    else if (r.key === "commish_overrides") _cache.commishOverrides = r.state || {};
    else if (r.key === "workaround_overrides") _cache.workaroundOverrides = r.state || {};
  }

  _cache.callup = {};
  for (const r of (co.data || [])) {
    _cache.callup[r.player_name] = { price: r.price, year: r.year };
  }
}

function _rowToTrade(r) {
  return {
    _id: r.id,
    date: r.date,
    team1: r.team1,
    team2: r.team2,
    team1Receives: r.team1_receives || [],
    team2Receives: r.team2_receives || [],
    notes: r.notes || "",
  };
}

async function _migrateFromLocalStorage() {
  // One-time push of pre-existing localStorage data into Supabase. Runs only
  // when the corresponding Supabase table is empty AND localStorage has data.
  // After this we trust Supabase as the source of truth.
  try {
    // Trades
    if (!_cache.trades.length) {
      const local = JSON.parse(localStorage.getItem("flm_trades") || "[]");
      for (const t of local) {
        await addTradeAsync(t);
      }
      if (local.length) console.log(`Migrated ${local.length} trades from localStorage.`);
    }
    // Keeper selections
    if (!Object.keys(_cache.keeperSel).length) {
      const local = JSON.parse(localStorage.getItem("flm_eligible_keepers") || "{}");
      const rows = [];
      for (const teamId of Object.keys(local)) {
        for (const playerName of Object.keys(local[teamId])) {
          const s = local[teamId][playerName] || {};
          rows.push({
            team_id: teamId,
            player_name: playerName,
            keeper: !!s.keeper,
            minor_keeper: !!s.minorKeeper,
            rule5: !!s.rule5,
            trade_block: !!s.tradeBlock,
          });
        }
      }
      if (rows.length) {
        await supabaseClient.from("keeper_selections").upsert(rows);
        console.log(`Migrated ${rows.length} keeper selection rows.`);
      }
    }
    // Draft
    if (!_cache.draft) {
      const local = localStorage.getItem("flm_draft_2027");
      if (local) {
        await supabaseClient.from("league_state").upsert({ key: "draft_2027", state: JSON.parse(local) });
        console.log("Migrated draft state.");
      }
    }
    // Rule 5
    if (!_cache.rule5) {
      const local = localStorage.getItem("flm_rule5");
      if (local) {
        await supabaseClient.from("league_state").upsert({ key: "rule5", state: JSON.parse(local) });
      }
    }
    // Commish overrides
    if (!Object.keys(_cache.commishOverrides).length) {
      const local = localStorage.getItem("flm_commish_overrides");
      if (local) {
        await supabaseClient.from("league_state").upsert({ key: "commish_overrides", state: JSON.parse(local) });
      }
    }
    // Workaround overrides
    if (!Object.keys(_cache.workaroundOverrides).length) {
      const local = localStorage.getItem("flm_workaround_overrides");
      if (local) {
        await supabaseClient.from("league_state").upsert({ key: "workaround_overrides", state: JSON.parse(local) });
      }
    }
    // Callup overrides
    if (!Object.keys(_cache.callup).length) {
      const local = JSON.parse(localStorage.getItem("flm_callup_prices") || "{}");
      const rows = Object.keys(local).map(name => ({
        player_name: name,
        price: local[name].price ?? null,
        year: local[name].year ?? null,
      }));
      if (rows.length) {
        await supabaseClient.from("callup_overrides").upsert(rows);
      }
    }
    // Re-load after migration so cache reflects whatever just got inserted.
    await _fetchAll();
  } catch (e) {
    console.error("Migration error:", e);
  }
}

async function initDb() {
  if (typeof currentOwner === "undefined" || !currentOwner) return; // wait for auth
  await _fetchAll();
  await _migrateFromLocalStorage();
  _dbReady = true;
  _readyListeners.splice(0).forEach(fn => { try { fn(); } catch (e) { console.error(e); } });
  _subscribeToChanges();
}

function _subscribeToChanges() {
  // Listen for trades / keeper_selections / league_state changes from other
  // users and refresh the cache + UI.
  const refresh = async () => {
    await _fetchAll();
    if (typeof updateEligibleKeepersView === "function" && currentView === "eligible") updateEligibleKeepersView();
    if (typeof switchTab === "function" && currentView === "trades") switchTab("trades");
    if (typeof switchTab === "function" && currentView === "draft") switchTab("draft");
    if (typeof switchTab === "function" && currentView === "rosters") switchTab("rosters");
  };
  try {
    supabaseClient.channel("league-data")
      .on("postgres_changes", { event: "*", schema: "public", table: "trades" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "keeper_selections" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "league_state" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "callup_overrides" }, refresh)
      .subscribe();
  } catch (e) {
    console.warn("Realtime subscribe failed:", e);
  }
}

// --- Public sync getters (read from cache) ---

function dbGetTrades() { return _cache.trades; }
function dbGetKeeperSelections() { return _cache.keeperSel; }
function dbGetDraft() { return _cache.draft; }
function dbGetRule5() { return _cache.rule5; }
function dbGetCallupOverrides() { return _cache.callup; }
function dbGetCommishOverrides() { return _cache.commishOverrides; }
function dbGetWorkaroundOverrides() { return _cache.workaroundOverrides; }

// --- Public async writers ---

// All writers do an optimistic cache update first so the UI is instantly
// up to date, then send to Supabase. On failure, alert and revert.

async function addTradeAsync(trade) {
  const tempId = "temp-" + Math.random().toString(36).slice(2);
  _cache.trades.push({ ...trade, _id: tempId });
  try {
    const { data, error } = await supabaseClient.from("trades").insert({
      date: trade.date,
      team1: trade.team1,
      team2: trade.team2,
      team1_receives: trade.team1Receives || [],
      team2_receives: trade.team2Receives || [],
      notes: trade.notes || "",
    }).select().single();
    if (error) throw error;
    const idx = _cache.trades.findIndex(t => t._id === tempId);
    if (idx !== -1) _cache.trades[idx] = _rowToTrade(data);
    return data.id;
  } catch (e) {
    _cache.trades = _cache.trades.filter(t => t._id !== tempId);
    throw e;
  }
}

async function deleteTradeAsync(id) {
  const idx = _cache.trades.findIndex(t => t._id === id);
  const removed = idx !== -1 ? _cache.trades[idx] : null;
  if (idx !== -1) _cache.trades.splice(idx, 1);
  try {
    const { error } = await supabaseClient.from("trades").delete().eq("id", id);
    if (error) throw error;
  } catch (e) {
    if (removed && idx !== -1) _cache.trades.splice(idx, 0, removed);
    throw e;
  }
}

async function setKeeperSelectionAsync(teamId, playerName, flags) {
  const allEmpty = !flags.keeper && !flags.minorKeeper && !flags.rule5 && !flags.tradeBlock;
  const prev = _cache.keeperSel[teamId]?.[playerName];

  if (allEmpty) {
    if (_cache.keeperSel[teamId]) delete _cache.keeperSel[teamId][playerName];
  } else {
    if (!_cache.keeperSel[teamId]) _cache.keeperSel[teamId] = {};
    _cache.keeperSel[teamId][playerName] = { ...flags };
  }

  try {
    if (allEmpty) {
      const { error } = await supabaseClient.from("keeper_selections")
        .delete()
        .eq("team_id", teamId)
        .eq("player_name", playerName);
      if (error) throw error;
    } else {
      const { error } = await supabaseClient.from("keeper_selections").upsert({
        team_id: teamId,
        player_name: playerName,
        keeper: !!flags.keeper,
        minor_keeper: !!flags.minorKeeper,
        rule5: !!flags.rule5,
        trade_block: !!flags.tradeBlock,
      });
      if (error) throw error;
    }
  } catch (e) {
    if (prev) {
      if (!_cache.keeperSel[teamId]) _cache.keeperSel[teamId] = {};
      _cache.keeperSel[teamId][playerName] = prev;
    } else if (_cache.keeperSel[teamId]) {
      delete _cache.keeperSel[teamId][playerName];
    }
    throw e;
  }
}

async function _saveLeagueStateAsync(key, state, cacheField) {
  const prev = _cache[cacheField];
  _cache[cacheField] = state;
  try {
    const { error } = await supabaseClient.from("league_state").upsert({ key, state });
    if (error) throw error;
  } catch (e) {
    _cache[cacheField] = prev;
    throw e;
  }
}

async function saveDraftAsync(draft)            { return _saveLeagueStateAsync("draft_2027", draft, "draft"); }
async function saveRule5Async(state)            { return _saveLeagueStateAsync("rule5", state, "rule5"); }
async function saveCommishOverridesAsync(map)   { return _saveLeagueStateAsync("commish_overrides", map, "commishOverrides"); }
async function saveWorkaroundOverridesAsync(m)  { return _saveLeagueStateAsync("workaround_overrides", m, "workaroundOverrides"); }

async function saveCallupOverrideAsync(playerName, price, year) {
  const prev = _cache.callup[playerName];
  _cache.callup[playerName] = { price, year };
  try {
    const { error } = await supabaseClient.from("callup_overrides")
      .upsert({ player_name: playerName, price, year });
    if (error) throw error;
  } catch (e) {
    if (prev) _cache.callup[playerName] = prev;
    else delete _cache.callup[playerName];
    throw e;
  }
}

// Hook into the auth state listener exposed by supabase-client.js so the DB
// loads as soon as the user is identified as an owner.
if (typeof onAuthChange === "function") {
  onAuthChange((user, owner) => {
    if (owner) initDb();
    else { _dbReady = false; }
  });
}
