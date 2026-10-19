"use strict";
/* ============================================================================
 * TGVoice — voice-assisted trade journaling (Analysis Hub modal).
 * Uses the free in-browser Web Speech API. Nothing is uploaded anywhere:
 * speech is transcribed locally by the browser, tags are extracted with
 * plain keyword matching (no AI service), and everything is saved with the
 * analysis entry in our own database.
 * ========================================================================== */
window.TGVoice = (function () {
  // keyword -> tag (matched case-insensitively against the transcript)
  const TAG_KEYWORDS = [
    { tag: "#LiquiditySweep", words: ["sweep", "swept", "liquidity", "stop hunt", "stop-run"] },
    { tag: "#VSA", words: ["vsa", "volume", "climax", "no demand", "no supply", "stopping volume", "effort vs result", "effort vs. result"] },
    { tag: "#FVG", words: ["fvg", "fair value gap", "imbalance"] },
    { tag: "#OrderBlock", words: ["order block", "orderblock", "ob "] },
    { tag: "#Breakout", words: ["breakout", "broke out", "break of structure", "bos"] },
    { tag: "#Retest", words: ["retest", "re-test", "retested"] },
    { tag: "#Divergence", words: ["divergence", "divergent"] },
    { tag: "#Trendline", words: ["trendline", "trend line"] },
    { tag: "#SRZone", words: ["support", "resistance", "supply zone", "demand zone"] },
    { tag: "#Engulfing", words: ["engulfing", "engulfed"] },
    { tag: "#FOMC", words: ["fomc", "fed", "federal reserve", "rate decision"] },
    { tag: "#NFP", words: ["nfp", "nonfarm", "non-farm", "payrolls"] },
    { tag: "#CPI", words: ["cpi", "inflation"] },
    { tag: "#Killzone", words: ["killzone", "kill zone", "london", "new york", "asian range"] },
    { tag: "#SMC", words: ["smc", "smart money", "change of character", "choch"] },
    { tag: "#ICT", words: ["ict"] },
  ];

  let getSymbol = () => "";
  let recognition = null;
  let listening = false;
  const tags = [];

  function $(id) { return document.getElementById(id); }

  function symbolTag() {
    let s = String(getSymbol() || "").toUpperCase();
    if (!s) return null;
    if (s.indexOf("PAXG") === 0) return "#XAUUSD";
    s = s.replace(/USDT$/, "").replace(/USDC$/, "").replace(/USD$/, "");
    if (/^[A-Z0-9]{2,12}$/.test(s)) return "#" + s;
    return null;
  }

  function extractTags(text) {
    const t = " " + String(text || "").toLowerCase() + " ";
    const found = [];
    for (const { tag, words } of TAG_KEYWORDS) {
      for (const w of words) {
        if (t.indexOf(w) >= 0) { found.push(tag); break; }
      }
    }
    const st = symbolTag();
    if (st) found.push(st);
    return found;
  }

  function addTags(list) {
    let changed = false;
    for (const tg of list) {
      if (tags.indexOf(tg) < 0 && tags.length < 20) { tags.push(tg); changed = true; }
    }
    if (changed) renderChips();
  }

  function renderChips() {
    const box = $("tagChips");
    if (!box) return;
    box.innerHTML = "";
    tags.forEach((tg, i) => {
      const c = document.createElement("span");
      c.className = "tag-chip";
      c.textContent = tg;
      c.title = "Click to remove";
      c.onclick = () => { tags.splice(i, 1); renderChips(); };
      box.appendChild(c);
    });
  }

  function setListening(on) {
    listening = on;
    const b = $("micBtn");
    if (b) {
      b.classList.toggle("listening", on);
      b.textContent = on ? "⏹ Stop" : "🎤 Speak";
    }
  }

  function start() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const status = $("micStatus");
    if (!SR) {
      if (status) status.textContent = "Voice not supported in this browser — type instead.";
      return;
    }
    if (listening) { try { recognition.stop(); } catch (_e) {} return; }
    recognition = new SR();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = (ev) => {
      try {
        const transcript = ev.results[0][0].transcript || "";
        const ta = $("anBody");
        if (ta) ta.value = (ta.value ? ta.value.replace(/\s+$/, "") + " " : "") + transcript;
        addTags(extractTags(transcript));
        if (status) status.textContent = "Heard ✓ — tags added. Speak again or edit.";
      } catch (_e) {}
    };
    recognition.onerror = (ev) => {
      if (status) status.textContent = "Mic error: " + (ev.error || "unknown") + " — type instead.";
      setListening(false);
    };
    recognition.onend = () => setListening(false);
    try {
      recognition.start();
      setListening(true);
      if (status) status.textContent = "Listening… speak your trade logic.";
    } catch (_e) {
      if (status) status.textContent = "Could not start the mic.";
      setListening(false);
    }
  }

  function reset() {
    tags.length = 0;
    renderChips();
    try { if (recognition && listening) recognition.stop(); } catch (_e) {}
    setListening(false);
    const st = $("micStatus");
    if (st) st.textContent = "";
  }

  function init(opts) {
    if (opts && opts.getSymbol) getSymbol = opts.getSymbol;
    const b = $("micBtn");
    if (!b) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      b.disabled = true;
      b.title = "Voice not supported in this browser";
      b.style.opacity = "0.5";
    }
    b.onclick = start;
  }

  return { init, reset, extractTags, get tags() { return tags.slice(); } };
})();
