"use strict";
/* ============================================================================
 * Trader Guider — Methodology UI orchestrator.
 * ----------------------------------------------------------------------------
 * - "Methodologies" dropdown (topbar): enable/disable ICT, SMC, VSA,
 *   Price Action, Elliott Wave, Chart Patterns, each with a gear → settings
 *   modal whose checkboxes toggle individual components instantly.
 * - Signal panel (side): current BUY/SELL plan or No signal / Mixed state.
 * - Render registry with a series cap and full cleanup (no leaks).
 * - Detection results are cached per (symbol, timeframe, data); toggling a
 *   checkbox re-renders from cache — instant, no full chart rebuild.
 * - State persists via app.js saveState (layout.methodologies).
 * ========================================================================== */
window.TGMethodUI = (function () {
  "use strict";

  const METHODS = {
    ict: {
      label: "ICT", color: "#d4a94e",
      settings: {
        structure: "Market Structure (BOS/CHoCH)",
        fvg: "Fair Value Gaps",
        orderblocks: "Order Blocks",
        sweeps: "Liquidity Sweeps",
        killzones: "Killzones",
        premium: "Premium / Discount",
      },
    },
    smc: {
      label: "SMC", color: "#4f7cff",
      settings: {
        structure: "Market Structure",
        orderblocks: "Order Blocks",
        fvg: "Fair Value Gaps",
        sweeps: "Liquidity Sweeps",
        premium: "Premium / Discount",
      },
    },
    vsa: {
      label: "VSA", color: "#26a69a",
      settings: {
        climax: "Buying / Selling Climax",
        nodemand: "No Demand / No Supply",
        stopping: "Stopping Volume",
        effort: "Effort vs Result",
      },
    },
    priceaction: {
      label: "Price Action", color: "#b48cf2",
      settings: {
        zones: "Support / Resistance Zones",
        candles: "Engulfing / Pin Bars",
      },
    },
    elliott: {
      label: "Elliott Wave", color: "#ef5350",
      settings: {
        impulse: "Impulse (1-2-3-4-5)",
        correction: "Correction (A-B-C)",
      },
    },
    patterns: {
      label: "Chart Patterns", color: "#8b94a7",
      settings: {
        hs: "Head & Shoulders",
        dbl: "Double Top / Bottom",
        wedge: "Wedges",
        flag: "Flags",
      },
    },
    trendsr: {
      label: "Trendlines + S/R", color: "#f0b429",
      settings: {
        trendlines: "Auto Trendlines",
        zones: "Horizontal S/R Zones",
        breakouts: "Breakout Signals",
        retests: "Retest / Bounce Signals",
      },
    },
  };
  const EVAL_METHODS = ["ict", "smc", "vsa", "priceaction", "trendsr"]; // can emit signals
  const SERIES_CAP = 140;
  const TF_SEC = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "1d": 86400, "1w": 604800 };
  const BULL = "#26a69a", BEAR = "#ef5350", DIM = "#3a4358";

  const S = {
    chart: null, candleSeries: null, markerSeries: null,
    getCandles: null, getTimeframe: null, onChange: null,
    methods: {}, cache: { key: null, ctx: null },
    registry: [], timer: null, ui: false,
  };

  function defaultState() {
    const o = {};
    for (const k of Object.keys(METHODS)) {
      o[k] = { enabled: false, settings: {} };
      for (const sk of Object.keys(METHODS[k].settings)) o[k].settings[sk] = true;
    }
    return o;
  }

  /* ---------------- render context ---------------- */
  function newRC() {
    return {
      series: [], markers: [],
      line(points, opts) {
        const s = S.chart.addLineSeries(Object.assign({
          color: "#d4a94e", lineWidth: 1, priceLineVisible: false,
          lastValueVisible: false, crosshairMarkerVisible: false,
        }, opts || {}));
        s.setData(points.map((p) => ({ time: p.time, value: p.price })));
        this.series.push(s);
        return s;
      },
      marker(m) { this.markers.push(m); },
    };
  }

  function clearRegistry() {
    for (const s of S.registry) { try { S.chart.removeSeries(s); } catch (_e) {} }
    S.registry = [];
    try { S.markerSeries.setMarkers([]); } catch (_e) {}
  }

  function commitRC(rc, midPrice, t0, t1) {
    for (const s of rc.series) {
      S.registry.push(s);
      while (S.registry.length > SERIES_CAP) {
        const old = S.registry.shift();
        try { S.chart.removeSeries(old); } catch (_e) {}
      }
    }
    try {
      S.markerSeries.setData([
        { time: t0, value: midPrice },
        { time: t1, value: midPrice },
      ]);
      S.markerSeries.setMarkers(rc.markers);
    } catch (_e) {}
  }

  /* ---------------- drawing helpers ---------------- */
  function hline(rc, price, color, style, width, title, t0, t1) {
    if (!(price > -1e18 && price < 1e18)) return;
    rc.line([{ time: t0, price }, { time: t1, price }],
      { color, lineWidth: width || 1, lineStyle: style || 0, title: title || "" });
  }

  function vline(rc, time, color, style, lo, hi) {
    rc.line([{ time, price: lo }, { time, price: hi }],
      { color: color || DIM, lineWidth: 1, lineStyle: style == null ? 2 : style });
  }

  function box(rc, t1, t2, top, bottom, color, title) {
    if (!(top > bottom)) return;
    const o = { color, lineWidth: 1, title: title || "" };
    rc.line([{ time: t1, price: top }, { time: t2, price: top }], o);
    rc.line([{ time: t1, price: bottom }, { time: t2, price: bottom }], o);
    rc.line([{ time: t1, price: top }, { time: t1, price: bottom }], o);
    rc.line([{ time: t2, price: top }, { time: t2, price: bottom }], o);
  }

  function midPriceOf(ctx) {
    const c = ctx.candles;
    let lo = Infinity, hi = -Infinity;
    for (const x of c) {
      if (x.low < lo) lo = x.low;
      if (x.high > hi) hi = x.high;
    }
    return (lo + hi) / 2;
  }

  /* ---------------- per-methodology renderers ---------------- */
  function renderStructure(rc, ctx, t0, t1, color) {
    const evs = ctx.structure.slice(-10);
    for (const e of evs) {
      rc.marker({
        time: e.time, position: e.dir === "bull" ? "belowBar" : "aboveBar",
        color: e.dir === "bull" ? BULL : BEAR, shape: "text",
        text: e.type === "BOS" ? "BOS" : "CHoCH",
      });
    }
  }

  function renderFVGs(rc, ctx, t0, t1) {
    for (const g of ctx.fvgs) {
      const c = g.dir === "bull" ? "rgba(38,166,154,0.85)" : "rgba(239,83,80,0.85)";
      box(rc, g.time, t1, g.top, g.bottom, c, "FVG");
    }
  }

  function renderOBs(rc, ctx, t0, t1) {
    for (const ob of ctx.obs) {
      box(rc, ob.time, t1, ob.top, ob.bottom, "#4f7cff", "OB");
    }
  }

  function renderSweeps(rc, ctx) {
    for (const s of ctx.sweeps) {
      rc.marker({
        time: s.time, position: s.dir === "bull" ? "belowBar" : "aboveBar",
        color: s.dir === "bull" ? BULL : BEAR, shape: "text", text: "SWEEP",
      });
    }
  }

  function renderKillzones(rc, ctx, lo, hi) {
    for (const kz of ctx.killzones) {
      vline(rc, kz.time, "#3a4358", 2, lo, hi);
      rc.marker({ time: kz.time, position: "aboveBar", color: "#8b94a7", shape: "text", text: kz.name });
    }
  }

  function renderPremium(rc, ctx, t0, t1) {
    const pd = ctx.pd;
    if (!pd) return;
    hline(rc, pd.high, DIM, 2, 1, "range high", t0, t1);
    hline(rc, pd.low, DIM, 2, 1, "range low", t0, t1);
    hline(rc, pd.eq, "#d4a94e", 0, 1, "equilibrium 50%", t0, t1);
    rc.marker({ time: t1, position: "aboveBar", color: "#8b94a7", shape: "text", text: "PREMIUM" });
    rc.marker({ time: t1, position: "belowBar", color: "#8b94a7", shape: "text", text: "DISCOUNT" });
  }

  function renderVSA(rc, ctx, settings) {
    const allow = { BC: settings.climax, SC: settings.climax, ND: settings.nodemand,
      NS: settings.nodemand, STPV: settings.stopping, EvR: settings.effort };
    for (const v of ctx.vsa) {
      if (!allow[v.type]) continue;
      rc.marker({
        time: v.time, position: v.dir === "bull" ? "belowBar" : "aboveBar",
        color: v.dir === "bull" ? BULL : BEAR, shape: "text", text: v.type,
      });
    }
  }

  function renderPA(rc, ctx, settings, t0, t1) {
    if (settings.zones) {
      for (const z of ctx.srZones) {
        const c = z.dir === "support" ? "rgba(38,166,154,0.8)" : "rgba(239,83,80,0.8)";
        hline(rc, z.top, c, 0, 1, `${z.dir} x${z.touches}`, t0, t1);
        hline(rc, z.bottom, c, 0, 1, "", t0, t1);
      }
    }
    if (settings.candles && ctx.paSetups) {
      for (const s of ctx.paSetups) {
        rc.marker({
          time: s.time, position: s.dir === "buy" ? "belowBar" : "aboveBar",
          color: s.dir === "buy" ? BULL : BEAR, shape: "text",
          text: s.kind === "engulfing" ? "ENG" : "PIN",
        });
      }
    }
  }

  function renderElliott(rc, ctx, settings) {
    for (const wv of ctx.elliott) {
      const pts = wv.labels;
      // connect pivots with thin lines
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        rc.line([{ time: a.time, price: a.price }, { time: b.time, price: b.price }],
          { color: "rgba(239,83,80,0.55)", lineWidth: 1 });
      }
      if (settings.impulse !== false) {
        for (const p of pts.slice(0, 5)) {
          rc.marker({ time: p.time, position: p.label === "2" || p.label === "4" ? "belowBar" : "aboveBar",
            color: "#ef5350", shape: "text", text: p.label });
        }
      }
      if (settings.correction !== false && pts.length > 5) {
        for (const p of pts.slice(5)) {
          rc.marker({ time: p.time, position: "inBar", color: "#d4a94e", shape: "text", text: p.label });
        }
      }
    }
  }

  function renderPatterns(rc, ctx, settings, t0, t1) {
    const P = ctx.patterns;
    function neck(a, b, color, label) {
      // extend neckline slightly right
      const tA = a.time, tB = Math.min(t1, b.time + (b.time - a.time));
      const slope = (b.price - a.price) / Math.max(b.time - a.time, 1);
      rc.line([{ time: tA, price: a.price }, { time: tB, price: b.price + slope * (tB - b.time) }],
        { color, lineWidth: 1, lineStyle: 2, title: label });
      rc.marker({ time: b.time, position: "aboveBar", color, shape: "text", text: label });
    }
    if (settings.hs) {
      for (const p of P.hs) {
        neck(p.neckline[0], p.neckline[1], "#b48cf2", p.label);
      }
    }
    if (settings.dbl) {
      for (const p of P.dbl) {
        const [a, mid, b] = p.pivots;
        hline(rc, p.neck, "#b48cf2", 2, 1, p.label, a.time, t1);
        rc.marker({ time: b.time, position: p.dir === "bull" ? "belowBar" : "aboveBar",
          color: p.dir === "bull" ? BULL : BEAR, shape: "text",
          text: p.confirmed >= 0 ? p.label + " ✓" : p.label });
      }
    }
    if (settings.wedge) {
      for (const w of P.wedge) {
        const c = w.dir === "bull" ? BULL : BEAR;
        const ext = (pivots) => {
          const a = pivots[0], b = pivots[pivots.length - 1];
          const slope = (b.price - a.price) / Math.max(b.time - a.time, 1);
          return [
            { time: a.time, price: a.price },
            { time: t1, price: a.price + slope * (t1 - a.time) },
          ];
        };
        rc.line(ext(w.highs), { color: c, lineWidth: 1 });
        rc.line(ext(w.lows), { color: c, lineWidth: 1, lineStyle: 2, title: w.label });
        rc.marker({ time: t1, position: "aboveBar", color: c, shape: "text", text: w.label });
      }
    }
    if (settings.flag) {
      for (const f of P.flag) {
        const c = f.dir === "bull" ? BULL : BEAR;
        rc.line([{ time: f.pole[0].time, price: f.pole[0].close }, { time: f.pole[1].time, price: f.pole[1].close }],
          { color: c, lineWidth: 2, title: f.label });
        rc.marker({ time: f.pole[1].time, position: f.dir === "bull" ? "belowBar" : "aboveBar",
          color: c, shape: "text", text: f.label });
      }
    }
  }

  function renderTrendSR(rc, ctx, settings, t0, t1) {
    // trendlines
    if (settings.trendlines) {
      for (const tl of ctx.trendlines || []) {
        const c = tl.type === "support" ? "rgba(38,166,154,0.9)" : "rgba(239,83,80,0.9)";
        const pts = tl.points.map((p) => ({ time: p.time, price: p.price }));
        // extend a little to the right for visibility
        const span = tl.endIdx - tl.startIdx;
        if (span > 0 && pts.length === 2) {
          pts.push({ time: t1, price: tl.lastValue });
        }
        rc.line(pts, { color: c, lineWidth: 1, title: `${tl.type} TL ×${tl.touches}` });
      }
    }
    // horizontal zones (reuse PA renderer pieces but respect this method's toggle)
    if (settings.zones) {
      for (const z of ctx.srZones || []) {
        const c = z.dir === "support" ? "rgba(38,166,154,0.7)" : "rgba(239,83,80,0.7)";
        hline(rc, z.top, c, 0, 1, `${z.dir} ×${z.touches}`, t0, t1);
        hline(rc, z.bottom, c, 0, 1, "", t0, t1);
      }
    }
  }

  function slopeOf(pts) {
    const n = pts.length;
    if (n < 2) return 0;
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (const p of pts) { const x = p.idx != null ? p.idx : p.time; sx += x; sy += p.price; sxy += x * p.price; sxx += x * x; }
    const den = n * sxx - sx * sx;
    return den ? (n * sxy - sx * sy) / den : 0;
  }

  /* ---------------- orchestration ---------------- */
  function tfSec() {
    try {
      const tf = S.getTimeframe ? S.getTimeframe() : "1h";
      return TF_SEC[tf] || 3600;
    } catch (_e) { return 3600; }
  }

  function cacheKey() {
    const c = S.getCandles ? S.getCandles() : [];
    if (!c.length) return null;
    return `${c.length}:${c[c.length - 1].time}`;
  }

  function getCtx() {
    const key = cacheKey();
    if (!key) return null;
    if (S.cache.key === key && S.cache.ctx) return S.cache.ctx;
    const candles = S.getCandles();
    let ctx = null;
    try {
      // evaluate on last 300 candles max (perf guard)
      const slice = candles.length > 300 ? candles.slice(-300) : candles;
      ctx = window.TGMethodology.analyze(slice, { tfSec: tfSec(), strength: 3 });
    } catch (_e) { ctx = null; }
    S.cache = { key, ctx };
    return ctx;
  }

  function invalidateCache() { S.cache = { key: null, ctx: null }; }

  function renderMethod(key, st, ctx, rc, t0, t1, lo, hi) {
    const set = st.settings || {};
    const M = METHODS[key];
    try {
      if (key === "ict" || key === "smc") {
        const accent = M.color;
        if (set.structure) renderStructure(rc, ctx, t0, t1, accent);
        if (set.fvg) renderFVGs(rc, ctx, t0, t1);
        if (set.orderblocks) renderOBs(rc, ctx, t0, t1);
        if (set.sweeps) renderSweeps(rc, ctx);
        if (set.killzones) renderKillzones(rc, ctx, lo, hi);
        if (set.premium) renderPremium(rc, ctx, t0, t1);
      } else if (key === "vsa") {
        renderVSA(rc, ctx, set);
      } else if (key === "priceaction") {
        renderPA(rc, ctx, set, t0, t1);
      } else if (key === "elliott") {
        renderElliott(rc, ctx, set);
      } else if (key === "patterns") {
        renderPatterns(rc, ctx, set, t0, t1);
      } else if (key === "trendsr") {
        renderTrendSR(rc, ctx, set, t0, t1);
      }
    } catch (_e) { /* one broken renderer must not kill the rest */ }
  }

  function evaluateSignal(ctx) {
    const G = window.TGSignals;
    const active = Object.keys(METHODS).filter(
      (k) => S.methods[k] && S.methods[k].enabled && EVAL_METHODS.indexOf(k) >= 0);
    const evals = {};
    try {
      if (active.indexOf("ict") >= 0) evals.ict = G.evalICTSMC(ctx, "ict");
      if (active.indexOf("smc") >= 0) evals.smc = G.evalICTSMC(ctx, "smc");
      if (active.indexOf("vsa") >= 0) evals.vsa = G.evalVSA(ctx);
      if (active.indexOf("priceaction") >= 0) evals.priceaction = G.evalPriceAction(ctx);
      if (active.indexOf("trendsr") >= 0) {
        const tset = (S.methods.trendsr && S.methods.trendsr.settings) || {};
        // at least one signal type must be enabled for this method
        if (tset.breakouts !== false || tset.retests !== false) {
          const s = G.evalTrendSR(ctx);
          if (s) {
            const isBreakout = (s.reasons[0] || "").indexOf("breakout") === 0;
            const isBounce = (s.reasons[0] || "").indexOf("rejection bounce") === 0;
            if ((isBreakout && tset.breakouts !== false) ||
                (isBounce && tset.retests !== false) ||
                (!isBreakout && !isBounce)) {
              evals.trendsr = s;
            }
          }
        }
      }
    } catch (_e) { /* evaluator fault -> treat as no signal */ }
    const lastIdx = ctx.candles.length - 1;
    try {
      return G.confluence(active, evals, lastIdx);
    } catch (_e) {
      return { state: "none" };
    }
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function renderSignalPanel(res) {
    const body = document.getElementById("sigBody");
    if (!body) return;
    const G = window.TGSignals;
    if (!res || res.state === "none") {
      const anyEval = Object.keys(METHODS).some(
        (k) => S.methods[k] && S.methods[k].enabled && EVAL_METHODS.indexOf(k) >= 0);
      body.innerHTML = `<div style="color:var(--dim);font-size:12px">${
        anyEval ? "No fresh signal right now — structure is forming." : "Enable ICT, SMC, VSA or Price Action above to generate signals."}</div>`;
      return;
    }
    if (res.state === "mixed") {
      body.innerHTML = `<div><span class="pill" style="border-color:#d4a94e;color:#d4a94e">MIXED — NO TRADE</span></div>
        <div style="color:var(--dim);font-size:12px;margin-top:8px">Methodologies disagree:<br>${esc((res.details || []).join("<br>"))}</div>`;
      return;
    }
    const sg = res.signal;
    const bull = sg.direction === "buy";
    const rr = G.rrRatio(sg);
    const conf = Math.max(0, Math.min(100, sg.confidence || 0));
    body.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <span class="pill ${bull ? "ok" : "bad"}" style="font-weight:700">${bull ? "BUY" : "SELL"}</span>
        <span style="font-size:12px;color:var(--dim)">${esc(sg.tag || "")}</span>
      </div>
      <table class="mini">
        <tr><th>Entry</th><td>${esc(G.fmtP(sg.entry))}</td></tr>
        <tr><th>Stop loss</th><td style="color:var(--red)">${esc(G.fmtP(sg.sl))}</td></tr>
        <tr><th>Take profit 1</th><td style="color:var(--green)">${esc(G.fmtP(sg.tp1))}</td></tr>
        <tr><th>Take profit 2</th><td style="color:var(--green)">${esc(G.fmtP(sg.tp2))}</td></tr>
        <tr><th>Risk : Reward</th><td>1 : ${rr != null ? rr.toFixed(2) : "—"}</td></tr>
      </table>
      <div style="margin-top:8px;font-size:12px;color:var(--dim)">Confidence</div>
      <div style="background:var(--panel2);border-radius:6px;height:8px;overflow:hidden">
        <div style="width:${conf}%;height:100%;background:${bull ? "var(--green)" : "var(--red)"}"></div>
      </div>
      <div style="margin-top:8px;font-size:12px;color:var(--dim)">${(sg.reasons || []).map(esc).join("<br>")}</div>
      <div style="margin-top:6px;font-size:11px;color:var(--dim)">Not financial advice — analytical plan only.</div>`;
  }

  function renderAll() {
    clearRegistry();
    const ctx = getCtx();
    if (!ctx || !ctx.candles.length) { renderSignalPanel({ state: "none" }); return; }
    const candles = ctx.candles;
    const t0 = candles[0].time, t1 = candles[candles.length - 1].time;
    let lo = Infinity, hi = -Infinity;
    for (const c of candles) { if (c.low < lo) lo = c.low; if (c.high > hi) hi = c.high; }
    const rc = newRC();
    for (const key of Object.keys(METHODS)) {
      const st = S.methods[key];
      if (!st || !st.enabled) continue;
      renderMethod(key, st, ctx, rc, t0, t1, lo, hi);
    }
    // signal (drawn into the same render context)
    const res = evaluateSignal(ctx);
    if ((res.state === "single" || res.state === "confluence") && res.signal) {
      try { window.TGSignals.render(S.chart, rc, res.signal, t0, t1); }
      catch (_e) { /* signal art must never break the chart */ }
    }
    commitRC(rc, (lo + hi) / 2, t0, t1);
    renderSignalPanel(res);
  }

  function scheduleRefresh() {
    clearTimeout(S.timer);
    S.timer = setTimeout(() => { invalidateCache(); renderAll(); }, 300);
  }

  /* ---------------- public: data changed ---------------- */
  function onData() { scheduleRefresh(); }

  /* ---------------- state ---------------- */
  function getState() {
    const o = {};
    for (const k of Object.keys(METHODS)) {
      o[k] = { enabled: !!(S.methods[k] && S.methods[k].enabled), settings: {} };
      for (const sk of Object.keys(METHODS[k].settings)) {
        o[k].settings[sk] = !!(S.methods[k] && S.methods[k].settings && S.methods[k].settings[sk]);
      }
    }
    return o;
  }

  function setState(saved) {
    S.methods = defaultState();
    if (saved && typeof saved === "object") {
      for (const k of Object.keys(METHODS)) {
        if (saved[k] && typeof saved[k] === "object") {
          S.methods[k].enabled = !!saved[k].enabled;
          for (const sk of Object.keys(METHODS[k].settings)) {
            if (saved[k].settings && sk in saved[k].settings) {
              S.methods[k].settings[sk] = !!saved[k].settings[sk];
            }
          }
        }
      }
    }
    syncMenu();
    renderAll();
  }

  /* ---------------- UI: dropdown menu ---------------- */
  function buildMenu() {
    const tfBar = document.getElementById("tfBar");
    if (!tfBar || document.getElementById("methodBtn")) return;
    const wrap = document.createElement("div");
    wrap.className = "method-wrap";
    wrap.innerHTML = `<button class="link" id="methodBtn" style="font-size:13px">◈ Methodologies ▾</button>
      <div class="method-menu" id="methodMenu"></div>`;
    tfBar.after(wrap);
    document.getElementById("methodBtn").onclick = (e) => {
      e.stopPropagation();
      document.getElementById("methodMenu").classList.toggle("open");
    };
    document.addEventListener("click", (e) => {
      const m = document.getElementById("methodMenu");
      if (m && m.classList.contains("open") && !e.target.closest(".method-wrap")) m.classList.remove("open");
    });
    syncMenu();
  }

  function syncMenu() {
    const menu = document.getElementById("methodMenu");
    if (!menu) return;
    menu.innerHTML = "";
    for (const k of Object.keys(METHODS)) {
      const M = METHODS[k], st = S.methods[k] || { enabled: false, settings: {} };
      const row = document.createElement("div");
      row.className = "method-row";
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = !!st.enabled;
      cb.onchange = () => {
        S.methods[k].enabled = cb.checked;
        renderAll();
        if (S.onChange) S.onChange();
      };
      const lab = document.createElement("span");
      lab.innerHTML = `<span style="color:${M.color}">●</span> `;
      lab.appendChild(document.createTextNode(M.label));
      lab.style.flex = "1";
      lab.onclick = () => { cb.checked = !cb.checked; cb.onchange(); };
      const gear = document.createElement("button");
      gear.className = "gear"; gear.title = `${M.label} settings`; gear.textContent = "⚙";
      gear.onclick = (e) => { e.stopPropagation(); openSettings(k); };
      row.appendChild(cb); row.appendChild(lab); row.appendChild(gear);
      menu.appendChild(row);
    }
  }

  /* ---------------- UI: settings modal ---------------- */
  function buildModal() {
    if (document.getElementById("methodModal")) return;
    const back = document.createElement("div");
    back.className = "modal-back"; back.id = "methodModal";
    back.innerHTML = `<div class="modal"><h2 id="mmTitle"></h2><div id="mmBody"></div>
      <div class="row" style="margin-top:12px"><button class="btn wide" id="mmClose">Done</button></div></div>`;
    document.body.appendChild(back);
    back.addEventListener("click", (e) => { if (e.target === back) back.classList.remove("open"); });
    document.getElementById("mmClose").onclick = () => back.classList.remove("open");
  }

  function openSettings(key) {
    const M = METHODS[key], st = S.methods[key];
    document.getElementById("mmTitle").textContent = `${M.label} — components`;
    const body = document.getElementById("mmBody");
    body.innerHTML = "";
    for (const sk of Object.keys(M.settings)) {
      const row = document.createElement("div");
      row.className = "method-row";
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = !!st.settings[sk];
      cb.onchange = () => {
        st.settings[sk] = cb.checked;
        renderAll(); // instant: uses cached detection
        if (S.onChange) S.onChange();
      };
      const lab = document.createElement("span");
      lab.textContent = M.settings[sk];
      lab.style.flex = "1";
      lab.onclick = () => { cb.checked = !cb.checked; cb.onchange(); };
      row.appendChild(cb); row.appendChild(lab);
      body.appendChild(row);
    }
    document.getElementById("methodModal").classList.add("open");
  }

  /* ---------------- UI: signal panel ---------------- */
  function buildSignalPanel() {
    const side = document.querySelector(".side");
    if (!side || document.getElementById("sigSec")) return;
    const sec = document.createElement("div");
    sec.className = "sec"; sec.id = "sigSec";
    sec.innerHTML = `<h3>Signals <button class="btn" id="sigRefresh" style="padding:3px 8px;font-size:11px" title="Re-evaluate now">↻</button></h3>
      <div id="sigBody"><div style="color:var(--dim);font-size:12px">Enable a methodology to generate signals.</div></div>`;
    side.prepend(sec);
    document.getElementById("sigRefresh").onclick = () => { invalidateCache(); renderAll(); };
  }

  /* ---------------- init ---------------- */
  function init(opts) {
    S.chart = opts.chart;
    S.candleSeries = opts.candleSeries;
    S.getCandles = opts.getCandles;
    S.getTimeframe = opts.getTimeframe;
    S.onChange = opts.onChange;
    S.methods = defaultState();
    try {
      S.markerSeries = S.chart.addLineSeries({
        color: "rgba(0,0,0,0)", lineWidth: 1,
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      });
      S.registry.push(S.markerSeries); // never removed by cap rotation... see below
      // keep markerSeries out of FIFO rotation:
      S.registry.pop();
    } catch (_e) { S.markerSeries = null; }
    buildMenu();
    buildModal();
    buildSignalPanel();
    S.ui = true;
    renderAll();
  }

  return { init, onData, getState, setState, renderAll, METHODS };
})();
