"use strict";
/* ============================================================================
 * Trader Guider — News Radar + Sentiment widget.
 * - Topbar "News" button toggles a floating panel.
 * - Panel: sentiment gauge (long/short bar + Fear & Greed) + upcoming
 *   high-impact events with % bias ("70% Bullish ...") and expected move.
 * - Auto-refresh every 30 min; refreshes on symbol change.
 * - Simple English strings (user's English is limited).
 * ========================================================================== */
window.TGNews = (function () {
  "use strict";

  const S = { getSymbol: null, getTrend: null, timer: null, open: false, busy: false };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }
  function localTime(iso) {
    try {
      const d = new Date(iso);
      return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    } catch (_e) { return ""; }
  }
  function countdown(iso) {
    const ms = new Date(iso).getTime() - Date.now();
    if (ms < 0) return "now";
    const h = Math.floor(ms / 3600e3), d = Math.floor(h / 24);
    if (d > 0) return `${d}d ${h % 24}h`;
    if (h > 0) return `${h}h ${Math.floor((ms % 3600e3) / 60e3)}m`;
    return `${Math.max(1, Math.floor(ms / 60e3))}m`;
  }

  function buildUI() {
    if (document.getElementById("newsBtn")) return;
    const topbar = document.querySelector(".topbar");
    const btn = document.createElement("button");
    btn.className = "link"; btn.id = "newsBtn"; btn.textContent = "📰 News";
    btn.title = "News radar + sentiment";
    const hub = document.querySelector(".topbar button.link");
    topbar.insertBefore(btn, hub);
    btn.onclick = (e) => { e.stopPropagation(); toggle(); };
    document.addEventListener("click", (e) => {
      const p = document.getElementById("newsPanel");
      if (p && p.classList.contains("open") && !e.target.closest("#newsPanel") && !e.target.closest("#newsBtn")) {
        p.classList.remove("open"); S.open = false;
      }
    });

    const panel = document.createElement("div");
    panel.className = "news-panel"; panel.id = "newsPanel";
    panel.innerHTML = `
      <div class="news-head"><span>📰 News Radar</span><button class="x" id="newsClose">×</button></div>
      <div class="news-sec">
        <div class="news-sec-t">Market mood</div>
        <div id="newsSent"><div class="news-dim">Loading…</div></div>
      </div>
      <div class="news-sec">
        <div class="news-sec-t">Coming news (USD)</div>
        <div id="newsEvents"><div class="news-dim">Loading…</div></div>
      </div>
      <div class="news-foot">Bias = % chance of price direction. Est. move only.</div>`;
    document.body.appendChild(panel);
    document.getElementById("newsClose").onclick = () => { panel.classList.remove("open"); S.open = false; };
  }

  function toggle() {
    const p = document.getElementById("newsPanel");
    S.open = !S.open;
    p.classList.toggle("open", S.open);
    if (S.open) refresh();
  }

  function renderSentiment(box, d) {
    if (!d || (d.longPct == null && !d.fearGreed)) {
      box.innerHTML = `<div class="news-dim">No mood data right now.</div>`;
      return;
    }
    const lp = d.longPct, sp = d.shortPct;
    const fg = d.fearGreed;
    let fgColor = "#8b94a7";
    if (fg) {
      fgColor = fg.value >= 55 ? "#26a69a" : fg.value <= 45 ? "#ef5350" : "#d4a94e";
    }
    box.innerHTML = `
      ${lp != null ? `
      <div class="lsbar"><div class="ls-long" style="width:${lp}%"></div><div class="ls-short" style="width:${sp}%"></div></div>
      <div class="ls-labels"><span style="color:#7fe3d8">Long ${lp}%</span><span style="color:#f5a3a1">Short ${sp}%</span></div>` : ""}
      ${fg ? `<div class="fg-row"><span class="news-dim">Fear &amp; Greed</span>
        <b style="color:${fgColor}">${fg.value} · ${esc(fg.label)}</b></div>` : ""}
      <div class="news-note">${esc(d.smartMoneyNote || "")}</div>
      ${d.venue ? `<div class="news-foot" style="padding:4px 0 0">L/S data: ${esc(d.venue)}</div>` : ""}`;
  }

  function renderEvents(box, events) {
    if (!events || !events.length) {
      box.innerHTML = `<div class="news-dim">No big news in the next days.</div>`;
      return;
    }
    box.innerHTML = events.slice(0, 8).map((ev) => {
      const b = ev.bias || {};
      const cls = b.direction === "bullish" ? "up" : b.direction === "bearish" ? "down" : "flat";
      return `<div class="news-ev">
        <div class="news-ev-top">
          <span class="impact-dot t${ev.tier || 2}"></span>
          <b>${esc(ev.title)}</b>
          <span class="news-when">${esc(localTime(ev.time))} · in ${esc(countdown(ev.time))}</span>
        </div>
        <div class="news-fp">${ev.forecast != null ? `Forecast <b>${esc(ev.forecast)}</b>` : "Forecast —"}
          &nbsp;·&nbsp; ${ev.previous != null ? `Last <b>${esc(ev.previous)}</b>` : "Last —"}</div>
        <div class="news-bias ${cls}">${esc(b.text || "")}</div>
        <div class="news-move">${esc(ev.expectedMove || "")}</div>
      </div>`;
    }).join("");
  }

  async function refresh() {
    if (S.busy) return;
    S.busy = true;
    const sym = S.getSymbol ? S.getSymbol() : "BTCUSDT";
    const trend = S.getTrend ? S.getTrend() : null;
    try {
      const [up, se] = await Promise.all([
        fetch(`/api/news/upcoming?asset=${encodeURIComponent(sym)}${trend ? `&trend=${trend}` : ""}`).then((r) => r.json()).catch(() => null),
        fetch(`/api/news/sentiment?symbol=${encodeURIComponent(sym)}`).then((r) => r.json()).catch(() => null),
      ]);
      const sentBox = document.getElementById("newsSent");
      const evBox = document.getElementById("newsEvents");
      if (sentBox) renderSentiment(sentBox, se);
      if (evBox) renderEvents(evBox, up && up.events);
    } catch (_e) { /* panel keeps old content */ }
    S.busy = false;
  }

  function onSymbolChange() { refresh(); }

  function init(opts) {
    S.getSymbol = opts.getSymbol;
    S.getTrend = opts.getTrend;
    buildUI();
    clearInterval(S.timer);
    S.timer = setInterval(refresh, 30 * 60 * 1000);
    // lazy first load: only fetch when the user opens the panel or sentiment
    // methodology is enabled (method-ui triggers via TGNews.prefetch)
  }

  function prefetch() { refresh(); } // called by method-ui when sentiment method enabled

  return { init, onSymbolChange, refresh, prefetch };
})();
