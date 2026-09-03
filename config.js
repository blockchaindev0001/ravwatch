'use strict';

// ---------------------------------------------------------------------------
// RAV Watch-to-Earn configuration
// ---------------------------------------------------------------------------
module.exports = {
  PORT: Number(process.env.PORT || 8910),

  // Site branding (kept generic; this is an independent viewer-rewards layer,
  // not an official RAV property).
  SITE_NAME: process.env.SITE_NAME || 'RAV Watch & Earn',

  // The real name of the channel being streamed, shown on the live player.
  CHANNEL_NAME: process.env.CHANNEL_NAME || "Real America's Voice",

  // --- The live stream (Real America's Voice, live on YouTube) -----------
  // RAV livestreams on YouTube. The server looks up whatever video is CURRENTLY
  // LIVE on this channel (so the id never has to be hand-updated), and the
  // browser plays it through YouTube's IFrame API, which reports real play
  // state -- so points only accrue while the live stream is actually playing.
  //   RAV YouTube channel: https://www.youtube.com/@RealAmericasVoice
  YT_CHANNEL_ID: process.env.YT_CHANNEL_ID || 'UCMGZ8pfQHgZ6Yj0-92PMENg',
  // Optional hard override: set a specific YouTube video id to embed instead of
  // auto-resolving the channel's current live stream. Leave blank for auto.
  YT_VIDEO_ID: process.env.YT_VIDEO_ID || '',
  // How long to cache the "what's live now" lookup (ms).
  LIVE_CACHE_MS: Number(process.env.LIVE_CACHE_MS || 60000),

  // --- Earning mechanics (server-authoritative) --------------------------
  // One point per TICK_SECONDS of real, continuous, foreground watch time.
  TICK_SECONDS: Number(process.env.TICK_SECONDS || 30),
  POINTS_PER_TICK: Number(process.env.POINTS_PER_TICK || 1),

  // The browser sends a heartbeat this often *while actually watching*.
  // Divides the tick evenly so points land right on the tick boundary.
  HEARTBEAT_MS: Number(process.env.HEARTBEAT_MS || 10000),

  // If no heartbeat arrives for longer than this, the earning clock resets and
  // the gap is not paid out. Set just above the heartbeat cadence (+ jitter) so
  // any real pause promptly resets, but ordinary beats never trip it.
  MAX_GAP_MS: Number(process.env.MAX_GAP_MS || 15000),

  // --- Active-presence check (anti-idle-farming) -------------------------
  // After this many ms of continuous earning, a "Still watching?" prompt
  // appears and earning pauses until the viewer clicks it. Set to 0 to disable.
  PRESENCE_EVERY_MS: Number(process.env.PRESENCE_EVERY_MS || 5 * 60 * 1000),

  // Session cookie lifetime (days).
  SESSION_DAYS: Number(process.env.SESSION_DAYS || 30),

  // =========================================================================
  // ANTI-BOT LAYERS
  // =========================================================================

  // --- (1) Wallet history / age gate on ROBINHOOD CHAIN (Sybil resistance) -
  // We check the connecting wallet's history on Robinhood Chain (an EVM L2,
  // chain id 4663). Robinhood requires KYC, so a wallet with real Robinhood
  // Chain activity is a strong "real human" signal — and a freshly generated
  // bot wallet has none.
  REQUIRE_WALLET_AGE: process.env.REQUIRE_WALLET_AGE !== 'false',
  MIN_WALLET_AGE_HOURS: Number(process.env.MIN_WALLET_AGE_HOURS || 24),
  CHAIN_NAME: process.env.CHAIN_NAME || 'Robinhood Chain',
  WALLET_CHAIN_ID: Number(process.env.WALLET_CHAIN_ID || 4663),
  // Public Robinhood Chain RPC (no key). Used for the keyless history check:
  // require the wallet to have sent >= FALLBACK_MIN_TX transactions on-chain.
  WALLET_RPC_URL: process.env.WALLET_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
  FALLBACK_MIN_TX: Number(process.env.FALLBACK_MIN_TX || 1),
  // OPTIONAL upgrade to TRUE time-based age (and to catch receive-only wallets):
  // an Alchemy Robinhood-Chain URL, e.g. https://robinhood-mainnet.g.alchemy.com/v2/<KEY>
  // When set, we read the wallet's FIRST transfer timestamp via getAssetTransfers
  // and require it to be older than MIN_WALLET_AGE_HOURS. (The public Blockscout
  // explorer is Cloudflare-gated, so it can't be queried server-side.)
  ALCHEMY_ASSET_TRANSFERS_URL: process.env.ALCHEMY_ASSET_TRANSFERS_URL || '',
  WALLET_AGE_CACHE_MS: Number(process.env.WALLET_AGE_CACHE_MS || 6 * 60 * 60 * 1000),

  // --- (2) Rotating watch token ------------------------------------------
  // Every heartbeat must carry a short-lived, server-signed token. It expires
  // fast and must be refreshed via a server round-trip, so a captured token
  // can't be replayed for long.
  WATCH_TOKEN_TTL_MS: Number(process.env.WATCH_TOKEN_TTL_MS || 90000),
  WATCH_REFRESH_MS: Number(process.env.WATCH_REFRESH_MS || 60000),

  // --- (3) CAPTCHA (Cloudflare Turnstile) --------------------------------
  // Required to start/resume an earning session. Human-detection is offloaded
  // to Cloudflare; the secret key lives ONLY here on the server.
  // Defaults below are Cloudflare's PUBLIC TEST keys (always pass) so the flow
  // works out of the box -- replace with your real keys for production.
  //   Get keys: https://dash.cloudflare.com -> Turnstile
  TURNSTILE_SITE_KEY: process.env.TURNSTILE_SITE_KEY || '1x00000000000000000000AA',
  TURNSTILE_SECRET_KEY: process.env.TURNSTILE_SECRET_KEY || '1x0000000000000000000000000000000AA',
  // Re-verify a human this often while watching (tie to the presence prompt).
  CAPTCHA_EVERY_MS: Number(process.env.CAPTCHA_EVERY_MS || 5 * 60 * 1000),
};
