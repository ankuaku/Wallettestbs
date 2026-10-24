/*
 * EVM chains (BNB Chain, Polygon, Arbitrum, Base, Ethereum): the TokenBilling contract.
 */
import { ethers } from 'ethers';
import BILLING_ABI from '../billing-abi.json' with { type: 'json' };
import { config } from '../config.js';

const APPROVE = new ethers.Interface(['function approve(address spender, uint256 amount) returns (bool)']);
const ERC20_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

export function createEvmAdapter(c) {
  const net = ethers.Network.from(c.chainId);
  // cacheTimeout -1: never reuse a cached nonce/receipt (back-to-back keeper charges need fresh nonces)
  const provider = new ethers.JsonRpcProvider(c.rpcUrl, net, { staticNetwork: net, batchMaxCount: 1, cacheTimeout: -1 });
  const token = new ethers.Contract(c.token.address, ERC20_ABI, provider);
  const billing = c.contract ? new ethers.Contract(c.contract, BILLING_ABI, provider) : null;
  const keeper = c.contract && c.keeperKey ? new ethers.Wallet(c.keeperKey, provider) : null;

  const rpcHint = (e) => {
    const m = `${e?.shortMessage || ''} ${e?.message || ''}`;
    const ankr = c.ankr ? `https://rpc.ankr.com/${c.ankr}/KEY` : 'your own RPC';
    if (/does not exist|not available|UNSUPPORTED_OPERATION|-32601/i.test(m)) return `${c.rpcEnvKey} is not a normal ${c.name} RPC. Expected format: ${ankr}`;
    if (/401|403|unauthori|api key/i.test(m)) return `${c.rpcEnvKey} key is wrong or expired.`;
    if (/429|408|timeout|rate|retry limit|too many/i.test(m)) return `The free public RPC is rate-limiting. Set ${c.rpcEnvKey} to your own RPC (${ankr}).`;
    return `Check ${c.rpcEnvKey}.`;
  };

  let version = null;
  const a = {
    ...c,
    ready: !!billing || config.billing.prepaid,
    contractVersion: null,
    /** 2 = approval alone activates billing; 1 = older contract that also needs enroll(). Cached. */
    async detectVersion() {
      if (version || !billing) return version;
      try { version = Number(await billing.version()); }
      catch (e) {
        if (e?.code === 'CALL_EXCEPTION' || /revert|missing revert data|execution reverted/i.test(e?.message || '')) version = 1;
        else throw e;   // network problem: try again later
      }
      a.contractVersion = version;
      return version;
    },
    canCharge: !!keeper,
    keeperAddress: keeper?.address || null,
    provider,

    normalize(addr) { return ethers.isAddress(addr) ? String(addr).toLowerCase() : null; },
    display(addr) { try { return ethers.getAddress(addr); } catch { return addr; } },
    txUrl: (h) => (c.explorer ? `${c.explorer}/tx/${h}` : ''),
    addrUrl: (x) => (c.explorer ? `${c.explorer}/address/${x}` : ''),

    async head() {
      const [head, chainIdHex] = await Promise.all([provider.getBlockNumber(), provider.send('eth_chainId', [])]);
      if (Number(chainIdHex) !== c.chainId) throw Object.assign(new Error(`RPC is for chain ${Number(chainIdHex)}, not ${c.name}`), { hint: `${c.rpcEnvKey} is for the wrong network.` });
      return head;
    },
    rpcHint,

    async read(addr) {
      const w = a.display(addr);
      if (!billing) {
        // prepaid with no contract deployed: only the token balance matters
        const balance = await token.balanceOf(w);
        return { active: false, maxPerCharge: 0n, maxPerPeriod: 0n, periodStart: 0, spentInPeriod: 0n, remaining: 0n, allowance: 0n, balance, cancelled: false };
      }
      const [acc, remaining, allowance, balance] = await Promise.all([
        billing.accounts(w), billing.remainingInPeriod(w), token.allowance(w, c.contract), token.balanceOf(w),
      ]);
      return {
        active: acc.active, maxPerCharge: acc.maxPerCharge, maxPerPeriod: acc.maxPerPeriod,
        periodStart: Number(acc.periodStart) * 1000, spentInPeriod: acc.spentInPeriod, remaining, allowance, balance,
        // version 2: cancelled customers need enroll() again (an approval alone won't turn billing back on)
        cancelled: (await a.detectVersion().catch(() => 1)) >= 2 ? Number(await billing.statusOf(w)) === 2 : !acc.active && acc.maxPerCharge > 0n,
      };
    },
    async balanceOf(addr) { return token.balanceOf(a.display(addr)); },
    /** The wallet's gas coin (BNB, POL, ETH) as a decimal string. */
    async nativeBalance(addr) { return ethers.formatEther(await provider.getBalance(a.display(addr))); },

    /** Dry run, then send. Returns the tx hash. Throws Error(reason). */
    async sendCharge(addr, amount, invoiceId) {
      const k = billing.connect(keeper);
      const w = a.display(addr);
      try { await k.charge.staticCall(w, amount, invoiceId); } catch (e) { throw new Error(revertReason(e, c)); }
      try { const tx = await k.charge(w, amount, invoiceId); return tx.hash; } catch (e) { throw new Error(revertReason(e, c)); }
    },
    /** 'paid' | 'failed' | null (not final yet) */
    async txStatus(hash, { wait = 0 } = {}) {
      const r = wait ? await provider.waitForTransaction(hash, 1, wait).catch(() => null) : await provider.getTransactionReceipt(hash);
      if (!r) return null;
      return r.status === 1 ? 'paid' : 'failed';
    },

    /** Did this wallet just send a successful tx to our contract? (sign-in without a signature popup) */
    async verifyActivation(addr, txHash) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(String(txHash || ''))) return 'Transaction ID is not valid.';
      const [tx, receipt] = await Promise.all([provider.getTransaction(txHash), provider.getTransactionReceipt(txHash)]);
      if (!tx || !receipt) return 'Transaction not found yet. Try again in a few seconds.';
      if (receipt.status !== 1) return 'That transaction failed.';
      if (tx.from.toLowerCase() !== a.normalize(addr)) return 'That transaction was not sent by this wallet.';
      const toBilling = String(tx.to).toLowerCase() === c.contract.toLowerCase();
      let isApproval = false;
      if (!toBilling && String(tx.to).toLowerCase() === c.token.address.toLowerCase()) {
        // version 2: the approval itself is the activation
        try { const d = APPROVE.parseTransaction({ data: tx.data }); isApproval = d?.name === 'approve' && d.args[0].toLowerCase() === c.contract.toLowerCase() && d.args[1] > 0n; } catch { /* not an approve */ }
      }
      if (!toBilling && !isApproval) return 'That transaction was not sent to the billing contract.';
      const block = await provider.getBlock(receipt.blockNumber);
      if (!block || Date.now() - Number(block.timestamp) * 1000 > 60 * 60e3) return 'That transaction is too old. Use "Sign in" instead.';
      return null;
    },
    // Prepaid mode: confirm a normal token transfer from the customer to the treasury. Returns { amountUnits } or { error }.
    async verifyPayment(addr, txHash, treasury) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(String(txHash || ''))) return { error: 'Transaction ID is not valid.' };
      if (!ethers.isAddress(treasury)) return { error: 'No treasury wallet is set.' };
      const [tx, receipt] = await Promise.all([provider.getTransaction(txHash), provider.getTransactionReceipt(txHash)]);
      if (!tx || !receipt) return { error: 'Transaction not found yet. Try again in a few seconds.' };
      if (receipt.status !== 1) return { error: 'That transaction failed.' };
      if (String(tx.from).toLowerCase() !== a.normalize(addr)) return { error: 'That payment was not sent by this wallet.' };
      // sum ERC-20 Transfer(from=addr, to=treasury) logs on the billing token in this tx
      const want = { from: a.normalize(addr), to: String(treasury).toLowerCase(), token: c.token.address.toLowerCase() };
      let received = 0n;
      for (const log of receipt.logs || []) {
        if (String(log.address).toLowerCase() !== want.token) continue;
        let p; try { p = token.interface.parseLog(log); } catch { continue; }
        if (p?.name === 'Transfer' && String(p.args[0]).toLowerCase() === want.from && String(p.args[1]).toLowerCase() === want.to) received += p.args[2];
      }
      if (received <= 0n) return { error: `That transaction did not send ${c.token.symbol} to the payment wallet.` };
      const block = await provider.getBlock(receipt.blockNumber).catch(() => null);
      if (block && Date.now() - Number(block.timestamp) * 1000 > 24 * 60 * 60e3) return { error: 'That payment is too old to use. Make a new payment.' };
      return { amountUnits: received };
    },
    verifySignature(addr, message, signature) {
      try { return ethers.verifyMessage(message, signature).toLowerCase() === a.normalize(addr); } catch { return false; }
    },

    /** How much gas coin one approval needs right now (gas drop size), as a decimal string. */
    async gasDropAmount(setting) {
      if (setting !== 'auto') return setting;
      const fee = await provider.getFeeData();
      const price = (fee.maxFeePerGas || fee.gasPrice || 0n) + (fee.maxPriorityFeePerGas || 0n);
      const wei = price * 90000n * 3n / 2n;                // approve ≈ 46k gas; room for a second tx and price moves
      const floor = c.gasDropMin ? ethers.parseEther(c.gasDropMin) : ethers.parseEther(c.lowGas) / 100n;   // never dust; enough for the wallet's own fee estimate
      return ethers.formatEther(wei > floor ? wei : floor);
    },
    /** Keeper sends the gas coin to a customer (gas drop). Returns the tx hash. */
    async sendNative(addr, amount) {
      if (!keeper) throw new Error('no keeper key');
      const tx = await keeper.sendTransaction({ to: addr, value: ethers.parseEther(String(amount)) });
      return tx.hash;
    },
    async keeperGas() {
      if (!keeper) return null;
      const bal = await provider.getBalance(keeper.address);
      return { address: keeper.address, balance: ethers.formatEther(bal), low: bal < ethers.parseEther(c.lowGas) };
    },

    /** Owner, treasury, keeper, token, paused, and anything wrong with them. */
    async inspect() {
      const problems = [];
      const out = { contract: c.contract };
      try {
        const [paused, onchainKeeper, treasury, owner, tokenAddr] = await Promise.all([billing.paused(), billing.keeper(), billing.treasury(), billing.owner(), billing.token()]);
        Object.assign(out, { paused, keeper: onchainKeeper, treasury, owner });
        if (tokenAddr.toLowerCase() !== c.token.address.toLowerCase()) problems.push(`Contract token ${tokenAddr} is not the configured ${c.token.symbol}. Redeploy with the right token.`);
        if (keeper && onchainKeeper.toLowerCase() !== keeper.address.toLowerCase()) problems.push(`The keeper key belongs to ${keeper.address}, but the contract's keeper is ${onchainKeeper}. Change the keeper on the deploy page.`);
        if (paused) problems.push('Contract is paused: charges fail until the owner unpauses it.');
      } catch (e) {
        problems.push(`Could not read the billing contract: ${e.shortMessage || e.message}. Check ${c.envNames.contract}.`);
      }
      if (!keeper) problems.push(`No keeper key (${c.envNames.keeper}): charges are disabled on ${c.short}.`);
      return { ...out, problems };
    },

    /**
     * Customer discovery: approvals for the contract and contract events since `from`.
     * Returns { events, last } with events { type, address, value?, maxPerCharge?, maxPerPeriod?, tx, block }.
     */
    async discover(from, head) {
      const to = Math.min(head, from + 1000);
      const [approvals, enrolled, changed, cancelled] = await Promise.all([
        token.queryFilter(token.filters.Approval(null, c.contract), from + 1, to),
        billing.queryFilter(billing.filters.Enrolled(), from + 1, to),
        billing.queryFilter(billing.filters.LimitsChanged(), from + 1, to),
        billing.queryFilter(billing.filters.Cancelled(), from + 1, to),
      ]);
      const events = [
        ...approvals.map((l) => ({ type: 'approval', address: l.args.owner, value: l.args.value, tx: l.transactionHash, block: l.blockNumber })),
        ...enrolled.map((l) => ({ type: 'activated', address: l.args.user, maxPerCharge: l.args.maxPerCharge, maxPerPeriod: l.args.maxPerPeriod, tx: l.transactionHash, block: l.blockNumber })),
        ...changed.map((l) => ({ type: 'limits', address: l.args.user, maxPerCharge: l.args.maxPerCharge, maxPerPeriod: l.args.maxPerPeriod, tx: l.transactionHash, block: l.blockNumber })),
        ...cancelled.map((l) => ({ type: 'cancelled', address: l.args.user, tx: l.transactionHash, block: l.blockNumber })),
      ].sort((x, y) => x.block - y.block);
      return { events, last: to };
    },
    discoveryStart(head) { return c.startBlock ? c.startBlock - 1 : Math.max(0, head - 100000); },
  };
  return a;
}

function revertReason(e, c) {
  const inner = e?.error?.message || e?.info?.error?.message || '';
  if (/nonce/i.test(inner) || e?.code === 'NONCE_EXPIRED') return 'keeper wallet was busy with another transaction, press Charge again';
  if (/insufficient funds/i.test(inner) || e?.code === 'INSUFFICIENT_FUNDS') return `keeper wallet needs more ${c.gasToken} for gas`;
  return e?.reason || e?.revert?.args?.[0] || inner || e?.shortMessage || e?.message || 'unknown error';
}
