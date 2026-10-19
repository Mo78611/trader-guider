"use strict";
/* Trader Guider landing — animated hero canvas, counters, scroll reveal. */
(function () {
  const canvas = document.getElementById("heroCanvas");
  const ctx = canvas.getContext("2d");
  let W, H, t = 0;
  const orbs = [];
  const LINE_N = 90;
  let seed = 7;
  function rnd() { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }

  function resize() {
    W = canvas.width = canvas.offsetWidth * devicePixelRatio;
    H = canvas.height = canvas.offsetHeight * devicePixelRatio;
  }
  window.addEventListener("resize", resize);
  resize();

  for (let i = 0; i < 5; i++) {
    orbs.push({
      x: rnd(), y: rnd(), r: 0.18 + rnd() * 0.22,
      hue: i % 2 ? 160 : 42, // emerald / gold
      sx: 0.00012 + rnd() * 0.0002, sy: 0.0001 + rnd() * 0.0002,
      ph: rnd() * Math.PI * 2,
    });
  }

  // smooth random-walk price path
  const prices = [];
  let p = 0.5;
  for (let i = 0; i < LINE_N; i++) { p += (rnd() - 0.46) * 0.09; p = Math.max(0.12, Math.min(0.88, p)); prices.push(p); }

  function draw() {
    t += 1;
    ctx.clearRect(0, 0, W, H);

    // gradient mesh orbs
    for (const o of orbs) {
      const x = (o.x + Math.sin(t * o.sx * 60 + o.ph) * 0.06) * W;
      const y = (o.y + Math.cos(t * o.sy * 60 + o.ph) * 0.06) * H;
      const r = o.r * Math.min(W, H);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `hsla(${o.hue}, 70%, 45%, 0.16)`);
      g.addColorStop(1, "hsla(0,0%,0%,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }

    // glowing chart line (drifts slowly)
    const baseY = H * 0.62, amp = H * 0.20;
    const off = Math.floor(t / 40) % LINE_N;
    ctx.save();
    ctx.shadowColor = "rgba(212,169,78,.8)";
    ctx.shadowBlur = 24 * devicePixelRatio;
    ctx.beginPath();
    for (let i = 0; i < LINE_N; i++) {
      const idx = (i + off) % LINE_N;
      const x = (i / (LINE_N - 1)) * W;
      const y = baseY - (prices[idx] - 0.5) * 2 * amp + Math.sin(t * 0.008 + i * 0.25) * 6 * devicePixelRatio;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    const grad = ctx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, "#d4a94e"); grad.addColorStop(0.6, "#f3d27a"); grad.addColorStop(1, "#26d3a0");
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2.4 * devicePixelRatio;
    ctx.stroke();
    ctx.restore();

    // soft area fill under the line
    ctx.save();
    ctx.globalAlpha = 0.10;
    ctx.beginPath();
    for (let i = 0; i < LINE_N; i++) {
      const idx = (i + off) % LINE_N;
      const x = (i / (LINE_N - 1)) * W;
      const y = baseY - (prices[idx] - 0.5) * 2 * amp;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
    const ag = ctx.createLinearGradient(0, baseY - amp, 0, H);
    ag.addColorStop(0, "#d4a94e"); ag.addColorStop(1, "transparent");
    ctx.fillStyle = ag; ctx.fill();
    ctx.restore();

    // floating particles
    ctx.fillStyle = "rgba(212,169,78,.5)";
    for (let i = 0; i < 26; i++) {
      const x = ((i * 197.3 + t * (0.12 + (i % 5) * 0.05)) % W + W) % W;
      const y = (H * ((i * 0.37) % 1)) + Math.sin(t * 0.01 + i) * 12;
      ctx.globalAlpha = 0.25 + 0.2 * Math.sin(t * 0.02 + i * 2);
      ctx.beginPath(); ctx.arc(x, y, 1.4 * devicePixelRatio, 0, 7); ctx.fill();
    }
    ctx.globalAlpha = 1;

    requestAnimationFrame(draw);
  }
  draw();

  /* animated stat counters */
  const counters = document.querySelectorAll(".num[data-count]");
  const cObs = new IntersectionObserver((es) => {
    for (const e of es) {
      if (!e.isIntersecting) continue;
      const el = e.target, target = +el.dataset.count, dur = 1400, t0 = performance.now();
      (function tick(now) {
        const k = Math.min((now - t0) / dur, 1), ease = 1 - Math.pow(1 - k, 3);
        el.textContent = Math.round(target * ease) + (target === 100 ? "%" : target > 9 ? "+" : "");
        if (k < 1) requestAnimationFrame(tick);
      })(t0);
      cObs.unobserve(el);
    }
  }, { threshold: 0.4 });
  counters.forEach((c) => cObs.observe(c));

  /* scroll reveal */
  const rObs = new IntersectionObserver((es) => {
    for (const e of es) if (e.isIntersecting) { e.target.classList.add("in"); rObs.unobserve(e.target); }
  }, { threshold: 0.12 });
  document.querySelectorAll(".reveal").forEach((el) => rObs.observe(el));
})();
