/* ============================================================================
 * TGWatchlist — TradingView-style watchlist: Crypto / Forex / Stocks tabs.
 * Bottom sheet on mobile, right panel on desktop. Tap a row -> loads on chart.
 * Live prices from /api/market/watchlist (30s server cache), auto-refresh.
 * ========================================================================== */
window.TGWatchlist = (function () {
  "use strict";

  const S = { el: null, tab: "crypto", data: null, timer: null, onPick: null };

  function fmtP(p) {
    if (p == null || !isFinite(p)) return "—";
    return p >= 1000 ? p.toLocaleString("en-US", { maximumFractionDigits: 2 })
         : p >= 100 ? p.toFixed(2)
         : p >= 1 ? p.toFixed(3) : p.toFixed(5);
  }

  function ensure() {
    if (S.el) return S.el;
    const el = document.createElement("div");
    el.id = "wlSheet";
    el.innerHTML =
      '<div class="wl-head"><span>Watchlist</span><button class="wl-x" id="wlClose">✕</button></div>' +
      '<div class="wl-tabs">' +
        '<button class="wl-tab active" data-t="crypto">Crypto</button>' +
        '<button class="wl-tab" data-t="forex">Forex</button>' +
        '<button class="wl-tab" data-t="stocks">Stocks</button>' +
      "</div>" +
      '<div class="wl-list" id="wlList"><div class="wl-loading">Loading…</div></div>';
    document.body.appendChild(el);
    el.querySelector("#wlClose").onclick = hide;
    el.querySelectorAll(".wl-tab").forEach((b) => {
      b.onclick = () => {
        el.querySelectorAll(".wl-tab").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        S.tab = b.dataset.t;
        render();
      };
    });
    // tap outside to close (mobile)
    el.addEventListener("click", (e) => { if (e.target === el) hide(); });
    S.el = el;
    return el;
  }

  function rowHtml(it) {
    const up = it.chg != null && it.chg >= 0;
    const col = it.chg == null ? "var(--dim)" : up ? "#26a69a" : "#ef5350";
    const chg = it.chg == null ? "" : (up ? "+" : "") + it.chg.toFixed(2) + "%";
    return `<div class="wl-row" data-s="${it.s}">` +
      `<span class="wl-sym">${it.label}</span>` +
      `<span class="wl-px"><span class="wl-price">${fmtP(it.price)}</span>` +
      `<span class="wl-chg" style="color:${col}">${chg}</span></span></div>`;
  }

  function render() {
    const list = S.el.querySelector("#wlList");
    const arr = S.data && S.data[S.tab];
    if (!arr || !arr.length) { list.innerHTML = '<div class="wl-loading">Loading…</div>'; return; }
    list.innerHTML = arr.map(rowHtml).join("");
    list.querySelectorAll(".wl-row").forEach((r) => {
      r.onclick = () => {
        const sym = r.dataset.s;
        hide();
        if (S.onPick) S.onPick(sym);
        else {
          const inp = document.getElementById("symInput");
          if (inp) { inp.value = sym; inp.dispatchEvent(new Event("change", { bubbles: true })); }
        }
      };
    });
  }

  async function refresh() {
    try {
      const r = await fetch("/api/market/watchlist");
      if (!r.ok) return;
      S.data = await r.json();
      if (S.el && S.el.classList.contains("open")) render();
    } catch (_e) {}
  }

  function show() {
    const el = ensure();
    el.classList.add("open");
    render();
    refresh();
    clearInterval(S.timer);
    S.timer = setInterval(refresh, 30000);
  }

  function hide() {
    if (S.el) S.el.classList.remove("open");
    clearInterval(S.timer);
    S.timer = null;
  }

  function toggle() {
    if (S.el && S.el.classList.contains("open")) hide(); else show();
  }

  function init(opts) {
    opts = opts || {};
    if (opts.onPick) S.onPick = opts.onPick;
    // watchlist button in topbar (added if not present)
    if (!document.getElementById("wlBtn")) {
      const b = document.createElement("button");
      b.id = "wlBtn"; b.className = "link"; b.title = "Watchlist";
      b.textContent = "👁 Watchlist";
      b.style.cssText = "font-size:13px";
      b.onclick = toggle;
      const tf = document.getElementById("tfBar");
      if (tf && tf.parentElement) tf.parentElement.insertBefore(b, tf.nextSibling);
    }
  }

  return { init, show, hide, toggle, refresh };
})();
