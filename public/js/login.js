"use strict";
/* Login / register. Firebase (Email/Password) first when configured,
   local bcrypt+JWT auth as the always-working fallback. */
const errBox = document.getElementById("authErr");
const modeBox = document.getElementById("authMode");
function showErr(t) { errBox.textContent = t; }

let fbAuth = null; // firebase.auth() when Firebase is usable

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error("cdn_load_failed"));
    document.head.appendChild(s);
  });
}

async function initFirebase() {
  try {
    const cfg = await fetch("/api/auth/firebase-config").then((r) => r.json());
    if (!cfg.configured) {
      console.warn("[Trader Guider] Firebase appId not set — using local auth. Add it in lib/firebase-auth-adapter.js (see README).");
      modeBox.textContent = "Local sign-in";
      return;
    }
    await loadScript("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
    await loadScript("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js");
    firebase.initializeApp(cfg.config);
    fbAuth = firebase.auth();
    modeBox.textContent = "Firebase sign-in";
  } catch (e) {
    console.warn("[Trader Guider] Firebase unavailable (" + e.message + ") — using local auth.");
    modeBox.textContent = "Local sign-in";
  }
}

document.getElementById("toReg").onclick = (e) => {
  e.preventDefault(); showErr("");
  document.getElementById("loginForm").style.display = "none";
  document.getElementById("regForm").style.display = "block";
};
document.getElementById("toLogin").onclick = (e) => {
  e.preventDefault(); showErr("");
  document.getElementById("regForm").style.display = "none";
  document.getElementById("loginForm").style.display = "block";
};

async function post(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, j };
}

async function firebaseSession(idToken, name) {
  const { ok, j } = await post("/api/auth/firebase-session", { idToken, name });
  if (!ok) throw new Error(j.error || "session_failed");
  return j;
}

async function doLogin(email, password) {
  // Firebase first; fall back to local on any Firebase-side failure
  // (e.g. account exists only locally, or CDN hiccup).
  if (fbAuth) {
    try {
      const cred = await fbAuth.signInWithEmailAndPassword(email, password);
      const idToken = await cred.user.getIdToken();
      await firebaseSession(idToken);
      location.href = "/terminal";
      return;
    } catch (e) {
      console.warn("[Trader Guider] Firebase sign-in failed, trying local:", e.code || e.message);
    }
  }
  const { ok, j } = await post("/api/auth/login", { email, password });
  if (ok) location.href = "/terminal";
  else showErr(j.error === "invalid_credentials" ? "Wrong email or password." : "Sign-in failed: " + (j.error || "unknown"));
}

async function doRegister(name, email, password) {
  if (fbAuth) {
    try {
      const cred = await fbAuth.createUserWithEmailAndPassword(email, password);
      try { await cred.user.updateProfile({ displayName: name }); } catch (_e) {}
      const idToken = await cred.user.getIdToken();
      await firebaseSession(idToken, name);
      location.href = "/terminal";
      return;
    } catch (e) {
      if (e.code === "auth/email-already-in-use") {
        showErr("That email is already registered — sign in instead.");
        return;
      }
      console.warn("[Trader Guider] Firebase register failed, trying local:", e.code || e.message);
    }
  }
  const { ok, j } = await post("/api/auth/register", { email, password, name });
  if (ok) location.href = "/terminal";
  else showErr(j.error === "email_already_registered" ? "That email is already registered — sign in instead."
    : j.error === "password_min_8_chars" ? "Password needs at least 8 characters."
    : "Couldn't create account: " + (j.error || "unknown"));
}

document.getElementById("loginBtn").onclick = () => {
  const email = document.getElementById("lEmail").value.trim();
  const password = document.getElementById("lPass").value;
  doLogin(email, password);
};

document.getElementById("regBtn").onclick = () => {
  const name = document.getElementById("rName").value.trim();
  const email = document.getElementById("rEmail").value.trim();
  const password = document.getElementById("rPass").value;
  doRegister(name, email, password);
};

// Enter key submits
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const regVisible = document.getElementById("regForm").style.display !== "none";
    (regVisible ? document.getElementById("regBtn") : document.getElementById("loginBtn")).click();
  }
});

// already logged in? go straight to the terminal
fetch("/api/auth/me").then((r) => r.json()).then((j) => { if (j.user) location.href = "/terminal"; }).catch(() => {});

initFirebase();
