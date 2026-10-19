"use strict";
/* ============================================================================
 * Trader Guider — MTF Heatmap widget.
 * ----------------------------------------------------------------------------
 * Small overlay (top-right of the chart) showing the trend bias of the
 * CURRENT symbol on 15m / 1H / 4H / 1D simultaneously — no tab switching.
 *
 * Per timeframe: EMA20 vs EMA50 (trend) + RSI(14) (momentum):
 *   up   = EMA20 > EMA50 and RSI > 55
 *   down = EMA20 < EMA50 and RSI < 45
 *   flat = anything else / insufficient data
 *
 * Pure overlay div — never touches chart series. Fetches klines in the
 * background, refreshes every 60s and whenever the symbol changes.
 * ========================================================================== */
window.TGMTF = (function () {
  "use strict";

  const TFS = ["15m", "1h", "4h", "1d"];
  const IDS = { "15m": "mtf-15m", "1h": "mtf-1h", "4h": "mtf-4h", "1d": "mtf-1d" };

  const S = {
    getSymbol: null, timer: null, inflight: false,
    collapsed: false,
  };

  function lastValid(arr) {
    if (!Array.isArray(arr)) return null;
    for (let i = arr.length - 1; i >= 0; i--) {
      const v = arr[i];
      if (typeof v === "number" && isFinite(v)) return v;
    }
    return null;
  }

  function biasOf(candles) {
    try {
      const IND = window.TGIndicators;
      if (!IND || !candles || candles.length < 60) return "flat";
      const closes = candles.map((c) => c.close);
      const e20 = lastValid(IND.ema(closes, 20));
      const e50 = lastValid(IND.ema(closes, 50));
      const rsi = lastValid(IND.rsi(closes, 14));
      if (e20 == null || e50 == null || rsi == null) return "flat";
      if (e20 > e50 && rsi > 55) return "up";
      if (e20 < e50 && rsi < 45) return "down";
      return "flat";
    } catch (_e) {
      return "flat";
    }
  }

  function paint(tf, bias) {
    const el = document.getElementById(IDS[tf]);
    if (!el) return;
    el.className = "mtf-badge " + bias;
    el.textContent = bias === "up" ? "▲ UP" : bias === "down" ? "▼ DN" : "— FLAT";
  }

  function paintAllLoading() {
    for (const tf of TFS) {
      const el = document.getElementById(IDS[tf]);
      if (el) { el.className = "mtf-badge flat"; el.textContent = "…"; }
    }
  }

  async function refresh() {
    if (S.inflight) return;
    const sym = S.getSymbol ? S.getSymbol() : null;
    if (!sym) return;
    S.inflight = true;
    try {
      const jobs = TFS.map(async (tf) => {
        try {
          const r = await fetch(`/api/market/klines?symbol=${encodeURIComponent(sym)}&interval=${tf}&limit=120`);
          if (!r.ok) return { tf, bias: "flat" };
          const j = await r.json();
          return { tf, bias: biasOf(j.candles) };
        } catch (_e) {
          return { tf, bias: "flat" };
        }
      });
      const results = await Promise.all(jobs);
      // only paint if the symbol didn't change mid-flight
      if (S.getSymbol && S.getSymbol() === sym) {
        for (const { tf, bias } of results) paint(tf, bias);
      }
    } finally {
      S.inflight = false;
    }
  }

  function onSymbolChange() {
    paintAllLoading();
    refresh();
  }

  function init(opts) {
    S.getSymbol = opts.getSymbol;
    const head = document.getElementById("mtfHead");
    const widget = document.getElementById("mtfWidget");
    const chev = document.getElementById("mtfChev");
    if (head && widget) {
      head.onclick = () => {
        S.collapsed = !S.collapsed;
        widget.classList.toggle("collapsed", S.collapsed);
        if (chev) chev.textContent = S.collapsed ? "▸" : "▾";
      };
    }
    paintAllLoading();
    refresh();
    clearInterval(S.timer);
    S.timer = setInterval(refresh, 60000);
  }

  return { init, refresh, onSymbolChange };
})();
