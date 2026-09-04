'use strict';

let cfg = { tickSeconds: 30, pointsPerTick: 1, heartbeatMs: 8000, presenceEveryMs: 300000 };
let me = null;                 // { username, points, watchSeconds }
let heartbeatTimer = null;
let uiTimer = null;
let secondsToNext = null;      // seconds of watching left until the next point (from server)

// --- player playback state (fed by the YouTube IFrame API) -----------------
let ytPlayer = null;
let ytApiReady = false;
let playerReady = false;       // YT player object is ready
let playerFailed = false;      // could not initialise the player
let playerPlaying = false;     // YT.PlayerState.PLAYING
let lastMediaTime = -1;        // last getCurrentTime() reading
let mediaAdvancing = true;     // did playback time move since last check?

// --- stream status (resolved by our server) --------------------------------
let streamMode = 'offline';    // 'live' | 'replay' | 'offline'
let liveVideoId = null;
let liveTitle = null;
const streamOn = () => streamMode === 'live' || streamMode === 'replay';

// --- active-presence ("still watching?") -----------------------------------
let presenceOK = true;
let activeMsSincePrompt = 0;

// --- anti-bot: CAPTCHA + rotating watch token ------------------------------
let cfWidgetId = null;         // Turnstile widget id
let cfToken = null;            // latest token from the widget's callback
let cfTokenUsed = false;       // Turnstile tokens are single-use
let watchToken = null;         // current rotating watch token
let watchTokenExp = 0;         // ms epoch when it expires
let lastCaptchaAt = 0;         // last time a full CAPTCHA was solved
let lastWatchError = null;     // human-readable reason the watch session failed
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const $ = (id) => document.getElementById(id);

async function api(pathname, opts = {}) {
  const res = await fetch(pathname, {
    method: 'GET',
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ===========================================================================
// YouTube player (IFrame API) + live-stream resolution
// ===========================================================================
function loadYouTubeApi() {
  window.onYouTubeIframeAPIReady = () => { ytApiReady = true; buildPlayerWhenReady(); };
  const s = document.createElement('script');
  s.src = 'https://www.youtube.com/iframe_api';
  s.async = true;
  s.onerror = () => { playerFailed = true; };
  document.head.appendChild(s);
  // If the API never loads (blocked), stop spinning after a while.
  setTimeout(() => { if (!ytApiReady) playerFailed = true; }, 12000);
}

// Ask the server what's live now; refresh periodically so we always follow the
// current broadcast without a hard-coded id.
async function refreshLive() {
  try {
    const s = await api('/api/live');
    streamMode = s.mode || (s.live ? 'live' : 'offline');
    liveTitle = s.title || null;
    if (s.videoId && s.videoId !== liveVideoId) {
      liveVideoId = s.videoId;
      buildPlayerWhenReady(); // (re)load the current live/replay video
    }
    if (streamMode === 'offline' && ytPlayer) { try { ytPlayer.pauseVideo(); } catch (_) {} }
    updateStreamUi();
  } catch (_) { /* keep last known */ }
}

function buildPlayerWhenReady() {
  if (!ytApiReady || !liveVideoId) return;
  if (ytPlayer) { try { ytPlayer.loadVideoById(liveVideoId); } catch (_) {} return; }
  ytPlayer = new YT.Player('player', {
    videoId: liveVideoId,
    playerVars: {
      autoplay: 1, mute: 1, playsinline: 1, rel: 0, modestbranding: 1,
      origin: location.origin,
    },
    events: {
      onReady: () => { playerReady = true; },
      onStateChange: (e) => {
        playerPlaying = (e.data === YT.PlayerState.PLAYING);
        // A recording finished -> loop it from the start so earning continues.
        if (e.data === YT.PlayerState.ENDED && streamMode === 'replay' && ytPlayer) {
          try { lastMediaTime = -1; ytPlayer.seekTo(0, true); ytPlayer.playVideo(); } catch (_) {}
        }
      },
      onError: () => { playerFailed = true; },
    },
  });
}

// Confirms playback time is actually moving (guards against a stalled player
// that still reports "playing").
function pollMediaTime() {
  if (!ytPlayer || typeof ytPlayer.getCurrentTime !== 'function') { mediaAdvancing = true; return; }
  let t;
  try { t = ytPlayer.getCurrentTime(); } catch (_) { return; }
  if (typeof t !== 'number' || isNaN(t)) { mediaAdvancing = true; return; }
  if (lastMediaTime >= 0) mediaAdvancing = t > lastMediaTime + 0.05;
  lastMediaTime = t;
}

function updateStreamUi() {
  const live = streamMode === 'live';
  const replay = streamMode === 'replay';
  const b = document.querySelector('.live');
  if (b) {
    b.textContent = live ? 'LIVE' : replay ? 'REPLAY' : 'OFFLINE';
    b.style.background = live ? 'var(--accent)' : replay ? 'var(--warn)' : '#555';
  }
  const dot = $('npDot');
  if (dot) dot.classList.toggle('off', !streamOn());
  const show = $('showTitle');
  if (show) {
    show.textContent = live
      ? (liveTitle ? '· ' + liveTitle : '· Live now')
      : replay
        ? (liveTitle ? '· Replay: ' + liveTitle : '· Replay')
        : '· Offline';
  }
  const banner = $('streamBanner');
  if (banner) {
    if (replay) {
      banner.innerHTML = '<b>RAV is currently offline.</b> You\'re watching a recent broadcast — you still earn points. We\'ll switch to the live stream automatically when RAV goes online.';
      banner.classList.remove('hidden');
    } else if (streamMode === 'offline') {
      banner.innerHTML = '<b>RAV is currently offline.</b> Live streaming will begin automatically when RAV goes online.';
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
  }
}

// ===========================================================================
// "Am I really watching?" — every gate must pass
// ===========================================================================
function isForeground() {
  return document.visibilityState === 'visible' && document.hasFocus();
}

// True when the stream is genuinely playing AND being watched (ignores the
// anti-bot token — that's handled separately so we can still fetch one).
function watchableNow() {
  if (!me) return false;
  if (!streamOn()) return false;       // nothing playing (offline) -> nothing to earn from
  if (!isForeground()) return false;
  if (!presenceOK) return false;
  if (!playerReady) return false;      // player not up -> don't earn
  if (!playerPlaying) return false;    // paused / ended / not started
  if (!mediaAdvancing) return false;   // player says playing but time frozen
  return true;
}

// Actually earning: watchable AND holding a valid anti-bot watch token.
function isEarning() {
  if (!watchableNow()) return false;
  if (cfg.captchaEnabled && !watchToken) return false; // human-check pending
  return true;
}

// Human-readable reason earning is off (for the status line).
function notEarningReason() {
  if (!me) return 'Connect your wallet to start earning.';
  if (streamMode === 'offline') return 'RAV is offline right now — earning resumes when a stream is playing.';
  if (!presenceOK) return 'Paused — confirm you are still watching.';
  if (!isForeground()) return 'Paused — keep this tab visible and focused to earn.';
  if (playerFailed && !playerReady) return 'Stream could not load — disable ad-blockers for this site and reload.';
  if (!playerReady) return 'Waiting for the live stream to load…';
  if (!playerPlaying) return 'Paused — press play on the live stream to earn.';
  if (!mediaAdvancing) return 'Buffering — earning resumes when the stream plays.';
  if (cfg.captchaEnabled && !watchToken) {
    return lastWatchError
      ? 'Human check failed: ' + lastWatchError + ' — see the check above.'
      : 'Verifying you are human — complete the check to earn.';
  }
  return '';
}

// ===========================================================================
// Anti-bot: Cloudflare Turnstile + rotating watch token
// ===========================================================================
function initTurnstile() {
  return new Promise((resolve) => {
    if (!cfg.captchaEnabled || !cfg.turnstileSiteKey) { resolve(false); return; }
    window.__cfOnload = () => {
      try {
        cfWidgetId = window.turnstile.render('#cfWidget', {
          sitekey: cfg.turnstileSiteKey,
          size: 'flexible',
          // Just capture tokens as the widget produces them. Turnstile refreshes
          // them on its own; we never reset it mid-verification.
          callback: (tok) => { cfToken = tok; cfTokenUsed = false; },
          'expired-callback': () => { cfToken = null; },
          'error-callback': () => { cfToken = null; },
        });
        resolve(true);
      } catch (_) { resolve(false); }
    };
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=__cfOnload&render=explicit';
    s.async = true; s.defer = true;
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
}

// Wait (up to timeoutMs) for a fresh, unspent CAPTCHA token from the widget's
// callback. Never resets the widget, so an in-progress verification completes.
// Returns 'disabled' when CAPTCHA is off, or null if none arrived in time.
async function getFreshCaptcha(timeoutMs = 20000) {
  if (!cfg.captchaEnabled) return 'disabled';
  if (cfWidgetId === null) return null;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cfToken && !cfTokenUsed) return cfToken;
    await sleep(300);
  }
  return null;
}

// Force the widget to mint a NEW token (only after a spent/failed one).
function newCaptchaToken() {
  cfToken = null; cfTokenUsed = false;
  try { window.turnstile.reset(cfWidgetId); } catch (_) {}
}

// Start (or CAPTCHA-re-verify) an earning session.
async function startWatchSession() {
  const captchaToken = await getFreshCaptcha();
  if (cfg.captchaEnabled && !captchaToken) {
    lastWatchError = 'no CAPTCHA response (let the check finish)';
    watchToken = null; return false;
  }
  try {
    const r = await api('/api/watch/start', {
      method: 'POST',
      body: JSON.stringify({ captchaToken: captchaToken === 'disabled' ? undefined : captchaToken }),
    });
    cfTokenUsed = true;            // this token is now spent
    watchToken = r.watchToken;
    watchTokenExp = Date.now() + r.ttlMs;
    lastCaptchaAt = Date.now();
    lastWatchError = null;
    return true;
  } catch (e) {
    lastWatchError = e.message || 'watch session failed';
    console.warn('[ravwatch] watch/start failed:', e.message);
    newCaptchaToken();             // spent/failed -> mint a fresh one for the retry
    watchToken = null; return false;
  }
}

// Keep the token fresh. CAPTCHA is solved ONCE at session start; after that we
// just rotate the token via /api/watch/refresh (no CAPTCHA), so the widget is
// not reset over and over. Re-CAPTCHA only if the token chain actually breaks.
async function refreshWatchToken() {
  if (!watchToken) return maybeStartSession();
  try {
    const r = await api('/api/watch/refresh', { method: 'POST', headers: { 'X-Watch-Token': watchToken } });
    watchToken = r.watchToken;
    watchTokenExp = Date.now() + r.ttlMs;
    return true;
  } catch (_) { return maybeStartSession(); }
}

// Attempt a fresh CAPTCHA-gated session start, but no more often than every 20s
// so a rejected token can't spin the widget in a "Verifying…" loop.
let lastSessionAttempt = 0;
async function maybeStartSession() {
  // Widget not rendered yet? Don't burn the backoff window — retry soon.
  if (cfg.captchaEnabled && cfWidgetId === null) return false;
  if (Date.now() - lastSessionAttempt < 20000) return false;
  lastSessionAttempt = Date.now();
  return startWatchSession();
}

// ===========================================================================
// Heartbeat + UI loops
// ===========================================================================
async function sendHeartbeat() {
  pollMediaTime();
  if (!watchableNow()) return;
  // Ensure a valid rotating watch token (may trigger a CAPTCHA).
  if (!watchToken || Date.now() > watchTokenExp - 15000) await refreshWatchToken();
  if (cfg.captchaEnabled && !watchToken) return; // still blocked on human-check
  try {
    const r = await api('/api/heartbeat', {
      method: 'POST',
      headers: watchToken ? { 'X-Watch-Token': watchToken } : {},
      body: '{}',
    });
    me.points = r.points;
    me.watchSeconds = r.watchSeconds;
    if (typeof r.secondsToNext === 'number') secondsToNext = r.secondsToNext; // resync to server truth
    renderPoints();
  } catch (e) {
    const msg = String(e.message);
    if (msg.includes('watch-token')) { watchToken = null; await startWatchSession(); }
    else if (msg.includes('logged in')) setLoggedOut();
  }
}

function uiTick() {
  const earning = isEarning();
  // accumulate active watch time toward the "still watching?" prompt
  if (cfg.presenceEveryMs > 0 && earning) {
    activeMsSincePrompt += 1000;
    if (activeMsSincePrompt >= cfg.presenceEveryMs) showPresencePrompt();
  }
  // Smoothly tick the countdown down between heartbeats — but ONLY while
  // actually earning. Paused/hidden -> it freezes instead of silently draining.
  if (earning && secondsToNext !== null && secondsToNext > 0) secondsToNext -= 1;
  renderStatus(earning);
}

function startLoops() {
  stopLoops();
  secondsToNext = cfg.tickSeconds; // full tick until the server says otherwise
  heartbeatTimer = setInterval(sendHeartbeat, Math.max(3000, cfg.heartbeatMs));
  uiTimer = setInterval(uiTick, 1000);
  sendHeartbeat();
  uiTick();
}

function stopLoops() {
  clearInterval(heartbeatTimer); heartbeatTimer = null;
  clearInterval(uiTimer); uiTimer = null;
}

// ===========================================================================
// Presence prompt
// ===========================================================================
function showPresencePrompt() {
  presenceOK = false;
  activeMsSincePrompt = 0;
  $('overlay').classList.remove('hidden');
}
function confirmPresence() {
  presenceOK = true;
  activeMsSincePrompt = 0;
  // The pause stopped heartbeats; the next one resets the server clock, so show
  // a full tick again rather than stale progress.
  secondsToNext = cfg.tickSeconds;
  $('overlay').classList.add('hidden');
  renderStatus(isEarning());
}

// ===========================================================================
// Rendering
// ===========================================================================
function renderPoints() {
  if (!me) return;
  $('pointsHdr').textContent = me.points;
  $('pointsBig').textContent = me.points;
  const s = me.watchSeconds || 0;
  $('watchTime').textContent = Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  $('rate').textContent = `${cfg.pointsPerTick} pt / ${cfg.tickSeconds}s`;
}

function renderStatus(earning) {
  const led = $('led');
  led.classList.remove('on', 'warn');
  if (!me) { $('statusText').textContent = notEarningReason(); $('countdown').textContent = '—'; return; }
  if (earning) {
    led.classList.add('on');
    $('statusText').textContent = 'Earning while you watch ✓';
    const remain = secondsToNext === null ? cfg.tickSeconds : secondsToNext;
    $('countdown').textContent = remain + 's';
  } else {
    led.classList.add('warn');
    $('statusText').textContent = notEarningReason();
    // Show the frozen value while paused so it's clear progress is on hold.
    $('countdown').textContent = secondsToNext === null ? 'paused' : secondsToNext + 's (paused)';
  }
}

async function renderLeaderboard() {
  try {
    const { leaderboard } = await api('/api/leaderboard');
    const body = $('lbBody');
    if (!leaderboard.length) {
      body.innerHTML = '<tr><td colspan="3" style="color:var(--muted)">No viewers yet.</td></tr>';
      return;
    }
    body.innerHTML = leaderboard.map((r) => {
      const mine = me && r.address && me.address && r.address.toLowerCase() === me.address.toLowerCase();
      return `<tr class="${mine ? 'me' : ''}"><td>${r.rank}</td><td>${escapeHtml(r.name)}</td><td class="r">${r.points}</td></tr>`;
    }).join('');
  } catch (_) { /* ignore */ }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ===========================================================================
// Wallet auth (Sign-In-With-Ethereum) / session
// ===========================================================================
function shortAddr(a) {
  return a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
}
function displayName(user) {
  return user.username || shortAddr(user.address);
}

async function connectWallet() {
  $('authErr').textContent = '';
  if (!window.ethereum) {
    // Mobile browsers have no wallet extension. Deep-link into the MetaMask app's
    // built-in browser, where a provider IS injected, so Connect works there.
    const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    if (isMobile) {
      $('authErr').textContent = 'Opening in the MetaMask app…';
      window.location.href = 'https://metamask.app.link/dapp/' + location.host + location.pathname;
      return;
    }
    $('authErr').innerHTML = 'No EVM wallet found. <a href="https://metamask.io/download/" target="_blank" rel="noopener" style="color:var(--accent2)">Install MetaMask</a>, then reload.';
    return;
  }
  const btn = $('connectBtn');
  btn.disabled = true; btn.textContent = 'Connecting…';
  try {
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    const address = accounts && accounts[0];
    if (!address) throw new Error('No account selected.');
    // 1) get the message to sign, 2) sign it, 3) verify server-side.
    const { message } = await api('/api/wallet/nonce', { method: 'POST', body: JSON.stringify({ address }) });
    const signature = await window.ethereum.request({ method: 'personal_sign', params: [message, address] });
    const user = await api('/api/wallet/verify', { method: 'POST', body: JSON.stringify({ address, signature }) });
    if (!user.username) promptUsername(user);
    else setLoggedIn(user);
  } catch (e) {
    // MetaMask user-rejection comes back as code 4001.
    $('authErr').textContent = e && e.code === 4001 ? 'You cancelled the wallet request.' : (e.message || 'Wallet connection failed.');
  } finally {
    btn.disabled = false; btn.textContent = 'Connect Wallet';
  }
}

function promptUsername(user) {
  me = user; // session exists; we just need a name
  $('authCard').classList.add('hidden');
  $('nameCard').classList.remove('hidden');
  $('nameWallet').textContent = shortAddr(user.address);
  $('newUsername').focus();
}

async function saveUsername() {
  const username = $('newUsername').value.trim();
  $('nameErr').textContent = '';
  try {
    const user = await api('/api/wallet/username', { method: 'POST', body: JSON.stringify({ username }) });
    $('nameCard').classList.add('hidden');
    setLoggedIn(user);
  } catch (e) {
    $('nameErr').textContent = e.message;
  }
}

function setLoggedIn(user) {
  me = user;
  $('authCard').classList.add('hidden');
  $('nameCard').classList.add('hidden');
  $('earnCard').classList.remove('hidden');
  $('pointsPill').classList.remove('hidden');
  $('logoutBtn').classList.remove('hidden');
  const who = $('whoami'); who.classList.remove('hidden'); who.textContent = displayName(user);
  const w = $('walletShort'); if (w) { w.textContent = shortAddr(user.address); w.title = user.address; }
  presenceOK = true; activeMsSincePrompt = 0;
  watchToken = null; watchTokenExp = 0; lastCaptchaAt = 0; lastSessionAttempt = 0;
  maybeStartSession(); // CAPTCHA -> first rotating watch token
  renderPoints();
  renderLeaderboard();
  startLoops();
}

function setLoggedOut() {
  me = null;
  watchToken = null; watchTokenExp = 0;
  stopLoops();
  $('authCard').classList.remove('hidden');
  $('nameCard').classList.add('hidden');
  $('earnCard').classList.add('hidden');
  $('pointsPill').classList.add('hidden');
  $('logoutBtn').classList.add('hidden');
  $('whoami').classList.add('hidden');
  $('overlay').classList.add('hidden');
  renderStatus(false);
  renderLeaderboard();
}

// ===========================================================================
// Boot
// ===========================================================================
async function boot() {
  try {
    cfg = await api('/api/config');
    $('siteName').textContent = cfg.siteName;
    document.title = cfg.siteName;
    if (cfg.channelName) $('channelName').textContent = cfg.channelName;
  } catch (_) { /* keep defaults */ }

  loadYouTubeApi();
  initTurnstile();
  await refreshLive();
  setInterval(refreshLive, 60000);

  $('connectBtn').onclick = connectWallet;
  $('saveUsername').onclick = saveUsername;
  $('newUsername').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveUsername(); });
  $('stillHere').onclick = confirmPresence;
  $('logoutBtn').onclick = async () => { await api('/api/logout', { method: 'POST', body: '{}' }); setLoggedOut(); };

  // If the viewer switches wallet accounts in MetaMask, drop the session so
  // they re-sign as the new address (points are per-address).
  if (window.ethereum && window.ethereum.on) {
    window.ethereum.on('accountsChanged', async () => {
      try { await api('/api/logout', { method: 'POST', body: '{}' }); } catch (_) {}
      setLoggedOut();
    });
  }

  document.addEventListener('visibilitychange', () => renderStatus(isEarning()));
  window.addEventListener('focus', () => renderStatus(isEarning()));
  window.addEventListener('blur', () => renderStatus(isEarning()));

  const { user } = await api('/api/me');
  if (user) setLoggedIn(user);
  else setLoggedOut();

  setInterval(renderLeaderboard, 15000);
}

boot();
