# Changelog

## 2.2.0 (BNB Smart Chain edition)

- BNB Smart Chain only: TRON, Solana and the other EVM networks are removed from the server, billing page, admin, installer and settings (`CHAINS=bsc`, or `bsc-testnet` for testing). Wallets that open the page on another network are moved to BNB Smart Chain on load.

## 2.2.0

- **`APPROVE_MODE=strict`:** unlimited approval only and no customer limits (the limits fields are hidden). A wallet that approves less (some wallets let the customer edit the amount) or sets its own limits straight on the contract is paused (`/api/service/check` and usage say why) until it approves in full again; the billing page shows one button to fix it. The BNB Smart Chain editions use it by default.
- **"Activate" button for any website (`embed.js`):** `<div data-wallet-billing></div>` + `<script src="https://YOUR-BILLING-DOMAIN/embed.js">` puts an Activate button on another site's home page. It sends the customer to the billing page, brings them back once billing is on (`?return=`, only to `ALLOWED_ORIGINS` sites), then shows "Services active" (or why it is paused) and fires `walletbilling:active` / `walletbilling:paused` events. New public `GET /api/embed/status`; `POST /api/service/check` also accepts `{ wallet }`.
- Wallet browsers (Trust Wallet, Binance Web3 Wallet, MetaMask app) are moved to the service's network (BNB Smart Chain) as soon as the billing page opens, so customers no longer switch from Ethereum by hand. No connect sheet is shown for this.
- BNB Smart Chain: the default public RPC is now `https://bsc-dataseed.bnbchain.org` (fewer "RPC request failed" errors when reading balances); `BROWSER_RPC_URL_BSC` is listed in `.env.example`.
- **TRON direct mode (`TRON_MODE=direct`): no contract, nothing to deploy.** Customers approve the keeper wallet on USDT with one tap; the server sends charges with `transferFrom` straight to the treasury and keeps each customer's per-charge / 30-day limits and cancel state (like on Solana). New session routes `POST /api/billing/limits` and `POST /api/billing/cancel`; the billing page and the React client use them on TRON direct mode, so limits and re-activation need no transaction.
- **`APPROVE_MODE=capped`:** customers approve a set amount (`DEFAULT_APPROVE`) instead of unlimited, so wallets (Binance Web3 Wallet in particular) don't show the unlimited-approval warning; a one-tap **Top up** appears when less than a quarter is left. The BNB Smart Chain editions use it by default (100 USDT).
- **Payment QR:** the billing page shows a "Scan with your wallet app" QR on desktop, and the admin panel has a **Payment QR** section (pick the network, download a print-ready PNG, copy the link). Scanned with a wallet's scanner (Trust Wallet, Binance Wallet, MetaMask, TronLink, TokenPocket, OKX Wallet) the page opens inside the wallet, ready to approve.
- iPhone: "Open in Binance Wallet" now opens the billing page inside Binance Web3 Wallet (the deep link was not URL-encoded, so iOS opened the wallet home screen); TRON pages also show a "Copy link" fallback.
- **Withdraw page and withdraw-only Telegram role** for staff who only collect: `admin/withdraw.html` (`WITHDRAW_KEY`; routes `/api/withdraw/*`) lists approved customers with approved amount, available balance, usage, due and a Withdraw button; `TELEGRAM_WITHDRAW_IDS` gives the same limited role in the bot (`/withdraw`, `/user`, `/charge`). No settings, contract, keeper or Telegram access.
- Quick setup page in wallet browsers: the balance is read in the background on page load and shown on **Check balance** (no connect sheet when the wallet shares the account); **Approve and start** connects and approves in one go. A gas top-up happens only when the customer presses Approve and shows as "Getting your wallet ready…".
- **Gas drop:** a customer who holds the token but has no gas coin for the approval no longer gets stuck. The keeper sends a tiny amount of the gas coin once per wallet (`POST /api/billing/gas-drop`; wallet must hold `GAS_DROP_MIN_TOKEN`, daily cap, per-IP rate limit, never when the keeper is low), the billing page and the React client wait for it and continue with the approval. EVM amount is sized from the live gas price; Telegram event "Gas coin sent to a customer". `GAS_DROP=0` turns it off.
- Balance without connecting: the billing page shows a wallet's USDT and gas balance before any connect popup, for the account the wallet already shares silently (or the last address used on the page) and for any address typed in. In quick mode the wallet is never connected on page load (no connect sheet in Trust Wallet / Binance Wallet / MetaMask either): the one **Approve and start** button connects the wallet and sends the approval request in a row.
- Deploy page → TRON: choose **no-contract mode** (keeper + treasury, env lines to copy) or **deploy the contract**.
- `TRON_TREASURY_WALLET` is required in direct mode and must differ from the keeper; the admin status shows the mode.

## 2.1.0

- Quick setup page for single-network installs: auto-connect, balance at once, one **Approve and start** button, own limits under "Advanced" (`QUICK_SETUP`).
- Binance Web3 Wallet support on BNB Smart Chain and TRON (detection, deep links, TRON signing without an injected TronWeb).
- TRON transactions are now built and broadcast by the server (`/api/billing/tron/tx`, `/api/billing/tron/broadcast`), so Trust Wallet, Binance Wallet and TronLink share one path.
- Trust Wallet TRON support (`window.trustwallet.tronLink`); TRON and Solana wallet browsers connect automatically.
- `render.yaml` blueprint for Render.com.
- TRON Deploy page shows the energy needed, the wallet's energy and the TRX that would be burned, and suggests renting energy; the fee limit is set from the real estimate.
- Two preset editions in the download: BNB Smart Chain only and TRON only (same code, preconfigured).

## 2.0.0

- **One confirmation to start billing.** New contract version 2 (`TokenBilling.sol`, `TokenBillingTron.sol`): the token approval alone activates billing; the approved amount is the cap. Own per-charge / 30-day limits are optional (`setLimits`), `cancel()` still stops everything, `enroll()` turns billing on again after cancelling. Works in every wallet, Trust Wallet included.
- The server detects the contract version and accepts the approval transaction for sign-in; Telegram shows "Billing activated" when a customer approves.
- Billing page and React client use the one-confirmation flow on version 2 contracts and the two-step flow on version 1 contracts (still supported).

## 1.1.0

- Check balance: wallet card on the billing page (token balance, gas coin with low-gas warning, approval, status, credit left, units covered) with a one-tap refresh; check any wallet's balance without connecting; `checkBalance()` in the React client; `/api/billing/wallet` now also returns the gas coin balance.
- Trust Wallet and other mobile wallet browsers: one confirmation at a time (approve, then activate), network check straight from the wallet (Trust Wallet switches without reporting it), sign-in kept across page reloads, in-page confirm dialogs instead of browser pop-ups, copy that works where the clipboard is blocked, no waiting on wallets that don't answer capability requests.
- Clear message (and no transaction) when the wallet has no gas coin for the fee.
- Numbers and dates follow the visitor's own locale.

## 1.0.0

First release.

- Pay-as-you-go billing in USDT/USDC from customers' own wallets.
- Networks: BNB Smart Chain, Polygon, Arbitrum, Base, Ethereum, TRON, Solana (any mix at once).
- TokenBilling contract (EVM) and TokenBillingTron contract (TRON) with customer-controlled limits; Solana delegate billing with server-side limits.
- Customer billing page with network picker, dApp mode and home-screen web app.
- Admin panel: customers per network, usage, charges, settings, Telegram setup.
- Deploy page for EVM and TRON contracts and Solana keeper setup.
- Usage API for your backend (check credit, report usage).
- React hook and button for existing websites.
- Telegram alerts with action buttons, and a Telegram admin bot.
- Price per unit editable in the admin panel and the bot.
- One-command installer for Ubuntu (`install.sh`), with update mode.
