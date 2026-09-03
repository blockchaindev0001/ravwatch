'use strict';

// ---------------------------------------------------------------------------
// Wallet history / age gate on ROBINHOOD CHAIN (Sybil resistance).
//
// Robinhood Chain (EVM L2, chain id 4663) is gated by Robinhood's KYC, so a
// wallet with real activity there is a strong "real human" signal. A freshly
// generated bot wallet has none.
//
// Two modes:
//   * Keyless (default): public Robinhood Chain RPC. We require the wallet to
//     have SENT >= FALLBACK_MIN_TX transactions (eth_getTransactionCount).
//     A brand-new bot wallet has 0. (Caveat: misses receive-only wallets.)
//   * Alchemy (if ALCHEMY_ASSET_TRANSFERS_URL is set): read the wallet's FIRST
//     transfer (in or out) and require it to be older than MIN_WALLET_AGE_HOURS
//     — true time-based age, and it also catches receive-only wallets.
//
// If the lookup service is unreachable we FAIL OPEN (allow) but flag it, so an
// RPC/provider outage can't lock out every legitimate viewer.
// ---------------------------------------------------------------------------
const cfg = require('./config');

const cache = new Map(); // addressLower -> { ok, ageHours|null, reason, at, ... }

async function rpc(url, method, params) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error.message || 'rpc-error');
  return data.result;
}

// Keyless: number of transactions the wallet has SENT on Robinhood Chain.
async function sentTxCount(address) {
  const hex = await rpc(cfg.WALLET_RPC_URL, 'eth_getTransactionCount', [address, 'latest']);
  if (typeof hex !== 'string') throw new Error('rpc-unavailable');
  return parseInt(hex, 16);
}

// Alchemy: timestamp (ms) of the wallet's FIRST transfer (in or out), or 0.
async function firstTransferTsMs(address) {
  const url = cfg.ALCHEMY_ASSET_TRANSFERS_URL;
  const base = {
    fromBlock: '0x0', toBlock: 'latest', order: 'asc', withMetadata: true,
    maxCount: '0x1', category: ['external', 'erc20', 'erc721', 'erc1155'],
  };
  const [outbound, inbound] = await Promise.all([
    rpc(url, 'alchemy_getAssetTransfers', [{ ...base, fromAddress: address }]),
    rpc(url, 'alchemy_getAssetTransfers', [{ ...base, toAddress: address }]),
  ]);
  const stamps = [];
  for (const res of [outbound, inbound]) {
    const t = res && res.transfers && res.transfers[0];
    const ts = t && t.metadata && t.metadata.blockTimestamp;
    if (ts) stamps.push(new Date(ts).getTime());
  }
  return stamps.length ? Math.min(...stamps) : 0;
}

async function checkWalletAge(address) {
  if (!cfg.REQUIRE_WALLET_AGE) return { ok: true, disabled: true };
  const key = String(address).toLowerCase();
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < cfg.WALLET_AGE_CACHE_MS) return cached;

  let result;
  try {
    if (cfg.ALCHEMY_ASSET_TRANSFERS_URL) {
      const ts = await firstTransferTsMs(address);
      if (!ts) {
        result = { ok: false, ageHours: 0, reason: 'no-history' };
      } else {
        const ageHours = (Date.now() - ts) / 3.6e6;
        const ok = ageHours >= cfg.MIN_WALLET_AGE_HOURS;
        result = { ok, ageHours: Math.round(ageHours), reason: ok ? 'ok' : 'too-new' };
      }
    } else {
      const n = await sentTxCount(address);
      const ok = n >= cfg.FALLBACK_MIN_TX;
      result = { ok, ageHours: null, txCount: n, fallback: true, reason: ok ? 'ok-fallback' : 'no-history' };
    }
  } catch (_) {
    result = { ok: true, ageHours: null, softpass: true, reason: 'lookup-unavailable' };
  }
  result.at = Date.now();
  cache.set(key, result);
  return result;
}

function rejectionMessage() {
  const chain = cfg.CHAIN_NAME;
  if (cfg.ALCHEMY_ASSET_TRANSFERS_URL) {
    return `This wallet is too new on ${chain}. To keep out bots, connect a wallet with ${chain} history at least ${cfg.MIN_WALLET_AGE_HOURS}h old.`;
  }
  return `This wallet has no ${chain} history yet. To keep out bots, connect a wallet you've used on ${chain} (one that has made at least one transaction there).`;
}

module.exports = { checkWalletAge, rejectionMessage };
