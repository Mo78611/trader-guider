"use strict";
/* ============================================================================
 * Trader Guider — Footprint logger (personal smart-money stats).
 * ----------------------------------------------------------------------------
 * Logs methodology events the user cares about so the engine can later tell
 * them what *their* marked setups did next:
 *   - every drawing the user creates (auto-logged as drawing:<kind>)
 *   - ⭐ on the signal panel (logs the live BUY/SELL plan)
 *   - manual "log current chart" from the Lab page
 *
 * Outcomes (MFE/MAE/return) are computed lazily by /api/lab/footprint-stats.
 * All network failures are silent — logging must never interrupt trading.
 * ========================================================================== */
window.TGFootprints = (function () {
  "use strict";

  const S = {
    getSymbol: null, getTimeframe: null, getLastClose: null, getLastTime: null,
  };

  function sessionOf(timeSec) {
    const h = new Date(timeSec * 1000).getUTCHours();
    if (h < 3) return "Asia";
    if (h >= 7 && h < 10) return "London";
    if (h >= 12 && h < 15) return "New York";
    return "Off-hours";
  }

  async function log(type, data) {
    try {
      data = data || {};
      const time = data.time || (S.getLastTime ? S.getLastTime() : Math.floor(Date.now() / 1000));
      const body = {
        type: String(type || "manual").slice(0, 40),
        symbol: data.symbol || (S.getSymbol ? S.getSymbol() : "BTCUSDT"),
        timeframe: data.timeframe || (S.getTimeframe ? S.getTimeframe() : "1h"),
        price: data.price != null ? data.price : (S.getLastClose ? S.getLastClose() : 0),
        time,
        dir: data.dir || "",
        note: String(data.note || "").slice(0, 200),
      };
      if (!(body.price > 0) || !(body.time > 0)) return false;
      body.session = sessionOf(body.time);
      const r = await fetch("/api/lab/footprints", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return r.ok;
    } catch (_e) { return false; }
  }

  /** Log the current live signal from the signal panel (⭐ button). */
  async function logSignal() {
    try {
      const sig = window.TGMethodUI ? window.TGMethodUI.getLastSignal() : null;
      if (!sig || (sig.state !== "single" && sig.state !== "confluence") || !sig.signal) {
        return { ok: false, msg: "No live signal to log." };
      }
      const s = sig.signal;
      const ok = await log("signal", {
        price: s.entry, dir: s.direction,
        note: `${s.tag || ""} entry ${s.entry} sl ${s.sl}`.slice(0, 200),
      });
      return { ok, msg: ok ? "Signal saved to Footprints ✓" : "Save failed." };
    } catch (_e) { return { ok: false, msg: "Save failed." }; }
  }

  function init(opts) {
    S.getSymbol = opts.getSymbol || null;
    S.getTimeframe = opts.getTimeframe || null;
    S.getLastClose = opts.getLastClose || null;
    S.getLastTime = opts.getLastTime || null;
  }

  return { init, log, logSignal };
})();
