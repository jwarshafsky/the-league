// League Message Board — slide-up panel triggered from the header 💬 icon.
//
// Same visual pattern as the CommishAI panel: fixed-position container at the
// bottom right of the viewport, with iOS keyboard handling so the input
// stays visible above the soft keyboard.
//
// Storage / RLS:
//   - Any signed-in owner can read all messages.
//   - INSERT requires team_id = my_team_id() (you post as your team).
//   - DELETE allowed for commissioners on any row, or authors on their own row.
//
// Server-side logic lives in js/db.js (dbGetMessages / postMessageAsync /
// deleteMessageAsync / clearAllMessagesAsync). This file is pure UI.

(function () {
  "use strict";

  let _open = false;
  let _mounted = false;

  function _ensureMounted() {
    if (_mounted) return;
    if (typeof document === "undefined" || !document.body) return;
    const root = document.createElement("div");
    root.id = "msgboard-root";
    root.innerHTML = `
      <div id="msgboard-panel" style="
        position:fixed;
        right:calc(20px + env(safe-area-inset-right, 0px));
        bottom:calc(84px + env(safe-area-inset-bottom, 0px));
        width:min(380px,calc(100vw - 32px));
        height:min(560px,calc(100vh - 120px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px)));
        background:var(--bg-card);
        border:1px solid var(--border);
        border-radius:14px;
        box-shadow:0 10px 40px rgba(0,0,0,0.45);
        z-index:991;
        display:none;
        flex-direction:column;
        overflow:hidden;
        font-family:inherit;
        transition:bottom 0.18s ease, height 0.18s ease;
      ">
        <div style="
          padding:13px 16px;
          background:linear-gradient(135deg,var(--accent-dim),#1e3a5f);
          color:#fff;
          display:flex;
          justify-content:space-between;
          align-items:center;
        ">
          <div>
            <div style="font-weight:700;font-size:0.95rem;letter-spacing:0.2px">League Message Board</div>
            <div style="font-size:0.7rem;color:rgba(255,255,255,0.7);margin-top:2px" id="msgboard-subtitle">Loading…</div>
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <button id="msgboard-clear" title="Clear all messages (commissioner only)" style="
              background:rgba(0,0,0,0.25);border:1px solid rgba(255,255,255,0.2);
              color:#fff;font-size:0.68rem;padding:4px 9px;border-radius:5px;cursor:pointer;display:none">
              Clear all
            </button>
            <button id="msgboard-close" aria-label="Close" style="
              background:none;border:none;color:#fff;font-size:1.3rem;cursor:pointer;
              padding:0 6px;line-height:1">×</button>
          </div>
        </div>
        <div id="msgboard-log" style="
          flex:1;
          overflow-y:auto;
          padding:14px 14px 8px 14px;
          display:flex;flex-direction:column;gap:8px;
          background:var(--bg);
        "></div>
        <form id="msgboard-form" style="
          border-top:1px solid var(--border);
          padding:10px 12px calc(10px + env(safe-area-inset-bottom, 0px)) 12px;
          background:var(--bg-card);
          display:flex;
          gap:8px;
          align-items:flex-end;
        ">
          <textarea id="msgboard-input" rows="1" placeholder="Write a message to the league…" maxlength="1000" style="
            flex:1;
            background:var(--bg);
            color:var(--text);
            border:1px solid var(--border);
            border-radius:8px;
            padding:9px 11px;
            font-size:16px;
            font-family:inherit;
            resize:none;
            min-height:38px;
            max-height:120px;
            line-height:1.4;
          "></textarea>
          <button id="msgboard-send" type="submit" style="
            background:var(--accent);
            color:#fff;
            border:none;
            border-radius:8px;
            padding:9px 14px;
            font-size:0.88rem;
            font-weight:600;
            cursor:pointer;
            white-space:nowrap;
          ">Post</button>
        </form>
      </div>
    `;
    document.body.appendChild(root);
    _mounted = true;

    document.getElementById("msgboard-close").addEventListener("click", _close);
    document.getElementById("msgboard-clear").addEventListener("click", _onClearAll);
    document.getElementById("msgboard-form").addEventListener("submit", _onSubmit);
    // Delegated delete — keeps the message id out of an inline onclick string
    // (no HTML-attribute escaping to get wrong).
    document.getElementById("msgboard-log").addEventListener("click", e => {
      const btn = e.target.closest("[data-msg-del]");
      if (btn) window._deleteMessage(btn.getAttribute("data-msg-del"));
    });
    document.getElementById("msgboard-input").addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        _onSubmit(e);
      }
    });
    document.getElementById("msgboard-input").addEventListener("input", _autoSize);

    // iOS keyboard handling — mirrors rules-bot.js. Tracks override state so
    // we only adjust positioning when there's actually a soft keyboard, and
    // restores the original CSS calc() positioning when it dismisses.
    try {
      const inputEl = document.getElementById("msgboard-input");
      const panel = document.getElementById("msgboard-panel");
      if (inputEl && panel && window.visualViewport) {
        let _bottomBackup = null;
        let _heightBackup = null;
        const apply = () => {
          try {
            const vv = window.visualViewport;
            const kbH = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
            if (kbH > 50) {
              if (_bottomBackup === null) {
                _bottomBackup = panel.style.bottom;
                _heightBackup = panel.style.height;
              }
              panel.style.bottom = (kbH + 8) + "px";
              panel.style.height = Math.min(560, vv.height - 16) + "px";
            } else if (_bottomBackup !== null) {
              panel.style.bottom = _bottomBackup;
              panel.style.height = _heightBackup;
              _bottomBackup = null;
              _heightBackup = null;
            }
          } catch (e) { console.warn("[msgboard] kb apply failed:", e); }
        };
        window.visualViewport.addEventListener("resize", apply);
        window.visualViewport.addEventListener("scroll", apply);
        inputEl.addEventListener("focus", apply);
        inputEl.addEventListener("blur", () => {
          // Restore on blur with a short delay — vv events sometimes fire late.
          setTimeout(() => {
            if (_bottomBackup !== null) {
              panel.style.bottom = _bottomBackup;
              panel.style.height = _heightBackup;
              _bottomBackup = null;
              _heightBackup = null;
            }
          }, 60);
        });
      }
    } catch (e) {
      console.warn("[msgboard] keyboard handler setup failed:", e);
    }
  }

  function _autoSize() {
    const t = document.getElementById("msgboard-input");
    if (!t) return;
    t.style.height = "auto";
    t.style.height = Math.min(120, t.scrollHeight) + "px";
  }

  function _open_panel() {
    _ensureMounted();
    // Mutually exclusive with the CommishAI panel — only one slide-up at a time.
    if (typeof window.closeRulesBot === "function") window.closeRulesBot();
    _open = true;
    const panel = document.getElementById("msgboard-panel");
    if (panel) panel.style.display = "flex";
    if (typeof window.lockBodyForOverlay === "function") window.lockBodyForOverlay("msgboard");
    _renderBoard();
    setTimeout(() => {
      const input = document.getElementById("msgboard-input");
      if (input && window.matchMedia && window.matchMedia("(pointer: fine)").matches) input.focus();
    }, 50);
  }

  function _close() {
    _open = false;
    const panel = document.getElementById("msgboard-panel");
    if (panel) panel.style.display = "none";
    if (typeof window.unlockBodyForOverlay === "function") window.unlockBodyForOverlay("msgboard");
  }

  // Expose close so the chatbot can dismiss us when it opens.
  window.closeMessageBoard = _close;

  function _toggle() {
    if (_open) _close();
    else _open_panel();
  }

  function _renderBoard() {
    _ensureMounted();
    const log = document.getElementById("msgboard-log");
    const subtitle = document.getElementById("msgboard-subtitle");
    const clearBtn = document.getElementById("msgboard-clear");
    if (!log || !subtitle || !clearBtn) return;

    const isCommish = typeof isCommissioner === "function" && isCommissioner();
    const myTeam = (typeof currentOwner !== "undefined" && currentOwner) ? currentOwner.team_id : null;
    const myUid  = (typeof currentUser  !== "undefined" && currentUser)  ? currentUser.id      : null;
    clearBtn.style.display = isCommish ? "inline-block" : "none";

    const messages = (typeof dbGetMessages === "function") ? dbGetMessages() : [];
    subtitle.textContent = messages.length
      ? `${messages.length} message${messages.length === 1 ? "" : "s"}`
      : "No messages yet — say something!";

    if (!messages.length) {
      log.innerHTML = '<div style="color:var(--text-dim);font-size:0.85rem;font-style:italic;text-align:center;padding:30px 12px">No messages yet. Be the first to post 👋</div>';
      return;
    }

    log.innerHTML = messages.map(m => {
      const team = (typeof LEAGUE_DATA !== "undefined")
        ? LEAGUE_DATA.teams.find(t => t.id === m.team_id) : null;
      const name = team ? team.name : (m.team_id || "?");
      const when = _relTime(m.created_at);
      const canDelete = isCommish || (myUid && m.user_id === myUid);
      const isMine = m.team_id === myTeam;
      const align = isMine ? "flex-end" : "flex-start";
      const bg = isMine ? "var(--accent)" : "var(--bg-card)";
      const fg = isMine ? "#fff" : "var(--text)";
      const dim = isMine ? "rgba(255,255,255,0.75)" : "var(--text-dim)";
      const deleteBtn = canDelete
        ? `<button data-msg-del="${_esc(m.id)}" title="Delete" style="background:none;border:none;color:${dim};font-size:0.78rem;cursor:pointer;padding:0 0 0 6px;line-height:1">×</button>`
        : "";
      return `
        <div style="display:flex;justify-content:${align}">
          <div style="max-width:80%;background:${bg};color:${fg};padding:8px 12px;border-radius:12px;font-size:0.9rem;line-height:1.4">
            <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:3px">
              <span style="font-weight:700;font-size:0.78rem">${_esc(name)}</span>
              <span style="color:${dim};font-size:0.7rem">${_esc(when)}</span>
              ${deleteBtn}
            </div>
            <div style="white-space:pre-wrap;word-wrap:break-word">${_esc(m.body)}</div>
          </div>
        </div>
      `;
    }).join("");

    log.scrollTop = log.scrollHeight;
  }

  // Expose for the realtime callback in db.js.
  window._renderMessageBoard = _renderBoard;

  async function _onSubmit(e) {
    e.preventDefault();
    const input = document.getElementById("msgboard-input");
    const send = document.getElementById("msgboard-send");
    if (!input || !send) return;
    const body = input.value;
    if (!body.trim()) return;
    send.disabled = true;
    try {
      if (typeof postMessageAsync !== "function") throw new Error("Database not ready");
      await postMessageAsync(body);
      input.value = "";
      input.style.height = "auto";
      _renderBoard();
    } catch (err) {
      alert("Couldn't post: " + (err.message || err));
    } finally {
      send.disabled = false;
    }
  }

  async function _onClearAll() {
    if (typeof isCommissioner !== "function" || !isCommissioner()) return;
    if (!confirm("Delete ALL messages? This can't be undone.")) return;
    try {
      if (typeof clearAllMessagesAsync === "function") await clearAllMessagesAsync();
      _renderBoard();
    } catch (err) {
      alert("Couldn't clear: " + (err.message || err));
    }
  }

  window._deleteMessage = async function (id) {
    if (!id) return;
    const isCommish = typeof isCommissioner === "function" && isCommissioner();
    if (!confirm(isCommish ? "Delete this message?" : "Delete your message?")) return;
    try {
      if (typeof deleteMessageAsync === "function") await deleteMessageAsync(id);
      _renderBoard();
    } catch (err) {
      alert("Couldn't delete: " + (err.message || err));
    }
  };

  function _esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
      ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  }
  function _relTime(ts) {
    if (!ts) return "";
    const ms = Date.now() - new Date(ts).getTime();
    if (ms < 60_000) return "just now";
    if (ms < 3_600_000) return Math.floor(ms / 60_000) + "m ago";
    if (ms < 86_400_000) return Math.floor(ms / 3_600_000) + "h ago";
    return Math.floor(ms / 86_400_000) + "d ago";
  }

  // Public entry point — called from the header 💬 button.
  window.toggleMessageBoard = function () {
    if (typeof currentOwner === "undefined" || !currentOwner) {
      alert("Sign in to use the message board.");
      return;
    }
    _toggle();
  };
})();
