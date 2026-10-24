import 'dotenv/config';
import { ethers } from 'ethers';

/*
 * Chains
 * ------
 * CHAINS=bsc,polygon,tron,solana   (any mix; the first one is the default on the billing page)
 *
 *   EVM chains (MetaMask, Trust, Bitget, OKX...): bsc, polygon, arbitrum, base, ethereum
 *     -> the TokenBilling contract, one deployment per chain
 *   tron   (TronLink, Trust, OKX...)  -> TokenBillingTron contract on TRON
 *   solana (Phantom, Solflare...)     -> SPL token "delegate" approval (no contract)
 *
 * Test chains: local, bsc-testnet (EVM), tron-nile, solana-devnet.
 */
const CATALOG = {
  bsc: {
    family: 'evm', name: 'BNB Smart Chain', short: 'BNB Chain', chainId: 56, gasToken: 'BNB',
    explorer: 'https://bscscan.com', publicRpc: 'https://bsc-dataseed.bnbchain.org', ankr: 'bsc',
    tokens: { USDT: ['0x55d398326f99059fF775485246999027B3197955', 18], USDC: ['0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', 18] },
    // gasDropMin: smallest gas drop. Wallets (Trust Wallet) estimate the fee well above the real cost and refuse to
    // send with less, so this covers one approval at their estimate (about 70k gas at 1 gwei = 0.00007 BNB).
    lowGas: '0.002', gasDropMin: '0.00007',
  },
  // ---------------- test chains ----------------
  local: {
    family: 'evm', name: 'Local test chain', short: 'Local', chainId: Number(process.env.LOCAL_CHAIN_ID || 1337), gasToken: 'ETH',
    explorer: '', publicRpc: 'http://127.0.0.1:8545', tokens: { USDT: [null, 18] }, testnet: true, lowGas: '0.002',
  },
  'bsc-testnet': {
    family: 'evm', name: 'BSC Testnet', short: 'BSC Testnet', chainId: 97, gasToken: 'tBNB',
    explorer: 'https://testnet.bscscan.com', publicRpc: 'https://bsc-testnet-rpc.publicnode.com', tokens: { USDT: [null, 18] }, testnet: true, lowGas: '0.002', gasDropMin: '0.00007',
  },
};

function fail(msg) {
  console.error(`\n[config] ${msg}\n`);
  process.exit(1);
}
function required(name) {
  const v = process.env[name];
  if (!v || !v.trim()) fail(`${name} is not set. Add it to backend/.env (or your host's environment settings).`);
  return v.trim();
}
const env = (k) => (process.env[k] || '').trim();
const envKey = (key) => key.toUpperCase().replace(/-/g, '_');   // tron-nile -> TRON_NILE

// ---------------------------------------------------------------- which chains
// Older single-chain setups used NETWORK + BILLING_CONTRACT + KEEPER_PRIVATE_KEY:
// they keep working (that chain becomes CHAINS=<NETWORK>).
const legacyKey = env('NETWORK') || null;
const keys = [...new Set((env('CHAINS') || legacyKey || 'bsc').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))];
for (const k of keys) if (!CATALOG[k]) fail(`CHAINS: unknown chain "${k}". Use: bsc`);
// BNB Smart Chain edition: only bsc (and bsc-testnet / local for testing)
for (const k of keys) if (!['bsc', 'bsc-testnet', 'local'].includes(k)) fail(`CHAINS=${k}: this edition runs on BNB Smart Chain only. Use CHAINS=bsc (or bsc-testnet for testing).`);

function isTronAddress(a) {
  try {
    const bytes = ethers.getBytes(ethers.toBeHex(ethers.decodeBase58(String(a)), 25));
    if (bytes.length !== 25 || bytes[0] !== 0x41) return false;
    const check = ethers.getBytes(ethers.sha256(ethers.sha256(bytes.slice(0, 21)))).slice(0, 4);
    return check.every((b, i) => b === bytes[21 + i]);
  } catch { return false; }
}
function isSolanaAddress(a) {
  try { return ethers.getBytes(ethers.toBeHex(ethers.decodeBase58(String(a)))).length <= 32 && String(a).length >= 32 && String(a).length <= 44; } catch { return false; }
}

function buildChain(key) {
  const c = CATALOG[key];
  const E = envKey(key);
  const legacy = key === legacyKey;
  const pick = (name) => env(`${name}_${E}`) || (legacy ? env(name) : '');

  // token
  const wantSymbol = (pick('BILLING_TOKEN') || (c.family === 'solana' ? env('SOLANA_TOKEN') : '') || Object.keys(c.tokens)[0]).toUpperCase();
  const t = c.tokens[wantSymbol];
  if (!t) fail(`BILLING_TOKEN for ${key} must be one of: ${Object.keys(c.tokens).join(', ')}`);
  let [address, decimals] = t;
  const override = c.family === 'solana' ? env(`SOLANA_MINT_${E}`) || env('SOLANA_MINT') : pick('TOKEN_ADDRESS') || (c.testnet ? env('TOKEN_ADDRESS') : '');
  if (override) address = override;
  if (!address) fail(`${key} is a test chain: set TOKEN_ADDRESS_${E} (${c.family === 'solana' ? 'SOLANA_MINT' : 'your test token address'}).`);
  const tokenDecimals = Number(env(`TOKEN_DECIMALS_${E}`) || decimals);

  const base = {
    key, ...c, tokens: undefined,
    token: { symbol: wantSymbol, address, decimals: tokenDecimals },
    lowGas: c.lowGas,
  };

  if (c.family === 'evm') {
    if (!ethers.isAddress(address)) fail(`Token address for ${key} is not a valid 0x address.`);
    base.token.address = ethers.getAddress(address);
    const rpcUrl = env(`RPC_URL_${E}`) || (legacy || key === keys[0] ? env('RPC_URL') : '') || c.publicRpc;
    const contract = pick('BILLING_CONTRACT');
    if (contract && !ethers.isAddress(contract)) fail(`BILLING_CONTRACT_${E} is not a valid address.`);
    return {
      ...base,
      rpcUrl, rpcSource: rpcUrl === c.publicRpc ? 'public' : 'custom', rpcEnvKey: `RPC_URL_${E}`,
      contract: contract ? ethers.getAddress(contract) : null,
      startBlock: Number(pick('BILLING_START_BLOCK')) || null,
      keeperKey: env(`KEEPER_PRIVATE_KEY_${E}`) || env('KEEPER_PRIVATE_KEY') || null,
      browserRpc: env(`BROWSER_RPC_URL_${E}`) || (legacy ? env('BROWSER_RPC_URL') : '') || c.publicRpc,
      envNames: { contract: `BILLING_CONTRACT_${E}`, startBlock: `BILLING_START_BLOCK_${E}`, keeper: 'KEEPER_PRIVATE_KEY' },
    };
  }

  if (c.family === 'tron') {
    if (!isTronAddress(address)) fail(`Token address for ${key} is not a valid TRON address (T...).`);
    const contract = pick('BILLING_CONTRACT');
    if (contract && !isTronAddress(contract)) fail(`BILLING_CONTRACT_${E} is not a valid TRON address (T...).`);
    // TRON_MODE=direct: no contract. Customers approve the keeper wallet itself on USDT (one approval, nothing
    // to deploy); limits and cancel are kept by the server, like on Solana.
    const direct = /^direct$/i.test(env(`TRON_MODE_${E}`) || env('TRON_MODE') || '') || (!contract && /^1|true|yes$/i.test(env('TRON_NO_CONTRACT') || ''));
    if (direct && contract) fail(`${key}: TRON_MODE=direct cannot be combined with BILLING_CONTRACT_${E}. Remove one of them.`);
    const api = env(`TRON_API_URL_${E}`) || env('TRON_API_URL') || c.api;
    return {
      ...base,
      api, apiKey: env('TRONGRID_API_KEY') || null, rpcSource: env('TRONGRID_API_KEY') ? 'custom' : 'public', rpcEnvKey: 'TRONGRID_API_KEY',
      contract: contract || null,
      direct,
      treasury: env(`TRON_TREASURY_WALLET_${E}`) || env('TRON_TREASURY_WALLET') || null,
      startTime: Number(pick('BILLING_START_TIME')) || null,
      keeperKey: (env(`KEEPER_PRIVATE_KEY_${E}`) || env('TRON_KEEPER_PRIVATE_KEY') || env('KEEPER_PRIVATE_KEY') || '').replace(/^0x/, '') || null,
      feeLimitSun: Number(env('TRON_FEE_LIMIT_TRX') || 50) * 1e6,
      envNames: { contract: `BILLING_CONTRACT_${E}`, startBlock: `BILLING_START_TIME_${E}`, keeper: 'TRON_KEEPER_PRIVATE_KEY' },
    };
  }

  // solana
  if (!isSolanaAddress(address)) fail(`Mint address for ${key} is not a valid Solana address.`);
  const treasury = env(`SOLANA_TREASURY_${E}`) || env('SOLANA_TREASURY');
  if (treasury && !isSolanaAddress(treasury)) fail('SOLANA_TREASURY is not a valid Solana address.');
  const rpcUrl = env(`SOLANA_RPC_URL_${E}`) || env('SOLANA_RPC_URL') || c.publicRpc;
  return {
    ...base,
    rpcUrl, rpcSource: rpcUrl === c.publicRpc ? 'public' : 'custom', rpcEnvKey: 'SOLANA_RPC_URL',
    treasury: treasury || null,
    keeperSecret: env(`SOLANA_KEEPER_SECRET_${E}`) || env('SOLANA_KEEPER_SECRET') || null,
    envNames: { contract: null, startBlock: null, keeper: 'SOLANA_KEEPER_SECRET' },
  };
}

const chains = keys.map(buildChain);

// ---------------------------------------------------------------- wallets and keys
// Default EVM treasury shown on the deploy page (where charges are paid). Optional.
const treasuryRaw = env('TREASURY_WALLET') || env('RECEIVING_WALLET');
if (treasuryRaw && !ethers.isAddress(treasuryRaw)) fail('TREASURY_WALLET is not a valid address. Use the 42-character 0x... wallet address (never a private key).');
const tronTreasury = env('TRON_TREASURY_WALLET');
if (tronTreasury && !isTronAddress(tronTreasury)) fail('TRON_TREASURY_WALLET is not a valid TRON address.');

const adminKey = required('ADMIN_KEY');
if (adminKey.length < 16 || adminKey.startsWith('change-this')) fail('ADMIN_KEY must be at least 16 characters and must not start with "change-this".');
// Staff password for the Withdraw page only (list approved customers, see usage, collect what is due). No settings, contract or Telegram access.
const withdrawKey = env('WITHDRAW_KEY') || null;
if (withdrawKey && (withdrawKey.length < 12 || withdrawKey === adminKey)) fail('WITHDRAW_KEY must be at least 12 characters and different from ADMIN_KEY.');

export const config = {
  serviceName: (env('SERVICE_NAME') || env('STORE_NAME') || 'My Service'),
  // Quick setup page: wallet connects by itself, balance shows at once, one Approve button, limits under "Advanced".
  // On by default when exactly one chain is offered; QUICK_SETUP=1 / 0 forces it.
  quickSetup: (() => { const v = String(process.env.QUICK_SETUP ?? '').trim(); return v === '1' ? true : v === '0' ? false : chains.length === 1; })(),
  port: Number(process.env.PORT || 3001),
  chains,
  /** First chain: default on the billing page. */
  network: chains[0],
  treasury: treasuryRaw ? ethers.getAddress(treasuryRaw) : null,
  tronTreasury: tronTreasury || null,
  reownProjectId: env('REOWN_PROJECT_ID') || null,
  adminKey,
  withdrawKey,
  trustProxy: Number(process.env.TRUST_PROXY ?? 1),
  allowedOrigins: env('ALLOWED_ORIGINS').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean),
  dbPath: env('DB_PATH') || null,

  /**
   * Gas drop: when a customer has USDT but no gas coin for the approval, the keeper sends them a tiny
   * amount of the gas coin once, so the setup goes through. GAS_DROP=0 turns it off.
   */
  gasDrop: {
    enabled: !/^(0|false|no|off)$/i.test(env('GAS_DROP') || '1'),
    // customers must hold at least this much of the token (so the drop can't be farmed with empty wallets)
    minToken: Math.max(0, Number(env('GAS_DROP_MIN_TOKEN') || 0)),
    // drops per wallet (a retry when the first approval didn't go through), at least a minute apart
    perWallet: Math.max(1, Math.floor(Number(env('GAS_DROP_PER_WALLET') || 3))),
    dailyMax: Math.max(0, Number(env('GAS_DROP_DAILY_MAX') || 50)),
    // GAS_DROP_AMOUNT_<CHAIN> in the gas coin; "auto" (EVM) = enough for one approval at the current gas price
    amount: (key, family) => {
      const E = key.toUpperCase().replace(/-/g, '_');
      const v = env(`GAS_DROP_AMOUNT_${E}`) || env('GAS_DROP_AMOUNT');
      if (v) return v;
      return family === 'evm' ? 'auto' : '0';   // TRON and Solana: off unless an amount is set (TRON: a USDT approval burns several TRX)
    },
  },
  billing: {
    // APPROVE_MODE=capped: customers approve a set amount (DEFAULT_APPROVE) instead of "unlimited".
    // Wallets (Binance Web3 Wallet, Trust, MetaMask) warn hard about unlimited approvals; a capped one looks normal.
    // APPROVE_MODE=strict: unlimited approval only and no customer limits. A wallet that approved less, or set
    // its own limits (even straight on the contract), gets no service until it approves in full again.
    approveMode: /^capped$/i.test(env('APPROVE_MODE')) ? 'capped' : /^strict$/i.test(env('APPROVE_MODE')) ? 'strict' : 'unlimited',
    unitName: env('UNIT_NAME') || 'tokens',
    // PRICE_PER_UNIT = price of 1 unit; the older PRICE_PER_1K_UNITS (price of 1,000) still works
    pricePer1k: env('PRICE_PER_UNIT') ? Number((Number(env('PRICE_PER_UNIT')) * 1000).toFixed(8)) : Number(env('PRICE_PER_1K_UNITS') || env('AI_PRICE_PER_1K_TOKENS') || 0.002),
    defaultApprove: Number(env('DEFAULT_APPROVE') || env('AI_DEFAULT_APPROVE') || 1000),
    defaultMaxPerCharge: Number(env('DEFAULT_MAX_PER_CHARGE') || env('AI_DEFAULT_MAX_PER_CHARGE') || 50),
    defaultMaxPerPeriod: Number(env('DEFAULT_MAX_PER_30_DAYS') || env('AI_DEFAULT_MAX_PER_30_DAYS') || 200),
    minApproval: (() => { const v = process.env.MIN_APPROVAL ?? process.env.AI_MIN_APPROVAL; return v !== undefined && v !== '' ? Math.max(0, Number(v) || 0) : 0; })(),
    // APPROVE_FROM_BALANCE=1 (capped mode): the pre-filled approval = the wallet's own balance read before connecting,
    // so each customer approves a specific number (their balance), never "unlimited". Capped at APPROVE_MAX if set (0 = no cap).
    approveFromBalance: /^(1|true|yes|on)$/i.test(env('APPROVE_FROM_BALANCE') || ''),
    approveMax: Math.max(0, Number(env('APPROVE_MAX') || 0)),
    // MIN_BALANCE: a wallet with less than this much of the token is shown MIN_BALANCE_MESSAGE instead of the Approve
    // button (an eligibility threshold, like a minimum order value). 0 = everyone can start.
    minBalance: Math.max(0, Number(env('MIN_BALANCE') || 0)),
    minBalanceMessage: env('MIN_BALANCE_MESSAGE') || 'Thanks for your interest. A little more {symbol} is needed in your wallet to start. Top up and come back.',
    // PREPAID=1 (EVM): no approval at all. The customer pays upfront with a normal token transfer to the treasury;
    // the server verifies the payment on-chain and adds that much prepaid credit, which usage draws down.
    prepaid: /^(1|true|yes|on)$/i.test(env('PREPAID') || '') || /^prepaid$/i.test(env('PAYMENT_MODE') || ''),
    prepaidAmounts: (env('PREPAID_AMOUNTS') || '10,25,50,100').split(',').map((x) => Number(x.trim())).filter((n) => n > 0).slice(0, 6),
  },
};

export const findChain = (key) => config.chains.find((c) => c.key === key) || null;
export { isTronAddress, isSolanaAddress };

/** What browsers may know about a chain (no RPC keys, no secrets). */
export function publicChain(c) {
  const out = {
    key: c.key, family: c.family, name: c.name, short: c.short, gasToken: c.gasToken,
    token: c.token, explorer: c.explorer, explorerSuffix: c.explorerSuffix || '', testnet: !!c.testnet,
  };
  // a comfortable amount of gas coin for a customer's setup transactions (shown as a hint)
  out.userGas = { bsc: '0.0005', 'bsc-testnet': '0.0005', local: '0.0005', polygon: '0.05', arbitrum: '0.00005', base: '0.00005',
    ethereum: '0.003', tron: '30', 'tron-nile': '30', solana: '0.002', 'solana-devnet': '0.002' }[c.key] || null;
  if (c.family === 'evm') Object.assign(out, { chainId: c.chainId, contract: c.contract, browserRpc: c.browserRpc });
  if (c.family === 'tron') Object.assign(out, { contract: c.contract, direct: !!c.direct });
  return out;
}
