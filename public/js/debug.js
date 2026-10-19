// Temporary client-error trap (debug only): posts window errors to the server
// so we can see the real boot error from a live browser.
(function () {
  function send(type, msg, stack) {
    try {
      fetch("/api/debug/error", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, msg: String(msg).slice(0, 2000), stack: String(stack || "").slice(0, 2000), url: location.href, ua: navigator.userAgent.slice(0, 120) }),
      }).catch(() => {});
    } catch (_e) {}
  }
  window.addEventListener("error", (e) => send("error", e.message, e.error && e.error.stack));
  window.addEventListener("unhandledrejection", (e) => send("unhandledrejection", (e.reason && (e.reason.message || e.reason)) || "?", (e.reason && e.reason.stack) || ""));
  // boot checkpoint ping: proves how far boot() got
  window.TGDebug = { ping: (stage) => send("ping", stage, "") };
})();
