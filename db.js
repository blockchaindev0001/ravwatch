'use strict';

// ---------------------------------------------------------------------------
// Tiny atomic JSON store. Zero native dependencies (no SQLite build tools).
// Accounts are keyed by EVM wallet address, so a viewer's points live with
// their wallet and come back whenever they reconnect it.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

// DATA_DIR is overridable so a host can point it at a persistent disk mount
// (e.g. Render disk at /data) — otherwise points reset on every redeploy.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadRaw(file) {
  ensureDir();
  if (!fs.existsSync(file)) return { users: {}, usernames: {} };
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { users: {}, usernames: {} };
  }
}

function shortAddr(addr) {
  return addr.slice(0, 6) + '…' + addr.slice(-4);
}

class Store {
  constructor(file = DB_FILE) {
    this.file = file;
    this.data = loadRaw(file);
    if (!this.data.users) this.data.users = {};       // key: lowercase address
    if (!this.data.usernames) this.data.usernames = {}; // key: lowercase username -> address key
  }

  flush() {
    ensureDir();
    const tmp = this.file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }

  save() {
    this.flush();
  }

  // --- accounts (keyed by wallet address) --------------------------------
  getByAddress(address) {
    if (!address) return null;
    return this.data.users[String(address).toLowerCase()] || null;
  }

  // Session lookups go through the address.
  getById(address) {
    return this.getByAddress(address);
  }

  // Look up the wallet's account, creating a fresh one on first connect.
  getOrCreateByAddress(address) {
    const key = String(address).toLowerCase();
    if (!this.data.users[key]) {
      this.data.users[key] = {
        address,               // checksummed form as provided
        username: null,        // chosen after first connect
        points: 0,
        watchSeconds: 0,
        lastSeenAt: 0,
        lastTickAt: 0,
        createdAt: Date.now(),
      };
      this.flush();
    }
    return this.data.users[key];
  }

  hasUsername(username) {
    return !!this.data.usernames[String(username || '').trim().toLowerCase()];
  }

  // Set (or change) the display name for a wallet. Unique, case-insensitive.
  setUsername(address, username) {
    const key = String(address).toLowerCase();
    const user = this.data.users[key];
    if (!user) throw new Error('Unknown wallet.');
    const uname = String(username || '').trim();
    if (!/^[A-Za-z0-9_]{3,20}$/.test(uname)) {
      throw new Error('Username must be 3-20 chars: letters, numbers, underscore.');
    }
    const unameKey = uname.toLowerCase();
    const owner = this.data.usernames[unameKey];
    if (owner && owner !== key) throw new Error('Username already taken.');
    if (user.username) delete this.data.usernames[user.username.toLowerCase()];
    user.username = uname;
    this.data.usernames[unameKey] = key;
    this.flush();
    return user;
  }

  // --- leaderboard -------------------------------------------------------
  leaderboard(limit = 20) {
    return Object.values(this.data.users)
      .sort((a, b) => b.points - a.points)
      .slice(0, limit)
      .map((u, i) => ({
        rank: i + 1,
        name: u.username || shortAddr(u.address),
        address: u.address,
        points: u.points,
      }));
  }
}

module.exports = { Store, DB_FILE, DATA_DIR, shortAddr };
