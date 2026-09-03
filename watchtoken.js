'use strict';

// ---------------------------------------------------------------------------
// Rotating watch tokens.
//
// A stateless, HMAC-signed token bound to a wallet address with a short expiry.
// The browser must attach it to every heartbeat, and refresh it (server round-
// trip) before it expires. A captured token is useless once it expires, and it
// only works for the wallet it was minted for.
// ---------------------------------------------------------------------------
const crypto = require('crypto');

function b64url(s) {
  return Buffer.from(s).toString('base64url');
}

function issueWatchToken(secret, addressLower, ttlMs) {
  const payload = { a: addressLower, iat: Date.now(), exp: Date.now() + ttlMs };
  const body = b64url(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verifyWatchToken(secret, token, addressLower) {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'missing' };
  const dot = token.indexOf('.');
  if (dot < 0) return { ok: false, reason: 'malformed' };
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad-sig' };
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (_) {
    return { ok: false, reason: 'bad-json' };
  }
  if (!payload.exp || payload.exp < Date.now()) return { ok: false, reason: 'expired' };
  if (addressLower && payload.a !== addressLower) return { ok: false, reason: 'wrong-wallet' };
  return { ok: true, payload };
}

module.exports = { issueWatchToken, verifyWatchToken };
