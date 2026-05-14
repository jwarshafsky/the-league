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
  proposals: [],       // array of trade_proposals rows (raw)
  messages: [],        // array of trade_proposal_messages rows (raw)
  keeperDeadline: null,// { at: ISO string } | null — past `at`, non-commish keeper toggles are blocked
  rosterMoves: [],     // [{ kind: "callup" | "demote", player_name, team_id, year?, at }]
  constitution: null,  // string (markdown) | null — commish-editable league rules
  settings: {},        // { currentSeason?, enforceRule5RosterSpot?, enforceMinorsRosterSpot? }
  feesPaid: {},        // { teamId: { league: bool, callup: bool } }
  keeperPriceExceptions: {}, // { playerName: truePrice } — overrides ESPN-displayed price
  notifyPrefs: {},     // { teamId: { prefs: {...}, receive_all, email } }
  pushSubs: [],        // [{ id, team_id, user_id, endpoint, ... }]
  leagueMessages: [],  // [{ id, team_id, user_id, body, created_at }]
  customProspects: [], // string[] — names typed during minors picks; shared league-wide via league_state
  espnSyncStatus: {},  // { lastSuccessAt, lastFailureAt, lastError, pushedAt } — set by the ESPN sync workflow
  pgCronHeartbeat: {}, // { lastFiredAt, lastWorkflow } — set by Supabase pg_cron jobs
  keyDates: {},        // { rule5_deadline, rule5_draft, keeper_deadline, auction_draft, minors_draft, trade_deadline } — ISO date strings
  activeVotes: [],     // [{ id, title, description, opens_at, closes_at, options }, ...] — multiple concurrent votes supported
};
// Cross-conversation read state for the trade inbox: { threadId: lastReadAt }.
// Anything in the thread newer than lastReadAt counts as unread (covers BOTH
// new proposals/counters AND new messages from the other side).
const TRADE_INBOX_READ_KEY = "flm_trade_inbox_read_v2";
function _getThreadReadTimes() {
  try { return JSON.parse(localStorage.getItem(TRADE_INBOX_READ_KEY) || "{}"); }
  catch { return {}; }
}
function _saveThreadReadTimes(map) {
  try { localStorage.setItem(TRADE_INBOX_READ_KEY, JSON.stringify(map)); } catch {}
}
// Read state lives in notification_prefs.prefs.inboxReads (server-side, syncs
// across the user's devices via realtime) AND in localStorage as a fast path
// (used by the next render before the server write round-trips). The server
// is the source of truth for cross-device freshness.
function dbMarkThreadRead(threadId) {
  const now = new Date().toISOString();
  // 1. Immediate local update so this device's badge clears without waiting.
  const map = _getThreadReadTimes();
  map[threadId] = now;
  _saveThreadReadTimes(map);
  // 2. Update the in-memory cache so dbGetThreadLastReadMs sees it instantly,
  //    then push to server. If the cache row is missing (notification_prefs
  //    fetch errored or user has never had a row), fetch the existing row
  //    from the server FIRST — otherwise our default-fallback would PUT
  //    receive_all=false back over a real receive_all=true.
  if (typeof currentOwner !== "undefined" && currentOwner) {
    const teamId = currentOwner.team_id;
    const cached = _cache.notifyPrefs[teamId];
    if (cached) {
      if (!cached.prefs.inboxReads) cached.prefs.inboxReads = {};
      cached.prefs.inboxReads[threadId] = now;
      _pushNotifyPrefsBackground(teamId, cached);
    } else {
      _markThreadReadAsync(teamId, threadId, now).catch(e =>
        console.warn("inbox-read async sync failed:", e));
    }
  }
}

// Fetch the current notification_prefs row from the server, merge in the new
// inboxReads timestamp, and write it back. Used when the in-memory cache row
// is missing — avoids clobbering receive_all / email with our defaults.
async function _markThreadReadAsync(teamId, threadId, nowIso) {
  const { data, error } = await supabaseClient
    .from("notification_prefs")
    .select("*")
    .eq("team_id", teamId)
    .maybeSingle();
  if (error) throw error;
  const row = data
    ? { prefs: data.prefs || {}, receiveAll: !!data.receive_all, email: data.email || null }
    : { prefs: {}, receiveAll: false, email: null };
  if (!row.prefs.inboxReads) row.prefs.inboxReads = {};
  row.prefs.inboxReads[threadId] = nowIso;
  _cache.notifyPrefs[teamId] = row;
  await _pushNotifyPrefsBackground(teamId, row);
}

function _pushNotifyPrefsBackground(teamId, row) {
  if (typeof saveNotifyPrefsAsync !== "function") return Promise.resolve();
  return saveNotifyPrefsAsync({
    teamId,
    prefs: row.prefs,
    receiveAll: row.receiveAll,
    email: row.email || ((typeof currentUser !== "undefined" && currentUser) ? currentUser.email : null),
  }).catch(e => console.warn("notification-prefs sync failed:", e));
}

// Message-board read tracking — same shape as thread reads. Writes both
// localStorage (immediate) and notification_prefs.prefs.msgBoardLastSeen
// (cross-device). Reads return max of both so a fresh read on either device
// always wins.
const MSGBOARD_LAST_SEEN_KEY = "flm_msgboard_last_seen";
function dbGetMsgBoardLastSeenMs() {
  let localMs = 0;
  try { localMs = parseInt(localStorage.getItem(MSGBOARD_LAST_SEEN_KEY) || "0", 10) || 0; } catch {}
  let serverMs = 0;
  if (typeof currentOwner !== "undefined" && currentOwner) {
    const ts = _cache.notifyPrefs[currentOwner.team_id]?.prefs?.msgBoardLastSeen;
    if (ts) serverMs = new Date(ts).getTime();
  }
  return Math.max(localMs, serverMs);
}
function dbMarkMsgBoardSeen() {
  const now = Date.now();
  try { localStorage.setItem(MSGBOARD_LAST_SEEN_KEY, String(now)); } catch {}
  if (typeof currentOwner === "undefined" || !currentOwner) return;
  const teamId = currentOwner.team_id;
  const nowIso = new Date(now).toISOString();
  const cached = _cache.notifyPrefs[teamId];
  if (cached) {
    cached.prefs.msgBoardLastSeen = nowIso;
    _pushNotifyPrefsBackground(teamId, cached);
  } else {
    _markMsgBoardSeenAsync(teamId, nowIso).catch(e =>
      console.warn("msgboard-seen async sync failed:", e));
  }
}
async function _markMsgBoardSeenAsync(teamId, nowIso) {
  const { data, error } = await supabaseClient
    .from("notification_prefs")
    .select("*")
    .eq("team_id", teamId)
    .maybeSingle();
  if (error) throw error;
  const row = data
    ? { prefs: data.prefs || {}, receiveAll: !!data.receive_all, email: data.email || null }
    : { prefs: {}, receiveAll: false, email: null };
  row.prefs.msgBoardLastSeen = nowIso;
  _cache.notifyPrefs[teamId] = row;
  await _pushNotifyPrefsBackground(teamId, row);
}
function dbGetThreadLastReadMs(threadId) {
  // Take the max of localStorage and server. Server alone isn't safe — if a
  // realtime _fetchAll runs between dbMarkThreadRead's local write and its
  // server write, the cache reloads the OLD server value and the badge
  // re-appears. Local alone misses cross-device. max() handles both.
  let localMs = 0;
  const v = _getThreadReadTimes()[threadId];
  if (v) localMs = new Date(v).getTime();
  let serverMs = 0;
  if (typeof currentOwner !== "undefined" && currentOwner) {
    const serverTs = _cache.notifyPrefs[currentOwner.team_id]?.prefs?.inboxReads?.[threadId];
    if (serverTs) serverMs = new Date(serverTs).getTime();
  }
  return Math.max(localMs, serverMs);
}
// True if there's at least one unread item (proposal or message from someone
// else) in this thread for the current owner.
function dbThreadHasUnread(thread) {
  if (typeof currentOwner === "undefined" || !currentOwner) return false;
  const myTeam = currentOwner.team_id;
  const lastRead = dbGetThreadLastReadMs(thread.threadId);
  for (const p of thread.proposals) {
    if (p.status === "pending" && p.to_team_id === myTeam && new Date(p.created_at).getTime() > lastRead) return true;
  }
  for (const m of thread.messages) {
    if (m.from_team_id !== myTeam && new Date(m.created_at).getTime() > lastRead) return true;
  }
  return false;
}
// Back-compat for old call sites that just want "has the user ever opened this thread".
function dbIsThreadRead(threadId) { return dbGetThreadLastReadMs(threadId) > 0; }
let _dbReady = false;
const _readyListeners = [];

function onDbReady(fn) {
  if (_dbReady) { try { fn(); } catch (e) { console.error(e); } return; }
  _readyListeners.push(fn);
}

async function _fetchAll() {
  const [trades, ks, ls, co, act, props, msgs, rm, np, ps, lm] = await Promise.all([
    supabaseClient.from("trades").select("*").order("created_at", { ascending: true }),
    supabaseClient.from("keeper_selections").select("*"),
    supabaseClient.from("league_state").select("*"),
    supabaseClient.from("callup_overrides").select("*"),
    supabaseClient.from("activity_log").select("*").order("created_at", { ascending: false }).limit(200),
    supabaseClient.from("trade_proposals").select("*").order("created_at", { ascending: false }),
    supabaseClient.from("trade_proposal_messages").select("*").order("created_at", { ascending: true }),
    supabaseClient.from("roster_moves").select("*").order("at", { ascending: true }),
    supabaseClient.from("notification_prefs").select("*"),
    supabaseClient.from("push_subscriptions").select("*"),
    supabaseClient.from("league_messages").select("*").order("created_at", { ascending: true }).limit(500),
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
  // Same as _surface, but only logs to the console — no toast. Use for tables
  // whose absence is expected during partial rollouts (e.g. before the
  // commissioner has run the SQL to create new tables).
  const _surfaceQuiet = (label, res) => {
    if (res.error) console.warn(`${label} fetch skipped: ${res.error.message || res.error}`);
  };
  _surface("trades", trades);
  _surface("keeper_selections", ks);
  _surface("league_state", ls);
  _surface("callup_overrides", co);
  _surface("activity_log", act);
  _surface("trade_proposals", props);
  _surface("trade_proposal_messages", msgs);
  _surface("roster_moves", rm);
  // notification_prefs and push_subscriptions are optional — they only exist
  // after the commissioner runs the schema additions for the notifications
  // feature. If they don't exist yet, the query returns a 'relation does not
  // exist' error from PostgREST; log it quietly but don't toast users.
  _surfaceQuiet("notification_prefs", np);
  _surfaceQuiet("push_subscriptions", ps);
  _surfaceQuiet("league_messages", lm);
  _cache.leagueMessages = lm.data || [];
  _cache.notifyPrefs = {};
  for (const r of (np.data || [])) {
    _cache.notifyPrefs[r.team_id] = {
      prefs: r.prefs || {},
      receiveAll: !!r.receive_all,
      email: r.email || null,
    };
  }
  _cache.pushSubs = ps.data || [];
  _cache.activity = act.data || [];
  _cache.proposals = props.data || [];
  _cache.messages = msgs.data || [];
  _cache.rosterMoves = rm.data || [];

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
  _cache.keeperDeadline = null;
  _cache.constitution = null;
  _cache.settings = {};
  _cache.feesPaid = {};
  _cache.keeperPriceExceptions = {};
  // NOTE: do NOT reset _cache.rosterMoves here — it's already populated above
  // from the dedicated roster_moves table. A leftover reset from when this
  // data lived in league_state was the cause of a bug where send-downs
  // appeared to work in the DB but never moved the player in the UI.
  for (const r of (ls.data || [])) {
    if (r.key === "draft_2027") _cache.draft = r.state;
    else if (r.key === "rule5") _cache.rule5 = r.state;
    else if (r.key === "commish_overrides") _cache.commishOverrides = r.state || {};
    else if (r.key === "workaround_overrides") _cache.workaroundOverrides = r.state || {};
    else if (r.key === "keeper_deadline") _cache.keeperDeadline = r.state;
    else if (r.key === "constitution") _cache.constitution = (r.state && r.state.markdown) || null;
    else if (r.key === "settings") _cache.settings = r.state || {};
    else if (r.key === "fees_paid") _cache.feesPaid = r.state || {};
    else if (r.key === "keeper_price_exceptions") _cache.keeperPriceExceptions = r.state || {};
    else if (r.key === "custom_prospects") _cache.customProspects = Array.isArray(r.state) ? r.state : (r.state?.names || []);
    else if (r.key === "espn_sync_status") _cache.espnSyncStatus = r.state || {};
    else if (r.key === "pg_cron_heartbeat") _cache.pgCronHeartbeat = r.state || {};
    else if (r.key === "key_dates") _cache.keyDates = r.state || {};
    else if (r.key === "active_vote") {
      // Schema migration: older rows stored a single object; new format is
      // an array. Accept both on read so a paste-in upgrade is seamless.
      if (Array.isArray(r.state)) _cache.activeVotes = r.state;
      else if (r.state && typeof r.state === "object" && r.state.id) _cache.activeVotes = [r.state];
      else _cache.activeVotes = [];
    }
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
    createdAt: r.created_at,
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
  // typing in a form or has a modal open (we don't want to wipe their work
  // on a realtime echo) — but DON'T drop the refresh entirely; flag it as
  // pending and re-attempt every few seconds until the user goes idle.
  let _refreshTimer = null;
  let _refreshDeferred = false;
  let _refreshRetryTimer = null;

  const _isUserBusy = () => {
    const ae = document.activeElement;
    const typing = ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT" || ae.isContentEditable);
    if (typing) return true;
    if (typeof currentView !== "undefined" && currentView === "trades"
        && document.getElementById("trade-form-container")?.children.length) return true;
    if (document.getElementById("pick-editor-modal")
        || document.getElementById("commish-editor-modal")) return true;
    return false;
  };

  const _applyBodyRefresh = () => {
    if (typeof switchTab !== "function" || typeof currentView === "undefined") return false;
    if (_isUserBusy()) return false;
    switchTab(currentView);
    return true;
  };

  const _scheduleRetry = () => {
    if (_refreshRetryTimer) return;
    _refreshRetryTimer = setTimeout(() => {
      _refreshRetryTimer = null;
      if (!_refreshDeferred) return;
      if (_applyBodyRefresh()) _refreshDeferred = false;
      else _scheduleRetry(); // still busy — try again in a few seconds
    }, 4000);
  };

  const refresh = () => {
    if (_refreshTimer) return;
    _refreshTimer = setTimeout(async () => {
      _refreshTimer = null;
      await _fetchAll();
      // Always re-render the header so the ESPN sync banner / online dot /
      // unread badges refresh even if we don't re-render the body.
      if (typeof renderHeaderUser === "function") renderHeaderUser();
      // Any realtime change is a candidate for auto-sync to Google Sheets.
      // The schedule helper rate-limits + debounces so rapid changes batch.
      if (typeof autoSyncSheetsScheduleSoon === "function") autoSyncSheetsScheduleSoon("realtime");
      if (!_applyBodyRefresh()) {
        _refreshDeferred = true;
        _scheduleRetry();
      } else {
        _refreshDeferred = false;
      }
    }, 150);
  };
  try {
    _realtimeChannel = supabaseClient.channel("league-data")
      .on("postgres_changes", { event: "*", schema: "public", table: "trades" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "keeper_selections" }, refresh)
      // league_state covers draft / rule5 transitions — re-check whether the
      // user's team has just entered an on-clock / on-deck / in-hole slot
      // after every refresh.
      .on("postgres_changes", { event: "*", schema: "public", table: "league_state" }, async (...args) => {
        await refresh(...args);
        if (typeof window !== "undefined" && typeof window._handleDraftToasts === "function") {
          window._handleDraftToasts();
        }
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "callup_overrides" }, refresh)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "activity_log" }, async (payload) => {
        await _fetchAll();
        // Fire an in-app toast for the newly-inserted row before the view
        // re-renders, so the user sees it even if they're not on Activity.
        if (typeof window !== "undefined" && typeof window._handleActivityToast === "function") {
          try { window._handleActivityToast(payload?.new); } catch (e) { console.warn("activity toast failed:", e); }
        }
        if (typeof currentView !== "undefined" && currentView === "activity" && typeof switchTab === "function") {
          switchTab("activity");
        }
      })
      // Trade-inbox traffic (proposals + messages). Re-fetch on any change
      // and re-render whichever inbox view is active. Header badge updates
      // via the standard auth-change broadcast.
      .on("postgres_changes", { event: "*", schema: "public", table: "trade_proposals" }, async () => {
        await _fetchAll();
        const ae = document.activeElement;
        const userIsTyping = ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT" || ae.isContentEditable);
        if (typeof renderHeaderUser === "function") renderHeaderUser();
        if (userIsTyping) return;
        if (typeof currentView !== "undefined" && currentView === "trades" && typeof renderTradesShell === "function") {
          renderTradesShell();
        }
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "roster_moves" }, async () => {
        await _fetchAll();
        const ae = document.activeElement;
        const userIsTyping = ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT" || ae.isContentEditable);
        if (userIsTyping) return;
        if (document.getElementById("pick-editor-modal") || document.getElementById("commish-editor-modal")) return;
        if (typeof _refreshAfterRosterMove === "function") _refreshAfterRosterMove();
        else if (typeof switchTab === "function" && typeof currentView !== "undefined") switchTab(currentView);
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "trade_proposal_messages" }, async () => {
        await _fetchAll();
        // Always update the badge regardless of which tab/sub-tab the user is
        // on — otherwise the Trades nav count goes stale on mobile (the only
        // visible badge until you open the drawer).
        if (typeof renderHeaderUser === "function") renderHeaderUser();
        const ae = document.activeElement;
        const userIsTyping = ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT" || ae.isContentEditable);
        if (userIsTyping) return;
        if (typeof currentView !== "undefined" && currentView === "trades" && typeof renderTradesShell === "function") {
          renderTradesShell();
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
      )
      // notification_prefs — re-fetch so the inbox-read state (stored in
      // prefs.inboxReads) propagates across devices. Re-renders the header
      // badge so the Trades count clears on iOS when read on desktop.
      .on("postgres_changes",
        { event: "*", schema: "public", table: "notification_prefs" },
        async () => {
          await _fetchAll();
          if (typeof renderHeaderUser === "function") renderHeaderUser();
        }
      )
      // league_votes — commissioners get realtime ballots as they come in
      // (RLS naturally hides this stream from non-commish). Used to drive
      // the running-tally view + a "new vote received" toast for commish.
      .on("postgres_changes",
        { event: "*", schema: "public", table: "league_votes" },
        async (payload) => {
          if (typeof window !== "undefined" && typeof window._handleVoteCast === "function") {
            try { window._handleVoteCast(payload?.new || payload?.old); } catch (e) { console.warn("vote toast failed:", e); }
          }
          if (typeof currentView !== "undefined" && currentView === "rules" && typeof switchTab === "function") {
            switchTab("rules");
          } else if (typeof currentView !== "undefined" && currentView === "settings" && typeof switchTab === "function") {
            switchTab("settings");
          }
        }
      )
      // league_messages — refresh the in-memory cache and re-render the
      // board if open so messages from other teams appear without polling.
      .on("postgres_changes",
        { event: "*", schema: "public", table: "league_messages" },
        async () => {
          await _fetchAll();
          if (typeof _renderMessageBoard === "function") _renderMessageBoard();
          if (typeof renderHeaderUser === "function") renderHeaderUser();
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
  _cache.proposals = [];
  _cache.messages = [];
  _cache.leagueMessages = [];
  _cache.espnSyncStatus = {};
  _cache.pgCronHeartbeat = {};
  _cache.keeperDeadline = null;
  _cache.rosterMoves = [];
  _cache.keyDates = {};
  _cache.activeVotes = [];
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
function dbGetSettings() { return _clone(_cache.settings || {}); }
function dbGetFeesPaid() { return _clone(_cache.feesPaid || {}); }
function dbGetKeeperPriceExceptions() { return _clone(_cache.keeperPriceExceptions || {}); }
function dbGetNotifyPrefs(teamId) {
  const row = (_cache.notifyPrefs || {})[teamId];
  return row ? _clone(row) : null;
}
function dbGetAllNotifyPrefs() { return _clone(_cache.notifyPrefs || {}); }
function dbGetPushSubs() { return _clone(_cache.pushSubs || []); }
function dbCountMyPushSubs() {
  if (typeof currentUser === "undefined" || !currentUser) return 0;
  return (_cache.pushSubs || []).filter(s => s.user_id === currentUser.id).length;
}
function dbHasPushSubForEndpoint(endpoint) {
  return (_cache.pushSubs || []).some(s => s.endpoint === endpoint);
}
function dbGetMessages() { return _clone(_cache.leagueMessages || []); }

async function postMessageAsync(body) {
  if (typeof currentOwner === "undefined" || !currentOwner) throw new Error("Sign in to post");
  const trimmed = (body || "").trim();
  if (!trimmed) throw new Error("Empty message");
  if (trimmed.length > 1000) throw new Error("Message too long (1000 char max)");
  const row = {
    team_id: currentOwner.team_id,
    user_id: currentUser ? currentUser.id : null,
    body: trimmed,
  };
  const { data, error } = await supabaseClient.from("league_messages").insert(row).select().single();
  if (error) throw error;
  _cache.leagueMessages = [...(_cache.leagueMessages || []), data];
  return data;
}

async function deleteMessageAsync(id) {
  const { error } = await supabaseClient.from("league_messages").delete().eq("id", id);
  if (error) throw error;
  _cache.leagueMessages = (_cache.leagueMessages || []).filter(m => m.id !== id);
}

async function clearAllMessagesAsync() {
  const { error } = await supabaseClient.from("league_messages").delete().not("id", "is", null);
  if (error) throw error;
  _cache.leagueMessages = [];
}
function dbGetActivity() { return _cache.activity; }            // read-only
function dbGetProposals() { return _cache.proposals; }          // read-only

// Group proposals into threads. Returns array of { threadId, proposals[],
// messages[], latestProposal, lastActivityAt }, sorted by lastActivityAt
// descending (most recent first).
function dbGetThreads() {
  const props = _cache.proposals || [];
  const msgs = _cache.messages || [];
  const byThread = {};
  for (const p of props) {
    if (!byThread[p.thread_id]) byThread[p.thread_id] = { threadId: p.thread_id, proposals: [], messages: [] };
    byThread[p.thread_id].proposals.push(p);
  }
  for (const m of msgs) {
    if (!byThread[m.thread_id]) continue; // orphan message — skip
    byThread[m.thread_id].messages.push(m);
  }
  const threads = Object.values(byThread).map(t => {
    t.proposals.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    t.messages.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    t.latestProposal = t.proposals[t.proposals.length - 1];
    const propAt = new Date(t.latestProposal.updated_at || t.latestProposal.created_at).getTime();
    const msgAt = t.messages.length ? new Date(t.messages[t.messages.length - 1].created_at).getTime() : 0;
    t.lastActivityAt = Math.max(propAt, msgAt);
    return t;
  });
  threads.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return threads;
}

// Unread inbox totals for the current owner — split into proposals (new
// pending offers to you) and messages (new chats from someone else), plus a
// `total` for the badge. Both are bounded by per-thread lastReadAt so opening
// a thread clears its share of each bucket.
function dbGetUnreadCounts() {
  if (typeof currentOwner === "undefined" || !currentOwner) return { proposals: 0, messages: 0, total: 0 };
  const myTeam = currentOwner.team_id;
  const threads = dbGetThreads();
  let proposals = 0, messages = 0;
  for (const t of threads) {
    const lastRead = dbGetThreadLastReadMs(t.threadId);
    const wasParty = t.proposals.some(p => p.from_team_id === myTeam || p.to_team_id === myTeam);
    if (!wasParty) continue;
    for (const p of t.proposals) {
      if (p.status === "pending" && p.to_team_id === myTeam && new Date(p.created_at).getTime() > lastRead) proposals += 1;
    }
    for (const m of t.messages) {
      if (m.from_team_id !== myTeam && new Date(m.created_at).getTime() > lastRead) messages += 1;
    }
  }
  return { proposals, messages, total: proposals + messages };
}
// Legacy alias still used in places — keep returning the total for compat.
function dbGetInboxUnreadCount() { return dbGetUnreadCounts().total; }

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

async function editTradeAsync(id, fields) {
  // Apply optimistic local update first; revert on RPC error.
  // Re-find by id on rollback — _cache.trades may have been replaced by a
  // realtime _fetchAll() during the await, in which case the captured idx
  // would no longer point at this trade.
  const startIdx = _cache.trades.findIndex(t => t._id === id);
  const prev = startIdx !== -1 ? { ..._cache.trades[startIdx] } : null;
  if (prev) {
    _cache.trades[startIdx] = {
      ..._cache.trades[startIdx],
      team1: fields.team1 ?? prev.team1,
      team2: fields.team2 ?? prev.team2,
      team1Receives: fields.team1Receives ?? prev.team1Receives,
      team2Receives: fields.team2Receives ?? prev.team2Receives,
      notes: fields.notes ?? prev.notes,
    };
  }
  try {
    const { error } = await supabaseClient.from("trades").update({
      team1: fields.team1,
      team2: fields.team2,
      team1_receives: fields.team1Receives || [],
      team2_receives: fields.team2Receives || [],
      notes: fields.notes ?? "",
    }).eq("id", id);
    if (error) throw error;
  } catch (e) {
    if (prev) {
      const curIdx = _cache.trades.findIndex(t => t._id === id);
      if (curIdx !== -1) _cache.trades[curIdx] = prev;
      // If the trade is no longer in cache (realtime removed it), there's
      // nothing to restore — the server-side state is the source of truth.
    }
    throw e;
  }
}

async function deleteTradeAsync(id) {
  // Optimistic remove. On failure, re-find by id rather than relying on a
  // pre-await index — realtime may have changed _cache.trades positions.
  const idx = _cache.trades.findIndex(t => t._id === id);
  const removed = idx !== -1 ? _cache.trades[idx] : null;
  if (idx !== -1) _cache.trades.splice(idx, 1);
  try {
    const { error } = await supabaseClient.from("trades").delete().eq("id", id);
    if (error) throw error;
  } catch (e) {
    if (removed && !_cache.trades.some(t => t._id === id)) {
      // Re-add in original position if possible; else append (a later
      // realtime refresh will sort it correctly).
      const insertAt = Math.min(idx, _cache.trades.length);
      _cache.trades.splice(insertAt, 0, removed);
    }
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
async function saveKeeperDeadlineAsync(state)   { return _saveLeagueStateAsync("keeper_deadline", state, "keeperDeadline"); }
async function saveSettingsAsync(s)             { return _saveLeagueStateAsync("settings", s, "settings"); }
async function saveFeesPaidAsync(m)             { return _saveLeagueStateAsync("fees_paid", m, "feesPaid"); }
async function saveKeeperPriceExceptionsAsync(m){ return _saveLeagueStateAsync("keeper_price_exceptions", m, "keeperPriceExceptions"); }
async function saveCustomProspectsAsync(list)   { return _saveLeagueStateAsync("custom_prospects", list, "customProspects"); }
async function saveKeyDatesAsync(dates)         { return _saveLeagueStateAsync("key_dates", dates, "keyDates"); }
async function saveActiveVotesAsync(votes)      { return _saveLeagueStateAsync("active_vote", votes && votes.length ? votes : null, "activeVotes"); }
function dbGetKeyDates() { return _clone(_cache.keyDates || {}); }
function dbGetActiveVotes() { return _clone(_cache.activeVotes || []); }

// --- Co-manager invites (commissioner-only) ---

// Add an email→team_id mapping. When that user signs in, claim_invited_team()
// auto-creates their owners row. RLS limits this table to commissioners.
async function addInvitedEmailAsync(email, teamId, isCommish) {
  const norm = String(email || "").trim().toLowerCase();
  if (!norm || !teamId) throw new Error("email and team_id required");
  const { error } = await supabaseClient.from("invited_emails").upsert({
    email: norm,
    team_id: teamId,
    is_commissioner: !!isCommish,
  });
  if (error) throw error;
}

async function deleteInvitedEmailAsync(email) {
  const norm = String(email || "").trim().toLowerCase();
  if (!norm) return;
  const { error } = await supabaseClient.from("invited_emails").delete().eq("email", norm);
  if (error) throw error;
}

async function fetchInvitedEmailsAsync() {
  const { data, error } = await supabaseClient.from("invited_emails").select("*").order("team_id");
  if (error) throw error;
  return data || [];
}

// --- League votes ---

async function castVoteAsync(voteId, optionIndex) {
  if (!currentOwner) throw new Error("Not signed in");
  if (!currentUser) throw new Error("Not signed in");
  const { error } = await supabaseClient.from("league_votes").upsert({
    vote_id: voteId,
    team_id: currentOwner.team_id,
    option_index: optionIndex,
    user_id: currentUser.id,
  });
  if (error) throw error;
}

async function fetchMyVoteAsync(voteId) {
  if (!currentOwner) return null;
  const { data, error } = await supabaseClient.from("league_votes")
    .select("*").eq("vote_id", voteId).eq("team_id", currentOwner.team_id).maybeSingle();
  if (error) throw error;
  return data;
}

// Commissioners only — fetches every ballot for a vote. RLS allows this
// because the policy permits is_commissioner() to read all rows.
async function fetchAllVotesAsync(voteId) {
  const { data, error } = await supabaseClient.from("league_votes")
    .select("*").eq("vote_id", voteId);
  if (error) throw error;
  return data || [];
}
function dbGetCustomProspects() { return _cache.customProspects || []; }
function dbGetEspnSyncStatus() { return _clone(_cache.espnSyncStatus || {}); }
function dbGetPgCronHeartbeat() { return _clone(_cache.pgCronHeartbeat || {}); }

async function saveNotifyPrefsAsync({ teamId, prefs, receiveAll, email }) {
  if (!teamId) throw new Error("teamId required");
  const row = {
    team_id: teamId,
    prefs: prefs || {},
    receive_all: !!receiveAll,
    email: email || null,
  };
  // Optimistic cache update; revert on error.
  const prev = _cache.notifyPrefs[teamId];
  _cache.notifyPrefs[teamId] = { prefs: row.prefs, receiveAll: row.receive_all, email: row.email };
  try {
    const { error } = await supabaseClient.from("notification_prefs").upsert(row);
    if (error) throw error;
  } catch (e) {
    if (prev) _cache.notifyPrefs[teamId] = prev; else delete _cache.notifyPrefs[teamId];
    throw e;
  }
}

async function savePushSubscriptionAsync({ teamId, userId, endpoint, p256dh, authKey, userAgent }) {
  const row = {
    team_id: teamId,
    user_id: userId,
    endpoint, p256dh, auth_key: authKey,
    user_agent: userAgent || null,
  };
  const { data, error } = await supabaseClient.from("push_subscriptions").insert(row).select().single();
  if (error) throw error;
  _cache.pushSubs = [...(_cache.pushSubs || []), data];
  return data;
}

async function deletePushSubscriptionAsync(endpoint) {
  const { error } = await supabaseClient.from("push_subscriptions").delete().eq("endpoint", endpoint);
  if (error) throw error;
  _cache.pushSubs = (_cache.pushSubs || []).filter(s => s.endpoint !== endpoint);
}
async function saveConstitutionAsync(markdown) {
  const prev = _cache.constitution;
  _cache.constitution = markdown;
  try {
    if (markdown == null || markdown === "") {
      const { error } = await supabaseClient.from("league_state").delete().eq("key", "constitution");
      if (error) throw error;
    } else {
      const { error } = await supabaseClient.from("league_state").upsert({ key: "constitution", state: { markdown } });
      if (error) throw error;
    }
  } catch (e) {
    _cache.constitution = prev;
    throw e;
  }
}
function dbGetKeeperDeadline() { return _cache.keeperDeadline; }
function dbGetConstitution() { return _cache.constitution; }

// --- League state snapshots (rollback) ---
//
// A snapshot is a single league_state row keyed `snapshot_<timestamp>` whose
// `state` jsonb holds a full copy of every relevant table: trades,
// keeper_selections, callup_overrides, roster_moves, and the rest of
// league_state (excluding snapshot rows themselves). Restoring wipes the
// current data and re-inserts from the snapshot. RLS already restricts
// league_state writes to commissioners.

async function listLeagueSnapshotsAsync() {
  const { data, error } = await supabaseClient
    .from("league_state")
    .select("key, state, updated_at")
    .like("key", "snapshot_%")
    .order("key", { ascending: false });
  if (error) throw error;
  return (data || []).map(r => ({
    key: r.key,
    takenAt: r.state?.takenAt || r.updated_at,
    label: r.state?.label || "(no label)",
    counts: {
      trades: r.state?.data?.trades?.length || 0,
      keeperSel: r.state?.data?.keeperSel?.length || 0,
      leagueState: r.state?.data?.leagueState?.length || 0,
      callup: r.state?.data?.callup?.length || 0,
      rosterMoves: r.state?.data?.rosterMoves?.length || 0,
    },
  }));
}

async function takeLeagueSnapshotAsync(label) {
  const ts = Date.now();
  const key = `snapshot_${ts}`;
  const [trades, ks, ls, co, rm] = await Promise.all([
    supabaseClient.from("trades").select("*"),
    supabaseClient.from("keeper_selections").select("*"),
    supabaseClient.from("league_state").select("*"),
    supabaseClient.from("callup_overrides").select("*"),
    supabaseClient.from("roster_moves").select("*"),
  ]);
  for (const r of [trades, ks, ls, co, rm]) {
    if (r.error) throw r.error;
  }
  // Don't snapshot existing snapshot rows — keeps the snapshot self-contained
  // and avoids exponential growth on repeat captures.
  const leagueStateRows = (ls.data || []).filter(r => !String(r.key).startsWith("snapshot_"));
  const snapshot = {
    takenAt: new Date(ts).toISOString(),
    label: label || `Snapshot ${new Date(ts).toLocaleString()}`,
    data: {
      trades: trades.data || [],
      keeperSel: ks.data || [],
      leagueState: leagueStateRows,
      callup: co.data || [],
      rosterMoves: rm.data || [],
    },
  };
  const { error } = await supabaseClient.from("league_state").insert({ key, state: snapshot });
  if (error) throw error;
  return { key, snapshot };
}

async function deleteLeagueSnapshotAsync(key) {
  if (!String(key).startsWith("snapshot_")) throw new Error("Not a snapshot key");
  const { error } = await supabaseClient.from("league_state").delete().eq("key", key);
  if (error) throw error;
}

async function restoreLeagueSnapshotAsync(key) {
  // Pull the snapshot row directly so we have the freshest copy.
  const { data: snapRow, error: getErr } = await supabaseClient
    .from("league_state").select("*").eq("key", key).single();
  if (getErr) throw getErr;
  const snap = snapRow.state;
  if (!snap || !snap.data) throw new Error("Snapshot has no data");

  // Auto-safety snapshot of current state before destructive restore, so the
  // commissioner can recover if they restore to the wrong point.
  try {
    await takeLeagueSnapshotAsync(`Auto-saved before restoring ${snap.label}`);
  } catch (e) {
    console.warn("auto-safety snapshot failed:", e);
  }

  // Wipe current data. Use a column predicate that matches all rows.
  const wipes = await Promise.all([
    supabaseClient.from("trades").delete().not("id", "is", null),
    supabaseClient.from("keeper_selections").delete().not("team_id", "is", null),
    supabaseClient.from("callup_overrides").delete().not("player_name", "is", null),
    supabaseClient.from("roster_moves").delete().not("id", "is", null),
    // Delete non-snapshot league_state rows only — snapshots themselves stay.
    supabaseClient.from("league_state").delete().not("key", "like", "snapshot_%"),
  ]);
  for (const r of wipes) if (r.error) throw r.error;

  // Re-insert snapshot data. Skip empty arrays.
  const inserts = [];
  if (snap.data.trades?.length)      inserts.push(supabaseClient.from("trades").insert(snap.data.trades));
  if (snap.data.keeperSel?.length)   inserts.push(supabaseClient.from("keeper_selections").insert(snap.data.keeperSel));
  if (snap.data.callup?.length)      inserts.push(supabaseClient.from("callup_overrides").insert(snap.data.callup));
  if (snap.data.rosterMoves?.length) inserts.push(supabaseClient.from("roster_moves").insert(snap.data.rosterMoves));
  if (snap.data.leagueState?.length) inserts.push(supabaseClient.from("league_state").insert(snap.data.leagueState));
  const results = await Promise.all(inserts);
  for (const r of results) if (r.error) throw r.error;

  // Refresh the in-memory cache so the UI reflects the restore.
  await _fetchAll();
  return snap;
}
// Single-row append. RLS allows the write when team_id = my_team_id() OR
// the user is a commissioner — that's enforced server-side.
async function appendRosterMoveAsync({ kind, player_name, team_id }) {
  if (!currentUser) throw new Error("Not signed in");
  const { data, error } = await supabaseClient.from("roster_moves").insert({
    kind, player_name, team_id, created_by: currentUser.id,
  }).select().single();
  if (error) throw error;
  _cache.rosterMoves = [...(_cache.rosterMoves || []), data];
  return data;
}
function dbGetRosterMoves() { return _cache.rosterMoves || []; }

// --- Trade Inbox writers ---

async function createProposalAsync({ from_team_id, to_team_id, team1_receives, team2_receives, notes }) {
  if (!currentUser) throw new Error("Not signed in");
  const { data, error } = await supabaseClient.from("trade_proposals").insert({
    from_team_id, to_team_id,
    team1_receives: team1_receives || [],
    team2_receives: team2_receives || [],
    notes: notes || "",
    created_by: currentUser.id,
  }).select().single();
  if (error) throw error;
  // Optimistic-ish: prepend to cache; realtime will dedupe via id on next refresh.
  _cache.proposals = [data, ...(_cache.proposals || [])];
  return data;
}

async function counterProposalAsync(parentProposal, { team1_receives, team2_receives, notes }) {
  if (!currentUser || !currentOwner) throw new Error("Not signed in");
  // Counter is sent BY the recipient of the parent — the from/to flip.
  const new_from = currentOwner.team_id;
  const new_to   = (parentProposal.from_team_id === new_from)
    ? parentProposal.to_team_id
    : parentProposal.from_team_id;
  // 1. Atomically mark parent as countered. Filtering on status='pending'
  //    means a racing accept/reject/withdraw will cause this to update 0
  //    rows and we abort — preventing the counter from forking a thread
  //    that was already closed.
  const { data: updated, error: upErr } = await supabaseClient.from("trade_proposals")
    .update({ status: "countered" })
    .eq("id", parentProposal.id)
    .eq("status", "pending")
    .select();
  if (upErr) throw upErr;
  if (!updated || updated.length === 0) {
    throw new Error("This proposal has already been accepted, rejected, or countered.");
  }
  // 2. Insert the counter in the same thread.
  const { data, error } = await supabaseClient.from("trade_proposals").insert({
    thread_id: parentProposal.thread_id,
    from_team_id: new_from,
    to_team_id: new_to,
    team1_receives: team1_receives || [],
    team2_receives: team2_receives || [],
    notes: notes || "",
    parent_proposal_id: parentProposal.id,
    created_by: currentUser.id,
  }).select().single();
  if (error) throw error;
  return data;
}

// Transition a proposal to a terminal status. Filtering on the current
// status='pending' enforces the state machine (no double-rejects, no
// reject-after-accept, etc.) at the DB level.
async function setProposalStatusAsync(proposalId, status) {
  const valid = ["accepted", "rejected", "withdrawn"];
  if (!valid.includes(status)) throw new Error("Invalid status: " + status);
  const { data, error } = await supabaseClient.from("trade_proposals")
    .update({ status })
    .eq("id", proposalId)
    .eq("status", "pending")
    .select();
  if (error) throw error;
  if (!data || data.length === 0) {
    throw new Error("This proposal has already been accepted, rejected, withdrawn, or countered.");
  }
}

// Accept a proposal: mark it accepted AND record a row in the trades table
// using the same asset arrays. The proposal's negotiation context (notes,
// chat thread) stays in the inbox — the Trade Log records just the swap.
async function acceptProposalAsync(proposal) {
  // 1. First claim the proposal atomically. If status != 'pending' (already
  //    accepted by someone else, withdrawn, etc.), abort BEFORE inserting a
  //    duplicate trade row. Previously this fired the trade insert before
  //    the status update, so concurrent accepts could double-record the
  //    trade with both updates being no-op idempotents.
  const claim = await supabaseClient.from("trade_proposals")
    .update({ status: "accepted" })
    .eq("id", proposal.id)
    .eq("status", "pending")
    .select();
  if (claim.error) throw claim.error;
  if (!claim.data || claim.data.length === 0) {
    throw new Error("This proposal has already been accepted, rejected, or withdrawn.");
  }
  // 2. Insert the trade. team1/team2 follow the proposal as-is.
  // In proposals, team1_receives = items the proposer (from_team) gets and
  // team2_receives = items the recipient gets. The trades table uses the
  // same convention (teamNReceives = items teamN receives), so the arrays
  // pass through unchanged.
  const tradeRow = {
    date: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
    team1: proposal.from_team_id,
    team2: proposal.to_team_id,
    team1Receives: proposal.team1_receives || [],
    team2Receives: proposal.team2_receives || [],
    notes: "",
  };
  try {
    const tradeId = await addTradeAsync(tradeRow);
    return { ...tradeRow, _id: tradeId };
  } catch (e) {
    // Trade insert failed AFTER we claimed the proposal. Best-effort revert
    // so the inbox doesn't show a phantom "accepted" with no log entry.
    try {
      await supabaseClient.from("trade_proposals")
        .update({ status: "pending" })
        .eq("id", proposal.id)
        .eq("status", "accepted");
    } catch { /* swallow — surface the original error */ }
    throw e;
  }
}

async function sendProposalMessageAsync(thread_id, body) {
  if (!currentOwner) throw new Error("Not signed in");
  const trimmed = (body || "").trim();
  if (!trimmed) throw new Error("Empty message");
  const { data, error } = await supabaseClient.from("trade_proposal_messages").insert({
    thread_id,
    from_team_id: currentOwner.team_id,
    body: trimmed,
  }).select().single();
  if (error) throw error;
  _cache.messages = [...(_cache.messages || []), data];
  return data;
}

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
