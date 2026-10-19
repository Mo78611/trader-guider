"use strict";
/* ============================================================================
 * TGReplay — bar replay / backtesting mode (TradingView-style).
 *
 * Full candle data always stays in state.candles. When replay is active,
 * the visible slice is candles with time <= cutoff. Indicators, methodologies
 * and the signal engine recompute on the slice only (via viewCandles()).
 * Drawings keep absolute times from the full array — never corrupted.
 * Paper trading during replay uses the last VISIBLE close as the price.
 * ========================================================================== */
window.TGReplay = (function () {
  let getFull = () => [];
  let onRender = () => {};
  let getHint = () => null;

  const R = {
    on: false,       // replay running (sliced view)
    armed: false,     // waiting for the user to click a cutoff candle
    cutoff: 0,       // unix time of last visible candle
    timer: null,
    speed: 1,        // 1 | 2 | 4
    speeds: [1, 2, 4],
  };

  function $(id) { return document.getElementById(id); }

  function full() { const c = getFull(); return Array.isArray(c) ? c : []; }

  function active() { return R.on; }
  function cutoff() { return R.cutoff; }

  function idxOf(time) {
    const c = full();
    for (let i = 0; i < c.length; i++) if (c[i].time >= time) return i;
    return c.length - 1;
  }

  function lastClose() {
    const v = visible();
    return v.length ? v[v.length - 1].close : 0;
  }

  function visible() {
    const c = full();
    if (!R.on || !R.cutoff) return c;
    return c.filter((k) => k.time <= R.cutoff);
  }

  function barEl() { return $("replayBar"); }

  function showBar() {
    let bar = barEl();
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "replayBar";
      bar.innerHTML = `
        <span class="rp-title">⏪ REPLAY</span>
        <button class="btn rp-btn" id="rpBack" title="Step back 1 bar">◀</button>
        <button class="btn rp-btn" id="rpPlay" title="Play / pause">▶</button>
        <button class="btn rp-btn" id="rpFwd" title="Step forward 1 bar">▶|</button>
        <button class="btn rp-btn" id="rpSpeed" title="Playback speed">1x</button>
        <span class="rp-count" id="rpCount"></span>
        <button class="btn rp-btn rp-exit" id="rpExit" title="Exit replay">✕ Exit</button>`;
      document.body.appendChild(bar);
      $("rpBack").onclick = () => step(-1);
      $("rpPlay").onclick = togglePlay;
      $("rpFwd").onclick = () => step(1);
      $("rpSpeed").onclick = cycleSpeed;
      $("rpExit").onclick = exit;
    }
    bar.style.display = "flex";
    updateCount();
  }

  function hideBar() {
    const bar = barEl();
    if (bar) bar.style.display = "none";
  }

  function updateCount() {
    const el = $("rpCount");
    if (!el) return;
    const c = full();
    const i = idxOf(R.cutoff);
    el.textContent = c.length ? `bar ${i + 1} / ${c.length}` : "";
  }

  function setHint(t) {
    const h = getHint();
    if (h) h.textContent = t;
  }

  /* ---- public: arm from the topbar button, then next chart click starts ---- */
  function arm() {
    if (R.on) { exit(); return; } // button toggles
    R.armed = true;
    setHint("Replay: click any candle on the chart — replay starts from there.");
  }

  function onChartClick(p) {
    if (!R.armed) return;
    if (!p || p.time == null) return;
    R.armed = false;
    startAt(p.time);
  }

  function startAt(time) {
    const c = full();
    if (!c.length) return;
    const i = idxOf(time);
    // need a few bars of history so indicators can compute
    const startI = Math.max(0, Math.min(i, c.length - 1));
    R.cutoff = c[startI].time;
    R.on = true;
    R.speed = 1;
    const sp = $("rpSpeed"); if (sp) sp.textContent = "1x";
    setPlayIcon(false);
    showBar();
    onRender();
    setHint("Replay mode — paper-trade from the sliced market. Exit restores live data.");
  }

  /* Move the cutoff by d bars. Returns false when the end is reached. */
  function step(d) {
    if (!R.on) return false;
    const c = full();
    let i = idxOf(R.cutoff) + d;
    if (i >= c.length) { i = c.length - 1; pause(); }
    if (i < 0) i = 0;
    R.cutoff = c[i].time;
    updateCount();
    onRender();
    return i < c.length - 1;
  }

  function setPlayIcon(playing) {
    const b = $("rpPlay");
    if (b) b.textContent = playing ? "⏸" : "▶";
  }

  function togglePlay() {
    if (R.timer) { pause(); return; }
    R.timer = setInterval(() => {
      if (!step(1)) { /* reached the end -> paused */ }
    }, Math.round(1000 / R.speed));
    setPlayIcon(true);
  }

  function pause() {
    if (R.timer) { clearInterval(R.timer); R.timer = null; }
    setPlayIcon(false);
  }

  function cycleSpeed() {
    const i = (R.speeds.indexOf(R.speed) + 1) % R.speeds.length;
    R.speed = R.speeds[i];
    const b = $("rpSpeed");
    if (b) b.textContent = R.speed + "x";
    if (R.timer) { pause(); togglePlay(); } // restart at new speed
  }

  function exit() {
    pause();
    R.on = false; R.cutoff = 0; R.armed = false;
    hideBar();
    onRender();
    setHint("Replay exited — live data restored.");
  }

  function init(opts) {
    if (opts) {
      if (opts.getFull) getFull = opts.getFull;
      if (opts.onRender) onRender = opts.onRender;
      if (opts.getHint) getHint = opts.getHint;
    }
    const btn = $("replayBtn");
    if (btn) btn.onclick = arm;
  }

  return { init, arm, onChartClick, active, cutoff, visible, lastClose, step, exit };
})();
