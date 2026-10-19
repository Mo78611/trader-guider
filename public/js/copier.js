"use strict";
/* ============================================================================
 * Trader Guider — Multi-account trade copier (frontend).
 * ----------------------------------------------------------------------------
 * Manages MT5 + Binance account lists and the copier switch. When the copier
 * is ON, oneClick() sends `copy: true` and the server fans the order out to
 * the selected accounts (MT5: proportional to balance; Binance: equal size).
 *
 * UI lives as a collapsible block at the bottom of the execution panel.
 * Default OFF. Every copy is logged server-side and shown in the receipt.
 * ========================================================================== */
window.TGCopier = (function () {
  "use strict";

  const S = {
    mt5Accounts: [], binAccounts: [],
    copier: { enabled: false, mt5AccountIds: [], binanceAccountIds: [] },
    open: false,
  };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  async function jget(url) {
    const r = await fetch(url);
    return r.json();
  }
  async function jpost(url, body) {
    const r = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  }

  async function load() {
    try {
      const [m, b, c] = await Promise.all([
        jget("/api/execute/mt5/accounts"),
        jget("/api/execute/binance/accounts"),
        jget("/api/execute/copier"),
      ]);
      S.mt5Accounts = Array.isArray(m.accounts) ? m.accounts : [];
      S.binAccounts = Array.isArray(b.accounts) ? b.accounts : [];
      if (c && !c.error) {
        S.copier = {
          enabled: !!c.enabled,
          mt5AccountIds: Array.isArray(c.mt5AccountIds) ? c.mt5AccountIds : [],
          binanceAccountIds: Array.isArray(c.binanceAccountIds) ? c.binanceAccountIds : [],
        };
      }
    } catch (_e) { /* offline: keep previous */ }
    render();
  }

  function copyEnabled() { return S.copier.enabled; }

  /** How many slave accounts would receive the next order for this target. */
  function copyCount(target) {
    if (!S.copier.enabled) return 0;
    if (target === "mt5") return S.copier.mt5AccountIds.length;
    return S.copier.binanceAccountIds.length;
  }

  /* ---------------- rendering ---------------- */
  function ensureSection() {
    if (document.getElementById("copySec")) return;
    const exec = document.getElementById("execSec");
    if (!exec) return;
    const sec = document.createElement("div");
    sec.id = "copySec";
    sec.className = "copy-sec";
    sec.innerHTML = `
      <div class="copy-head" id="copyHead">📋 Multi-account copier <span class="chev">▾</span></div>
      <div class="copy-body" id="copyBody" style="display:none"></div>`;
    exec.appendChild(sec);
    document.getElementById("copyHead").onclick = () => {
      S.open = !S.open;
      document.getElementById("copyBody").style.display = S.open ? "block" : "none";
      document.querySelector("#copyHead .chev").textContent = S.open ? "▴" : "▾";
    };
  }

  function accountRow(a, kind) {
    const checked = kind === "mt5"
      ? S.copier.mt5AccountIds.includes(a.id)
      : S.copier.binanceAccountIds.includes(a.id);
    const master = a.isMaster ? ` <span class="pill ok" style="font-size:10px">MASTER</span>` : "";
    const sub = kind === "mt5"
      ? `${esc(a.server)} · ${esc(a.accountId)}`
      : `${esc(a.venue)}`;
    return `<div class="copy-acct">
      <input type="checkbox" data-kind="${kind}" data-id="${a.id}" ${checked ? "checked" : ""}
        title="Include in copier" style="width:auto">
      <div style="flex:1"><div style="font-size:13px">${esc(a.label)}${master}</div>
      <div style="font-size:11px;color:var(--dim)">${sub}</div></div>
      <button class="btn" style="padding:4px 8px;font-size:11px" data-conn="${kind}:${a.id}">Connect</button>
      <button class="btn" style="padding:4px 8px;font-size:11px" data-del="${kind}:${a.id}" title="Remove">✕</button>
    </div>`;
  }

  function render() {
    ensureSection();
    const body = document.getElementById("copyBody");
    if (!body) return;
    const mt5Rows = S.mt5Accounts.length
      ? S.mt5Accounts.map((a) => accountRow(a, "mt5")).join("")
      : `<div style="font-size:12px;color:var(--dim)">No MT5 accounts yet.</div>`;
    const binRows = S.binAccounts.length
      ? S.binAccounts.map((a) => accountRow(a, "bin")).join("")
      : `<div style="font-size:12px;color:var(--dim)">No extra Binance key sets yet.</div>`;
    body.innerHTML = `
      <div class="row">
        <label style="flex:1">Copier ${S.copier.enabled ? "<b style='color:var(--green)'>ON</b>" : "<span style='color:var(--dim)'>OFF</span>"}</label>
        <button class="btn" id="copyToggle" style="padding:6px 12px">${S.copier.enabled ? "Turn OFF" : "Turn ON"}</button>
      </div>
      <div style="font-size:11px;color:var(--dim);margin-bottom:8px">
        Tick the accounts that receive a copy. MT5 copies are sized proportionally to balance; Binance copies use equal size. Default OFF. DRY_RUN simulates everything.
      </div>
      <div class="copy-sub">MT5 accounts</div>
      ${mt5Rows}
      <div class="row" style="margin-top:6px">
        <input id="copyMt5Label" placeholder="Label" style="max-width:90px">
        <input id="copyMt5Server" placeholder="Server" style="max-width:110px">
        <input id="copyMt5Acct" placeholder="Login" style="max-width:80px">
        <input id="copyMt5Pass" type="password" placeholder="Password" autocomplete="off" style="max-width:100px">
      </div>
      <div class="row"><button class="btn" id="copyMt5Add" style="flex:1">+ Add MT5 account</button></div>
      <div class="copy-sub" style="margin-top:8px">Binance key sets</div>
      ${binRows}
      <div class="row" style="margin-top:6px">
        <select id="copyBinVenue" style="max-width:150px">
          <option value="binance_spot">spot (testnet)</option>
          <option value="binance_futures">futures (testnet)</option>
          <option value="binance_spot_main">spot MAINNET</option>
          <option value="binance_futures_main">futures MAINNET</option>
        </select>
        <input id="copyBinLabel" placeholder="Label" style="max-width:90px">
      </div>
      <div class="row">
        <input id="copyBinKey" placeholder="API key" autocomplete="off">
        <input id="copyBinSec" type="password" placeholder="API secret" autocomplete="off">
      </div>
      <div class="row"><button class="btn" id="copyBinAdd" style="flex:1">+ Add Binance key set</button></div>
      <div class="status-line" id="copyMsg"></div>`;

    document.getElementById("copyToggle").onclick = saveCopier;
    body.querySelectorAll("input[data-kind]").forEach((cb) => {
      cb.onchange = saveCopier;
    });
    body.querySelectorAll("[data-del]").forEach((b) => {
      b.onclick = () => removeAccount(b.getAttribute("data-del"));
    });
    body.querySelectorAll("[data-conn]").forEach((b) => {
      b.onclick = () => connectAccount(b.getAttribute("data-conn"));
    });
    document.getElementById("copyMt5Add").onclick = addMt5;
    document.getElementById("copyBinAdd").onclick = addBinance;
  }

  function msg(t, err) {
    const el = document.getElementById("copyMsg");
    if (!el) return;
    el.className = "status-line" + (err ? " err" : " okk");
    el.textContent = t;
  }

  async function saveCopier() {
    const mt5 = [], bin = [];
    document.querySelectorAll('#copyBody input[data-kind="mt5"]:checked')
      .forEach((cb) => mt5.push(parseInt(cb.getAttribute("data-id"), 10)));
    document.querySelectorAll('#copyBody input[data-kind="bin"]:checked')
      .forEach((cb) => bin.push(parseInt(cb.getAttribute("data-id"), 10)));
    // The button shows the ACTION: "Turn ON" is shown while currently OFF,
    // so clicking it means the user wants it ON.
    const wantOn = document.getElementById("copyToggle").textContent.trim() === "Turn ON";
    const { json } = await jpost("/api/execute/copier", {
      enabled: wantOn, mt5AccountIds: mt5, binanceAccountIds: bin,
    });
    if (json.error) { msg("Save failed: " + json.error, true); return; }
    S.copier = { enabled: !!json.enabled, mt5AccountIds: json.mt5AccountIds || [],
      binanceAccountIds: json.binanceAccountIds || [] };
    msg(wantOn ? "Copier ON ✓" : "Copier OFF");
    render();
  }

  async function addMt5() {
    const label = document.getElementById("copyMt5Label").value.trim();
    const server = document.getElementById("copyMt5Server").value.trim();
    const accountId = document.getElementById("copyMt5Acct").value.trim();
    const password = document.getElementById("copyMt5Pass").value;
    if (!server || !accountId || !password) { msg("Server, login and password required.", true); return; }
    const { json } = await jpost("/api/execute/mt5/accounts", { label, server, accountId, password });
    if (json.error) { msg("Add failed: " + (json.detail || json.error), true); return; }
    msg("MT5 account added ✓ (encrypted)");
    await load();
  }

  async function addBinance() {
    const venue = document.getElementById("copyBinVenue").value;
    const label = document.getElementById("copyBinLabel").value.trim();
    const apiKey = document.getElementById("copyBinKey").value.trim();
    const apiSecret = document.getElementById("copyBinSec").value;
    if (!apiKey || !apiSecret) { msg("API key and secret required.", true); return; }
    if (venue.includes("_main") && !confirm("⚠ MAINNET key set — these keys can move REAL money. Add anyway?")) return;
    const { json } = await jpost("/api/execute/binance/accounts", { venue, label, apiKey, apiSecret });
    if (json.error) { msg("Add failed: " + (json.detail || json.error), true); return; }
    msg("Binance key set added ✓ (encrypted)");
    await load();
  }

  async function removeAccount(spec) {
    const [kind, id] = spec.split(":");
    if (!confirm("Remove this account from the copier?")) return;
    const url = kind === "mt5" ? `/api/execute/mt5/accounts/${id}` : `/api/execute/binance/accounts/${id}`;
    const r = await fetch(url, { method: "DELETE" });
    const j = await r.json().catch(() => ({}));
    if (j.error) { msg("Remove failed: " + j.error, true); return; }
    msg("Removed ✓");
    await load();
  }

  async function connectAccount(spec) {
    const [kind, id] = spec.split(":");
    msg("Connecting…");
    if (kind === "mt5") {
      const { json } = await jpost(`/api/execute/mt5/accounts/${id}/connect`, {});
      if (json.error) { msg("Connect failed: " + (json.detail || json.error), true); return; }
      const a = json.account || {};
      msg(`Connected ✓ ${a.login || ""} @ ${a.server || ""} — balance ${a.balance || "?"} ${a.currency || ""}`);
    } else {
      msg("Binance key sets need no connect step — they are used per order.", false);
    }
  }

  function init() {
    load();
  }

  return { init, load, copyEnabled, copyCount };
})();
