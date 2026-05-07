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
              const ip = typeof stat.inningsPitched === "string" ? parseFloat(stat.inningsPitched) : (stat.inningsPitched || 0);
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

function getCustomProspects() {
  try { return JSON.parse(localStorage.getItem("flm_custom_prospects") || "[]"); }
  catch { return []; }
}

function addCustomProspect(name) {
  const list = getCustomProspects();
  const cached = getCachedProspects() || [];
  if (!list.includes(name) && !cached.includes(name)) {
    list.push(name);
    if (list.length > 2000) list.shift();
    localStorage.setItem("flm_custom_prospects", JSON.stringify(list));
  }
}

function getAllDraftedPlayerNames() {
  const names = new Set();
  LEAGUE_DATA.teams.forEach(team => {
    team.majors.forEach(p => names.add(p.name));
    team.callups.forEach(p => names.add(p.name));
    team.minors.forEach(p => names.add(p.name));
  });
  try {
    const draft = JSON.parse(localStorage.getItem("flm_draft_2027") || "null");
    if (draft && draft.picks) draft.picks.forEach(pk => names.add(pk.player));
  } catch {}
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
