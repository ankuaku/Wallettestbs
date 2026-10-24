import QRCode from 'qrcode';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (h) => (h ? `${h.slice(0, 8)}…${h.slice(-6)}` : '');
const when = (t) => (t ? new Date(t).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '');
const KEY = 'billing:admin-key';

let key = sessionStorage.getItem(KEY) || '';
let data = null;
let bill = null;   // AI billing overview
let tg = null;     // Telegram settings

let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'x-admin-key': key, ...(opts.body ? { 'content-type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) { logout(); throw new Error('Wrong admin key.'); }
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status}).`);
  return body;
}

function logout() {
  sessionStorage.removeItem(KEY);
  key = '';
  $('#app').hidden = true;
  $('#login').hidden = false;
  ['#logout', '#refresh', '#net-pill'].forEach((s) => { $(s).hidden = true; });
}

async function load() {
  [data, bill, tg] = await Promise.all([
    api('/api/admin/overview'),
    api('/api/admin/billing').catch((e) => ({ error: e.message })),
    api('/api/admin/telegram').catch(() => null),
  ]);
  $('#login').hidden = true;
  $('#app').hidden = false;
  ['#logout', '#refresh'].forEach((s) => { $(s).hidden = false; });
  const pill = $('#net-pill');
  const isTest = (data.chains || []).some((c) => c.testnet);
  pill.textContent = `${isTest ? 'Test mode' : 'Live'}: ${(data.chains || []).map((c) => c.short).join(', ')}`;
  pill.classList.toggle('test', isTest);
  pill.hidden = false;
  render();
}

function renderBilling() {
  const unit = bill?.settings?.unitName || 'units';
  const Unit = unit.charAt(0).toUpperCase() + unit.slice(1);
  const box = $('#billing-status');
  if (!bill || bill.error) { box.innerHTML = `<p class="msg err">${esc(bill?.error || 'Billing data not available.')}</p>`; return; }
  const link = (url, text) => (url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>` : esc(text));

  box.innerHTML = `
    <div class="stats">
      <div class="stat"><div class="k">Customers</div><div class="v">${bill.totals.accounts}</div></div>
      <div class="stat"><div class="k">Collected (USD stablecoins)</div><div class="v">${esc(bill.totals.paid)}
        ${Object.keys(bill.totals.byChain || {}).length > 1 ? `<div class="small" style="font:400 .8rem var(--body)">${Object.entries(bill.totals.byChain).map(([k, v]) => `${esc(k)}: ${esc(v.toFixed(2))}`).join('<br/>')}</div>` : ''}</div></div>
    </div>
    <div class="net-grid" style="margin-top:14px">${bill.chains.map((c) => {
      const i = c.inspect || {};
      const statusPill = !c.ready ? '<span class="pill muted">Not set up</span>' : i.paused ? '<span class="pill off">Paused</span>' : c.network?.ok === false ? '<span class="pill off">Not connected</span>' : c.canCharge ? '<span class="pill on">Running</span>' : '<span class="pill warn">No keeper</span>';
      return `<div class="net-card ${c.ready ? '' : 'is-off'}">
        <div class="net-head"><span class="net-name">${esc(c.name)}</span>${statusPill}</div>
        <div class="net-meta">
          <span>${esc(c.symbol)} · ${c.family === 'solana' ? 'delegate approval' : 'contract'} ${c.family === 'solana' ? '' : link(i.contract ? `${c.explorer}/${c.family === 'tron' ? 'contract' : 'address'}/${i.contract}` : '', i.contract ? short(i.contract) : '-')}</span>
          ${c.keeperAddress ? `<span>Keeper ${link(c.keeperUrl, short(c.keeperAddress))}${c.keeperGas ? `: ${esc(Number(c.keeperGas.balance).toFixed(4))} ${esc(c.gasToken)}${c.keeperGas.energy !== undefined ? `, energy ${esc(c.keeperGas.energy)}` : ''}` : ''}</span>` : ''}
          ${i.treasury ? `<span>Treasury ${esc(short(i.treasury))}</span>` : ''}
          ${c.problems.map((p) => `<span style="color:var(--bad)">${esc(p)}</span>`).join('')}
        </div></div>`;
    }).join('')}</div>
    <p class="small" style="margin-top:8px">Set up or manage a chain on the <a href="./deploy.html">Deploy contract</a> page.</p>`;

  // settings form (don't overwrite while typing)
  const s = bill.settings;
  const setIfIdle = (id, v) => { const el = $(id); if (document.activeElement !== el) el.value = v; };
  setIfIdle('#s-price', s.pricePerUnit); setIfIdle('#s-approve', s.defaultApprove);
  setIfIdle('#s-charge', s.defaultMaxPerCharge); setIfIdle('#s-period', s.defaultMaxPerPeriod);
  setIfIdle('#s-min', s.minApproval);
  $('label[for="s-min"]').textContent = 'Minimum approval (USD stablecoin)';
  $('label[for="s-price"]').textContent = `Price per 1 ${unit.replace(/s$/, '')} (USD stablecoin)`;
  priceHint();
  $('label[for="u-tokens"]').textContent = `${Unit} used`;

  const sel = $('#u-wallet'); const cur = sel.value;
  sel.innerHTML = bill.accounts.length
    ? bill.accounts.map((a) => `<option value="${esc(a.account)}">${esc(a.chainName)} · ${esc(a.label || short(a.wallet))}${a.email ? ` (${esc(a.email)})` : ''}</option>`).join('')
    : '<option value="">No customers yet</option>';
  if (cur) sel.value = cur;
  const chainSel = $('#c-chain');
  if (chainSel && !chainSel.options.length) chainSel.innerHTML = bill.chains.filter((c) => c.ready).map((c) => `<option value="${esc(c.key)}">${esc(c.short)}</option>`).join('');
  updateCost();

  $('#billing-accounts').innerHTML = bill.accounts.length ? `
    <thead><tr><th>Customer</th><th>Chain</th><th>On-chain</th><th>Limits (charge / 30d)</th><th>Left 30d</th><th>Approved</th><th>Balance</th><th>${esc(Unit)}</th><th>Due</th><th>Credit left</th><th>Can charge now</th><th>Amount</th><th></th><th></th></tr></thead>
    <tbody>${bill.accounts.map((a) => {
      const c = a.chainState || {};
      return `<tr>
        <td>${link(a.addressUrl, a.label || short(a.wallet))}${a.email ? `<br/><span class="small">${esc(a.email)}</span>` : ''}${a.blocked ? ' <span class="pill off">Blocked</span>' : ''}</td>
        <td>${esc(a.chainName)}<br/><span class="small">${esc(a.symbol)}</span></td>
        <td>${c.active ? '<span class="pill on">Active</span>' : (c.allowance && c.allowance !== '0.00') ? '<span class="pill warn">Approved only</span><br/><span class="small">not activated yet</span>' : '<span class="pill off">Off</span>'}</td>
        <td>${c.active ? `${esc(c.maxPerCharge)} / ${esc(c.maxPerPeriod)}` : '-'}</td>
        <td>${esc(c.remainingInPeriod ?? '-')}</td>
        <td>${esc(c.allowance ?? '-')}</td>
        <td>${esc(c.balance ?? '-')}</td>
        <td>${Number(a.tokensUsed).toLocaleString('en-IN')}</td>
        <td><strong>${esc(a.due)}</strong>${Number(a.inFlight) > 0 ? `<br/><span class="small">${esc(a.inFlight)} in progress</span>` : ''}</td>
        <td>${a.usable ? esc(a.creditLeft) : `<span class="pill off">Paused</span><br/><span class="small">${esc(a.creditReason || '')}</span>`}</td>
        <td>${Number(a.chargeableNow) > 0 ? esc(a.chargeableNow) : `<span class="small">${esc(a.cannotChargeReason || '0')}</span>`}</td>
        <td><input class="amt-in" type="number" min="0" step="0.01" placeholder="${esc(a.chargeableNow)}" aria-label="Amount to charge" /></td>
        <td><button class="btn btn-primary btn-sm" data-charge="${esc(a.account)}" data-sym="${esc(a.symbol)}" data-label="${esc(short(a.wallet))}" type="button" ${Number(a.chargeableNow) > 0 && a.canCharge ? '' : 'disabled'}>Charge</button></td>
        <td><button class="btn btn-ghost btn-sm" data-block="${esc(a.account)}" data-state="${a.blocked ? 0 : 1}" type="button">${a.blocked ? 'Unblock' : 'Block'}</button></td>
      </tr>`;
    }).join('')}</tbody>` : '<tbody><tr><td>No customers yet. They appear after approving or activating on the billing page.</td></tr></tbody>';

  $('#billing-charges').innerHTML = bill.charges.length ? `
    <thead><tr><th>When</th><th>Chain</th><th>Customer</th><th>Amount</th><th>Status</th><th>Transaction</th><th>Error</th></tr></thead>
    <tbody>${bill.charges.map((c) => `<tr>
      <td>${when(c.created_at)}</td><td>${esc(c.chainName)}</td><td>${esc(short(c.wallet))}</td><td>${esc(c.amount)} ${esc(c.symbol)}</td>
      <td class="status ${esc(c.status)}">${esc(c.status)}</td><td>${c.tx_hash ? link(c.txUrl, short(c.tx_hash)) : ''}</td><td class="small">${esc(c.error || '')}</td></tr>`).join('')}</tbody>`
    : '<tbody><tr><td>No charges yet.</td></tr></tbody>';
}

function updateCost() {
  if (!bill?.settings) return;
  const t = Number($('#u-tokens').value);
  $('#u-cost').textContent = t > 0 ? `Cost: ${(t * Number(bill.settings.pricePerUnit)).toFixed(6)} (in the customer's stablecoin)` : '';
}

function priceHint() {
  const v = Number($('#s-price').value);
  const unit = bill?.settings?.unitName || 'units';
  $('#s-price-hint').textContent = v > 0
    ? `1,000 ${unit} = ${+(v * 1000).toFixed(6)} · 1,000,000 ${unit} = ${+(v * 1e6).toFixed(4)}`
    : 'Price of one unit, e.g. 0.002';
}

function renderTelegram() {
  if (!tg) return;
  const tokenIn = $('#tg-token'); const chatIn = $('#tg-chat');
  tokenIn.disabled = tg.tokenFromEnv;
  tokenIn.placeholder = tg.hasToken ? `Saved (${tg.tokenHint})${tg.tokenFromEnv ? ', set in the server environment' : ''}` : '123456789:ABC...';
  $('#tg-token-hint').textContent = tg.tokenFromEnv ? 'Set by TELEGRAM_BOT_TOKEN on the server.' : 'Stored on your server. Leave empty to keep the saved one.';
  if (document.activeElement !== chatIn) chatIn.value = tg.chatId || '';
  chatIn.disabled = tg.chatFromEnv;
  $('#tg-enabled').checked = tg.enabled;
  $('#tg-events').innerHTML = tg.events.map((e) => `<label><input type="checkbox" data-tg-event="${esc(e.key)}" ${e.on ? 'checked' : ''} /> ${esc(e.label)}</label>`).join('');
  if (tg.bot) {
    const bt = tg.bot;
    $('#tg-commands').checked = bt.commands;
    $('#tg-commands').disabled = bt.commandsFromEnv;
    const adm = $('#tg-admins');
    if (document.activeElement !== adm) adm.value = bt.adminIds.filter((x) => !bt.adminIdsFromEnv.includes(x)).join(', ');
    const wd = $('#tg-withdraw');
    if (wd && document.activeElement !== wd) wd.value = (bt.withdrawIds || []).filter((x) => !(bt.withdrawIdsFromEnv || []).includes(x)).join(', ');
    $('#tg-bot-status').innerHTML = !tg.hasToken ? '<span class="pill muted">Add a bot token first</span>'
      : !bt.commands ? '<span class="pill muted">Off</span>'
      : bt.running ? `<span class="pill on">Listening</span> ${bt.botName ? `as <b>@${esc(bt.botName)}</b>. Open it in Telegram and send /start.` : ''}${bt.adminIdsFromEnv.length ? ` Also from TELEGRAM_ADMIN_IDS: ${esc(bt.adminIdsFromEnv.join(', '))}.` : ''}`
      : bt.lastError ? `<span class="pill off">Error</span> ${esc(bt.lastError)}` : '<span class="pill muted">Starting…</span>';
  }
  $('#tg-status').innerHTML = !tg.configured ? '<span class="pill muted">Not set up</span>'
    : tg.lastError ? `<span class="pill off">Error</span> ${esc(tg.lastError)}`
    : tg.enabled ? '<span class="pill on">Ready</span>' : '<span class="pill muted">Paused</span>';
}

function render() {
  const { chains = [], treasury } = data;
  const down = chains.filter((c) => c.status?.ok === false);
  const warn = $('#chain-warn');
  warn.hidden = !down.length;
  warn.textContent = down.map((c) => `${c.name}: not connected. ${c.status.error || ''}`).join('  ');
  $('#stats').innerHTML = [
    ['Chains', chains.map((c) => `${esc(c.short)} <span class="small" style="font:400 .8rem var(--body)">${esc(c.token.symbol)}, ${c.status?.ok ? 'connected' : c.status?.ok === false ? 'not connected' : '…'}${c.rpcSource === 'public' ? ', public RPC' : ''}</span>`).join('<br/>')],
    ['Default EVM treasury', treasury ? `<span class="mono" style="font-size:.85rem">${esc(short(treasury))}</span>` : '<span class="small">Not set (TREASURY_WALLET)</span>'],
  ].map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');
  renderBilling();
  renderTelegram();
  renderQR();
}

// ------------------------------------------------------------------ payment QR
function qrLink() {
  let base = ($('#qr-url').value || '').trim() || `${location.origin}/`;
  try {
    const u = new URL(base);
    const ch = $('#qr-chain').value;
    if (ch) u.searchParams.set('chain', ch); else u.searchParams.delete('chain');
    return u.toString();
  } catch { return base; }
}
async function renderQR() {
  const chains = data?.chains || [];
  const sel = $('#qr-chain');
  if (!sel.options.length) {
    sel.innerHTML = chains.length > 1 ? '<option value="">Customer chooses</option>' + chains.map((c) => `<option value="${esc(c.key)}">${esc(c.name)}</option>`).join('') : '<option value=""></option>';
    $('#qr-chain-field').hidden = chains.length < 2;
  }
  if (!$('#qr-url').value) $('#qr-url').value = `${location.origin}/`;
  const link = qrLink();
  $('#qr-text').textContent = link;
  try { $('#qr-box').innerHTML = await QRCode.toString(link, { type: 'svg', margin: 1, width: 220, errorCorrectionLevel: 'M' }); } catch { $('#qr-box').textContent = 'Not a valid link'; }
}
document.addEventListener('input', (e) => { if (e.target.id === 'qr-url') renderQR(); });
document.addEventListener('change', (e) => { if (e.target.id === 'qr-chain') renderQR(); });
document.addEventListener('click', async (e) => {
  const id = e.target.closest('button')?.id;
  if (id === 'qr-copy') {
    try { await navigator.clipboard.writeText(qrLink()); toast('Link copied'); } catch { toast('Copy failed: select the link and copy it'); }
  } else if (id === 'qr-png') {
    const a = document.createElement('a');
    a.href = await QRCode.toDataURL(qrLink(), { width: 1024, margin: 2, errorCorrectionLevel: 'M' });
    a.download = 'billing-qr.png';
    a.click();
  }
});

document.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  try {
    if (b.id === 'login-btn') {
      key = $('#key').value.trim();
      $('#login-err').hidden = true;
      try { await load(); sessionStorage.setItem(KEY, key); }
      catch (err) { $('#login-err').textContent = err.message; $('#login-err').hidden = false; }
      return;
    }
    if (b.id === 'logout') return logout();
    if (b.id === 'refresh') { await load(); return toast('Up to date'); }

    if (b.dataset.charge) {
      const row = b.closest('tr');
      const amount = row.querySelector('.amt-in').value.trim();
      const shown = amount || row.querySelector('.amt-in').placeholder;
      if (!confirm(`Charge ${shown} ${b.dataset.sym} from ${b.dataset.label}?`)) return;
      b.disabled = true; b.textContent = 'Charging…';
      try {
        const r = await api('/api/admin/billing/charge', { method: 'POST', body: { account: b.dataset.charge, amount: amount || undefined } });
        toast(r.charge.status === 'paid' ? `Charged ${r.charge.amount} ${r.charge.symbol}` : `Charge ${r.charge.status}`);
      } finally { await load(); }
      return;
    }

    if (b.dataset.block) {
      await api('/api/admin/billing/account', { method: 'POST', body: { account: b.dataset.block, blocked: b.dataset.state === '1' } });
      await load();
      return toast(b.dataset.state === '1' ? 'Customer blocked: their API key stops working' : 'Customer unblocked');
    }

    if (b.id === 'tg-save') {
      const body = {};
      const t = $('#tg-token').value.trim(); if (t) body.token = t;
      if (!$('#tg-chat').disabled) body.chatId = $('#tg-chat').value.trim();
      tg = await api('/api/admin/telegram', { method: 'POST', body });
      $('#tg-token').value = '';
      renderTelegram();
      return toast('Telegram settings saved');
    }
    if (b.id === 'tg-find') {
      const r = await api('/api/admin/telegram/find-chat', { method: 'POST', body: {} });
      if (r.chats.length === 1) {
        tg = await api('/api/admin/telegram', { method: 'POST', body: { chatId: r.chats[0].id } });
        renderTelegram();
        return toast(`Chat found: ${r.chats[0].title}`);
      }
      $('#tg-chats').innerHTML = `<p class="small">Pick the chat for alerts:</p><div class="chat-pick">${r.chats.map((c) =>
        `<button class="btn btn-ghost btn-sm" type="button" data-tg-chat="${esc(c.id)}">${esc(c.title)} (${esc(c.type)})</button>`).join('')}</div>`;
      return;
    }
    if (b.dataset.tgChat) {
      tg = await api('/api/admin/telegram', { method: 'POST', body: { chatId: b.dataset.tgChat } });
      $('#tg-chats').innerHTML = '';
      renderTelegram();
      return toast('Chat saved');
    }
    if (b.id === 'tg-test') {
      await api('/api/admin/telegram/test', { method: 'POST', body: {} });
      tg = await api('/api/admin/telegram');
      renderTelegram();
      return toast('Test message sent. Check Telegram.');
    }
    if (b.id === 'tg-save-bot') {
      tg = await api('/api/admin/telegram', { method: 'POST', body: { commands: $('#tg-commands').checked, adminIds: $('#tg-admins').value.trim(), withdrawIds: $('#tg-withdraw').value.trim() } });
      renderTelegram();
      toast('Saved. The bot picks it up within a few seconds.');
      return;
    }
    if (b.id === 'tg-save-events') {
      const events = {};
      document.querySelectorAll('[data-tg-event]').forEach((i) => { events[i.dataset.tgEvent] = i.checked; });
      tg = await api('/api/admin/telegram', { method: 'POST', body: { events, enabled: $('#tg-enabled').checked } });
      renderTelegram();
      return toast('Alert choices saved');
    }

    if (b.id === 'add-customer') {
      const wallet = $('#c-wallet').value.trim();
      const r = await api('/api/admin/billing/add-customer', { method: 'POST', body: { wallet, chain: $('#c-chain')?.value || undefined } });
      $('#c-wallet').value = '';
      await load();
      return toast(r.added ? `Customer added${r.active ? '' : ' (approved, not activated yet)'}` : 'Already in the list');
    }

    if (b.id === 'add-usage') {
      const wallet = $('#u-wallet').value;
      if (!wallet) return toast('No customer selected.');
      const r = await api('/api/admin/billing/usage', { method: 'POST', body: { account: wallet, tokens: Number($('#u-tokens').value), note: $('#u-note').value } });
      $('#u-tokens').value = ''; $('#u-note').value = '';
      await load();
      return toast(`Added ${r.cost} ${r.symbol}. Due now: ${r.due}`);
    }

    if (b.id === 'save-billing') {
      await api('/api/admin/billing/settings', { method: 'POST', body: {
        pricePerUnit: $('#s-price').value, defaultApprove: $('#s-approve').value,
        defaultMaxPerCharge: $('#s-charge').value, defaultMaxPerPeriod: $('#s-period').value,
        minApproval: $('#s-min').value,
      } });
      await load();
      return toast('Billing settings saved');
    }

  } catch (err) {
    toast(err.message);
  }
});

$('#u-tokens').addEventListener('input', updateCost);
$('#s-price').addEventListener('input', priceHint);
$('#key').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#login-btn').click(); });

if (key) load().catch(() => logout());
// Auto-refresh every 30s, but not while you're typing in a form.
setInterval(() => {
  if (!key || document.hidden || $('#app').hidden || $('#billing').contains(document.activeElement) || $('#telegram').contains(document.activeElement)) return;
  load().catch(() => {});
}, 30000);
