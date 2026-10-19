"use strict";
/* ============================================================================
 * Trader Guider — Live Strategy Estimator.
 * ----------------------------------------------------------------------------
 * Watches the ticked methodologies in the ◈ Methodologies menu and instantly
 * shows:
 *   a) estimated trade frequency  (≈ X trades/week, ≈ Y/month)
 *   b) estimated win rate          (≈ Z%)
 *   c) strictness meter            (0-100 gauge, green -> yellow -> red)
 *   d) AI suggestion line          (too strict / too loose / add confluence)
 *
 * HEURISTIC MODEL (ESTIMATE ONLY — not a promise, not backtested):
 *   Each methodology has a base signal rate (signals/week on the 1H chart)
 *   and a base win rate from long-run observation of the detection logic.
 *   Combined (AND logic, all must agree):
 *     freq  = min(freqs) * 0.55^(n-1)
 *     win   = avg(wins) + 2.5*(n-1), capped at 80
 *   Rationale: every extra required condition roughly halves the setups
 *   (0.55 factor) while confluence adds a few points of edge (2.5 each).
 *   Numbers are rounded for display. Label on screen always says
 *   "Estimates from model — not guarantees".
 * ========================================================================== */
window.TGEstimator = (function () {
  "use strict";

  // baseFreq: signals/week on 1H. baseWin: long-run win-rate %.
  var MODEL = {
    ict:          { label: "ICT",               freq: 8,  win: 62 },
    smc:          { label: "SMC",               freq: 7,  win: 60 },
    vsa:          { label: "VSA",               freq: 12, win: 58 },
    priceaction:  { label: "Price Action",      freq: 10, win: 57 },
    elliott:      { label: "Elliott Wave",      freq: 2,  win: 55 },
    patterns:     { label: "Chart Patterns",    freq: 3,  win: 56 },
    trendsr:      { label: "Trendlines + S/R",  freq: 6,  win: 59 },
    autodraw:     { label: "Auto-Draw",         freq: 5,  win: 62 },
    sentiment:    { label: "Sentiment & News",  freq: 5,  win: 54 },
    smt:          { label: "SMT Divergence",    freq: 4,  win: 58 },
    displacement: { label: "Displacement Radar",freq: 9,  win: 56 },
    magnets:      { label: "Sweep Magnets",     freq: 6,  win: 55 },
    // kzones is a session overlay, not a signal source -> excluded on purpose
  };

  /**
   * Pure math — no DOM. Returns null when nothing is checked.
   * keys: array of methodology keys, e.g. ["ict","vsa"]
   */
  function compute(keys) {
    var act = (keys || []).filter(function (k) { return MODEL[k]; });
    if (!act.length) return null;
    var n = act.length;
    var minF = Infinity, sumW = 0;
    for (var i = 0; i < n; i++) {
      var m = MODEL[act[i]];
      if (m.freq < minF) minF = m.freq;
      sumW += m.win;
    }
    var freqW = minF * Math.pow(0.55, n - 1);
    var win = Math.min(80, sumW / n + 2.5 * (n - 1));
    // strictness 0..100: grows with each extra condition and with falling frequency
    var strict = Math.round(20 * (n - 1) + ((12 - Math.min(freqW, 12)) / 12) * 40);
    strict = Math.max(0, Math.min(100, strict));

    var tip = "", tipKind = "ok";
    if (freqW < 1) {
      // find the weakest link (lowest base win rate) and show life without it
      var worst = act[0], worstW = MODEL[act[0]].win;
      for (var j = 1; j < n; j++) {
        if (MODEL[act[j]].win < worstW) { worst = act[j]; worstW = MODEL[act[j]].win; }
      }
      var rest = act.filter(function (k) { return k !== worst; });
      var alt = compute(rest);
      tip = "⚠️ Too strict — uncheck '" + MODEL[worst].label + "' → ≈" +
        alt.freqW.toFixed(1) + "/week at ~" + Math.round(alt.win) + "%";
      tipKind = "bad";
    } else if (freqW > 30) {
      tip = "⚠️ Too loose — tick one more methodology to add a filter.";
      tipKind = "warn";
    } else if (n === 1) {
      tip = "Single system — add one more for confluence (+~2.5% win rate).";
      tipKind = "warn";
    } else {
      tip = "Balanced ✓ — workable frequency with confluence edge.";
      tipKind = "ok";
    }

    return {
      n: n,
      keys: act.slice(),
      freqW: Math.round(freqW * 10) / 10,
      freqM: Math.round(freqW * 4.3 * 10) / 10,
      win: Math.round(win),
      strict: strict,
      tip: tip,
      tipKind: tipKind,
    };
  }

  /* ---------------- widget DOM ---------------- */
  var S = { getState: null, built: false, collapsed: false };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function build() {
    if (S.built) return;
    // Proper placement (user rule 2026-10-19): the estimator is a PANEL below
    // the chart, never an overlay in the topbar. It sits in the .panels grid
    // right after the execution section — on PC it shares the grid row,
    // on mobile it stacks like every other panel.
    var panels = document.querySelector(".panels");
    if (!panels || document.getElementById("estWrap")) return;
    var div = document.createElement("div");
    div.id = "estWrap";
    div.className = "sec";
    div.style.display = "none";
    div.innerHTML =
      '<h3 style="cursor:pointer" id="estHead">📊 Live estimate <span class="chev">▾</span></h3>' +
      '<div class="est-body" id="estBody">' +
        '<div class="est-line" id="estFreq"></div>' +
        '<div class="est-line" id="estWin"></div>' +
        '<div class="est-meter"><div class="est-fill" id="estFill"></div></div>' +
        '<div class="est-tip" id="estTip"></div>' +
        '<div class="est-note">Estimates from model — not guarantees.</div>' +
      "</div>";
    var exec = document.getElementById("execSec");
    if (exec && exec.parentNode === panels && exec.nextSibling) {
      panels.insertBefore(div, exec.nextSibling);
    } else {
      panels.prepend(div);
    }
    document.getElementById("estHead").onclick = function () {
      S.collapsed = !S.collapsed;
      document.getElementById("estBody").style.display = S.collapsed ? "none" : "block";
    };
    S.built = true;
  }

  function activeKeys() {
    var out = [];
    try {
      var st = S.getState ? S.getState() : null;
      if (!st) return out;
      for (var k in MODEL) {
        if (st[k] && st[k].enabled) out.push(k);
      }
    } catch (_e) {}
    return out;
  }

  function update() {
    if (!S.built) build();
    var box = document.getElementById("estWrap");
    if (!box) return;
    var r = compute(activeKeys());
    if (!r) { box.style.display = "none"; return; }
    box.style.display = "block";
    document.getElementById("estFreq").textContent =
      "≈ " + r.freqW.toFixed(1) + " trades/week · ≈ " + r.freqM.toFixed(1) + "/month";
    document.getElementById("estWin").textContent = "≈ " + r.win + "% win rate";
    var fill = document.getElementById("estFill");
    fill.style.width = r.strict + "%";
    fill.style.background = r.strict < 40 ? "var(--green)" :
      r.strict <= 70 ? "#f0b429" : "var(--red)";
    var tip = document.getElementById("estTip");
    tip.textContent = r.tip;
    tip.className = "est-tip " + r.tipKind;
  }

  function init(opts) {
    S.getState = opts && opts.getState ? opts.getState : null;
    build();
    update();
  }

  return { init: init, update: update, compute: compute, MODEL: MODEL };
})();
