// Floating chat widget that calls the rules-bot Supabase edge function.
// Conversation is per-user, persisted in localStorage. The button only
// appears once the user is signed in (we hook _bootRulesBot from the
// auth-completion path in app.js / supabase-client.js if available;
// otherwise we poll on first render).

(function () {
  const FN_URL = "https://fbllfkrtjsihrkwnbmlw.supabase.co/functions/v1/rules-bot";
  const STORAGE_KEY_PREFIX = "flm_rules_bot_history_v1_";
  const MAX_HISTORY = 20; // last 20 turns kept locally

  let _open = false;
  let _sending = false;

  function _historyKey() {
    const id = (typeof currentOwner !== "undefined" && currentOwner) ? currentOwner.id : "anon";
    return STORAGE_KEY_PREFIX + id;
  }

  function _loadHistory() {
    try { return JSON.parse(localStorage.getItem(_historyKey()) || "[]"); }
    catch { return []; }
  }

  function _saveHistory(turns) {
    try { localStorage.setItem(_historyKey(), JSON.stringify(turns.slice(-MAX_HISTORY))); }
    catch {}
  }

  function _clearHistory() {
    try { localStorage.removeItem(_historyKey()); } catch {}
  }

  function _esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // Minimal markdown: paragraphs, **bold**, *italic*, `code`, simple bullets.
  function _renderMessage(text) {
    const lines = String(text).split(/\r?\n/);
    const out = [];
    let inList = false;
    const inline = (s) => {
      let t = _esc(s);
      t = t.replace(/`([^`]+)`/g, '<code style="background:rgba(255,255,255,0.07);padding:1px 5px;border-radius:4px;font-size:0.92em">$1</code>');
      t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      t = t.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");
      return t;
    };
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, "");
      const bullet = line.match(/^\s*[-*]\s+(.*)$/);
      if (bullet) {
        if (!inList) { out.push('<ul style="margin:6px 0 6px 18px;padding:0">'); inList = true; }
        out.push(`<li style="margin:2px 0">${inline(bullet[1])}</li>`);
      } else {
        if (inList) { out.push("</ul>"); inList = false; }
        if (!line.trim()) continue;
        out.push(`<p style="margin:6px 0;line-height:1.5">${inline(line)}</p>`);
      }
    }
    if (inList) out.push("</ul>");
    return out.join("");
  }

  function _ensureMounted() {
    if (document.getElementById("rules-bot-root")) return;
    const root = document.createElement("div");
    root.id = "rules-bot-root";
    root.innerHTML = `
      <button id="rules-bot-fab" title="Ask the league rules bot"
        style="position:fixed;bottom:20px;right:20px;z-index:990;
               width:54px;height:54px;border-radius:50%;border:none;
               background:linear-gradient(135deg,var(--accent),#1e3a5f);
               color:#fff;font-size:1.5rem;cursor:pointer;
               box-shadow:0 4px 14px rgba(0,0,0,0.35);display:none">💬</button>

      <div id="rules-bot-panel"
        style="position:fixed;bottom:84px;right:20px;z-index:991;
               width:min(420px,calc(100vw - 32px));
               height:min(560px,calc(100vh - 120px));
               background:var(--bg-card);border:1px solid var(--border);
               border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,0.45);
               display:none;flex-direction:column;overflow:hidden">
        <div style="display:flex;align-items:center;justify-content:space-between;
                    gap:8px;padding:12px 14px;border-bottom:1px solid var(--border);
                    background:linear-gradient(135deg,var(--accent-dim),#1e3a5f)">
          <div style="font-weight:700;color:var(--text-bright);font-size:0.95rem">Ask the League</div>
          <div style="display:flex;gap:6px">
            <button id="rules-bot-clear" title="Clear conversation"
              style="background:rgba(255,255,255,0.12);border:none;color:#fff;
                     font-size:0.72rem;padding:4px 8px;border-radius:6px;cursor:pointer">Clear</button>
            <button id="rules-bot-close" title="Close"
              style="background:rgba(255,255,255,0.12);border:none;color:#fff;
                     font-size:0.85rem;padding:4px 9px;border-radius:6px;cursor:pointer">×</button>
          </div>
        </div>
        <div id="rules-bot-log" style="flex:1;overflow-y:auto;padding:12px 14px;
             font-size:0.86rem;color:var(--text);scroll-behavior:smooth"></div>
        <form id="rules-bot-form"
          style="display:flex;gap:8px;padding:10px;border-top:1px solid var(--border);
                 background:var(--bg)">
          <input type="text" id="rules-bot-input" autocomplete="off"
            placeholder="Ask a rules or site question…"
            style="flex:1;background:var(--bg-card);color:var(--text);
                   border:1px solid var(--border);border-radius:8px;
                   padding:8px 10px;font-size:0.88rem">
          <button type="submit" id="rules-bot-send"
            style="background:var(--accent);color:#fff;border:none;
                   padding:8px 14px;border-radius:8px;font-weight:600;
                   font-size:0.85rem;cursor:pointer">Send</button>
        </form>
      </div>
    `;
    document.body.appendChild(root);

    document.getElementById("rules-bot-fab").addEventListener("click", () => _toggle(!_open));
    document.getElementById("rules-bot-close").addEventListener("click", () => _toggle(false));
    document.getElementById("rules-bot-clear").addEventListener("click", () => {
      if (!confirm("Clear conversation?")) return;
      _clearHistory();
      _renderLog();
    });
    document.getElementById("rules-bot-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const input = document.getElementById("rules-bot-input");
      const q = input.value.trim();
      if (!q) return;
      input.value = "";
      _sendMessage(q);
    });
  }

  function _toggle(open) {
    _open = !!open;
    const panel = document.getElementById("rules-bot-panel");
    const fab = document.getElementById("rules-bot-fab");
    if (!panel || !fab) return;
    panel.style.display = _open ? "flex" : "none";
    fab.textContent = _open ? "×" : "💬";
    if (_open) {
      _renderLog();
      setTimeout(() => document.getElementById("rules-bot-input")?.focus(), 50);
    }
  }

  function _renderLog() {
    const log = document.getElementById("rules-bot-log");
    if (!log) return;
    const turns = _loadHistory();
    if (!turns.length) {
      log.innerHTML = `
        <div style="color:var(--text-dim);font-size:0.82rem;line-height:1.55">
          Hi! I'm the league assistant. I can answer:
          <ul style="margin:8px 0 0 18px;padding:0">
            <li>Rules questions (cited from the constitution)</li>
            <li>How to use this site</li>
            <li>Questions about your team's keepers, trades, and roster</li>
          </ul>
          <div style="margin-top:10px;font-style:italic">Try: "Can I keep a $42 player for 3 more years?"</div>
        </div>`;
      return;
    }
    log.innerHTML = turns.map(t => {
      const isUser = t.role === "user";
      return `
        <div style="margin-bottom:10px;display:flex;${isUser ? "justify-content:flex-end" : ""}">
          <div style="max-width:88%;padding:8px 12px;border-radius:12px;
                      background:${isUser ? "var(--accent-dim)" : "rgba(255,255,255,0.05)"};
                      border:1px solid ${isUser ? "var(--accent)" : "var(--border)"};
                      color:var(--text)">
            ${isUser ? _esc(t.content).replace(/\n/g, "<br>") : _renderMessage(t.content)}
          </div>
        </div>`;
    }).join("");
    log.scrollTop = log.scrollHeight;
  }

  async function _sendMessage(question) {
    if (_sending) return;
    _sending = true;

    const turns = _loadHistory();
    turns.push({ role: "user", content: question });
    _saveHistory(turns);
    _renderLog();

    const log = document.getElementById("rules-bot-log");
    const placeholder = document.createElement("div");
    placeholder.style.cssText = "margin-bottom:10px;color:var(--text-dim);font-size:0.82rem;font-style:italic";
    placeholder.textContent = "Thinking…";
    log.appendChild(placeholder);
    log.scrollTop = log.scrollHeight;

    document.getElementById("rules-bot-send").disabled = true;

    try {
      const session = (typeof supabaseClient !== "undefined")
        ? (await supabaseClient.auth.getSession()).data.session
        : null;
      if (!session) throw new Error("Not signed in");

      // Include the asker's currently-computed roster (post-trades, post-callups).
      // Static data.js can't be pulled server-side easily; the frontend already
      // has the live, adjusted roster in memory.
      const teamId = currentOwner?.team_id;
      const myTeam = (typeof LEAGUE_DATA !== "undefined" && teamId)
        ? LEAGUE_DATA.teams.find(t => t.id === teamId)
        : null;
      const rosterPayload = myTeam ? {
        team_id: myTeam.id,
        name: myTeam.name,
        majors: myTeam.majors || [],
        minors: myTeam.minors || [],
        callups: myTeam.callups || [],
      } : null;
      // All-team roster summary (sizes only) so the bot can answer
      // "how many minors does Corey have" type questions without leaking data.
      const allTeamsSummary = (typeof LEAGUE_DATA !== "undefined")
        ? LEAGUE_DATA.teams.map(t => ({
            team_id: t.id, name: t.name,
            majors: (t.majors || []).length,
            minors: (t.minors || []).length,
            callups: (t.callups || []).length,
          }))
        : [];

      const resp = await fetch(FN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + session.access_token,
          "apikey": (typeof SUPABASE_ANON_KEY !== "undefined" ? SUPABASE_ANON_KEY : ""),
        },
        body: JSON.stringify({
          question,
          history: turns.slice(0, -1).slice(-10),
          myRoster: rosterPayload,
          allTeamsSummary,
        }),
      });
      const data = await resp.json();
      placeholder.remove();

      if (!resp.ok) throw new Error(data?.error || ("HTTP " + resp.status));

      turns.push({ role: "assistant", content: data.answer || "(empty response)" });
      _saveHistory(turns);
      _renderLog();
    } catch (e) {
      placeholder.remove();
      turns.push({ role: "assistant", content: "_Error: " + (e.message || e) + "_" });
      _saveHistory(turns);
      _renderLog();
    } finally {
      _sending = false;
      const send = document.getElementById("rules-bot-send");
      if (send) send.disabled = false;
    }
  }

  // Show / hide the FAB based on auth state. Polls every 2s until we see
  // currentOwner; then keeps the visibility in sync via the same poll.
  function _watchAuth() {
    setInterval(() => {
      const fab = document.getElementById("rules-bot-fab");
      if (!fab) return;
      const signedIn = (typeof currentOwner !== "undefined" && !!currentOwner);
      fab.style.display = signedIn ? "block" : "none";
      if (!signedIn && _open) _toggle(false);
    }, 2000);
  }

  function init() {
    _ensureMounted();
    _watchAuth();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
