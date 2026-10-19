"use strict";
// Auth helpers: JWT sessions in an httpOnly cookie.
// 30-day persistent cookie => closing the tab/browser does NOT log the user out.

const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "dev-only-insecure-secret";
const SESSION_DAYS = parseInt(process.env.SESSION_DAYS || "30", 10);
const COOKIE_NAME = "tg_session";

function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email },
    JWT_SECRET,
    { expiresIn: `${SESSION_DAYS}d` }
  );
}

function setSessionCookie(res, user) {
  const token = signToken(user);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    // secure: true in production behind HTTPS; localhost is plain HTTP
    secure: process.env.COOKIE_SECURE === "true",
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: "/",
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: "/" });
}

// Express middleware: attaches req.user = {id, email} or null (does not reject)
function optionalAuth(req, _res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) { req.user = null; return next(); }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { id: payload.sub, email: payload.email };
  } catch (_e) {
    req.user = null;
  }
  next();
}

// Express middleware: rejects with 401 when not logged in
function requireAuth(req, res, next) {
  optionalAuth(req, res, () => {
    if (!req.user) return res.status(401).json({ error: "not_authenticated" });
    next();
  });
}

module.exports = { signToken, setSessionCookie, clearSessionCookie, optionalAuth, requireAuth, COOKIE_NAME };
