"use strict";
/* ============================================================================
 * TGRisk — auto-lot risk calculator for the execution panel.
 *
 *   lotSize(MT5) = (balance × risk%) / (SL distance in price × valuePerPt)
 *   qty(Binance) = (balance × risk%) / (SL distance in price)   [quote currency]
 *
 * valuePerPt = account-currency value of a $1.00 price move for 1.0 lot.
 *   XAUUSD: 1 lot = 100 oz  -> $100 per $1 move
 *   XAGUSD: 1 lot = 5000 oz -> $5000 per $1 move
 *   BTCUSD/ETHUSD (Exness-style): 1 lot = 1 coin -> $1 per $1 move
 *   Forex XXXUSD: 1 lot = 100k units -> $100,000 per 1.00 move ($10/pip)
 *   Fallback (crypto spot style): $1 per $1 move
 * ========================================================================== */
window.TGRisk = (function () {
  const SPECS = [
    { re: /^XAU/i, valuePerPt: 100, label: "XAU (100 oz/lot)" },
    { re: /^XAG/i, valuePerPt: 5000, label: "XAG (5000 oz/lot)" },
    { re: /^BTC/i, valuePerPt: 1, label: "BTC (1 coin/lot)" },
    { re: /^ETH/i, valuePerPt: 1, label: "ETH (1 coin/lot)" },
    { re: /^[A-Z]{6}$/, valuePerPt: 100000, label: "Forex (100k/lot)" },
  ];
  const FALLBACK = { valuePerPt: 1, label: "Spot (1:1)" };

  const MIN_LOT = 0.01, MAX_LOT = 100;
  const MIN_QTY = 0.0001;

  let getEntry = () => 0;   // last price, injected by app.js
  let getSymbol = () => "";
  let getTarget = () => "mt5";

  function num(v, d) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : d;
  }

  function specFor(symbol) {
    const s = String(symbol || "").toUpperCase().replace(/[^A-Z]/g, "");
    for (const sp of SPECS) if (sp.re.test(s)) return sp;
    return FALLBACK;
  }

  /* Pure math — easy to unit test.
   * Returns { ok, lots|qty, riskAmt, slDist, specLabel } or { ok:false, reason }. */
  function calc(o) {
    const balance = num(o.balance, NaN);
    const riskPct = num(o.riskPct, NaN);
    const entry = num(o.entry, NaN);
    const sl = num(o.sl, NaN);
    if (!(balance > 0)) return { ok: false, reason: "Enter a balance above 0." };
    if (!(riskPct > 0) || riskPct > 100) return { ok: false, reason: "Risk % must be 0–100." };
    if (!(entry > 0) || !(sl > 0)) return { ok: false, reason: "Need entry price and SL." };
    const slDist = Math.abs(entry - sl);
    if (!(slDist > 0)) return { ok: false, reason: "SL must differ from entry." };
    const riskAmt = (balance * riskPct) / 100;

    if (o.target === "binance") {
      // quantity in base asset; riskAmt is in quote currency (USDT)
      let qty = riskAmt / slDist;
      if (!Number.isFinite(qty) || qty <= 0) return { ok: false, reason: "Bad numbers." };
      qty = Math.max(MIN_QTY, qty);
      // round to a sane precision for crypto quantities
      const rounded = qty >= 1 ? Math.round(qty * 1000) / 1000 : Math.round(qty * 100000) / 100000;
      return { ok: true, qty: rounded, riskAmt, slDist, specLabel: "Spot qty" };
    }
    // MT5-style lots
    const spec = specFor(o.symbol);
    let lots = riskAmt / (slDist * spec.valuePerPt);
    if (!Number.isFinite(lots) || lots <= 0) return { ok: false, reason: "Bad numbers." };
    lots = Math.min(MAX_LOT, Math.max(MIN_LOT, lots));
    lots = Math.round(lots * 100) / 100; // 0.01 step
    if (lots < MIN_LOT) lots = MIN_LOT;
    return { ok: true, lots, riskAmt, slDist, specLabel: spec.label };
  }

  function $(id) { return document.getElementById(id); }

  function readUI() {
    return {
      balance: num($("acctBal") && $("acctBal").value, 10000),
      riskPct: num($("riskPct") && $("riskPct").value, 1),
      sl: num($("execSL") && $("execSL").value, NaN),
      entry: num(getEntry(), NaN),
      symbol: getSymbol(),
      target: getTarget() === "mt5" ? "mt5" : "binance",
    };
  }

  /* Recompute from the panel inputs; writes the result into #lotOut and,
   * when Auto mode is on, into #execVol (the field oneClick reads). */
  function recalc() {
    const out = $("lotOut");
    const auto = $("autoLot") && $("autoLot").checked;
    const r = calc(readUI());
    if (!r.ok) {
      if (out) out.textContent = "— " + r.reason;
      return r;
    }
    const isBin = readUI().target === "binance";
    const val = isBin ? r.qty : r.lots;
    const unit = isBin ? "" : " lots";
    if (out) {
      out.textContent = `${val}${unit}  ·  risk $${r.riskAmt.toFixed(2)}  ·  SL dist ${r.slDist}  ·  ${r.specLabel}`;
      out.style.color = "var(--text)";
    }
    if (auto) {
      const vol = $("execVol");
      if (vol) { vol.value = val; vol.readOnly = true; vol.style.opacity = "0.75"; }
    } else {
      const vol = $("execVol");
      if (vol) { vol.readOnly = false; vol.style.opacity = "1"; }
    }
    return r;
  }

  /* Volume oneClick should send: calculated when Auto is on, manual otherwise. */
  function effectiveVolume() {
    const auto = $("autoLot") && $("autoLot").checked;
    if (!auto) return num($("execVol") && $("execVol").value, 0.01);
    const r = recalc();
    if (r.ok) return readUI().target === "binance" ? r.qty : r.lots;
    return num($("execVol") && $("execVol").value, 0.01);
  }

  /* Fill the SL field from the live signal engine (if a signal exists). */
  function useSignalSL() {
    const line = $("execStatus");
    try {
      const ui = window.TGMethodUI;
      const sig = ui && ui.getLastSignal ? ui.getLastSignal() : null;
      const s = sig && (sig.state === "single" || sig.state === "confluence") ? sig.signal : null;
      if (!s || !(s.sl > 0)) {
        if (line) { line.className = "status-line err"; line.textContent = "No live signal with SL right now — enable a methodology."; }
        return;
      }
      $("execSL").value = s.sl;
      if (line) {
        line.className = "status-line okk";
        line.textContent = `SL set from ${s.direction.toUpperCase()} signal (${s.tag || "signal"}) ✓ — lot size recalculated.`;
      }
      recalc();
    } catch (_e) {
      if (line) { line.className = "status-line err"; line.textContent = "Could not read signal."; }
    }
  }

  function init(opts) {
    if (opts) {
      if (opts.getEntry) getEntry = opts.getEntry;
      if (opts.getSymbol) getSymbol = opts.getSymbol;
      if (opts.getTarget) getTarget = opts.getTarget;
    }
    ["riskPct", "acctBal", "execSL"].forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener("input", recalc);
    });
    const auto = $("autoLot");
    if (auto) auto.addEventListener("change", recalc);
    const tgt = $("execTarget");
    if (tgt) tgt.addEventListener("change", recalc);
    const btn = $("useSigSL");
    if (btn) btn.addEventListener("click", useSignalSL);
    recalc();
  }

  return { init, recalc, calc, specFor, effectiveVolume, useSignalSL, setEntryGetter: (fn) => { getEntry = fn; } };
})();
