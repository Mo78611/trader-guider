"use strict";
// AES-256-GCM encryption for stored exchange API keys.
//
// LOCALHOST-GRADE SECURITY — read this:
//  * Keys are encrypted at rest with ENCRYPTION_KEY from .env, which is the
//    correct minimum. But this is still a single local box: anyone with the
//    .env file and the DB file can decrypt. That is fine for localhost demo
//    use on your own machine and NOT acceptable for a public server.
//  * Never commit .env or data/*.db to git.

const crypto = require("crypto");

function getKey() {
  const hex = (process.env.ENCRYPTION_KEY || "").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      "ENCRYPTION_KEY must be 64 hex chars (32 bytes). " +
      "Generate: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  return Buffer.from(hex, "hex");
}

// returns base64(iv 12B | tag 16B | ciphertext)
function encrypt(plainText) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(String(plainText), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

function decrypt(payloadB64) {
  const key = getKey();
  const buf = Buffer.from(payloadB64, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

module.exports = { encrypt, decrypt };
