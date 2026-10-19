"use strict";
/* ============================================================================
 * Trader Guider — ICT Killzone sessions + true midnight open.
 * ----------------------------------------------------------------------------
 * Draws very-low-opacity session background boxes (Asian / London /
 * New York, UTC) for the last 5 days plus a dashed "true midnight open"
 * (00:00 UTC) horizontal line per visible day.
 *
 * Implemented as a lightweight HTML overlay positioned with
 * timeScale().timeToCoordinate() / series.priceToCoordinate() — no extra
 * chart series, no canvas fights, instant updates on scroll/zoom.
 * Toggle + settings live in the ◈ Methodologies menu ("Killzone Sessions").
 * ========================================================================== */
window.TGKZ = (function () {
  "use strict";

  const SESSIONS = [
    { name: "ASIA", start: 0, end: 3, color: "rgba(79,124,255,0.055)", edge: "rgba(79,124,255,0.25)" },
    { name: "LONDON", start: 7, end: 10, color: "rgba(212,169,78,0.06)", edge: "rgba(212,169,78,0.28)" },
    { name: "NEW YORK", start: 12, end: 15, color: "rgba(38,166,154,0.055)", edge: "rgba(38,166,154,0.28)" },
  ];

  const S = {
    chart: null, candleSeries: null, getCandles: null,
    enabled: false, showBoxes: true, showMidnight: true,
    overlay: null, rangeTimer: null, renderTimer: null,
  };

  function num(x) { return typeof x === "number" && isFinite(x); }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function fmtP(p) {
    if (!num(p)) return "—";
    const a = Math.abs(p);
    if (a >= 1000) return p.toLocaleString("en-US", { maximumFractionDigits: 1 });
    if (a >= 100) return p.toFixed(2);
    return p.toFixed(4);
  }

  function ensureOverlay() {
    if (S.overlay) return S.overlay;
    const main = document.querySelector(".main");
    if (!main) return null;
    const d = document.createElement("div");
    d.id = "kzOverlay";
    d.className = "kz-overlay";
    d.style.display = "none";
    main.appendChild(d);
    S.overlay = d;
    return d;
  }

  function clear() {
    if (S.overlay) { S.overlay.innerHTML = ""; S.overlay.style.display = "none"; }
  }

  function render() {
    clearTimeout(S.renderTimer);
    S.renderTimer = setTimeout(doRender, 60);
  }

  function doRender() {
    const ov = ensureOverlay();
    if (!ov || !S.chart || !S.candleSeries) return;
    if (!S.enabled || (!S.showBoxes && !S.showMidnight)) { clear(); return; }
    const candles = S.getCandles ? S.getCandles() : [];
    if (!Array.isArray(candles) || candles.length < 30) { clear(); return; }

    const ts = S.chart.timeScale();
    let html = "";
    const nowDay = Math.floor(Date.now() / 1000 / 86400);

    // ---- session boxes: last 5 UTC days ----
    if (S.showBoxes) {
      for (let d = 0; d < 5; d++) {
        const dayStart = (nowDay - d) * 86400;
        for (const s of SESSIONS) {
          const t1 = dayStart + s.start * 3600;
          const t2 = dayStart + s.end * 3600;
          let x1 = null, x2 = null;
          try {
            x1 = ts.timeToCoordinate(t1);
            x2 = ts.timeToCoordinate(t2);
          } catch (_e) {}
          if (x1 == null || x2 == null || !isFinite(x1) || !isFinite(x2)) continue;
          const left = Math.round(Math.min(x1, x2));
          const width = Math.round(Math.abs(x2 - x1));
          if (width < 4) continue;
          html += `<div class="kz-box" style="left:${left}px;width:${width}px;` +
            `background:${s.color};border-left:1px dashed ${s.edge};border-right:1px dashed ${s.edge}">` +
            `<span class="kz-label">${s.name}</span></div>`;
        }
      }
    }

    // ---- true midnight open: horizontal dashed line per visible day ----
    if (S.showMidnight) {
      // index candles by day for O(1) lookup
      const byDay = new Map();
      for (const c of candles) {
        if (!c || !num(c.time) || !num(c.open)) continue;
        const day = Math.floor(c.time / 86400);
        if (!byDay.has(day)) byDay.set(day, c); // first candle of the day ≈ 00:00 UTC open
      }
      const days = Array.from(byDay.keys()).sort((a, b) => b - a).slice(0, 5);
      for (const day of days) {
        const c = byDay.get(day);
        let y = null;
        try { y = S.candleSeries.priceToCoordinate(c.open); } catch (_e) {}
        if (y == null || !isFinite(y)) continue;
        html += `<div class="kz-midnight" style="top:${Math.round(y)}px" ` +
          `title="True midnight open (00:00 UTC)">${""}</div>` +
          `<div class="kz-midnight-label" style="top:${Math.round(y) - 14}px">00:00 open ${fmtP(c.open)}</div>`;
      }
    }

    ov.innerHTML = html;
    ov.style.display = html ? "block" : "none";
  }

  /** Called by method-ui when the checkbox / settings change. */
  function apply(enabled, settings) {
    S.enabled = !!enabled;
    if (settings) {
      if (typeof settings.boxes === "boolean") S.showBoxes = settings.boxes;
      if (typeof settings.midnight === "boolean") S.showMidnight = settings.midnight;
    }
    render();
  }

  function onData() {
    if (S.enabled) render();
  }

  function init(opts) {
    S.chart = opts.chart;
    S.candleSeries = opts.candleSeries;
    S.getCandles = opts.getCandles;
    ensureOverlay();
    try {
      const ts = S.chart.timeScale();
      const h = () => {
        clearTimeout(S.rangeTimer);
        S.rangeTimer = setTimeout(() => { if (S.enabled) render(); }, 300);
      };
      if (typeof ts.subscribeVisibleTimeRangeChange === "function") {
        ts.subscribeVisibleTimeRangeChange(h);
      } else if (typeof ts.subscribeVisibleLogicalRangeChange === "function") {
        ts.subscribeVisibleLogicalRangeChange(h);
      }
    } catch (_e) {}
  }

  return { init, apply, onData };
})();
