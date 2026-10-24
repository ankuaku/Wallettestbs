/*
 * Withdraw page: for staff who only collect. Lists approved customers (approved amount, token balance,
 * usage, due) and withdraws what is due. Uses WITHDRAW_KEY (or the admin key); nothing else is reachable.
 */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (h) => (h && h.length > 16 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h || '');
const when = (t) => (t ? new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
const KEY = 'billing:withdraw-key';
let key = sessionStorage.getItem(KEY) || '';
let data = null;
let busyRow = null;
let openHistory = null;

let toastTimer;
function toast(text) { const t = $('#toast'); t.textContent = text; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600); }

async function api(path, opts = {}) {
  const res = await fetch(path, { method: opts.method || 'GET', headers: { 'x-admin-key': key, ...(opts.body ? { 'content-type': 'application/json' } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) { logout(); throw new Error(body.error || 'Wrong password.'); }
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status}).`);
  return body;
}
function logout() {
  key = ''; sessionStorage.removeItem(KEY);
  $('#app').hidden = true; $('#login').hidden = false; $('#refresh').hidden = true; $('#logout').hidden = true;
}

async function load() {
  data = await api('/api/withdraw');
  $('#login').hidden = true; $('#app').hidden = false; $('#refresh').hidden = false; $('#logout').hidden = false;
  render();
}

function render() {
  const rows = data.rows;
  const q = ($('#search').value || '').trim().toLowerCase();
  const onlyDue = $('#only-due').checked;
  const shown = rows.filter((r) => (!q || `#${r.id} ${r.wallet} ${r.label || ''}`.toLowerCase().includes(q)) && (!onlyDue || Number(r.due) > 0));
  const dueSum = {}; const canSum = {};
  for (const r of rows) { dueSum[r.symbol] = (dueSum[r.symbol] || 0) + Number(r.due); canSum[r.symbol] = (canSum[r.symbol] || 0) + Number(r.withdrawable); }
  const money = (o) => Object.entries(o).map(([s, v]) => `${v.toFixed(2)} ${esc(s)}`).join(' + ') || '0';
  $('#stats').innerHTML = `
    <div class="stat"><div class="k">Approved customers</div><div class="v">${rows.length}</div></div>
    <div class="stat"><div class="k">Due in total</div><div class="v">${money(dueSum)}</div></div>
    <div class="stat"><div class="k">Can withdraw now</div><div class="v">${money(canSum)}</div></div>
    <div class="stat"><div class="k">Price</div><div class="v">${esc(data.pricePerUnit)} per ${esc(String(data.unitName).replace(/s$/, ''))}</div></div>`;
  $('#rows').innerHTML = shown.length ? `
    <thead><tr><th>Customer</th><th>Chain</th><th>Status</th><th>Approved</th><th>Available balance</th><th>${esc(data.unitName)} used</th><th>Due</th><th>Can withdraw</th><th>Amount</th><th></th></tr></thead>
    <tbody>${shown.map((r) => `<tr data-id="${r.id}">
      <td><b>#${r.id}</b> <a href="${esc(r.addressUrl)}" target="_blank" rel="noopener" title="${esc(r.wallet)}">${esc(short(r.wallet))}</a>${r.label ? `<br><span class="small">${esc(r.label)}</span>` : ''}${r.blocked ? ' <span class="pill muted">blocked</span>' : ''}<br><span class="small"><button class="link-btn" data-history="${r.id}" type="button">History</button> · <button class="link-btn" data-usage="${r.id}" type="button">+ usage</button></span></td>
      <td>${esc(r.chainName)}</td>
      <td>${r.active ? '<span class="pill on">Active</span>' : '<span class="pill muted">Not active</span>'}</td>
      <td>${esc(r.approved)}${r.approved === 'Unlimited' ? '' : ` ${esc(r.symbol)}`}</td>
      <td>${esc(r.balance)} ${esc(r.symbol)}</td>
      <td>${Number(r.tokensUsed).toLocaleString()}<br><span class="small">= ${esc(r.used)} ${esc(r.symbol)}, paid ${esc(r.paid)}</span></td>
      <td><b>${esc(r.due)} ${esc(r.symbol)}</b></td>
      <td>${Number(r.withdrawable) > 0 ? `<b>${esc(r.withdrawable)} ${esc(r.symbol)}</b>` : `<span class="small">${esc(r.reason || '0')}</span>`}</td>
      <td><input data-amount="${r.id}" type="number" min="0" step="0.01" placeholder="${esc(r.withdrawable)}" /></td>
      <td><button class="btn btn-primary btn-sm" data-withdraw="${r.id}" type="button" ${Number(r.withdrawable) > 0 && busyRow !== r.id && r.canCharge ? '' : 'disabled'}>${busyRow === r.id ? 'Withdrawing…' : 'Withdraw'}</button></td>
    </tr>`).join('')}</tbody>` : '<tbody><tr><td>No approved customers match.</td></tr></tbody>';
}

async function withdraw(id) {
  const r = data.rows.find((x) => x.id === id);
  const raw = ($(`[data-amount="${id}"]`)?.value || '').trim();
  const amount = raw ? Number(raw) : null;
  if (raw && !(amount > 0)) return toast('Amount must be more than 0.');
  if (amount && amount > Number(r.due)) return toast(`Amount is more than what is due (${r.due} ${r.symbol}).`);
  if (!confirm(`Withdraw ${raw || r.withdrawable} ${r.symbol} from #${id} (${short(r.wallet)}) on ${r.chainName}?\n\nThis sends a blockchain transaction into the treasury.`)) return;
  busyRow = id; render();
  try {
    const { charge } = await api('/api/withdraw/charge', { method: 'POST', body: { account: r.account, amount: raw || undefined } });
    toast(charge.status === 'paid' ? `Paid: ${charge.amount} ${charge.symbol}` : `Sent, confirming (${charge.status})`);
  } catch (e) { toast(e.message); }
  busyRow = null;
  try { await load(); } catch { render(); }
  if (openHistory === id) history(id);
}

async function addUsage(id) {
  const r = data.rows.find((x) => x.id === id);
  const v = prompt(`How many ${data.unitName} did #${id} use? (${data.pricePerUnit} each)`);
  if (v === null) return;
  const n = Number(String(v).replace(/[, _]/g, ''));
  if (!(n > 0)) return toast('Enter a number above 0.');
  try { const u = await api('/api/withdraw/usage', { method: 'POST', body: { account: r.account, tokens: n, note: 'withdraw page' } }); toast(`Added ${u.tokens.toLocaleString()} ${data.unitName}; due now ${u.due} ${u.symbol}`); await load(); }
  catch (e) { toast(e.message); }
}

async function history(id) {
  const r = data.rows.find((x) => x.id === id);
  openHistory = id;
  const h = await api(`/api/withdraw/history?account=${encodeURIComponent(r.account)}`);
  $('#history-sec').hidden = false;
  $('#history-h').textContent = `History: #${id} ${short(r.wallet)} (${r.chainName})`;
  $('#history-usage').innerHTML = `<thead><tr><th>When</th><th>${esc(data.unitName)}</th><th>Cost</th><th>Note</th></tr></thead><tbody>${h.usage.length ? h.usage.map((u) => `<tr><td>${esc(when(u.created_at))}</td><td>${Number(u.tokens).toLocaleString()}</td><td>${esc(u.cost)} ${esc(r.symbol)}</td><td>${esc(u.note || u.source || '')}</td></tr>`).join('') : '<tr><td>No usage yet.</td></tr>'}</tbody>`;
  $('#history-charges').innerHTML = `<thead><tr><th>When</th><th>Amount</th><th>Status</th><th>Transaction</th></tr></thead><tbody>${h.charges.length ? h.charges.map((c) => `<tr><td>${esc(when(c.created_at))}</td><td>${esc(c.amount)} ${esc(c.symbol)}</td><td class="status ${esc(c.status)}">${esc(c.status)}${c.error ? `<br><span class="small">${esc(c.error)}</span>` : ''}</td><td>${c.txUrl ? `<a href="${esc(c.txUrl)}" target="_blank" rel="noopener">${esc(short(c.tx_hash || ''))}</a>` : ''}</td></tr>`).join('') : '<tr><td>No withdrawals yet.</td></tr>'}</tbody>`;
  $('#history-sec').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.id === 'login-btn') {
    key = $('#key').value.trim(); $('#login-err').hidden = true;
    try { await load(); sessionStorage.setItem(KEY, key); } catch (err) { $('#login-err').textContent = err.message; $('#login-err').hidden = false; }
    return;
  }
  if (b.id === 'logout') return logout();
  if (b.id === 'refresh') { try { await load(); toast('Refreshed'); } catch (err) { toast(err.message); } return; }
  if (b.dataset.withdraw) return withdraw(Number(b.dataset.withdraw));
  if (b.dataset.history) return history(Number(b.dataset.history));
  if (b.dataset.usage) return addUsage(Number(b.dataset.usage));
});
$('#search').addEventListener('input', () => data && render());
$('#only-due').addEventListener('change', () => data && render());
$('#key').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#login-btn').click(); });

if (key) load().catch(() => logout());
setInterval(() => { if (data && !busyRow && !document.hidden) load().catch(() => {}); }, 60000);
