// Live prospect list — fetched from MLB Stats API
// Cache refreshes every 7 days (or manually via refreshProspectCache()).
// Inclusion criteria:
//   - All current MiLB rostered players (auto-eligible: on a minor league team)
//   - All MLB 40-man players with career AB < 200 AND career IP < 50 (still minors-eligible per league rules)
//   - All draft prospects for upcoming drafts (HS + college)
//   - Small supplemental list for notable foreign/NPB/KBO/CPBL players not in MLB DB

const PROSPECT_CACHE_KEY = "flm_prospect_cache_v3";
const PROSPECT_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// MLB Stats API sport IDs
const MILB_SPORT_IDS = [11, 12, 13, 14, 16]; // AAA, AA, High-A, Low-A, Rookie
const MLB_SPORT_ID = 1;

// League eligibility thresholds (from constitution)
const MAX_ELIGIBLE_AB = 200; // Career AB < 200 = still minors-eligible
const MAX_ELIGIBLE_IP = 50;  // Career IP < 50 = still minors-eligible

// MLB innings-pitched use ".1"/".2" to mean 1/3 and 2/3 of an inning, NOT
// decimals. parseFloat("46.2") = 46.2 but the real value is 46 2/3. Today's
// thresholds are integers so this can't flip eligibility, but any later
// comparison/sum would be wrong — convert properly at the source.
function _ipToNumber(ip) {
  if (typeof ip === "number") return ip;
  const s = String(ip == null ? "" : ip).trim();
  if (!s) return 0;
  const [wholeStr, fracStr] = s.split(".");
  const whole = parseInt(wholeStr, 10) || 0;
  const frac = fracStr === "1" ? 1 / 3 : fracStr === "2" ? 2 / 3 : 0;
  return whole + frac;
}

// Supplemental: notable foreign pros (NPB/KBO/CPBL) + elite amateur names
// not in MLB Stats API until they sign/are drafted.
const SUPPLEMENTAL_PROSPECTS = [
  // NPB
  "Munetaka Murakami", "Roki Sasaki", "Sotaro Kojima", "Shota Morishita",
  "Kazuki Yamazaki", "Shinnosuke Ogasawara", "Keiya Ino", "Ryoma Ugajin",
  "Hiromi Itoh", "Sho Nakata", "Teruaki Sato", "Kazuma Okamoto",
  "Munetaka Kamikura", "Ukyo Shuto",
  // KBO
  "Jung Hoo Lee", "Hyun-jin Ryu", "Kim Ha-seong", "Go Young-pyo",
  "Eui-ri Noh", "Won-jun Kim",
  // Top Cuban defectors / undrafted intl
  "Luis Robert Sr.", "Yasmani Grandal",
];

function _fetchJson(url) {
  return fetch(url).then(r => r.ok ? r.json() : null).catch(() => null);
}

async function fetchMiLBPlayerNames(season) {
  const results = await Promise.all(
    MILB_SPORT_IDS.map(id =>
      _fetchJson(`https://statsapi.mlb.com/api/v1/sports/${id}/players?season=${season}`)
    )
  );
  const names = new Set();
  results.forEach(r => {
    if (r && Array.isArray(r.people)) {
      r.people.forEach(p => { if (p.fullName) names.add(p.fullName); });
    }
  });
  return names;
}

async function fetchMLBEligibleNames(season) {
  const list = await _fetchJson(`https://statsapi.mlb.com/api/v1/sports/${MLB_SPORT_ID}/players?season=${season}`);
  if (!list || !Array.isArray(list.people)) return new Set();

  const nameById = {};
  list.people.forEach(p => { if (p.fullName) nameById[p.id] = p.fullName; });
  const ids = Object.keys(nameById);

  // Batch career-stat lookups in chunks of 100
  const chunks = [];
  for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));

  const eligible = new Set();
  for (const chunk of chunks) {
    const url = `https://statsapi.mlb.com/api/v1/people?personIds=${chunk.join(",")}&hydrate=stats(group=[hitting,pitching],type=career)`;
    const batch = await _fetchJson(url);
    if (!batch || !Array.isArray(batch.people)) continue;

    batch.people.forEach(p => {
      let maxAB = 0, maxIP = 0;
      if (Array.isArray(p.stats)) {
        p.stats.forEach(s => {
          const group = s.group?.displayName;
          (s.splits || []).forEach(sp => {
            const stat = sp.stat || {};
            if (group === "hitting" && typeof stat.atBats === "number") {
              maxAB = Math.max(maxAB, stat.atBats);
            }
            if (group === "pitching") {
              const ip = _ipToNumber(stat.inningsPitched);
              if (!isNaN(ip)) maxIP = Math.max(maxIP, ip);
            }
          });
        });
      }
      if (maxAB < MAX_ELIGIBLE_AB && maxIP < MAX_ELIGIBLE_IP && p.fullName) {
        eligible.add(p.fullName);
      }
    });
  }
  return eligible;
}

async function fetchDraftProspectNames(year) {
  const data = await _fetchJson(`https://statsapi.mlb.com/api/v1/draft/prospects/${year}`);
  if (!data) return new Set();
  const names = new Set();
  const pushFrom = arr => arr?.forEach(p => {
    const n = p.person?.fullName || p.fullName || p.name;
    if (n) names.add(n);
  });
  if (Array.isArray(data.prospects)) pushFrom(data.prospects);
  // Also handle shape with rounds/picks
  if (Array.isArray(data.drafts?.dates)) {
    data.drafts.dates.forEach(d => (d.drafts || []).forEach(pk => {
      if (pk.person?.fullName) names.add(pk.person.fullName);
    }));
  }
  return names;
}

async function fetchDraftedPlayersFromRecentDraft(year) {
  // Completed draft records — useful so players drafted to MLB orgs show up
  const data = await _fetchJson(`https://statsapi.mlb.com/api/v1/draft/${year}`);
  if (!data) return new Set();
  const names = new Set();
  (data.drafts?.rounds || []).forEach(rd => {
    (rd.picks || []).forEach(pk => {
      if (pk.person?.fullName) names.add(pk.person.fullName);
    });
  });
  return names;
}

let _prospectRefreshPromise = null;
async function refreshProspectCache(onProgress) {
  if (_prospectRefreshPromise) return _prospectRefreshPromise;
  _prospectRefreshPromise = (async () => {
    const season = new Date().getFullYear();
    onProgress?.("Fetching MiLB rosters...");
    const milb = await fetchMiLBPlayerNames(season);

    onProgress?.(`Fetching MLB players under eligibility thresholds (${milb.size} MiLB so far)...`);
    const mlbEligible = await fetchMLBEligibleNames(season);

    onProgress?.(`Fetching recent & upcoming draft prospects...`);
    const [draftUp1, draftUp2, draftPrev] = await Promise.all([
      fetchDraftProspectNames(season),
      fetchDraftProspectNames(season + 1),
      fetchDraftedPlayersFromRecentDraft(season - 1),
    ]);

    const all = new Set([
      ...milb, ...mlbEligible,
      ...draftUp1, ...draftUp2, ...draftPrev,
      ...SUPPLEMENTAL_PROSPECTS,
    ]);
    const names = Array.from(all).sort((a, b) => a.localeCompare(b));
    localStorage.setItem(PROSPECT_CACHE_KEY, JSON.stringify({
      fetchedAt: Date.now(),
      season,
      counts: {
        milb: milb.size,
        mlbEligible: mlbEligible.size,
        draftCurrent: draftUp1.size,
        draftNext: draftUp2.size,
        draftPrev: draftPrev.size,
        supplemental: SUPPLEMENTAL_PROSPECTS.length,
        total: names.length,
      },
      names,
    }));
    onProgress?.(`Loaded ${names.length} prospects.`);
    return names;
  })();
  try {
    return await _prospectRefreshPromise;
  } finally {
    _prospectRefreshPromise = null;
  }
}

function getCachedProspects() {
  try {
    const cache = JSON.parse(localStorage.getItem(PROSPECT_CACHE_KEY) || "null");
    if (!cache) return null;
    if (Date.now() - cache.fetchedAt > PROSPECT_CACHE_MAX_AGE_MS) return null;
    return cache.names;
  } catch { return null; }
}

function getProspectCacheMeta() {
  try {
    const cache = JSON.parse(localStorage.getItem(PROSPECT_CACHE_KEY) || "null");
    if (!cache) return null;
    return {
      fetchedAt: cache.fetchedAt,
      counts: cache.counts || { total: (cache.names || []).length },
      isStale: Date.now() - cache.fetchedAt > PROSPECT_CACHE_MAX_AGE_MS,
    };
  } catch { return null; }
}

// Custom-prospect names are league-wide: when one owner types a name during
// a minors pick, every other owner's autocomplete should pick it up too.
// Stored in league_state.custom_prospects (synced via realtime); localStorage
// kept as a fast-path cache so the autocomplete works pre-DB-ready.
function getCustomProspects() {
  // Union the server cache (authoritative, league-wide) with the local cache
  // (covers names typed offline or before the data layer finished loading).
  const server = (typeof dbGetCustomProspects === "function") ? dbGetCustomProspects() : [];
  let local = [];
  try { local = JSON.parse(localStorage.getItem("flm_custom_prospects") || "[]"); } catch {}
  if (!server.length) return local;
  if (!local.length) return server.slice();
  const seen = new Set(server);
  const merged = server.slice();
  for (const n of local) if (!seen.has(n)) { seen.add(n); merged.push(n); }
  return merged;
}

function addCustomProspect(name) {
  if (!name) return;
  const cached = getCachedProspects() || [];
  if (cached.includes(name)) return;
  // Local write-through so this device sees it instantly.
  let local = [];
  try { local = JSON.parse(localStorage.getItem("flm_custom_prospects") || "[]"); } catch {}
  if (!local.includes(name)) {
    local.push(name);
    if (local.length > 2000) local.shift();
    try { localStorage.setItem("flm_custom_prospects", JSON.stringify(local)); } catch {}
  }
  // Push to the shared league-wide list. Fire-and-forget — the realtime
  // callback on league_state will refresh _cache.customProspects on every
  // device. If the function isn't defined yet (script load order), the next
  // call will catch up.
  if (typeof saveCustomProspectsAsync === "function" && typeof dbGetCustomProspects === "function") {
    const server = dbGetCustomProspects();
    if (!server.includes(name)) {
      const next = server.concat([name]);
      // Cap server-side too so the league_state row doesn't grow forever.
      while (next.length > 2000) next.shift();
      saveCustomProspectsAsync(next).catch(e =>
        console.warn("custom-prospects sync failed:", e));
    }
  }
}

function getAllDraftedPlayerNames() {
  const names = new Set();
  LEAGUE_DATA.teams.forEach(team => {
    team.majors.forEach(p => names.add(p.name));
    team.callups.forEach(p => names.add(p.name));
    team.minors.forEach(p => names.add(p.name));
  });
  // Read from the Supabase-backed cache when available (post-Phase-2 source
  // of truth); fall back to the legacy localStorage key otherwise.
  let draft = null;
  if (typeof dbGetDraft === "function") {
    draft = dbGetDraft();
  } else {
    try { draft = JSON.parse(localStorage.getItem("flm_draft_2027") || "null"); } catch {}
  }
  if (draft && draft.picks) draft.picks.forEach(pk => names.add(pk.player));
  return names;
}

function getAvailableProspects() {
  const cached = getCachedProspects() || [];
  const custom = getCustomProspects();
  const drafted = getAllDraftedPlayerNames();
  const combined = [...new Set([...cached, ...custom])];
  return combined
    .filter(n => !drafted.has(n))
    .sort((a, b) => a.localeCompare(b));
}
