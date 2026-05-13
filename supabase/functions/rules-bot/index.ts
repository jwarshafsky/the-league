// rules-bot — Supabase Edge Function. Routes a user question through Groq
// (Llama 3.1 8B Instant primary, 3.3 70B fallback). Free tier for now.
//
// Required secrets (Supabase dashboard → Project Settings → Edge Functions):
//   GROQ_API_KEY                — from https://console.groq.com/keys
//   COMMISHAI_DAILY_TOKEN_CAP   — optional, defaults to 2,000,000 tokens/day.
//                                 Set to "0" to disable the cap entirely.
//   SUPABASE_URL                — auto-injected
//   SUPABASE_ANON_KEY           — auto-injected
//   SUPABASE_SERVICE_ROLE_KEY   — auto-injected
//
// Daily usage is tracked in league_state under key="commishai_usage" and
// resets at UTC midnight. View at any time:
//   SELECT state FROM league_state WHERE key='commishai_usage';
//
// Deploy via dashboard: Edge Functions → rules-bot → Code → paste → Deploy.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.74.0";

const ALLOWED_ORIGINS = [
  "https://jwarshafsky.github.io",
  "http://localhost:8090",
  "http://127.0.0.1:8090",
];

const corsHeaders = (origin: string | null) => {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type, apikey",
    "Vary": "Origin",
  };
};

// Compact rules digest — sent on every request so the bot can cite by §.
// The full constitution is on the Rules tab in the app; we only send the
// digest here to keep prompts cheap.
// Sections numbered to match the constitution.
const RULES_DIGEST = `
§1 Format: 12 teams, 5×5 roto. Auction draft 26 rounds, $260 budget. Roster: C, 1B, 2B, SS, 3B, MI, CI, 5 OF, Util, 9 P, 4 Bench, 7 IL (post-draft only). Daily moves. Limits: 200 GS pitchers, 2106 GS hitters, 1000 IP min for ERA/WHIP. Bat cats: R, HR, RBI, SB, OBP. Pitch cats: QS, K, SV+HLD, ERA, WHIP.
§1b Trading draft $: only for next draft. Max $290 entering draft ($260+$30 acquired). Trading >$10 away requires $200 security deposit.
§2a Keeper caps: max 8 ML, max 10 MiL.
§2b ML keepers (drafted): keep up to 3 add'l yrs at draft value, +$2/yr. Min cost $1, non-int rounded up. Traded players keep cost basis.
§2b ML keepers (FA): $6 first keepable yr, +$2/yr, 3 yrs max. Players dropped in final contract yr → can be added in FA but NOT kept.
§2c Post-keeper-deadline drops only allowed for newly-reported injury/legal news (not regret).
§2d $40+ auction price → max 2 add'l yrs. $50+ → max 1 add'l yr.
§2e MiL keepers (max 10): no salary while in minors. Pre-2027 drafted = 4-yr contracts (e.g. drafted 2017 → keepable through 2020). 2027+ drafted = "call up + 3 yr" (kept up to 3 yrs after call-up).
§2e MiL→ML pricing on first ML kept yr, based on ESPN top-200 ranking March 1: outside top 200=$1, 100-199=$3, 50-99=$5, 20-49=$10, top 19=$15. Then +$2/yr after.
§3a Minor draft: 7 rounds, reverse standings. Anti-tanking: <45 roto pts → bottom of next year's order. Picks traded after May 15 NOT protected (Feb 2025 amendment).
§3 Limits: never >10 minors at keeper deadline or end of MiL draft. Forfeit picks that would exceed 10.
§3b MiL transactions: call-up free anytime. Send-down to minors costs $10 REAL MONEY (per send-down). Call-ups during MiL draft permitted (drop ML player). Post-Jan-2026: call up minors after keeper deadline before ML draft for $0.
§3c Eligibility: <200 career AB or <50 career IP for MiL drafting. Existing MiL keepers grandfathered in their final 3 contract yrs.
§3d Pre-MLB auction draftees can't be dropped until April 15 unless DL'd or acquired >$1.
§3f Post-Jan-2026: MiL players who hit 75 IP / 300 AB must be called up or dropped by end of next MiL draft.
§4a Trade deadline set on ESPN. After deadline: only $/picks/MiL trades; traded MiL can't be called up until next offseason. FA pickups after deadline can't be kept.
§4b Veto: commish only, only for collusion / mistake / mutual agreement.
§4c No conditional trades. 24-hr protest window.
§5 Rule 5 Draft: by Jan 31 shrink full roster (ML+MiL) to 25. Snake, reverse standings. Drafting team pays origin team $1. Need open 25-man slot. Unprotected/unselected players can't be kept by original team.
§6 FAAB: tri-weekly (Tue/Thu/Sun 11am). $1000/season. $0 bids OK. All FA keepers cost $6 regardless of bid. FAAB$ tradeable as of 2026. Bidding on another team's MiL → drop+forfeit$.
§7 Fees: $300/season. 1st place = $2300+collected fees+chooses draft loc. 2nd=$1000. 3rd=$300+luxury overflow. 4th=luxury 60% (max $300). 5th=luxury 40%.
§9c Constitution changes need majority vote (commish judges significance).
§10 Luxury tax: every $ over $350 at trade deadline. Pool 60/40 to 4th/5th, 4th capped at $300, excess to 3rd.
`.trim();

// Ultra-compact site guide — keeps prompt cheap.
const SITE_GUIDE = `
Tabs: Select Keepers, 2026 Keepers, Rule 5 Draft, Minors Draft, Minors Rosters, Trade Block, Trade Inbox, Trade Log, Activity, League History, League Rules. Auth via Google or email OTP. Header link → ESPN league. Commissioners have Edit/Delete on trades, Undo on Activity, Lock Keepers button, "Manager view" toggle, Reset on drafts.
`.trim();

// Compact, line-per-player roster. Cuts JSON overhead ~70%.
function _compactRoster(r: { team_id?: string; name?: string; majors?: unknown[]; minors?: unknown[]; callups?: unknown[] } | null): string {
  if (!r) return "(no roster — frontend may be stale)";
  const fmt = (p: Record<string, unknown>): string => {
    const name = String(p.name ?? "?");
    const price = p.price != null ? `$${p.price}` : "";
    const year = p.yearAcquired != null ? ` y${p.yearAcquired}` : "";
    const src = p.source ? ` ${p.source}` : "";
    const last = p.keeperLastYear != null ? ` keep→${p.keeperLastYear}` : "";
    const next = p.nextYearPrice != null ? ` next$${p.nextYearPrice}` : "";
    return `${name}${price}${year}${src}${last}${next}`.trim();
  };
  const lines: string[] = [];
  if (r.majors?.length) lines.push("Majors:", ...(r.majors as Record<string, unknown>[]).map(p => "  " + fmt(p)));
  if (r.callups?.length) lines.push("Callups:", ...(r.callups as Record<string, unknown>[]).map(p => "  " + fmt(p)));
  if (r.minors?.length) lines.push("Minors:", ...(r.minors as Record<string, unknown>[]).map(p => "  " + fmt(p)));
  return lines.join("\n");
}

// Compact trades: one line each, "date | team1 → team2 | t1gets ↔ t2gets".
function _compactTrades(trades: Array<Record<string, unknown>>): string {
  if (!trades.length) return "(none)";
  const formatAssets = (arr: unknown): string => {
    if (!Array.isArray(arr) || !arr.length) return "—";
    return arr.map((a: Record<string, unknown>) => String(a.value ?? a.type ?? "?")).join(", ");
  };
  return trades.map(t => {
    const date = t.date ?? "?";
    const t1 = t.team1 ?? "?";
    const t2 = t.team2 ?? "?";
    const r1 = formatAssets(t.team1_receives);
    const r2 = formatAssets(t.team2_receives);
    return `${date} | ${t1} gets [${r1}] ↔ ${t2} gets [${r2}]`;
  }).join("\n");
}

function jsonResponse(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(origin) });
  if (req.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405, origin);

  // Reject unknown origins before doing any work. The browser would block the
  // response anyway (Allow-Origin mismatch), but processing the request still
  // burns Groq tokens against the daily cap. Origin is null for same-origin
  // requests and for server-to-server callers (curl, scripts) — allow those.
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    return jsonResponse({ error: "forbidden origin" }, 403, origin);
  }

  const authHeader = req.headers.get("Authorization") || req.headers.get("authorization");
  if (!authHeader) return jsonResponse({ error: "unauthenticated" }, 401, origin);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY");

  if (!GROQ_API_KEY) return jsonResponse({ error: "GROQ_API_KEY not configured" }, 500, origin);

  // Verify the JWT and find the asker.
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return jsonResponse({ error: "unauthenticated" }, 401, origin);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: owner, error: ownerErr } = await admin
    .from("owners")
    .select("id, team_id, is_commissioner")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (ownerErr) return jsonResponse({ error: "owner lookup failed: " + ownerErr.message }, 500, origin);
  if (!owner || !owner.team_id) {
    return jsonResponse({ error: "no team assigned to your account" }, 403, origin);
  }
  // Display name lookup — owners table doesn't store a name, so we map
  // team_id → owner name via a hardcoded table that matches data.js.
  const TEAM_NAMES: Record<string, string> = {
    jeff: "Jeff", matt: "Matt", jesse: "Jesse", sam: "Sam",
    saxton: "Saxton", aj: "AJ", corey: "Corey", dave: "Dave",
    "josh-doug": "Josh/Doug", larry: "Larry", zack: "Zack", glicksman: "Glicksman",
  };
  const ownerName = TEAM_NAMES[owner.team_id] || owner.team_id;

  type RosterPayload = { team_id: string; name?: string; majors?: unknown[]; minors?: unknown[]; callups?: unknown[] };
  let payload: {
    question?: string;
    history?: { role: string; content: string }[];
    myRoster?: RosterPayload;
    leagueIndex?: string[];
  };
  try { payload = await req.json(); } catch { return jsonResponse({ error: "bad json" }, 400, origin); }
  const question = (payload.question || "").trim();
  if (!question) return jsonResponse({ error: "empty question" }, 400, origin);
  if (question.length > 2000) return jsonResponse({ error: "question too long (max 2000 chars)" }, 400, origin);
  // Last 4 turns is enough conversational context — older turns blow up the prompt.
  // Cap each turn's content too so a client can't balloon the prompt by stuffing
  // history (the daily token cap is the second line of defense).
  const MAX_HISTORY_CHARS = 4000;
  const history = (payload.history || []).slice(-4)
    .filter(m => m && typeof m.content === "string")
    .map(m => ({ role: m.role, content: m.content.slice(0, MAX_HISTORY_CHARS) }));
  // Only trust the client-supplied roster if its team_id matches the asker's
  // verified team (or the asker is a commish — they can ask about anyone).
  const myRoster = payload.myRoster &&
    (payload.myRoster.team_id === owner.team_id || owner.is_commissioner)
    ? payload.myRoster : null;
  const leagueIndex = Array.isArray(payload.leagueIndex)
    ? payload.leagueIndex.filter(s => typeof s === "string")
    : [];

  // Daily token cap — backstop in case we ever upgrade to a paid tier.
  // Reads/writes a single league_state row with the day's running total.
  const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD" UTC
  const capStr = Deno.env.get("COMMISHAI_DAILY_TOKEN_CAP") || "2000000";
  const dailyCap = parseInt(capStr, 10) || 0;

  let usageState: { day: string; total: number; input: number; output: number; requests: number } = {
    day: today, total: 0, input: 0, output: 0, requests: 0,
  };
  if (dailyCap > 0) {
    const { data: usageRow } = await admin
      .from("league_state").select("state").eq("key", "commishai_usage").maybeSingle();
    const stored = usageRow?.state as typeof usageState | undefined;
    if (stored && stored.day === today) usageState = stored;
    if (usageState.total >= dailyCap) {
      const realMsg = `CommishAI daily token cap reached (${usageState.total.toLocaleString()} / ${dailyCap.toLocaleString()}). Resets at midnight UTC.`;
      return jsonResponse({
        error: owner.is_commissioner ? realMsg : "I don't have the answer. Please ask the commissioner.",
      }, 429, origin);
    }
  }

  // Mask upstream errors for non-commissioners; commissioners see the real
  // text so they can debug.
  const maskError = (real: string) =>
    owner.is_commissioner ? real : "I don't have the answer. Please ask the commissioner.";

  // Most context (full constitution, keeper selections, draft/rule5 states,
  // callup overrides, proposals, roster moves, trades) is intentionally NOT
  // sent — keeps prompts cheap. The asker's roster (with pre-computed
  // keeperLastYear) is sent from the frontend and covers most team-data
  // questions. Cross-team queries go through the leagueIndex section.

  const systemPrompt = [
    "You are The League Assistant for The League — a 12-team keeper baseball league.",
    `The user asking is "${ownerName}" (team_id: ${owner.team_id}).`,
    owner.is_commissioner ? "This user is a commissioner." : "This user is a regular owner.",
    "",
    "You answer three kinds of questions:",
    "  1. League rules — cite by section (e.g. '§2(d)'). For full text, point users to the League Rules tab.",
    "  2. How to use this site — refer to the SITE GUIDE below.",
    "  3. The asker's own roster — use the keeperLastYear field on each player.",
    "",
    "Be concise but informative. Don't invent rules, numbers, or features. If something isn't in the digest",
    "or roster, say so.",
    "",
    "CRITICAL — keeperLastYear is the FINAL year a player can be kept. It already accounts for all caps,",
    "FA rules, MiL contracts, and §2(d) price tiers. NEVER add additional years to it. NEVER apply §2(b)'s",
    "'3 additional years' on top of it. The compact line `keep→2026` means 2026 is the last keepable year",
    "(and if currentSeason=2026, this is the final season).",
    "",
    "Examples:",
    "  - 'How many years can I keep Chourio?' → look up keeperLastYear=2026, currentSeason=2026 → 'This is",
    "    his final year (2026). After this season he must return to the draft.' Do NOT cite §2(b)'s 3-yr rule",
    "    or compute anything; the field is the answer.",
    "  - 'Through 2029' filter → list players where keeperLastYear >= 2029. Don't reason about why.",
    "",
    "When listing players (e.g. 'who can I keep through year N'):",
    "  - Filter roster on keeperLastYear >= N.",
    "  - Format each player as a markdown bullet: `- **Name** — $next-yr-price (one-phrase rationale)`",
    "    Examples: `- **Joe Ryan** — $24 next yr (2026 auction, $22 base, §2(b))`",
    "             `- **Cholowsky** — minors, no salary (2026 MiL draftee, §2(e) 4-yr contract)`",
    "  - DO NOT dump the raw compact line (e.g. 'Joe Ryan$22 y2026 ...') — re-format it.",
    "  - Group under markdown headings: `### Majors`, `### Callups`, `### Minors`. Skip empty headings.",
    "  - When a group has no qualifying players, say `_None_` and briefly explain why",
    "    (e.g. 'all majors are 2025 or earlier acquisitions, max keepable yr is 2028 per §2(b)').",
    "",
    "=== SITE GUIDE ===",
    SITE_GUIDE,
    "",
    "=== RULES DIGEST (cite by §) ===",
    "Full text in the League Rules tab. Use this digest for citations.",
    RULES_DIGEST,
    "",
    "=== ASKER'S ROSTER ===",
    "Each player has keeperLastYear (last yr keepable). Filter on it for keeper questions.",
    _compactRoster(myRoster),
    "",
    "=== LEAGUE INDEX (other 11 teams) ===",
    "Format per line: `teamId ML: Name$price→YY, ...` or `teamId MiL: Name→YY, ...`",
    "YY is last two digits of last keepable year (e.g. →28 means 2028). (C) marks an active callup.",
    "Use this for cross-team questions. NEVER quote the raw line verbatim to the user — rephrase naturally.",
    "Bad: 'matt MiL: ... Gage Workman→28'.  Good: 'Workman is on Matt's minors roster; contract through 2028.'",
    "The asker's own roster is in the ASKER'S ROSTER section above (not duplicated here).",
    leagueIndex.length ? leagueIndex.join("\n") : "(no league index sent)",
  ].join("\n");

  // Build OpenAI-compatible chat history (Groq uses the OpenAI schema).
  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: systemPrompt },
  ];
  for (const m of history) {
    messages.push({ role: m.role === "assistant" ? "assistant" : "user", content: m.content });
  }
  messages.push({ role: "user", content: question });

  // Primary: Llama 3.1 8B Instant. Fallback: 3.3 70B Versatile.
  const MODELS = [
    "llama-3.1-8b-instant",
    "llama-3.3-70b-versatile",
  ];
  const errors: string[] = [];
  let answer = "";
  let usedModel = "";

  for (const model of MODELS) {
    let resp: Response;
    // 30s timeout per model attempt — a hanging Groq call would otherwise
    // consume the entire edge function runtime quota and time out the
    // function (which returns an opaque 500 to the client).
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.2,
          max_tokens: 1024,
        }),
        signal: ctrl.signal,
      });
    } catch (e) {
      errors.push(`${model}: fetch failed: ${(e as Error).message}`);
      continue;
    } finally {
      clearTimeout(timer);
    }

    // Fall through on retryable conditions: 429 (TPM/RPD quota), 413 (request
    // too large for this model's TPM), 404 (model unavailable), 400 with
    // model_not_found (Google retired or renamed it).
    if (resp.status === 429 || resp.status === 404 || resp.status === 413) {
      const text = await resp.text();
      errors.push(`${model}: ${resp.status}: ${text.slice(0, 200)}`);
      continue;
    }
    if (resp.status === 400) {
      const text = await resp.text();
      if (text.includes("model_decommissioned") || text.includes("model_not_found")) {
        errors.push(`${model}: ${resp.status}: ${text.slice(0, 200)}`);
        continue;
      }
      return jsonResponse({ error: maskError(`groq 400: ${text.slice(0, 400)}`) }, 502, origin);
    }
    if (!resp.ok) {
      const text = await resp.text();
      return jsonResponse({ error: maskError(`groq ${resp.status}: ${text.slice(0, 400)}`) }, 502, origin);
    }

    const data = await resp.json();
    answer = data?.choices?.[0]?.message?.content || "";
    if (answer) {
      usedModel = model;
      // Accumulate today's token usage for the daily cap.
      const u = data?.usage || {};
      const inTok = Number(u.prompt_tokens || 0);
      const outTok = Number(u.completion_tokens || 0);
      usageState.input += inTok;
      usageState.output += outTok;
      usageState.total += inTok + outTok;
      usageState.requests += 1;
      break;
    }
    errors.push(`${model}: empty response`);
  }

  if (!answer) {
    return jsonResponse({ error: maskError("all groq models exhausted: " + errors.join(" | ")) }, 502, origin);
  }

  // Persist updated usage. Await so a transient DB error surfaces rather than
  // silently letting the cap state go stale (which would allow future requests
  // to bypass the cap until the next successful write).
  if (dailyCap > 0) {
    try {
      await admin.from("league_state").upsert({ key: "commishai_usage", state: usageState });
    } catch (e) {
      console.warn("commishai_usage upsert failed:", (e as Error).message);
    }
  }

  return jsonResponse({
    answer,
    model: usedModel,
    usage: dailyCap > 0 ? { todayTotal: usageState.total, dailyCap } : undefined,
  }, 200, origin);
});
