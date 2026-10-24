/*
 * Wallet Billing client for your own website (React, Next.js, Vue, plain JS).
 * Works on every chain the billing server has switched on:
 *   EVM chains (BNB Chain, Polygon, Arbitrum, Base, Ethereum): MetaMask, Trust, Bitget, OKX… (window.ethereum)
 *   TRON: TronLink and TRON-compatible wallets (window.tronLink / window.tronWeb)
 *   Solana: Phantom, Solflare, Backpack (window.phantom.solana / window.solflare / window.solana)
 *
 *   npm install ethers                  (v6, always)
 *   npm install @solana/web3.js         (only if you offer Solana)
 *
 *   import * as solanaWeb3 from '@solana/web3.js';   // only if you offer Solana
 *   const billing = createWalletBilling({ apiBase: 'https://billing.yourdomain.com', solanaWeb3 });
 *   const chains = await billing.chains();            // [{ key, name, family, token: { symbol } }, …]
 *   const { wallet, apiKey } = await billing.activate({ chain: 'tron' });
 *
 * The billing server must allow your site's origin: ALLOWED_ORIGINS=https://www.yoursite.com
 */
import { BrowserProvider, Contract, MaxUint256, parseUnits, formatUnits, getAddress, toQuantity } from 'ethers';

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];
const BILLING_ABI = [
  'function enroll(uint128 maxPerCharge, uint128 maxPerPeriod)',
  'function setLimits(uint128 maxPerCharge, uint128 maxPerPeriod)',
  'function cancel()',
  'function accounts(address) view returns (bool active, uint128 maxPerCharge, uint128 maxPerPeriod, uint64 periodStart, uint128 spentInPeriod)',
];
// TronWeb takes JSON ABIs
const TRON_BILLING_ABI = [
  { type: 'function', name: 'enroll', stateMutability: 'nonpayable', inputs: [{ name: 'maxPerCharge', type: 'uint128' }, { name: 'maxPerPeriod', type: 'uint128' }], outputs: [] },
  { type: 'function', name: 'setLimits', stateMutability: 'nonpayable', inputs: [{ name: 'maxPerCharge', type: 'uint128' }, { name: 'maxPerPeriod', type: 'uint128' }], outputs: [] },
  { type: 'function', name: 'cancel', stateMutability: 'nonpayable', inputs: [], outputs: [] },
];
const TRC20_ABI = [{ type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] }];

/** "No spending limit" is stored as this number (the contract needs some value). */
export const NO_LIMIT = 2n ** 127n - 1n;
const U64_MAX = 2n ** 64n - 1n;

export class WalletBillingError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
// ethers hides unrecognised wallet errors behind "could not coalesce error"; dig out the real one
function innerMessage(e) {
  const out = []; const seen = new Set();
  const walk = (x, d = 0) => {
    if (!x || d > 6 || seen.has(x)) return;
    if (typeof x === 'string') { out.push(x); return; }
    if (typeof x !== 'object') return;
    seen.add(x);
    for (const k of ['reason', 'shortMessage', 'message']) if (typeof x[k] === 'string') out.push(x[k]);
    for (const k of ['error', 'info', 'data', 'cause', 'payload']) walk(x[k], d + 1);
  };
  walk(e);
  const good = out.map((t) => t.trim()).filter((t) => t && !/could not coalesce|internal json-rpc error|^\{/i.test(t));
  return good.sort((a, b) => a.length - b.length)[0] || out[0] || String(e || '');
}
const isRejection = (e) => e?.code === 4001 || e?.code === 'ACTION_REJECTED' || /reject|denied|cancel|declined/i.test(`${e?.shortMessage || ''} ${e?.message || e || ''}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Inside a wallet app's own browser (Trust Wallet, MetaMask app, …)? Those work best with one request at a time. */
export function isWalletBrowser() {
  if (typeof window === 'undefined' || !window.ethereum) return false;
  const e = window.ethereum;
  const trust = !!(window.trustwallet || e.isTrust || e.isTrustWallet) || /trust\s?wallet/i.test(navigator.userAgent || '');
  return trust || /android|iphone|ipad|ipod/i.test(navigator.userAgent || '');
}

// remember billing-server sign-ins across page reloads (wallet browsers reload often)
const keep = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* storage blocked */ } },
};

/** Links that open your page inside a wallet app (for phones without a wallet in the browser). */
export function openInWalletLinks(url = window.location.href) {
  const noProto = url.replace(/^https?:\/\//, '');
  return {
    metamask: `https://metamask.app.link/dapp/${noProto}`,
    trust: `https://link.trustwallet.com/open_url?coin_id=20000714&url=${encodeURIComponent(url)}`,
    phantom: `https://phantom.app/ul/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(new URL(url).origin)}`,
  };
}

export function createWalletBilling({ apiBase, eip1193, solanaWeb3 } = {}) {
  if (!apiBase) throw new Error('createWalletBilling needs apiBase, e.g. https://billing.yourdomain.com');
  const base = apiBase.replace(/\/$/, '');
  let cfg = null;
  const sessions = {};   // chain key -> { wallet, session }
  const sessKey = (chainKey, wallet) => `wallet-billing:${base}:${chainKey}:${String(wallet).toLowerCase()}`;
  const saveSession = (chainKey, wallet, session) => { sessions[chainKey] = { wallet, session }; keep.set(sessKey(chainKey, wallet), session); };

  const evm = () => {
    const p = eip1193 || (typeof window !== 'undefined' ? window.ethereum : null);
    if (!p) throw new WalletBillingError('NO_WALLET', 'No EVM wallet found in this browser. Open this page in MetaMask or Trust Wallet, or install the MetaMask extension.');
    return p;
  };
  const tron = () => {
    const t = typeof window !== 'undefined' ? (window.tronLink?.tronWeb || window.tronWeb) : null;
    if (!t && !window.tronLink) throw new WalletBillingError('NO_WALLET', 'No TRON wallet found. Open this page in TronLink, or install the TronLink extension.');
    return t;
  };
  const sol = () => {
    const p = typeof window !== 'undefined' ? (window.phantom?.solana || window.solflare || window.backpack || window.solana) : null;
    if (!p) throw new WalletBillingError('NO_WALLET', 'No Solana wallet found. Open this page in Phantom, or install the Phantom extension.');
    return p;
  };

  async function api(path, { method = 'GET', body, auth } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new WalletBillingError(`HTTP_${res.status}`, j.error || `Billing server error (${res.status}).`);
    return j;
  }

  async function getConfig() {
    if (!cfg) {
      cfg = await api('/api/billing/config');
      if (!cfg.enabled || !cfg.chains?.length) throw new WalletBillingError('NOT_READY', 'Billing is not set up on the server yet.');
    }
    return cfg;
  }
  /** Chains customers can pay on: [{ key, name, short, family, token: { symbol, decimals } , … }] */
  async function chains() { return (await getConfig()).chains; }
  async function chainFor(key) {
    const c = await getConfig();
    const ch = key ? c.chains.find((x) => x.key === key) : c.chains[0];
    if (!ch) throw new WalletBillingError('BAD_CHAIN', `Chain "${key}" is not enabled on the billing server.`);
    return ch;
  }

  /** Connect the right wallet for the chain; returns the address. */
  async function connect(chainKey) {
    const c = await chainFor(chainKey);
    let address;
    try {
      if (c.family === 'evm') {
        const accounts = await evm().request({ method: 'eth_requestAccounts' });
        if (!accounts?.length) throw new WalletBillingError('NO_ACCOUNT', 'The wallet did not share an account.');
        await ensureEvmChain(c);
        address = getAddress(accounts[0]);
      } else if (c.family === 'tron') {
        tron();
        if (window.tronLink?.request) {
          const r = await window.tronLink.request({ method: 'tron_requestAccounts' });
          if (r?.code && r.code !== 200) throw new Error(r.message || 'The wallet did not connect.');
        }
        address = tron()?.defaultAddress?.base58;
        if (!address) throw new WalletBillingError('NO_ACCOUNT', 'Unlock your TRON wallet and try again.');
      } else {
        const r = await sol().connect();
        address = (r?.publicKey || sol().publicKey).toString();
      }
    } catch (e) {
      if (e instanceof WalletBillingError) throw e;
      throw isRejection(e) ? new WalletBillingError('REJECTED', 'You cancelled the wallet connection.') : e;
    }
    api('/api/events/wallet', { method: 'POST', body: { address, chain: c.key, chainId: c.chainId, wallet: 'website', page: 'billing' } }).catch(() => {});
    return address;
  }

  async function ensureEvmChain(c) {
    const p = evm();
    const want = toQuantity(c.chainId);
    const onChain = async () => Number(await p.request({ method: 'eth_chainId' })) === c.chainId;
    if (await onChain()) return;
    try {
      await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: want }] });
    } catch (e) {
      if (e?.code === 4902 || /unrecognized|not added|unknown chain/i.test(e?.message || '')) {
        await p.request({ method: 'wallet_addEthereumChain', params: [{
          chainId: want, chainName: c.name, nativeCurrency: { name: c.gasToken, symbol: c.gasToken, decimals: 18 },
          rpcUrls: [c.browserRpc], blockExplorerUrls: c.explorer ? [c.explorer] : [],
        }] });
      } else if (isRejection(e)) {
        throw new WalletBillingError('REJECTED', 'You cancelled the network switch.');
      } else {
        throw new WalletBillingError('WRONG_NETWORK', `Please switch your wallet to ${c.name}.`);
      }
    }
    // some wallet browsers (e.g. Trust Wallet) switch a moment later and don't report it: check
    for (let i = 0; i < 15; i++) { if (await onChain()) return; await sleep(300); }
    throw new WalletBillingError('WRONG_NETWORK', `Please switch your wallet to ${c.name} (tap the network icon at the top of the wallet's browser) and try again.`);
  }

  /** The connected address without any popup (null if the site isn't connected yet). */
  async function currentAddress(chainKey) {
    const c = await chainFor(chainKey);
    try {
      if (c.family === 'evm') { const a = await evm().request({ method: 'eth_accounts' }); return a?.[0] ? getAddress(a[0]) : null; }
      if (c.family === 'tron') return (window.tronLink?.tronWeb || window.tronWeb)?.defaultAddress?.base58 || null;
      return (window.phantom?.solana || window.solflare || window.backpack || window.solana)?.publicKey?.toString() || null;
    } catch { return null; }
  }

  /**
   * Check balance: token balance, gas coin for fees, approval and billing status.
   * Uses the already-connected wallet (no popup); pass an address to check any wallet.
   */
  async function checkBalance(chainKey, address) {
    const c = await chainFor(chainKey);
    const wallet = address || (await currentAddress(c.key)) || (await connect(c.key));
    const st = await status(wallet, c.key);
    const need = c.userGas ? Number(c.userGas) : null;
    return { ...st, lowGas: st.gas !== null && need !== null && Number(st.gas) < need, suggestedGas: c.userGas || null };
  }

  /** On-chain status through the billing server (same for every chain). */
  async function status(address, chainKey) {
    const c = await chainFor(chainKey);
    const j = await api(`/api/billing/wallet?chain=${encodeURIComponent(c.key)}&wallet=${encodeURIComponent(address)}`);
    const d = c.token.decimals;
    const unl = BigInt(c.family === 'solana' ? 2n ** 63n : 2n ** 120n);
    const show = (u) => (BigInt(u) >= unl ? 'unlimited' : formatUnits(BigInt(u), d));
    return {
      chain: c.key, wallet: address, active: j.active, symbol: c.token.symbol,
      approved: show(j.allowance), balance: formatUnits(BigInt(j.balance), d),
      gas: j.gas ?? null, gasToken: j.gasToken || c.gasToken,
      maxPerCharge: j.active ? show(j.maxPerCharge) : null, maxPerPeriod: j.active ? show(j.maxPerPeriod) : null,
      remainingInPeriod: j.active ? show(j.remaining) : null,
      raw: j,
    };
  }

  /**
   * One-click setup on a chain: approve (if needed) + activate (or update limits),
   * sign in to the billing server, create an API key.
   *
   * options: chain (key, default = first enabled), unlimited (default true; on Solana a
   * set amount is safer), approve, maxPerCharge / maxPerPeriod (null = no limit),
   * createKey (default true), onStep(step): connect | gas (server tops up the gas coin) | approve | activate | confirming | signin | done
   * returns { chain, wallet, apiKey, account, txHash, status }
   */
  async function activate(options = {}) {
    const { chain: chainKey, unlimited = true, approve, maxPerCharge = null, maxPerPeriod = null, createKey = true, onStep = () => {} } = options;
    const c = await chainFor(chainKey);
    const d = c.token.decimals;
    const perCharge = maxPerCharge == null ? NO_LIMIT : parseUnits(String(maxPerCharge), d);
    const perPeriod = maxPerPeriod == null ? NO_LIMIT : parseUnits(String(maxPerPeriod), d);
    if ((maxPerCharge == null) !== (maxPerPeriod == null)) throw new WalletBillingError('BAD_LIMITS', 'Set both limits, or neither.');
    if (perCharge <= 0n || perPeriod <= 0n) throw new WalletBillingError('BAD_LIMITS', 'Limits must be more than 0.');
    if (perCharge > perPeriod) throw new WalletBillingError('BAD_LIMITS', 'The per-charge limit cannot be higher than the 30-day limit.');
    const approveUnits = unlimited ? (c.family === 'solana' ? U64_MAX : MaxUint256) : parseUnits(String(approve ?? 0), d);
    if (!unlimited && approveUnits <= 0n) throw new WalletBillingError('BAD_APPROVE', 'Enter an approval amount.');
    if (!unlimited && BigInt(c.minApprovalUnits || 0) > approveUnits) throw new WalletBillingError('BAD_APPROVE', `The minimum approval is ${formatUnits(BigInt(c.minApprovalUnits), d)} ${c.token.symbol}.`);

    onStep('connect');
    const wallet = await connect(c.key);
    const before = await status(wallet, c.key);
    if (before.gas !== null && Number(before.gas) === 0) {
      // the server can send a little gas coin once (gas drop) when the wallet holds enough of the token
      const noGas = new WalletBillingError('NO_GAS', `Your wallet has no ${before.gasToken} for the network fee. Add about ${c.userGas || 'a little'} ${before.gasToken} on ${c.name} and try again.`);
      if (!c.gasDrop || BigInt(before.raw.balance) < parseUnits(String(c.gasDrop.minToken || 0), d)) throw noGas;
      onStep('gas');
      try { await api('/api/billing/gas-drop', { method: 'POST', body: { chain: c.key, wallet } }); }
      catch (e) { throw new WalletBillingError('NO_GAS', `${e.message} ${noGas.message}`); }
      const ok = await waitUntil(async () => Number((await status(wallet, c.key)).gas) > 0, 90000, 3000);
      if (!ok) throw new WalletBillingError('NO_GAS', `The ${before.gasToken} top-up is on its way. Try again in a moment.`);
    }
    let txHash;
    // contract version 2: the approval alone activates billing (one confirmation) unless the
    // customer wants own limits, previously set limits, or cancelled before
    const v2 = (c.contractVersion || 1) >= 2;
    const hadOwnLimits = before.active && before.maxPerCharge !== 'unlimited';
    const approveOnly = v2 && maxPerCharge == null && !before.raw.cancelled && !hadOwnLimits;
    try {
      if (c.family === 'evm') {
        const s = await (new BrowserProvider(evm(), 'any')).getSigner();
        const token = new Contract(c.token.address, ERC20_ABI, s);
        const bill = new Contract(c.contract, BILLING_ABI, s);
        const allowance = await token.allowance(wallet, c.contract);
        let approveTx = null;
        const needApprove = unlimited ? allowance < 2n ** 200n : allowance < approveUnits;
        if (needApprove && approveOnly) {
          onStep('approve');
          const tx = await token.approve(c.contract, approveUnits);
          onStep('confirming');
          await tx.wait();
          txHash = tx.hash;
        } else {
          if (needApprove) {
            onStep('approve'); approveTx = await token.approve(c.contract, approveUnits);
            // wallet browsers: wait for the approval before asking for the second confirmation
            if (isWalletBrowser()) { onStep('confirming'); await approveTx.wait(); approveTx = null; }
          }
          onStep('activate');
          const tx = before.active ? await bill.setLimits(perCharge, perPeriod) : await bill.enroll(perCharge, perPeriod);
          onStep('confirming');
          await Promise.all([approveTx?.wait(), tx.wait()]);
          txHash = tx.hash;
        }
      } else if (c.family === 'tron' && c.direct) {
        // direct mode (no contract): approve the billing wallet; limits / re-activation are saved through the session
        const t = tron();
        const allowance = BigInt(before.raw.allowance);
        const needApprove = unlimited ? allowance < 2n ** 200n : allowance < approveUnits;
        if (needApprove) {
          onStep('approve');
          txHash = await t.contract(TRC20_ABI, c.token.address).approve(c.spender, approveUnits.toString()).send({ feeLimit: 100e6 });
          onStep('confirming');
          await waitUntil(async () => BigInt((await status(wallet, c.key)).raw.allowance) > 0n, 90000, 3000);
          await sleep(2000);
        }
        if (maxPerCharge != null || hadOwnLimits || before.raw.cancelled || !needApprove) {
          onStep('signin');
          let session = null;
          if (txHash) { try { session = (await api('/api/billing/login-tx', { method: 'POST', body: { chain: c.key, wallet, txHash } })).session; saveSession(c.key, wallet, session); } catch { /* sign below */ } }
          if (!session) session = await sessionOrSignIn(c.key);
          await api('/api/billing/limits', { method: 'POST', auth: session, body: { maxPerCharge: maxPerCharge == null ? null : perCharge.toString(), maxPerPeriod: maxPerPeriod == null ? null : perPeriod.toString() } });
        }
      } else if (c.family === 'tron') {
        const t = tron();
        const allowance = BigInt(before.raw.allowance);
        const needApprove = unlimited ? allowance < 2n ** 200n : allowance < approveUnits;
        let approveId = null;
        if (needApprove) {
          onStep('approve');
          approveId = await t.contract(TRC20_ABI, c.token.address).approve(c.contract, approveUnits.toString()).send({ feeLimit: 100e6 });
        }
        if (needApprove && approveOnly) txHash = approveId;
        else {
          onStep('activate');
          txHash = await t.contract(TRON_BILLING_ABI, c.contract)[before.active ? 'setLimits' : 'enroll'](perCharge.toString(), perPeriod.toString()).send({ feeLimit: 100e6 });
        }
        onStep('confirming');
        await waitUntil(async () => (await status(wallet, c.key)).active, 90000, 3000);
        await sleep(3000);
      } else {
        if (!solanaWeb3?.VersionedTransaction) throw new WalletBillingError('SETUP', 'Pass solanaWeb3 (import * as solanaWeb3 from "@solana/web3.js") to createWalletBilling to use Solana.');
        const { tx } = await api('/api/billing/solana/tx', { method: 'POST', body: {
          chain: c.key, wallet, approve: unlimited ? 'max' : approveUnits.toString(),
          maxPerCharge: maxPerCharge == null ? null : perCharge.toString(), maxPerPeriod: maxPerPeriod == null ? null : perPeriod.toString(),
        } });
        onStep('activate');
        const vtx = solanaWeb3.VersionedTransaction.deserialize(Uint8Array.from(atob(tx), (ch) => ch.charCodeAt(0)));
        const { signature } = await sol().signAndSendTransaction(vtx);
        onStep('confirming');
        await waitUntil(async () => (await status(wallet, c.key)).active, 60000, 2000);
        txHash = signature;
      }
    } catch (e) {
      if (e instanceof WalletBillingError) throw e;
      if (isRejection(e)) throw new WalletBillingError('REJECTED', 'You cancelled the request in your wallet.');
      throw new WalletBillingError('TX_FAILED', innerMessage(e) || 'The wallet transaction failed.');
    }

    onStep('signin');
    let session = sessions[c.key]?.wallet === wallet ? sessions[c.key].session : null;   // direct mode may have signed in already
    let account = `${c.key}:${wallet}`;
    if (!session) {
      if (txHash) { const r = await api('/api/billing/login-tx', { method: 'POST', body: { chain: c.key, wallet, txHash } }); session = r.session; account = r.account; saveSession(c.key, wallet, session); }
      else session = await sessionOrSignIn(c.key);   // direct mode, nothing sent on-chain: message signature
    }
    await api('/api/billing/register', { method: 'POST', body: {}, auth: session });
    const apiKey = createKey ? (await api('/api/billing/api-key', { method: 'POST', body: {}, auth: session })).apiKey : null;
    onStep('done');
    return { chain: c.key, wallet, apiKey, account, txHash, status: await status(wallet, c.key) };
  }

  /** Sign in an already-active customer with a message signature (no transaction, no fee). */
  async function signIn(chainKey) {
    const c = await chainFor(chainKey);
    const wallet = await connect(c.key);
    const { time, message } = await api(`/api/billing/login-message?chain=${encodeURIComponent(c.key)}&wallet=${encodeURIComponent(wallet)}`);
    let signature;
    try {
      if (c.family === 'evm') signature = await (await (new BrowserProvider(evm(), 'any')).getSigner()).signMessage(message);
      else if (c.family === 'tron') signature = await tron().trx.signMessageV2(message);
      else { const r = await sol().signMessage(new TextEncoder().encode(message), 'utf8'); signature = btoa(String.fromCharCode(...(r.signature || r))); }
    } catch (e) { throw isRejection(e) ? new WalletBillingError('REJECTED', 'You cancelled the signature.') : e; }
    saveSession(c.key, wallet, (await api('/api/billing/login', { method: 'POST', body: { chain: c.key, wallet, time, signature } })).session);
    return wallet;
  }

  /** A saved session, or sign in with a message signature. */
  async function sessionOrSignIn(chainKey) {
    try { return await sessionFor(chainKey); }
    catch (e) { if (e.code !== 'NO_SESSION') throw e; await signIn(chainKey); return sessionFor(chainKey); }
  }
  async function sessionFor(chainKey) {
    const c = await chainFor(chainKey);
    if (sessions[c.key]) return sessions[c.key].session;
    // a sign-in from an earlier visit (same wallet, still connected)?
    const wallet = await currentAddress(c.key);
    const saved = wallet && keep.get(sessKey(c.key, wallet));
    if (saved) { sessions[c.key] = { wallet, session: saved }; return saved; }
    throw new WalletBillingError('NO_SESSION', 'Sign in with the wallet first.');
  }
  /** Billing-server call that drops a stale saved sign-in. */
  async function authed(chainKey, path, opts = {}) {
    const c = await chainFor(chainKey);
    try { return await api(path, { ...opts, auth: await sessionFor(c.key) }); }
    catch (e) {
      if (e.code === 'HTTP_401' && sessions[c.key]) { keep.del(sessKey(c.key, sessions[c.key].wallet)); delete sessions[c.key]; throw new WalletBillingError('NO_SESSION', 'Please sign in with the wallet again.'); }
      throw e;
    }
  }
  /** New API key (the old one stops working). Needs activate() or signIn() first. */
  async function createApiKey(chainKey) { return (await authed(chainKey, '/api/billing/api-key', { method: 'POST', body: {} })).apiKey; }
  /** Usage dashboard: credit left, used, paid, due, recent usage and charges. */
  async function me(chainKey) { return authed(chainKey, '/api/billing/me'); }

  /** Stop billing (customer side). */
  async function cancel(chainKey) {
    const c = await chainFor(chainKey);
    const wallet = await connect(c.key);
    try {
      if (c.family === 'evm') await (await new Contract(c.contract, BILLING_ABI, await (new BrowserProvider(evm(), 'any')).getSigner()).cancel()).wait();
      else if (c.family === 'tron' && c.direct) await api('/api/billing/cancel', { method: 'POST', auth: await sessionOrSignIn(c.key), body: {} });
      else if (c.family === 'tron') await tron().contract(TRON_BILLING_ABI, c.contract).cancel().send({ feeLimit: 100e6 });
      else {
        const { tx } = await api('/api/billing/solana/tx', { method: 'POST', body: { chain: c.key, wallet, action: 'cancel' } });
        await sol().signAndSendTransaction(solanaWeb3.VersionedTransaction.deserialize(Uint8Array.from(atob(tx), (ch) => ch.charCodeAt(0))));
      }
    } catch (e) { throw isRejection(e) ? new WalletBillingError('REJECTED', 'You cancelled the request in your wallet.') : e; }
  }

  async function waitUntil(fn, ms, every) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn().catch(() => false)) return true; await sleep(every); }
    return false;
  }

  const hasWallet = (family = 'evm') => {
    if (typeof window === 'undefined') return false;
    if (family === 'evm') return !!(eip1193 || window.ethereum);
    if (family === 'tron') return !!(window.tronLink || window.tronWeb);
    return !!(window.phantom?.solana || window.solflare || window.backpack || window.solana);
  };

  return { getConfig, chains, connect, currentAddress, status, checkBalance, activate, signIn, createApiKey, me, cancel, hasWallet };
}
