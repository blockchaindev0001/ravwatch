'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');

const cfg = require('./config');
const { Store, DATA_DIR } = require('./db');
const { applyHeartbeat } = require('./earn');

const store = new Store();

// --- session secret (persisted so logins survive restarts) -----------------
const SECRET_FILE = path.join(DATA_DIR, '.secret');
function loadSecret() {
  // Prefer an env secret so sessions + watch tokens survive restarts on hosts
  // with an ephemeral filesystem (Render/Railway/Fly free tiers).
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  try {
    return fs.readFileSync(SECRET_FILE, 'utf8');
  } catch {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const s = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SECRET_FILE, s);
    return s;
  }
}
const SECRET = loadSecret();

function sign(userId) {
  const mac = crypto.createHmac('sha256', SECRET).update(userId).digest('hex');
  return `${userId}.${mac}`;
}
function unsign(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const userId = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', SECRET).update(userId).digest('hex');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return userId;
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const app = express();
app.set('trust proxy', 1); // behind a host proxy (Render/Railway/Fly) -> real client IP
app.use(express.json());

// attach current user (if any) from the signed cookie
app.use((req, _res, next) => {
  const token = parseCookies(req).sid;
  const userId = unsign(token);
  req.user = userId ? store.getById(userId) : null;
  next();
});

// Add "; Secure" in production (HTTPS) so the session cookie is only sent over
// TLS. Set COOKIE_SECURE=true on your host once it's on https.
const SECURE = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
function setSession(res, userId) {
  const maxAge = cfg.SESSION_DAYS * 24 * 60 * 60;
  res.setHeader(
    'Set-Cookie',
    `sid=${encodeURIComponent(sign(userId))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${SECURE}`
  );
}
function clearSession(res) {
  res.setHeader('Set-Cookie', `sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${SECURE}`);
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not logged in.' });
  next();
}

// --- config for the client -------------------------------------------------
app.get('/api/config', (_req, res) => {
  res.json({
    siteName: cfg.SITE_NAME,
    channelName: cfg.CHANNEL_NAME,
    tickSeconds: cfg.TICK_SECONDS,
    pointsPerTick: cfg.POINTS_PER_TICK,
    heartbeatMs: cfg.HEARTBEAT_MS,
    presenceEveryMs: cfg.PRESENCE_EVERY_MS,
    // anti-bot: what the client needs to drive the CAPTCHA + watch token
    captchaEnabled: CAPTCHA_ENABLED,
    turnstileSiteKey: CAPTCHA_ENABLED ? cfg.TURNSTILE_SITE_KEY : null,
    watchRefreshMs: cfg.WATCH_REFRESH_MS,
    captchaEveryMs: cfg.CAPTCHA_EVERY_MS,
  });
});

// --- "what is RAV streaming live right now?" ------------------------------
// Server-side lookup of the channel's current live video id. Done here (not in
// the browser) because it just needs a plain HTTP GET of the YouTube page.
let liveCache = { at: 0, live: false, videoId: null, title: null };

const YT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  // Bypass YouTube's consent interstitial that datacenter IPs (Render) often hit.
  Cookie: 'CONSENT=YES+1; SOCS=CAI',
};

// Authoritative path: YouTube Data API (IP-independent, reliable on any host).
async function apiSearch(eventType) {
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${cfg.YT_CHANNEL_ID}&eventType=${eventType}&type=video&order=date&maxResults=1&key=${cfg.YT_API_KEY}`;
  const r = await fetch(url);
  const data = await r.json();
  const item = data.items && data.items[0];
  if (item && item.id && item.id.videoId) {
    return { videoId: item.id.videoId, title: (item.snippet && item.snippet.title) || null };
  }
  return null;
}

async function resolveViaApi() {
  const live = await apiSearch('live');
  if (live) return { mode: 'live', live: true, videoId: live.videoId, title: live.title };
  if (cfg.REPLAY_WHEN_OFFLINE) {
    const done = await apiSearch('completed'); // most recent finished broadcast
    if (done) return { mode: 'replay', live: false, videoId: done.videoId, title: done.title };
  }
  return { mode: 'offline', live: false, videoId: null, title: null };
}

// Keyless path: find the channel's candidate video, then CONFIRM it is truly
// live now on its own watch page (channel /live page lacks that flag and is
// true even for scheduled premieres).
async function watchStatus(vid) {
  const watch = await fetch(`https://www.youtube.com/watch?v=${vid}&hl=en&gl=US`, { headers: YT_HEADERS });
  const w = await watch.text();
  return {
    liveNow: /"isLiveNow":true/.test(w),
    upcoming: /"isUpcoming":true/.test(w),
    ended: /"actualEndTime"/.test(w),
    title: ((w.match(/<title>([^<]*)<\/title>/) || [])[1] || '').replace(/ - YouTube$/, '').trim() || null,
  };
}

async function resolveViaScrape() {
  // 1) Is the channel actually live right now?
  const chan = await fetch(`https://www.youtube.com/channel/${cfg.YT_CHANNEL_ID}/live?hl=en&gl=US`, { headers: YT_HEADERS });
  const chanHtml = await chan.text();
  const canon = chanHtml.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})">/);
  const vid = canon ? canon[1] : (chanHtml.match(/"videoId":"([A-Za-z0-9_-]{11})"/) || [])[1] || null;
  if (vid) {
    const s = await watchStatus(vid);
    if (s.liveNow && !s.upcoming && !s.ended) return { mode: 'live', live: true, videoId: vid, title: s.title };
  }

  // 2) Not live -> fall back to a recent finished broadcast (a real recording).
  if (cfg.REPLAY_WHEN_OFFLINE) {
    const streams = await fetch(`https://www.youtube.com/channel/${cfg.YT_CHANNEL_ID}/streams?hl=en&gl=US`, { headers: YT_HEADERS });
    const sHtml = await streams.text();
    const ids = [...new Set((sHtml.match(/"videoId":"([A-Za-z0-9_-]{11})"/g) || []).map((m) => m.slice(11, 22)))];
    // Pick the first playable past broadcast: not upcoming and not currently live.
    for (const id of ids.slice(0, 8)) {
      const s = await watchStatus(id);
      if (!s.upcoming && !s.liveNow) return { mode: 'replay', live: false, videoId: id, title: s.title };
    }
  }
  return { mode: 'offline', live: false, videoId: null, title: null };
}

async function resolveLive() {
  if (cfg.YT_VIDEO_ID) {
    return { mode: 'live', live: true, videoId: cfg.YT_VIDEO_ID, title: 'RAV (manual)' };
  }
  if (Date.now() - liveCache.at < cfg.LIVE_CACHE_MS) return liveCache;
  try {
    // Free HTML method is primary (unlimited). The Data API costs 100 units per
    // search.list call and the free quota is only 10k/day, so use it ONLY as a
    // fallback when scraping comes up empty.
    let res = await resolveViaScrape();
    if (res.mode === 'offline' && cfg.YT_API_KEY) {
      try {
        const apiRes = await resolveViaApi();
        if (apiRes.mode !== 'offline') res = apiRes;
      } catch (_) { /* API quota/error -> keep scrape result */ }
    }
    liveCache = { at: Date.now(), ...res };
  } catch (_) {
    liveCache = { ...liveCache, at: Date.now() }; // keep last known; retry next window
  }
  return liveCache;
}

app.get('/api/live', async (_req, res) => {
  const s = await resolveLive();
  res.json({ mode: s.mode || (s.live ? 'live' : 'offline'), live: s.live, videoId: s.videoId, title: s.title });
});

// --- wallet auth (Sign-In-With-Ethereum) + anti-bot layers -----------------
const { buildMessage, recoverSigner, normalizeAddress } = require('./wallet');
const { checkWalletAge, rejectionMessage } = require('./walletage');
const { verifyCaptcha, ENABLED: CAPTCHA_ENABLED } = require('./captcha');
const { issueWatchToken, verifyWatchToken } = require('./watchtoken');

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
}

// One-time nonces per address, short-lived, single-use.
const nonces = new Map(); // lowercase address -> { nonce, exp }
const NONCE_TTL_MS = 5 * 60 * 1000;

function publicUser(u) {
  return {
    address: u.address,
    username: u.username || null,
    points: u.points,
    watchSeconds: u.watchSeconds || 0,
  };
}

// Step 1: the browser asks for a message to sign for its address.
app.post('/api/wallet/nonce', (req, res) => {
  const address = normalizeAddress((req.body || {}).address);
  if (!address) return res.status(400).json({ error: 'Invalid wallet address.' });
  const nonce = crypto.randomBytes(16).toString('hex');
  nonces.set(address.toLowerCase(), { nonce, exp: Date.now() + NONCE_TTL_MS });
  res.json({ message: buildMessage(cfg.SITE_NAME, address, nonce) });
});

// Step 2: the browser returns the signature; we verify it and open a session.
app.post('/api/wallet/verify', async (req, res) => {
  const address = normalizeAddress((req.body || {}).address);
  const signature = (req.body || {}).signature;
  if (!address || !signature) return res.status(400).json({ error: 'Missing address or signature.' });

  const rec = nonces.get(address.toLowerCase());
  if (!rec || rec.exp < Date.now()) return res.status(400).json({ error: 'Sign-in expired — please try again.' });

  const message = buildMessage(cfg.SITE_NAME, address, rec.nonce);
  const signer = recoverSigner(message, signature);
  if (!signer || signer.toLowerCase() !== address.toLowerCase()) {
    return res.status(401).json({ error: 'Signature did not match wallet.' });
  }
  nonces.delete(address.toLowerCase()); // single use

  // Anti-bot layer 1: wallet must clear the age / history gate.
  const age = await checkWalletAge(signer);
  if (!age.ok) return res.status(403).json({ error: rejectionMessage(), reason: age.reason });

  const user = store.getOrCreateByAddress(signer);
  setSession(res, user.address.toLowerCase());
  res.json(publicUser(user));
});

// Step 3 (first connect only): choose a username.
app.post('/api/wallet/username', requireAuth, (req, res) => {
  try {
    const user = store.setUsername(req.user.address, (req.body || {}).username);
    res.json(publicUser(user));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({ user: publicUser(req.user) });
});

// --- watch session: CAPTCHA -> rotating watch token ------------------------
// Layer 3 (CAPTCHA) gates the START of an earning session; layer 2 (rotating
// token) then rides every heartbeat.

// Start (or re-verify) a session: requires a fresh CAPTCHA token.
app.post('/api/watch/start', requireAuth, async (req, res) => {
  const cap = await verifyCaptcha((req.body || {}).captchaToken, clientIp(req));
  if (!cap.ok) return res.status(403).json({ error: `CAPTCHA rejected (${cap.reason || 'unknown'})`, reason: cap.reason });
  const token = issueWatchToken(SECRET, req.user.address.toLowerCase(), cfg.WATCH_TOKEN_TTL_MS);
  res.json({ watchToken: token, ttlMs: cfg.WATCH_TOKEN_TTL_MS, refreshMs: cfg.WATCH_REFRESH_MS, captchaEveryMs: cfg.CAPTCHA_EVERY_MS });
});

// Refresh: swaps a still-valid token for a fresh one. No CAPTCHA needed here,
// but the token must be currently valid (so refreshing can't outlive a session
// that was never CAPTCHA-verified).
app.post('/api/watch/refresh', requireAuth, (req, res) => {
  const current = req.headers['x-watch-token'];
  const v = verifyWatchToken(SECRET, current, req.user.address.toLowerCase());
  if (!v.ok) return res.status(401).json({ error: 'Watch token invalid — restart session.', reason: v.reason });
  const token = issueWatchToken(SECRET, req.user.address.toLowerCase(), cfg.WATCH_TOKEN_TTL_MS);
  res.json({ watchToken: token, ttlMs: cfg.WATCH_TOKEN_TTL_MS });
});

// --- the earning heartbeat -------------------------------------------------
app.post('/api/heartbeat', requireAuth, (req, res) => {
  // Layer 2: every heartbeat must carry a valid, unexpired watch token bound to
  // this wallet. Missing/expired -> tell the client to restart the session.
  const v = verifyWatchToken(SECRET, req.headers['x-watch-token'], req.user.address.toLowerCase());
  if (!v.ok) return res.status(428).json({ error: 'watch-token', reason: v.reason });

  const result = applyHeartbeat(req.user, Date.now(), cfg);
  if (result.awarded) store.save();
  res.json({
    points: result.points,
    granted: result.granted,
    watchSeconds: req.user.watchSeconds || 0,
    secondsToNext: result.secondsToNext,
  });
});

// --- leaderboard -----------------------------------------------------------
app.get('/api/leaderboard', (_req, res) => {
  res.json({ leaderboard: store.leaderboard(20) });
});

app.use(express.static(path.join(__dirname, 'public')));

// start (skip when imported by tests)
if (require.main === module) {
  app.listen(cfg.PORT, () => {
    console.log(`${cfg.SITE_NAME} running -> http://localhost:${cfg.PORT}`);
  });
}

module.exports = { app, store };
