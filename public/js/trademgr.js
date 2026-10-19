"use strict";
/* ============================================================================
 * Trader Guider — Auto Trade Manager.
 * ----------------------------------------------------------------------------
 * Tracks every executed order (DRY_RUN paper, bridge, or binance) in the
 * server-side paper_trades table and applies the user's automation rules:
 *
 *   Auto Break-Even — when price reaches +1R, SL moves to entry.
 *   Auto Partial    — at TP1 (or +1.5R when no TP1), 50% of qty closes.
 *
 * Bridge trades: rules are pushed to the bridge (/api/execute/mt5/modify and
 * /close_partial). If the bridge is offline the trade is paper-simulated and
 * clearly marked as simulated.
 * Paper trades: rules are simulated in the tracker (SL/TP fields updated on
 * the server so state survives reloads).
 *
 * Live P/L is shown in the Positions panel (#trackedBox). Live price comes
 * from the public ticker, polled every 10s — no websockets needed.
 * ========================================================================== */
window.TGTradeMgr = (function () {
  "use strict";

  const S = {
    trades: [], prices: {}, timer: null, user: null,
  };

  function num(x) { return typeof x === "number" && isFinite(x); }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function fmtP(p) {
    if (!num(p)) return "—";
    const a = Math.abs(p);
    if (a >= 1000) return p.toLocaleString("en-US", { maximumFractionDigits: 2 });
    if (a >= 100) return p.toFixed(2);
    if (a >= 1) return p.toFixed(3);
    return p.toFixed(5);
  }

  /* ---------------- server API ---------------- */
  async function api(path, body) {
    const r = await fetch(`/api/execute/paper${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return r.json();
  }

  async function load() {
    try {
      const j = await api("");
      S.trades = Array.isArray(j.trades) ? j.trades : [];
    } catch (_e) {
      S.trades = [];
    }
    render();
  }

  /** Register a trade right after an order was sent/logged. */
  async function track(trade) {
    try {
      const j = await api("", {
        symbol: trade.symbol, side: trade.side, entry: trade.entry,
        sl: trade.sl || 0, tp: trade.tp || 0, qty: trade.qty || 0,
        auto_be: trade.auto_be !== false, auto_partial: trade.auto_partial !== false,
        bridge_ticket: trade.bridge_ticket || null, target: trade.target || "paper",
      });
      if (j && j.ok) await load();
      return j && j.id;
    } catch (_e) {
      return null;
    }
  }

  async function closeTrade(id) {
    // pass the last known price so the server can score realized P/L (tilt-lock)
    const t = S.trades.find((x) => x.id === id);
    const cached = t ? S.prices[t.symbol] : null;
    try { await api(`/${id}/close`, cached && cached.p > 0 ? { exit_price: cached.p } : {}); } catch (_e) {}
    await load();
    // a fresh loss may have armed the tilt-lock — refresh its banner immediately
    try { if (window.TGTilt) window.TGTilt.refresh(); } catch (_e2) {}
  }

  async function setAuto(id, kind, on) {
    try { await api(`/${id}`, kind === "be" ? { auto_be: on } : { auto_partial: on }); } catch (_e) {}
    await load();
  }

  /* ---------------- live prices ---------------- */
  async function tickPrice(symbol) {
    if (S.prices[symbol] && Date.now() - S.prices[symbol].t < 15000) {
      return S.prices[symbol].p;
    }
    try {
      const j = await fetch(`/api/market/ticker?symbol=${encodeURIComponent(symbol)}`).then((r) => r.json());
      const p = parseFloat(j.lastPrice);
      if (p > 0) {
        S.prices[symbol] = { p, t: Date.now() };
        return p;
      }
    } catch (_e) {}
    return S.prices[symbol] ? S.prices[symbol].p : null;
  }

  /* ---------------- automation rules ---------------- */
  function rMultiple(trade, price) {
    const bull = trade.side === "buy";
    const risk = bull ? trade.entry - trade.sl : trade.sl - trade.entry;
    if (!(risk > 0)) return null;
    const move = bull ? price - trade.entry : trade.entry - price;
    return move / risk;
  }

  async function applyRules() {
    for (const t of S.trades) {
      if (t.status !== "open") continue;
      const price = await tickPrice(t.symbol);
      if (!(price > 0)) continue;
      const R = rMultiple(t, price);
      if (R == null) continue;

      // --- Auto break-even at +1R ---
      if (t.auto_be && !t.be_moved && R >= 1 && t.sl !== t.entry) {
        await moveSL(t, t.entry);
      }
      // --- Auto partial at TP1 or +1.5R ---
      const tp1Hit = t.tp > 0 && (t.side === "buy" ? price >= t.tp : price <= t.tp);
      if (t.auto_partial && !t.partial_done && (tp1Hit || R >= 1.5) && t.qty > 0) {
        await partialClose(t);
      }
      // --- paper stop-out / take-profit simulation ---
      if (t.target === "paper") {
        const bull = t.side === "buy";
        if (t.sl > 0 && (bull ? price <= t.sl : price >= t.sl)) {
          await closeTrade(t.id);
        } else if (t.tp > 0 && (bull ? price >= t.tp : price <= t.tp)) {
          await closeTrade(t.id);
        }
      }
    }
    render();
  }

  async function moveSL(t, newSL) {
    const isBridge = t.bridge_ticket && t.target === "mt5";
    if (isBridge) {
      try {
        const r = await fetch("/api/execute/mt5/modify", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ticket: t.bridge_ticket, sl: newSL }),
        }).then((x) => x.json());
        if (r && !r.error && !r.dryRun) {
          await api(`/${t.id}`, { sl: newSL, be_moved: true });
        } else {
          // bridge dry-run or unreachable: paper-simulate, mark clearly
          await api(`/${t.id}`, { sl: newSL, be_moved: true });
          console.log("[trade-mgr] BE simulated (bridge dry-run/offline) for", t.id);
        }
      } catch (_e) {
        await api(`/${t.id}`, { sl: newSL, be_moved: true });
      }
    } else {
      await api(`/${t.id}`, { sl: newSL, be_moved: true });
    }
    const tr = S.trades.find((x) => x.id === t.id);
    if (tr) { tr.sl = newSL; tr.be_moved = true; }
  }

  async function partialClose(t) {
    const half = t.qty / 2;
    const isBridge = t.bridge_ticket && t.target === "mt5";
    if (isBridge && half > 0) {
      try {
        const r = await fetch("/api/execute/mt5/close_partial", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ticket: t.bridge_ticket, volume: half }),
        }).then((x) => x.json());
        if (r && !r.error && !r.dryRun) {
          await api(`/${t.id}`, { qty: half, partial_done: true });
        } else {
          await api(`/${t.id}`, { qty: half, partial_done: true });
          console.log("[trade-mgr] partial simulated (bridge dry-run/offline) for", t.id);
        }
      } catch (_e) {
        await api(`/${t.id}`, { qty: half, partial_done: true });
      }
    } else {
      await api(`/${t.id}`, { qty: half, partial_done: true });
    }
    const tr = S.trades.find((x) => x.id === t.id);
    if (tr) { tr.qty = half; tr.partial_done = true; }
  }

  /* ---------------- positions panel ---------------- */
  function pnl(t, price) {
    if (!(price > 0) || !(t.qty > 0)) return null;
    const diff = t.side === "buy" ? price - t.entry : t.entry - price;
    return diff * t.qty;
  }

  function render() {
    const box = document.getElementById("trackedBox");
    if (!box) return;
    const open = S.trades.filter((t) => t.status === "open");
    if (!open.length) {
      box.innerHTML = "";
      return;
    }
    let html = `<div style="color:var(--dim);font-size:12px;margin:6px 0">Tracked trades (auto manager)</div>
      <table class="mini"><tr><th>Symbol</th><th>Side</th><th>Entry</th><th>SL</th><th>P/L</th><th></th></tr>`;
    for (const t of open) {
      const cached = S.prices[t.symbol];
      const price = cached ? cached.p : null;
      const p = price ? pnl(t, price) : null;
      const badges = [
        t.be_moved ? `<span class="pill ok" style="font-size:10px">BE</span>` : "",
        t.partial_done ? `<span class="pill" style="font-size:10px">½</span>` : "",
        t.target === "paper" ? `<span style="color:var(--dim);font-size:10px">sim</span>` : "",
      ].join(" ");
      html += `<tr>
        <td>${esc(t.symbol)}<br>${badges}</td>
        <td style="color:${t.side === "buy" ? "var(--green)" : "var(--red)"}">${t.side.toUpperCase()}</td>
        <td>${fmtP(t.entry)}</td>
        <td>${fmtP(t.sl)}</td>
        <td style="color:${p == null ? "var(--dim)" : p >= 0 ? "var(--green)" : "var(--red)"}">${p == null ? "…" : p.toFixed(2)}</td>
        <td><button class="btn" style="padding:2px 6px;font-size:10px" onclick="TGTradeMgr.close(${t.id})">✕</button></td>
      </tr>`;
    }
    html += "</table>";
    box.innerHTML = html;
  }

  /* ---------------- public ---------------- */
  function init() {
    load();
    clearInterval(S.timer);
    S.timer = setInterval(async () => {
      await applyRules();
      // refresh cached prices for visible symbols
      const syms = Array.from(new Set(S.trades.filter((t) => t.status === "open").map((t) => t.symbol)));
      for (const s of syms) await tickPrice(s);
      render();
    }, 10000);
  }

  return { init, track, close: closeTrade, setAuto, reload: load };
})();
