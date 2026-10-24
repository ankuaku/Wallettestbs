import { createAppKit } from '@reown/appkit';
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { bsc, bscTestnet } from '@reown/appkit/networks';
import { defineChain, http } from 'viem';
import { connect, getAccount, getConnectors, switchChain, injected, createConfig, reconnect, watchAccount } from '@wagmi/core';

/** Pick the AppKit network object for the service's chain. */
function networkFor(cfg) {
  const known = { [bsc.id]: bsc, [bscTestnet.id]: bscTestnet };
  if (known[cfg.network.chainId]) return known[cfg.network.chainId];
  // Local test chain
  return defineChain({
    id: cfg.network.chainId,
    name: cfg.network.name,
    nativeCurrency: { name: cfg.network.gasToken, symbol: cfg.network.gasToken, decimals: 18 },
    rpcUrls: { default: { http: [cfg.network.browserRpc || cfg.network.publicRpc] } },
    caipNetworkId: `eip155:${cfg.network.chainId}`,
    chainNamespace: 'eip155',
  });
}

export function initWallet(cfg, description) {
  // The billing network (plus any extra networks in cfg.payOptions).
  const evmNets = [cfg.network, ...(cfg.payOptions || []).map((o) => o.network)]
    .filter((n, i, all) => n.family !== 'tron' && n.chainId && all.findIndex((m) => m.chainId === n.chainId) === i);
  const networks = evmNets.map((n) => networkFor({ network: n }));
  const network = networks[0];
  // Read-only calls (balance, allowance) go to our chosen public RPCs, not to
  // Reown's RPC, so they keep working on Reown's free plan or without Reown.
  const transports = Object.fromEntries(evmNets.map((n, i) => [networks[i].id, http(n.browserRpc || n.publicRpc)]));

  if (!cfg.projectId) {
    // No Reown: direct wallet connections only (extension / in-wallet browser).
    const wagmi = createConfig({ chains: networks, connectors: [injected()], transports });
    // returning visitor: reconnect silently if the wallet already allowed this site
    reconnect(wagmi).catch(() => {});
    return { appkit: null, wagmi, network };
  }

  const adapter = new WagmiAdapter({ projectId: cfg.projectId, networks, transports });
  const appkit = createAppKit({
    adapters: [adapter],
    networks,
    defaultNetwork: network,
    projectId: cfg.projectId,
    metadata: {
      name: cfg.serviceName || cfg.storeName,
      description,
      url: window.location.origin,
      icons: [`${window.location.origin}/icon.png`],
    },
    features: { analytics: false, email: false, socials: false, swaps: false, onramp: false, send: false, history: false },
    // Don't lock the page with a "Switch network" popup when the wallet is on
    // another chain. Our own UI shows a Switch button instead; some in-app
    // wallet browsers never answer AppKit's switch request, which froze the page.
    allowUnsupportedChain: true,
    themeMode: 'light',
    themeVariables: { '--w3m-accent': '#2775CA', '--w3m-font-family': 'Figtree, system-ui, sans-serif', '--w3m-z-index': 3000 },
  });
  return { appkit, wagmi: adapter.wagmiConfig, network };
}

export function friendlyWalletError(e, cfg) {
  const m = `${e?.shortMessage || ''} ${e?.message || ''}`.toLowerCase();
  if (m.includes('reject') || m.includes('denied') || m.includes('cancel')) return 'You cancelled the request in your wallet. Nothing was changed.';
  if (m.includes('insufficient funds')) return `Your wallet needs a little ${cfg.network.gasToken} on ${cfg.network.name} for the network fee.`;
  if (m.includes('chain') || m.includes('network')) return `Switch your wallet to ${cfg.network.name} and try again.`;
  return e?.shortMessage || 'Your wallet could not complete the request. Try again.';
}

// ------------------------------------------------------------------ connect + switch

const CHAIN_PARAMS = {
  56: { chainId: '0x38', chainName: 'BNB Smart Chain', nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 }, rpcUrls: ['https://bsc-dataseed.bnbchain.org'], blockExplorerUrls: ['https://bscscan.com'] },
  97: { chainId: '0x61', chainName: 'BNB Smart Chain Testnet', nativeCurrency: { name: 'tBNB', symbol: 'tBNB', decimals: 18 }, rpcUrls: ['https://bsc-testnet-rpc.publicnode.com'], blockExplorerUrls: ['https://testnet.bscscan.com'] },
};

const hasInjected = () => typeof window !== 'undefined' && !!window.ethereum;

/** Running inside Trust Wallet (its DApp browser or extension)? */
export function isTrustWallet() {
  if (typeof window === 'undefined') return false;
  const e = window.ethereum;
  return !!(window.trustwallet || e?.isTrust || e?.isTrustWallet || e?.providers?.some?.((p) => p.isTrust || p.isTrustWallet))
    || /trust\s?wallet/i.test(navigator.userAgent || '');
}

/** Running inside the Binance Web3 Wallet (Binance app's dApp browser)? */
export function isBinanceWallet() {
  if (typeof window === 'undefined') return false;
  const e = window.ethereum;
  return !!(window.binancew3w || e?.isBinance || e?.providers?.some?.((p) => p.isBinance));
}

/** Name of the wallet injected into this page, for labels. */
export function injectedWalletName() {
  if (isBinanceWallet()) return 'Binance Wallet';
  if (isTrustWallet()) return 'Trust Wallet';
  const e = typeof window !== 'undefined' ? window.ethereum : null;
  if (e?.isMetaMask && !e?.isBitKeep) return 'MetaMask';
  if (e?.isBitKeep) return 'Bitget Wallet';
  if (e?.isOkxWallet || e?.isOKExWallet) return 'OKX Wallet';
  return 'wallet';
}

/** Mobile wallet browsers (Trust, MetaMask app, Bitget, OKX…) work best with one request at a time. */
export const isInWalletBrowser = () => hasInjected() && (isMobile() || isTrustWallet() || isBinanceWallet());

/** Chain id straight from the wallet (some in-app browsers don't report chain changes). */
export async function walletChainId() {
  if (!hasInjected()) return null;
  try { return Number.parseInt(await window.ethereum.request({ method: 'eth_chainId' }), 16) || null; } catch { return null; }
}

/**
 * Inside a wallet's own browser, move the wallet to the service's network as soon as the page opens,
 * so customers never have to switch from Ethereum to BNB Chain by hand. Trust Wallet and Binance Web3
 * Wallet switch silently; if the wallet does not know the network it is added. Errors are ignored:
 * the Approve button switches again anyway.
 */
export async function preSwitchChain(cfg) {
  const want = cfg?.network?.chainId;
  if (!want || !isInWalletBrowser()) return false;
  if ((await walletChainId()) === want) return true;
  const hex = `0x${want.toString(16)}`;
  try {
    await timeout(window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] }), 15000);
  } catch (e) {
    const unknown = e?.code === 4902 || e?.data?.originalError?.code === 4902 || /unrecognized|not added|unknown chain/i.test(e?.message || '');
    if (unknown && CHAIN_PARAMS[want]) {
      try { await timeout(window.ethereum.request({ method: 'wallet_addEthereumChain', params: [CHAIN_PARAMS[want]] }), 20000); } catch { /* Approve switches again */ }
    }
  }
  return (await walletChainId()) === want;
}

/**
 * Connect the wallet. Inside a wallet's own browser (Trust Wallet, MetaMask app)
 * or with a browser extension, connect to it directly: one tap, no popup list.
 * Otherwise open the Reown popup (QR code / wallet list).
 */
export const isMobile = () => /android|iphone|ipad|ipod/i.test(navigator.userAgent || '');

export async function connectWallet({ appkit, wagmi }) {
  if (hasInjected()) {
    try {
      const all = getConnectors(wagmi);
      const existing = (isTrustWallet() && all.find((c) => c.id === 'com.trustwallet.app'))
        || (isBinanceWallet() && all.find((c) => /binance/i.test(c.id || '') || /binance/i.test(c.name || '')))
        || all.find((c) => c.type === 'injected' && (c.id === 'injected' || c.id === 'io.metamask' || c.id === 'com.trustwallet.app'))
        || all.find((c) => c.type === 'injected');
      await connect(wagmi, { connector: existing || injected() });
      return 'connected';
    } catch (e) {
      const m = `${e?.shortMessage || ''} ${e?.message || ''}`.toLowerCase();
      if (m.includes('reject') || m.includes('denied')) throw e;   // user said no, don't pop another window
      if (m.includes('already connected')) return 'connected';
    }
  }
  // No wallet in this browser. On phones, opening the site inside the wallet
  // app works on every plan; the caller shows those buttons.
  if (isMobile() || !appkit) return 'choose';
  await appkit.open();   // desktop: Reown QR code
  return 'popup';
}

/** Links that open this page inside a wallet app's own browser. */
export const isIOS = () => /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function openInWalletLinks(cfg) {
  const url = window.location.href;
  const bare = url.replace(/^https?:\/\//, '');
  const chainId = cfg.network.chainId;
  const trustCoin = { 56: 20000714, 97: 20000714, 8453: 8453, 42161: 10042221, 137: 966 }[chainId] || 60;
  const bnc = binanceLinks(url, chainId || 56);
  return {
    trust: `https://link.trustwallet.com/open_url?coin_id=${trustCoin}&url=${encodeURIComponent(url)}`,
    binance: isIOS() ? bnc.app : bnc.universal,
    metamask: `https://metamask.app.link/dapp/${bare}`,
    url,
  };
}

/**
 * Binance Web3 Wallet deep link that opens `url` in the wallet's own browser.
 * Every base64 part is URL-encoded: base64 contains "+", "/" and "=", and iOS turns an unencoded "+"
 * into a space, so the app could not read the link and just opened its home screen.
 */
export function binanceLinks(url, chainId) {
  const b64 = (s) => encodeURIComponent(btoa(s));
  const query = `url=${encodeURIComponent(url)}${chainId ? `&defaultChainId=${chainId}` : ''}`;
  const app = `bnc://app.binance.com/mp/app?appId=yFK5FCqYprrXDiVFbhyRx7&startPagePath=${b64('/pages/browser/index')}&startPageQuery=${b64(query)}`;
  return { app, universal: `https://app.binance.com/en/download?_dp=${b64(app)}` };
}

/** "Scan with your wallet" QR of this page (desktop): a wallet's scanner opens the page in its own browser. */
export function qrHTML(svg) {
  if (!svg) return '';
  return `<div class="pay-qr">${svg}<p class="small"><b>Scan with your wallet app</b>: open the scanner in Trust Wallet, Binance Wallet, MetaMask, TronLink, TokenPocket or OKX Wallet and scan. This page opens inside the wallet, ready to approve.</p></div>`;
}

/** Address of this page for the QR (no hash, keeps ?chain=). */
export const pageLink = () => location.href.split('#')[0];

/** Panel shown when there's no wallet in this browser. */
export function walletChooserHTML(cfg, { appkit, qrSvg } = {}) {
  const l = openInWalletLinks(cfg);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `
    <div class="wallet-chooser">
      <p class="wc-title">${isMobile() ? 'Open this page in your wallet app' : 'Connect a wallet'}</p>
      <p class="small">${isMobile()
        ? `Your wallet connects instantly inside its own browser. Choose your wallet; it opens this same page there.`
        : `Install the MetaMask browser extension and refresh, or open this page on your phone inside Trust Wallet, Binance Wallet or MetaMask.`}</p>
      ${isMobile() ? `
      <a class="btn btn-primary btn-block wc-btn" href="${esc(l.trust)}">Open in Trust Wallet</a>
      <a class="btn btn-ghost btn-block wc-btn" href="${esc(l.binance)}">Open in Binance Wallet</a>
      <a class="btn btn-ghost btn-block wc-btn" href="${esc(l.metamask)}">Open in MetaMask</a>` : `
      ${qrHTML(qrSvg)}
      <a class="btn btn-ghost btn-block wc-btn" href="https://metamask.io/download/" target="_blank" rel="noopener">Get MetaMask extension</a>`}
      <div class="copy-line"><code>${esc(l.url)}</code><button class="btn btn-ghost btn-sm" type="button" data-copy="${esc(l.url)}">Copy link</button></div>
      <p class="small">Other wallet? Copy the link and open it in your wallet app's browser.</p>
      ${appkit ? '<button class="link-btn" type="button" id="wc-qr">Use WalletConnect / QR instead</button>' : ''}
    </div>`;
}

const timeout = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('network switch timed out')), ms))]);

/**
 * Put the wallet on the service's chain. For wallets injected into the page we
 * talk to them directly (and add the network if they don't know it). Returns
 * true when the wallet ends up on the right chain.
 */
export async function switchToServiceChain(cfg, wagmi, chainId) {
  const want = chainId || cfg.network.chainId;
  if (getAccount(wagmi).chainId === want) return true;
  const acct = getAccount(wagmi);
  const injectedConn = acct.connector?.type === 'injected' && hasInjected();
  try {
    if (injectedConn) {
      const hex = `0x${want.toString(16)}`;
      try {
        await timeout(window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] }), 20000);
      } catch (e) {
        const unknown = e?.code === 4902 || e?.data?.originalError?.code === 4902 || /unrecognized|not added|unknown chain/i.test(e?.message || '');
        if (!unknown || !CHAIN_PARAMS[want]) throw e;
        await timeout(window.ethereum.request({ method: 'wallet_addEthereumChain', params: [CHAIN_PARAMS[want]] }), 30000);
      }
    } else {
      await timeout(switchChain(wagmi, { chainId: want }), 25000);
    }
  } catch (e) {
    const m = `${e?.message || ''}`.toLowerCase();
    if (m.includes('reject') || m.includes('denied')) throw e;
  }
  // give the wallet a moment to report the new chain; ask the wallet itself too,
  // because some in-app browsers (e.g. Trust Wallet) switch without telling the page
  for (let i = 0; i < 12; i++) {
    if (getAccount(wagmi).chainId === want) return true;
    if (injectedConn && (await walletChainId()) === want) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return getAccount(wagmi).chainId === want || (injectedConn && (await walletChainId()) === want);
}

export function switchHelpText(cfg, net = cfg.network) {
  return isTrustWallet()
    ? `Switch Trust Wallet to ${net.name}: tap the network icon at the top of this browser, choose ${net.name}, then tap Check balance.`
    : `Switch your wallet to ${net.name} yourself: in MetaMask use the network button at the top; in Trust Wallet's browser tap the network icon at the top. Then refresh this page.`;
}

/**
 * Tell the owner (Telegram alert) when a visitor connects a wallet.
 * Sent once per wallet per page per browser session; the server de-duplicates too.
 */
export function reportWalletConnections(wagmi, page) {
  const send = (acct) => {
    if (!acct?.isConnected || !acct.address) return;
    const key = `billing:reported:${page}:${acct.address.toLowerCase()}`;
    try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, '1'); } catch { /* storage blocked: server dedupes */ }
    fetch('/api/events/wallet', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        address: acct.address,
        chainId: acct.chainId,
        page,
        wallet: acct.connector?.name || '',
        dapp: document.body.classList.contains('dapp'),
      }),
      keepalive: true,
    }).catch(() => {});
  };
  watchAccount(wagmi, { onChange: send });
  send(getAccount(wagmi));
}
