/*
 * Telegram alerts for the service owner.
 *
 * Sends a message to your Telegram when something happens: a wallet connects,
 * a customer approves / activates / cancels billing,
 * a charge goes through or fails, a network goes down, the keeper runs low on gas.
 * The site keeps running automatically; these alerts let you check things by hand.
 *
 * Setup: create a bot with @BotFather, then either set TELEGRAM_BOT_TOKEN and
 * TELEGRAM_CHAT_ID in the environment, or paste the token in the admin panel
 * (Telegram alerts) and press "Find my chat".
 */
import { config } from './config.js';
import { db, getMeta, setMeta } from './db.js';

export const EVENTS = {
  wallet_connect: { label: 'Wallet connected on the site', default: true },
  approval: { label: 'Approval given / changed / revoked', default: true },
  activated: { label: 'Billing activated or limits changed', default: true },
  cancelled: { label: 'Billing cancelled', default: true },
  charge: { label: 'Charge (paid or failed)', default: true },
  usage_stop: { label: 'Customer ran out of credit', default: true },
  health: { label: 'Network down / keeper low on gas', default: true },
  gas_drop: { label: 'Gas coin sent to a customer (gas drop)', default: true },
  payment: { label: 'Prepaid payment received', default: true },
};

// ------------------------------------------------------------------ settings

const envToken = (process.env.TELEGRAM_BOT_TOKEN || '').trim() || null;
const envChat = (process.env.TELEGRAM_CHAT_ID || '').trim() || null;

export function telegramSettings() {
  let events = {};
  try { events = JSON.parse(getMeta('telegram:events') || '{}'); } catch { /* defaults */ }
  const token = envToken || getMeta('telegram:token') || null;
  const chatId = envChat || getMeta('telegram:chat') || null;
  return {
    token,
    chatId,
    tokenFromEnv: !!envToken,
    chatFromEnv: !!envChat,
    enabled: getMeta('telegram:enabled') !== '0',
    events: Object.fromEntries(Object.entries(EVENTS).map(([k, v]) => [k, events[k] ?? v.default])),
  };
}

export class TelegramError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;

export function saveTelegramSettings(body = {}) {
  if (body.token !== undefined && !envToken) {
    const t = String(body.token).trim();
    if (t && !TOKEN_RE.test(t)) throw new TelegramError(400, 'That does not look like a bot token (it looks like 123456789:ABC...).');
    setMeta('telegram:token', t);
  }
  if (body.chatId !== undefined && !envChat) {
    const c = String(body.chatId).trim();
    if (c && !/^-?\d{3,}$|^@[A-Za-z0-9_]{4,}$/.test(c)) throw new TelegramError(400, 'Chat ID is a number like 123456789 (or -100... for a group).');
    setMeta('telegram:chat', c);
  }
  if (body.enabled !== undefined) setMeta('telegram:enabled', body.enabled ? '1' : '0');
  if (body.events && typeof body.events === 'object') {
    const cur = telegramSettings().events;
    for (const k of Object.keys(EVENTS)) if (body.events[k] !== undefined) cur[k] = !!body.events[k];
    setMeta('telegram:events', JSON.stringify(cur));
  }
  return publicTelegram();
}

/** Safe to show in the admin panel: never returns the full token. */
export function publicTelegram() {
  const s = telegramSettings();
  return {
    configured: !!(s.token && s.chatId),
    hasToken: !!s.token,
    tokenHint: s.token ? `…${s.token.slice(-4)}` : null,
    chatId: s.chatId,
    tokenFromEnv: s.tokenFromEnv,
    chatFromEnv: s.chatFromEnv,
    enabled: s.enabled,
    events: Object.entries(EVENTS).map(([key, v]) => ({ key, label: v.label, on: s.events[key] })),
    lastError,
  };
}

// ------------------------------------------------------------------ sending

// TELEGRAM_API_BASE is only for testing against a local mock.
const API_BASE = (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, '');
let lastError = null;
const queue = [];
let sending = false;
const recent = new Map();   // dedupe key -> time

const api = async (token, method, body, timeoutMs = 15000) => {
  const res = await fetch(`${API_BASE}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) {
    const err = new Error(j.description || `Telegram HTTP ${res.status}`);
    err.retryAfter = j.parameters?.retry_after;
    throw err;
  }
  return j.result;
};
export const tgApi = api;

/** Filled by the command bot (telegramBot.js) while it is polling, so "Find my chat" doesn't compete with it. */
export const chatRegistry = { active: false, chats: [] };

async function pump() {
  if (sending) return;
  sending = true;
  while (queue.length) {
    const { token, chatId, text, markup } = queue[0];
    try {
      await api(token, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}) });
      lastError = null;
      queue.shift();
      await new Promise((r) => setTimeout(r, 1100));   // stay well under Telegram's limits
    } catch (e) {
      if (e.retryAfter) { await new Promise((r) => setTimeout(r, (e.retryAfter + 1) * 1000)); continue; }
      lastError = e.message;
      console.warn(`[telegram] ${e.message}`);
      queue.shift();
    }
  }
  sending = false;
}

export const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
export const code = (s) => `<code>${esc(s)}</code>`;
export const link = (url, text) => (url ? `<a href="${esc(url)}">${esc(text)}</a>` : esc(text));

/** "Open customer" / "Collect" buttons under an alert, when the Telegram bot's commands are on. */
function alertButtons(account, collect) {
  if (!account) return null;
  const env = String(process.env.TELEGRAM_COMMANDS ?? '').trim();
  if (env === '0' || (env !== '1' && getMeta('telegram:commands') === '0')) return null;
  try {
    const r = db.prepare('SELECT rowid FROM billing_accounts WHERE wallet = ?').get(account);
    if (!r) return null;
    const row = [{ text: '👤 Open customer', callback_data: `u:${r.rowid}` }];
    if (collect) row.push({ text: '💰 Collect', callback_data: `c:${r.rowid}` });
    return { inline_keyboard: [row] };
  } catch { return null; }
}

/**
 * Queue an alert. `dedupeKey` + `dedupeMs` stop the same alert repeating
 * (e.g. the same wallet reconnecting). Never throws: alerts must not break the site.
 */
export function notify(event, lines, { dedupeKey, dedupeMs = 0, account = null, collect = false } = {}) {
  try {
    const s = telegramSettings();
    if (!s.enabled || !s.token || !s.chatId || !s.events[event]) return false;
    if (dedupeKey) {
      const k = `${event}:${dedupeKey}`;
      const t = recent.get(k);
      if (t && Date.now() - t < dedupeMs) return false;
      recent.set(k, Date.now());
      if (recent.size > 5000) for (const [kk, tt] of recent) if (Date.now() - tt > 24 * 3600e3) recent.delete(kk);
    }
    const text = [...[].concat(lines), `<i>${esc(config.serviceName)}</i>`].filter(Boolean).join('\n');
    queue.push({ token: s.token, chatId: s.chatId, text: text.slice(0, 4000), markup: alertButtons(account, collect) });
    if (queue.length > 200) queue.splice(0, queue.length - 200);
    pump();
    return true;
  } catch (e) {
    console.warn(`[telegram] ${e.message}`);
    return false;
  }
}

/** Admin: send a test message right now and report the result. */
export async function sendTest() {
  const s = telegramSettings();
  if (!s.token) throw new TelegramError(400, 'Add the bot token first.');
  if (!s.chatId) throw new TelegramError(400, 'Add the chat ID first (or press "Find my chat").');
  try {
    await api(s.token, 'sendMessage', { chat_id: s.chatId, text: `✅ <b>${esc(config.serviceName)}</b>\nTelegram alerts are working.`, parse_mode: 'HTML' });
    lastError = null;
  } catch (e) {
    lastError = e.message;
    throw new TelegramError(400, `Telegram said: ${e.message}. Check the token, and that you pressed Start in the bot chat.`);
  }
}

/** Admin: find the chat of whoever last messaged the bot (after they press Start). */
export async function findChat() {
  const s = telegramSettings();
  if (!s.token) throw new TelegramError(400, 'Add the bot token first.');
  if (chatRegistry.active) {
    if (!chatRegistry.chats.length) throw new TelegramError(404, 'No chats found yet. Open your bot in Telegram, press Start (or send any message), then try again.');
    return chatRegistry.chats;
  }
  let updates;
  try { updates = await api(s.token, 'getUpdates', { limit: 50, timeout: 0 }); }
  catch (e) { throw new TelegramError(400, `Telegram said: ${e.message}. Check the bot token.`); }
  const chats = [];
  for (const u of updates.reverse()) {
    const c = u.message?.chat || u.channel_post?.chat || u.my_chat_member?.chat;
    if (c && !chats.some((x) => x.id === c.id)) chats.push({ id: String(c.id), title: c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || String(c.id), type: c.type });
  }
  if (!chats.length) throw new TelegramError(404, 'No chats found. Open your bot in Telegram, press Start (or send any message), then try again.');
  return chats;
}
