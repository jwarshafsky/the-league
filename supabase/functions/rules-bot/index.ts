// rules-bot — Supabase Edge Function. Routes a user question through Gemini
// Flash with the league constitution + the asker's team context as system
// prompt. Free-tier-friendly: gemini-2.0-flash gives 1500 req/day per project.
//
// Required secrets (Supabase dashboard → Project Settings → Edge Functions):
//   GEMINI_API_KEY    — from https://aistudio.google.com/app/apikey
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

// Site guide — describes the app's tabs and features so the bot can answer
// "where do I find X" / "how do I do Y" questions.
const SITE_GUIDE = `
The League app (https://jwarshafsky.github.io/the-league/) is a static web app
backed by Supabase for auth and data. Sign in with Google or with an email
magic link / 6-digit OTP code (the OTP code field is the workaround if your
email client eats the magic link).

# Header
- "The League" link in the top-left opens the ESPN league page (id 1200).
- The pill on the right shows your name + your role (★ for commissioner).
- Commissioners can click their name to flip into "Manager view" (👁) — a UI
  preview of what regular owners see. Server permissions are unchanged.
- "X online" + the hover tooltip lists owners currently active.

# Tabs (left to right)
- **Select Keepers**: pick keepers, MiLB keepers, Rule 5 protections, and
  trade-block flags via checkboxes. Caps (8 ML / 10 MiL / 25 Rule 5) shown
  in summary bar — red number means over the cap. Pressing a Keep box
  auto-protects via Rule 5; un-checking Rule 5 also unkeeps. After the
  keeper deadline (commish-set lock), only commish can edit.
- **Keepers**: read-only summary of each team's locked-in 2026 keepers and
  contract status, including \"$10 send down fee\" badges (accumulated by
  count of demotions — $10, $20, $30 …).
- **Rule 5 Draft**: snake draft from non-protected pool. "Pick" submits a
  selection (creates a $1 trade in the trade log). "Pass" skips. Commish
  can "Undo Last" to reverse the most recent pick.
- **Minors Draft**: 7-round reverse-standings draft. Click a pick to open
  the editor — set/edit player, edit notes, delete a pick, "Reset to
  Original Owner" appears whenever the current owner ≠ the original
  (works for both manual overrides and trade-log-derived ownership).
- **Minors Rosters**: pick a team or "All Teams". For your own team
  (or as commish on any team), each minor leaguer has a "Call Up" button;
  callups have a "Send Down" button when eligible. Salaries are not
  prompted — call-up prices are set in the offseason via Set Price on
  Select Keepers.
- **Trade Block**: a card per team showing players each owner has flagged.
  "Propose Trade" pre-fills the composer.
- **Trade Inbox**: full proposal lifecycle — create, counter, accept,
  reject, message thread per proposal. Red (N) badge counts new pending
  proposals + new messages directed at you.
- **Trade Log**: every accepted trade. Commissioners can Edit or Delete
  any trade in place.
- **Activity**: chronological feed of every meaningful action (keeper
  toggles, trades, callups, picks, etc.). Commissioners get an "undo"
  link on every entry — clicking deletes the log row and reverses the
  underlying action where possible (toggles, trades, picks, callups,
  callup prices, lock state, commish overrides).
- **League History**: trophy room — past seasons' standings (auto-pulled
  from ESPN, but stored as a static snapshot so it's independent of live
  ESPN). Click "Full standings" on a year to see the full rank table.
- **League Rules**: this constitution. Commissioners see an Edit button
  that opens a textarea — saves persist to Supabase.

# Common tasks
- Lock keepers (commish): Select Keepers tab → "Lock Keepers" button.
  Click again to unlock.
- Set a call-up price (commish): Select Keepers → MiLB section →
  "Set Price" link next to a player → enter price (1, 3, 5, 10, 15, or
  custom) and year. Used for keeper-value math.
- Override a player's contract (commish): Select Keepers → click the
  ⚙ icon next to a contract to open the Commish Editor.
- Send an invite to a new owner: handled outside the app, via
  scripts/send_invite.py. The allowlist is the invited_emails Supabase
  table; public sign-up is disabled.

# Caching note
- Every code change bumps the ?v=N query string in index.html. If the
  user reports stale UI, suggest hard-reload or share the current
  https://jwarshafsky.github.io/the-league/?v=N URL.
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
  const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");

  if (!GEMINI_API_KEY) return jsonResponse({ error: "GEMINI_API_KEY not configured" }, 500, origin);

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

  let payload: { question?: string; history?: { role: string; content: string }[] };
  try { payload = await req.json(); } catch { return jsonResponse({ error: "bad json" }, 400, origin); }
  const question = (payload.question || "").trim();
  if (!question) return jsonResponse({ error: "empty question" }, 400, origin);
  if (question.length > 2000) return jsonResponse({ error: "question too long (max 2000 chars)" }, 400, origin);
  const history = (payload.history || []).slice(-10).filter(m => m && typeof m.content === "string");

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
    "=== SITE GUIDE ===",
    SITE_GUIDE,
    "",
    "=== CONSTITUTION ===",
    constitution,
    "",
    "=== ASKER'S KEEPER SELECTIONS ===",
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

  // Gemini conversation: a single "user" turn carries the system prompt + the
  // first message; subsequent turns alternate user/model. (Gemini doesn't have
  // a dedicated system role on the v1beta endpoint we use.)
  const contents = [
    { role: "user", parts: [{ text: systemPrompt + "\n\n=== QUESTION ===\n" + (history.length ? "(see conversation below)" : question) }] },
  ];
  if (history.length) {
    contents.push({ role: "model", parts: [{ text: "Understood. I'll help with rules and your team's data." }] });
    for (const m of history) {
      contents.push({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] });
    }
    contents.push({ role: "user", parts: [{ text: question }] });
  }

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
  let geminiResp: Response;
  try {
    geminiResp = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents,
        generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
      }),
    });
  } catch (e) {
    return jsonResponse({ error: "gemini fetch failed: " + (e as Error).message }, 502, origin);
  }

  if (!geminiResp.ok) {
    const text = await geminiResp.text();
    return jsonResponse({ error: `gemini ${geminiResp.status}: ${text.slice(0, 400)}` }, 502, origin);
  }

  const geminiData = await geminiResp.json();
  const answer: string = geminiData?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text || "").join("") || "";
  if (!answer) {
    return jsonResponse({ error: "empty response from model", debug: geminiData }, 502, origin);
  }

  return jsonResponse({ answer }, 200, origin);
});
