"use strict";
/* ============================================================================
 * Trader Guider — Liquidity / order-book heatmap (Level 2).
 * ----------------------------------------------------------------------------
 * Fetches public order-book depth (no key) and renders glowing horizontal
 * bars on the right side of the chart where bid/ask walls cluster. Opacity
 * scales with relative size; the biggest wall gets a 🧲 magnet tag.
 *
 * Pure HTML overlay positioned with priceToCoordinate() so bars sit exactly
 * on their price levels. Non-intrusive, collapsible, mobile-safe.
 * ========================================================================== */
window.TGLiq = (function () {
  "use strict";

  const BUCKETS = 18;

  const S = {
    chart: null, candleSeries: null, getSymbol: null,
    on: false, timer: null, busy: false, overlay: null, rangeTimer: null,
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
    if (a >= 1) return p.toFixed(3);
    return p.toFixed(5);
  }

  function ensureOverlay() {
    if (S.overlay) return S.overlay;
    const main = document.querySelector(".main");
    if (!main) return null;
    const d = document.createElement("div");
    d.id = "liqOverlay";
    d.className = "liq-overlay";
    d.style.display = "none";
    main.appendChild(d);
    S.overlay = d;
    return d;
  }

  function clear() {
    if (S.overlay) { S.overlay.innerHTML = ""; S.overlay.style.display = "none"; }
  }

  async function update() {
    if (!S.on || S.busy) return;
    const symbol = S.getSymbol ? S.getSymbol() : null;
    if (!symbol) return;
    S.busy = true;
    try {
      const j = await fetch(`/api/market/depth?symbol=${encodeURIComponent(symbol)}&limit=100`)
        .then((r) => r.json());
      const bids = Array.isArray(j.bids) ? j.bids : [];
      const asks = Array.isArray(j.asks) ? j.asks : [];
      if (!bids.length && !asks.length) { clear(); return; }
      render(bids, asks);
    } catch (_e) {
      // keep the old picture on transient failure
    } finally {
      S.busy = false;
    }
  }

  function render(bids, asks) {
    const ov = ensureOverlay();
    if (!ov || !S.candleSeries) return;
    const all = bids.concat(asks);
    let lo = Infinity, hi = -Infinity;
    for (const [p] of all) { if (p < lo) lo = p; if (p > hi) hi = p; }
    if (!(lo < hi)) { clear(); return; }

    // aggregate into price buckets
    const buckets = [];
    for (let i = 0; i < BUCKETS; i++) buckets.push({ lo: lo + ((hi - lo) * i) / BUCKETS, qty: 0, bid: 0, ask: 0 });
    function add(p, q, side) {
      let i = Math.floor(((p - lo) / (hi - lo)) * BUCKETS);
      if (i < 0) i = 0; if (i >= BUCKETS) i = BUCKETS - 1;
      buckets[i].qty += q;
      buckets[i][side] += q;
    }
    for (const [p, q] of bids) add(p, q, "bid");
    for (const [p, q] of asks) add(p, q, "ask");
    let maxQ = 0;
    for (const b of buckets) if (b.qty > maxQ) maxQ = b.qty;
    if (!(maxQ > 0)) { clear(); return; }

    let html = "";
    let magIdx = -1;
    buckets.forEach((b, i) => { if (b.qty === maxQ) magIdx = i; });
    buckets.forEach((b, i) => {
      if (!(b.qty > 0)) return;
      const mid = (b.lo + (hi - lo) / BUCKETS / 2);
      let y = null;
      try { y = S.candleSeries.priceToCoordinate(mid); } catch (_e) {}
      if (y == null || !isFinite(y)) return;
      const rel = b.qty / maxQ;
      const w = Math.round(8 + rel * 64); // px width
      const op = (0.18 + rel * 0.72).toFixed(2);
      const bidDom = b.bid >= b.ask;
      const col = bidDom ? `rgba(38,166,154,${op})` : `rgba(239,83,80,${op})`;
      const tag = i === magIdx ? `<span class="liq-mag">🧲 ${fmtP(mid)}</span>` : "";
      html += `<div class="liq-bar" style="top:${Math.round(y - 6)}px;width:${w}px;background:${col}" ` +
        `title="${bidDom ? "bid" : "ask"} wall ≈ ${fmtP(mid)}">${tag}</div>`;
    });
    ov.innerHTML = html || "";
    ov.style.display = html ? "block" : "none";
  }

  function schedule() {
    clearInterval(S.timer);
    S.timer = null;
    if (!S.on) { clear(); return; }
    update();
    S.timer = setInterval(update, 15000);
  }

  function toggle() {
    S.on = !S.on;
    const btn = document.getElementById("liqBtn");
    if (btn) btn.classList.toggle("active", S.on);
    schedule();
    return S.on;
  }

  function onSymbolChange() {
    if (S.on) update();
  }

  function init(opts) {
    S.chart = opts.chart;
    S.candleSeries = opts.candleSeries;
    S.getSymbol = opts.getSymbol;
    ensureOverlay();
    // re-align bars when the user scrolls/zooms (price scale moves)
    try {
      S.chart.timeScale().subscribeVisibleTimeRangeChange(() => {
        clearTimeout(S.rangeTimer);
        S.rangeTimer = setTimeout(() => { if (S.on) update(); }, 350);
      });
    } catch (_e) {}
    // topbar toggle button
    if (!document.getElementById("liqBtn")) {
      const rp = document.getElementById("replayBtn");
      const b = document.createElement("button");
      b.className = "link";
      b.id = "liqBtn";
      b.title = "Liquidity heatmap (order-book walls)";
      b.textContent = "💧 Liquidity";
      b.onclick = toggle;
      if (rp && rp.parentNode) rp.parentNode.insertBefore(b, rp.nextSibling);
      else {
        const tb = document.querySelector(".topbar");
        if (tb) tb.appendChild(b);
      }
    }
  }

  return { init, toggle, onSymbolChange, update };
})();
