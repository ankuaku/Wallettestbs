// Node's built-in SQLite: nothing to compile, so no Node-version mismatch errors on deploy.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { config } from './config.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const file = config.dbPath || path.join(dir, '..', 'billing.db');
fs.mkdirSync(path.dirname(file), { recursive: true });
export const db = new DatabaseSync(file);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

/**
 * db.transaction(fn) -> function that runs fn inside BEGIN/COMMIT and rolls
 * back if fn throws. Nested calls join the outer transaction.
 */
let depth = 0;
db.transaction = (fn) => (...args) => {
  if (depth > 0) return fn(...args);
  depth++;
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn(...args);
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    depth--;
  }
};

db.exec(`
-- ---------- wallet billing ----------
CREATE TABLE IF NOT EXISTS billing_accounts (
  wallet        TEXT PRIMARY KEY,      -- account key "<chain>:<address>" (EVM addresses lowercase)
  label         TEXT,
  email         TEXT,
  api_key_hash  TEXT UNIQUE,
  api_key_hint  TEXT,                  -- last 4 chars, to recognise the key
  blocked       INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet      TEXT NOT NULL,
  tokens      INTEGER NOT NULL,
  cost_units  TEXT NOT NULL,           -- base units of that chain's billing token
  note        TEXT,
  source      TEXT NOT NULL DEFAULT 'admin',   -- admin | api
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_wallet ON usage_events(wallet, created_at);

CREATE TABLE IF NOT EXISTS billing_charges (
  id           TEXT PRIMARY KEY,       -- bytes32 invoice id sent to the contract
  wallet       TEXT NOT NULL,
  amount_units TEXT NOT NULL,
  status       TEXT NOT NULL,          -- pending | sent | paid | failed
  tx_hash      TEXT,
  error        TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_charges_wallet ON billing_charges(wallet, created_at);

-- Solana: limits the customer chose (enforced by this server; EVM/TRON keep them in the contract)
CREATE TABLE IF NOT EXISTS account_limits (
  wallet          TEXT PRIMARY KEY,
  max_per_charge  TEXT,
  max_per_period  TEXT,
  cancelled       INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS billing_payments (
  tx_hash      TEXT PRIMARY KEY,       -- the customer's transfer-to-treasury transaction (prepaid mode)
  wallet       TEXT NOT NULL,          -- account key "<chain>:<address>"
  amount_units TEXT NOT NULL,          -- base units of the billing token received
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_wallet ON billing_payments(wallet, created_at);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// ---------- migration: single-chain rows ("0xabc...") -> "<chain>:0xabc..." ----------
{
  const legacy = (process.env.NETWORK || '').trim() || config.chains.find((c) => c.family === 'evm')?.key || config.chains[0].key;
  for (const table of ['billing_accounts', 'usage_events', 'billing_charges']) {
    db.prepare(`UPDATE ${table} SET wallet = ? || ':' || wallet WHERE wallet NOT LIKE '%:%'`).run(legacy);
  }
  const old = db.prepare(`SELECT value FROM meta WHERE key = 'billing_discovery_block'`).get();
  if (old) {
    db.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES(?, ?)').run(`billing_discovery:${legacy}`, old.value);
    db.prepare(`DELETE FROM meta WHERE key = 'billing_discovery_block'`).run();
  }
}

export function getMeta(key) {
  return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
}
export function setMeta(key, value) {
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}
