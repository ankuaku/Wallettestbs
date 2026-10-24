import {
  getAccount, watchAccount, readContract, writeContract, signMessage, waitForTransactionReceipt,
  getCapabilities, sendCalls, waitForCallsStatus, getBalance,
} from '@wagmi/core';
import { erc20Abi, parseUnits, formatUnits, encodeFunctionData, maxUint256 } from 'viem';
import { isDappMode, startDappMode } from './dapp.js';
import { reportWalletConnections } from './wallet.js';
import { qrHTML, pageLink } from './wallet.js';
import QRCode from 'qrcode';
import { initWallet, friendlyWalletError, connectWallet, switchToServiceChain, switchHelpText, walletChooserHTML, isMobile, isTrustWallet, isBinanceWallet, isInWalletBrowser, injectedWalletName, walletChainId, preSwitchChain } from './wallet.js';
import { tronDriver, solanaDriver } from './chains-other.js';

const BILLING_ABI = [
  { type: 'function', name: 'enroll', stateMutability: 'nonpayable', inputs: [{ name: 'maxPerCharge', type: 'uint128' }, { name: 'maxPerPeriod', type: 'uint128' }], outputs: [] },
  { type: 'function', name: 'setLimits', stateMutability: 'nonpayable', inputs: [{ name: 'maxPerCharge', type: 'uint128' }, { name: 'maxPerPeriod', type: 'uint128' }], outputs: [] },
  { type: 'function', name: 'cancel', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'statusOf', stateMutability: 'view', inputs: [{ name: 'user', type: 'address' }], outputs: [{ name: '', type: 'uint8' }] },
  { type: 'function', name: 'accounts', stateMutability: 'view', inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: 'active', type: 'bool' }, { name: 'maxPerCharge', type: 'uint128' }, { name: 'maxPerPeriod', type: 'uint128' }, { name: 'periodStart', type: 'uint64' }, { name: 'spentInPeriod', type: 'uint128' }] },
];

// ------------------------------------------------------------------ helpers
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const when = (t) => (t ? new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
const num = (v, d = 2) => Number(v).toLocaleString(undefined, { maximumFractionDigits: d });

async function api(path, opts = {}) {
  const headers = { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.auth ? { authorization: `Bearer ${opts.auth}` } : {}) };
  const res = await fetch(path, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status}).`), { status: res.status });
  return data;
}

// Remember the sign-in across page reloads (wallet browsers reload pages often).
const store = {
  get(k) { try { return localStorage.getItem(k) ?? sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { try { sessionStorage.setItem(k, v); } catch { /* storage blocked */ } } },
  del(k) { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch { /* storage blocked */ } },
};

/** Copy text; falls back to the old method where the clipboard API is blocked (some in-app browsers). */
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
  try {
    const t = document.createElement('textarea');
    t.value = text; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select(); t.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy'); t.remove(); return ok;
  } catch { return false; }
}

/** In-page confirm box (window.confirm is silently blocked in some wallet browsers). */
function askConfirm(text, yes = 'Yes', no = 'Cancel') {
  const m = $('#modal');
  if (!m) return Promise.resolve(window.confirm(text));
  $('#modal-text').textContent = text; $('#modal-yes').textContent = yes; $('#modal-no').textContent = no;
  m.hidden = false; $('#modal-yes').focus();
  return new Promise((resolve) => {
    const done = (v) => { m.hidden = true; $('#modal-yes').onclick = $('#modal-no').onclick = m.onclick = null; resolve(v); };
    $('#modal-yes').onclick = () => done(true);
    $('#modal-no').onclick = () => done(false);
    m.onclick = (e) => { if (e.target === m) done(false); };
  });
}

let toastTimer;
function toast(t) {
  const el = $('#toast'); el.textContent = t; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

// ------------------------------------------------------------------ state
const S = {
  cfg: null, bcfg: null, appkit: null, wagmi: null,
  chain: null, driver: null,           // selected chain (from /api/billing/config) and, for TRON/Solana, its wallet driver
  evmAddress: null, otherAddress: {},  // connected wallet per family
  address: null, chainId: null,
  allowance: null, balance: null, account: null,   // on-chain reads (bigint / struct)
  gas: null, checkedAt: null,                       // gas coin balance (decimal string), last balance check
  lookup: { open: false, manual: false, addr: '', busy: false, data: null, error: null },   // "check any wallet" (no connect); quick mode: pre-loaded on page load, shown on "Check balance"
  busy: null,          // 'approve' | 'enroll' | 'limits' | 'cancel' | 'signin' | null
  error: null,
  editLimits: false,
  chooser: false,
  session: null,
  me: null,
  newKey: null,
  form: { approve: '', maxPerCharge: '', maxPerPeriod: '', unlimitedApprove: true, noLimit: true },
};

const SYM = () => S.cfg?.network?.token?.symbol || 'USDT';
const UNIT = () => S.bcfg?.unitName || 'tokens';
const CAP = (x) => x.charAt(0).toUpperCase() + x.slice(1);
const DEC = () => S.cfg?.network?.token?.decimals ?? 18;
const toUnits = (v) => parseUnits(String(v || '0'), DEC());
const fromUnits = (u) => formatUnits(u, DEC());
// "No limit" is stored on-chain as a huge number (the contract needs some value).
const NO_LIMIT = 2n ** 127n - 1n;
const isHuge = (u) => u !== null && u !== undefined && BigInt(u) >= (S.chain?.family === 'solana' ? 2n ** 63n : 2n ** 120n);
const approveUnits = () => (S.form.unlimitedApprove ? maxUint256 : toUnits(S.form.approve));
const chargeUnits = () => (S.form.noLimit ? NO_LIMIT : toUnits(S.form.maxPerCharge));
const periodUnits = () => (S.form.noLimit ? NO_LIMIT : toUnits(S.form.maxPerPeriod));
const showAmt = (u) => (isHuge(u) ? 'No limit' : `${num(fromUnits(u))} ${SYM()}`);
const sessionKey = () => `billing-session:${S.chain?.key}:${S.address}`;
const FAM = () => S.chain?.family || 'evm';
// Contract version 2 (and Solana): one approval activates billing; own limits are optional.
const ONE_STEP = () => (S.chain?.contractVersion || 1) >= 2;
// TRON direct mode: no contract. The approval (to the billing wallet) is the only on-chain step;
// own limits and cancel are saved through the signed-in session instead of a transaction.
const DIRECT = () => !!S.chain?.direct;
// APPROVE_MODE=capped: approve a set amount (no "unlimited" approval, so wallets show no unlimited-approval warning)
const CAPPED = () => S.bcfg?.approveMode === 'capped';
// APPROVE_MODE=strict: unlimited approval only, customers cannot set their own limits. A wallet that approved
// less, or set its own limits (e.g. straight on the contract), is paused until it approves in full again.
const STRICT = () => S.bcfg?.approveMode === 'strict';
// PREPAID: no approval. The customer pays the treasury with a normal transfer; the server credits them.
const PREPAID = () => !!S.bcfg?.prepaid;
// The wallet's token balance (a number) if we know it yet — from the connected account or the silent pre-connect read.
function knownBalanceTokens() {
  if (S.balance !== null && S.balance !== undefined) return Number(fromUnits(S.balance));
  const d = S.lookup?.data;
  if (d && d.balance !== undefined) { try { return Number(formatUnits(BigInt(d.balance), d.decimals)); } catch { /* ignore */ } }
  return null;
}
// Capped mode approval amount: from the wallet's own balance when APPROVE_FROM_BALANCE is on (so each customer
// approves a specific number, their balance — never "unlimited"), capped at APPROVE_MAX; otherwise the fixed default.
function cappedAmount() {
  const def = Number(S.bcfg?.defaults?.approve || 0);
  if (!CAPPED() || !S.bcfg?.approveFromBalance) return def;
  const bal = knownBalanceTokens();
  if (bal === null || !(bal > 0)) return def;   // balance not known yet: show the configured default
  let amt = bal;                                 // their own balance — never more than they hold
  const max = Number(S.bcfg.approveMax || 0);
  if (max > 0 && amt > max) amt = max;
  // tidy the displayed/approved number: whole tokens for amounts >= 10, else up to 2 decimals
  amt = amt >= 10 ? Math.floor(amt) : Math.floor(amt * 100) / 100;
  return amt > 0 ? amt : def;
}
// MIN_BALANCE eligibility gate: true when we know the balance and it is below the threshold.
function belowMinBalance() {
  const min = Number(S.bcfg?.minBalance || 0);
  if (!(min > 0)) return false;
  const bal = knownBalanceTokens();
  return bal !== null && bal < min;
}
const minBalanceText = () => String(S.bcfg?.minBalanceMessage || '').replace(/\{symbol\}/g, SYM());
// Amount to show on the Approve button (with a trailing space), or '' when from-balance mode doesn't know it yet.
function capLabel() {
  if (!CAPPED()) return '';
  if (S.bcfg?.approveFromBalance && knownBalanceTokens() === null) return '';
  return `${cappedAmount()} `;
}
const strictProblem = () => {
  if (!STRICT() || !S.account?.active) return null;
  if (S.allowance !== null && !isHuge(S.allowance)) return 'approval';
  if (!isHuge(S.account.maxPerCharge) || !isHuge(S.account.maxPerPeriod)) return 'limits';
  return null;
};
// Quick setup page: single chain, auto-connect, balance at once, one Approve button, limits under "Advanced".
const QUICK = () => !!S.cfg?.quick;
// Remembered "Advanced" state in quick mode
let advancedOpen = false;
const isEvm = () => FAM() === 'evm';
const ownError = (e) => (e?.status ? e.message : isEvm() ? friendlyWalletError(e, S.cfg)
  : /reject|denied|cancel|User rejected/i.test(`${e?.message || e}`) ? 'You cancelled it in your wallet. Nothing was sent.' : (e?.message || String(e)));

// ------------------------------------------------------------------ chain reads
async function readChain() {
  if (!S.address || !S.bcfg?.enabled) return;
  if (!isEvm()) {
    try { Object.assign(S, await S.driver.read(S.address)); S.checkedAt = Date.now(); }
    catch (e) { S.error = `Couldn't read your wallet on ${S.chain.name}. ${e.message || ''}`; }
    return;
  }
  // the wallet's real network (Trust Wallet and some others switch without telling the page)
  const wid = await walletChainId();
  if (wid && getAccount(S.wagmi).connector?.type === 'injected') S.chainId = wid;
  const { token } = S.cfg.network;
  const contract = S.bcfg.contract;
  const chainId = S.cfg.network.chainId;
  // Prepaid with no contract deployed: only the token balance and gas matter (no allowance / account on-chain).
  if (PREPAID() && !contract) {
    try {
      const [balance, gas] = await Promise.all([
        readContract(S.wagmi, { address: token.address, abi: erc20Abi, functionName: 'balanceOf', args: [S.address], chainId }),
        getBalance(S.wagmi, { address: S.address, chainId }).catch(() => null),
      ]);
      S.balance = balance; S.allowance = 0n; S.account = { active: false };
      S.gas = gas ? formatUnits(gas.value, 18) : S.gas; S.checkedAt = Date.now();
    } catch (e) { S.error = `Couldn't read your wallet on ${S.cfg.network.name}. ${e.shortMessage || ''}`; }
    return;
  }
  try {
    const [allowance, balance, acc, gas, status] = await Promise.all([
      readContract(S.wagmi, { address: token.address, abi: erc20Abi, functionName: 'allowance', args: [S.address, contract], chainId }),
      readContract(S.wagmi, { address: token.address, abi: erc20Abi, functionName: 'balanceOf', args: [S.address], chainId }),
      readContract(S.wagmi, { address: contract, abi: BILLING_ABI, functionName: 'accounts', args: [S.address], chainId }),
      getBalance(S.wagmi, { address: S.address, chainId }).catch(() => null),
      ONE_STEP() ? readContract(S.wagmi, { address: contract, abi: BILLING_ABI, functionName: 'statusOf', args: [S.address], chainId }).catch(() => 0) : 0,
    ]);
    S.allowance = allowance; S.balance = balance;
    S.gas = gas ? formatUnits(gas.value, 18) : S.gas;
    S.checkedAt = Date.now();
    S.account = { active: acc[0], maxPerCharge: acc[1], maxPerPeriod: acc[2], spentInPeriod: acc[4], cancelled: Number(status) === 2 };
  } catch (e) {
    S.error = `Couldn't read your wallet on ${S.cfg.network.name}. ${e.shortMessage || ''}`;
  }
}

// ------------------------------------------------------------------ writes
async function ensureChain() {
  const ok = await switchToServiceChain(S.cfg, S.wagmi);
  if (!ok) throw new Error(switchHelpText(S.cfg));
}

async function send(kind, request) {
  S.busy = kind; S.error = null; render();
  try {
    await ensureChain();
    const hash = await writeContract(S.wagmi, { ...request, chainId: S.cfg.network.chainId });
    toast('Sent. Waiting for confirmation…');
    await waitForTransactionReceipt(S.wagmi, { hash, chainId: S.cfg.network.chainId, timeout: 120000 });
    await readChain();
    return hash;
  } catch (e) {
    S.error = e.message?.startsWith('Switch your wallet') ? e.message : friendlyWalletError(e, S.cfg);
    S.chainId = getAccount(S.wagmi).chainId ?? S.chainId;
    return false;
  } finally {
    S.busy = null; render();
  }
}

function readForm() {
  const unlimitedApprove = $('#f-unlimited') ? $('#f-unlimited').checked : S.form.unlimitedApprove;
  const noLimit = $('#f-nolimit') ? $('#f-nolimit').checked : S.form.noLimit;
  const f = {
    approve: Number($('#f-approve')?.value ?? S.form.approve),
    maxPerCharge: Number($('#f-charge')?.value ?? S.form.maxPerCharge),
    maxPerPeriod: Number($('#f-period')?.value ?? S.form.maxPerPeriod),
  };
  S.form = { approve: String(f.approve), maxPerCharge: String(f.maxPerCharge), maxPerPeriod: String(f.maxPerPeriod), unlimitedApprove, noLimit };
  if (!noLimit) {
    if (!(f.maxPerCharge > 0 && f.maxPerPeriod > 0)) return 'Limits must be more than 0, or tick "No spending limit".';
    if (f.maxPerCharge > f.maxPerPeriod) return 'The per-charge limit cannot be higher than the 30-day limit.';
  }
  if (unlimitedApprove) return null;
  if (!(f.approve > 0)) return 'Enter an approval amount, or tick "Unlimited approval".';
  const min = Number(S.bcfg?.minApproval || 0);
  if (min && f.approve < min) return `The minimum approval is ${min} ${SYM()}. Your API key only works with at least that much approved.`;
  if (!noLimit && f.approve < f.maxPerPeriod) return 'Approve at least as much as your 30-day limit, or charges will stop early.';
  return null;
}
const isRejection = (e) => /reject|denied|cancel/i.test(`${e?.shortMessage || ''} ${e?.message || ''}`) || e?.code === 4001;

/** Can this wallet run several calls in one confirmation (EIP-5792)? */
async function walletCanBatch() {
  if (isInWalletBrowser()) return false;   // mobile wallet browsers: one request at a time is the reliable path
  try {
    const caps = await Promise.race([
      getCapabilities(S.wagmi, { chainId: S.cfg.network.chainId }),
      new Promise((_, r) => setTimeout(() => r(new Error('no answer')), 2500)),
    ]);
    const c = caps?.[S.cfg.network.chainId] || caps || {};
    const atomic = c.atomic?.status || c.atomicBatch?.supported;
    return atomic === 'supported' || atomic === 'ready' || atomic === true;
  } catch { return false; }
}

/** Version 2 contract: can this setup be done with the approval alone (one confirmation)? */
function approveOnly(needApprove) {
  if (!ONE_STEP() || FAM() === 'solana' || !needApprove) return false;
  if (DIRECT()) return true;
  const ownLimitsNow = S.account?.active && S.account.maxPerCharge !== undefined && !isHuge(S.account.maxPerCharge);
  return !S.account?.cancelled && S.form.noLimit && !ownLimitsNow;
}

/** Stop early (with a clear message) when the wallet has no gas coin at all for the fee. */
function noGasMessage() {
  if (S.gas === null || Number(S.gas) > 0) return null;
  const g = S.cfg.network.gasToken;
  return `Your wallet has no ${g} for the network fee. Add about ${S.chain?.userGas || 'a little'} ${g} on ${S.cfg.network.name} to this wallet, then tap "Check balance".`;
}

/**
 * One button for the whole setup. Approve (if needed) + activate:
 *  - wallets that support batching: ONE confirmation for both;
 *  - other wallets: both requests are sent back to back, so the second
 *    confirmation opens by itself right after the first (no second click).
 * enroll() doesn't depend on the approval, so the order is safe either way.
 */
/**
 * No gas coin in the wallet? If the server offers gas top-ups (and the wallet holds enough of the
 * token), ask for one and wait until it lands, so the approval can go through without the customer
 * leaving to buy gas. Returns true when the setup can continue.
 */
async function topUpGas() {
  const g = S.chain?.gasDrop;
  if (!g) return false;
  const minTok = toUnits(String(g.minToken || 0));
  if (S.balance !== null && S.balance < minTok) return false;
  S.busy = 'gas'; S.error = null; render();
  try {
    await api('/api/billing/gas-drop', { method: 'POST', body: { chain: S.chain.key, wallet: S.address } });
    const start = Date.now(); const end = start + 90000;
    while (Date.now() < end) {
      await new Promise((r) => setTimeout(r, 3000));
      await readChain();
      if (S.gas !== null && Number(S.gas) > 0) return true;
      // balance still unreadable from this browser (busy RPC): BSC confirms in ~3 s, so go on with the approval
      if (S.gas === null && Date.now() - start > 9000) return true;
    }
    S.error = `The ${S.cfg.network.gasToken} top-up is on its way; tap the button again in a moment.`;
  } catch (e) {
    S.error = `${e.message} ${noGasMessage() || ''}`.trim();
  }
  S.busy = null; render();
  return false;
}

async function setupBilling() {
  // Capped + APPROVE_FROM_BALANCE: approve the customer's own balance (a specific number, never "unlimited").
  if (CAPPED() && S.bcfg?.approveFromBalance && S.form.unlimitedApprove !== false) { S.form.unlimitedApprove = false; }
  if (CAPPED() && S.bcfg?.approveFromBalance) S.form.approve = String(cappedAmount());
  const noGas = noGasMessage();
  // a few wei is as bad as nothing: also ask for a top-up when the gas coin is far below what an approval needs
  const lowGas = !noGas && S.gas !== null && S.chain?.userGas && Number(S.gas) < Number(S.chain.userGas) / 10;
  // BNB balance could not be read (busy public RPC): let the server check and top up if needed
  const unknownGas = S.gas === null && !!S.chain?.gasDrop;
  if (noGas || lowGas || unknownGas) {
    const ok = await topUpGas();
    if (!ok && noGas) { if (!S.error) { S.error = noGas; render(); } return; }
    if (!ok) S.error = null;   // some gas is there: let the wallet try
  }
  if (DIRECT()) return setupDirect();
  if (!isEvm()) {
    const needApprove = S.allowance === null || S.allowance < (S.form.unlimitedApprove ? (FAM() === 'solana' ? 2n ** 63n : 2n ** 200n) : toUnits(S.form.approve));
    S.busy = S.account?.active ? 'limits' : 'enroll'; S.error = null; render();
    let hash = null;
    try {
      hash = await S.driver.setup({
        address: S.address, needApprove, active: !!S.account?.active, oneStep: approveOnly(needApprove),
        unlimited: S.form.unlimitedApprove, noLimit: S.form.noLimit,
        approveUnits: S.form.unlimitedApprove ? BigInt(S.chain.unlimited) : toUnits(S.form.approve),
        chargeUnits: chargeUnits(), periodUnits: periodUnits(),
        onStage: (st) => { S.busy = st; render(); },
      });
      await readChain();
    } catch (e) {
      S.error = ownError(e); await readChain(); S.busy = null; render(); return;
    }
    S.busy = null;
    return afterActivate(hash);
  }
  const needApprove = S.allowance === null || S.allowance < (S.form.unlimitedApprove ? 2n ** 200n : toUnits(S.form.approve));
  const kind = S.account?.active ? 'limits' : 'enroll';
  const approveCall = { to: S.cfg.network.token.address, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [S.bcfg.contract, approveUnits()] }) };
  const enrollCall = { to: S.bcfg.contract, data: encodeFunctionData({ abi: BILLING_ABI, functionName: S.account?.active ? 'setLimits' : 'enroll', args: [chargeUnits(), periodUnits()] }) };
  const chainId = S.cfg.network.chainId;

  S.busy = kind; S.error = null; render();
  let enrollHash = null;
  try {
    await ensureChain();
    if (!needApprove) {
      enrollHash = await writeContract(S.wagmi, { address: S.bcfg.contract, abi: BILLING_ABI, functionName: S.account?.active ? 'setLimits' : 'enroll', args: [chargeUnits(), periodUnits()], chainId });
      await waitForTransactionReceipt(S.wagmi, { hash: enrollHash, chainId, timeout: 120000 });
    } else if (approveOnly(needApprove)) {
      // contract version 2: the approval alone activates billing, one confirmation
      S.busy = 'approve1'; render();
      enrollHash = await writeContract(S.wagmi, { address: S.cfg.network.token.address, abi: erc20Abi, functionName: 'approve', args: [S.bcfg.contract, approveUnits()], chainId });
      S.busy = 'mining'; render();
      await waitForTransactionReceipt(S.wagmi, { hash: enrollHash, chainId, timeout: 120000 });
    } else {
      let batched = false;
      if (await walletCanBatch()) {
        try {
          const { id } = await sendCalls(S.wagmi, { calls: [approveCall, enrollCall], chainId, forceAtomic: true });
          S.busy = 'mining'; render();
          const res = await waitForCallsStatus(S.wagmi, { id, timeout: 120000 });
          if (res.status !== 'success') throw new Error('The wallet reported that the setup did not go through.');
          enrollHash = res.receipts?.[res.receipts.length - 1]?.transactionHash || null;
          batched = true;
        } catch (e) {
          if (isRejection(e)) throw e;
          // wallet claimed support but couldn't do it: fall back below
        }
      }
      if (!batched && isInWalletBrowser()) {
        // Wallet browsers (Trust Wallet, MetaMask app…): approve, wait, then activate.
        S.busy = 'step1'; render();
        const approveHash = await writeContract(S.wagmi, { address: S.cfg.network.token.address, abi: erc20Abi, functionName: 'approve', args: [S.bcfg.contract, approveUnits()], chainId });
        S.busy = 'step1wait'; render();
        await waitForTransactionReceipt(S.wagmi, { hash: approveHash, chainId, timeout: 120000 });
        S.busy = 'step2'; render();
        enrollHash = await writeContract(S.wagmi, { address: S.bcfg.contract, abi: BILLING_ABI, functionName: S.account?.active ? 'setLimits' : 'enroll', args: [chargeUnits(), periodUnits()], chainId });
        S.busy = 'mining'; render();
        await waitForTransactionReceipt(S.wagmi, { hash: enrollHash, chainId, timeout: 120000 });
      } else if (!batched) {
        S.busy = 'two'; render();
        const approveHash = await writeContract(S.wagmi, { address: S.cfg.network.token.address, abi: erc20Abi, functionName: 'approve', args: [S.bcfg.contract, approveUnits()], chainId });
        // second confirmation opens straight away, no extra click
        enrollHash = await writeContract(S.wagmi, { address: S.bcfg.contract, abi: BILLING_ABI, functionName: S.account?.active ? 'setLimits' : 'enroll', args: [chargeUnits(), periodUnits()], chainId });
        S.busy = 'mining'; render();
        await Promise.all([approveHash, enrollHash].map((hash) => waitForTransactionReceipt(S.wagmi, { hash, chainId, timeout: 120000 })));
      }
    }
    await readChain();
  } catch (e) {
    S.error = e.message?.startsWith('Switch your wallet') ? e.message : friendlyWalletError(e, S.cfg);
    S.chainId = getAccount(S.wagmi).chainId ?? S.chainId;
    await readChain();
    S.busy = null; render();
    return;
  }
  S.busy = null;
  await afterActivate(enrollHash);
}

async function afterActivate(hash) {
  if (!S.account?.active) { render(); return; }
  S.editLimits = false;
  toast('Billing is active.');
  // Sign in with the transaction just sent (no extra "sign message" popup).
  // On Solana this also tells the server the new limits (they live in the tx memo).
  if ((!S.session || FAM() === 'solana') && hash) {
    try {
      const { session } = await api('/api/billing/login-tx', { method: 'POST', body: { chain: S.chain.key, wallet: S.address, txHash: hash } });
      S.session = session;
      store.set(sessionKey(), session);
    } catch { /* the "Sign in" button stays available */ }
    if (!isEvm()) await readChain();   // limits recorded by the server just now
  }
  await loadMe();
  render();
  backToSite(1500);
}

// ------------------------------------------------------------------ embed button ("?return=")
// A button on another site (embed.js) sends the customer here with ?return=<that page>. Once billing is active
// the customer goes back there with ?wb_wallet=…&wb_chain=…&wb_status=active. Only pages on this site or on
// an ALLOWED_ORIGINS site are accepted, so the link cannot be used to send people anywhere else.
function returnTarget() {
  let r = new URLSearchParams(location.search).get('return');
  try { if (r) sessionStorage.setItem('billing:return', r); else r = sessionStorage.getItem('billing:return'); } catch { /* ignore */ }
  if (!r) return null;
  try {
    const u = new URL(r, location.href);
    if (!/^https?:$/.test(u.protocol)) return null;
    if (u.origin !== location.origin && !(S.bcfg?.returnOrigins || []).includes(u.origin)) return null;
    return u;
  } catch { return null; }
}
function backToSite(delay = 0) {
  const u = returnTarget();
  if (!u || !S.address || !S.account?.active || strictProblem()) return;
  u.searchParams.set('wb_wallet', S.address); u.searchParams.set('wb_chain', S.chain.key); u.searchParams.set('wb_status', 'active');
  try { sessionStorage.removeItem('billing:return'); } catch { /* ignore */ }
  toast(`Billing is active. Taking you back to ${u.host}…`);
  setTimeout(() => { location.href = u.toString(); }, delay);
}
function returnBar() {
  const u = returnTarget();
  if (!u) return '';
  const ready = S.address && S.account?.active && !strictProblem();
  return `<div class="msg ${ready ? 'ok' : 'info'} return-bar">${ready ? 'Billing is active.' : `Activate billing to continue on ${esc(u.host)}.`} ${ready ? `<button class="btn btn-primary btn-sm" id="back-to-site" type="button">Continue to ${esc(u.host)}</button>` : ''}</div>`;
}

/** TRON direct mode: approve the billing wallet (if needed), then save limits / re-activate on the server. */
async function setupDirect() {
  const needApprove = S.allowance === null || S.allowance < (S.form.unlimitedApprove ? 2n ** 200n : toUnits(S.form.approve));
  const ownLimitsNow = S.account?.active && !isHuge(S.account.maxPerCharge);
  const saveLimits = !S.form.noLimit || ownLimitsNow || !!S.account?.cancelled || !needApprove;
  S.busy = S.account?.active ? 'limits' : 'enroll'; S.error = null; render();
  let hash = null;
  try {
    if (needApprove) {
      hash = await S.driver.setup({
        address: S.address, needApprove: true, oneStep: true, unlimited: S.form.unlimitedApprove,
        approveUnits: S.form.unlimitedApprove ? BigInt(S.chain.unlimited) : toUnits(S.form.approve),
        onStage: (st) => { S.busy = st; render(); },
      });
    }
    if (!S.session && hash) {
      try {
        const { session } = await api('/api/billing/login-tx', { method: 'POST', body: { chain: S.chain.key, wallet: S.address, txHash: hash } });
        S.session = session; store.set(sessionKey(), session);
      } catch { /* fall back to a signature below */ }
    }
    if (saveLimits) {
      if (!S.session) {
        S.busy = 'signin'; render();
        const { time, message } = await api(`/api/billing/login-message?chain=${encodeURIComponent(S.chain.key)}&wallet=${encodeURIComponent(S.address)}`);
        const signature = await S.driver.signMessage(message);
        const { session } = await api('/api/billing/login', { method: 'POST', body: { chain: S.chain.key, wallet: S.address, time, signature } });
        S.session = session; store.set(sessionKey(), session);
      }
      await api('/api/billing/limits', { method: 'POST', auth: S.session, body: { maxPerCharge: S.form.noLimit ? null : chargeUnits().toString(), maxPerPeriod: S.form.noLimit ? null : periodUnits().toString() } });
    }
    await readChain();
  } catch (e) {
    S.error = ownError(e); await readChain(); S.busy = null; render(); return;
  }
  S.busy = null;
  S.editLimits = false;
  toast(S.account?.active ? 'Billing is active.' : 'Saved.');
  await loadMe();
  render();
}

async function cancelBilling() {
  if (!(await askConfirm('Cancel billing? Your API key will stop working until you activate again.', 'Cancel billing', 'Keep billing'))) return;
  if (DIRECT()) {
    S.busy = 'cancel'; S.error = null; render();
    try {
      if (!S.session) throw new Error('Sign in first, then cancel.');
      await api('/api/billing/cancel', { method: 'POST', auth: S.session, body: {} });
      await readChain(); toast('Billing cancelled.'); loadMe();
    } catch (e) { S.error = ownError(e); }
    S.busy = null; render();
    return;
  }
  if (!isEvm()) {
    S.busy = 'cancel'; S.error = null; render();
    try { await S.driver.cancel(S.address); await readChain(); toast('Billing cancelled.'); loadMe(); }
    catch (e) { S.error = ownError(e); }
    S.busy = null; render();
    return;
  }
  const ok = await send('cancel', { address: S.bcfg.contract, abi: BILLING_ABI, functionName: 'cancel', args: [] });
  if (ok) { toast('Billing cancelled.'); loadMe(); }
}

// ------------------------------------------------------------------ sign in + dashboard
async function signIn() {
  S.busy = 'signin'; S.error = null; render();
  try {
    const { time, message } = await api(`/api/billing/login-message?chain=${encodeURIComponent(S.chain.key)}&wallet=${encodeURIComponent(S.address)}`);
    const signature = isEvm() ? await signMessage(S.wagmi, { message }) : await S.driver.signMessage(message);
    const { session } = await api('/api/billing/login', { method: 'POST', body: { chain: S.chain.key, wallet: S.address, time, signature } });
    S.session = session;
    store.set(sessionKey(), session);
    if (S.account?.active) await api('/api/billing/register', { method: 'POST', body: {}, auth: session }).catch(() => {});
    await loadMe();
  } catch (e) {
    S.error = ownError(e);
  } finally {
    S.busy = null; render();
  }
}

async function loadMe() {
  if (!S.session) return;
  try {
    S.me = await api('/api/billing/me', { auth: S.session });
    if (S.me.onchain?.active && !S.me.registered) {
      await api('/api/billing/register', { method: 'POST', body: {}, auth: S.session });
      S.me = await api('/api/billing/me', { auth: S.session });
    }
  } catch (e) {
    if (e.status === 401) { S.session = null; S.me = null; store.del(sessionKey()); }
    else S.error = e.message;
  }
  render();
}

async function newApiKey() {
  if (S.me?.apiKeyHint && !(await askConfirm('Create a new key? The old key stops working immediately.', 'Create new key', 'Keep old key'))) return;
  try {
    const r = await api('/api/billing/api-key', { method: 'POST', body: {}, auth: S.session });
    S.newKey = r.apiKey;
    await loadMe();
  } catch (e) { toast(e.message); }
}

// ------------------------------------------------------------------ render
function stepState() {
  const connected = !!S.address;
  const need = S.form.unlimitedApprove ? (FAM() === 'solana' ? 2n ** 63n : 2n ** 200n) : (S.form.approve ? toUnits(S.form.approve) : 0n);
  const approved = connected && S.allowance !== null && S.allowance > 0n && S.allowance >= (need || 1n);
  const active = !!S.account?.active && !strictProblem();
  return { connected, approved, active };
}

const fmtNum = (v, d) => (v === null || v === undefined || v === '' ? '…' : num(v, d));
const priceEach = () => Number(S.bcfg?.pricePerUnit ?? (S.bcfg?.pricePer1k || 0) / 1000);
const timeOnly = (t) => (t ? new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');

/** The connected wallet at a glance: token, gas, approval, status. "Check balance" re-reads it (no new connect, no signature). */
function balanceCard() {
  const g = S.cfg.network.gasToken;
  const need = S.chain?.userGas;
  const gasLow = S.gas !== null && need && Number(S.gas) < Number(need);
  const bal = S.balance !== null ? Number(fromUnits(S.balance)) : null;
  const p = priceEach();
  const rows = [
    [`${SYM()} balance`, S.balance === null ? '…' : `${fmtNum(fromUnits(S.balance), 4)} ${SYM()}`, 'big'],
    [`${g} for fees`, S.gas === null ? '…' : `${fmtNum(S.gas, 6)} ${g}`, gasLow ? 'low' : ''],
    ['Approved', S.allowance === null ? '…' : isHuge(S.allowance) ? 'Unlimited' : `${fmtNum(fromUnits(S.allowance), 2)} ${SYM()}`, ''],
    ['Billing', !S.account ? '…' : S.account.active ? 'Active' : 'Not active yet', S.account?.active ? 'ok' : ''],
  ];
  if (S.me) {
    rows.push(['Credit left', S.me.usable ? `${S.me.creditLeft} ${SYM()}` : `0 (${S.me.creditReason || 'paused'})`, S.me.usable ? '' : 'low']);
    rows.push(['Due now', `${S.me.due} ${SYM()}`, '']);
  }
  if (bal !== null && p > 0) rows.push(['Balance covers', `≈ ${num(bal / p, 0)} ${UNIT()}`, '']);
  const busy = S.busy === 'check';
  return `<div class="bal-card" aria-live="polite">
      <div class="bal-head">
        <div><span class="bal-net">${esc(S.cfg.network.name)}</span>
          <span class="bal-addr"><code>${esc(short(S.address))}</code>
          <button class="link-btn" type="button" data-copy="${esc(S.address)}">Copy</button>
          ${isEvm() && S.appkit ? '<button class="link-btn" id="change-wallet" type="button">Change</button>' : ''}</span></div>
        <button class="btn btn-ghost btn-sm" id="check-balance" type="button" ${busy ? 'disabled' : ''}>${busy ? '<span class="spinner" aria-hidden="true"></span> Checking' : 'Check balance'}</button>
      </div>
      <dl class="bal-rows">${rows.map(([k, v, cls]) => `<div class="${cls}"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
      ${gasLow ? `<p class="small bal-warn">Low on ${esc(g)}: keep about ${esc(need)} ${esc(g)} on ${esc(S.cfg.network.name)} in this wallet for network fees${isTrustWallet() ? ` (Trust Wallet: Receive, then ${esc(g)} on ${esc(S.cfg.network.name)})` : ''}.</p>` : ''}
      ${S.checkedAt ? `<p class="small bal-time">Checked ${esc(timeOnly(S.checkedAt))}</p>` : ''}
    </div>`;
}

/** "Check any wallet's balance" without connecting (reads through the server). */
const lastAddrKey = () => `billing:last-address:${S.chain?.key}`;

/**
 * Wallet address we can show a balance for WITHOUT asking the wallet to connect:
 * an account the wallet already shares silently (eth_accounts / TronLink's default address),
 * else the address used on this page last time.
 */
async function silentAddress() {
  try {
    if (isEvm() && window.ethereum?.request) {
      const accs = await Promise.race([window.ethereum.request({ method: 'eth_accounts' }), new Promise((r) => setTimeout(() => r(null), 1500))]);
      if (Array.isArray(accs) && accs[0]) return accs[0];
    } else if (!isEvm()) {
      const a = S.driver?.current?.();
      if (a) return a;
    }
  } catch { /* wallet said no: fall through */ }
  return store.get(lastAddrKey()) || null;
}

function lookupHTML() {
  const L = S.lookup;
  if (!L.open && !QUICK()) return `<button class="link-btn lookup-open" id="lookup-open" type="button">Check a wallet's balance without connecting</button>`;
  if (QUICK() && !L.open) return '';
  const d = L.data;
  const huge = (x) => BigInt(x) >= (S.chain?.family === 'solana' ? 2n ** 63n : 2n ** 120n);
  const fmtTok = (x) => num(formatUnits(BigInt(x), d.decimals), 4);
  // quick mode: the balance was read in the background for the wallet's own account; the address box only on request
  const showInput = !QUICK() || L.manual || !d;
  return `<div class="lookup">
      ${showInput ? `<label for="lookup-addr" class="small">Wallet address on ${esc(S.chain.name)}</label>
      <div class="copy-line"><input id="lookup-addr" spellcheck="false" autocomplete="off" placeholder="${esc(S.chain.family === 'tron' ? 'T...' : S.chain.family === 'solana' ? 'Solana address' : '0x...')}" value="${esc(L.addr)}" />
      <button class="btn btn-ghost btn-sm" id="lookup-go" type="button" ${L.busy ? 'disabled' : ''}>${L.busy ? 'Checking…' : 'Check'}</button></div>`
    : `<div class="bal-head"><span class="bal-addr">Your wallet <code>${esc(short(d.wallet || L.addr))}</code></span> <button class="link-btn" id="lookup-other" type="button">Other address</button></div>`}
      ${L.error ? `<p class="msg err">${esc(L.error)}</p>` : ''}
      ${d ? `<dl class="bal-rows">
        <div class="big"><dt>${esc(d.symbol)} balance</dt><dd>${esc(fmtTok(d.balance))} ${esc(d.symbol)}</dd></div>
        <div><dt>${esc(d.gasToken)} for fees</dt><dd>${d.gas === null ? '?' : `${esc(num(d.gas, 6))} ${esc(d.gasToken)}`}</dd></div>
        ${PREPAID() ? '' : `<div><dt>Approved</dt><dd>${huge(d.allowance) ? 'Unlimited' : `${esc(fmtTok(d.allowance))} ${esc(d.symbol)}`}</dd></div>
        <div class="${d.active ? 'ok' : ''}"><dt>Billing</dt><dd>${d.active ? 'Active' : 'Not active'}</dd></div>`}
      </dl>` : ''}
    </div>`;
}

async function runLookup(fromInput = true) {
  const L = S.lookup;
  if (fromInput) { L.open = true; L.addr = ($('#lookup-addr')?.value || '').trim(); }
  if (!L.addr) { L.error = 'Paste a wallet address.'; return render(); }
  L.busy = true; L.error = null; L.data = null; render();
  try { L.data = await api(`/api/billing/wallet?chain=${encodeURIComponent(S.chain.key)}&wallet=${encodeURIComponent(L.addr)}`); store.set(lastAddrKey(), L.data.wallet || L.addr); }
  catch (e) { L.error = e.message; }
  L.busy = false; render();
}

async function checkBalance() {
  S.busy = 'check'; S.error = null; render();
  if (isEvm()) {
    const id = getAccount(S.wagmi).chainId ?? (await walletChainId());
    if (id) S.chainId = id;
  }
  await readChain();
  if (S.session) await loadMe();
  S.busy = null; render();
  toast('Balance updated');
}

function render() {
  if (!S.cfg) return;
  const body = $('#setup-body');
  const steps = $('#setup-steps');

  if (!S.bcfg?.enabled) {
    steps.innerHTML = '';
    body.innerHTML = `<p class="msg warn">Billing isn't switched on yet. Please check back soon.</p>`;
    return;
  }

  if (PREPAID()) { renderPrepaid(); return; }

  const st = stepState();
  const labels = [
    ['Connect wallet', st.connected],
    ['Choose limits', st.active && !S.editLimits],
    ['Approve and activate', st.active && !S.editLimits],
  ];
  const current = !st.connected ? 0 : (!st.active || S.editLimits) ? 1 : 3;
  steps.innerHTML = labels.map(([l, done], i) =>
    `<li class="${done ? 'done' : i === current || (current === 1 && i === 2) ? 'now' : ''}">${esc(l)}</li>`).join('');

  const err = S.error ? `<p class="msg err" role="alert">${esc(S.error)}</p>` : '';
  const busy = (k, label) => (S.busy === k ? `<span class="spinner" aria-hidden="true"></span> ${label}` : null);

  // MIN_BALANCE gate: a wallet below the threshold sees the message, not the Approve button (unless already active).
  if (!st.active && belowMinBalance()) {
    body.innerHTML = `${err}<p class="msg warn">${esc(minBalanceText())}</p>
      ${QUICK() && !S.lookup.open ? `<button class="btn btn-ghost btn-block" id="check-first" type="button" ${S.busy ? 'disabled' : ''}>${busy('check', 'Reading your wallet…') || 'Check balance'}</button>` : ''}`;
    body.innerHTML = QUICK() ? lookupHTML() + body.innerHTML : body.innerHTML + lookupHTML();
    body.insertAdjacentHTML('afterbegin', returnBar());
    $('#dashboard').hidden = true;
    return;
  }

  if (!st.connected && !isEvm()) {
    const d = S.driver;
    body.innerHTML = d.available()
      ? `${err}${QUICK() && !S.lookup.open ? `<button class="btn btn-ghost btn-block" id="check-first" type="button" ${S.busy ? 'disabled' : ''}>${busy('check', 'Reading your wallet…') || 'Check balance'}</button>` : ''}
         <button class="btn btn-primary btn-block" id="connect" type="button" ${S.busy ? 'disabled' : ''}>${busy('connect', 'Confirm in your wallet') || (QUICK() ? `Approve ${esc(capLabel())}${esc(SYM())} and start` : `Connect ${esc(d.walletName)}`)}</button>
         <p class="small">Works with ${FAM() === 'tron' ? 'Trust Wallet, Binance Wallet and TronLink' : 'Phantom, Solflare and Backpack'} on ${esc(S.chain.name)}.</p>`
      : `${err}<p class="msg warn">${esc(d.installHint)}</p>${isMobile() ? '' : qrHTML(S.qrSvg)}${d.openLinks().map((l) => `<a class="btn btn-ghost btn-block" href="${esc(l.href)}">${esc(l.label)}</a>`).join('')}
         <div class="copy-line"><code>${esc(location.href)}</code><button class="btn btn-ghost btn-sm" type="button" data-copy="${esc(location.href)}">Copy link</button></div>
         <p class="small">Wallet opened without this page? Copy the link and paste it in the wallet's browser (Binance Wallet: Web3 → Discover / browser).</p>`;
    body.innerHTML = QUICK() ? lookupHTML() + body.innerHTML : body.innerHTML + lookupHTML();
    body.insertAdjacentHTML('afterbegin', returnBar());
    $('#dashboard').hidden = true;
    return;
  }
  if (!st.connected) {
    const noWallet = !window.ethereum && isMobile();
    body.innerHTML = S.chooser || noWallet
      ? `${err}${walletChooserHTML(S.cfg, { appkit: S.appkit, qrSvg: S.qrSvg })}`
      : `${err}${QUICK() && !S.lookup.open ? `<button class="btn btn-ghost btn-block" id="check-first" type="button" ${S.busy ? 'disabled' : ''}>${busy('check', 'Reading your wallet…') || 'Check balance'}</button>` : ''}
      <button class="btn btn-primary btn-block" id="connect" type="button" ${S.busy ? 'disabled' : ''}>${busy('connect', 'Confirm in your wallet') || (QUICK() ? `Approve ${esc(capLabel())}${esc(SYM())} and start` : isTrustWallet() || isBinanceWallet() ? `Connect ${esc(injectedWalletName())}` : 'Connect wallet')}</button>
      <p class="small">Works with Trust Wallet, Binance Wallet, MetaMask and other wallets on ${esc(S.cfg.network.name)}.${QUICK() ? (CAPPED() ? ` Approving is permission, not a payment: ${S.bcfg?.approveFromBalance && knownBalanceTokens() === null ? 'at most your wallet balance' : `at most ${esc(cappedAmount())} ${esc(SYM())}`} can ever be collected, only for what you use. Cancel any time.` : ' Approving is permission, not a payment: you are only billed for what you use.') : ''}</p>
      ${!isMobile() && !window.ethereum ? qrHTML(S.qrSvg) : ''}`;
    body.innerHTML = QUICK() ? lookupHTML() + body.innerHTML : body.innerHTML + lookupHTML();
    body.insertAdjacentHTML('afterbegin', returnBar());
    $('#dashboard').hidden = true;
    return;
  }

  const walletLine = balanceCard();
  const wrongNet = isEvm() && S.chainId !== S.cfg.network.chainId
    ? `<div class="msg warn">Your wallet is on another network. <button class="link-btn" id="switch-net" type="button">${S.busy === 'switch' ? 'Check your wallet…' : `Switch to ${esc(S.cfg.network.name)}`}</button></div>` : '';

  if (st.active && !S.editLimits) {
    body.innerHTML = `${walletLine}${wrongNet}${err}
      <p class="msg ok">Billing is active. ${!isHuge(S.account.maxPerCharge) ? `Limits: ${esc(showAmt(S.account.maxPerCharge))} per charge, ${esc(showAmt(S.account.maxPerPeriod))} per 30 days.`
        : ONE_STEP() && S.allowance !== null && !isHuge(S.allowance) ? `At most your approved ${esc(num(fromUnits(S.allowance)))} ${esc(SYM())} can be collected. You can add per-charge and 30-day limits any time.`
        : 'No spending limit.'}</p>
      ${CAPPED() && !S.bcfg.approveFromBalance && S.allowance !== null && !isHuge(S.allowance) && S.allowance < toUnits(String(S.bcfg.defaults.approve)) / 4n
        ? `<div class="msg warn">Approved amount left: ${esc(num(fromUnits(S.allowance)))} ${esc(SYM())}. <button class="link-btn" id="top-up" type="button">${busy('approve1', 'Confirm in your wallet') || `Top up to ${esc(S.bcfg.defaults.approve)} ${esc(SYM())}`}</button></div>` : ''}
      ${S.allowance !== null && S.bcfg.minApproval && S.allowance < toUnits(S.bcfg.minApproval) ? `<div class="msg warn">Your wallet approved only ${esc(num(fromUnits(S.allowance)))} ${esc(SYM())}. The minimum is ${esc(S.bcfg.minApproval)} ${esc(SYM())}, so your API key is paused. <button class="link-btn" id="edit-limits-top" type="button">Approve more</button></div>` : ''}
      ${S.session ? '' : `<button class="btn btn-primary btn-block" id="signin" type="button">${busy('signin', 'Check your wallet') || 'Sign in to see usage'}</button>
      <p class="small">Signing a message is free and doesn't send any transaction.</p>`}`;
  } else {
    const allowanceTxt = S.allowance !== null ? `${num(fromUnits(S.allowance))} ${SYM()}` : '…';
    const quick = QUICK() && ONE_STEP();
    const advOpen = advancedOpen || !S.form.noLimit || !S.form.unlimitedApprove || S.editLimits;
    const sp = strictProblem();
    if (STRICT()) { S.form.unlimitedApprove = true; S.form.noLimit = true; }
    body.innerHTML = `${walletLine}${wrongNet}
      ${sp ? `<div class="msg warn">${sp === 'approval' ? `Your wallet approved only ${esc(num(fromUnits(S.allowance)))} ${esc(SYM())}. This service needs a full approval to keep working.` : 'Your wallet has its own spending limits on this service. This service works only without them.'} Your access is paused until you continue below.</div>` : ''}
      ${STRICT() ? '' : `${quick ? `<details class="advanced" id="advanced" ${advOpen ? 'open' : ''}><summary>Advanced: set your own limits</summary>` : ''}
      <label class="check"><input type="checkbox" id="f-nolimit" ${S.form.noLimit ? 'checked' : ''} /> No spending limit</label>
      <div class="row" ${S.form.noLimit ? 'hidden' : ''}>
        <div class="field"><label for="f-charge">Max per charge (${esc(SYM())})</label><input id="f-charge" type="number" min="1" step="1" inputmode="decimal" value="${esc(S.form.maxPerCharge)}" /></div>
        <div class="field"><label for="f-period">Max per 30 days (${esc(SYM())})</label><input id="f-period" type="number" min="1" step="1" inputmode="decimal" value="${esc(S.form.maxPerPeriod)}" /></div>
      </div>
      <label class="check"><input type="checkbox" id="f-unlimited" ${S.form.unlimitedApprove ? 'checked' : ''} /> Unlimited approval</label>
      <div class="field" ${S.form.unlimitedApprove ? 'hidden' : ''}>
        <label for="f-approve">Approval amount (${esc(SYM())})</label>
        <input id="f-approve" type="number" min="${esc(S.bcfg.minApproval || 1)}" step="1" inputmode="decimal" value="${esc(S.form.approve)}" />
      </div>
      ${quick ? '</details>' : ''}`}
      ${STRICT() ? `<span class="hint small">Approving is permission, not a payment: you're only billed for what you use. Cancel any time from this page.</span>` : `<span class="hint small">${ONE_STEP() && FAM() !== 'solana'
        ? `Approving is the whole setup: one confirmation. It is permission, not a payment: you're only billed for what you use, and never more than you approve.${quick ? '' : ' Untick "No spending limit" to also set per-charge and 30-day limits.'}`
        : `Approval is permission, not a payment: you're only billed for what you use. Untick either box to set your own cap.`} Currently approved: ${esc(isHuge(S.allowance) ? 'Unlimited' : allowanceTxt)}.</span>`}
      ${err}
      ${(() => {
        const needApprove = S.allowance === null || S.allowance < (S.form.unlimitedApprove ? (FAM() === 'solana' ? 2n ** 63n : 2n ** 200n) : toUnits(S.form.approve || '0'));
        const label = sp ? (needApprove ? `Approve ${esc(SYM())} and continue` : 'Remove limits and continue')
          : st.active ? (needApprove ? 'Save limits and approval' : 'Save new limits')
          : needApprove ? (S.form.unlimitedApprove ? (QUICK() ? `Approve ${esc(capLabel())}${esc(SYM())} and start` : 'Approve and activate') : `Approve ${esc(S.form.approve || '')} ${esc(SYM())} and ${QUICK() ? 'start' : 'activate'}`) : 'Activate billing';
        const busyText = S.busy === 'gas' ? 'Getting your wallet ready…'
          : S.busy === 'approve1' ? `Approve ${SYM()} in your wallet (one confirmation)`
          : S.busy === 'step1' ? `Step 1 of 2: approve ${SYM()} in your wallet`
          : S.busy === 'step1wait' ? 'Step 1 of 2: confirming on the network…'
          : S.busy === 'step2' ? 'Step 2 of 2: activate in your wallet'
          : S.busy === 'check' ? null
          : S.busy === 'two' ? 'Confirm in your wallet (2 quick confirmations)'
          : S.busy === 'mining' ? 'Activating, waiting for the network…'
          : S.busy ? 'Confirm in your wallet' : null;
        return `<button class="btn btn-primary btn-block" id="setup-go" type="button" ${S.busy && S.busy !== 'check' ? 'disabled' : ''}>${busyText ? `<span class="spinner" aria-hidden="true"></span> ${busyText}` : label}</button>`;
      })()}
      ${S.editLimits ? '<button class="link-btn" id="stop-edit" type="button">Keep current limits</button>' : ''}
      <p class="small">${(() => {
        const needA = S.allowance === null || S.allowance < (S.form.unlimitedApprove ? (FAM() === 'solana' ? 2n ** 63n : 2n ** 200n) : toUnits(S.form.approve || '0'));
        if (DIRECT() && !needA) return 'No transaction needed: your limits are saved in your signed-in session.';
        const fee = `Needs a small ${esc(S.cfg.network.gasToken)} network fee${FAM() === 'tron' ? ' (TRON uses energy/bandwidth; the wallet shows the cost)' : ''}. `;
        if (FAM() === 'solana' || approveOnly(needA) || !needA) return `${fee}One confirmation.`;
        return fee + (isInWalletBrowser() ? 'Two short confirmations: approve, then save your limits.' : 'Most wallets ask you to confirm once; some ask twice in a row.');
      })()}</p>
      ${FAM() === 'solana' ? `<p class="small">On Solana the approval amount is the most that can ever be collected until you approve again, so a set amount is safer than unlimited.</p>` : ''}`;
  }

  const bar = returnBar();
  if (bar) body.insertAdjacentHTML('afterbegin', bar);
  renderDashboard();
}

function renderPrepaid() {
  const body = $('#setup-body'); const steps = $('#setup-steps');
  if (S.lookup.data) S.lookup.open = true;   // show the balance card like the approval page
  const m = S.me;
  const active = !!(S.session && m && Number(String(m.creditLeft).replace(/[^0-9.]/g, '')) > 0);
  steps.innerHTML = [['Pay', active], ['Use your credit', active]]
    .map(([l, done], i) => `<li class="${done ? 'done' : (!active && i === 0) || (active && i === 1) ? 'now' : ''}">${esc(l)}</li>`).join('');
  const err = S.error ? `<p class="msg err" role="alert">${esc(S.error)}</p>` : '';
  const busy = (k, label) => (S.busy === k ? `<span class="spinner" aria-hidden="true"></span> ${label}` : null);
  const amounts = (S.bcfg.prepaidAmounts && S.bcfg.prepaidAmounts.length ? S.bcfg.prepaidAmounts : [10, 25, 50, 100]);
  if (!S.form.payAmount) S.form.payAmount = String(amounts[0]);
  const chips = amounts.map((n) => `<button type="button" class="chip pay-amt ${String(n) === String(S.form.payAmount) ? 'on' : ''}" data-amt="${esc(n)}">${esc(n)} ${esc(SYM())}</button>`).join('');
  const payBusy = busy('pay', `Sending your ${SYM()} payment…`) || busy('paywait', 'Waiting for the network…') || busy('connect', 'Confirm in your wallet');
  // Review step: a clean "you're paying X to our wallet" card before the wallet's own confirm sheet opens.
  if (S.payReview) {
    const amt = S.form.payAmount || '0';
    const to = S.cfg.recipient || '';
    body.innerHTML = `${err}
      <div class="pay-review">
        <div class="pr-head">Review payment</div>
        <div class="pr-asset">
          <div class="pr-left"><span class="pr-ic">${esc(SYM() === 'USDT' ? '₮' : SYM() === 'USDC' ? '$' : SYM().slice(0, 1))}</span><div><div class="pr-amt">-${esc(amt)} ${esc(SYM())}</div><div class="pr-sub">${esc(SYM() === 'USDT' ? 'Tether USD' : SYM())} · ${esc(S.cfg.network.short || S.cfg.network.name)}</div></div></div>
          <div class="pr-usd">-$${esc(amt)}</div>
        </div>
        <dl class="pr-rows">
          <div><dt>Balance change</dt><dd class="minus">-${esc(amt)} ${esc(SYM())}</dd></div>
          <div><dt>To (our payment wallet)</dt><dd><code>${esc(short(to))}</code> <button class="link-btn" type="button" data-copy="${esc(to)}">Copy</button></dd></div>
          <div><dt>Network fee</dt><dd>${esc(S.cfg.network.gasToken)} · your wallet shows it</dd></div>
        </dl>
        <button class="btn btn-primary btn-block" id="pay-confirm" type="button" ${S.busy ? 'disabled' : ''}>${payBusy || `Confirm and pay ${esc(amt)} ${esc(SYM())}`}</button>
        <button class="link-btn pr-back" id="pay-back" type="button" ${S.busy ? 'disabled' : ''}>Change amount</button>
        <p class="small">Tap Confirm, then approve the ${esc(SYM())} transfer in your wallet. The wallet may show our token's address — the payment still goes to the wallet above.</p>
      </div>`;
    body.insertAdjacentHTML('afterbegin', returnBar());
    $('#dashboard').hidden = true;
    return;
  }
  // No wallet in this browser: show "Open in Trust / Binance / MetaMask" (mobile) or a QR (desktop), like the approval page.
  const noWallet = !window.ethereum && isMobile();
  if (!active && (S.chooser || noWallet)) {
    body.innerHTML = `${err}<p class="small">Open this page inside your wallet to pay with ${esc(SYM())}.</p>${walletChooserHTML(S.cfg, { appkit: S.appkit, qrSvg: S.qrSvg })}`;
    body.innerHTML = lookupHTML() + body.innerHTML;
    body.insertAdjacentHTML('afterbegin', returnBar());
    $('#dashboard').hidden = true;
    return;
  }
  // A card like the approval page: your balance on top, one clear amount picker, one big button.
  const card = `
    ${active ? `<p class="msg ok">You have <b>${esc(m.creditLeft)} ${esc(SYM())}</b> of credit left. Add more below.</p>` : ''}
    ${err}
    <div class="pay-pick">
      <span class="pay-label">${active ? `Add more ${esc(SYM())}` : `How much ${esc(SYM())} to start with?`}</span>
      <div class="pay-amts">${chips}</div>
      <div class="pay-custom"><input id="pay-custom" type="number" min="1" step="1" inputmode="decimal" value="${esc(S.form.payAmount)}" aria-label="Amount in ${esc(SYM())}" /><span class="pay-cur">${esc(SYM())}</span></div>
    </div>
    <button class="btn btn-primary btn-block" id="pay-go" type="button" ${S.busy ? 'disabled' : ''}>${payBusy || `Pay ${esc(S.form.payAmount || '')} ${esc(SYM())}${active ? '' : ' and start'}`}</button>
    <p class="small">${active ? 'A normal transfer to our payment wallet.' : `Pay once, use it as you go — no approval, no limits to set.`} Your wallet shows the exact amount; nothing else can be taken. Needs a little ${esc(S.cfg.network.gasToken)} for the fee.</p>`;
  // balance card first in quick mode (like the approval page), else below
  const checkBtn = (QUICK() && !S.lookup.open && !S.lookup.data)
    ? `<button class="btn btn-ghost btn-block" id="check-first" type="button" ${S.busy ? 'disabled' : ''}>${busy('check', 'Reading your wallet…') || 'Check balance'}</button>` : '';
  const qr = (!isMobile() && !window.ethereum) ? qrHTML(S.qrSvg) : '';
  body.innerHTML = QUICK() ? (lookupHTML() + checkBtn + card + qr) : (card + qr + lookupHTML());
  body.insertAdjacentHTML('afterbegin', returnBar());
  renderDashboard();
}

async function payPrepaid(amount) {
  const amt = Number(amount);
  if (!(amt > 0)) { S.error = `Enter how much ${SYM()} to pay.`; render(); return; }
  S.error = null; S.busy = 'connect'; render();
  try {
    if (!S.address) {
      if ((await connectWallet({ appkit: S.appkit, wagmi: S.wagmi })) === 'choose') { S.chooser = true; S.busy = null; render(); return; }
      const acct = getAccount(S.wagmi);
      if (acct.isConnected && acct.chainId !== S.cfg.network.chainId) await switchToServiceChain(S.cfg, S.wagmi).catch(() => {});
      if (acct.address) await useAddress(acct.address);
    }
    if (!S.address) { S.busy = null; render(); return; }
    if (!(await switchToServiceChain(S.cfg, S.wagmi))) { S.error = switchHelpText(S.cfg); S.busy = null; render(); return; }
    const to = S.cfg.recipient;
    if (!to) { S.error = 'No payment wallet is set. Tell the service owner to set TREASURY_WALLET.'; S.busy = null; render(); return; }
    S.busy = 'pay'; render();
    const hash = await writeContract(S.wagmi, { address: S.cfg.network.token.address, abi: erc20Abi, functionName: 'transfer', args: [to, toUnits(String(amt))], chainId: S.cfg.network.chainId });
    S.busy = 'paywait'; render();
    await waitForTransactionReceipt(S.wagmi, { hash, chainId: S.cfg.network.chainId, timeout: 120000 });
    const r = await api('/api/billing/pay', { method: 'POST', body: { chain: S.chain.key, wallet: S.address, txHash: hash } });
    S.session = r.session; store.set(sessionKey(), r.session); S.payReview = false;
    toast(`Payment received. ${r.creditLeft} ${SYM()} credit added.`);
    await readChain(); await loadMe();
  } catch (e) {
    S.error = friendlyWalletError(e, S.cfg);
  }
  S.busy = null; render();
}

function renderDashboard() {
  const d = $('#dashboard');
  if (!S.session || !S.me) { d.hidden = true; return; }
  d.hidden = false;
  const m = S.me; const c = m.onchain || {};
  const stats = PREPAID()
    ? [[`${CAP(UNIT())} used`, num(m.tokensUsed, 0)],
       [`Prepaid balance (${SYM()})`, m.usable ? m.creditLeft : `0 (${m.creditReason || 'top up'})`],
       [`Topped up (${SYM()})`, m.toppedUp ?? '-'],
       [`Spent (${SYM()})`, m.used]]
    : [[`${CAP(UNIT())} used`, num(m.tokensUsed, 0)],
       [`Credit left (${SYM()})`, m.usable ? m.creditLeft : `0 (${m.creditReason || 'paused'})`],
       [`Due now (${SYM()})`, m.due],
       [`Paid so far (${SYM()})`, m.paid],
       [`Left this 30 days (${SYM()})`, c.remainingInPeriod ?? '-']];
  $('#dash-stats').innerHTML = stats.map(([k, v]) => `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('');

  $('#key-box').innerHTML = S.newKey
    ? `<div class="copy-line"><code>${esc(S.newKey)}</code><button class="btn btn-ghost btn-sm" type="button" data-copy="${esc(S.newKey)}">Copy</button></div>
       <p class="msg warn">Copy it now. It won't be shown again.</p>`
    : m.apiKeyHint ? `<p>Active key ending in <code>${esc(m.apiKeyHint)}</code></p>` : '<p class="small">No key yet.</p>';
  $('#new-key').textContent = m.apiKeyHint || S.newKey ? 'Create new key' : 'Create API key';
  $('#new-key').disabled = PREPAID() ? !S.session : !c.active;

  $('#limit-box').innerHTML = PREPAID()
    ? `<p>Prepaid: you pay up front and usage draws it down. Top up any time from the top of this page.<br/>
       <span class="small">Balance: ${esc(m.usable ? m.creditLeft : '0')} ${esc(SYM())}. Topped up in total: ${esc(m.toppedUp ?? '-')} ${esc(SYM())}.</span></p>`
    : c.active
    ? `<p>${c.maxPerCharge === 'No limit' ? 'No spending limit.' : `${esc(c.maxPerCharge)} ${esc(SYM())} per charge, ${esc(c.maxPerPeriod)} ${esc(SYM())} per 30 days.`}<br/>
       <span class="small">Approved: ${esc(c.allowance)} ${esc(SYM())}. Used ${c.rolling ? 'in the last 30 days' : 'this window'}: ${esc(c.spentInPeriod)}${c.periodResets ? `. Resets ${esc(when(c.periodResets))}` : ''}.</span></p>`
    : `<p class="msg warn">Billing is cancelled. Activate again above to use your API key.</p>`;
  $('#cancel-billing').hidden = !c.active;
  $('#edit-limits').hidden = !c.active || STRICT();

  $('#usage-table').innerHTML = m.usage.length
    ? `<thead><tr><th>When</th><th>${esc(CAP(UNIT()))}</th><th>Cost (${esc(SYM())})</th><th>Note</th></tr></thead><tbody>${m.usage.map((u) =>
        `<tr><td>${esc(when(u.created_at))}</td><td>${esc(num(u.tokens, 0))}</td><td>${esc(u.cost)}</td><td>${esc(u.note || '')}</td></tr>`).join('')}</tbody>`
    : '<tbody><tr><td>No usage yet.</td></tr></tbody>';
  $('#charge-table').innerHTML = m.charges.length
    ? `<thead><tr><th>When</th><th>Amount (${esc(SYM())})</th><th>Status</th><th>Transaction</th></tr></thead><tbody>${m.charges.map((ch) =>
        `<tr><td>${esc(when(ch.created_at))}</td><td>${esc(ch.amount)}</td><td class="status ${esc(ch.status)}">${esc(ch.status)}</td>
         <td>${ch.txUrl ? `<a href="${esc(ch.txUrl)}" target="_blank" rel="noopener">${esc(short(ch.tx_hash))}</a>` : esc(short(ch.tx_hash || ''))}</td></tr>`).join('')}</tbody>`
    : '<tbody><tr><td>No charges yet.</td></tr></tbody>';
}

// ------------------------------------------------------------------ events
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.copy) { toast((await copyText(b.dataset.copy)) ? 'Copied' : 'Copy failed: press and hold to copy'); return; }
  if (b.dataset.chain) return selectChain(b.dataset.chain);
  if (b.dataset.amt) { S.form.payAmount = String(b.dataset.amt); return render(); }
  switch (b.id) {
    case 'connect': return connectThenSetup(true);
    case 'check-first': return checkBalanceFirst();
    case 'lookup-other': S.lookup.manual = true; render(); return $('#lookup-addr')?.focus();
    case 'wc-qr': return S.appkit?.open();
    case 'check-balance': return checkBalance();
    case 'lookup-open': S.lookup.open = true; render(); return $('#lookup-addr')?.focus();
    case 'lookup-go': return runLookup();
    case 'change-wallet': return S.appkit ? S.appkit.open() : toast('Switch the account inside your wallet app.');
    case 'switch-net': {
      S.busy = 'switch'; S.error = null; render();
      try { if (!(await switchToServiceChain(S.cfg, S.wagmi))) S.error = switchHelpText(S.cfg); }
      catch (err) { S.error = friendlyWalletError(err, S.cfg); }
      S.busy = null; S.chainId = (await walletChainId()) ?? getAccount(S.wagmi).chainId ?? null;
      if (S.chainId === S.cfg.network.chainId) await readChain();
      return render();
    }
    case 'setup-go': { const err = readForm(); if (err) { S.error = err; return render(); } return setupBilling(); }
    case 'pay-go': {
      const a = Number(S.form.payAmount);
      if (!(a > 0)) { S.error = `Enter how much ${SYM()} to pay.`; return render(); }
      S.error = null; S.payReview = true; return render();
    }
    case 'pay-confirm': return payPrepaid(S.form.payAmount);
    case 'pay-back': S.payReview = false; S.error = null; return render();
    case 'signin': return signIn();
    case 'refresh': return checkBalance();
    case 'new-key': return newApiKey();
    case 'edit-limits-top':
    case 'edit-limits':
      if (STRICT()) return;
      S.editLimits = true;
      S.form.noLimit = isHuge(S.account.maxPerCharge);
      S.form.unlimitedApprove = isHuge(S.allowance);
      S.form.maxPerCharge = S.form.noLimit ? String(S.bcfg.defaults.maxPerCharge) : fromUnits(S.account.maxPerCharge);
      S.form.maxPerPeriod = S.form.noLimit ? String(S.bcfg.defaults.maxPerPeriod) : fromUnits(S.account.maxPerPeriod);
      S.form.approve = String(Math.max(Number(S.form.approve || 0), Number(S.form.maxPerPeriod)));
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return render();
    case 'stop-edit': S.editLimits = false; S.error = null; return render();
    case 'top-up':
      S.form.unlimitedApprove = false; S.form.approve = String(cappedAmount() || S.bcfg.defaults.approve);
      return setupBilling();
    case 'cancel-billing': return cancelBilling();
    case 'back-to-site': return backToSite(0);
  }
});
// keep typed values across re-renders
document.addEventListener('toggle', (e) => { if (e.target.id === 'advanced') advancedOpen = e.target.open; }, true);
document.addEventListener('change', (e) => {
  if (e.target.id === 'pay-custom') { S.form.payAmount = e.target.value; const c = $('#pay-go'); if (c && !S.busy) c.textContent = `Pay ${e.target.value || ''} ${SYM()}${S.me && S.me.usable ? '' : ' and start'}`; }
  if (e.target.id === 'f-nolimit') { S.form.noLimit = e.target.checked; render(); }
  if (e.target.id === 'f-unlimited') { S.form.unlimitedApprove = e.target.checked; render(); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'lookup-addr') runLookup();
  if (e.key === 'Escape' && !$('#modal')?.hidden) $('#modal-no')?.click();
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'lookup-addr') S.lookup.addr = e.target.value;
  if (e.target.id === 'f-approve') S.form.approve = e.target.value;
  if (e.target.id === 'f-charge') S.form.maxPerCharge = e.target.value;
  if (e.target.id === 'f-period') S.form.maxPerPeriod = e.target.value;
  if (e.target.id === 'f-approve') {
    const btn = $('#setup-go');
    if (btn && !S.busy && /Approve/.test(btn.textContent)) btn.textContent = `Approve ${e.target.value} ${SYM()} and activate`;
  }
});

// ------------------------------------------------------------------ boot
// ------------------------------------------------------------------ chains
async function useAddress(addr) {
  const changed = addr !== S.address;
  S.address = addr || null;
  if (S.address) store.set(lastAddrKey(), S.address);
  if (changed) {
    S.allowance = S.balance = S.account = null; S.gas = null; S.checkedAt = null; S.me = null; S.newKey = null; S.error = null;
    S.session = S.address ? store.get(sessionKey()) : null;
  }
  render();
  if (S.address) { await readChain(); if (S.session) await loadMe(); }
  render();
}

function renderPicker() {
  const el = $('#chain-pick');
  if (!el) return;
  const chains = S.bcfg.chains || [];
  el.hidden = chains.length < 2;
  el.innerHTML = chains.map((c) => `<button type="button" class="chip" data-chain="${esc(c.key)}" aria-pressed="${c.key === S.chain?.key}">${esc(c.short)} <span class="sym">${esc(c.token.symbol)}</span></button>`).join('');
}

async function selectChain(key) {
  const c = (S.bcfg.chains || []).find((x) => x.key === key) || S.bcfg.chains[0];
  S.chain = c;
  try { sessionStorage.setItem('billing:chain', c.key); } catch { /* ignore */ }
  S.cfg.network = c;
  S.bcfg.contract = c.contract || null;
  S.driver = c.family === 'tron' ? tronDriver(c) : c.family === 'solana' ? solanaDriver(c) : null;
  S.editLimits = false; S.chooser = false; S.lookup = { ...S.lookup, data: null, error: null };
  document.querySelectorAll('[data-token]').forEach((el) => { el.textContent = SYM(); });
  document.querySelectorAll('[data-net]').forEach((el) => { el.textContent = c.name; });
  const pill = $('#net-pill'); pill.textContent = c.name; pill.hidden = false;
  const explorerPath = c.family === 'solana' ? null : `${c.explorer}/${c.family === 'tron' ? 'contract' : 'address'}/${c.contract}`;
  $('#contract-line').innerHTML = c.family === 'solana'
    ? `On Solana you approve our billing delegate <span class="mono">${esc(short(c.delegate))}</span> on your ${esc(c.token.symbol)} account. Your limits are recorded with the approval and enforced by our billing server; revoke any time in your wallet.`
    : `Billing contract: <a href="${esc(explorerPath)}" target="_blank" rel="noopener">${esc(short(c.contract))}</a>. You can read its code and every charge on the explorer.`;
  if (c.family === 'solana' && S.form.unlimitedApprove) { S.form.unlimitedApprove = false; }
  $('#trust-treasury').innerHTML = c.family === 'solana'
    ? '<strong>Capped by you.</strong> We can never collect more than the amount you approve; your per-charge and 30-day limits are enforced by our billing server.'
    : '<strong>Straight to us.</strong> Payments can only go to our treasury address, set in the contract.';
  $('#foot-line').innerHTML = c.family === 'solana'
    ? `Charges on ${esc(c.name)} are made by our billing delegate, never above your approval. Every charge has a transaction you can check on the explorer.`
    : `Charges are made by our billing contract on ${esc(c.name)}, only within the limits you set. Every charge has a transaction you can check on the explorer.`;
  renderPicker();
  if (!isMobile()) {
    try {
      const u = new URL(pageLink()); if ((S.bcfg?.chains || []).length > 1) u.searchParams.set('chain', c.key);
      S.qrSvg = await QRCode.toString(u.toString(), { type: 'svg', margin: 1, width: 200, errorCorrectionLevel: 'M' });
    } catch { S.qrSvg = null; }
  }
  const addr = c.family === 'evm' ? S.evmAddress : (S.otherAddress[c.key] || S.driver.current());
  if (c.family === 'evm' && S.evmAddress) S.chainId = getAccount(S.wagmi).chainId ?? null;
  await useAddress(addr || null);
}

(async function boot() {
  try {
    [S.cfg, S.bcfg] = await Promise.all([api('/api/config'), api('/api/billing/config')]);
  } catch {
    $('#setup-body').innerHTML = '<p class="msg err">The server isn\'t reachable right now. Refresh in a minute.</p>';
    return;
  }
  const { cfg, bcfg } = S;
  document.querySelectorAll('[data-store-name]').forEach((el) => { el.textContent = cfg.serviceName || cfg.storeName; });
  document.title = `${cfg.serviceName || cfg.storeName}: pay as you go in stablecoins`;
  document.querySelectorAll('[data-unit]').forEach((el) => { el.textContent = UNIT(); });
  $('#price').textContent = bcfg.pricePerUnit ?? String(bcfg.pricePer1k / 1000);
  $('#price-1k').textContent = num(bcfg.pricePer1k, 6);
  document.querySelectorAll('[data-unit-one]').forEach((el) => { el.textContent = UNIT().replace(/s$/, ''); });
  S.form = { approve: String(bcfg.defaults.approve), maxPerCharge: String(bcfg.defaults.maxPerCharge), maxPerPeriod: String(bcfg.defaults.maxPerPeriod), unlimitedApprove: !CAPPED(), noLimit: true };
  if (STRICT()) { S.form.unlimitedApprove = true; S.form.noLimit = true; document.querySelectorAll('.lim-opt').forEach((el) => { el.hidden = true; }); }
  if (!bcfg.enabled || !(bcfg.chains || []).length) { render(); return; }

  // EVM wallets (wagmi): every EVM chain the server bills on
  const evmChains = bcfg.chains.filter((c) => c.family === 'evm');
  if (evmChains.length) {
    const w = initWallet({ ...cfg, network: evmChains[0], payOptions: evmChains.map((n) => ({ network: n })) }, 'Pay-as-you-go billing');
    S.appkit = w.appkit; S.wagmi = w.wagmi;
    reportWalletConnections(S.wagmi, 'billing');
    watchAccount(S.wagmi, { onChange: async (acct) => {
      S.evmAddress = acct.isConnected ? acct.address : null;
      if (!isEvm()) return;
      const sameAddr = S.evmAddress === S.address;
      S.chainId = acct.chainId ?? null;
      if (sameAddr) { if (S.address && S.chainId === S.cfg.network.chainId && S.allowance === null) await readChain(); render(); return; }
      await useAddress(S.evmAddress);
    } });
    S.evmAddress = getAccount(S.wagmi).address || null;
  }

  let want = new URLSearchParams(location.search).get('chain');
  try { want = want || sessionStorage.getItem('billing:chain'); } catch { /* ignore */ }
  await selectChain(want || bcfg.chains[0].key);
  // Wallet browsers (Trust, Binance, MetaMask mobile) connect right away: no popup there. On a desktop
  // browser the balance is shown without connecting (see showBalanceSilently); the wallet connects on Approve.
  if (QUICK()) { if (isDappMode()) document.body.classList.add('dapp'); }
  // Wallet browser still on another network (Trust Wallet opens on Ethereum): move it to BNB Chain now.
  if (QUICK() && isEvm()) preSwitchChain(S.cfg).catch(() => {});
  else if (isDappMode() && S.wagmi && isEvm() && window.ethereum) startDappMode({ cfg: S.cfg, wagmi: S.wagmi, appkit: S.appkit, switchChain: true, onConnected: () => useAddress(getAccount(S.wagmi).address) });
  if (QUICK()) {
    document.body.classList.add('quick');
    const lede = document.querySelector('.ai-hero .lede');
    if (lede) lede.innerHTML = PREPAID()
      ? `Pay with <span data-token>${esc(SYM())}</span> once and use it as you go. A normal transfer from your wallet — no approval, nothing can be taken beyond what you pay.`
      : `Approve <span data-token>${esc(SYM())}</span> once from your wallet. You're only billed for what you use, and never more than you approve. Cancel any time.`;
  }
  if (PREPAID()) {
    document.body.classList.add('prepaid');
    const h = document.querySelector('.ai-trust h2'); if (h) h.textContent = `Why it's safe`;
    const ul = document.querySelector('.ai-trust ul.plain');
    if (ul) ul.innerHTML = `
      <li><strong>No approval, no draining.</strong> You send a normal ${esc(SYM())} transfer — the wallet shows the exact amount, and nothing can touch the rest of your balance.</li>
      <li><strong>You choose how much.</strong> Pay a little, use it, pay again. You only ever spend what you send.</li>
      <li><strong>Straight to us.</strong> Payment goes to our wallet address and is credited to your account automatically.</li>
      <li><strong>Nothing automatic.</strong> No future charges can happen without you sending another payment yourself.</li>`;
    const fl = document.querySelector('#foot-line');
    if (fl) fl.textContent = `You pay up front with a normal ${SYM()} transfer and your usage draws it down. Every payment has a transaction you can check on the explorer.`;
  }
  // TRON / Solana wallet browsers: connect right away too (one tap less)
  if (!QUICK() && !isEvm() && !S.address && S.driver?.available() && (isDappMode() || isMobile())) {
    try { S.otherAddress[S.chain.key] = await S.driver.connect(); await useAddress(S.otherAddress[S.chain.key]); } catch { /* the Connect button stays */ }
  }
  showBalanceSilently();
})();

/**
 * Connect the wallet. In quick mode this is the "Approve and start" button: the wallet connects
 * (its own sheet), and the approval request follows right away, so it is one tap for the customer.
 */
/**
 * Quick mode "Check balance" before connecting: the balance was already read in the background for the
 * wallet's own account, so it just appears. If the wallet shares no account without connecting, connect
 * (the wallet's own sheet) and show the connected card; no approval is sent here.
 */
async function checkBalanceFirst() {
  if (S.lookup.data) { S.lookup.open = true; render(); return; }
  S.busy = 'check'; render();
  const a = await silentAddress();
  if (a) { S.lookup.addr = a; S.busy = null; await runLookup(false); return; }
  S.busy = null;
  return connectThenSetup(false);
}

async function connectThenSetup(setup = true) {
  S.error = null; S.busy = 'connect'; render();
  try {
    if (!isEvm()) {
      S.otherAddress[S.chain.key] = await S.driver.connect();
      await useAddress(S.otherAddress[S.chain.key]);
      fetch('/api/events/wallet', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: S.address, chain: S.chain.key, wallet: S.driver.walletName, page: 'billing' }) }).catch(() => {});
    } else {
      if ((await connectWallet({ appkit: S.appkit, wagmi: S.wagmi })) === 'choose') { S.chooser = true; S.busy = null; render(); return; }
      const acct = getAccount(S.wagmi);
      if (acct.isConnected && acct.chainId !== S.cfg.network.chainId) await switchToServiceChain(S.cfg, S.wagmi).catch(() => {});
      S.chainId = getAccount(S.wagmi).chainId ?? (await walletChainId()) ?? S.chainId;
      if (acct.address) await useAddress(acct.address);
    }
  } catch (err) {
    S.error = isEvm() ? friendlyWalletError(err, S.cfg) : ownError(err); S.busy = null; render(); return;
  }
  S.busy = null;
  if (!S.address) { render(); return; }
  if (setup && QUICK() && !S.account?.active) return setupBilling();
  render();
}

/** Not connected yet? Show the balance anyway, for the wallet's own account or the last address used here. */
async function showBalanceSilently() {
  if (S.address || S.lookup.data || S.lookup.busy) return;
  const a = await silentAddress();
  if (!a || S.address) return;
  S.lookup.addr = a;
  S.lookup.open = !QUICK();   // quick mode: keep it ready, show it when "Check balance" is tapped
  await runLookup(false);
}
