import { BrowserProvider, ContractFactory, Contract, Wallet, getAddress, isAddress, parseEther, formatEther } from 'ethers';
import BUILD from './billing-build.json';
import { mountOtherChain } from './deploy-other.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (a) => (a ? `${a.slice(0, 8)}…${a.slice(-6)}` : '');

let toastTimer;
function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2400); }
async function copy(t) { try { await navigator.clipboard.writeText(t); toast('Copied'); } catch { toast('Copy failed, select and copy manually'); } }

const S = {
  cfg: null, provider: null, signer: null, account: null, chainId: null, balance: null,
  keeperSecret: null, busy: null, error: null, deployed: null, funded: false,
};

// Network details for the wallet's "add network" request.
const chainParams = (n) => ({
  chainId: `0x${n.chainId.toString(16)}`, chainName: n.name,
  nativeCurrency: { name: n.gasToken, symbol: n.gasToken, decimals: 18 },
  rpcUrls: [n.browserRpc], blockExplorerUrls: n.explorer ? [n.explorer] : [],
});
const envKey = (k) => k.toUpperCase().replace(/-/g, '_');

// ethers wraps wallet/RPC errors it doesn't recognise as "could not coalesce error";
// the real reason is nested inside (error.error, info.error, data.message, ...).
function innerMessage(e) {
  const seen = new Set(); const out = [];
  const walk = (x, d = 0) => {
    if (!x || d > 6 || seen.has(x)) return;
    if (typeof x === 'string') { out.push(x); return; }
    if (typeof x !== 'object') return;
    seen.add(x);
    for (const k of ['reason', 'shortMessage', 'message']) if (typeof x[k] === 'string') out.push(x[k]);
    for (const k of ['error', 'info', 'data', 'cause', 'payload', 'originalError']) walk(x[k], d + 1);
  };
  walk(e);
  const good = out.map((s) => s.trim()).filter((s) => s && !/could not coalesce|internal json-rpc error|^\s*\{/i.test(s));
  return { all: out.join(' | '), best: good.sort((a, b) => a.length - b.length)[0] || null };
}

function friendly(e) {
  const { all, best } = innerMessage(e);
  const m = all.toLowerCase();
  const gas = S.cfg.network.gasToken;
  if (e?.code === 'ACTION_REJECTED' || e?.code === 4001 || /user (rejected|denied)|rejected the request|cancel/.test(m)) return 'You cancelled it in your wallet. Nothing happened.';
  if (/insufficient funds|exceeds balance|insufficient balance/.test(m)) return `Not enough ${gas} in this wallet for the network fee. Add a little ${gas} to the owner wallet and try again.`;
  if (/underpriced|fee too low|max fee per gas less than block base fee|tip.*too low|minimum.*gas/.test(m)) return `The wallet set the network fee too low. In the wallet's confirm screen choose "Market" or "Aggressive" gas (Polygon needs at least ~30 gwei priority fee) and try again.`;
  if (/nonce too low|nonce has already been used|replacement transaction/.test(m)) return 'The wallet has a stuck or pending transaction. In MetaMask: Settings > Advanced > Clear activity tab data, then try again.';
  if (/rate limit|too many requests|429|limit exceeded|timeout|failed to fetch|network error|header not found/.test(m)) return `The wallet's ${S.cfg.network.name} RPC is busy or down (${best || 'no details'}). In MetaMask: Settings > Networks > ${S.cfg.network.name} > change the RPC URL (e.g. ${S.cfg.network.browserRpc || 'a public RPC'}), then try again.`;
  if (/chain.?id|wrong network|does not match/.test(m)) return `The wallet is on a different network. Switch it to ${S.cfg.network.name} and try again.`;
  if (/execution reverted|revert/.test(m)) return `The network rejected it: ${best || 'reverted'}. Check that the token, treasury and keeper addresses are right.`;
  return best || e?.shortMessage || e?.message || 'Something went wrong.';
}

// ------------------------------------------------------------------ wallet
async function connect() {
  if (!window.ethereum) {
    S.error = 'No wallet found in this browser. Open this page on a computer with the MetaMask extension, or in the MetaMask app\'s built-in browser.';
    return render();
  }
  try {
    S.provider = new BrowserProvider(window.ethereum, 'any');
    await S.provider.send('eth_requestAccounts', []);
    await refreshWallet();
    window.ethereum.on?.('accountsChanged', () => refreshWallet());
    window.ethereum.on?.('chainChanged', () => refreshWallet());
  } catch (e) { S.error = friendly(e); }
  render();
}

async function refreshWallet() {
  try {
    S.provider = new BrowserProvider(window.ethereum, 'any');
    S.signer = await S.provider.getSigner();
    S.account = await S.signer.getAddress();
    S.chainId = Number((await S.provider.getNetwork()).chainId);
    S.balance = await S.provider.getBalance(S.account);
    if (S.pendingOpen && S.chainId === S.cfg.network.chainId && !S.deployed) {
      const addr = S.pendingOpen; S.pendingOpen = null;
      await loadContract(addr, { quiet: true });
    }
    if (!$('#treasury').value) $('#treasury').value = S.cfg?.recipient || S.account;
  } catch { /* shown as not connected */ }
  render();
}

async function switchNetwork() {
  const id = S.cfg.network.chainId;
  const hex = `0x${id.toString(16)}`;
  try {
    await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
  } catch (e) {
    if ((e?.code === 4902 || String(e?.message).includes('Unrecognized')) && S.cfg.network.browserRpc) {
      await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [chainParams(S.cfg.network)] });
    } else { S.error = friendly(e); }
  }
  await refreshWallet();
}

// ------------------------------------------------------------------ keeper
function generateKeeper() {
  if (S.keeperSecret && !confirm('Create another keeper wallet? The one shown now will be discarded.')) return;
  const w = Wallet.createRandom();
  S.keeperSecret = { address: w.address, privateKey: w.privateKey, saved: false };
  $('#keeper').value = w.address;
  render();
}

// ------------------------------------------------------------------ deploy
function readInputs() {
  const keeper = $('#keeper').value.trim();
  const treasury = $('#treasury').value.trim();
  if (!isAddress(keeper)) return { error: 'Enter a valid keeper address, or create a new keeper wallet.' };
  if (!isAddress(treasury)) return { error: 'Enter a valid treasury address.' };
  if (getAddress(keeper) === getAddress(treasury)) return { error: 'Keeper and treasury must be different wallets.' };
  if (S.account && getAddress(keeper) === getAddress(S.account)) return { error: "Don't use your owner wallet as the keeper. Its key would have to go on the server." };
  if (S.keeperSecret && getAddress(keeper) === getAddress(S.keeperSecret.address) && !S.keeperSecret.saved) return { error: "Save the keeper's private key first and tick the box in step 2." };
  return { keeper: getAddress(keeper), treasury: getAddress(treasury) };
}

async function deploy() {
  const inp = readInputs();
  if (inp.error) { S.error = inp.error; return render(); }
  const net = S.cfg.network;
  if (!confirm(`Deploy the billing contract on ${net.name}?\n\nToken: ${net.token.symbol} ${net.token.address}\nTreasury: ${inp.treasury}\nKeeper: ${inp.keeper}\n\nYour wallet will ask you to confirm and pay a small ${net.gasToken} fee.`)) return;
  S.busy = 'deploy'; S.error = null; render();
  let hash = null;
  try {
    if (S.chainId !== net.chainId) throw new Error(`wrong network: switch the wallet to ${net.name} first`);
    const factory = new ContractFactory(BUILD.abi, BUILD.bytecode, S.signer);
    const txReq = await factory.getDeployTransaction(net.token.address, inp.treasury, inp.keeper);
    const sent = await S.signer.sendTransaction(txReq);
    hash = sent.hash;
    S.busy = 'mining'; render();
    // Wait for the receipt; tolerate a flaky wallet RPC (the usual source of "could not coalesce error").
    let receipt = null;
    for (let i = 0; i < 100 && !receipt; i++) {
      try { receipt = await S.provider.getTransactionReceipt(hash); } catch (err) { console.warn('receipt check failed, retrying', err); }
      if (!receipt) await new Promise((r) => setTimeout(r, 3000));
    }
    if (!receipt) throw Object.assign(new Error('not confirmed yet'), { pendingHash: hash });
    if (receipt.status !== 1) throw new Error(`the deploy transaction failed on-chain (${hash})`);
    const address = receipt.contractAddress;
    const block = receipt.blockNumber;
    // Read back what the chain actually stored
    const live = new Contract(address, BUILD.abi, S.provider);
    const [token, treasury, keeper, owner] = await Promise.all([live.token(), live.treasury(), live.keeper(), live.owner()]);
    S.deployed = { address, tx: hash, block, token, treasury, keeper, owner, paused: false };
    try { localStorage.setItem(SAVED_KEY, JSON.stringify({ address, tx: hash, block })); } catch { /* ignore */ }
    toast('Contract deployed');
  } catch (e) {
    console.error('deploy error (full details):', e);
    const ex = net.explorer ? `${net.explorer}/tx/${hash}` : hash;
    S.error = hash
      ? `The transaction was sent (${ex}) but this page couldn't confirm it: ${friendly(e)} Don't deploy again. Open the link: once it shows Success, copy the contract address from there and paste it under "Open an existing contract" (and put the transaction's block number in BILLING_START_BLOCK_${envKey(net.key)}). Keep the keeper private key you saved.`
      : friendly(e);
  } finally {
    S.busy = null; render();
  }
}

let SAVED_KEY = 'billing:deployed-contract';

/** Read an already-deployed TokenBilling contract from the chain. */
async function loadContract(address, { quiet = false } = {}) {
  if (!isAddress(address)) { if (!quiet) { S.error = 'That is not a valid contract address.'; render(); } return false; }
  if (!S.provider || !S.account) { if (!quiet) { S.error = 'Connect your wallet in step 1 first.'; render(); } return false; }
  if (S.chainId !== S.cfg.network.chainId) { if (!quiet) { S.error = `Switch your wallet to ${S.cfg.network.name} first.`; render(); } return false; }
  try {
    const live = new Contract(getAddress(address), BUILD.abi, S.provider);
    const [token, treasury, keeper, owner, paused] = await Promise.all([live.token(), live.treasury(), live.keeper(), live.owner(), live.paused()]);
    let saved = null; try { saved = JSON.parse(localStorage.getItem(SAVED_KEY) || 'null'); } catch { /* ignore */ }
    const same = saved?.address && getAddress(saved.address) === getAddress(address);
    S.deployed = { address: getAddress(address), tx: same ? saved.tx : null, block: same ? saved.block : null, token, treasury, keeper, owner, paused };
    try { localStorage.setItem(SAVED_KEY, JSON.stringify({ address: S.deployed.address, tx: S.deployed.tx, block: S.deployed.block })); } catch { /* ignore */ }
    S.error = null;
    render();
    return true;
  } catch (e) {
    if (!quiet) { S.error = `Couldn't read a billing contract at that address on ${S.cfg.network.name}. ${e.shortMessage || ''}`; render(); }
    return false;
  }
}

async function ownerTx(label, fn) {
  S.busy = label; S.error = null; render();
  try {
    const c = new Contract(S.deployed.address, BUILD.abi, S.signer);
    const tx = await fn(c);
    await tx.wait();
    await loadContract(S.deployed.address, { quiet: true });
    toast('Done');
  } catch (e) { S.error = friendly(e); }
  S.busy = null; render();
}

function changeKeeper() {
  const k = $('#keeper').value.trim();
  if (!isAddress(k)) { S.error = 'Create a new keeper wallet in step 2 first (or paste a keeper address there).'; return render(); }
  if (S.keeperSecret && getAddress(k) === getAddress(S.keeperSecret.address) && !S.keeperSecret.saved) { S.error = "Save the new keeper's private key and tick the box in step 2 first."; return render(); }
  if (getAddress(k) === getAddress(S.deployed.keeper)) { S.error = 'That is already the keeper.'; return render(); }
  if (!confirm(`Change the keeper to ${k}?\n\nThe old keeper stops working immediately. Put the new keeper's private key in the server's .env (KEEPER_PRIVATE_KEY) afterwards and restart.`)) return;
  return ownerTx('keeper', (c) => c.setKeeper(getAddress(k)));
}

function changeTreasury() {
  const t = $('#new-treasury').value.trim();
  if (!isAddress(t)) { S.error = 'Paste a valid 0x... wallet address for the new treasury.'; return render(); }
  if (getAddress(t) === getAddress(S.deployed.treasury)) { S.error = 'That is already the treasury.'; return render(); }
  if (!confirm(`Send all future charges to ${t}?\n\nUse a wallet you control (not an exchange deposit address).`)) return;
  return ownerTx('treasury', (c) => c.setTreasury(getAddress(t)));
}

function transferOwner() {
  const o = $('#new-owner').value.trim();
  if (!isAddress(o)) { S.error = 'Paste a valid 0x... wallet address for the new owner.'; return render(); }
  if (getAddress(o) === getAddress(S.deployed.owner)) { S.error = 'That wallet is already the owner.'; return render(); }
  if (S.deployed.keeper && getAddress(o) === getAddress(S.deployed.keeper)) { S.error = "Don't make the keeper the owner. The keeper's key is on the server."; return render(); }
  if (!confirm(`Make ${o} the owner of this contract?\n\nYou will lose all owner controls. Double-check the address: this cannot be undone from this wallet.`)) return;
  return ownerTx('owner', (c) => c.transferOwnership(getAddress(o)));
}

async function fundKeeper() {
  const amt = $('#fund-amt').value.trim() || '0.005';
  S.busy = 'fund'; S.error = null; render();
  try {
    const tx = await S.signer.sendTransaction({ to: S.deployed.keeper, value: parseEther(amt) });
    await tx.wait();
    S.funded = true;
    toast(`Sent ${amt} ${S.cfg.network.gasToken} to the keeper`);
  } catch (e) { S.error = friendly(e); }
  S.busy = null; await refreshWallet();
}

// ------------------------------------------------------------------ render
function render() {
  const net = S.cfg?.network;
  if (!net) return;
  const err = S.error ? `<p class="msg err" role="alert">${esc(S.error)}</p>` : '';
  const explorer = net.explorer;
  const addrLink = (a) => (explorer ? `<a href="${explorer}/address/${a}" target="_blank" rel="noopener">${esc(a)}</a>` : esc(a));

  // step 1
  const onRight = S.chainId === net.chainId;
  $('#wallet-body').innerHTML = !S.account
    ? `${err}<button class="btn btn-primary" id="connect" type="button">Connect MetaMask</button>`
    : `<p>Connected: <span class="mono">${esc(S.account)}</span></p>
       <p class="small">Balance: ${S.balance !== null ? esc(Number(formatEther(S.balance)).toFixed(5)) : '…'} ${esc(net.gasToken)}. This wallet becomes the contract <strong>owner</strong>: it can pause billing and change the keeper or treasury. Keep it off the server.</p>
       ${onRight ? `<p class="msg ok">Wallet is on ${esc(net.name)}.</p>` : `<p class="msg warn">Your wallet is on another network (chain ${esc(S.chainId)}). Billing runs on ${esc(net.name)} (chain ${net.chainId}).</p>
       <button class="btn btn-primary" id="switch" type="button">Switch to ${esc(net.name)}</button>`}`;

  // step 2 secret
  const ks = S.keeperSecret;
  $('#keeper-secret').innerHTML = ks ? `
    <div class="secret">
      <strong>New keeper wallet: save this private key now</strong>
      <span class="small">It is shown only once and is not stored anywhere. You'll paste it into the server's .env as KEEPER_PRIVATE_KEY. Anyone with it can use the keeper's gas money, but cannot take customer funds.</span>
      <div class="copy-line"><code class="mono">${esc(ks.privateKey)}</code><button class="btn btn-ghost btn-sm" type="button" data-copy="${esc(ks.privateKey)}">Copy</button></div>
      <label class="small"><input type="checkbox" id="saved-key" ${ks.saved ? 'checked' : ''}/> I saved the private key somewhere safe</label>
    </div>` : '';

  $('#token-line').innerHTML = `${esc(net.token.symbol)} on ${esc(net.name)}: ${addrLink(net.token.address)}`;

  // step 4
  const d = S.deployed;
  if (d) {
    const ok = [d.token, d.treasury, d.keeper].every(Boolean);
    const E = envKey(net.key);
    const env = `# make sure CHAINS in .env includes ${net.key}, e.g. CHAINS=${[...new Set([...(S.cfg.chains || []).map((c) => c.key), net.key])].join(',')}\nBILLING_CONTRACT_${E}=${d.address}${d.block ? `\nBILLING_START_BLOCK_${E}=${d.block}` : ''}${ks && ks.address === d.keeper ? `\nKEEPER_PRIVATE_KEY=${ks.privateKey}` : `\n# KEEPER_PRIVATE_KEY=<private key of ${d.keeper}> (one keeper key can serve all EVM chains)`}`;
    $('#deploy-body').innerHTML = `
      <p class="msg ok">Deployed. Contract address:</p>
      <div class="copy-line"><code class="mono">${esc(d.address)}</code><button class="btn btn-ghost btn-sm" type="button" data-copy="${esc(d.address)}">Copy</button></div>
      ${d.tx && explorer ? `<a href="${explorer}/tx/${d.tx}" target="_blank" rel="noopener">View deployment on the explorer</a>` : ''}
      <table><tbody>
        <tr><th>Owner</th><td class="mono">${addrLink(d.owner)}</td></tr>
        <tr><th>Token</th><td class="mono">${addrLink(d.token)}</td></tr>
        <tr><th>Treasury</th><td class="mono">${addrLink(d.treasury)}</td></tr>
        <tr><th>Keeper</th><td class="mono">${addrLink(d.keeper)}</td></tr>
      </tbody></table>
      ${ok ? '' : '<p class="msg err">Could not read back all values. Check the contract on the explorer.</p>'}

      ${d.paused ? '<p class="msg err">Billing is paused. Charges will fail until you unpause.</p>' : ''}
      ${S.account && getAddress(S.account) === getAddress(d.owner) ? `
        <h3>Owner controls</h3>
        <p class="small">Lost the keeper key, or think it leaked? Create a new keeper wallet in step 2, tick the box, then change the keeper here. No need to deploy again.</p>
        <div class="row">
          <button class="btn btn-ghost btn-sm" id="set-keeper" type="button" ${S.busy ? 'disabled' : ''}>${S.busy === 'keeper' ? '<span class="spinner"></span> Confirm in wallet' : 'Change keeper to the address in step 2'}</button>
          <button class="btn btn-ghost btn-sm ${d.paused ? '' : 'danger'}" id="toggle-pause" type="button" ${S.busy ? 'disabled' : ''}>${S.busy === 'pause' ? '<span class="spinner"></span> Confirm in wallet' : d.paused ? 'Unpause billing' : 'Pause all billing'}</button>
        </div>
        <div class="row" style="align-items:flex-end">
          <div class="field" style="flex:1;min-width:0"><label for="new-treasury">New treasury (where charges are paid)</label><input id="new-treasury" placeholder="0x..." spellcheck="false" autocomplete="off" /></div>
          <button class="btn btn-ghost btn-sm" id="set-treasury" type="button" ${S.busy ? 'disabled' : ''}>${S.busy === 'treasury' ? '<span class="spinner"></span> Confirm in wallet' : 'Change treasury'}</button>
        </div>
        <div class="row" style="align-items:flex-end">
          <div class="field" style="flex:1;min-width:0"><label for="new-owner">Transfer ownership to</label><input id="new-owner" placeholder="0x..." spellcheck="false" autocomplete="off" /></div>
          <button class="btn btn-ghost btn-sm danger" id="set-owner" type="button" ${S.busy ? 'disabled' : ''}>${S.busy === 'owner' ? '<span class="spinner"></span> Confirm in wallet' : 'Transfer ownership'}</button>
        </div>
        <p class="small">Deploying for someone else? Set their wallet as treasury, then transfer ownership to their wallet. After the transfer, only the new owner can change anything.</p>` : `<p class="small">Connect the owner wallet (${esc(short(d.owner))}) to change the keeper or treasury, pause billing, or transfer ownership.</p>`}

      <h3>Give the keeper gas money</h3>
      <p class="small">The keeper pays a tiny ${esc(net.gasToken)} fee for each charge.</p>
      <div class="row">
        <div class="field"><label for="fund-amt">Amount (${esc(net.gasToken)})</label><input id="fund-amt" type="number" min="0" step="0.001" value="0.005" /></div>
      </div>
      <button class="btn ${S.funded ? 'btn-ghost' : 'btn-primary'}" id="fund" type="button" ${S.busy ? 'disabled' : ''}>${S.busy === 'fund' ? '<span class="spinner"></span> Confirm in wallet' : S.funded ? 'Send more' : 'Send to keeper'}</button>

      <h3>Last step: add these to the server's .env</h3>
      <div class="env-lines">${esc(env)}</div>
      <button class="btn btn-ghost btn-sm" type="button" data-copy="${esc(env)}">Copy all</button>
      <p class="small">Also add SERVICE_API_KEY (any long password). Restart the server, then check the Billing section in the admin panel.</p>
      ${err}
      <p class="small"><button class="link-btn" id="new-deploy" type="button">Deploy a different contract instead</button></p>`;
    return;
  }
  const busyLabel = S.busy === 'deploy' ? 'Confirm in your wallet' : S.busy === 'mining' ? 'Deploying, waiting for the block' : null;
  $('#deploy-body').innerHTML = `
    ${err}
    <button class="btn btn-primary" id="deploy" type="button" ${!S.account || !onRight || S.busy ? 'disabled' : ''}>
      ${busyLabel ? `<span class="spinner"></span> ${busyLabel}` : 'Deploy contract'}
    </button>
    ${!S.account ? '<p class="small">Connect your wallet in step 1 first.</p>' : !onRight ? `<p class="small">Switch to ${esc(net.name)} in step 1 first.</p>` : `<p class="small">Costs a small ${esc(net.gasToken)} network fee, paid by your connected wallet.</p>`}
    <h3>Already deployed?</h3>
    <p class="small">You don't need to deploy again. Paste the contract address to open it (find it in MetaMask activity, or on the explorer under your owner wallet as "Contract Creation").</p>
    <div class="copy-line"><input id="existing" placeholder="0x... contract address" spellcheck="false" autocomplete="off" style="flex:1;min-width:0;padding:10px 12px;border:1px solid var(--line);border-radius:6px;font:inherit" /><button class="btn btn-ghost btn-sm" id="open-existing" type="button">Open</button></div>`;
}

// ------------------------------------------------------------------ events
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.copy) return copy(b.dataset.copy);
  S.error = null;
  switch (b.id) {
    case 'connect': return connect();
    case 'switch': return switchNetwork();
    case 'gen-keeper': return generateKeeper();
    case 'deploy': return deploy();
    case 'fund': return fundKeeper();
    case 'open-existing': return loadContract($('#existing').value.trim());
    case 'set-keeper': return changeKeeper();
    case 'set-treasury': return changeTreasury();
    case 'set-owner': return transferOwner();
    case 'toggle-pause': {
      const next = !S.deployed.paused;
      if (!confirm(next ? 'Pause all billing? No charges can go through until you unpause.' : 'Unpause billing?')) return;
      return ownerTx('pause', (c) => c.setPaused(next));
    }
    case 'new-deploy':
      if (!confirm('Clear this contract from the page and deploy a new one? The old contract keeps existing on the chain.')) return;
      S.deployed = null; try { localStorage.removeItem(SAVED_KEY); } catch { /* ignore */ }
      return render();
  }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'saved-key' && S.keeperSecret) { S.keeperSecret.saved = e.target.checked; }
});

// ------------------------------------------------------------------ boot
// ------------------------------------------------------------------ chain picker
const CATALOG = [
  ['bsc', 'BNB Chain'],
];
function renderPicker(active) {
  const configured = new Map((S.cfg.chains || []).map((c) => [c.key, c]));
  const keys = [...configured.keys(), ...CATALOG.map(([k]) => k).filter((k) => !configured.has(k))];
  $('#chain-pick').innerHTML = keys.map((k) => {
    const c = configured.get(k);
    const label = c ? c.short : CATALOG.find(([x]) => x === k)?.[1] || k;
    return `<a class="chip ${k === active ? 'on' : ''} ${c ? '' : 'off'}" href="?chain=${esc(k)}" title="${c ? `${esc(c.token.symbol)} on ${esc(c.name)}` : 'Not in CHAINS yet'}">${esc(label)}${c ? '' : ' +'}</a>`;
  }).join('');
}

(async function boot() {
  try {
    const res = await fetch('/api/config');
    S.cfg = await res.json();
  } catch {
    $('#wallet-body').innerHTML = '<p class="msg err">The server is not reachable.</p>';
    return;
  }
  const want = new URLSearchParams(location.search).get('chain') || S.cfg.chains?.[0]?.key || S.cfg.network.key;
  renderPicker(want);
  const chosen = (S.cfg.chains || []).find((c) => c.key === want);
  if (!chosen) {
    $('#evm-steps').hidden = true;
    $('#other-panel').hidden = false;
    $('#other-panel').innerHTML = `<section class="panel"><h2>${esc(want)} is not switched on yet</h2>
      <p>Add <code>${esc(want)}</code> to <code>CHAINS</code> in the server's <code>.env</code> (for example <code>CHAINS=${esc([...(S.cfg.chains || []).map((c) => c.key), want].join(','))}</code>), restart the server, then open this page again.</p></section>`;
    return;
  }
  if (chosen.family !== 'evm') {
    $('#evm-steps').hidden = true;
    $('#other-panel').hidden = false;
    const pill = $('#net-pill'); pill.textContent = `${chosen.token.symbol} on ${chosen.name}`; pill.hidden = false;
    return mountOtherChain({ cfg: S.cfg, chain: chosen, el: $('#other-panel'), toast, copy });
  }
  S.cfg.network = chosen;
  SAVED_KEY = `billing:deployed-contract:${chosen.key}`;
  const pill = $('#net-pill'); pill.textContent = `${chosen.token.symbol} on ${chosen.name}`; pill.hidden = false;
  let known = null;
  if (chosen.contract) {
    known = chosen.contract;
    $('.intro').insertAdjacentHTML('afterend', `<p class="msg ok">The server already uses billing contract ${esc(chosen.contract)} on ${esc(chosen.name)}. It opens below once your wallet is connected. No need to deploy again.</p>`);
  }
  if (!known) { try { known = JSON.parse(localStorage.getItem(SAVED_KEY) || 'null')?.address || null; } catch { /* ignore */ } }
  S.pendingOpen = known;
  render();
  if (window.ethereum) {
    try {
      const accts = await window.ethereum.request({ method: 'eth_accounts' });
      if (accts?.length) { S.provider = new BrowserProvider(window.ethereum, 'any'); await refreshWallet(); }
    } catch { /* not connected yet */ }
  }
})();
