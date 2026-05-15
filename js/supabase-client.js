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
// False until the first refreshAuthState() finishes. Listeners (e.g. authGate)
// check this so they can render a "Loading…" splash instead of the claim-team
// screen during the window where currentUser is set but currentOwner hasn't
// been fetched yet.
let _authResolved = false;
function isAuthResolved() { return _authResolved; }
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

// Set to true the first time we validate an email against the allowlist for
// the current page load. Skips re-checking on every reload / token refresh,
// which previously signed users out when the RPC timed out (e.g. an iPad
// reconnecting to cellular). The DB's RLS is the real authorization gate;
// this is only a UX message for OAuth signups not yet on the invite list.
let _allowlistChecked = false;

async function refreshAuthState(opts) {
  const isNewSignIn = !!(opts && opts.checkAllowlist);
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session && session.user) {
    currentUser = { id: session.user.id, email: session.user.email };

    // Only validate the allowlist on a fresh sign-in. Restored sessions
    // (page reload, token refresh) already passed this check the first
    // time they signed in.
    if (isNewSignIn && !_allowlistChecked) {
      const allowed = await isEmailAllowed(currentUser.email);
      _allowlistChecked = true;
      if (!allowed) {
        await supabaseClient.auth.signOut();
        currentUser = null;
        currentOwner = null;
        window.__leagueAuthError = "This email isn't on the league invite list yet. Ask a commissioner to add you.";
        fireAuthChange();
        return;
      }
    }

    currentOwner = await fetchOwnerRow(currentUser.id);
    // Auto-claim a pre-assigned team on first login.
    if (!currentOwner) {
      try {
        const { error } = await supabaseClient.rpc("claim_invited_team");
        if (error) {
          console.error("claim_invited_team error:", error);
          window.__leagueAuthError = "Couldn't auto-assign your team. Pick it manually below or ask a commissioner.";
        } else {
          currentOwner = await fetchOwnerRow(currentUser.id);
        }
      } catch (e) {
        console.error("Auto-claim threw:", e);
        window.__leagueAuthError = "Couldn't auto-assign your team. Pick it manually below or ask a commissioner.";
      }
    }
  } else {
    currentUser = null;
    currentOwner = null;
  }
  _authResolved = true;
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
  window.__leagueAuthError = null;
  await supabaseClient.auth.signOut();
}

// React to login/logout events from the SDK. Only revalidate the allowlist
// on a fresh SIGNED_IN — restored sessions (INITIAL_SESSION, TOKEN_REFRESHED)
// trust the prior validation so a flaky network can't sign the user out.
supabaseClient.auth.onAuthStateChange((event, session) => {
  // Diagnostic: append the last few auth events to localStorage so the
  // login-screen Diagnostics panel can show what triggered an unexpected
  // sign-out (token refresh failure, etc.). Cap at 10 entries.
  try {
    const log = JSON.parse(localStorage.getItem("flm_auth_events") || "[]");
    log.push({
      t: new Date().toISOString(),
      e: event,
      hasSession: !!(session && session.user),
      online: navigator.onLine,
      visible: document.visibilityState,
    });
    while (log.length > 10) log.shift();
    localStorage.setItem("flm_auth_events", JSON.stringify(log));
  } catch {}
  refreshAuthState({ checkAllowlist: event === "SIGNED_IN" });
});

// Run once on script load to populate state from any existing session.
refreshAuthState();
