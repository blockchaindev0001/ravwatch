'use strict';

// ---------------------------------------------------------------------------
// Cloudflare Turnstile verification.
//
// The browser solves the challenge and gets a token; we verify that token
// server-to-server with our SECRET key (never exposed to the page). Human
// detection is Cloudflare's job — we only trust their yes/no.
// ---------------------------------------------------------------------------
const cfg = require('./config');

const ENABLED = !!cfg.TURNSTILE_SECRET_KEY;

async function verifyCaptcha(token, remoteip) {
  if (!ENABLED) return { ok: true, disabled: true };
  if (!token) return { ok: false, reason: 'missing-captcha' };
  try {
    const body = new URLSearchParams();
    body.append('secret', cfg.TURNSTILE_SECRET_KEY);
    body.append('response', token);
    if (remoteip) body.append('remoteip', remoteip);
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
    });
    const data = await r.json();
    return { ok: !!data.success, reason: (data['error-codes'] || []).join(',') || null };
  } catch (_) {
    return { ok: false, reason: 'verify-unreachable' };
  }
}

module.exports = { verifyCaptcha, ENABLED };
