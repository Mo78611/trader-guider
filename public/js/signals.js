"use strict";
/* ============================================================================
 * Trader Guider — Signal generation & confluence engine.
 * ----------------------------------------------------------------------------
 * Per-methodology evaluators turn detected structure into concrete trade
 * plans {direction, entry, sl, tp1, tp2, confidence, reasons, barIdx, tag}.
 * The confluence engine merges multiple active methodologies into ONE unified
 * signal — only when they agree. Conflicts produce an explicit "mixed" state,
 * never a trade.
 *
 * Risk model: SL sits beyond the structural extreme that would invalidate the
 * idea (sweep extreme / zone edge) plus a 0.2×ATR buffer. TP1 targets the
 * nearest opposing liquidity pool (swing); TP2 the next one. Nothing static.
 *
 * These are analytical trade plans for chart study, not financial advice and
 * not live orders — execution stays behind the app's dry-run/testnet guards.
 * ========================================================================== */
window.TGSignals = (function () {
  "use strict";

  const METHOD_LABELS = { ict: "ICT", smc: "SMC", vsa: "VSA", priceaction: "Price Action" };
  const FRESH_BARS = 10; // a signal older than this can't join confluence

  function num(x) { return typeof x === "number" && isFinite(x); }

  function fmtP(p) {
    if (!num(p)) return "—";
    const a = Math.abs(p);
    if (a >= 1000) return p.toLocaleString("en-US", { maximumFractionDigits: 1 });
    if (a >= 100) return p.toFixed(2);
    if (a >= 1) return p.toFixed(3);
    return p.toFixed(5);
  }

  function nearestLiquidity(dir, fromPrice, swings) {
    const bull = dir === "buy";
    const cands = (swings || []).filter((s) =>
      bull ? (s.type === "high" && s.price > fromPrice) : (s.type === "low" && s.price < fromPrice));
    cands.sort((a, b) => (bull ? a.price - b.price : b.price - a.price));
    return cands;
  }

  /* ---------------- ICT / SMC evaluator ----------------
   * ICT: structure shift + FVG tap + liquidity sweep (strict).
   * SMC: structure shift + order-block tap (+ sweep optional).            */
  function evalICTSMC(ctx, flavor) {
    if (!ctx || ctx.dead || !ctx.candles || !ctx.candles.length) return null;
    const { candles, atrVal, swings, structure, fvgs, obs, sweeps } = ctx;
    if (!num(atrVal) || atrVal <= 0) return null;
    const n = candles.length;
    const last = candles[n - 1];
    if (!last || !num(last.close)) return null;
    const wantZone = flavor === "ict" ? "fvg" : "ob";
    const needSweep = flavor === "ict";

    for (const dir of ["buy", "sell"]) {
      const bull = dir === "buy";
      // 1) structure trigger within 20 bars
      const trig = structure.filter((e) =>
        e.dir === (bull ? "bull" : "bear") && (n - 1 - e.idx) <= 20);
      if (!trig.length) continue;
      // 2) zone tap: last close inside zone, or wick tapped it in last 6 bars
      const zones = (wantZone === "fvg" ? fvgs : obs).filter((z) => z.dir === (bull ? "bull" : "bear"));
      let zone = null, tapIdx = -1;
      for (let i = zones.length - 1; i >= 0; i--) {
        const z = zones[i];
        if (!num(z.top) || !num(z.bottom)) continue;
        const inside = last.close <= z.top && last.close >= z.bottom;
        let wicked = false, wi = -1;
        for (let j = n - 1; j >= Math.max(0, n - 6); j--) {
          const c = candles[j];
          if (!c || !num(c.low) || !num(c.high)) continue;
          const touch = bull
            ? (c.low <= z.top && c.low >= z.bottom - 0.1 * atrVal)
            : (c.high >= z.bottom && c.high <= z.top + 0.1 * atrVal);
          if (touch) { wicked = true; wi = j; break; }
        }
        if (inside || wicked) { zone = z; tapIdx = wicked ? wi : n - 1; break; }
      }
      if (!zone) continue;
      // 3) liquidity sweep within 20 bars (required for ICT, bonus for SMC)
      const sweep = sweeps.filter((s) =>
        s.dir === (bull ? "bull" : "bear") && (n - 1 - s.idx) <= 20).pop();
      if (needSweep && !sweep) continue;

      const reasons = [];
      const ev = trig[trig.length - 1];
      reasons.push(`${ev.type} ${bull ? "bullish" : "bearish"}`);
      reasons.push(`tapped ${wantZone === "fvg" ? "FVG" : "order block"}`);
      if (sweep) reasons.push(`${sweep.kind} liquidity swept`);

      const entry = (zone.top + zone.bottom) / 2;
      const slRef = sweep ? sweep.price : (bull ? zone.bottom : zone.top);
      const sl = bull ? slRef - 0.2 * atrVal : slRef + 0.2 * atrVal;
      if (bull ? sl >= entry : sl <= entry) continue; // sanity: SL must be on the risk side
      const liq = nearestLiquidity(dir, entry, swings);
      const risk = Math.abs(entry - sl);
      const tp1 = liq[0] ? liq[0].price : (bull ? entry + 2 * risk : entry - 2 * risk);
      const tp2 = liq[1] ? liq[1].price : (bull ? tp1 + risk : tp1 - risk);
      return {
        method: flavor, direction: dir, entry, sl, tp1, tp2,
        confidence: Math.min(50 + reasons.length * 12, 92),
        reasons, barIdx: Math.max(tapIdx, ev.idx), barTime: candles[Math.max(tapIdx, ev.idx)].time,
        tag: METHOD_LABELS[flavor],
      };
    }
    return null;
  }

  /* ---------------- VSA evaluator ---------------- */
  function evalVSA(ctx) {
    if (!ctx || ctx.dead || !ctx.candles || ctx.candles.length < 30) return null;
    const { candles, atrVal, vsa } = ctx;
    if (!num(atrVal) || atrVal <= 0) return null;
    const n = candles.length;
    const last = candles[n - 1];
    if (!last || !num(last.open) || !num(last.close)) return null;
    for (const dir of ["buy", "sell"]) {
      const bull = dir === "buy";
      const sig = vsa.filter((v) =>
        v.dir === (bull ? "bull" : "bear") && (n - 1 - v.idx) <= 5).pop();
      if (!sig) continue;
      const conf = bull ? last.close > last.open : last.close < last.open;
      if (!conf) continue; // need confirmation bar
      const sigBar = candles[sig.idx];
      if (!sigBar || !num(sigBar.low) || !num(sigBar.high)) continue;
      const entry = last.close;
      const sl = bull ? sigBar.low - 0.2 * atrVal : sigBar.high + 0.2 * atrVal;
      const risk = Math.abs(entry - sl);
      if (!(risk > 0)) continue;
      const tp = bull ? entry + 2 * risk : entry - 2 * risk;
      return {
        method: "vsa", direction: dir, entry, sl,
        tp1: tp, tp2: bull ? entry + 3 * risk : entry - 3 * risk,
        confidence: 68, reasons: [`${sig.label} + confirmation`],
        barIdx: n - 1, barTime: last.time, tag: "VSA",
      };
    }
    return null;
  }

  /* ---------------- Price-action evaluator ---------------- */
  function evalPriceAction(ctx) {
    if (!ctx || ctx.dead || !ctx.candles || ctx.candles.length < 10) return null;
    const { candles, atrVal, srZones } = ctx;
    if (!num(atrVal) || atrVal <= 0 || !srZones || !srZones.length) return null;
    const n = candles.length;
    for (const dir of ["buy", "sell"]) {
      const bull = dir === "buy";
      const zones = srZones.filter((z) => z.dir === (bull ? "support" : "resistance"));
      for (let j = n - 1; j >= Math.max(1, n - 3); j--) {
        const c = candles[j], p = candles[j - 1];
        if (!c || !p || !num(c.open) || !num(c.close) || !num(p.open) || !num(p.close)) continue;
        const body = Math.abs(c.close - c.open);
        if (body <= 0) continue;
        const lowerWick = Math.min(c.open, c.close) - c.low;
        const upperWick = c.high - Math.max(c.open, c.close);
        const engulf = bull
          ? (p.close < p.open && c.close > c.open && c.close > p.open && c.open < p.close)
          : (p.close > p.open && c.close < c.open && c.close < p.open && c.open > p.close);
        const pin = bull
          ? (lowerWick > 2 * body && upperWick < body && body > 0.1 * atrVal)
          : (upperWick > 2 * body && lowerWick < body && body > 0.1 * atrVal);
        if (!engulf && !pin) continue;
        const extreme = bull ? c.low : c.high;
        const zone = zones.find((z) =>
          num(z.top) && num(z.bottom) &&
          extreme >= z.bottom - 0.3 * atrVal && extreme <= z.top + 0.3 * atrVal);
        if (!zone) continue;
        const entry = c.close;
        const sl = bull ? zone.bottom - 0.2 * atrVal : zone.top + 0.2 * atrVal;
        const risk = Math.abs(entry - sl);
        if (!(risk > 0)) continue;
        const opp = srZones
          .filter((z) => z.dir === (bull ? "resistance" : "support") &&
            (bull ? z.bottom > entry : z.top < entry))
          .sort((a, b) => (bull ? a.bottom - b.bottom : b.top - a.top))[0];
        const tp1 = opp ? (bull ? opp.top : opp.bottom)
          : (bull ? entry + 2 * risk : entry - 2 * risk);
        return {
          method: "priceaction", direction: dir, entry, sl, tp1, tp2: tp1,
          confidence: engulf ? 70 : 64,
          reasons: [`${engulf ? "engulfing" : "pin bar"} @ ${zone.dir} (${zone.touches} touches)`],
          barIdx: j, barTime: c.time, tag: "Price Action",
        };
      }
    }
    return null;
  }

  /* ---------------- Confluence engine ---------------- */
  function confluence(activeMethods, evals, lastIdx) {
    const fresh = [];
    for (const m of activeMethods) {
      const s = evals[m];
      if (s && (lastIdx - s.barIdx) <= FRESH_BARS) fresh.push({ method: m, sig: s });
    }
    if (!activeMethods.length) return { state: "none" };
    if (activeMethods.length === 1) {
      if (!fresh.length) return { state: "none" };
      const f = fresh[0];
      return { state: "single", signal: Object.assign({}, f.sig, { tag: METHOD_LABELS[f.method] || f.method }) };
    }
    if (!fresh.length) return { state: "none" };
    if (fresh.length === 1) {
      // multi-mode but only one methodology is firing — honest single-method
      // signal, NOT a confluence tag
      const f = fresh[0];
      return { state: "single", signal: Object.assign({}, f.sig, { tag: METHOD_LABELS[f.method] || f.method }) };
    }
    const dirs = Array.from(new Set(fresh.map((f) => f.sig.direction)));
    if (dirs.length > 1) {
      return {
        state: "mixed",
        details: fresh.map((f) => `${METHOD_LABELS[f.method] || f.method}:${f.sig.direction}`),
      };
    }
    const dir = dirs[0];
    const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    const entries = fresh.map((f) => f.sig.entry);
    const sls = fresh.map((f) => f.sig.sl);
    const signal = {
      direction: dir,
      entry: med(entries),
      sl: dir === "buy" ? Math.min.apply(null, sls) : Math.max.apply(null, sls), // most conservative
      tp1: med(fresh.map((f) => f.sig.tp1)),
      tp2: med(fresh.map((f) => f.sig.tp2)),
      confidence: Math.round(fresh.reduce((a, f) => a + f.sig.confidence, 0) / fresh.length),
      reasons: fresh.reduce((acc, f) => acc.concat(
        f.sig.reasons.map((r) => `${METHOD_LABELS[f.method] || f.method}: ${r}`)), []),
      barIdx: Math.max.apply(null, fresh.map((f) => f.sig.barIdx)),
      barTime: fresh.reduce((a, f) => (f.sig.barIdx > a.barIdx ? f.sig : a), fresh[0].sig).barTime,
      tag: `Strong ${dir === "buy" ? "Buy" : "Sell"} — ${fresh.map((f) => METHOD_LABELS[f.method] || f.method).join(" + ")}`,
      methods: fresh.map((f) => f.method),
    };
    // sanity: SL must sit on the risk side of entry
    if (dir === "buy" ? signal.sl >= signal.entry : signal.sl <= signal.entry) {
      return { state: "mixed", details: ["invalid geometry after merge"] };
    }
    return { state: "confluence", signal };
  }

  function rrRatio(signal) {
    if (!signal || !num(signal.entry) || !num(signal.sl) || !num(signal.tp1)) return null;
    const risk = Math.abs(signal.entry - signal.sl);
    if (!(risk > 0)) return null;
    return Math.abs(signal.tp1 - signal.entry) / risk;
  }

  /* ---------------- Risk/reward box renderer ----------------
   * Pushes line series + markers into the render context rc:
   *   rc.line(points, opts) -> series
   *   rc.marker(descriptor)
   * Entry (blue), SL (red dashed), TP1/TP2 (green), translucent risk shade
   * between entry and SL, and a BUY/SELL text marker at the signal bar. */
  function render(chart, rc, signal, t0, t1) {
    if (!signal || !num(signal.entry) || !num(signal.sl)) return;
    const bull = signal.direction === "buy";
    function hline(price, color, style, width, title) {
      if (!num(price)) return;
      rc.line(
        [{ time: t0, value: price }, { time: t1, value: price }],
        { color, lineWidth: width || 1, lineStyle: style || 0,
          priceLineVisible: true, lastValueVisible: false,
          crosshairMarkerVisible: false, title: title || "" }
      );
    }
    hline(signal.entry, "#4f7cff", 0, 2, `ENTRY ${fmtP(signal.entry)}`);
    hline(signal.sl, "#ef5350", 2, 1, `SL ${fmtP(signal.sl)}`);
    hline(signal.tp1, "#26a69a", 0, 1, `TP1 ${fmtP(signal.tp1)}`);
    hline(signal.tp2, "#26a69a", 2, 1, `TP2 ${fmtP(signal.tp2)}`);
    // risk shade: stacked translucent lines between entry and SL
    for (let i = 1; i < 8; i++) {
      const p = signal.entry + ((signal.sl - signal.entry) * i) / 8;
      rc.line(
        [{ time: t0, value: p }, { time: t1, value: p }],
        { color: "rgba(239,83,80,0.10)", lineWidth: 6,
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }
      );
    }
    // BUY / SELL marker at the signal bar
    if (num(signal.barTime)) {
      rc.marker({
        time: signal.barTime,
        position: bull ? "belowBar" : "aboveBar",
        color: bull ? "#26a69a" : "#ef5350",
        shape: "text",
        text: bull ? "BUY" : "SELL",
      });
      const rr = rrRatio(signal);
      if (rr != null) {
        rc.marker({
          time: t1, position: "inBar", color: "#8b94a7", shape: "text",
          text: `RR 1:${rr.toFixed(1)}`,
        });
      }
    }
  }

  return {
    METHOD_LABELS, FRESH_BARS, fmtP,
    evalICTSMC, evalVSA, evalPriceAction,
    confluence, rrRatio, render,
  };
})();
