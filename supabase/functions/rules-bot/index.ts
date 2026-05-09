// rules-bot — Supabase Edge Function. Routes a user question through Groq
// (Llama 3.3 70B) with the league constitution + the asker's team context
// as system prompt. Free-tier-friendly: 14,400 req/day on the free tier.
//
// Required secrets (Supabase dashboard → Project Settings → Edge Functions):
//   GROQ_API_KEY      — from https://console.groq.com/keys
//   SUPABASE_URL      — auto-injected
//   SUPABASE_ANON_KEY — auto-injected
//   SUPABASE_SERVICE_ROLE_KEY — auto-injected
//
// Deploy via dashboard: Edge Functions → New Function → name "rules-bot" →
// paste this file's contents → Deploy.

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

// Compact site guide — describes the app's tabs/features so the bot can
// answer "where do I find X" questions. Trimmed aggressively to fit Groq's
// 12k TPM budget on Llama 3.3 70B.
const SITE_GUIDE = `
App: https://jwarshafsky.github.io/the-league/ — static site + Supabase. Sign in with Google or email magic link / OTP code.
Header: "The League" link goes to the ESPN league. Commissioners (★) can click their name to toggle "Manager view" (👁) for an owner-perspective preview.

Tabs:
- Select Keepers: tick keepers, MiLB keepers, Rule 5, trade-block flags. Caps 8 ML / 10 MiL / 25 Rule 5. Press Keep auto-protects via Rule 5. Commish can lock.
- Keepers: read-only summary of each team's locked keepers + contract status. "$10 send-down fee" badges accumulate ($10/$20/$30).
- Rule 5 Draft: snake, reverse standings. Pick creates a $1 trade. Pass skips. Commish has Undo Last.
- Minors Draft: 7 rounds, reverse standings. Click a pick to edit. "Reset to Original Owner" reverts trade-log or manual overrides.
- Minors Rosters: per-team. Owner/commish sees Call Up on minors and Send Down on callups (when eligible).
- Trade Block: per-team cards of flagged players. Propose Trade pre-fills the composer.
- Trade Inbox: full proposal lifecycle (create, counter, accept, reject, messages). Red (N) badge counts unread.
- Trade Log: all accepted trades. Commish can Edit/Delete in place.
- Activity: chronological feed. Commish has "undo" on every entry — reverses the underlying action (toggles, trades, picks, callups, lock, overrides).
- League History: past-season standings (snapshot, ESPN-independent).
- League Rules: this constitution. Commish has Edit.

Common commish tasks: lock/unlock keepers via the Lock button on Select Keepers; set call-up prices via "Set Price" on the MiLB row; override contracts via ⚙ on the player row.
`.trim();

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
  type SummaryRow = { team_id: string; name?: string; majors?: number; minors?: number; callups?: number };
  let payload: {
    question?: string;
    history?: { role: string; content: string }[];
    myRoster?: RosterPayload;
    allTeamsSummary?: SummaryRow[];
  };
  try { payload = await req.json(); } catch { return jsonResponse({ error: "bad json" }, 400, origin); }
  const question = (payload.question || "").trim();
  if (!question) return jsonResponse({ error: "empty question" }, 400, origin);
  if (question.length > 2000) return jsonResponse({ error: "question too long (max 2000 chars)" }, 400, origin);
  const history = (payload.history || []).slice(-10).filter(m => m && typeof m.content === "string");
  // Only trust the client-supplied roster if its team_id matches the asker's
  // verified team (or the asker is a commish — they can ask about anyone).
  const myRoster = payload.myRoster &&
    (payload.myRoster.team_id === owner.team_id || owner.is_commissioner)
    ? payload.myRoster : null;
  const allTeamsSummary = Array.isArray(payload.allTeamsSummary) ? payload.allTeamsSummary : [];

  // Pull league context. Almost everything in this league is public to all
  // owners; we filter trade_proposal_messages to only the asker's threads.
  const [constitutionRow, allKeepers, allTrades, callupRows, leagueState, rosterMoves, propThreads] = await Promise.all([
    admin.from("league_state").select("state").eq("key", "constitution").maybeSingle(),
    admin.from("keeper_selections").select("team_id, player_name, keeper, minor_keeper, rule5, trade_block"),
    admin.from("trades").select("id, date, team1, team2, team1_receives, team2_receives, notes").order("created_at", { ascending: false }).limit(80),
    admin.from("callup_overrides").select("player_name, price, year"),
    admin.from("league_state").select("key, state").in("key", ["draft_2027", "rule5", "commish_overrides", "keeper_deadline"]),
    admin.from("roster_moves").select("kind, player_name, team_id, at").order("at", { ascending: false }).limit(50),
    admin.from("trade_proposals").select("id, from_team_id, to_team_id, status, team1_receives, team2_receives, created_at")
      .or(`from_team_id.eq.${owner.team_id},to_team_id.eq.${owner.team_id}`)
      .order("created_at", { ascending: false }).limit(20),
  ]);

  const constitution: string = constitutionRow?.data?.state?.markdown || "(constitution not yet saved)";
  const myKeepers = (allKeepers.data || []).filter(k => k.team_id === owner.team_id);
  const myTrades = (allTrades.data || []).filter(t => t.team1 === owner.team_id || t.team2 === owner.team_id);
  const myMoves = (rosterMoves.data || []).filter(m => m.team_id === owner.team_id);
  const draftState = (leagueState.data || []).find(r => r.key === "draft_2027")?.state || null;
  const rule5State = (leagueState.data || []).find(r => r.key === "rule5")?.state || null;
  const keeperDeadline = (leagueState.data || []).find(r => r.key === "keeper_deadline")?.state || null;

  const systemPrompt = [
    "You are The League Assistant for The League — a 12-team keeper baseball league.",
    `The user asking is "${ownerName}" (team_id: ${owner.team_id}).`,
    owner.is_commissioner ? "This user is a commissioner." : "This user is a regular owner.",
    "",
    "You answer two kinds of questions:",
    "  1. League rules — cite the constitution section number (e.g. 'per §2(d)').",
    "  2. How to use this site — refer to the SITE GUIDE below.",
    "",
    "Be concise. If you don't know or it isn't in the data provided, say so plainly. Do not invent rules, numbers, or features.",
    "Do not reveal another team's pending trade proposals or messages — only the asker's own threads are visible to you.",
    "",
    "IMPORTANT — keeper eligibility: every player on the asker's roster includes a `keeperLastYear`",
    "field, pre-computed by the app's authoritative contract-status logic. To answer 'who can I keep",
    "through 2029', filter players where keeperLastYear >= 2029. Do NOT derive eligibility yourself",
    "from yearAcquired alone — call-ups, trades, source (auction|fa|keeper|callup), and the $40/$50",
    "draft-price caps all change the math, and getting it wrong is worse than declining. If",
    "keeperLastYear is null on a player, say so rather than guessing.",
    "",
    "=== SITE GUIDE ===",
    SITE_GUIDE,
    "",
    "=== CONSTITUTION ===",
    constitution,
    "",
    "=== ASKER'S CURRENT ROSTER (post-trades, post-callups) ===",
    "Each player carries: name, price (auction $), yearAcquired, source",
    "(auction|fa|keeper|callup|callup-via-trade), and contract metadata.",
    "Use this to compute keeper eligibility and next-year prices per the constitution.",
    JSON.stringify(myRoster || "(no roster sent — frontend may be stale)"),
    "",
    "=== ASKER'S KEEPER SELECTIONS (the flags they've checked) ===",
    JSON.stringify(myKeepers),
    "",
    "=== ASKER'S TRADES ===",
    JSON.stringify(myTrades),
    "",
    "=== ASKER'S MINORS ROSTER MOVES ===",
    JSON.stringify(myMoves),
    "",
    "=== ASKER'S TRADE PROPOSALS (own threads only) ===",
    JSON.stringify(propThreads.data || []),
    "",
    "=== LEAGUE-PUBLIC: ALL TEAMS' ROSTER SIZES ===",
    JSON.stringify(allTeamsSummary),
    "",
    "=== LEAGUE-PUBLIC: CALL-UP PRICE OVERRIDES ===",
    JSON.stringify(callupRows.data || []),
    "",
    "=== LEAGUE-PUBLIC: KEEPER DEADLINE STATE ===",
    JSON.stringify(keeperDeadline),
    "",
    "=== LEAGUE-PUBLIC: MINORS DRAFT STATE (summary) ===",
    JSON.stringify(draftState ? { type: draftState.type, year: draftState.year, picksMade: (draftState.picks || []).length, passed: (draftState.passed || []).length } : null),
    "",
    "=== LEAGUE-PUBLIC: RULE 5 DRAFT STATE (summary) ===",
    JSON.stringify(rule5State ? { picksMade: (rule5State.picks || []).length, poolSize: (rule5State.pool || []).length } : null),
  ].join("\n");

  // Build OpenAI-compatible chat history (Groq uses the OpenAI schema).
  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: systemPrompt },
  ];
  for (const m of history) {
    messages.push({ role: m.role === "assistant" ? "assistant" : "user", content: m.content });
  }
  messages.push({ role: "user", content: question });

  // Try a sequence of Groq models; fall through on size/quota/availability
  // errors. Order matters: 70B-versatile first for quality, then 8B-instant
  // for higher TPM headroom on big requests, then alternates if those are
  // both rate-limited at once.
  const MODELS = [
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
    "gemma2-9b-it",
  ];
  const errors: string[] = [];
  let answer = "";
  let usedModel = "";

  for (const model of MODELS) {
    let resp: Response;
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
          max_tokens: 4096,
        }),
      });
    } catch (e) {
      errors.push(`${model}: fetch failed: ${(e as Error).message}`);
      continue;
    }

    // Fall through on retryable conditions: 429 (TPM/RPD quota), 413 (request
    // too large for this model's TPM), 404 (model unavailable), 400 with
    // model_decommissioned (Groq retired it).
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
      return jsonResponse({ error: `groq 400: ${text.slice(0, 400)}` }, 502, origin);
    }
    if (!resp.ok) {
      const text = await resp.text();
      return jsonResponse({ error: `groq ${resp.status}: ${text.slice(0, 400)}` }, 502, origin);
    }

    const data = await resp.json();
    answer = data?.choices?.[0]?.message?.content || "";
    if (answer) { usedModel = model; break; }
    errors.push(`${model}: empty response`);
  }

  if (!answer) {
    return jsonResponse({ error: "all groq models exhausted: " + errors.join(" | ") }, 502, origin);
  }

  return jsonResponse({ answer, model: usedModel }, 200, origin);
});
