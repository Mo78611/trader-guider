"use strict";
/* ============================================================================
 * FIREBASE AUTH ADAPTER — WIRED (Email/Password). Local JWT remains the app session.
 * ============================================================================
 * Config lives HERE (single source of truth). The browser apiKey below is
 * public-by-design (Firebase web keys are meant to be embedded; restrict it by
 * domain in Firebase console > Project Settings > API restrictions).
 *
 * HOW TO ADD THE appId (2 minutes, user does it once):
 *   Firebase console > Project Settings > General > "Your apps" >
 *   "Trader Guider Web" > copy the "App ID" value (looks like 1:788004774099:web:...)
 *   and paste it below replacing APP_ID_HERE.
 *
 * FALLBACK BEHAVIOR (by design):
 *   If appId is still the placeholder, isFirebaseConfigured() returns false and
 *   the ENTIRE app silently keeps using local email+password auth (bcrypt +
 *   JWT httpOnly cookie in lib/auth.js). A console warning is logged on server
 *   boot and on the login page. Nothing crashes.
 *
 * FLOW (when configured):
 *   1. Login page loads the Firebase JS SDK (compat, CDN) and signs the user
 *      in with signInWithEmailAndPassword / createUserWithEmailAndPassword.
 *   2. The client sends the Firebase ID token to POST /api/auth/firebase-session.
 *   3. The backend verifies the token with Google's tokeninfo endpoint
 *      (localhost-grade verification — production should use firebase-admin
 *      with a service account instead), links/creates the local user row by
 *      firebase_uid, and mints the SAME local JWT httpOnly session cookie the
 *      rest of the app already uses. Chart state, analyses, API keys — all
 *      unchanged, keyed off the local user id.
 *
 * PHONE OTP: not enabled in the Firebase console for this project, so it is
 * NOT implemented. See the commented stub at the bottom for the future path.
 * ============================================================================
 */

const FIREBASE_CONFIG = {
  // Overridable via env (12-factor); hardcoded values are the fallback.
  apiKey: process.env.FIREBASE_API_KEY || "AIzaSyCN3PIAqbR5jxMDFvAqAdcRQI6sBYbU33o",
  authDomain: process.env.FIREBASE_AUTH_DOMAIN || "trader-guider.firebaseapp.com",
  projectId: process.env.FIREBASE_PROJECT_ID || "trader-guider",
  messagingSenderId: process.env.FIREBASE_SENDER_ID || "788004774099",
  // ⬇️  PASTE APP ID HERE — Firebase console > Project Settings > General >
  //     Your apps > "Trader Guider Web" > App ID  (1:788004774099:web:...)
  //     or set the FIREBASE_APP_ID env var.
  appId: process.env.FIREBASE_APP_ID || "APP_ID_HERE",
};

const APP_ID_PLACEHOLDER = "APP_ID_HERE";

function isFirebaseConfigured() {
  const c = FIREBASE_CONFIG;
  return Boolean(
    c.apiKey && c.authDomain && c.projectId &&
    c.appId && c.appId !== APP_ID_PLACEHOLDER
  );
}

// Safe subset handed to the browser (no secrets in here).
function getPublicConfig() {
  if (!isFirebaseConfigured()) return null;
  const { apiKey, authDomain, projectId, messagingSenderId, appId } = FIREBASE_CONFIG;
  return { apiKey, authDomain, projectId, messagingSenderId, appId };
}

/**
 * Verify a Firebase ID token (localhost-grade).
 * Calls Google's tokeninfo endpoint and checks audience + expiry.
 * Production upgrade path: verify with firebase-admin SDK + service account.
 */
async function verifyFirebaseIdToken(idToken) {
  if (!isFirebaseConfigured()) throw new Error("firebase_not_configured");
  if (!idToken || typeof idToken !== "string" || idToken.length < 100) {
    throw new Error("malformed_id_token");
  }
  const res = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) throw new Error("token_rejected_by_google");
  const claims = await res.json();
  if (claims.aud !== FIREBASE_CONFIG.projectId) throw new Error("audience_mismatch");
  if (Number(claims.exp) * 1000 < Date.now()) throw new Error("token_expired");
  if (!claims.user_id || !claims.email) throw new Error("missing_claims");
  return { uid: String(claims.user_id), email: String(claims.email) };
}

/* ----------------------------------------------------------------------------
 * PHONE OTP — STUB (NOT enabled in Firebase console; do not wire until it is)
 *
 * Future path when the user enables Phone provider in the console:
 *   1. Frontend (compat SDK):
 *        const verifier = new firebase.auth.RecaptchaVerifier('otp-btn', {size:'invisible'}, fbAuth);
 *        const confirmation = await fbAuth.signInWithPhoneNumber(phoneE164, verifier);
 *        const userCred = await confirmation.confirm(smsCode);
 *   2. Then: const idToken = await userCred.user.getIdToken();
 *      POST /api/auth/firebase-session {idToken} — the SAME endpoint used for
 *      email/password above. No backend changes needed; tokeninfo verifies
 *      phone-auth tokens identically (claims.phone_number present).
 *   NOTE: Firebase Phone Auth may require a Blaze billing account in some
 *   regions even within the free quota — verify in the console first.
 * ---------------------------------------------------------------------------- */

module.exports = {
  FIREBASE_CONFIG,
  APP_ID_PLACEHOLDER,
  isFirebaseConfigured,
  getPublicConfig,
  verifyFirebaseIdToken,
};
