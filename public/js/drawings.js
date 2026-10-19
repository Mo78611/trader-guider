"use strict";
/* Drawing tools for Trader Guider.
   Drawings are plain data: {id, kind, points:[{time,price}], text, color}
   Rendered as lightweight-charts line series + markers; fully serializable
   so they persist to SQLite and restore exactly. */

window.TGDrawings = (function () {
  const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  const FIB_COLORS = ["#8b94a7", "#4f7cff", "#4f7cff", "#d4a94e", "#ef5350", "#4f7cff", "#8b94a7"];

  function create(chart, candleSeries, getCandles, onChange) {
    const S = {
      chart, candleSeries, getCandles, onChange,
      drawings: [], seriesById: new Map(), tool: "cursor", pending: null,
    };

    function dataRange() {
      const c = S.getCandles();
      if (!c.length) return null;
      return { from: c[0].time, to: c[c.length - 1].time };
    }

    function clearSeries() {
      for (const list of S.seriesById.values()) for (const s of list) {
        try { S.chart.removeSeries(s); } catch (_e) {}
      }
      S.seriesById.clear();
      try { S.candleSeries.setMarkers([]); } catch (_e) {}
    }

    function addLine(points, opts) {
      const clean = (points || []).filter((p) => p && isFinite(p.time) && isFinite(p.price));
      if (clean.length < 1) return null;
      const s = S.chart.addLineSeries(Object.assign({
        color: "#d4a94e", lineWidth: 2, priceLineVisible: false,
        lastValueVisible: false, crosshairMarkerVisible: false,
      }, opts || {}));
      s.setData(clean.map((p) => ({ time: p.time, value: p.price })));
      return s;
    }

    function render() {
      clearSeries();
      const range = dataRange();
      const markers = [];
      for (const d of S.drawings) {
        const made = [];
        if (d.kind === "trendline" && d.points.length === 2) {
          made.push(addLine(d.points, { color: d.color, title: "" }));
        } else if (d.kind === "hline" && d.points.length >= 1 && range) {
          const p = d.points[0].price;
          made.push(addLine([{ time: range.from, price: p }, { time: range.to, price: p }],
            { color: d.color, lineStyle: 2, lineWidth: 1, title: d.text || p.toFixed(2) }));
        } else if (d.kind === "fib" && d.points.length === 2 && range) {
          const a = d.points[0].price, b = d.points[1].price;
          const lo = Math.min(a, b), hi = Math.max(a, b), span = hi - lo;
          FIB_LEVELS.forEach((f, i) => {
            const price = lo + span * f;
            made.push(addLine([{ time: range.from, price }, { time: range.to, price }],
              { color: FIB_COLORS[i], lineStyle: i === 4 ? 0 : 2, lineWidth: 1,
                title: `fib ${f}` }));
          });
        } else if (d.kind === "text" && d.points.length >= 1) {
          markers.push({ time: d.points[0].time, position: "inBar", color: d.color,
                         shape: "text", text: d.text || "note" });
        } else if (d.kind === "rect" && d.points.length === 2 && range) {
          const t1 = Math.min(d.points[0].time, d.points[1].time);
          const t2 = Math.max(d.points[0].time, d.points[1].time);
          const p1 = Math.min(d.points[0].price, d.points[1].price);
          const p2 = Math.max(d.points[0].price, d.points[1].price);
          const o = { color: d.color, lineWidth: 1, lineStyle: 0 };
          made.push(addLine([{ time: t1, price: p2 }, { time: t2, price: p2 }], o));
          made.push(addLine([{ time: t1, price: p1 }, { time: t2, price: p1 }], o));
          made.push(addLine([{ time: t1, price: p1 }, { time: t1, price: p2 }], o));
          made.push(addLine([{ time: t2, price: p1 }, { time: t2, price: p2 }], o));
        } else if (d.kind === "channel" && d.points.length === 3 && range) {
          const [a, b, c] = d.points;
          const slope = (b.price - a.price) / Math.max(b.time - a.time, 1);
          const lineAt = (base, t) => base.price + slope * (t - base.time);
          const o = { color: d.color, lineWidth: 1, lineStyle: 0 };
          made.push(addLine([{ time: range.from, price: lineAt(a, range.from) },
                             { time: range.to, price: lineAt(a, range.to) }], o));
          made.push(addLine([{ time: range.from, price: lineAt(c, range.from) },
                             { time: range.to, price: lineAt(c, range.to) }],
                             Object.assign({}, o, { lineStyle: 2 })));
        } else if (d.kind === "vline" && d.points.length >= 1) {
          const t = d.points[0].time;
          const cs = S.getCandles();
          let lo = Infinity, hi = -Infinity;
          for (const c of cs) { if (c.low < lo) lo = c.low; if (c.high > hi) hi = c.high; }
          if (isFinite(lo) && isFinite(hi)) {
            made.push(addLine([{ time: t, price: lo }, { time: t, price: hi }],
              { color: d.color, lineWidth: 1, lineStyle: 2 }));
          }
        } else if (d.kind === "whatif" && d.points.length >= 2) {
          // What-if projector: user path + ATR probability cones.
          // 68% cone = ±1×ATR√n, 95% = ±2×ATR√n around the drawn path.
          const pts = d.points;
          made.push(addLine(pts, { color: "#00e5a0", lineWidth: 2, title: "what-if path" }));
          const atr = atrLast();
          const tf = tfSeconds();
          if (atr > 0 && tf > 0) {
            const t0 = pts[0].time;
            const totalBars = Math.max(1, Math.round((pts[pts.length - 1].time - t0) / tf));
            for (const k of [1, 2]) {
              const up = [], dn = [];
              for (const p of pts) {
                const bars = Math.max(1, Math.round((p.time - t0) / tf));
                const w = k * atr * Math.sqrt(bars);
                up.push({ time: p.time, price: p.price + w });
                dn.push({ time: p.time, price: p.price - w });
              }
              const col = k === 1 ? "rgba(38,166,154,0.5)" : "rgba(239,83,80,0.45)";
              made.push(addLine(up, { color: col, lineWidth: 1, lineStyle: 2,
                title: k === 1 ? "68% cone" : "95% cone" }));
              made.push(addLine(dn, { color: col, lineWidth: 1, lineStyle: 2 }));
            }
            const move = Math.abs(pts[pts.length - 1].price - pts[0].price);
            const a68 = atr * Math.sqrt(totalBars), a95 = 2 * atr * Math.sqrt(totalBars);
            const verdict = move <= a68 ? "realistic" : move <= a95 ? "stretched" : "fantasy";
            markers.push({ time: pts[pts.length - 1].time, position: "inBar",
              color: "#d4a94e", shape: "text", text: "what-if: " + verdict });
          }
        }
        if (made.length) S.seriesById.set(d.id, made.filter(Boolean));
      }
      if (markers.length) { try { S.candleSeries.setMarkers(markers.filter((m) => m && isFinite(m.time))); } catch (_e) {} }
    }

    function uid() { return "d" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36); }

    function atrLast() {
      const cs = S.getCandles();
      const n = cs.length;
      if (n < 15) return 0;
      const trs = [0];
      for (let i = 1; i < n; i++) {
        const h = cs[i].high, l = cs[i].low, pc = cs[i - 1].close;
        trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
      }
      let prev = 0;
      for (let i = 1; i <= 14; i++) prev += trs[i];
      prev /= 14;
      for (let i = 15; i < n; i++) prev = (prev * 13 + trs[i]) / 14;
      return prev;
    }

    function tfSeconds() {
      const cs = S.getCandles();
      if (cs.length < 3) return 3600;
      const ds = [];
      for (let i = 1; i < Math.min(cs.length, 20); i++) ds.push(cs[i].time - cs[i - 1].time);
      ds.sort((a, b) => a - b);
      return ds[Math.floor(ds.length / 2)] || 3600;
    }

    function logDrawing(kind, pt) {
      try {
        if (window.TGFootprints) window.TGFootprints.log("drawing:" + kind, { price: pt.price, time: pt.time });
      } catch (_e) {}
    }

    function setTool(t) {
      S.tool = t; S.pending = null; S.pendingPts = null; S.pendingId = null;
      document.querySelectorAll(".tool").forEach((el) => el.classList.toggle("active", el.dataset.tool === t));
      const hints = {
        cursor: "Click a tool on the left to start drawing.",
        trendline: "Trendline: click two points on the chart.",
        hline: "Horizontal line: click at the price level.",
        fib: "Fibonacci: click swing low, then swing high.",
        text: "Text label: click a bar, then type the label.",
        rect: "Rectangle: click two opposite corners.",
        channel: "Parallel channel: click two points for the main line, then a third point for the parallel.",
        vline: "Vertical line: click a bar to mark the time.",
        whatif: "What-if path: click points along your imagined path. Switch tool when done.",
        eraser: "Eraser: click near a drawing to delete it.",
      };
      const h = document.getElementById("chartHint");
      if (h) h.textContent = hints[t] || "";
    }

    function nearestDrawing(point) {
      // pixel-space distance from click to each drawing's anchor points
      let best = null, bestDist = 14;
      const ts = S.chart.timeScale();
      for (const d of S.drawings) {
        for (const p of d.points) {
          const x = ts.timeToCoordinate(p.time);
          const y = S.candleSeries.priceToCoordinate(p.price);
          if (x == null || y == null) continue;
          const dist = Math.hypot(x - point.x, y - point.y);
          if (dist < bestDist) { bestDist = dist; best = d; }
        }
      }
      return best;
    }

    function handleClick(param) {
      if (!param || !param.point) return;
      if (S.tool === "eraser") {
        const d = nearestDrawing(param.point);
        if (d) {
          S.drawings = S.drawings.filter((x) => x.id !== d.id);
          render(); S.onChange();
        }
        return;
      }
      if (param.time == null) return; // clicked outside bars
      const price = S.candleSeries.coordinateToPrice(param.point.y);
      if (price == null) return;
      const pt = { time: param.time, price };
      const color = "#d4a94e";

      if (S.tool === "hline") {
        S.drawings.push({ id: uid(), kind: "hline", points: [pt], text: price.toFixed(2), color });
        logDrawing("hline", pt);
        render(); S.onChange(); setTool("cursor");
      } else if (S.tool === "text") {
        const t = prompt("Label text:", "");
        if (t) {
          S.drawings.push({ id: uid(), kind: "text", points: [pt], text: t.slice(0, 60), color });
          logDrawing("text", pt);
        }
        render(); S.onChange(); setTool("cursor");
      } else if (S.tool === "vline") {
        S.drawings.push({ id: uid(), kind: "vline", points: [pt], text: "", color });
        logDrawing("vline", pt);
        render(); S.onChange(); setTool("cursor");
      } else if (S.tool === "whatif") {
        // freehand path: every click appends to the same drawing until the tool changes
        let d = S.pendingId ? S.drawings.find((x) => x.id === S.pendingId) : null;
        if (!d) {
          d = { id: uid(), kind: "whatif", points: [pt], text: "", color: "#00e5a0" };
          S.drawings.push(d);
          S.pendingId = d.id;
          logDrawing("whatif", pt);
        } else {
          d.points.push(pt);
        }
        render(); S.onChange();
        // stays active — user switches tool when the path is done
      } else if (S.tool === "trendline" || S.tool === "fib" || S.tool === "rect" || S.tool === "channel") {
        if (!S.pendingPts) S.pendingPts = [];
        S.pendingPts.push(pt);
        const need = S.tool === "channel" ? 3 : 2;
        if (S.pendingPts.length >= need) {
          const kind = S.tool;
          S.drawings.push({ id: uid(), kind, points: S.pendingPts.slice(0, need), text: "", color });
          logDrawing(kind, pt);
          S.pendingPts = null;
          render(); S.onChange(); setTool("cursor");
        }
      }
    }

    function load(list) { S.drawings = Array.isArray(list) ? list : []; render(); }
    function get() { return S.drawings; }
    function clear() { S.drawings = []; render(); S.onChange(); }

    S.chart.subscribeClick(handleClick);
    return { setTool, load, get, clear, render, get tool() { return S.tool; } };
  }

  return { create };
})();
