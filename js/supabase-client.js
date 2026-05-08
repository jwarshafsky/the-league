// Supabase client + auth helpers.
// Loaded after the Supabase UMD bundle from the CDN; uses window.supabase.

const SUPABASE_URL = "https://fbllfkrtjsihrkwnbmlw.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_aRh0MmQKrMCr8YnTwv9xIg_1F08WXf2";

// Allowlist now lives in the invited_emails table (checked via RPC).
// FALLBACK_ALLOWLIST covers the case where the network call fails.
const FALLBACK_ALLOWLIST = [
  "jwarshafsky@gmail.com",
  "davidwarsh@gmail.com",
];

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    // Implicit flow lets a magic link sent to email work even when clicked
    // in a different browser/device than where it was requested. PKCE requires
    // the same browser context to hold the verifier.
    flowType: "implicit",
  },
});

// In-memory state, populated on auth.
let currentUser = null;       // { id, email }
let currentOwner = null;      // { team_id, is_commissioner }
const authListeners = [];

function onAuthChange(fn) {
  authListeners.push(fn);
  // Fire once with current state in case the caller missed earlier events.
  fn(currentUser, currentOwner);
}

function fireAuthChange() {
  authListeners.forEach(fn => {
    try { fn(currentUser, currentOwner); } catch (e) { console.error(e); }
  });
}

async function fetchOwnerRow(userId) {
  const { data, error } = await supabaseClient
    .from("owners")
    .select("team_id, is_commissioner")
    .eq("id", userId)
    .maybeSingle();
  if (error) {
    console.warn("Owner lookup failed:", error.message);
    return null;
  }
  return data;
}

async function refreshAuthState() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session && session.user) {
    currentUser = { id: session.user.id, email: session.user.email };

    // For OAuth (Google), users can land here without being on the allowlist —
    // gate them post-hoc. Magic-link flow is already gated client-side by isEmailAllowed.
    const allowed = await isEmailAllowed(currentUser.email);
    if (!allowed) {
      await supabaseClient.auth.signOut();
      currentUser = null;
      currentOwner = null;
      window.__leagueAuthError = "This email isn't on the league invite list yet. Ask a commissioner to add you.";
      fireAuthChange();
      return;
    }

    currentOwner = await fetchOwnerRow(currentUser.id);
    // Auto-claim a pre-assigned team on first login.
    if (!currentOwner) {
      try {
        const { error } = await supabaseClient.rpc("claim_invited_team");
        if (!error) currentOwner = await fetchOwnerRow(currentUser.id);
      } catch (e) {
        console.warn("Auto-claim failed:", e);
      }
    }
  } else {
    currentUser = null;
    currentOwner = null;
  }
  fireAuthChange();
}

async function signInWithGoogle() {
  const { error } = await supabaseClient.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: window.location.origin + window.location.pathname,
    },
  });
  if (error) throw error;
}

async function isEmailAllowed(email) {
  // Look up via Supabase RPC; fall back to the small hardcoded list if that fails.
  try {
    const { data, error } = await supabaseClient.rpc("is_email_invited", { email_to_check: email });
    if (!error && typeof data === "boolean") return data;
  } catch {}
  return FALLBACK_ALLOWLIST.map(e => e.toLowerCase()).includes(email.toLowerCase());
}

async function sendMagicLink(email) {
  const cleaned = (email || "").trim().toLowerCase();
  const ok = await isEmailAllowed(cleaned);
  if (!ok) {
    throw new Error("This email isn't on the league invite list yet. Ask a commissioner to add you.");
  }
  const { error } = await supabaseClient.auth.signInWithOtp({
    email: cleaned,
    options: { emailRedirectTo: window.location.origin + window.location.pathname },
  });
  if (error) throw error;
}

async function verifyEmailCode(email, code) {
  const cleaned = (email || "").trim().toLowerCase();
  const token = (code || "").trim();
  const { data, error } = await supabaseClient.auth.verifyOtp({
    email: cleaned,
    token,
    type: "email",
  });
  if (error) throw error;
  return data;
}

async function signOut() {
  await supabaseClient.auth.signOut();
}

// React to login/logout events from the SDK.
supabaseClient.auth.onAuthStateChange(() => { refreshAuthState(); });

// Run once on script load to populate state from any existing session.
refreshAuthState();
