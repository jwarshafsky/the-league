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
      <button id="rules-bot-fab" title="Ask CommishAI"
        style="position:fixed;bottom:calc(20px + env(safe-area-inset-bottom, 0px));right:calc(20px + env(safe-area-inset-right, 0px));z-index:990;
               width:54px;height:54px;border-radius:50%;border:none;padding:0;
               background:transparent;color:#fff;font-size:1.5rem;line-height:54px;text-align:center;cursor:pointer;
               box-shadow:0 4px 14px rgba(0,0,0,0.35);display:none;overflow:hidden;
               touch-action:manipulation;-webkit-tap-highlight-color:transparent;user-select:none;-webkit-user-select:none"><img id="rules-bot-fab-icon" src="icons/commish-ai.png" alt="" style="position:absolute;top:50%;left:50%;width:135%;height:135%;transform:translate(-50%,-50%);object-fit:contain;pointer-events:none"></button>

      <div id="rules-bot-panel"
        style="position:fixed;bottom:calc(84px + env(safe-area-inset-bottom, 0px));right:calc(20px + env(safe-area-inset-right, 0px));z-index:991;
               width:min(380px,calc(100vw - 32px));
               height:min(560px,calc(100vh - 120px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px)));
               background:var(--bg-card);border:1px solid var(--border);
               border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,0.45);
               display:none;flex-direction:column;overflow:hidden">
        <div style="display:flex;align-items:center;justify-content:space-between;
                    gap:8px;padding:12px 14px;border-bottom:1px solid var(--border);
                    background:linear-gradient(135deg,var(--accent-dim),#1e3a5f)">
          <div style="font-weight:700;color:var(--text-bright);font-size:0.95rem;display:flex;align-items:center;gap:10px">Ask CommishAI <img src="icons/commish-ai.png" alt="" style="width:48px;height:48px"></div>
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
          style="display:flex;gap:8px;padding:10px 10px 4px;border-top:1px solid var(--border);
                 background:var(--bg)">
          <input type="text" id="rules-bot-input" autocomplete="off"
            placeholder="Ask CommishAI…"
            style="flex:1;background:var(--bg-card);color:var(--text);
                   border:1px solid var(--border);border-radius:8px;
                   padding:8px 10px;font-size:16px">
          <button type="submit" id="rules-bot-send"
            style="background:var(--accent);color:#fff;border:none;
                   padding:8px 14px;border-radius:8px;font-weight:600;
                   font-size:0.85rem;cursor:pointer">Send</button>
        </form>
        <div style="text-align:center;font-size:0.68rem;color:var(--text-dim);
                    padding:0 10px 8px;background:var(--bg);font-style:italic">
          CommishAI can make mistakes — when in doubt, verify with the human commissioners.
        </div>
      </div>
    `;
    document.body.appendChild(root);

    // One handler per button, bound to `click`. `click` fires once per user
    // tap on every platform we care about (incl. iOS PWA), where `pointerup`
    // was unreliable. Each button has its OWN debounce timestamp so opening
    // and immediately closing (FAB then ×) isn't blocked. The 50ms guard
    // only catches pathological browser-synthesized doubled events, well
    // below the ~150ms minimum human tap rate.
    const fabEl = document.getElementById("rules-bot-fab");
    const closeEl = document.getElementById("rules-bot-close");
    const _onTap = (next) => {
      let _last = 0;
      return (e) => {
        const now = Date.now();
        if (now - _last < 50) return;
        _last = now;
        if (e) { e.preventDefault?.(); e.stopPropagation?.(); }
        _toggle(next === undefined ? !_open : next);
      };
    };
    fabEl.addEventListener("click", _onTap(undefined));
    closeEl.addEventListener("click", _onTap(false));

    // iOS keyboard handling: pin the panel above the soft keyboard while the
    // input is focused. Listens to visualViewport (which IS reliable on iOS)
    // and computes the keyboard height as innerHeight - vv.height - vv.offsetTop.
    // Guarded so a failure here can't take down the FAB / toggle basics.
    try {
      const inputEl = document.getElementById("rules-bot-input");
      const panel = document.getElementById("rules-bot-panel");
      if (inputEl && panel && window.visualViewport) {
        // Smooth movement so the panel slides instead of jumping when the
        // keyboard animates in/out.
        panel.style.transition = "bottom 0.18s ease, height 0.18s ease";

        // Track whether we've actually overridden the panel's positioning so
        // we don't clobber the original inline styles when there's no
        // keyboard to lift the panel above. Clearing `panel.style.bottom`
        // when we never set it would erase the original `bottom: calc(...)`
        // and the panel would fall to top:auto / bottom:auto = 0,0.
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
          } catch (e) { console.warn("[rules-bot] kb apply failed:", e); }
        };

        // Re-apply on every focus + every viewport change while focused.
        let _bound = false;
        const bind = () => {
          if (_bound) return;
          _bound = true;
          window.visualViewport.addEventListener("resize", apply);
          window.visualViewport.addEventListener("scroll", apply);
        };
        const unbind = () => {
          if (!_bound) return;
          _bound = false;
          window.visualViewport.removeEventListener("resize", apply);
          window.visualViewport.removeEventListener("scroll", apply);
        };

        inputEl.addEventListener("focus", () => {
          bind();
          // Run apply a few times during the keyboard animation; iOS doesn't
          // always fire the resize event in time on the very first focus.
          [50, 200, 500].forEach(t => setTimeout(apply, t));
        });
        inputEl.addEventListener("blur", () => {
          unbind();
          // Only restore originals if we actually overrode them.
          if (_bottomBackup !== null) {
            panel.style.bottom = _bottomBackup;
            panel.style.height = _heightBackup;
            _bottomBackup = null;
            _heightBackup = null;
          }
        });
      }
    } catch (e) { console.warn("[rules-bot] keyboard handler setup failed:", e); }
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
    if (_open) {
      fab.innerHTML = "×";
    } else {
      fab.innerHTML = '<img id="rules-bot-fab-icon" src="icons/commish-ai.png" alt="" style="position:absolute;top:50%;left:50%;width:135%;height:135%;transform:translate(-50%,-50%);object-fit:contain;pointer-events:none">';
    }
    // Mutually exclusive with the message board — only one slide-up at a time.
    if (_open && typeof window.closeMessageBoard === "function") window.closeMessageBoard();
    if (_open) _renderLog();
    // Note: deliberately NOT auto-focusing the input on open — on iOS PWA
    // that triggers the soft keyboard immediately, which combined with our
    // visualViewport listener was causing the panel to resize/reposition
    // before the user had a chance to read the greeting. The user taps the
    // input themselves when they're ready to type.
  }

  function _renderLog() {
    const log = document.getElementById("rules-bot-log");
    if (!log) return;
    const turns = _loadHistory();
    if (!turns.length) {
      log.innerHTML = `
        <div style="color:var(--text-dim);font-size:0.82rem;line-height:1.55">
          Hi, I'm CommishAI. I can answer:
          <ul style="margin:8px 0 0 18px;padding:0">
            <li>Rules questions (cited from the constitution)</li>
            <li>How to use this site</li>
            <li>Questions about your team's keepers, trades, and roster</li>
          </ul>
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

      // Include the asker's currently-computed roster (post-trades, post-callups)
      // with keeper-eligibility math already applied. Static data.js can't be
      // pulled server-side easily; the frontend has the live adjusted roster
      // plus the authoritative contract-status helpers.
      const teamId = currentOwner?.team_id;
      const myTeam = (typeof LEAGUE_DATA !== "undefined" && teamId)
        ? LEAGUE_DATA.teams.find(t => t.id === teamId)
        : null;
      const annotateMajor = (p) => {
        try {
          const cs = (typeof getContractStatus === "function") ? getContractStatus(p, CURRENT_SEASON) : null;
          const lastKeepableYear = cs ? CURRENT_SEASON + cs.yearsRemaining : null;
          return { ...p, keeperLastYear: lastKeepableYear, nextYearPrice: cs?.nextYearPrice ?? null, contractStatus: cs?.status ?? null };
        } catch { return p; }
      };
      const annotateMinor = (p) => {
        try {
          const ms = (typeof getMinorLeagueContractStatus === "function") ? getMinorLeagueContractStatus(p, CURRENT_SEASON) : null;
          const lastKeepableYear = (ms && ms.yearsRemaining !== null) ? CURRENT_SEASON + ms.yearsRemaining : null;
          return { ...p, keeperLastYear: lastKeepableYear, contractNote: ms?.contractNote ?? null, eligibilityWarning: ms?.eligibilityWarning ?? null };
        } catch { return p; }
      };
      // Callups that aren't on the ESPN roster have been dropped — exclude them.
      const teamIdForFilter = myTeam?.id;
      const isActiveCallup = (p) => {
        if (typeof getMinorTeamStatus !== "function" || !teamIdForFilter) return true;
        return getMinorTeamStatus(p.name, teamIdForFilter) === "on-roster";
      };

      // data.js's majors only carry keepers locked in pre-auction. The 2026
      // auction picks are on the ESPN roster but not in data.js. Merge them
      // in so the bot sees the full ML roster. ESPN draftPicks carry
      // bidAmount + keeper flag; for non-keepers, yearAcquired is this season.
      function buildMergedMajors() {
        const baseList = (myTeam.majors || []);
        if (typeof getEspnSnapshot !== "function") return baseList;
        const snap = getEspnSnapshot();
        const espnTeam = snap?.teams?.find(t => ESPN_ABBREV_TO_LOCAL?.[t.abbrev] === myTeam.id);
        if (!espnTeam) return baseList;

        const dataJsNames = new Set(baseList.map(p => p.name));
        const callupNames = new Set((myTeam.callups || []).map(p => p.name));
        const minorNames = new Set((myTeam.minors || []).map(p => p.name));

        const picksByPlayerId = {};
        for (const pick of (snap.draftPicks || [])) {
          if (pick.teamId === espnTeam.espnId) picksByPlayerId[pick.playerId] = pick;
        }

        const synthesized = [];
        for (const ep of (espnTeam.roster || [])) {
          if (dataJsNames.has(ep.name)) continue;
          if (callupNames.has(ep.name) || minorNames.has(ep.name)) continue;
          const pick = picksByPlayerId[ep.playerId];
          if (pick && !pick.keeper) {
            synthesized.push({
              name: ep.name,
              price: pick.bidAmount,
              yearAcquired: CURRENT_SEASON,
              source: "auction",
              fromMinors: false,
            });
          } else if (!pick) {
            // No draft pick → likely FA pickup. §2(b): keepable at $6 first yr.
            synthesized.push({
              name: ep.name,
              price: 6,
              yearAcquired: CURRENT_SEASON,
              source: "fa",
              fromMinors: false,
            });
          } else {
            // Keeper not in data.js — unusual; include with what we know
            synthesized.push({
              name: ep.name,
              price: pick.bidAmount,
              yearAcquired: CURRENT_SEASON,
              source: "auction",
              fromMinors: false,
            });
          }
        }
        return [...baseList, ...synthesized];
      }

      const mergedMajors = buildMergedMajors();
      const rosterPayload = myTeam ? {
        team_id: myTeam.id,
        name: myTeam.name,
        currentSeason: (typeof CURRENT_SEASON !== "undefined") ? CURRENT_SEASON : null,
        majors: mergedMajors.map(annotateMajor),
        minors: (myTeam.minors || []).map(annotateMinor),
        callups: (myTeam.callups || []).filter(isActiveCallup).map(annotateMajor),
      } : null;

      // Compact per-team league index for cross-team questions ("when does
      // Workman's contract expire?"). Format: one block per team with
      //   teamId M: Name$price→year, ...
      //   teamId m: Name→year, ...
      // Excludes the asker's own team (their full roster goes separately).
      // Goal: stay well under Groq's 6k TPM ceiling for the 8B fallback.
      function buildLeagueIndex() {
        if (typeof getEspnSnapshot !== "function" || typeof CURRENT_SEASON === "undefined") return [];
        const snap = getEspnSnapshot();
        if (!snap) return [];
        const lines = [];
        const ySuffix = (yr) => yr === "?" ? "?" : String(yr).slice(-2); // 2028 → "28"
        for (const team of LEAGUE_DATA.teams) {
          if (myTeam && team.id === myTeam.id) continue; // asker's own team is in rosterPayload
          const espnTeam = snap.teams.find(t => ESPN_ABBREV_TO_LOCAL?.[t.abbrev] === team.id);
          const picksByPlayerId = {};
          if (espnTeam) {
            for (const pick of (snap.draftPicks || [])) {
              if (pick.teamId === espnTeam.espnId) picksByPlayerId[pick.playerId] = pick;
            }
          }
          const dataJsNames = new Set((team.majors || []).map(p => p.name));
          const callupNames = new Set((team.callups || []).map(p => p.name));
          const minorNames = new Set((team.minors || []).map(p => p.name));

          const majors = [];
          for (const p of (team.majors || [])) {
            try {
              const cs = getContractStatus(p, CURRENT_SEASON);
              majors.push(`${p.name}$${p.price}→${ySuffix(CURRENT_SEASON + cs.yearsRemaining)}`);
            } catch { /* skip */ }
          }
          if (espnTeam) {
            for (const ep of (espnTeam.roster || [])) {
              if (dataJsNames.has(ep.name) || callupNames.has(ep.name) || minorNames.has(ep.name)) continue;
              const pick = picksByPlayerId[ep.playerId];
              const price = pick ? pick.bidAmount : 6;
              const synth = { name: ep.name, price, yearAcquired: CURRENT_SEASON, fromMinors: false };
              try {
                const cs = getContractStatus(synth, CURRENT_SEASON);
                majors.push(`${ep.name}$${price}→${ySuffix(CURRENT_SEASON + cs.yearsRemaining)}`);
              } catch { /* skip */ }
            }
          }
          for (const p of (team.callups || [])) {
            if (typeof getMinorTeamStatus === "function" &&
                getMinorTeamStatus(p.name, team.id) !== "on-roster") continue;
            try {
              const cs = getContractStatus(p, CURRENT_SEASON);
              majors.push(`${p.name}(C)→${ySuffix(CURRENT_SEASON + cs.yearsRemaining)}`);
            } catch { /* skip */ }
          }
          const minors = [];
          for (const p of (team.minors || [])) {
            try {
              const ms = getMinorLeagueContractStatus(p, CURRENT_SEASON);
              const last = (ms && ms.yearsRemaining !== null) ? CURRENT_SEASON + ms.yearsRemaining : "C+3";
              minors.push(`${p.name}→${ySuffix(last)}`);
            } catch { /* skip */ }
          }
          if (majors.length) lines.push(`${team.id} ML: ${majors.join(", ")}`);
          if (minors.length) lines.push(`${team.id} MiL: ${minors.join(", ")}`);
        }
        return lines;
      }

      const leagueIndex = buildLeagueIndex();
      const resp = await fetch(FN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + session.access_token,
          "apikey": (typeof SUPABASE_ANON_KEY !== "undefined" ? SUPABASE_ANON_KEY : ""),
        },
        body: JSON.stringify({
          question,
          history: turns.slice(0, -1).slice(-4),
          myRoster: rosterPayload,
          leagueIndex,
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

  function _syncFabVisibility() {
    const fab = document.getElementById("rules-bot-fab");
    if (!fab) return;
    const signedIn = (typeof currentOwner !== "undefined" && !!currentOwner);
    fab.style.display = signedIn ? "block" : "none";
  }

  // Show / hide the FAB based on auth state. Reacts immediately via
  // onAuthChange callback; keeps a slow poll as safety net.
  function _watchAuth() {
    if (typeof onAuthChange === "function") {
      onAuthChange(() => _syncFabVisibility());
    }
    setInterval(_syncFabVisibility, 4000);
  }

  function init() {
    _ensureMounted();
    _watchAuth();
    // Expose close so the message board can dismiss us when it opens.
    window.closeRulesBot = () => _toggle(false);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
