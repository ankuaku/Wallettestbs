# Add wallet billing to your own website

For a site (React, Next.js, Vue...) that already has its own "Pay" / "Subscribe" button.
Nothing from your website's code needs to be shared.

| File | What it is |
|---|---|
| `react/walletBilling.js` | Framework-free client for every enabled chain: EVM (MetaMask, Trust...), TRON (TronLink), Solana (Phantom). Connect, switch network, activate (one approval on contract version 2), sign in, API key, check balance, cancel. |
| `react/useWalletBilling.js` | React hook (`chains`, `busy`, `step`, `error`, `result`, `activate`...). |
| `react/PayWithWalletButton.jsx` | Ready-made button with a network picker. Or use the hook with your own button. |
| `server-example.js` | Your backend: verify and save the key, check before serving, report usage after. |

## Steps

1. Billing server `.env`: `ALLOWED_ORIGINS=https://www.your-site.com` (exact origin), restart.
2. React project: `npm install ethers` (plus `npm install @solana/web3.js` if Solana is enabled). Copy the three files from `react/` to e.g. `src/billing/`.
3. Connect your existing button:

```jsx
import * as solanaWeb3 from '@solana/web3.js';               // only if Solana is enabled
import { useWalletBilling } from './billing/useWalletBilling.js';

function PlanCheckout() {
  const { chains, activate, busy, step, error, hasWallet, walletLinks } =
    useWalletBilling('https://billing.your-site.com', { solanaWeb3 });
  const [chain, setChain] = useState('bsc');

  const onPay = async () => {
    const r = await activate({ chain });                      // { chain, wallet, apiKey, account, txHash, status }
    if (!r) return;                                           // cancelled or failed: see `error`
    await fetch('/api/me/billing', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chain: r.chain, wallet: r.wallet, apiKey: r.apiKey }) });
  };

  return <>
    {chains.map((c) => <button key={c.key} onClick={() => setChain(c.key)} aria-pressed={c.key === chain}>{c.short} · {c.token.symbol}</button>)}
    <button onClick={onPay} disabled={busy}>{busy ? `Working: ${step}…` : 'Pay with crypto wallet'}</button>
    {error && error.code !== 'REJECTED' && <p>{error.message}</p>}
  </>;
}
```

4. Your backend: follow `server-example.js`.
5. Charging stays in the billing admin panel (**Charge** button).

`activate()` options: `{ chain, unlimited: true, approve: 100, maxPerCharge: null, maxPerPeriod: null }` (`null` = no limit).
On Solana use a set approval (`unlimited: false, approve: 100`): it is the most that can ever be collected until the customer approves again.

### Check balance

```js
const b = await checkBalance('bsc');            // connected wallet, no popup (connects only if needed)
// { balance: '812.4', symbol: 'USDT', gas: '0.0123', gasToken: 'BNB', lowGas: false,
//   approved: 'unlimited', active: true, remainingInPeriod: 'unlimited', … }
const other = await checkBalance('bsc', '0xAnyAddress');   // any wallet, read-only
```

Show it next to your Pay button, and warn when `lowGas` is true (the customer needs a little BNB/POL/ETH/TRX/SOL for the network fee). `activate()` stops with error code `NO_GAS` when the wallet has none at all.

### Trust Wallet and other mobile wallet browsers

With contract version 2 `activate()` needs a single wallet confirmation (the approval) unless you pass `maxPerCharge` / `maxPerPeriod` (own limits: a second confirmation). Inside a wallet app's own browser the client sends one request at a time, checks the network itself after switching (Trust Wallet doesn't always report it), and keeps the customer signed in across page reloads. Open your page in Trust Wallet with `walletLinks.trust`.

Wallets per chain: EVM needs `window.ethereum`, TRON `window.tronLink`/`window.tronWeb`, Solana `window.phantom.solana` (or Solflare/Backpack). `hasWallet(family)` tells you; `walletLinks.metamask / trust / phantom` reopen your page inside those apps on phones.
