"use strict";
/* ============================================================================
 * Trader Guider — Sweep Magnet Map (liquidity pools).
 * ----------------------------------------------------------------------------
 * Detects where liquidity sits and scores each pool's "magnet strength":
 *   +30  untouched (price never closed beyond it since it formed)
 *   +20  per extra touch beyond the 2nd
 *   +20  inside the current killzone session (Asia/London/New York, UTC)
 *   +10  at a premium/discount extreme (top/bottom 15% of dealing range)
 *
 * Pool types: equal highs/lows (≥2 swing touches within 0.2×ATR), old major
 * swing highs/lows, round numbers. Drawn as subtle horizontal lines, the
 * strongest brightest, labeled "🧲 82". ONLY when ticked in the ◈ menu
 * (ZERO CHART CLUTTER rule).
 * ========================================================================== */
window.TGMagnets = (function () {
  "use strict";

  const S = {
    chart: null, getCandles: null,
    enabled: false, minScore: 50, showMagnets: true,
    series: [],
  };

  function num(x) { return typeof x === "number" && isFinite(x); }

  function clear() {
    for (const s of S.series) { try { S.chart.removeSeries(s); } catch (_e) {} }
    S.series = [];
  }

  function sessionNow() {
    const h = new Date().getUTCHours();
    if (h < 3) return "Asia";
    if (h >= 7 && h < 10) return "London";
    if (h >= 12 && h < 15) return "New York";
    return null;
  }

  function roundStep(price) {
    // sensible round-number step for the price magnitude
    if (price >= 10000) return 1000;
    if (price >= 1000) return 100;
    if (price >= 100) return 10;
    if (price >= 10) return 1;
    if (price >= 1) return 0.1;
    return 0.01;
  }

  function detect(candles) {
    const M = window.TGMethodology;
    if (!M || !Array.isArray(candles) || candles.length < 60) return [];
    const n = candles.length;
    const atrA = M.atr(candles, 14);
    const atr = M.lastValid(atrA);
    if (!num(atr) || atr <= 0) return [];
    const sw = M.swings(candles, 3);
    const recent = sw.filter((s) => s.idx >= n - 220);
    const pools = [];
    const sessNow = sessionNow();
    const pd = M.premiumDiscount(candles, sw, 120);

    function scorePool(price, touches, formedIdx, kind) {
      let score = 0;
      // untouched? (no close beyond since formed)
      let untouched = true;
      for (let j = formedIdx + 1; j < n; j++) {
        const c = candles[j];
        if (!c || !num(c.close)) continue;
        if (kind === "high" && c.close > price + 0.1 * atr) { untouched = false; break; }
        if (kind === "low" && c.close < price - 0.1 * atr) { untouched = false; break; }
      }
      if (untouched) score += 30;
      if (touches > 2) score += Math.min(40, (touches - 2) * 20);
      if (sessNow) score += 20; // current session = liquidity hunting hours
      if (pd && num(pd.high) && num(pd.low) && pd.high > pd.low) {
        const span = pd.high - pd.low;
        const edge = kind === "high"
          ? (pd.high - price) / span < 0.15
          : (price - pd.low) / span < 0.15;
        if (edge) score += 10;
      }
      return Math.min(100, score);
    }

    // 1) equal highs / lows
    const tol = 0.2 * atr;
    for (const mode of ["high", "low"]) {
      const pts = recent.filter((s) => s.type === mode).map((s) => ({ price: s.price, idx: s.idx }));
      pts.sort((a, b) => a.price - b.price);
      let cluster = [];
      const flush = () => {
        if (cluster.length >= 2) {
          const prices = cluster.map((p) => p.price);
          const price = prices.reduce((a, b) => a + b, 0) / prices.length;
          const formed = Math.max(...cluster.map((p) => p.idx));
          pools.push({
            price, kind: mode, touches: cluster.length,
            score: scorePool(price, cluster.length, formed, mode),
            label: "equal " + (mode === "high" ? "highs" : "lows"),
          });
        }
        cluster = [];
      };
      for (const p of pts) {
        if (cluster.length && p.price - cluster[0].price > tol) flush();
        cluster.push(p);
      }
      flush();
    }

    // 2) old major swing extremes
    const highs = recent.filter((s) => s.type === "high").sort((a, b) => b.price - a.price).slice(0, 3);
    const lows = recent.filter((s) => s.type === "low").sort((a, b) => a.price - b.price).slice(0, 3);
    for (const s of highs) {
      if (pools.some((p) => Math.abs(p.price - s.price) < tol)) continue;
      pools.push({ price: s.price, kind: "high", touches: 1,
        score: scorePool(s.price, 1, s.idx, "high"), label: "old high" });
    }
    for (const s of lows) {
      if (pools.some((p) => Math.abs(p.price - s.price) < tol)) continue;
      pools.push({ price: s.price, kind: "low", touches: 1,
        score: scorePool(s.price, 1, s.idx, "low"), label: "old low" });
    }

    // 3) round numbers near the current price
    const last = candles[n - 1].close;
    const step = roundStep(last);
    for (let k = -3; k <= 3; k++) {
      const price = Math.round(last / step) * step + k * step;
      if (pools.some((p) => Math.abs(p.price - price) < tol)) continue;
      pools.push({ price, kind: price >= last ? "high" : "low", touches: 0,
        score: Math.min(100, 20 + (sessNow ? 20 : 0)), label: "round number" });
    }

    pools.sort((a, b) => b.score - a.score);
    return pools.slice(0, 10);
  }

  function refresh() {
    clear();
    if (!S.enabled) return;
    const candles = S.getCandles ? S.getCandles() : [];
    if (!candles.length) return;
    let pools = [];
    try { pools = detect(candles); } catch (_e) { pools = []; }
    const show = pools.filter((p) => p.score >= S.minScore).slice(0, 8);
    if (!show.length || !S.showMagnets) return;
    const t0 = candles[0].time, t1 = candles[candles.length - 1].time;
    for (const p of show) {
      try {
        const alpha = 0.25 + (p.score / 100) * 0.65;
        const color = p.kind === "high"
          ? `rgba(239,83,80,${alpha.toFixed(2)})`
          : `rgba(38,166,154,${alpha.toFixed(2)})`;
        const s = S.chart.addLineSeries({
          color, lineWidth: p.score >= 80 ? 2 : 1, lineStyle: 2,
          priceLineVisible: false, lastValueVisible: false,
          crosshairMarkerVisible: false, title: `🧲 ${p.score} ${p.label}`,
        });
        s.setData([{ time: t0, value: p.price }, { time: t1, value: p.price }]);
        S.series.push(s);
      } catch (_e) { /* one bad pool must not break the rest */ }
    }
  }

  /** Called by method-ui when the checkbox / settings change. */
  function apply(enabled, settings) {
    S.enabled = !!enabled;
    const ms = settings && settings.minScore;
    const n = parseInt(ms, 10);
    S.minScore = n >= 0 && n <= 100 ? n : 50;
    S.showMagnets = !settings || settings.magnets !== false;
    if (!S.enabled) { clear(); return; }
    refresh();
  }

  function onData() { if (S.enabled) refresh(); }

  function init(opts) {
    S.chart = opts.chart;
    S.getCandles = opts.getCandles;
  }

  return { init, apply, onData, refresh, _detect: detect };
})();
