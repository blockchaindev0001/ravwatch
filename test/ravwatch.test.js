'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Wallet } = require('ethers');

const { Store, shortAddr } = require('../db');
const { applyHeartbeat } = require('../earn');
const { buildMessage, recoverSigner, normalizeAddress } = require('../wallet');
const { issueWatchToken, verifyWatchToken } = require('../watchtoken');

const CFG = { TICK_SECONDS: 30, POINTS_PER_TICK: 1, MAX_GAP_MS: 15000 };
const HB = 10000; // heartbeat cadence used in the continuity tests
const SITE = 'RAV Watch & Earn';

function tmpStore() {
  const file = path.join(os.tmpdir(), `ravwatch-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  return { s: new Store(file), file };
}

function watchContinuously(user, t0, count, stepMs, cfg) {
  let t = t0;
  for (let i = 0; i < count; i++) { applyHeartbeat(user, t, cfg); t += stepMs; }
  return user.points;
}

// --- wallet sign-in --------------------------------------------------------
test('a real wallet signature recovers to its own address', async () => {
  const w = Wallet.createRandom();
  const msg = buildMessage(SITE, w.address, 'nonce123');
  const sig = await w.signMessage(msg);
  const recovered = recoverSigner(msg, sig);
  assert.strictEqual(recovered.toLowerCase(), w.address.toLowerCase());
});

test('a tampered message / wrong nonce does NOT recover the signer', async () => {
  const w = Wallet.createRandom();
  const sig = await w.signMessage(buildMessage(SITE, w.address, 'nonceA'));
  const recovered = recoverSigner(buildMessage(SITE, w.address, 'nonceB'), sig);
  assert.notStrictEqual((recovered || '').toLowerCase(), w.address.toLowerCase());
});

test('normalizeAddress checksums valid addresses and rejects junk', () => {
  const w = Wallet.createRandom();
  assert.strictEqual(normalizeAddress(w.address.toLowerCase()), w.address); // checksummed
  assert.strictEqual(normalizeAddress('0x123'), null);
  assert.strictEqual(normalizeAddress('not-an-address'), null);
});

// --- accounts keyed by wallet ---------------------------------------------
test('getOrCreateByAddress creates once and returns the same account', () => {
  const { s } = tmpStore();
  const w = Wallet.createRandom();
  const a = s.getOrCreateByAddress(w.address);
  a.points = 7;
  const b = s.getOrCreateByAddress(w.address);       // same wallet again
  assert.strictEqual(b.points, 7);                    // not reset
  assert.strictEqual(s.getByAddress(w.address.toLowerCase()).points, 7); // case-insensitive
});

test('setUsername enforces format and uniqueness', () => {
  const { s } = tmpStore();
  const w1 = Wallet.createRandom();
  const w2 = Wallet.createRandom();
  s.getOrCreateByAddress(w1.address);
  s.getOrCreateByAddress(w2.address);
  assert.throws(() => s.setUsername(w1.address, 'ab'), /3-20/);
  assert.throws(() => s.setUsername(w1.address, 'bad name'), /3-20/);
  s.setUsername(w1.address, 'Patriot');
  assert.throws(() => s.setUsername(w2.address, 'patriot'), /taken/); // case-insensitive clash
  // same wallet can keep/rename its own name
  s.setUsername(w1.address, 'Patriot'); // idempotent
  s.setUsername(w1.address, 'Patriot2');
  assert.strictEqual(s.getByAddress(w1.address).username, 'Patriot2');
});

test('points persist across store reloads, keyed by wallet', () => {
  const { s, file } = tmpStore();
  const w = Wallet.createRandom();
  const u = s.getOrCreateByAddress(w.address);
  u.points = 42;
  s.setUsername(w.address, 'holder');
  s.save();
  const s2 = new Store(file);
  const back = s2.getByAddress(w.address);
  assert.strictEqual(back.points, 42);
  assert.strictEqual(back.username, 'holder');
  fs.rmSync(file, { force: true });
});

test('leaderboard falls back to short address when no username', () => {
  const { s } = tmpStore();
  const w = Wallet.createRandom();
  const u = s.getOrCreateByAddress(w.address);
  u.points = 3;
  const row = s.leaderboard()[0];
  assert.strictEqual(row.name, shortAddr(w.address));
  assert.strictEqual(row.points, 3);
});

// --- rotating watch token (anti-bot layer 2) -------------------------------
test('a valid watch token verifies for its own wallet', () => {
  const secret = 'test-secret';
  const addr = '0xabc0000000000000000000000000000000000001';
  const tok = issueWatchToken(secret, addr, 90000);
  const v = verifyWatchToken(secret, tok, addr);
  assert.ok(v.ok);
  assert.strictEqual(v.payload.a, addr);
});

test('watch token is rejected for a different wallet', () => {
  const secret = 'test-secret';
  const tok = issueWatchToken(secret, '0xabc0000000000000000000000000000000000001', 90000);
  const v = verifyWatchToken(secret, tok, '0xdef0000000000000000000000000000000000002');
  assert.ok(!v.ok);
  assert.strictEqual(v.reason, 'wrong-wallet');
});

test('an expired watch token is rejected', () => {
  const secret = 'test-secret';
  const addr = '0xabc0000000000000000000000000000000000001';
  const tok = issueWatchToken(secret, addr, -1); // already expired
  assert.strictEqual(verifyWatchToken(secret, tok, addr).reason, 'expired');
});

test('a tampered / wrong-secret watch token is rejected', () => {
  const addr = '0xabc0000000000000000000000000000000000001';
  const tok = issueWatchToken('secretA', addr, 90000);
  assert.strictEqual(verifyWatchToken('secretB', tok, addr).reason, 'bad-sig');
  assert.strictEqual(verifyWatchToken('secretA', 'garbage', addr).reason, 'malformed');
  assert.strictEqual(verifyWatchToken('secretA', '', addr).reason, 'missing');
});

// --- earning rule ----------------------------------------------------------
test('first heartbeat starts the clock and pays nothing', () => {
  const user = { points: 0, watchSeconds: 0 };
  const r = applyHeartbeat(user, 1_000_000, CFG);
  assert.ok(!r.awarded);
  assert.strictEqual(user.points, 0);
  assert.strictEqual(user.lastTickAt, 1_000_000);
});

test('continuous watching grants one point per tick of real time', () => {
  const user = { points: 0, watchSeconds: 0 };
  watchContinuously(user, 2_000_000, 10, HB, CFG); // beats at 0..90s -> 30/60/90
  assert.strictEqual(user.points, 3);
  assert.strictEqual(user.watchSeconds, 90);
});

test('heartbeat spam earns nothing faster than real time (anti-farm)', () => {
  const user = { points: 0, watchSeconds: 0 };
  const t0 = 3_000_000;
  applyHeartbeat(user, t0, CFG);
  for (let i = 1; i <= 1000; i++) applyHeartbeat(user, t0 + i * 0.5, CFG);
  assert.strictEqual(user.points, 0);
});

test('jitter tolerance: a heartbeat landing slightly early still counts', () => {
  const user = { points: 0, watchSeconds: 0 };
  const t0 = 4_000_000;
  applyHeartbeat(user, t0, CFG);
  applyHeartbeat(user, t0 + 10000, CFG);
  applyHeartbeat(user, t0 + 20000, CFG);
  const r = applyHeartbeat(user, t0 + 29000, CFG);
  assert.ok(r.awarded);
  assert.strictEqual(user.points, 1);
});

test('closed/paused tab: the gap is NOT banked into points (continuity)', () => {
  const user = { points: 0, watchSeconds: 0 };
  const t0 = 5_000_000;
  applyHeartbeat(user, t0, CFG);
  const r = applyHeartbeat(user, t0 + 3_600_000, CFG);
  assert.ok(!r.awarded);
  assert.strictEqual(user.points, 0);
});

test('resume after a break requires a fresh full tick before paying', () => {
  const user = { points: 0, watchSeconds: 0 };
  const t0 = 6_000_000;
  applyHeartbeat(user, t0, CFG);
  const tR = t0 + 3_600_000;
  applyHeartbeat(user, tR, CFG);
  applyHeartbeat(user, tR + 10000, CFG);
  applyHeartbeat(user, tR + 20000, CFG);
  const r = applyHeartbeat(user, tR + 30000, CFG);
  assert.ok(r.awarded);
  assert.strictEqual(user.points, 1);
});

test('secondsToNext reflects real progress and resets after a break', () => {
  const user = { points: 0, watchSeconds: 0 };
  const t0 = 8_000_000;
  assert.strictEqual(applyHeartbeat(user, t0, CFG).secondsToNext, 30);
  assert.strictEqual(applyHeartbeat(user, t0 + 10000, CFG).secondsToNext, 20);
  assert.strictEqual(applyHeartbeat(user, t0 + 20000, CFG).secondsToNext, 10);
  assert.strictEqual(applyHeartbeat(user, t0 + 3_600_000, CFG).secondsToNext, 30);
});
