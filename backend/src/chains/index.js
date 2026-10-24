/*
 * One adapter per configured chain, plus a health loop per chain
 * (Telegram alert when a chain's RPC has been down for 5 minutes).
 */
import { config } from '../config.js';
import { db } from '../db.js';
import { notify, esc } from '../notify.js';
import { createEvmAdapter } from './evm.js';

/** Per-customer limits kept by the server (not used on BNB Smart Chain: limits live in the contract). */
export function limitStore(key) {
  const acct = (addr) => `${key}:${addr}`;
  return {
    limits(addr) {
      const r = db.prepare('SELECT * FROM account_limits WHERE wallet = ?').get(acct(addr));
      if (!r) return null;
      const v = (x) => (x === null || x === undefined ? null : BigInt(x));
      return { maxPerCharge: v(r.max_per_charge), maxPerPeriod: v(r.max_per_period), cancelled: !!r.cancelled };
    },
    setLimits(addr, l) {
      const s = (x) => (x === null || x === undefined ? null : x.toString());
      db.prepare(`INSERT INTO account_limits(wallet, max_per_charge, max_per_period, cancelled, updated_at) VALUES(?, ?, ?, ?, ?)
                  ON CONFLICT(wallet) DO UPDATE SET max_per_charge = excluded.max_per_charge, max_per_period = excluded.max_per_period,
                  cancelled = excluded.cancelled, updated_at = excluded.updated_at`)
        .run(acct(addr), s(l?.maxPerCharge), s(l?.maxPerPeriod), l?.cancelled ? 1 : 0, Date.now());
    },
    spentSince(addr, since, exclude = null) {
      return db.prepare(`SELECT amount_units FROM billing_charges WHERE wallet = ? AND created_at >= ? AND status IN ('paid','sent','pending') AND id IS NOT ?`)
        .all(acct(addr), since, exclude).reduce((t, r) => t + BigInt(r.amount_units), 0n);
    },
  };
}

export const adapters = config.chains.map((c) => {
  // BNB Smart Chain edition: EVM only (bsc, plus bsc-testnet / local for testing)
  if (c.family !== 'evm') throw new Error(`${c.key}: this edition runs on BNB Smart Chain only.`);
  const a = createEvmAdapter(c);
  a.unlimitedAt = a.unlimitedAt || 2n ** 120n;
  a.status = { ok: null, lastBlock: null, error: null };
  return a;
});
export const getAdapter = (key) => adapters.find((a) => a.key === key) || null;

async function check(a) {
  try {
    a.status.lastBlock = await a.head();
    a.status.ok = true; a.status.error = null;
  } catch (e) {
    a.status.ok = false;
    a.status.error = e.hint || a.rpcHint(e);
    console.error(`[${a.key}] can't reach the network: ${e.shortMessage || e.message}. ${a.status.error}`);
  }
  const s = a.status;
  if (s.ok === false) {
    s.downSince = s.downSince || Date.now();
    if (!s.alerted && Date.now() - s.downSince > 5 * 60e3) {
      s.alerted = true;
      notify('health', ['🔌 <b>Network not connected</b>', `${esc(a.name)}: billing can't read the chain or send charges.`, esc(s.error || '')]);
    }
  } else {
    if (s.alerted) notify('health', ['✅ <b>Network back online</b>', esc(a.name)]);
    s.downSince = null; s.alerted = false;
  }
}

export function startHealth() {
  for (const a of adapters) { check(a); setInterval(() => check(a), 30e3); }
}
