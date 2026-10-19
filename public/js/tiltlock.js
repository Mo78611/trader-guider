"use strict";
/* ============================================================================
 * Trader Guider — Tilt-Lock overtrading blocker (frontend).
 * ----------------------------------------------------------------------------
 * Topbar 🛡 button → modal: pick mode (N consecutive losses | X% daily
 * drawdown), limits, cooldown hours, account balance. When the server says
 * the lock is active, BUY/SELL are disabled and a countdown banner shows
 * "🔒 Tilt-Lock active — HH:MM:SS remaining to protect capital."
 *
 * Manual override needs the user to type UNLOCK (deliberate friction).
 * The server ALSO enforces the lock (HTTP 423) so the UI can't be bypassed.
 * ========================================================================== */
window.TGTilt = (function () {
  "use strict";

  const S = {
    locked: false, remainingSec: 0, reason: "", stats: null,
    settings: null, timer: null, countTimer: null,
  };

  function num(x) { return typeof x === "number" && isFinite(x); }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function fmtCountdown(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = String(Math.floor(sec / 3600)).padStart(2, "0");
    const m = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
    const s = String(sec % 60).padStart(2, "0");
    return `${h}:${m}:${s}`;
  }

  async function refresh() {
    try {
      const j = await fetch("/api/execute/tilt").then((r) => r.json());
      if (j && !j.error) {
        S.locked = !!j.locked;
        S.remainingSec = j.remainingSec || 0;
        S.reason = j.reason || "";
        S.stats = j.stats || null;
        S.settings = j.settings || S.settings;
        applyLockUI();
        renderModalStatus();
      }
    } catch (_e) { /* keep previous state on failure */ }
  }

  function applyLockUI() {
    const buy = document.getElementById("buyBtn");
    const sell = document.getElementById("sellBtn");
    const btn = document.getElementById("tiltBtn");
    for (const b of [buy, sell]) {
      if (!b) continue;
      b.disabled = S.locked;
      b.classList.toggle("tilt-frozen", S.locked);
    }
    if (btn) {
      btn.classList.toggle("tilt-active", S.locked);
      btn.textContent = S.locked ? "🔒 Tilt-Lock" : "🛡 Tilt-Lock";
      btn.title = S.locked
        ? `Frozen: ${S.reason || "loss limit hit"} — ${fmtCountdown(S.remainingSec)} left`
        : "Overtrading blocker — set your daily loss limit";
    }
    let banner = document.getElementById("tiltBanner");
    if (S.locked) {
      if (!banner) {
        banner = document.createElement("div");
        banner.id = "tiltBanner";
        banner.className = "tilt-banner";
        const sec = document.getElementById("execSec");
        if (sec) sec.prepend(banner);
      }
      banner.style.display = "block";
      banner.innerHTML = `🔒 <b>Tilt-Lock active</b> — ${esc(S.reason || "loss limit hit")}.<br>` +
        `<span id="tiltCount">${fmtCountdown(S.remainingSec)}</span> remaining to protect capital.`;
    } else if (banner) {
      banner.style.display = "none";
    }
    // tick the countdown locally every second
    clearInterval(S.countTimer);
    if (S.locked) {
      S.countTimer = setInterval(() => {
        S.remainingSec = Math.max(0, S.remainingSec - 1);
        const el = document.getElementById("tiltCount");
        if (el) el.textContent = fmtCountdown(S.remainingSec);
        if (S.remainingSec <= 0) refresh();
      }, 1000);
    }
  }

  function isLocked() { return S.locked; }

  /* ---------------- modal ---------------- */
  function ensureModal() {
    if (document.getElementById("tiltModal")) return;
    const back = document.createElement("div");
    back.className = "modal-back";
    back.id = "tiltModal";
    back.innerHTML = `
      <div class="modal">
        <h2>🛡 Tilt-Lock — overtrading blocker</h2>
        <div class="row"><label>Mode</label>
          <select id="tiltMode">
            <option value="losses">Consecutive losses</option>
            <option value="drawdown">Daily drawdown %</option>
          </select>
        </div>
        <div class="row" id="tiltLossesRow"><label>Max losses</label>
          <input id="tiltMaxLosses" type="number" min="1" max="20" step="1" value="3">
        </div>
        <div class="row" id="tiltDdRow" style="display:none"><label>Max drawdown %</label>
          <input id="tiltMaxDd" type="number" min="0.5" max="100" step="0.5" value="5">
        </div>
        <div class="row"><label>Cooldown (hrs)</label>
          <input id="tiltCooldown" type="number" min="0.25" max="72" step="0.25" value="4">
        </div>
        <div class="row"><label>Account $</label>
          <input id="tiltBalance" type="number" min="1" step="any" value="10000"
            title="Used for the drawdown % math">
        </div>
        <div class="row"><button class="btn wide" id="tiltSave">Save blocker</button></div>
        <div class="status-line" id="tiltMsg"></div>
        <hr style="border-color:var(--border);margin:12px 0">
        <div id="tiltStatusBox"></div>
        <div class="row" id="tiltUnlockRow" style="display:none">
          <label>Override</label>
          <input id="tiltUnlockInput" placeholder='Type UNLOCK' autocomplete="off" style="flex:1">
          <button class="btn" id="tiltUnlockBtn">Unlock</button>
        </div>
        <div class="row" style="margin-top:10px"><button class="btn wide" id="tiltClose">Done</button></div>
      </div>`;
    document.body.appendChild(back);
    back.addEventListener("click", (e) => { if (e.target === back) back.classList.remove("open"); });
    document.getElementById("tiltClose").onclick = () => back.classList.remove("open");
    document.getElementById("tiltMode").onchange = (e) => {
      const dd = e.target.value === "drawdown";
      document.getElementById("tiltLossesRow").style.display = dd ? "none" : "flex";
      document.getElementById("tiltDdRow").style.display = dd ? "flex" : "none";
    };
    document.getElementById("tiltSave").onclick = save;
    document.getElementById("tiltUnlockBtn").onclick = unlock;
  }

  function open() {
    ensureModal();
    const s = S.settings || {};
    document.getElementById("tiltMode").value = s.mode || "losses";
    document.getElementById("tiltMode").dispatchEvent(new Event("change"));
    document.getElementById("tiltMaxLosses").value = s.max_losses || 3;
    document.getElementById("tiltMaxDd").value = s.max_drawdown_pct || 5;
    document.getElementById("tiltCooldown").value = s.cooldown_hours || 4;
    document.getElementById("tiltBalance").value = s.balance || 10000;
    renderModalStatus();
    document.getElementById("tiltModal").classList.add("open");
  }

  function renderModalStatus() {
    const box = document.getElementById("tiltStatusBox");
    if (!box) return;
    const st = S.stats;
    const today = st
      ? `Today: ${st.closedToday} closed · ${st.consecLosses} consec. losses · P/L ${st.pnlDay >= 0 ? "+" : ""}${st.pnlDay} (${st.drawdownPct}% dd)`
      : "Today: no scored trades yet.";
    box.innerHTML =
      `<div style="font-size:13px;margin-bottom:6px">${esc(today)}</div>` +
      (S.locked
        ? `<div class="warn">🔒 <b>LOCKED</b> — ${esc(S.reason || "")}<br>` +
          `Unlocks in <b>${fmtCountdown(S.remainingSec)}</b>. Only scored (tracked) trades count.</div>`
        : `<div style="font-size:12px;color:var(--dim)">Blocker armed — not locked. ` +
          `Only trades closed through the tracker with an exit price are scored.</div>`);
    const ur = document.getElementById("tiltUnlockRow");
    if (ur) ur.style.display = S.locked ? "flex" : "none";
  }

  async function save() {
    const msg = document.getElementById("tiltMsg");
    msg.className = "status-line"; msg.textContent = "Saving…";
    try {
      const j = await fetch("/api/execute/tilt", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: document.getElementById("tiltMode").value,
          max_losses: parseInt(document.getElementById("tiltMaxLosses").value, 10),
          max_drawdown_pct: parseFloat(document.getElementById("tiltMaxDd").value),
          cooldown_hours: parseFloat(document.getElementById("tiltCooldown").value),
          balance: parseFloat(document.getElementById("tiltBalance").value),
        }),
      }).then((r) => r.json());
      if (j.error) { msg.className = "status-line err"; msg.textContent = "Save failed: " + j.error; return; }
      msg.className = "status-line okk"; msg.textContent = "Saved ✓ blocker armed.";
      await refresh();
    } catch (e) {
      msg.className = "status-line err"; msg.textContent = "Save failed: " + e.message;
    }
  }

  async function unlock() {
    const v = document.getElementById("tiltUnlockInput").value;
    const msg = document.getElementById("tiltMsg");
    try {
      const j = await fetch("/api/execute/tilt/unlock", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: v }),
      }).then((r) => r.json());
      if (j.error) { msg.className = "status-line err"; msg.textContent = j.detail || j.error; return; }
      document.getElementById("tiltUnlockInput").value = "";
      msg.className = "status-line okk"; msg.textContent = "Unlocked — trade carefully.";
      await refresh();
    } catch (e) {
      msg.className = "status-line err"; msg.textContent = "Unlock failed: " + e.message;
    }
  }

  function init() {
    // topbar button
    if (!document.getElementById("tiltBtn")) {
      const b = document.createElement("button");
      b.className = "link";
      b.id = "tiltBtn";
      b.textContent = "🛡 Tilt-Lock";
      b.title = "Overtrading blocker";
      b.onclick = open;
      const tb = document.querySelector(".topbar");
      const anchor = document.getElementById("liqBtn");
      if (tb) tb.insertBefore(b, anchor ? anchor.nextSibling : null);
    }
    refresh();
    clearInterval(S.timer);
    S.timer = setInterval(refresh, 30000);
  }

  return { init, open, refresh, isLocked };
})();
