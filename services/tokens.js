const crypto = require("node:crypto");

// Tokens in an email link: a long random string, stored hashed, single use,
// with an expiry. The same shape serves email verification and password resets.
//
// Why hashed: the database holds a hash, so anyone who can read it still cannot
// reset someone's password. Only the emailed link carries the real value.

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // a day to click the link
const RESET_TTL_MS = 60 * 60 * 1000; // an hour is plenty for a password reset

// 32 random bytes, hex encoded: 64 characters, no ambiguity about which
// character is a capital I or a lowercase l.
function newToken() {
  return crypto.randomBytes(32).toString("hex");
}

// What actually goes in the database.
function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// Issues a token for a user and returns BOTH the record to store and the plain
// value to put in the email. The plain value is never persisted.
async function issueToken(user, field, ttlMs) {
  const token = newToken();

  user[field] = {
    hash: hashToken(token),
    expiresAt: new Date(Date.now() + ttlMs),
  };
  await user.save();

  return token;
}

// Checks a token against a stored record without leaking why it failed.
// Returns the stored record if it is good, or null.
function tokenMatches(record, token) {
  if (!record?.hash || !record.expiresAt) return null;

  if (new Date(record.expiresAt).getTime() < Date.now()) return null;

  // Both hashes are the same length, so a plain === is in practice constant time
  // here; timingSafeEqual is used anyway since it costs nothing.
  const given = Buffer.from(hashToken(token), "hex");
  const stored = Buffer.from(record.hash, "hex");
  if (given.length !== stored.length) return null;

  return crypto.timingSafeEqual(given, stored) ? record : null;
}

// Clears whichever token field was used, so a link cannot be replayed.
async function clearToken(user, field) {
  user[field] = undefined;
}

module.exports = {
  VERIFY_TTL_MS,
  RESET_TTL_MS,
  newToken,
  hashToken,
  issueToken,
  tokenMatches,
  clearToken,
};
