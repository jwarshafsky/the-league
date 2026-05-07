// Supabase client + auth helpers.
// Loaded after the Supabase UMD bundle from the CDN; uses window.supabase.

const SUPABASE_URL = "https://fbllfkrtjsihrkwnbmlw.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_aRh0MmQKrMCr8YnTwv9xIg_1F08WXf2";

// Beta allowlist — only these emails can request a magic link until we open
// it up league-wide. Add Dave's email when ready.
const BETA_ALLOWLIST = [
  "jwarshafsky@gmail.com",
];

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: "pkce",
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
    currentOwner = await fetchOwnerRow(currentUser.id);
  } else {
    currentUser = null;
    currentOwner = null;
  }
  fireAuthChange();
}

async function sendMagicLink(email) {
  const cleaned = (email || "").trim().toLowerCase();
  if (!BETA_ALLOWLIST.map(e => e.toLowerCase()).includes(cleaned)) {
    throw new Error("This is a private beta. Your email isn't on the allowlist yet.");
  }
  const { error } = await supabaseClient.auth.signInWithOtp({
    email: cleaned,
    options: { emailRedirectTo: window.location.origin + window.location.pathname },
  });
  if (error) throw error;
}

async function signOut() {
  await supabaseClient.auth.signOut();
}

// React to login/logout events from the SDK.
supabaseClient.auth.onAuthStateChange(() => { refreshAuthState(); });

// Run once on script load to populate state from any existing session.
refreshAuthState();
