/*
 * Telegram admin bot: manage billing from Telegram, not only receive alerts.
 *
 *   /start           menu with buttons
 *   /status          networks, keeper gas, money collected
 *   /customers       customer list (tap one for details and actions)
 *   /find <text>     search by #id, address (or part of it), label or email
 *   /user <text>     one customer's full info
 *   /usage <who> <units> [note]   record usage (the "tokens" they used)
 *   /charge <who> [amount]        charge now (asks you to confirm)
 *   /chargeall       charge everyone who owes and can pay (asks you to confirm)
 *   /block <who>  /unblock <who>  /label <who> <text>
 *   /add <chain> <wallet>         add a customer who approved but isn't listed
 *   /charges         recent charges
 *   /settings        price and defaults;  /set <name> <value> to change one
 *   /id  /cancel  /help
 *
 * Who can use it: the chat set as TELEGRAM_CHAT_ID (admin panel "Telegram alerts"),
 * and any Telegram user ID listed in TELEGRAM_ADMIN_IDS. In a group, only the group's
 * admins (or the listed IDs) can run commands. Everyone else only gets their own ID back.
 *
 * Uses long polling (getUpdates), so it works on any server without a public webhook URL.
 * Turn it off with TELEGRAM_COMMANDS=0 or the switch in the admin panel.
 */
import crypto from 'node:crypto';
import { config } from './config.js';
import { getMeta, setMeta } from './db.js';
import { telegramSettings, tgApi, esc, code, chatRegistry } from './notify.js';
import { admin, accountRow, BillingError } from './billing.js';

const PAGE = 8;
const envAdmins = String(process.env.TELEGRAM_ADMIN_IDS || '').split(/[\s,]+/).filter((x) => /^-?\d+$/.test(x));
// Withdraw-only users: they see approved customers, usage and what is due, and can collect it. Nothing else.
const envWithdrawers = String(process.env.TELEGRAM_WITHDRAW_IDS || '').split(/[\s,]+/).filter((x) => /^-?\d+$/.test(x));

export function botSettings() {
  const env = String(process.env.TELEGRAM_COMMANDS ?? '').trim();
  const stored = getMeta('telegram:commands');
  return {
    commands: env === '0' ? false : env === '1' ? true : stored !== '0',
    commandsFromEnv: env === '0' || env === '1',
    adminIds: [...new Set([...envAdmins, ...String(getMeta('telegram:admins') || '').split(/[\s,]+/).filter((x) => /^-?\d+$/.test(x))])],
    adminIdsFromEnv: envAdmins,
    withdrawIds: [...new Set([...envWithdrawers, ...String(getMeta('telegram:withdrawers') || '').split(/[\s,]+/).filter((x) => /^-?\d+$/.test(x))])],
    withdrawIdsFromEnv: envWithdrawers,
    running: state.running,
    botName: state.botName,
    lastError: state.lastError,
  };
}

export function saveBotSettings(b = {}) {
  if (b.commands !== undefined) setMeta('telegram:commands', b.commands ? '1' : '0');
  if (b.adminIds !== undefined) {
    const ids = String(b.adminIds).split(/[\s,]+/).filter(Boolean);
    for (const id of ids) if (!/^-?\d{3,}$/.test(id)) throw new BillingError(400, `"${id}" is not a Telegram user ID (a number like 123456789).`);
    setMeta('telegram:admins', ids.join(','));
  }
  if (b.withdrawIds !== undefined) {
    const ids = String(b.withdrawIds).split(/[\s,]+/).filter(Boolean);
    for (const id of ids) if (!/^-?\d{3,}$/.test(id)) throw new BillingError(400, `"${id}" is not a Telegram user ID (a number like 123456789).`);
    setMeta('telegram:withdrawers', ids.join(','));
  }
  return botSettings();
}

// ------------------------------------------------------------------ state
const state = { running: false, token: null, offset: 0, botName: null, lastError: null };
const pendingInput = new Map();   // chatId -> { kind, id, exp }
const confirms = new Map();       // token -> { chatId, userId, text, run, exp }
const groupAdmins = new Map();    // `${chat}:${user}` -> { ok, at }
const deniedAt = new Map();

const short = (s, n = 6) => (String(s).length > 2 * n + 1 ? `${String(s).slice(0, n)}…${String(s).slice(-4)}` : String(s));
const money = (v, symb) => `${v} ${esc(symb)}`;
const when = (t) => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '-');
const who = (from) => (from?.username ? `@${from.username}` : [from?.first_name, from?.last_name].filter(Boolean).join(' ') || String(from?.id || '?'));
const kb = (rows) => ({ inline_keyboard: rows.filter((r) => r && r.length) });
const btn = (text, data) => ({ text, callback_data: data });

// ------------------------------------------------------------------ telegram I/O
async function call(method, body, timeoutMs) { return tgApi(state.token, method, body, timeoutMs); }

const screens = new Set();   // messages this bot posted (alerts are not in here, so they are never overwritten)
async function send(chatId, text, markup) {
  const t = String(text).slice(0, 4000);
  try {
    const m = await call('sendMessage', { chat_id: chatId, text: t, parse_mode: 'HTML', disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}) });
    if (m?.message_id) { screens.add(`${chatId}:${m.message_id}`); if (screens.size > 2000) screens.delete(screens.values().next().value); }
    return m;
  } catch (e) { console.warn(`[telegram-bot] send failed: ${e.message}`); return null; }
}
async function edit(msg, text, markup) {
  if (!msg) return null;
  if (!screens.has(`${msg.chat.id}:${msg.message_id}`)) return send(msg.chat.id, text, markup);
  try {
    return await call('editMessageText', { chat_id: msg.chat.id, message_id: msg.message_id, text: String(text).slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}) });
  } catch (e) {
    if (/not modified/i.test(e.message)) return null;
    return send(msg.chat.id, text, markup);
  }
}

// ------------------------------------------------------------------ access control
/** 'admin' (everything), 'withdraw' (collect only), or false. */
async function isAllowed(chat, from) {
  const s = telegramSettings();
  const b = botSettings();
  const uid = String(from?.id ?? '');
  if (b.adminIds.includes(uid)) return 'admin';
  if (b.withdrawIds.includes(uid)) return 'withdraw';
  if (!s.chatId || String(chat.id) !== String(s.chatId)) return false;
  if (chat.type === 'private') return 'admin';
  if (chat.type === 'channel') return false;
  // group: only the group's admins
  const k = `${chat.id}:${uid}`;
  const hit = groupAdmins.get(k);
  if (hit && Date.now() - hit.at < 10 * 60e3) return hit.ok;
  let ok = false;
  try { const m = await call('getChatMember', { chat_id: chat.id, user_id: from.id }); ok = ['creator', 'administrator'].includes(m.status); } catch { ok = false; }
  groupAdmins.set(k, { ok, at: Date.now() });
  return ok ? 'admin' : false;
}

// ------------------------------------------------------------------ views
async function statusText() {
  const t = admin.totals();
  const lines = [`📊 <b>${esc(config.serviceName)}: status</b>`, ''];
  for (const c of admin.chains()) {
    let gas = '';
    if (c.keeperGas) {
      try { const g = await Promise.race([c.keeperGas(), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 8000))]); gas = ` · keeper ${esc(Number(g.balance).toFixed(4).replace(/\.?0+$/, ''))} ${esc(c.gasToken)}${g.low ? ' ⚠️ low' : ''}`; }
      catch { gas = ' · keeper gas: ?'; }
    }
    const net = c.network?.ok === false ? '🔴 not connected' : c.network?.ok ? '🟢' : '⚪';
    const setup = !c.ready ? ' · not set up' : !c.canCharge ? ' · no keeper key (charges off)' : '';
    lines.push(`${net} <b>${esc(c.name)}</b> (${esc(c.symbol)})${setup}${gas}`);
    if (c.discovery?.error) lines.push(`   ⚠️ discovery: ${esc(c.discovery.error)}`);
    if (c.network?.ok === false && c.network.error) lines.push(`   ${esc(c.network.error)}`);
  }
  lines.push('', `👥 Customers: <b>${t.customers}</b> (${t.newCustomers24h} new in 24h)`,
    `🧮 Usage in 24h: <b>${t.usage24h.toLocaleString('en-US')}</b> ${esc(config.billing.unitName)}`,
    `💰 Collected: <b>${t.paid.toFixed(2)}</b> total, ${t.paid24h.toFixed(2)} in 24h`);
  const by = Object.entries(t.byChain).map(([k, v]) => `${esc(k)} ${v.toFixed(2)}`).join(' · ');
  if (by) lines.push(`   ${by}`);
  return lines.join('\n');
}

function accountButtonLabel(acc) {
  const [chainKey, ...rest] = acc.wallet.split(':');
  const addr = rest.join(':');
  return `#${acc.rowid} ${chainKey} ${short(addr)}${acc.label ? ` · ${acc.label.slice(0, 18)}` : ''}${acc.blocked ? ' 🚫' : ''}`;
}

async function listView(offset = 0) {
  const total = admin.count();
  if (!total) return { text: '👥 No customers yet. They appear here after they activate billing (or use /add).', markup: kb([[btn('⬅️ Menu', 'm')]]) };
  const rows = admin.list(PAGE, offset);
  const nav = [];
  if (offset > 0) nav.push(btn('◀️ Prev', `l:${Math.max(0, offset - PAGE)}`));
  if (offset + PAGE < total) nav.push(btn('Next ▶️', `l:${offset + PAGE}`));
  return {
    text: `👥 <b>Customers</b> ${offset + 1}-${Math.min(total, offset + PAGE)} of ${total}\nTap one for details, usage and charging.`,
    markup: kb([...rows.map((r) => [btn(accountButtonLabel(r), `u:${r.rowid}`)]), nav, [btn('🔎 Find', 'f'), btn('💰 Charge all', 'ca'), btn('⬅️ Menu', 'm')]]),
  };
}

/** Withdraw role: approved customers with approved amount, balance and what is due. */
async function withdrawView(offset = 0) {
  const accounts = admin.list(500, 0);
  const rows = (await Promise.all(accounts.map(accountRow))).filter((r) => r && r.chainState && (r.chainState.active || r.chainState.allowance !== '0'));
  if (!rows.length) return { text: '💳 No approved customers yet.', markup: kb([[btn('🔄 Refresh', 'w:0')]]) };
  const page = rows.slice(offset, offset + PAGE);
  const lines = [`💳 <b>Withdraw</b> · approved customers ${offset + 1}-${Math.min(rows.length, offset + PAGE)} of ${rows.length}`, ''];
  for (const r of page) {
    const c = r.chainState;
    lines.push(`<b>#${r.id}</b> ${esc(r.chainName)} ${code(short(r.wallet))}${r.label ? ` · ${esc(r.label)}` : ''}${c.active ? '' : ' · ❌ not active'}`,
      `   approved ${esc(c.allowance)}${c.allowance === 'Unlimited' ? '' : ` ${esc(r.symbol)}`} · balance ${money(c.balance, r.symbol)}`,
      `   used ${r.tokensUsed.toLocaleString('en-US')} ${esc(config.billing.unitName)} · due <b>${money(r.due, r.symbol)}</b> · can withdraw <b>${money(r.chargeableNow, r.symbol)}</b>`);
  }
  const nav = [];
  if (offset > 0) nav.push(btn('◀️ Prev', `w:${Math.max(0, offset - PAGE)}`));
  if (offset + PAGE < rows.length) nav.push(btn('Next ▶️', `w:${offset + PAGE}`));
  return {
    text: lines.join('\n'),
    markup: kb([...page.map((r) => [btn(`#${r.id} ${short(r.wallet)} · withdraw ${r.chargeableNow} ${r.symbol}`, `u:${r.id}`)]), nav, [btn('🔄 Refresh', `w:${offset}`)]]),
  };
}
const withdrawMenu = () => kb([[btn('💳 Approved customers', 'w:0')]]);

async function userView(id, role = 'admin') {
  const acc = admin.byId(id);
  if (!acc) return { text: `No customer #${esc(id)}.`, markup: kb([[btn('👥 Customers', 'l:0')]]) };
  const r = await accountRow(acc);
  if (!r) return { text: `Customer #${esc(id)} is on a chain that is no longer enabled (${esc(acc.wallet)}).`, markup: kb([[btn('👥 Customers', 'l:0')]]) };
  const c = r.chainState;
  const lines = [
    `👤 <b>Customer #${acc.rowid}</b>${r.label ? ` · ${esc(r.label)}` : ''}${r.blocked ? ' · 🚫 BLOCKED' : ''}`,
    `Chain: ${esc(r.chainName)} (${esc(r.symbol)})`,
    `Wallet: ${code(r.wallet)}`,
    r.addressUrl ? `<a href="${esc(r.addressUrl)}">View on explorer</a>` : null,
    r.email ? `Email: ${esc(r.email)}` : null,
    `Joined: ${when(r.created_at)} · API key: ${r.apiKeyHint ? `…${esc(r.apiKeyHint)}` : 'none'}`,
    '',
    '<b>On-chain</b>',
    c ? `Billing: ${c.active ? '✅ active' : '❌ not active'}` : `⚠️ Can't read the chain: ${esc(r.chainError || 'not set up')}`,
    c ? `Approved: ${esc(c.allowance)}${c.allowance === 'Unlimited' ? '' : ` ${esc(r.symbol)}`} · Balance: ${money(c.balance, r.symbol)}` : null,
    c ? `Limits: ${esc(c.maxPerCharge)} per charge · ${esc(c.maxPerPeriod)} per 30 days` : null,
    c ? `Left this period: ${esc(c.remainingInPeriod)} (spent ${esc(c.spentInPeriod)})` : null,
    '',
    '<b>Billing</b>',
    `Used: ${r.tokensUsed.toLocaleString('en-US')} ${esc(config.billing.unitName)} = ${money(r.used, r.symbol)}`,
    `Paid: ${money(r.paid, r.symbol)}${Number(r.inFlight) > 0 ? ` · in progress ${money(r.inFlight, r.symbol)}` : ''}`,
    `Due now: <b>${money(r.due, r.symbol)}</b>`,
    `Can charge now: <b>${money(r.chargeableNow, r.symbol)}</b>${r.cannotChargeReason ? ` (${esc(r.cannotChargeReason)})` : ''}`,
    `Credit left: ${money(r.creditLeft, r.symbol)} ≈ ${r.tokensLeft.toLocaleString('en-US')} ${esc(config.billing.unitName)}${r.usable ? '' : ` · ⛔ ${esc(r.creditReason)}`}`,
  ].filter((x) => x !== null);
  const id2 = acc.rowid;
  if (role === 'withdraw') {
    return {
      text: lines.join('\n'),
      markup: kb([
        [btn('💳 Withdraw max', `c:${id2}`), btn('💵 Withdraw amount', `cm:${id2}`), btn('🧾 History', `h:${id2}`)],
        [btn('🔄 Refresh', `u:${id2}`), btn('💳 Approved customers', 'w:0')],
      ]),
    };
  }
  return {
    text: lines.join('\n'),
    markup: kb([
      [btn('➕ Add usage', `au:${id2}`), btn('💰 Charge max', `c:${id2}`), btn('💵 Charge amount', `cm:${id2}`)],
      [r.blocked ? btn('✅ Unblock', `ub:${id2}`) : btn('🚫 Block', `b:${id2}`), btn('🏷 Label', `lb:${id2}`), btn('🧾 History', `h:${id2}`)],
      [btn('🔄 Refresh', `u:${id2}`), btn('👥 Customers', 'l:0'), btn('⬅️ Menu', 'm')],
    ]),
  };
}

function historyText(acc) {
  const usage = admin.usage(acc.wallet, 10);
  const ch = admin.charges(acc.wallet, 8);
  const L = [`🧾 <b>Customer #${acc.rowid}: history</b>`, '', '<b>Latest usage</b>'];
  if (!usage.length) L.push('none');
  for (const u of usage) L.push(`${when(u.created_at)} · ${u.tokens.toLocaleString('en-US')} = ${esc(u.cost)} · ${esc(u.source)}${u.note ? ` · ${esc(u.note)}` : ''}`);
  L.push('', '<b>Latest charges</b>');
  if (!ch.length) L.push('none');
  for (const c of ch) L.push(`${when(c.created_at)} · ${esc(c.amount)} ${esc(c.symbol)} · ${statusIcon(c.status)} ${esc(c.status)}${c.txUrl ? ` · <a href="${esc(c.txUrl)}">tx</a>` : ''}${c.error ? ` · ${esc(c.error)}` : ''}`);
  return L.join('\n');
}
const statusIcon = (s) => ({ paid: '✅', failed: '❌', sent: '⏳', pending: '⏳' }[s] || '');

function chargesText() {
  const ch = admin.charges(null, 15);
  const L = ['💸 <b>Recent charges</b>', ''];
  if (!ch.length) L.push('No charges yet.');
  for (const c of ch) L.push(`${statusIcon(c.status)} ${when(c.created_at)} · ${esc(c.chainName)} ${code(short(c.wallet))} · ${esc(c.amount)} ${esc(c.symbol)}${c.txUrl ? ` · <a href="${esc(c.txUrl)}">tx</a>` : ''}${c.error ? `\n    ${esc(c.error)}` : ''}`);
  return L.join('\n');
}

const SETTING_NAMES = { price: 'pricePerUnit', price1k: 'pricePer1k', approve: 'defaultApprove', percharge: 'defaultMaxPerCharge', per30: 'defaultMaxPerPeriod', minapproval: 'minApproval' };
function settingsText() {
  const s = admin.settings();
  return [
    '⚙️ <b>Billing settings</b>', '',
    `price: <b>${s.pricePerUnit}</b> per 1 ${esc(s.unitName.replace(/s$/, ''))} (= ${s.pricePer1k} per 1,000)`,
    `approve (default approval): ${s.defaultApprove}`,
    `percharge (default per-charge limit): ${s.defaultMaxPerCharge}`,
    `per30 (default 30-day limit): ${s.defaultMaxPerPeriod}`,
    `minapproval (API keys stop below this): ${s.minApproval}`,
    '', 'Change one: <code>/set price 0.002</code> (price of 1 unit)',
  ].join('\n');
}

const HELP = [
  '🤖 <b>Billing bot</b>',
  '',
  '<b>Look</b>',
  '/status: networks, keeper gas, money collected',
  '/customers: list (tap for details)',
  '/find text: search by #id, address, label, email',
  '/user who: one customer',
  '/charges: recent charges',
  '/settings: price and defaults',
  '',
  '<b>Do</b>',
  '/usage who units [note]: add usage',
  '/charge who [amount]: charge (asks to confirm)',
  '/chargeall: charge everyone who owes',
  '/block who, /unblock who, /label who text',
  '/add chain wallet: add a customer',
  '/set name value: change a setting (e.g. /set price 0.002)',
  '/cancel: stop the current question',
  '',
  '"who" = #id (e.g. <code>#12</code>), wallet address, part of it, label or email.',
].join('\n');

const menu = () => kb([
  [btn('📊 Status', 's'), btn('👥 Customers', 'l:0')],
  [btn('🔎 Find', 'f'), btn('💸 Charges', 'ch'), btn('💰 Charge all', 'ca')],
  [btn('⚙️ Settings', 'st'), btn('➕ Add customer', 'ac'), btn('❓ Help', 'hp')],
]);

// ------------------------------------------------------------------ actions
function ask(chatId, kind, id, prompt) {
  pendingInput.set(String(chatId), { kind, id, exp: Date.now() + 10 * 60e3 });
  return send(chatId, `${prompt}\n\n<i>Send /cancel to stop.</i>`, { force_reply: true, input_field_placeholder: 'Type here' });
}

function confirm(chatId, userId, text, run) {
  const t = crypto.randomBytes(6).toString('hex');
  confirms.set(t, { chatId: String(chatId), userId: String(userId), run, exp: Date.now() + 5 * 60e3 });
  for (const [k, v] of confirms) if (v.exp < Date.now()) confirms.delete(k);
  return send(chatId, text, kb([[btn('✅ Yes, do it', `y:${t}`), btn('✖️ No', `n:${t}`)]]));
}

/** "#12", address, part of an address, label… -> exactly one account, or a reply that asks which. */
async function pick(chatId, q, then) {
  const found = admin.find(q, 8);
  if (!found.length) { await send(chatId, `No customer matches "${esc(q)}".`); return null; }
  if (found.length > 1) {
    await send(chatId, `Several customers match "${esc(q)}". Which one?`, kb(found.map((r) => [btn(accountButtonLabel(r), `${then}:${r.rowid}`)])));
    return null;
  }
  return found[0];
}

async function doUsage(chatId, from, acc, units, note) {
  const n = Number(String(units).replace(/[, _]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return send(chatId, 'Units must be a positive number, e.g. <code>1500</code>.');
  const r = admin.addUsage(acc.wallet, n, note || `via Telegram by ${who(from)}`, 'telegram');
  console.log(`[telegram-bot] ${who(from)} (${from.id}) added ${r.tokens} usage to ${acc.wallet}`);
  return send(chatId, `✅ Added <b>${r.tokens.toLocaleString('en-US')}</b> ${esc(config.billing.unitName)} to #${acc.rowid} (${money(r.cost, r.symbol)}).\nDue now: <b>${money(r.due, r.symbol)}</b>`,
    kb([[btn('💰 Charge now', `c:${acc.rowid}`), btn('👤 Open customer', `u:${acc.rowid}`)]]));
}

async function askCharge(chatId, from, acc, amount) {
  const r = await accountRow(acc);
  if (!r) return send(chatId, 'That customer\'s chain is not enabled.');
  if (!r.canCharge) return send(chatId, `Charging is off on ${esc(r.chainName)} (no keeper key on the server).`);
  let amt = amount;
  if (amt === undefined || amt === null || amt === '') {
    if (r.chargeableRaw <= 0n) return send(chatId, `Nothing can be charged from #${acc.rowid} now: ${esc(r.cannotChargeReason || 'nothing due')}.`);
    amt = r.chargeableNow;
  } else if (!(Number(amt) > 0)) return send(chatId, 'Amount must be more than 0.');
  return confirm(chatId, from.id,
    `💰 <b>Charge ${money(esc(amt), r.symbol)}</b> from customer #${acc.rowid}?\n${esc(r.chainName)} ${code(r.wallet)}${r.label ? ` (${esc(r.label)})` : ''}\nDue: ${money(r.due, r.symbol)} · can charge now: ${money(r.chargeableNow, r.symbol)}`,
    async () => {
      await send(chatId, `⏳ Charging #${acc.rowid}… (up to 2 minutes)`);
      console.log(`[telegram-bot] ${who(from)} (${from.id}) charges ${amt} from ${acc.wallet}`);
      const c = await admin.charge(acc.wallet, amount === undefined || amount === null || amount === '' ? undefined : String(amount));
      return send(chatId, c.status === 'paid'
        ? `✅ Paid: <b>${money(esc(c.amount), c.symbol)}</b> from #${acc.rowid}${c.txUrl ? `\n<a href="${esc(c.txUrl)}">View transaction</a>` : ''}`
        : `⏳ Sent, still confirming (${esc(c.status)}). Check /charges in a minute.${c.txUrl ? `\n<a href="${esc(c.txUrl)}">View transaction</a>` : ''}`,
      kb([[btn('👤 Open customer', `u:${acc.rowid}`)]]));
    });
}

async function askChargeAll(chatId, from) {
  const accounts = admin.list(1000, 0);
  const rows = (await Promise.all(accounts.map(accountRow))).filter((r) => r && r.canCharge && r.chargeableRaw > 0n);
  if (!rows.length) return send(chatId, 'Nobody can be charged right now (nothing due, or limits/approval/balance are 0).');
  const sums = {};
  for (const r of rows) sums[r.symbol] = (sums[r.symbol] || 0) + Number(r.chargeableNow);
  const list = rows.slice(0, 25).map((r) => `#${r.id} ${esc(r.chainName)} ${code(short(r.wallet))}: ${money(r.chargeableNow, r.symbol)}`);
  if (rows.length > 25) list.push(`…and ${rows.length - 25} more`);
  return confirm(chatId, from.id,
    [`💰 <b>Charge ${rows.length} customer(s)?</b>`, `Total: ${Object.entries(sums).map(([s, v]) => `${v.toFixed(2)} ${esc(s)}`).join(' + ')}`, '', ...list].join('\n'),
    async () => {
      await send(chatId, `⏳ Charging ${rows.length} customer(s), one by one…`);
      console.log(`[telegram-bot] ${who(from)} (${from.id}) started charge-all for ${rows.length} accounts`);
      let ok = 0; const bad = [];
      for (const r of rows) {
        try { const c = await admin.charge(r.account); if (c.status !== 'failed') ok += 1; else bad.push(`#${r.id}: ${c.error || 'failed'}`); }
        catch (e) { bad.push(`#${r.id}: ${e.message}`); }
      }
      return send(chatId, [`✅ Done: ${ok} charged${bad.length ? `, ${bad.length} failed` : ''}.`, ...bad.slice(0, 15).map(esc)].join('\n'));
    });
}

async function setBlocked(chatId, from, acc, blocked) {
  admin.setAccount(acc.wallet, { blocked });
  console.log(`[telegram-bot] ${who(from)} (${from.id}) ${blocked ? 'blocked' : 'unblocked'} ${acc.wallet}`);
  return send(chatId, `${blocked ? '🚫 Blocked' : '✅ Unblocked'} customer #${acc.rowid}. ${blocked ? 'Their API key stops working now.' : 'Their API key works again.'}`, kb([[btn('👤 Open customer', `u:${acc.rowid}`)]]));
}

async function addCustomer(chatId, text) {
  const parts = String(text).trim().split(/\s+/);
  const [chainKey, wallet] = parts.length >= 2 ? parts : [null, parts[0]];
  const r = await admin.addCustomer(wallet, chainKey);
  const acc = admin.find(r.account, 1)[0];
  return send(chatId, `${r.added ? '✅ Added' : 'ℹ️ Already listed:'} ${code(r.account)}\nActive: ${r.active ? 'yes' : 'no'} · approved ${esc(r.allowance)} ${esc(r.symbol)}`,
    acc ? kb([[btn('👤 Open customer', `u:${acc.rowid}`)]]) : undefined);
}

async function setSetting(chatId, from, name, value) {
  const k = SETTING_NAMES[String(name || '').toLowerCase()];
  if (!k) return send(chatId, `Unknown setting. Use one of: ${Object.keys(SETTING_NAMES).join(', ')}.`);
  admin.saveSettings({ [k]: value });
  console.log(`[telegram-bot] ${who(from)} (${from.id}) set ${k}=${value}`);
  return send(chatId, `✅ Saved.\n\n${settingsText()}`);
}

// ------------------------------------------------------------------ handlers
async function onText(msg, role = 'admin') {
  const chatId = msg.chat.id;
  const from = msg.from || {};
  const text = String(msg.text || '').trim();
  const m = text.match(/^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  const cmd = m ? m[1].toLowerCase() : null;
  const arg = m ? (m[2] || '').trim() : '';

  if (cmd === 'id') return send(chatId, `Chat ID: ${code(chatId)}\nYour user ID: ${code(from.id)}`);
  if (role === 'withdraw') return onTextWithdraw(msg, cmd, arg);
  if (cmd === 'cancel') { pendingInput.delete(String(chatId)); return send(chatId, 'OK, cancelled.', menu()); }

  // answer to a question the bot asked
  const p = pendingInput.get(String(chatId));
  if (!cmd && p) {
    pendingInput.delete(String(chatId));
    if (p.exp < Date.now()) return send(chatId, 'That question expired. Start again from the menu.', menu());
    const acc = p.id ? admin.byId(p.id) : null;
    if (p.id && !acc) return send(chatId, 'That customer no longer exists.');
    switch (p.kind) {
      case 'usage': {
        const [u, ...note] = text.split(/\s+/);
        return doUsage(chatId, from, acc, u, note.join(' '));
      }
      case 'amount': return askCharge(chatId, from, acc, text.replace(/[^0-9.]/g, ''));
      case 'label':
        admin.setAccount(acc.wallet, { label: text === '-' ? '' : text });
        return send(chatId, `🏷 Label saved for #${acc.rowid}.`, kb([[btn('👤 Open customer', `u:${acc.rowid}`)]]));
      case 'find': {
        const found = admin.find(text, 8);
        if (!found.length) return send(chatId, `No customer matches "${esc(text)}".`, menu());
        if (found.length === 1) { const v = await userView(found[0].rowid); return send(chatId, v.text, v.markup); }
        return send(chatId, `Found ${found.length}:`, kb(found.map((r) => [btn(accountButtonLabel(r), `u:${r.rowid}`)])));
      }
      case 'add': return addCustomer(chatId, text);
      default: return null;
    }
  }

  switch (cmd) {
    case 'start': case 'menu': return send(chatId, `🤖 <b>${esc(config.serviceName)} billing</b>\nWhat do you want to do?`, menu());
    case 'help': return send(chatId, HELP, menu());
    case 'status': return send(chatId, await statusText(), kb([[btn('🔄 Refresh', 's'), btn('⬅️ Menu', 'm')]]));
    case 'customers': case 'users': case 'list': { const v = await listView(0); return send(chatId, v.text, v.markup); }
    case 'charges': return send(chatId, chargesText(), kb([[btn('🔄 Refresh', 'ch'), btn('⬅️ Menu', 'm')]]));
    case 'settings': return send(chatId, settingsText());
    case 'set': {
      const [name, value] = arg.split(/\s+/);
      if (!name || value === undefined) return send(chatId, settingsText());
      return setSetting(chatId, from, name, value);
    }
    case 'price': return arg ? setSetting(chatId, from, 'price', arg) : send(chatId, settingsText());
    case 'find': case 'search': {
      if (!arg) return ask(chatId, 'find', null, '🔎 Send an address (or part of it), #id, label or email.');
      pendingInput.set(String(chatId), { kind: 'find', exp: Date.now() + 60e3 });
      return onText({ ...msg, text: arg });
    }
    case 'user': case 'info': case 'customer': {
      if (!arg) return ask(chatId, 'find', null, '🔎 Which customer? Send an address, #id, label or email.');
      const acc = await pick(chatId, arg, 'u'); if (!acc) return null;
      const v = await userView(acc.rowid); return send(chatId, v.text, v.markup);
    }
    case 'usage': case 'addusage': case 'tokens': {
      const parts = arg.split(/\s+/).filter(Boolean);
      if (parts.length < 2) return send(chatId, 'Use: <code>/usage #12 1500 optional note</code>\n(or open a customer and press ➕ Add usage)');
      const acc = await pick(chatId, parts[0], 'au'); if (!acc) return null;
      return doUsage(chatId, from, acc, parts[1], parts.slice(2).join(' '));
    }
    case 'charge': {
      const parts = arg.split(/\s+/).filter(Boolean);
      if (!parts.length) return send(chatId, 'Use: <code>/charge #12</code> (as much as possible) or <code>/charge #12 5</code>');
      const acc = await pick(chatId, parts[0], 'c'); if (!acc) return null;
      return askCharge(chatId, from, acc, parts[1]);
    }
    case 'chargeall': return askChargeAll(chatId, from);
    case 'block': case 'unblock': {
      if (!arg) return send(chatId, `Use: <code>/${cmd} #12</code>`);
      const acc = await pick(chatId, arg, cmd === 'block' ? 'b' : 'ub'); if (!acc) return null;
      return setBlocked(chatId, from, acc, cmd === 'block');
    }
    case 'label': {
      const [q, ...rest] = arg.split(/\s+/);
      if (!q || !rest.length) return send(chatId, 'Use: <code>/label #12 Acme Ltd</code>');
      const acc = await pick(chatId, q, 'lb'); if (!acc) return null;
      admin.setAccount(acc.wallet, { label: rest.join(' ') });
      return send(chatId, `🏷 Label saved for #${acc.rowid}.`);
    }
    case 'add': case 'addcustomer':
      if (!arg) return ask(chatId, 'add', null, `➕ Send: <code>chain wallet</code>\nChains: ${admin.chains().filter((c) => c.ready).map((c) => code(c.key)).join(', ')}`);
      return addCustomer(chatId, arg);
    default:
      if (cmd) return send(chatId, `Unknown command /${esc(cmd)}.`, menu());
      // plain text without a question: treat it as a search
      pendingInput.set(String(chatId), { kind: 'find', exp: Date.now() + 60e3 });
      return onText(msg);
  }
}

/** Withdraw role: list approved customers, open one, collect what is due. Nothing else. */
async function onTextWithdraw(msg, cmd, arg) {
  const chatId = msg.chat.id;
  const from = msg.from || {};
  const p = pendingInput.get(String(chatId));
  if (cmd === 'cancel') { pendingInput.delete(String(chatId)); return send(chatId, 'OK, cancelled.', withdrawMenu()); }
  if (!cmd && p) {
    pendingInput.delete(String(chatId));
    if (p.exp < Date.now()) return send(chatId, 'That question expired. Start again.', withdrawMenu());
    const acc = p.id ? admin.byId(p.id) : null;
    if (p.kind === 'amount' && acc) return askCharge(chatId, from, acc, msg.text.trim());
    if (p.kind === 'find') { const acc2 = await pick(chatId, msg.text.trim(), 'u'); if (!acc2) return null; const v = await userView(acc2.rowid, 'withdraw'); return send(chatId, v.text, v.markup); }
    return send(chatId, 'Not available for your role.', withdrawMenu());
  }
  switch (cmd) {
    case 'start': case 'menu': case 'help': case null: {
      if (!cmd && msg.text) { const acc = await pick(chatId, msg.text.trim(), 'u'); if (!acc) return null; const v = await userView(acc.rowid, 'withdraw'); return send(chatId, v.text, v.markup); }
      return send(chatId, `💳 <b>${esc(config.serviceName)}: withdraw</b>\nYou can see approved customers, their usage and what is due, and collect it.\n/withdraw · /user #12 · /charge #12 [amount]`, withdrawMenu());
    }
    case 'withdraw': case 'customers': case 'list': { const v = await withdrawView(0); return send(chatId, v.text, v.markup); }
    case 'user': case 'info': case 'customer': case 'find': {
      if (!arg) return ask(chatId, 'find', null, '🔎 Which customer? Send an address, #id or label.');
      const acc = await pick(chatId, arg, 'u'); if (!acc) return null;
      const v = await userView(acc.rowid, 'withdraw'); return send(chatId, v.text, v.markup);
    }
    case 'charge': case 'collect': {
      const parts = arg.split(/\s+/).filter(Boolean);
      if (!parts.length) return send(chatId, 'Use: <code>/charge #12</code> (as much as possible) or <code>/charge #12 5</code>');
      const acc = await pick(chatId, parts[0], 'c'); if (!acc) return null;
      return askCharge(chatId, from, acc, parts[1]);
    }
    default: return send(chatId, `Not available for your role. You can use /withdraw, /user and /charge.`, withdrawMenu());
  }
}

async function onCallback(q, role = 'admin') {
  const msg = q.message;
  const chatId = msg?.chat?.id;
  const from = q.from || {};
  const [kind, val] = String(q.data || '').split(':');
  call('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
  if (!chatId) return null;
  if (role === 'withdraw' && !['w', 'u', 'c', 'cm', 'h', 'y', 'n'].includes(kind)) return send(chatId, 'Not available for your role.', withdrawMenu());
  const acc = val && /^\d+$/.test(val) && !['l'].includes(kind) ? admin.byId(val) : null;
  const needAcc = ['u', 'au', 'c', 'cm', 'b', 'ub', 'lb', 'h'].includes(kind);
  if (needAcc && !acc) return send(chatId, 'That customer no longer exists.');

  switch (kind) {
    case 'm': return edit(msg, `🤖 <b>${esc(config.serviceName)} billing</b>\nWhat do you want to do?`, menu());
    case 's': return edit(msg, await statusText(), kb([[btn('🔄 Refresh', 's'), btn('⬅️ Menu', 'm')]]));
    case 'l': { const v = await listView(Number(val) || 0); return edit(msg, v.text, v.markup); }
    case 'u': { const v = await userView(val, role); return edit(msg, v.text, v.markup); }
    case 'w': { const v = await withdrawView(Number(val) || 0); return edit(msg, v.text, v.markup); }
    case 'h': return send(chatId, historyText(acc), kb([[btn('👤 Open customer', `u:${acc.rowid}`)]]));
    case 'ch': return edit(msg, chargesText(), kb([[btn('🔄 Refresh', 'ch'), btn('⬅️ Menu', 'm')]]));
    case 'st': return send(chatId, settingsText());
    case 'hp': return send(chatId, HELP);
    case 'f': return ask(chatId, 'find', null, '🔎 Send an address (or part of it), #id, label or email.');
    case 'ac': return ask(chatId, 'add', null, `➕ Send: <code>chain wallet</code>\nChains: ${admin.chains().filter((c) => c.ready).map((c) => code(c.key)).join(', ')}`);
    case 'ca': return askChargeAll(chatId, from);
    case 'au': return ask(chatId, 'usage', acc.rowid, `➕ How many ${esc(config.billing.unitName)} did customer #${acc.rowid} use?\nSend a number, optionally followed by a note. Example: <code>1500 March posts</code>\nPrice: ${admin.settings().pricePerUnit} each.`);
    case 'c': return askCharge(chatId, from, acc);
    case 'cm': return ask(chatId, 'amount', acc.rowid, `💵 How much to charge customer #${acc.rowid}? Send an amount, e.g. <code>5</code>`);
    case 'b': return setBlocked(chatId, from, acc, true);
    case 'ub': return setBlocked(chatId, from, acc, false);
    case 'lb': return ask(chatId, 'label', acc.rowid, `🏷 Send a label (name) for customer #${acc.rowid}. Send - to clear it.`);
    case 'y': case 'n': {
      const c = confirms.get(val);
      confirms.delete(val);
      if (!c || c.exp < Date.now()) return edit(msg, `${msg.text ? esc(msg.text) : ''}\n\n⌛ Expired. Start again.`);
      if (c.userId !== String(from.id) || c.chatId !== String(chatId)) { confirms.set(val, c); return null; }
      if (kind === 'n') return edit(msg, `${esc(msg.text || '')}\n\n✖️ Cancelled.`);
      await edit(msg, `${esc(msg.text || '')}\n\n✅ Confirmed by ${esc(who(from))}.`);
      return c.run();
    }
    default: return null;
  }
}

async function handle(u) {
  const msg = u.message || u.edited_message;
  const cq = u.callback_query;
  const chat = msg?.chat || cq?.message?.chat;
  const from = msg?.from || cq?.from;
  if (!chat || !from || from.is_bot) return;
  // ignore commands older than 10 minutes (e.g. sent while the server was down)
  if (msg?.date && Date.now() / 1000 - msg.date > 600) return;
  chatRegistry.chats = [{ id: String(chat.id), title: chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || String(chat.id), type: chat.type },
    ...chatRegistry.chats.filter((c) => c.id !== String(chat.id))].slice(0, 20);

  const role = await isAllowed(chat, from);
  if (!role) {
    const k = `${chat.id}:${from.id}`;
    if (msg && (!deniedAt.get(k) || Date.now() - deniedAt.get(k) > 10 * 60e3)) {
      deniedAt.set(k, Date.now());
      const configured = !!telegramSettings().chatId;
      await send(chat.id, configured
        ? `⛔ This bot is private.\nYour user ID: ${code(from.id)} · chat ID: ${code(chat.id)}\nAsk the owner to add your user ID in the admin panel (Telegram → Admin user IDs).`
        : `👋 Bot connected. This chat's ID is ${code(chat.id)}.\nIn the billing admin panel → Telegram alerts, press "Find my chat" (or paste this ID) and Save. Then send /start again.`);
    }
    if (cq) call('answerCallbackQuery', { callback_query_id: cq.id, text: 'Not allowed' }).catch(() => {});
    return;
  }
  try {
    if (cq) await onCallback(cq, role);
    else if (msg?.text) await onText(msg, role);
  } catch (e) {
    const m = e instanceof BillingError ? e.message : `Something went wrong: ${e.message}`;
    if (!(e instanceof BillingError)) console.error('[telegram-bot]', e);
    await send(chat.id, `⚠️ ${esc(m)}`);
  }
}

// ------------------------------------------------------------------ polling loop
const COMMANDS = [
  ['start', 'Menu'], ['status', 'Networks, keeper gas, money collected'], ['customers', 'Customer list'],
  ['find', 'Find a customer'], ['usage', 'Add usage: /usage #id units'], ['charge', 'Charge: /charge #id [amount]'],
  ['chargeall', 'Charge everyone who owes'], ['charges', 'Recent charges'], ['settings', 'Price and defaults'],
  ['add', 'Add a customer'], ['help', 'All commands'], ['cancel', 'Cancel the current question'],
];

async function loop() {
  for (;;) {
    const s = telegramSettings();
    const b = botSettings();
    if (!s.token || !b.commands) {
      state.running = false; chatRegistry.active = false;
      await new Promise((r) => setTimeout(r, 10e3));
      continue;
    }
    if (state.token !== s.token) {
      // resume after the last update we handled, so a restart never runs a command twice
      const saved = getMeta('telegram:offset');
      const [tokTail, off] = String(saved || '').split(':');
      state.token = s.token; state.offset = tokTail === s.token.slice(-6) ? Number(off) || 0 : 0; state.botName = null;
      try {
        await call('deleteWebhook', { drop_pending_updates: false });
        const me = await call('getMe', {});
        state.botName = me?.username || null;
        await call('setMyCommands', { commands: COMMANDS.map(([command, description]) => ({ command, description })) }).catch(() => {});
        console.log(`[telegram-bot] listening for commands as @${state.botName}`);
      } catch (e) {
        state.lastError = e.message; state.token = null;
        console.warn(`[telegram-bot] can't start: ${e.message}`);
        await new Promise((r) => setTimeout(r, 30e3));
        continue;
      }
    }
    state.running = true; chatRegistry.active = true;
    try {
      const updates = await call('getUpdates', { offset: state.offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, 35e3);
      state.lastError = null;
      for (const u of updates || []) {
        state.offset = u.update_id + 1;
        setMeta('telegram:offset', `${state.token.slice(-6)}:${state.offset}`);
        await handle(u);
      }
    } catch (e) {
      state.lastError = e.message;
      if (!/aborted|timeout/i.test(e.message)) console.warn(`[telegram-bot] ${e.message}`);
      await new Promise((r) => setTimeout(r, /conflict/i.test(e.message) ? 15e3 : 5e3));
    }
  }
}

export function startTelegramBot() {
  loop().catch((e) => console.error('[telegram-bot] stopped:', e));
}
