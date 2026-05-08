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
  activity: [],        // array of { id, type, actor_team_id, target_team_id, payload, created_at }
};
let _dbReady = false;
const _readyListeners = [];

function onDbReady(fn) {
  if (_dbReady) { try { fn(); } catch (e) { console.error(e); } return; }
  _readyListeners.push(fn);
}

async function _fetchAll() {
  const [trades, ks, ls, co, act] = await Promise.all([
    supabaseClient.from("trades").select("*").order("created_at", { ascending: true }),
    supabaseClient.from("keeper_selections").select("*"),
    supabaseClient.from("league_state").select("*"),
    supabaseClient.from("callup_overrides").select("*"),
    supabaseClient.from("activity_log").select("*").order("created_at", { ascending: false }).limit(200),
  ]);
  // Surface query errors so a transient network/RLS issue doesn't silently
  // wipe the UI to empty caches. Each table is independent — we still load
  // whatever did succeed.
  const _surface = (label, res) => {
    if (res.error) {
      const msg = `${label} fetch failed: ${res.error.message || res.error}`;
      console.warn(msg);
      if (typeof showToast === "function") showToast(msg, "warn");
    }
  };
  _surface("trades", trades);
  _surface("keeper_selections", ks);
  _surface("league_state", ls);
  _surface("callup_overrides", co);
  _surface("activity_log", act);
  _cache.activity = act.data || [];

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
  if (localStorage.getItem("flm_migrated_v1") === "true") return;
  // Only commissioners can write rows that touch other teams. Non-commish
  // users' inserts silently RLS-reject; flag the migration done for them
  // without attempting the writes.
  if (!currentOwner || !currentOwner.is_commissioner) {
    localStorage.setItem("flm_migrated_v1", "true");
    return;
  }
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
    localStorage.setItem("flm_migrated_v1", "true");
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

let _realtimeChannel = null;

function _subscribeToChanges() {
  if (_realtimeChannel) return;
  // Listen for trades / keeper_selections / league_state changes from other
  // users and refresh the cache + UI. Skip the re-render if the user is mid-
  // typing in a form (we don't want to wipe their input on echo).
  const refresh = async () => {
    await _fetchAll();
    const ae = document.activeElement;
    const userIsTyping = ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT" || ae.isContentEditable);
    if (userIsTyping) return;
    if (typeof switchTab !== "function" || typeof currentView === "undefined") return;
    // Skip refreshing the trades tab when the New Trade form is open — would wipe queued assets.
    if (currentView === "trades" && document.getElementById("trade-form-container")?.children.length) return;
    // Skip the open Pick Editor / Commish Editor modals.
    if (document.getElementById("pick-editor-modal") || document.getElementById("commish-editor-modal")) return;
    switchTab(currentView);
  };
  try {
    _realtimeChannel = supabaseClient.channel("league-data")
      .on("postgres_changes", { event: "*", schema: "public", table: "trades" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "keeper_selections" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "league_state" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "callup_overrides" }, refresh)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "activity_log" }, async () => {
        await _fetchAll();
        if (typeof currentView !== "undefined" && currentView === "activity" && typeof switchTab === "function") {
          switchTab("activity");
        }
      })
      // Watch the current user's owners row so promotion/demotion to/from
      // commissioner takes effect without a reload.
      .on("postgres_changes",
        { event: "*", schema: "public", table: "owners", filter: `id=eq.${currentUser.id}` },
        async () => {
          if (typeof fetchOwnerRow !== "function" || !currentUser) return;
          const fresh = await fetchOwnerRow(currentUser.id);
          if (fresh) currentOwner = fresh;
          if (typeof fireAuthChange === "function") fireAuthChange();
          if (typeof switchTab === "function" && typeof currentView !== "undefined") switchTab(currentView);
        }
      );
    _realtimeChannel.subscribe();
  } catch (e) {
    console.warn("Realtime subscribe failed:", e);
  }

  _setupPresence();
}

function _resetDb() {
  // Tear down everything when the user signs out (or switches accounts).
  try { _realtimeChannel?.unsubscribe(); } catch {}
  try { _presenceChannel?.unsubscribe(); } catch {}
  try { supabaseClient.removeAllChannels(); } catch {}
  _realtimeChannel = null;
  _presenceChannel = null;
  _onlineTeams = [];
  _firePresence();
  _cache.trades = [];
  _cache.keeperSel = {};
  _cache.draft = null;
  _cache.rule5 = null;
  _cache.callup = {};
  _cache.commishOverrides = {};
  _cache.workaroundOverrides = {};
  _cache.activity = [];
  _dbReady = false;
}

// --- Realtime presence: who else is on the site right now ---

let _presenceChannel = null;
let _onlineTeams = [];          // [{ teamId, teamName, isCommissioner }]
const _presenceListeners = [];

function onPresenceChange(fn) {
  _presenceListeners.push(fn);
  fn(_onlineTeams);
}

function _firePresence() {
  _presenceListeners.forEach(fn => { try { fn(_onlineTeams); } catch (e) { console.error(e); } });
}

function _setupPresence() {
  if (_presenceChannel) return;
  if (typeof currentUser === "undefined" || !currentUser || !currentOwner) return;
  const team = LEAGUE_DATA.teams.find(t => t.id === currentOwner.team_id);
  const payload = {
    user_id: currentUser.id,
    team_id: currentOwner.team_id,
    team_name: team ? team.name : currentOwner.team_id,
    is_commissioner: !!currentOwner.is_commissioner,
    joined_at: new Date().toISOString(),
  };

  _presenceChannel = supabaseClient.channel("presence-online", {
    config: { presence: { key: currentUser.id } },
  });

  const sync = () => {
    const state = _presenceChannel.presenceState();
    const seen = new Map();
    Object.values(state).flat().forEach(p => {
      if (!p || !p.team_id) return;
      // De-dupe: one card per team_id even if multiple tabs.
      if (!seen.has(p.team_id)) {
        seen.set(p.team_id, {
          teamId: p.team_id,
          teamName: p.team_name,
          isCommissioner: !!p.is_commissioner,
        });
      }
    });
    _onlineTeams = Array.from(seen.values()).sort((a, b) => a.teamName.localeCompare(b.teamName));
    _firePresence();
  };

  _presenceChannel
    .on("presence", { event: "sync" }, sync)
    .on("presence", { event: "join" }, sync)
    .on("presence", { event: "leave" }, sync)
    .subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        try { await _presenceChannel.track(payload); } catch (e) { console.warn("presence track error:", e); }
      }
    });
}

function dbGetOnlineTeams() { return _onlineTeams; }

// --- Public sync getters (read from cache) ---

// Cache snapshots — return a deep-clone for any structure callers might
// mutate, so in-place edits don't corrupt the cache and a write-failure
// rollback can actually restore the prior state.
function _clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
function dbGetTrades() { return _cache.trades; }                // arrays of records, read-only
function dbGetKeeperSelections() { return _clone(_cache.keeperSel); }
function dbGetDraft() { return _clone(_cache.draft); }
function dbGetRule5() { return _clone(_cache.rule5); }
function dbGetCallupOverrides() { return _clone(_cache.callup); }
function dbGetCommishOverrides() { return _clone(_cache.commishOverrides); }
function dbGetWorkaroundOverrides() { return _clone(_cache.workaroundOverrides); }
function dbGetActivity() { return _cache.activity; }            // read-only

// Append-only logger; never throws (activity logging shouldn't break UX).
async function logActivityAsync(type, payload, opts) {
  if (typeof currentOwner === "undefined" || !currentOwner) return;
  const row = {
    type,
    actor_team_id: currentOwner.team_id,
    target_team_id: (opts && opts.targetTeamId) || currentOwner.team_id,
    payload: payload || {},
  };
  try {
    const { data, error } = await supabaseClient.from("activity_log").insert(row).select().single();
    if (error) throw error;
    _cache.activity.unshift(data);
    if (_cache.activity.length > 200) _cache.activity.length = 200;
  } catch (e) {
    const msg = `Activity log failed (${type}): ${e?.message || e}`;
    console.warn(msg);
    if (typeof showToast === "function") showToast(msg, "warn");
  }
}

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
    if (_cache.keeperSel[teamId]) {
      delete _cache.keeperSel[teamId][playerName];
      if (!Object.keys(_cache.keeperSel[teamId]).length) delete _cache.keeperSel[teamId];
    }
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
  // The league_state.state column is NOT NULL, so a "reset" deletes the row
  // rather than upserting null.
  const isReset = state === null || state === undefined;
  _cache[cacheField] = isReset ? null : state;
  try {
    if (isReset) {
      const { error } = await supabaseClient.from("league_state").delete().eq("key", key);
      if (error) throw error;
    } else {
      const { error } = await supabaseClient.from("league_state").upsert({ key, state });
      if (error) throw error;
    }
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
    else _resetDb();
  });
}
