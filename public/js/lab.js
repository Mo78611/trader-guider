"use strict";
/* ============================================================================
 * Trader Guider — Strategy Lab page (🧪).
 * Tabs: Strategy Lab (confluence builder + backtester), Footprints (personal
 * smart-money stats), Session DNA (per-session market personality).
 * ========================================================================== */
(function () {
  "use strict";

  const CONDITIONS = [
    ["fvg_tap", "ICT FVG tap"],
    ["ob_tap", "ICT Order Block tap"],
    ["sweep", "Liquidity Sweep"],
    ["vsa_climax", "VSA Climax"],
    ["vsa_ndns", "VSA No Demand / Supply"],
    ["tl_break", "Trendline Break"],
    ["tl_retest", "Trendline Retest"],
    ["sr_bounce", "S/R Bounce"],
    ["bos", "BOS / CHoCH"],
    ["rsi_div", "RSI Divergence"],
  ];
  const selected = new Set(["sweep", "fvg_tap"]);

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  async function api(path, opts) {
    const r = await fetch(path, opts);
    if (r.status === 401) { location.href = "/login"; throw new Error("auth"); }
    return r;
  }

  async function boot() {
    try {
      const me = await api("/api/auth/me").then((r) => r.json());
      const name = me.user && (me.user.name || me.user.email);
      if (name) $("labUser").textContent = name;
    } catch (_e) { /* stay anyway; api() redirects on 401 */ }

    // tabs
    document.querySelectorAll(".lab-tab").forEach((t) => {
      t.onclick = () => {
        document.querySelectorAll(".lab-tab").forEach((x) => x.classList.remove("active"));
        t.classList.add("active");
        for (const name of ["lab", "foot", "dna"])
          $("tab-" + name).style.display = t.dataset.tab === name ? "block" : "none";
        if (t.dataset.tab === "foot") loadFootprints();
        if (t.dataset.tab === "dna") loadDNA();
      };
    });

    // condition checklist
    const grid = $("condGrid");
    for (const [key, label] of CONDITIONS) {
      const d = document.createElement("label");
      d.className = "cond-item" + (selected.has(key) ? " on" : "");
      d.innerHTML = `<input type="checkbox" ${selected.has(key) ? "checked" : ""}> ${esc(label)}`;
      const box = d.querySelector("input");
      box.onchange = () => {
        if (box.checked) selected.add(key); else selected.delete(key);
        d.classList.toggle("on", box.checked);
      };
      grid.appendChild(d);
    }

    $("runBt").onclick = runBacktest;
    $("fpAdd").onclick = addFootprint;
    $("fpReload").onclick = loadFootprints;
    $("dnaLoad").onclick = loadDNA;
    $("logoutBtn").onclick = async () => {
      await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
      location.href = "/login";
    };
  }

  /* ---------------- backtest ---------------- */
  async function runBacktest() {
    const conds = [...selected];
    const logic = document.querySelector('input[name="logic"]:checked').value;
    if (conds.length < 1) { $("btStatus").textContent = "Pick at least 1 condition."; return; }
    if (logic === "AND" && conds.length < 2) {
      $("btStatus").textContent = "AND needs 2 or more conditions. Pick more, or use OR.";
      return;
    }
    if (conds.length > 5) {
      $("btStatus").textContent = "Max 5 conditions. Untick some.";
      return;
    }
    $("btStatus").textContent = "Running backtest on real history… this can take a few seconds.";
    $("btResult").style.display = "none";
    $("runBt").disabled = true;
    try {
      const r = await api("/api/lab/backtest", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: $("labSymbol").value.toUpperCase().replace(/[^A-Z0-9]/g, ""),
          interval: $("labTf").value, logic, conditions: conds,
          limit: parseInt($("labLook").value, 10),
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "failed");
      renderBacktest(j, logic);
      $("btStatus").textContent =
        `Done in ${(j.ms / 1000).toFixed(1)}s — ${j.bars} bars of ${j.symbol} ${j.interval}.`;
    } catch (e) {
      $("btStatus").textContent = "Backtest failed: " + (e.message === "auth" ? "login again." : "market data unavailable, try later.");
    } finally {
      $("runBt").disabled = false;
    }
  }

  function renderBacktest(j, logic) {
    $("btResult").style.display = "block";
    const wrCls = j.winRate >= 50 ? "good" : j.winRate >= 35 ? "" : "bad";
    const rCls = j.avgR >= 0.3 ? "good" : j.avgR >= 0 ? "" : "bad";
    $("btStats").innerHTML = `
      <div class="stat-box"><div class="v">${j.trades}</div><div class="l">Trades</div></div>
      <div class="stat-box"><div class="v ${wrCls}">${j.winRate}%</div><div class="l">Win rate</div></div>
      <div class="stat-box"><div class="v ${rCls}">${j.avgR}R</div><div class="l">Avg R</div></div>
      <div class="stat-box"><div class="v">${j.maxDD}R</div><div class="l">Max drawdown</div></div>
      <div class="stat-box"><div class="v">${logic}</div><div class="l">Logic</div></div>`;
    // equity curve SVG
    const svg = $("equitySvg");
    const eq = j.equity && j.equity.length > 1 ? j.equity : [0, 0];
    const W = 600, H = 180, P = 14;
    const mn = Math.min(...eq, 0), mx = Math.max(...eq, 0);
    const span = (mx - mn) || 1;
    const X = (i) => P + (i / (eq.length - 1)) * (W - 2 * P);
    const Y = (v) => H - P - ((v - mn) / span) * (H - 2 * P);
    const pts = eq.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
    const lastV = eq[eq.length - 1];
    const col = lastV >= 0 ? "#26a69a" : "#ef5350";
    svg.innerHTML =
      `<line x1="${P}" y1="${Y(0)}" x2="${W - P}" y2="${Y(0)}" stroke="#3a4356" stroke-width="1"/>` +
      `<polyline points="${pts}" fill="none" stroke="${col}" stroke-width="2"/>` +
      `<circle cx="${X(eq.length - 1)}" cy="${Y(lastV)}" r="4" fill="${col}"/>` +
      `<text x="${W - P - 4}" y="${Y(lastV) - 8}" fill="${col}" font-size="13" text-anchor="end" font-weight="bold">${lastV.toFixed(1)}R</text>`;
    $("btConds").innerHTML = j.perCondition.map((c) =>
      `<tr><td>${esc(c.label)}</td><td>${c.fired}</td><td>${c.wins}</td>` +
      `<td>${c.winRate == null ? "—" : c.winRate + "%"}</td></tr>`).join("");
    const lbl = Object.fromEntries(CONDITIONS);
    $("btTrades").innerHTML = j.sample.slice().reverse().map((t) =>
      `<tr><td>${esc(t.time)}</td><td style="color:${t.dir === "buy" ? "var(--green)" : "var(--red)"};font-weight:600">${t.dir.toUpperCase()}</td>` +
      `<td>${Number(t.entry).toLocaleString()}</td>` +
      `<td style="color:${t.r > 0 ? "var(--green)" : "var(--red)"}">${t.r > 0 ? "+" : ""}${t.r}R</td>` +
      `<td style="color:var(--dim)">${t.conds.map((c) => esc(lbl[c] || c)).join(", ")}</td></tr>`
    ).join("") || `<tr><td colspan="5" style="color:var(--dim)">No trades fired.</td></tr>`;
  }

  /* ---------------- footprints ---------------- */
  async function addFootprint() {
    $("fpStatus").textContent = "Saving…";
    try {
      const sym = $("fpSymbol").value.toUpperCase().replace(/[^A-Z0-9]/g, "") || "BTCUSDT";
      const tf = $("fpTf").value;
      // grab the live price so the footprint has a real anchor
      const k = await api(`/api/klines/${encodeURIComponent(sym)}/${tf}/2`).then((r) => r.json());
      const kl = (k.candles || k.klines || []);
      const last = kl.length ? kl[kl.length - 1] : null;
      const price = last ? last.close : 0;
      if (!(price > 0)) { $("fpStatus").textContent = "No live price for that symbol."; return; }
      const r = await api("/api/lab/footprints", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "manual", symbol: sym, timeframe: tf,
          price, time: Math.floor(Date.now() / 1000),
          note: $("fpNote").value,
        }),
      });
      if (!r.ok) { $("fpStatus").textContent = "Could not save."; return; }
      $("fpNote").value = "";
      $("fpStatus").textContent = "Saved ✓";
      loadFootprints();
    } catch (_e) { $("fpStatus").textContent = "Save failed."; }
  }

  async function loadFootprints() {
    $("fpStatus").textContent = "Loading stats…";
    try {
      const [statsJ, listJ] = await Promise.all([
        api("/api/lab/footprint-stats").then((r) => r.json()),
        api("/api/lab/footprints").then((r) => r.json()),
      ]);
      const stats = statsJ.stats || [];
      $("fpStats").innerHTML = stats.length
        ? `<table class="mini"><thead><tr><th>Setup</th><th>Samples</th><th>Win %</th><th>Avg MFE (ATR)</th></tr></thead><tbody>` +
          stats.map((s) =>
            `<tr><td>${esc(s.type)} <span style="color:var(--dim)">@ ${esc(s.session)}</span></td>` +
            `<td>${s.n}</td>` +
            `<td style="color:${s.winPct >= 60 ? "var(--green)" : s.winPct >= 45 ? "var(--gold)" : "var(--red)"};font-weight:600">${s.winPct}%</td>` +
            `<td>${s.avgMfeAtr}</td></tr>`).join("") + `</tbody></table>` +
          `<div style="color:var(--dim);font-size:12px;margin-top:6px">Win = price moved your way within ~24h.</div>`
        : `<div style="color:var(--dim);font-size:13px;margin-top:8px">No footprints with outcomes yet. Draw on the chart or ⭐ a signal, then come back.</div>`;
      const typeLbl = (t) => t.startsWith("drawing:") ? "✏️ " + t.slice(8) : t === "signal" ? "📊 signal" : esc(t);
      $("fpList").innerHTML = (listJ.footprints || []).slice(0, 30).map((f) =>
        `<tr><td>${typeLbl(f.type)}</td><td>${esc(f.symbol)}</td><td>${esc(f.session)}</td>` +
        `<td>${Number(f.price).toLocaleString()}</td>` +
        `<td>${f.mfe_atr == null || f.mfe_atr < 0 ? "—" : f.mfe_atr}</td>` +
        `<td>${f.mae_atr == null || f.mae_atr < 0 ? "—" : f.mae_atr}</td>` +
        `<td><button class="link" data-del="${f.id}" style="color:var(--red)">✕</button></td></tr>`
      ).join("") || `<tr><td colspan="7" style="color:var(--dim)">Nothing logged yet.</td></tr>`;
      document.querySelectorAll("[data-del]").forEach((b) => {
        b.onclick = async () => {
          await api("/api/lab/footprints/" + b.dataset.del, { method: "DELETE" });
          loadFootprints();
        };
      });
      $("fpStatus").textContent = `${statsJ.total || 0} footprints with outcomes.`;
    } catch (_e) { $("fpStatus").textContent = "Load failed."; }
  }

  /* ---------------- session DNA ---------------- */
  async function loadDNA() {
    const sym = $("dnaSymbol").value.toUpperCase().replace(/[^A-Z0-9]/g, "") || "BTCUSDT";
    $("dnaTable").innerHTML = `<tr><td colspan="5" style="color:var(--dim)">Learning…</td></tr>`;
    $("dnaWarn").innerHTML = "";
    try {
      const j = await api("/api/lab/dna?symbol=" + encodeURIComponent(sym)).then((r) => r.json());
      if (j.error) throw new Error(j.error);
      const hours = { Asia: "00–03", London: "07–10", "New York": "12–15" };
      $("dnaTable").innerHTML = ["Asia", "London", "New York"].map((s) => {
        const d = j.sessions[s] || {};
        return `<tr><td><b>${s}</b> <span style="color:var(--dim)">${hours[s]} UTC</span></td>` +
          `<td>${d.avg_range_atr == null ? "—" : d.avg_range_atr + "×"}</td>` +
          `<td>${d.sweep_freq_per_day == null ? "—" : d.sweep_freq_per_day}</td>` +
          `<td>${d.reversal_pct == null ? "—" : d.reversal_pct + "%"}</td>` +
          `<td>${d.samples || 0}</td></tr>`;
      }).join("");
      if (j.warning) {
        $("dnaWarn").innerHTML = `<div class="warn-line">⚠️ ${esc(j.warning)}</div>`;
      } else {
        $("dnaWarn").innerHTML = `<div class="ok-line">✓ Current session is inside its normal range.</div>`;
      }
    } catch (_e) {
      $("dnaTable").innerHTML = `<tr><td colspan="5" style="color:var(--red)">DNA failed — market data unavailable, try later.</td></tr>`;
    }
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
