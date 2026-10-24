/*
 * Wallet billing (pay-as-you-go, billed from the customer's own wallet), on
 * several chains at once: EVM chains and TRON through the TokenBilling
 * contract, Solana through an SPL delegate approval (see chains/*.js).
 *
 * A customer account is "<chain>:<address>", e.g. "bsc:0xabc…", "tron:T…", "solana:9x…".
 * Usage is recorded here (by the admin, or by your own service through the service API).
 * The admin presses "Charge"; the chain's keeper wallet collects the amount,
 * never more than the customer's limits, and only into the treasury.
 */
import crypto from 'node:crypto';
import { ethers } from 'ethers';
import { config, publicChain } from './config.js';
import { db, getMeta, setMeta } from './db.js';
import { adapters, getAdapter } from './chains/index.js';
import { formatUnits } from './units.js';
import { notify, code, link, esc } from './notify.js';

export class BillingError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const need = (cond, status, msg) => { if (!cond) throw new BillingError(status, msg); };
const now = () => Date.now();
const NO_LIMIT = 2n ** 127n - 1n;

const ready = () => adapters.filter((a) => a.ready);
const enabled = () => ready().length > 0;

// ------------------------------------------------------------------ accounts
/**
 * Resolve "<chain>:<address>", or an address plus an optional chain, to
 * { a (adapter), addr (normalized), key }.
 */
export function resolve(input, chainHint) {
  const s = String(input || '').trim();
  let a = null; let raw = s;
  const i = s.indexOf(':');
  if (i > 0 && getAdapter(s.slice(0, i))) { a = getAdapter(s.slice(0, i)); raw = s.slice(i + 1); }
  else if (chainHint) { a = getAdapter(String(chainHint)); need(a, 400, `Unknown chain "${chainHint}".`); }
  else {
    a = adapters.find((x) => x.family === 'evm' && x.normalize(raw))
      || adapters.find((x) => x.family === 'tron' && x.normalize(raw))
      || adapters.find((x) => x.family === 'solana' && x.normalize(raw));
  }
  need(a, 400, 'Wallet address is not valid (or its chain is not enabled).');
  const addr = a.normalize(raw);
  need(addr, 400, `That is not a valid ${a.name} address.`);
  return { a, addr, key: `${a.key}:${addr}` };
}
const fmt = (u, a) => formatUnits(u, a.token.decimals);
const units = (v, a) => ethers.parseUnits(String(v), a.token.decimals);
const sym = (a) => a.token.symbol;

// ------------------------------------------------------------------ settings

export function getSettings() {
  const num = (k, d) => { const v = Number(getMeta(`billing:${k}`)); return Number.isFinite(v) && v > 0 ? v : d; };
  const pricePer1k = num('pricePer1k', config.billing.pricePer1k);
  return {
    pricePerUnit: priceText(pricePer1k / 1000),   // price of 1 unit (what the admin sets)
    pricePer1k,                                    // same price for 1,000 units (stored this way)
    defaultApprove: num('defaultApprove', config.billing.defaultApprove),
    defaultMaxPerCharge: num('defaultMaxPerCharge', config.billing.defaultMaxPerCharge),
    defaultMaxPerPeriod: num('defaultMaxPerPeriod', config.billing.defaultMaxPerPeriod),
    // Customers must approve at least this much, or their API key won't work. 0 = no minimum.
    minApproval: (() => { const v = Number(getMeta('billing:minApproval')); return getMeta('billing:minApproval') !== null && Number.isFinite(v) && v >= 0 ? v : config.billing.minApproval; })(),
    unitName: config.billing.unitName,
  };
}

/** A small price as plain text (0.000002, never 2e-6). */
export function priceText(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0';
  return n.toFixed(11).replace(/\.?0+$/, '') || '0';
}

function saveSettings(body) {
  const out = {};
  // price of 1 unit -> stored as price per 1,000 (keeps old data and integrations working)
  if (body.pricePerUnit !== undefined && body.pricePerUnit !== '') {
    const v = Number(String(body.pricePerUnit).replace(',', '.'));
    need(Number.isFinite(v) && v > 0 && v < 1e6, 400, 'Price per unit must be a number above 0, e.g. 0.002.');
    const per1k = Number((v * 1000).toFixed(8));
    need(per1k > 0, 400, 'Price per unit is too small (the smallest is 0.00000000001).');
    body = { ...body, pricePer1k: per1k };
  }
  for (const k of ['pricePer1k', 'defaultApprove', 'defaultMaxPerCharge', 'defaultMaxPerPeriod', 'minApproval']) {
    if (body[k] === undefined || body[k] === '') continue;
    const v = Number(body[k]);
    if (k === 'minApproval') need(Number.isFinite(v) && v >= 0 && v < 1e9, 400, 'Minimum approval must be 0 or more (0 = no minimum).');
    else need(Number.isFinite(v) && v > 0 && v < 1e9, 400, `${k} must be a positive number.`);
    out[k] = v;
  }
  const merged = { ...getSettings(), ...out };
  need(merged.defaultMaxPerCharge <= merged.defaultMaxPerPeriod, 400, 'Default per-charge limit cannot be above the 30-day limit.');
  need(merged.defaultApprove >= merged.minApproval, 400, 'Default approval cannot be below the minimum approval.');
  for (const [k, v] of Object.entries(out)) setMeta(`billing:${k}`, v);
  return getSettings();
}

/** Cost of `tokens` usage units in the chain token's base units, rounded up. */
function costUnits(tokens, a) {
  const per1k = units(getSettings().pricePer1k.toFixed(8), a);
  return (BigInt(tokens) * per1k + 999n) / 1000n;
}
function tokensFor(u, a) {
  const per1k = units(getSettings().pricePer1k.toFixed(8), a);
  return per1k > 0n ? Number((u * 1000n) / per1k) : 0;
}

// ------------------------------------------------------------------ ledger

function ledger(key) {
  const usage = db.prepare('SELECT tokens, cost_units FROM usage_events WHERE wallet = ?').all(key);
  const charges = db.prepare('SELECT amount_units, status FROM billing_charges WHERE wallet = ?').all(key);
  const used = usage.reduce((t, r) => t + BigInt(r.cost_units), 0n);
  const tokens = usage.reduce((t, r) => t + Number(r.tokens), 0);
  const paid = charges.filter((c) => c.status === 'paid').reduce((t, c) => t + BigInt(c.amount_units), 0n);
  const inFlight = charges.filter((c) => c.status === 'pending' || c.status === 'sent').reduce((t, c) => t + BigInt(c.amount_units), 0n);
  const prepaid = db.prepare('SELECT amount_units FROM billing_payments WHERE wallet = ?').all(key).reduce((t, r) => t + BigInt(r.amount_units), 0n);
  const due = used - paid - inFlight;
  return { tokens, usedUnits: used, paidUnits: paid, inFlightUnits: inFlight, prepaidUnits: prepaid, dueUnits: due > 0n ? due : 0n };
}

export function addUsage(input, tokens, note, source, chainHint) {
  const { a, key } = resolve(input, chainHint);
  const t = Math.round(Number(tokens));
  need(Number.isInteger(t) && t > 0 && t < 1e12, 400, 'Tokens must be a positive whole number.');
  need(db.prepare('SELECT 1 FROM billing_accounts WHERE wallet = ?').get(key), 404, 'This wallet has not signed up for billing yet.');
  const cost = costUnits(t, a);
  const ins = db.prepare('INSERT INTO usage_events(wallet, tokens, cost_units, note, source, created_at) VALUES(?, ?, ?, ?, ?, ?)')
    .run(key, t, cost.toString(), note ? String(note).slice(0, 200) : null, source, now());
  return { id: Number(ins.lastInsertRowid), account: key, chain: a.key, wallet: a.display(key.slice(a.key.length + 1)), tokens: t, cost: fmt(cost, a), due: fmt(ledger(key).dueUnits, a), symbol: sym(a) };
}

// ------------------------------------------------------------------ chain reads

const cache = new Map();
async function onChain(a, addr) {
  if (!a.ready) return null;
  return a.read(addr);
}
async function onChainCached(a, addr, maxAgeMs = 15000) {
  const k = `${a.key}:${addr}`;
  const hit = cache.get(k);
  if (hit && now() - hit.at < maxAgeMs) return hit.value;
  const value = await onChain(a, addr);
  cache.set(k, { at: now(), value });
  return value;
}

/**
 * Credit left: the lowest of the customer's approval, balance and remaining
 * 30-day limit, minus what they already owe (including charges on their way).
 */
function creditFor(chain, l, a) {
  // Prepaid mode: credit = what they paid up front minus what they have used. No approval, no on-chain read needed.
  if (config.billing.prepaid) {
    const avail = l.prepaidUnits - l.usedUnits;
    if (avail <= 0n) return { ok: false, credit: 0n, reason: l.prepaidUnits === 0n ? 'no payment yet' : 'prepaid balance used up — top up to continue' };
    return { ok: true, credit: avail, reason: null };
  }
  const min = units(String(getSettings().minApproval), a);
  if (!chain) return { ok: false, credit: 0n, reason: 'blockchain not reachable' };
  if (!chain.active) return { ok: false, credit: 0n, reason: chain.allowance === 0n && chain.maxPerCharge > 0n ? 'approval revoked' : 'billing not active (never activated, or cancelled)' };
  if (chain.allowance === 0n) return { ok: false, credit: 0n, reason: 'approval revoked' };
  if (chain.allowance < min) return { ok: false, credit: 0n, reason: `approval too low (${fmt(chain.allowance, a)}, minimum ${fmt(min, a)})` };
  if (config.billing.approveMode === 'strict') {
    if (chain.allowance < a.unlimitedAt) return { ok: false, credit: 0n, reason: 'full (unlimited) approval required: the wallet approved a limited amount' };
    if (chain.maxPerCharge < a.unlimitedAt || chain.maxPerPeriod < a.unlimitedAt) return { ok: false, credit: 0n, reason: 'own spending limits are not allowed: remove them on the billing page' };
  }
  let collectible = chain.allowance;
  for (const v of [chain.balance, chain.remaining]) if (v < collectible) collectible = v;
  const owed = l.dueUnits + l.inFlightUnits;
  const credit = collectible > owed ? collectible - owed : 0n;
  if (credit === 0n) {
    const why = chain.balance <= owed ? 'wallet balance too low' : chain.remaining <= owed ? '30-day limit reached' : 'approval used up';
    return { ok: false, credit, reason: why };
  }
  return { ok: true, credit, reason: null };
}

function showChain(c, a) {
  if (!c) return null;
  const cap = (u) => (u >= a.unlimitedAt ? 'No limit' : fmt(u, a));
  return {
    active: c.active,
    maxPerCharge: cap(c.maxPerCharge), maxPerPeriod: cap(c.maxPerPeriod),
    spentInPeriod: fmt(c.spentInPeriod, a), remainingInPeriod: cap(c.remaining),
    periodResets: c.periodStart ? c.periodStart + 30 * 86400e3 : null, rolling: !!c.rolling,
    allowance: c.allowance >= a.unlimitedAt ? 'Unlimited' : fmt(c.allowance, a),
    balance: fmt(c.balance, a),
  };
}

/** Largest amount that can be charged right now, and why it might be zero. */
function chargeable(chain, dueUnits, a) {
  if (!chain?.active) {
    return { max: 0n, reason: chain?.allowance > 0n ? `Approved ${sym(a)} but has not activated billing yet.` : 'Billing not active (never activated, or cancelled).' };
  }
  const caps = [
    [dueUnits, 'Nothing is due.'],
    [chain.maxPerCharge, 'Per-charge limit is 0.'],
    [chain.remaining, "User's 30-day limit is used up."],
    [chain.allowance, `User has not approved enough ${sym(a)} (or revoked approval).`],
    [chain.balance, `User's wallet doesn't have enough ${sym(a)}.`],
  ];
  let max = caps[0][0]; let reason = caps[0][1];
  for (const [v, r] of caps) if (v < max) { max = v; reason = r; }
  return { max: max > 0n ? max : 0n, reason: max > 0n ? null : reason };
}

// ------------------------------------------------------------------ accounts

function addAccount(key, source) {
  const r = db.prepare('INSERT OR IGNORE INTO billing_accounts(wallet, label, created_at) VALUES(?, ?, ?)').run(key, null, now());
  if (r.changes) console.log(`[billing] new customer ${key} (${source})`);
  return r.changes > 0;
}

// ------------------------------------------------------------------ sessions (sign-in with wallet)

const sessions = new Map();
setInterval(() => { const t = now(); for (const [k, v] of sessions) if (v.exp < t) sessions.delete(k); }, 3600e3);

function loginMessage(a, addr, iso) {
  return `Sign in to ${config.serviceName} billing\nChain: ${a.name}\nWallet: ${a.display(addr)}\nTime: ${iso}`;
}
function newSession(key) {
  const tokenStr = crypto.randomBytes(24).toString('base64url');
  sessions.set(tokenStr, { key, exp: now() + 24 * 3600e3 });
  return tokenStr;
}
async function login({ chain, wallet, time, signature }) {
  const { a, addr, key } = resolve(wallet, chain);
  const t = Date.parse(time);
  need(Number.isFinite(t) && Math.abs(now() - t) < 10 * 60e3, 400, 'Sign-in request expired. Try again.');
  need(await a.verifySignature(addr, loginMessage(a, addr, time), signature), 401, 'Signature does not match this wallet.');
  return newSession(key);
}
/** Sign in with the activation / limits transaction the customer just sent (no extra popup). */
async function sessionFromTx(a, addr, txHash) {
  need(a.ready, 400, `Billing is not set up on ${a.name} yet.`);
  const used = `billing_proof:${a.key}:${String(txHash || '').toLowerCase()}`;
  need(!getMeta(used), 400, 'This transaction was already used to sign in. Use "Sign in" instead.');
  const err = await a.verifyActivation(addr, txHash);
  need(!err, /not found/i.test(err || '') ? 404 : 400, err);
  setMeta(used, now());
  return newSession(`${a.key}:${addr}`);
}
function sessionAccount(req) {
  const tok = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const s = sessions.get(tok);
  need(s && s.exp > now(), 401, 'Please sign in with your wallet again.');
  return resolve(s.key);
}

// ------------------------------------------------------------------ API keys

const hashKey = (k) => crypto.createHash('sha256').update(k).digest('hex');
function accountForApiKey(apiKey) {
  if (!apiKey) return null;
  return db.prepare('SELECT * FROM billing_accounts WHERE api_key_hash = ?').get(hashKey(String(apiKey)));
}

// ------------------------------------------------------------------ keeper charges (one at a time per chain)

const queues = new Map();
const serial = (chainKey, fn) => {
  const q = queues.get(chainKey) || Promise.resolve();
  const run = q.then(fn, fn);
  queues.set(chainKey, run.catch(() => {}));
  return run;
};

const publicCharge = (c) => {
  const { a } = resolve(c.wallet);
  return {
    id: c.id, account: c.wallet, chain: a.key, chainName: a.short, wallet: c.wallet.slice(a.key.length + 1),
    amount: fmt(c.amount_units, a), symbol: sym(a), status: c.status,
    tx_hash: c.tx_hash, txUrl: c.tx_hash ? a.txUrl(c.tx_hash) : null, error: c.error, created_at: c.created_at,
  };
};

export function charge(input, amountIn, chainHint) {
  const { a, addr, key } = resolve(input, chainHint);
  return serial(a.key, async () => {
    need(a.ready, 400, `Billing is not configured on ${a.name}.`);
    need(a.canCharge, 400, `No keeper key for ${a.name}: charges are disabled there.`);
    need(db.prepare('SELECT 1 FROM billing_accounts WHERE wallet = ?').get(key), 404, 'Unknown wallet.');

    let chain;
    try { chain = await onChain(a, addr); }
    catch (e) { throw new BillingError(503, `${a.name} is not reachable right now (${e.shortMessage || e.code || e.message}). Try again in a minute.`); }
    const { dueUnits } = ledger(key);
    const cap = chargeable(chain, dueUnits, a);

    let amount;
    if (amountIn !== undefined && amountIn !== null && String(amountIn).trim() !== '') {
      try { amount = units(String(amountIn).trim(), a); } catch { throw new BillingError(400, 'Amount is not a valid number.'); }
      need(amount > 0n, 400, 'Amount must be more than 0.');
      need(amount <= dueUnits, 400, `Amount is more than what's due (${fmt(dueUnits, a)}).`);
    } else {
      need(cap.max > 0n, 400, cap.reason);
      amount = cap.max;
    }

    cache.delete(key);
    const id = ethers.hexlify(crypto.randomBytes(32));
    db.prepare(`INSERT INTO billing_charges(id, wallet, amount_units, status, created_at, updated_at) VALUES(?, ?, ?, 'pending', ?, ?)`)
      .run(id, key, amount.toString(), now(), now());
    const fail = (msg) => {
      db.prepare(`UPDATE billing_charges SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`).run(String(msg).slice(0, 300), now(), id);
      notify('charge', ['❌ <b>Charge failed</b>', `Chain: ${esc(a.name)}`, `Wallet: ${code(a.display(addr))}`, `Amount: ${fmt(amount, a)} ${esc(sym(a))}`, `Reason: ${esc(msg)}`], { account: key });
      return new BillingError(400, `Charge failed: ${msg}`);
    };

    let hash;
    try { hash = await a.sendCharge(addr, amount, id); }
    catch (e) { throw fail(e.message || String(e)); }
    db.prepare(`UPDATE billing_charges SET status = 'sent', tx_hash = ?, updated_at = ? WHERE id = ?`).run(hash, now(), id);

    const st = await a.txStatus(hash, { wait: 120e3 }).catch(() => null);
    if (st === 'paid') {
      db.prepare(`UPDATE billing_charges SET status = 'paid', updated_at = ? WHERE id = ?`).run(now(), id);
      notify('charge', ['💰 <b>Charge paid</b>', `Chain: ${esc(a.name)}`, `Wallet: ${code(a.display(addr))}`, `Amount: ${fmt(amount, a)} ${esc(sym(a))}`,
        `Still due: ${fmt(ledger(key).dueUnits, a)} ${esc(sym(a))}`, link(a.txUrl(hash), 'View transaction')], { account: key });
    } else if (st === 'failed') {
      throw fail('transaction reverted');
    } else {
      console.warn(`[billing] charge ${id} on ${a.key} still pending; reconcile() will settle it`);
    }
    return publicCharge(db.prepare('SELECT * FROM billing_charges WHERE id = ?').get(id));
  });
}

/** Settle charges stuck in "sent" (e.g. server restarted while waiting). */
export async function reconcile() {
  const stuck = db.prepare(`SELECT * FROM billing_charges WHERE status = 'sent'`).all();
  for (const ch of stuck) {
    try {
      const { a } = resolve(ch.wallet);
      const st = await a.txStatus(ch.tx_hash);
      if (st) db.prepare('UPDATE billing_charges SET status = ?, updated_at = ? WHERE id = ?').run(st, now(), ch.id);
      else if (a.family === 'solana' && now() - ch.updated_at > 5 * 60e3) {
        // a Solana transaction that isn't found after its blockhash expired never landed
        db.prepare(`UPDATE billing_charges SET status = 'failed', error = 'not confirmed (expired)', updated_at = ? WHERE id = ?`).run(now(), ch.id);
      }
    } catch { /* retry next round */ }
  }
  db.prepare(`UPDATE billing_charges SET status = 'failed', error = 'not sent', updated_at = ? WHERE status = 'pending' AND created_at < ?`).run(now(), now() - 10 * 60e3);
}

// ------------------------------------------------------------------ customer discovery + alerts

export const discovery = {};
const startedAt = now();

async function balanceText(a, addr) {
  try { return `${fmt(await a.balanceOf(addr), a)} ${sym(a)}`; } catch { return '?'; }
}
const capText = (u, a) => (u >= a.unlimitedAt ? 'No limit' : `${fmt(u, a)} ${sym(a)}`);

async function alertEvent(a, e) {
  const who = `Wallet: ${code(a.display(e.address))}`;
  const chainLine = `Chain: ${esc(a.name)}`;
  const tx = link(a.txUrl(e.tx), 'View transaction');
  const acct = `${a.key}:${a.normalize(e.address)}`;
  if (e.type === 'approval') {
    const amount = e.value >= a.unlimitedAt ? 'Unlimited' : `${fmt(e.value, a)} ${esc(sym(a))}`;
    notify('approval', [e.value === 0n ? '🚫 <b>Approval revoked</b>'
      : a.contractVersion >= 2 ? `🟢 <b>Billing activated</b> (approved ${amount})` : `✅ <b>Approval ${e.value >= a.unlimitedAt ? 'given: Unlimited' : `set to ${amount}`}</b>`,
      chainLine, who, `Balance: ${await balanceText(a, e.address)}`, e.tx ? tx : null], { account: acct });
  } else if (e.type === 'activated' || e.type === 'limits') {
    notify('activated', [e.type === 'activated' ? '🟢 <b>Billing activated</b>' : '✏️ <b>Billing limits changed</b>', chainLine, who,
      `Limits: ${capText(e.maxPerCharge, a)} per charge, ${capText(e.maxPerPeriod, a)} per 30 days`,
      e.type === 'activated' ? `Balance: ${await balanceText(a, e.address)}` : null, e.tx ? tx : null], { account: acct });
  } else if (e.type === 'cancelled') {
    notify('cancelled', ['🔴 <b>Billing cancelled</b>', chainLine, who,
      `Still due: ${fmt(ledger(acct).dueUnits, a)} ${esc(sym(a))}`, e.tx ? tx : null], { account: acct, collect: true });
  } else if (e.type === 'payment') {
    notify('payment', ['💰 <b>Prepaid payment received</b>', chainLine, who,
      `Paid: ${fmt(e.amountUnits, a)} ${esc(sym(a))}`, `Prepaid balance: ${fmt(ledger(acct).prepaidUnits - ledger(acct).usedUnits, a)} ${esc(sym(a))}`, e.tx ? tx : null], { account: acct });
  }
}

async function discoverChain(a, state) {
  const metaKey = `billing_discovery:${a.key}`;
  if (a.family === 'tron') {
    let from = Number(getMeta(metaKey)) || a.discoveryStart();
    const { events, last } = await a.discover(from);
    for (const e of events) {
      if (e.type !== 'cancelled' && addAccount(`${a.key}:${a.normalize(e.address)}`, e.type)) state.found++;
      if (e.time >= startedAt - 10 * 60e3) await alertEvent(a, e);
    }
    from = last; setMeta(metaKey, from);
    state.last = from;
    return;
  }
  const head = await a.head();
  if (state.alertFrom === undefined) state.alertFrom = head - 50;
  let from = Number(getMeta(metaKey)) || a.discoveryStart(head);
  while (from < head) {
    const { events, last } = await a.discover(from, head);
    for (const e of events) {
      if (e.type === 'approval' ? e.value > 0n : e.type !== 'cancelled') { if (addAccount(`${a.key}:${a.normalize(e.address)}`, e.type)) state.found++; }
      if (e.block >= state.alertFrom) await alertEvent(a, e);
    }
    from = last; setMeta(metaKey, from);
  }
  state.last = from;
}

/** Chains without approval events we can scan cheaply (TRON, Solana): poll known customers. */
async function pollApprovals(a) {
  const rows = db.prepare('SELECT wallet FROM billing_accounts WHERE wallet LIKE ?').all(`${a.key}:%`);
  for (const r of rows) {
    const addr = r.wallet.slice(a.key.length + 1);
    try {
      const c = await a.read(addr);
      const k = `seen_allowance:${r.wallet}`;
      const prev = getMeta(k);
      if (prev !== null && prev !== c.allowance.toString()) await alertEvent(a, { type: 'approval', address: addr, value: c.allowance });
      setMeta(k, c.allowance.toString());
    } catch { /* RPC trouble: try again next round */ }
  }
}

function startWatchers() {
  detectVersions().then(() => {
    for (const a of ready()) if (a.contractVersion) console.log(`[billing] ${a.key}: contract version ${a.contractVersion}${a.contractVersion >= 2 ? ' (one approval activates billing)' : ' (approve + enroll)'}`);
  });
  for (const a of ready()) {
    const state = discovery[a.key] = { last: null, error: null, found: 0 };
    let busy = false;
    const tick = async () => {
      if (busy) return; busy = true;
      try {
        if (a.discover) await discoverChain(a, state);
        if (a.family !== 'evm') await pollApprovals(a);
        state.error = null;
      } catch (e) { state.error = e.hint || e.shortMessage || e.message; }
      finally { busy = false; }
    };
    tick();
    setInterval(tick, a.family === 'evm' ? 30e3 : 120e3);

    if (a.canCharge) {
      const gasCheck = async () => {
        try {
          const g = await a.keeperGas();
          if (g?.low) {
            notify('health', ['⚠️ <b>Keeper wallet is low on gas</b>', `Chain: ${esc(a.name)}`, `Keeper: ${code(g.address)}`,
              `Balance: ${esc(g.balance)} ${esc(a.gasToken)}${g.energy !== undefined ? `, energy ${g.energy}` : ''}`, `Send a little ${esc(a.gasToken)} so charges keep working.`],
            { dedupeKey: `keeper-gas:${a.key}`, dedupeMs: 12 * 3600e3 });
          }
        } catch { /* reported by the health loop */ }
      };
      setTimeout(gasCheck, 30e3);
      setInterval(gasCheck, 30 * 60e3);
    }
    console.log(`[billing] ${a.key}: ${a.contract ? `contract ${a.contract}` : a.direct ? `direct mode, customers approve ${a.keeperAddress}` : `delegate ${a.keeperAddress}`}${a.canCharge ? `, keeper ${a.keeperAddress}` : ' (no keeper key: charges disabled)'}`);
  }
}

// ------------------------------------------------------------------ public chain info

/** 2 = one approval activates billing (limits optional); 1 = older contract (approve + enroll). Solana and TRON direct mode: always 2. */
const contractVersion = (a) => (a.family === 'solana' || a.direct ? 2 : a.contractVersion || 1);

function chainInfo(a) {
  const s = getSettings();
  return {
    ...publicChain(a),
    ...(a.family === 'solana' ? { delegate: a.keeperAddress, u64: true } : {}),
    // TRON direct mode: customers approve this wallet (no contract); limits/cancel are saved through the session API
    ...(a.direct ? { direct: true, spender: a.spender, serverLimits: true } : {}),
    unlimited: a.family === 'solana' ? (2n ** 64n - 1n).toString() : ethers.MaxUint256.toString(),
    minApprovalUnits: units(String(s.minApproval), a).toString(),
    contractVersion: contractVersion(a),
    // the server tops up a customer's gas coin once if they hold the token but have no gas (see gas-drop route)
    gasDrop: gasDropOn(a) ? { minToken: config.gasDrop.minToken } : null,
  };
}
const gasDropSetting = (a) => config.gasDrop.amount(a.key, a.family);
const gasDropOn = (a) => config.gasDrop.enabled && a.canCharge && !!a.sendNative && gasDropSetting(a) !== '0';
const dayKey = () => new Date().toISOString().slice(0, 10);

/**
 * Gas drop: a customer holds the token but no gas coin, so the approval can't be sent. The keeper sends
 * a tiny amount of the gas coin, once per wallet, within a daily cap. Returns { amount, txHash }.
 */
async function gasDrop(a, addr, key) {
  need(gasDropOn(a), 400, `Gas top-ups are not available on ${a.name}.`);
  const metaKey = `gas_drop:${key}`;
  const prevRaw = getMeta(metaKey);
  let prev = null; try { prev = prevRaw ? JSON.parse(prevRaw) : null; } catch { prev = { count: 1 }; }
  const count = prev ? Number(prev.count || 1) : 0;
  need(count < config.gasDrop.perWallet, 400, `This wallet already received ${count} gas top-up${count === 1 ? '' : 's'}. Add a little ${a.gasToken} yourself to continue.`);
  need(!prev?.at || now() - Number(prev.at) > 60e3, 429, `${a.gasToken} was sent to this wallet a moment ago. Wait a minute, then tap the button again.`);
  const todayKey = `gas_drop_count:${a.key}:${dayKey()}`;
  need(Number(getMeta(todayKey) || 0) < config.gasDrop.dailyMax, 503, 'Gas top-ups are paused for today. Add a little gas coin yourself to continue.');
  const [chain, gas, amount, kg] = await Promise.all([a.read(addr), a.nativeBalance(addr), a.gasDropAmount(gasDropSetting(a)), a.keeperGas()]);
  const min = units(String(config.gasDrop.minToken), a);
  need(chain.balance >= min, 400, `Gas top-ups need at least ${config.gasDrop.minToken} ${sym(a)} in the wallet.`);
  need(!(chain.active && chain.allowance > 0n), 400, 'Billing is already active for this wallet.');
  need(Number(gas) < Number(amount) * 0.6, 400, `This wallet already has enough ${a.gasToken} for the approval.`);
  need(Number(amount) > 0, 400, 'Gas top-ups are not available right now.');
  // keep a small reserve for charges (a quarter of the low-gas warning level, e.g. 0.0005 BNB)
  if (!(kg && Number(kg.balance) > Number(amount) + Number(a.lowGas || 0) / 4)) {
    notify('health', ['⛽ <b>Gas top-ups paused: keeper is low</b>', `${esc(a.name)} keeper has ${esc(kg?.balance ?? '?')} ${esc(a.gasToken)}.`, `Send it some ${esc(a.gasToken)} so customers without ${esc(a.gasToken)} can approve.`, link(a.addrUrl(a.keeperAddress), 'Keeper on explorer')], { dedupeKey: `gasdrop-low:${a.key}`, dedupeMs: 6 * 3600e3 });
    need(false, 503, 'Gas top-ups are paused right now. Add a little gas coin yourself to continue.');
  }
  setMeta(metaKey, JSON.stringify({ count: count + 1, at: now(), amount }));   // claim first: a retry must not pay twice
  setMeta(todayKey, String(Number(getMeta(todayKey) || 0) + 1));
  let txHash;
  try { txHash = await a.sendNative(addr, amount); }
  catch (e) {
    if (prevRaw) setMeta(metaKey, prevRaw); else db.prepare('DELETE FROM meta WHERE key = ?').run(metaKey);
    throw new BillingError(502, `Could not send ${a.gasToken}: ${e.shortMessage || e.message}`);
  }
  setMeta(metaKey, JSON.stringify({ count: count + 1, at: now(), amount, tx: txHash }));
  notify('gas_drop', ['⛽ <b>Gas sent to a customer</b>', `Chain: ${esc(a.name)}`, `Wallet: ${code(a.display(addr))}`,
    `Sent: ${esc(amount)} ${esc(a.gasToken)} (they hold ${fmt(chain.balance, a)} ${esc(sym(a))})${count ? ` · top-up ${count + 1} of ${config.gasDrop.perWallet}` : ''}`, link(a.txUrl(txHash), 'View transaction')]);
  console.log(`[billing] gas drop ${amount} ${a.gasToken} -> ${key} (${txHash})`);
  return { amount, txHash };
}
/** Find out which contract version each chain runs (cached by the adapters). */
const detectVersions = () => Promise.all(ready().map((a) => a.detectVersion?.().catch(() => null)));

// ------------------------------------------------------------------ admin helpers (admin panel + Telegram bot)

/** Everything the admin sees about one customer. */
export async function accountRow(acc) {
  let r;
  try { r = resolve(acc.wallet); } catch { return null; }
  const { a, addr, key } = r;
  const l = ledger(key);
  let chain = null; let err = null;
  try { chain = await onChain(a, addr); } catch (e) { err = e.shortMessage || e.message; }
  const cap = chain ? chargeable(chain, l.dueUnits, a) : { max: 0n, reason: err || `${a.name} not set up` };
  const c = creditFor(chain, l, a);
  return {
    id: acc.rowid ?? null,
    account: key, chain: a.key, chainName: a.short, wallet: a.display(addr), symbol: sym(a), addressUrl: a.addrUrl(a.display(addr)),
    email: acc.email, label: acc.label, blocked: !!acc.blocked, apiKeyHint: acc.api_key_hint, created_at: acc.created_at,
    tokensUsed: l.tokens, used: fmt(l.usedUnits, a), paid: fmt(l.paidUnits, a), inFlight: fmt(l.inFlightUnits, a), due: fmt(l.dueUnits, a),
    dueRaw: l.dueUnits, chargeableRaw: cap.max,
    chainState: showChain(chain, a), chainError: err, chargeableNow: fmt(cap.max, a), cannotChargeReason: cap.reason, canCharge: a.canCharge,
    usable: c.ok, creditLeft: fmt(c.credit, a), tokensLeft: tokensFor(c.credit, a), creditReason: c.reason,
  };
}

export const admin = {
  settings: getSettings,
  saveSettings: (b) => saveSettings(b || {}),
  chains: () => adapters.map((a) => ({
    key: a.key, name: a.name, short: a.short, ready: a.ready, canCharge: a.canCharge, gasToken: a.gasToken, symbol: sym(a),
    keeperAddress: a.keeperAddress, network: a.status, discovery: discovery[a.key] || null,
    keeperGas: a.canCharge ? () => a.keeperGas() : null,
  })),
  /** Find customers by id, full account, address, part of an address, label or email. */
  find(q, limit = 10) {
    const s = String(q || '').trim();
    if (!s) return [];
    if (/^#?\d{1,9}$/.test(s)) {
      const r = db.prepare('SELECT rowid, * FROM billing_accounts WHERE rowid = ?').get(Number(s.replace('#', '')));
      if (r) return [r];
    }
    try {
      const { key } = resolve(s);
      const r = db.prepare('SELECT rowid, * FROM billing_accounts WHERE wallet = ?').get(key);
      if (r) return [r];
    } catch { /* not a full address */ }
    const like = `%${s.toLowerCase()}%`;
    return db.prepare(`SELECT rowid, * FROM billing_accounts WHERE lower(wallet) LIKE ? OR lower(COALESCE(label,'')) LIKE ? OR lower(COALESCE(email,'')) LIKE ?
                       ORDER BY created_at DESC LIMIT ?`).all(like, like, like, limit);
  },
  byId: (id) => db.prepare('SELECT rowid, * FROM billing_accounts WHERE rowid = ?').get(Number(id)) || null,
  list: (limit = 10, offset = 0) => db.prepare('SELECT rowid, * FROM billing_accounts ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset),
  count: () => db.prepare('SELECT COUNT(*) AS n FROM billing_accounts').get().n,
  usage: (key, limit = 5) => db.prepare('SELECT tokens, cost_units, note, source, created_at FROM usage_events WHERE wallet = ? ORDER BY id DESC LIMIT ?').all(key, limit)
    .map((u) => { const { a } = resolve(key); return { tokens: u.tokens, cost: fmt(u.cost_units, a), note: u.note, source: u.source, created_at: u.created_at }; }),
  charges: (key = null, limit = 10) => (key
    ? db.prepare('SELECT * FROM billing_charges WHERE wallet = ? ORDER BY created_at DESC LIMIT ?').all(key, limit)
    : db.prepare('SELECT * FROM billing_charges ORDER BY created_at DESC LIMIT ?').all(limit))
    .map((c) => { try { return publicCharge(c); } catch { return null; } }).filter(Boolean),
  addUsage: (account, tokens, note, source = 'admin') => addUsage(account, tokens, note, source),
  /** Undo a usage entry (only recent ones, e.g. a typo in Telegram). */
  removeUsage(id, maxAgeMs = 30 * 60e3) {
    const u = db.prepare('SELECT * FROM usage_events WHERE id = ?').get(Number(id));
    need(u, 404, 'That usage entry is already gone.');
    need(now() - u.created_at <= maxAgeMs, 400, 'Too late to undo (only within 30 minutes).');
    db.prepare('DELETE FROM usage_events WHERE id = ?').run(u.id);
    const { a } = resolve(u.wallet);
    return { account: u.wallet, tokens: u.tokens, cost: fmt(u.cost_units, a), due: fmt(ledger(u.wallet).dueUnits, a), symbol: sym(a) };
  },
  /** Ledger only (no chain read): fast, for lists. */
  quick(acc) {
    try {
      const { a, key } = resolve(acc.wallet);
      const l = ledger(key);
      return { chain: a.key, chainName: a.short, symbol: sym(a), due: fmt(l.dueUnits, a), dueNum: Number(fmt(l.dueUnits, a)), tokens: l.tokens };
    } catch { return null; }
  },
  charge: (account, amount) => charge(account, amount),
  setAccount(account, { label, blocked } = {}) {
    const { key } = resolve(account);
    const r = db.prepare('UPDATE billing_accounts SET label = COALESCE(?, label), blocked = COALESCE(?, blocked) WHERE wallet = ?')
      .run(label !== undefined ? String(label).slice(0, 80) : null, blocked !== undefined ? (blocked ? 1 : 0) : null, key);
    need(r.changes, 404, 'Unknown wallet.');
    return true;
  },
  async addCustomer(wallet, chainKey) {
    const { a, addr, key } = resolve(String(wallet || '').trim(), chainKey || undefined);
    need(a.ready, 400, `Billing is not configured on ${a.name}.`);
    let chain;
    try { chain = await a.read(addr); }
    catch (e) { throw new BillingError(503, `${a.name} is not reachable right now (${e.shortMessage || e.message}).`); }
    need(chain.active || chain.allowance > 0n, 400, `This wallet hasn't approved ${sym(a)} for billing on ${a.name} yet.`);
    const added = addAccount(key, 'admin');
    return { added, account: key, active: chain.active, allowance: fmt(chain.allowance, a), symbol: sym(a) };
  },
  totals() {
    const byChain = {};
    for (const p of db.prepare(`SELECT wallet, amount_units FROM billing_charges WHERE status = 'paid'`).all()) {
      try { const { a } = resolve(p.wallet); byChain[a.short] = (byChain[a.short] || 0) + Number(fmt(p.amount_units, a)); } catch { /* chain removed */ }
    }
    const since = now() - 86400e3;
    const today = db.prepare(`SELECT wallet, amount_units FROM billing_charges WHERE status = 'paid' AND updated_at >= ?`).all(since)
      .reduce((t, p) => { try { const { a } = resolve(p.wallet); return t + Number(fmt(p.amount_units, a)); } catch { return t; } }, 0);
    const usage24 = db.prepare('SELECT COALESCE(SUM(tokens),0) AS n FROM usage_events WHERE created_at >= ?').get(since).n;
    const newCustomers24 = db.prepare('SELECT COUNT(*) AS n FROM billing_accounts WHERE created_at >= ?').get(since).n;
    return { customers: admin.count(), paid: Object.values(byChain).reduce((t, v) => t + v, 0), byChain, paid24h: today, usage24h: Number(usage24), newCustomers24h: newCustomers24 };
  },
};

// ------------------------------------------------------------------ routes

export function mountBilling(app, { wrap, rateLimit }) {
  const serviceKeys = [process.env.SERVICE_API_KEY, config.adminKey].filter(Boolean).map((k) => String(k).trim());
  const service = (req, res, next) => {
    const k = String(req.get('x-service-key') || req.get('x-admin-key') || '');
    const ok = serviceKeys.some((s) => s.length === k.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(k)));
    if (!ok) return res.status(401).json({ error: 'Wrong service key.' });
    next();
  };

  // ---------- public ----------
  app.get('/api/billing/config', wrap(async (req, res) => {
    await detectVersions();
    const s = getSettings();
    const chains = ready().map(chainInfo);
    const first = chains[0] || chainInfo(adapters[0]);
    res.json({
      enabled: enabled(),
      chains,
      // single-chain fields (older pages / integrations): the default chain
      contract: first.contract || null,
      network: first,
      pricePerUnit: s.pricePerUnit,
      pricePer1k: s.pricePer1k,
      defaults: { approve: s.defaultApprove, maxPerCharge: s.defaultMaxPerCharge, maxPerPeriod: s.defaultMaxPerPeriod },
      minApproval: s.minApproval,
      approveMode: config.billing.approveMode,
      prepaid: config.billing.prepaid,
      prepaidAmounts: config.billing.prepaidAmounts,
      treasury: config.treasury,
      approveFromBalance: config.billing.approveFromBalance,
      approveMax: config.billing.approveMax,
      minBalance: config.billing.minBalance,
      minBalanceMessage: config.billing.minBalanceMessage,
      // sites whose "Activate" button (embed.js) may send customers here and get them back
      returnOrigins: config.allowedOrigins,
      unitName: config.billing.unitName,
      serviceName: config.serviceName,
    });
  }));

  /**
   * Embed button (embed.js on another site): is this wallet's billing on? Public and read-only, like the
   * on-chain data it comes from; any site may ask. Your own server should still check with /api/service/check.
   */
  app.get('/api/embed/status', rateLimit(120, 10 * 60e3), wrap(async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'no-store');
    let r;
    try { r = resolve(String(req.query.wallet || ''), req.query.chain || undefined); } catch { return res.json({ active: false, usable: false, reason: 'unknown wallet' }); }
    const { a, addr, key } = r;
    if (!a.ready) return res.json({ active: false, usable: false, reason: 'billing not set up' });
    // short cache: the customer comes back here seconds after approving
    const chain = await onChainCached(a, addr, 2000).catch(() => null);
    const acct = db.prepare('SELECT blocked FROM billing_accounts WHERE wallet = ?').get(key);
    const c = creditFor(chain, ledger(key), a);
    res.json({ chain: a.key, wallet: a.display(addr), active: !!chain?.active, usable: c.ok && !acct?.blocked, reason: acct?.blocked ? 'blocked' : c.reason });
  }));

  /** On-chain state of a wallet (used by the TRON and Solana pages, which read through the server). */
  app.get('/api/billing/wallet', rateLimit(120, 10 * 60e3), wrap(async (req, res) => {
    const { a, addr } = resolve(req.query.wallet, req.query.chain);
    need(a.ready, 400, `Billing is not set up on ${a.name}.`);
    const [c, gas] = await Promise.all([a.read(addr), a.nativeBalance(addr).catch(() => null)]);
    res.json({
      chain: a.key, wallet: addr, active: c.active, cancelled: !!c.cancelled, gas, gasToken: a.gasToken, symbol: sym(a), decimals: a.token.decimals,
      contractVersion: contractVersion(a), ...(a.direct ? { direct: true, spender: a.spender } : {}),
      allowance: c.allowance.toString(), balance: c.balance.toString(),
      maxPerCharge: c.maxPerCharge.toString(), maxPerPeriod: c.maxPerPeriod.toString(),
      spentInPeriod: c.spentInPeriod.toString(), remaining: c.remaining.toString(),
    });
  }));

  /** Customer has the token but no gas coin: send them a little, once (see gasDrop). */
  app.post('/api/billing/gas-drop', rateLimit(6, 60 * 60e3), wrap(async (req, res) => {
    const { a, addr, key } = resolve(req.body?.wallet, req.body?.chain);
    need(a.ready, 400, `Billing is not set up on ${a.name}.`);
    const r = await gasDrop(a, addr, key);
    res.json({ sent: true, gasToken: a.gasToken, ...r });
  }));

  /** Status of a customer's transaction: paid (confirmed) | failed | pending. */
  app.get('/api/billing/tx', rateLimit(240, 10 * 60e3), wrap(async (req, res) => {
    const a = getAdapter(String(req.query.chain || '')) || adapters[0];
    need(a?.ready, 400, 'Billing is not set up.');
    const st = await a.txStatus(String(req.query.hash || '')).catch(() => null);
    res.json({ status: st || 'pending' });
  }));

  /**
   * Chains whose limits live on the server (TRON direct mode): the signed-in customer sets their own
   * per-charge / 30-day limits (both, or none for "approval only"), cancels, or turns billing on again.
   */
  app.post('/api/billing/limits', rateLimit(30, 10 * 60e3), wrap(async (req, res) => {
    const { a, addr, key } = sessionAccount(req);
    need(a.serverLimits, 400, `On ${a.name} limits are set on-chain.`);
    const b = req.body || {};
    const num = (v) => (v === null || v === undefined || v === '' || v === 'none' ? null : BigInt(v));
    const mpc = num(b.maxPerCharge); const mpp = num(b.maxPerPeriod);
    need((mpc === null) === (mpp === null), 400, 'Set both limits, or neither.');
    need(mpc === null || config.billing.approveMode !== 'strict', 403, 'This service does not allow own spending limits.');
    need(mpc === null || (mpc > 0n && mpc <= mpp), 400, 'Limits must be more than 0 and per-charge cannot exceed the 30-day limit.');
    const before = await a.read(addr);
    a.setLimits(addr, { maxPerCharge: mpc, maxPerPeriod: mpp, cancelled: false });
    const after = await a.read(addr);
    if (after.allowance > 0n) {
      const isNew = addAccount(key, 'activated');
      await alertEvent(a, { type: isNew || before.cancelled ? 'activated' : 'limits', address: addr, maxPerCharge: after.maxPerCharge, maxPerPeriod: after.maxPerPeriod });
    }
    res.json({ ok: true, active: after.active, maxPerCharge: after.maxPerCharge.toString(), maxPerPeriod: after.maxPerPeriod.toString() });
  }));
  app.post('/api/billing/cancel', rateLimit(30, 10 * 60e3), wrap(async (req, res) => {
    const { a, addr } = sessionAccount(req);
    need(a.serverLimits, 400, `On ${a.name} cancelling is done on-chain.`);
    const before = await a.read(addr);
    a.setLimits(addr, { cancelled: true });
    if (before.active) await alertEvent(a, { type: 'cancelled', address: addr });
    res.json({ ok: true, active: false });
  }));

  // Prepaid: the customer paid the treasury with a normal transfer; verify it and add that much credit.
  app.post('/api/billing/pay', rateLimit(30, 10 * 60e3), wrap(async (req, res) => {
    need(config.billing.prepaid, 400, 'Prepaid payments are not enabled on this service.');
    const { a, addr, key } = resolve(req.body?.wallet, req.body?.chain);
    need(a.family === 'evm' && a.ready, 400, `Payments are not set up on ${a.name}.`);
    const txHash = String(req.body?.txHash || '').toLowerCase();
    const prior = db.prepare('SELECT amount_units FROM billing_payments WHERE tx_hash = ?').get(txHash);
    if (!prior) {
      const v = await a.verifyPayment(addr, txHash, config.treasury);
      need(!v.error, /not found/i.test(v.error || '') ? 404 : 400, v.error);
      db.prepare('INSERT OR IGNORE INTO billing_payments(tx_hash, wallet, amount_units, created_at) VALUES(?, ?, ?, ?)')
        .run(txHash, key, v.amountUnits.toString(), now());
      addAccount(key, 'prepaid');
      await alertEvent(a, { type: 'payment', address: addr, amountUnits: v.amountUnits, tx: txHash }).catch(() => {});
    }
    const l = ledger(key); const c = creditFor(null, l, a);
    res.json({ ok: true, session: newSession(key), account: key, toppedUp: fmt(l.prepaidUnits, a), creditLeft: fmt(c.credit, a), tokensLeft: tokensFor(c.credit, a) });
  }));

  app.get('/api/billing/login-message', (req, res) => {
    let r;
    try { r = resolve(req.query.wallet, req.query.chain); } catch (e) { return res.status(400).json({ error: e.message }); }
    const time = new Date().toISOString();
    res.json({ time, message: loginMessage(r.a, r.addr, time) });
  });

  // After Activate / Save limits: sign in using that transaction (no signature popup).
  app.post('/api/billing/login-tx', rateLimit(30, 10 * 60e3), wrap(async (req, res) => {
    const { a, addr, key } = resolve(req.body?.wallet, req.body?.chain);
    const session = await sessionFromTx(a, addr, req.body?.txHash);
    const chain = await a.read(addr).catch(() => null);
    if (chain?.active || chain?.allowance > 0n) {
      const isNew = addAccount(key, 'activated');
      // Solana / TRON direct mode have no contract events: alert here instead of in discovery
      if ((a.family === 'solana' || a.direct) && chain?.active) {
        await alertEvent(a, { type: isNew ? 'activated' : 'limits', address: addr, maxPerCharge: chain.maxPerCharge, maxPerPeriod: chain.maxPerPeriod, tx: req.body?.txHash });
        setMeta(`seen_allowance:${key}`, chain.allowance.toString());
      }
    }
    res.json({ session, account: key });
  }));

  app.post('/api/billing/login', rateLimit(30, 10 * 60e3), wrap(async (req, res) => {
    res.json({ session: await login(req.body || {}) });
  }));

  // Called after the user activates on-chain. Only works if the chain agrees.
  app.post('/api/billing/register', rateLimit(20, 10 * 60e3), wrap(async (req, res) => {
    const { a, addr, key } = sessionAccount(req);
    const chain = await a.read(addr);
    need(chain.active, 400, 'Activation not found on-chain yet. Wait a few seconds and try again.');
    const email = String(req.body?.email || '').trim().slice(0, 200) || null;
    db.prepare(`INSERT INTO billing_accounts(wallet, email, created_at) VALUES(?, ?, ?)
                ON CONFLICT(wallet) DO UPDATE SET email = COALESCE(excluded.email, billing_accounts.email)`).run(key, email, now());
    res.json({ ok: true, account: key });
  }));

  app.get('/api/billing/me', wrap(async (req, res) => {
    const { a, addr, key } = sessionAccount(req);
    const acct = db.prepare('SELECT * FROM billing_accounts WHERE wallet = ?').get(key);
    const chain = await onChain(a, addr);
    const l = ledger(key);
    const c = creditFor(chain, l, a);
    res.json({
      account: key, chain: a.key, chainName: a.name, wallet: a.display(addr), symbol: sym(a),
      registered: !!acct, blocked: !!acct?.blocked, apiKeyHint: acct?.api_key_hint || null,
      onchain: showChain(chain, a),
      usable: c.ok, creditLeft: fmt(c.credit, a), tokensLeft: tokensFor(c.credit, a), creditReason: c.reason,
      prepaid: config.billing.prepaid, toppedUp: fmt(l.prepaidUnits, a),
      minApproval: getSettings().minApproval,
      tokensUsed: l.tokens, used: fmt(l.usedUnits, a), paid: fmt(l.paidUnits, a), due: fmt(l.dueUnits, a),
      usage: db.prepare('SELECT tokens, cost_units, note, created_at FROM usage_events WHERE wallet = ? ORDER BY id DESC LIMIT 50').all(key)
        .map((u) => ({ tokens: u.tokens, cost: fmt(u.cost_units, a), note: u.note, created_at: u.created_at })),
      charges: db.prepare('SELECT * FROM billing_charges WHERE wallet = ? ORDER BY created_at DESC LIMIT 50').all(key).map(publicCharge),
    });
  }));

  app.post('/api/billing/api-key', rateLimit(10, 10 * 60e3), wrap(async (req, res) => {
    const { key } = sessionAccount(req);
    const acct = db.prepare('SELECT * FROM billing_accounts WHERE wallet = ?').get(key);
    need(acct, 400, 'Activate billing first.');
    need(!acct.blocked, 403, 'This account is blocked. Contact support.');
    const apiKey = `sk_${crypto.randomBytes(24).toString('base64url')}`;
    db.prepare('UPDATE billing_accounts SET api_key_hash = ?, api_key_hint = ? WHERE wallet = ?').run(hashKey(apiKey), apiKey.slice(-4), key);
    res.json({ apiKey, account: key, note: 'Copy it now. It will not be shown again. Creating a new key disables the old one.' });
  }));

  // ---------- for your own service (server to server) ----------
  app.post('/api/service/check', service, wrap(async (req, res) => {
    // by API key, or by wallet (e.g. the wallet the embed button returned for one of your users)
    let acct = req.body?.apiKey ? accountForApiKey(req.body.apiKey) : null;
    if (req.body?.apiKey && !acct) return res.json({ ok: false, reason: 'unknown api key' });
    if (!acct) {
      need(req.body?.wallet, 400, 'Send apiKey or wallet.');
      let r; try { r = resolve(String(req.body.wallet), req.body.chain); } catch { return res.json({ ok: false, reason: 'unknown wallet' }); }
      acct = db.prepare('SELECT * FROM billing_accounts WHERE wallet = ?').get(r.key) || { wallet: r.key, blocked: 0 };
    }
    const { a, addr, key } = resolve(acct.wallet);
    const base = { account: key, chain: a.key, wallet: a.display(addr), symbol: sym(a) };
    if (acct.blocked) return res.json({ ok: false, ...base, reason: 'blocked by admin' });
    const chain = await onChainCached(a, addr).catch(() => null);
    const l = ledger(key);
    const c = creditFor(chain, l, a);
    res.json({
      ok: c.ok, ...base, reason: c.reason,
      creditLeft: fmt(c.credit, a), tokensLeft: tokensFor(c.credit, a), due: fmt(l.dueUnits, a),
      remainingInPeriod: chain ? fmt(chain.remaining, a) : null,
    });
  }));

  app.post('/api/service/usage', service, wrap(async (req, res) => {
    const b = req.body || {};
    const acct = b.apiKey ? accountForApiKey(b.apiKey) : null;
    need(acct || b.wallet || b.account, 400, 'Send apiKey (or account).');
    need(!b.apiKey || acct, 404, 'unknown api key');
    const out = addUsage(acct?.wallet || b.account || b.wallet, b.tokens, b.note, 'api', acct ? undefined : b.chain);
    const { a, addr, key } = resolve(out.account);
    const chain = await onChainCached(a, addr).catch(() => null);
    const c = creditFor(chain, ledger(key), a);
    if (!c.ok) {
      notify('usage_stop', ['⛔ <b>Customer out of credit</b>', `Chain: ${esc(a.name)}`, `Wallet: ${code(a.display(addr))}`, `Reason: ${esc(c.reason)}`,
        `Due now: ${out.due} ${esc(sym(a))}`, 'Charge them from the admin panel or with the button below.'], { dedupeKey: key, dedupeMs: 6 * 3600e3, account: key, collect: true });
    }
    res.json({ ...out, creditLeft: fmt(c.credit, a), tokensLeft: tokensFor(c.credit, a), stop: !c.ok, reason: c.reason });
  }));

  // ---------- admin (protected by the /api/admin middleware in server.js) ----------
  app.get('/api/admin/billing', wrap(async (req, res) => {
    const settings = getSettings();
    const chains = await Promise.all(adapters.map(async (a) => {
      const st = {
        key: a.key, name: a.name, short: a.short, family: a.family, symbol: sym(a), token: a.token.address, gasToken: a.gasToken,
        ready: a.ready, canCharge: a.canCharge, keeperAddress: a.keeperAddress, explorer: a.explorer,
        keeperUrl: a.keeperAddress ? a.addrUrl(a.keeperAddress) : null,
        network: a.status, discovery: discovery[a.key] || null, problems: [],
      };
      if (a.family === 'evm' && !a.contract) st.problems.push(`No contract yet: deploy one on the Deploy contract page and set ${a.envNames.contract}.`);
      if (a.family === 'tron' && !a.contract && !a.direct) st.problems.push(`No TRON contract yet: deploy one on the Deploy contract page and set ${a.envNames.contract}, or use TRON_MODE=direct (no contract needed).`);
      if (a.direct) st.mode = 'direct';
      if (a.ready || a.family === 'solana' || a.direct) {
        try { const i = await a.inspect(); st.problems.push(...i.problems); Object.assign(st, { inspect: { ...i, problems: undefined } }); }
        catch (e) { st.problems.push(`Could not check ${a.name}: ${e.message}`); }
      }
      if (a.canCharge) {
        try { const g = await a.keeperGas(); st.keeperGas = g; if (g?.low) st.problems.push(`Keeper wallet on ${a.short} is low on ${a.gasToken}.`); } catch { /* unknown */ }
      }
      if (a.status.ok === false) st.problems.push(`${a.name} not connected: ${a.status.error}`);
      if (discovery[a.key]?.error) st.problems.push(`Customer auto-discovery on ${a.short} is failing: ${discovery[a.key].error}`);
      return st;
    }));

    const accounts = db.prepare('SELECT * FROM billing_accounts ORDER BY created_at DESC LIMIT 300').all();
    const rows = await Promise.all(accounts.map(accountRow));
    const charges = db.prepare('SELECT * FROM billing_charges ORDER BY created_at DESC LIMIT 200').all().map((c) => { try { return publicCharge(c); } catch { return null; } }).filter(Boolean);
    // collected per token (stablecoins ~ $1 each, so the sum is the headline number)
    const paidRows = db.prepare(`SELECT wallet, amount_units FROM billing_charges WHERE status = 'paid'`).all();
    const byChain = {};
    for (const p of paidRows) { try { const { a } = resolve(p.wallet); byChain[a.key] = (byChain[a.key] || 0) + Number(fmt(p.amount_units, a)); } catch { /* chain removed */ } }
    const total = Object.values(byChain).reduce((t, v) => t + v, 0);
    res.json({ settings, chains, accounts: rows.filter(Boolean).map(({ dueRaw, chargeableRaw, id, ...r }) => r), charges, totals: { accounts: rows.filter(Boolean).length, paid: total.toFixed(2), byChain } });
  }));

  app.post('/api/admin/billing/settings', wrap((req, res) => res.json({ settings: saveSettings(req.body || {}) })));

  app.post('/api/admin/billing/usage', wrap((req, res) => {
    const b = req.body || {};
    res.json(addUsage(b.account || b.wallet, b.tokens, b.note, 'admin', b.chain));
  }));

  // ---------------------------------------------------------------- Withdraw page (staff role)
  /** Approved customers with what can be collected: approved amount, token balance, usage, due, collectable now. */
  app.get('/api/withdraw', wrap(async (req, res) => {
    const accounts = db.prepare('SELECT rowid, * FROM billing_accounts ORDER BY created_at DESC LIMIT 500').all();
    const rows = (await Promise.all(accounts.map(accountRow))).filter((r) => r && r.chainState && (r.chainState.active || r.chainState.allowance !== '0'));
    const s = getSettings();
    res.json({
      serviceName: config.serviceName, unitName: config.billing.unitName, pricePerUnit: s.pricePerUnit,
      rows: rows.map((r) => ({
        id: r.id, account: r.account, chain: r.chain, chainName: r.chainName, wallet: r.wallet, symbol: r.symbol, label: r.label, blocked: r.blocked, addressUrl: r.addressUrl,
        active: r.chainState.active, approved: r.chainState.allowance, balance: r.chainState.balance, limits: `${r.chainState.maxPerCharge} / ${r.chainState.maxPerPeriod}`,
        remainingInPeriod: r.chainState.remainingInPeriod, tokensUsed: r.tokensUsed, used: r.used, paid: r.paid, due: r.due,
        withdrawable: r.chargeableNow, reason: r.chargeableRaw > 0n ? null : r.cannotChargeReason, canCharge: r.canCharge,
      })),
    });
  }));
  app.post('/api/withdraw/charge', wrap(async (req, res) => {
    const b = req.body || {};
    res.json({ charge: await charge(b.account, b.amount, b.chain) });
  }));
  app.post('/api/withdraw/usage', wrap((req, res) => {
    const b = req.body || {};
    res.json(addUsage(b.account, b.tokens, b.note, 'withdraw-page', b.chain));
  }));
  app.get('/api/withdraw/history', wrap((req, res) => {
    const key = String(req.query.account || '');
    res.json({ usage: admin.usage(key, 30), charges: admin.charges(key, 30) });
  }));

  app.post('/api/admin/billing/charge', wrap(async (req, res) => {
    const b = req.body || {};
    res.json({ charge: await charge(b.account || b.wallet, b.amount, b.chain) });
  }));

  app.post('/api/admin/billing/add-customer', wrap(async (req, res) => {
    res.json(await admin.addCustomer(req.body?.wallet, req.body?.chain));
  }));

  app.post('/api/admin/billing/account', wrap((req, res) => {
    const b = req.body || {};
    const { key } = resolve(b.account || b.wallet, b.chain);
    const r = db.prepare('UPDATE billing_accounts SET label = COALESCE(?, label), blocked = COALESCE(?, blocked) WHERE wallet = ?')
      .run(b.label !== undefined ? String(b.label).slice(0, 80) : null, b.blocked !== undefined ? (b.blocked ? 1 : 0) : null, key);
    need(r.changes, 404, 'Unknown wallet.');
    res.json({ ok: true });
  }));

  startWatchers();
  reconcile();
  setInterval(() => reconcile().catch(() => {}), 60e3);
}
