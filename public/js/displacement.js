"use strict";
/* ============================================================================
 * Trader Guider — Displacement Radar (impulse scoring).
 * ----------------------------------------------------------------------------
 * Scores every impulse leg (swing low → swing high or reverse):
 *   body%  = |sum of bodies| / leg range            (40%)
 *   volume = leg avg volume vs 20-bar average       (30%)
 *   speed  = (range / ATR) / bars in leg           (30%)
 * Score 0-100. Legs above the threshold get a subtle "⚡87" glow marker at
 * the leg end; weak legs draw nothing (ZERO CHART CLUTTER rule).
 * A small panel lists the top-5 strongest legs.
 *
 * Own invisible line series for markers (same pattern as TGSMT), toggle in
 * the ◈ Methodologies menu ("Displacement Radar").
 * ========================================================================== */
window.TGDisplacement = (function () {
  "use strict";

  const S = {
    chart: null, markerSeries: null, getCandles: null,
    enabled: false, minScore: 75, showPanel: true, panel: null,
  };

  function num(x) { return typeof x === "number" && isFinite(x); }

  function ensureSeries() {
    if (S.markerSeries || !S.chart) return;
    try {
      S.markerSeries = S.chart.addLineSeries({
        color: "rgba(0,0,0,0)", lineWidth: 1,
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      });
    } catch (_e) { S.markerSeries = null; }
  }

  function atr14(candles) {
    const n = candles.length;
    const out = new Array(n).fill(null);
    if (n < 15) return out;
    const trs = [0];
    for (let i = 1; i < n; i++) {
      const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
      trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    let prev = 0;
    for (let i = 1; i <= 14; i++) prev += trs[i];
    prev /= 14; out[14] = prev;
    for (let i = 15; i < n; i++) prev = (prev * 13 + trs[i]) / 14, out[i] = prev;
    return out;
  }

  function scoreLegs(candles) {
    const M = window.TGMethodology;
    if (!M || !Array.isArray(candles) || candles.length < 40) return [];
    const atrA = atr14(candles);
    const sw = M.swings(candles, 3);
    const vols = candles.map((c) => (num(c.volume) ? c.volume : 0));
    const legs = [];
    for (let k = 1; k < sw.length; k++) {
      const a = sw[k - 1], b = sw[k];
      if (a.type === b.type) continue; // need opposite pivots
      const bull = b.type === "high";
      const lo = Math.min(a.price, b.price), hi = Math.max(a.price, b.price);
      const range = hi - lo;
      if (!(range > 0)) continue;
      const bars = b.idx - a.idx;
      if (!(bars >= 2)) continue;
      const atr = atrA[b.idx];
      if (!num(atr) || atr <= 0) continue;
      let bodySum = 0, volSum = 0, vn = 0;
      for (let j = a.idx; j <= b.idx; j++) {
        const c = candles[j];
        if (!c) continue;
        bodySum += (c.close - c.open) * (bull ? 1 : -1);
        if (num(c.volume)) { volSum += c.volume; vn++; }
      }
      const bodyPct = Math.max(0, Math.min(1, bodySum / range));
      // volume vs 20-bar average before the leg
      let base = 0, bn = 0;
      for (let j = Math.max(0, a.idx - 20); j < a.idx; j++) {
        if (num(candles[j].volume)) { base += candles[j].volume; bn++; }
      }
      const baseAvg = bn ? base / bn : 1;
      const legAvg = vn ? volSum / vn : 0;
      const volScore = Math.max(0, Math.min(1, (legAvg / Math.max(baseAvg, 1e-9)) / 3));
      const speed = (range / atr) / bars;
      const speedScore = Math.max(0, Math.min(1, speed / 2));
      const score = Math.round(
        40 * bodyPct + 30 * volScore + 30 * speedScore);
      legs.push({
        fromIdx: a.idx, toIdx: b.idx, time: b.time,
        dir: bull ? "buy" : "sell", score,
        range, bars,
        price: bull ? b.price : b.price,
      });
    }
    legs.sort((x, y) => y.score - x.score);
    return legs;
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function renderPanel(legs) {
    let p = S.panel;
    if (!p) {
      p = document.createElement("div");
      p.id = "dispPanel";
      p.className = "disp-panel";
      const main = document.querySelector(".main");
      if (main) main.appendChild(p);
      S.panel = p;
    }
    const top = legs.filter((l) => l.score >= S.minScore).slice(0, 5);
    if (!S.showPanel || !top.length) { p.style.display = "none"; return; }
    p.style.display = "block";
    p.innerHTML = `<div class="disp-head">⚡ Displacement Radar</div>` +
      top.map((l) =>
        `<div class="disp-row"><span class="disp-score">${l.score}</span>` +
        `<span class="disp-dir ${l.dir}">${l.dir === "buy" ? "▲" : "▼"}</span>` +
        `<span class="disp-note">${l.bars} bars</span></div>`
      ).join("");
  }

  function clear() {
    try { if (S.markerSeries) S.markerSeries.setMarkers([]); } catch (_e) {}
    if (S.panel) S.panel.style.display = "none";
  }

  function refresh() {
    clear();
    if (!S.enabled) return;
    const candles = S.getCandles ? S.getCandles() : [];
    if (!candles.length) return;
    let legs = [];
    try { legs = scoreLegs(candles); } catch (_e) { legs = []; }
    const strong = legs.filter((l) => l.score >= S.minScore).slice(0, 12);
    ensureSeries();
    if (S.markerSeries && strong.length) {
      try {
        const last = candles[candles.length - 1];
        S.markerSeries.setData([
          { time: strong[0].time - 3600, value: last.close },
          { time: strong[0].time, value: last.close },
        ]);
        S.markerSeries.setMarkers(strong.map((l) => ({
          time: l.time,
          position: l.dir === "buy" ? "belowBar" : "aboveBar",
          color: l.score >= 90 ? "#00e5a0" : "#d4a94e",
          shape: "text",
          text: `⚡${l.score}`,
        })));
      } catch (_e) {}
    }
    renderPanel(legs);
  }

  /** Called by method-ui when the checkbox / settings change. */
  function apply(enabled, settings) {
    S.enabled = !!enabled;
    const ms = settings && settings.minScore;
    const n = parseInt(ms, 10);
    S.minScore = n >= 0 && n <= 100 ? n : 75;
    S.showPanel = !settings || settings.panel !== false;
    if (!S.enabled) { clear(); return; }
    refresh();
  }

  function onData() { if (S.enabled) refresh(); }

  function init(opts) {
    S.chart = opts.chart;
    S.getCandles = opts.getCandles;
    ensureSeries();
  }

  return { init, apply, onData, refresh, _scoreLegs: scoreLegs };
})();
