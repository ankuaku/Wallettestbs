# Developer guide: add the "Connect now" button to your website

This guide is for the developer of the website where customers should **activate** the service (your home page, pricing page, dashboard…). It takes about 15 minutes.

Your website stays as it is. You add one button. The button sends the customer to the billing page, where they approve USDT once in their wallet (Trust Wallet, Binance Web3 Wallet, MetaMask). Then they come back to your page with billing switched on, and your server checks their wallet before serving them.

```
Your website                        Billing server (this package)              Your server
─────────────                       ─────────────────────────────              ───────────
[Connect now]  ──click──▶  billing page: Approve USDT (1 confirmation)
               ◀─back────  ?wb_wallet=0x…&wb_status=active
"✓ Services active"  ──wallet──────────────────────────────────────────▶  save wallet on the user
                                     /api/service/check { wallet }  ◀──────  before serving
                                     /api/service/usage { wallet, tokens } ◀  after serving
```

---

## 1. Before you start

You need from the person who runs the billing server:

| What | Example | Where it comes from |
|---|---|---|
| Billing server address | `https://billing.yourdomain.com` | Where this package is installed |
| Service key | `SERVICE_API_KEY` value | `backend/.env` on the billing server (keep it on your server only, never in the browser) |

On the billing server, `backend/.env` must contain your website's address so customers are sent back to it:

```
ALLOWED_ORIGINS=https://www.yoursite.com,https://yoursite.com
```

Write every address your site opens on (with and without `www`), without a path and without a trailing `/`. Restart the billing server after changing it.

The billing contract must be deployed and the billing page must work on its own first (open `https://billing.yourdomain.com` in Trust Wallet and approve once with a test wallet).

---

## 2. Add the button (2 lines)

Paste this where the button should appear, for example on the home page:

```html
<div data-wallet-billing data-label="Connect now"></div>
<script src="https://billing.yourdomain.com/embed.js" async></script>
```

That's all for the button. Load the `<script>` once per page, even with several buttons.

**Prepaid mode:** if the billing server runs with `PREPAID=1`, the same button automatically becomes a **Pay with USDT** button. The customer taps it, lands on the pay page (amount → review → wallet transfer), and comes back with credit added. You can still override the text with `data-label="Pay with USDT"`.

What the customer sees:

| Situation | Button shows |
|---|---|
| New visitor | **Connect now** |
| Came back after approving | **✓ Services active** · wallet `0x12…ab` · *Manage* |
| Billing paused (approval revoked, limited approval, empty wallet…) | **Connect now** + "Paused for 0x12…ab: *reason*" + *Use another wallet* |

Options (attributes on the `<div>`, all optional):

| Attribute | Default | Meaning |
|---|---|---|
| `data-label` | Activate services | Button text, e.g. `Connect now`, `Start with crypto` |
| `data-active-label` | Services active | Text when billing is on |
| `data-theme` | (yellow) | `dark` = dark button |
| `data-return` | the current page | Page to come back to after approving (must be on an `ALLOWED_ORIGINS` site) |
| `data-chain` | the server's network | Only for billing servers with several networks |

The default button has the class `wb-btn` (active state `wb-btn wb-on`), so you can restyle it from your own CSS:

```css
[data-wallet-billing] .wb-btn { background: #6d28d9; color: #fff; border-radius: 999px; }
```

### Your own button instead

Already have a button in your design? Give it `data-wallet-billing-link` and keep the script tag:

```html
<button class="my-cta" data-wallet-billing-link>Connect now</button>
<script src="https://billing.yourdomain.com/embed.js" async></script>
```

Clicking it opens the billing page (with the way back). While billing is on, the element also gets the class `wb-is-active`, for example to hide it:

```css
.my-cta.wb-is-active { display: none; }
```

---

## 3. Connect the wallet to your logged-in user

When the customer comes back, the script fires an event with the wallet address. Send it to **your** server and store it on the user:

```html
<script>
  window.addEventListener('walletbilling:active', function (e) {
    // e.detail.wallet = "0x…", e.detail.chain = "bsc"
    fetch('/api/me/wallet', {                 // your own route
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ wallet: e.detail.wallet, chain: e.detail.chain }),
    });
  });

  window.addEventListener('walletbilling:paused', function (e) {
    // e.detail.reason, e.g. "approval revoked": show your own message if you like
  });
</script>
```

The event fires on every page load where the remembered wallet is active, so your route should simply save (or overwrite) the wallet on the user.

Also available in the browser:

| Call | Returns |
|---|---|
| `WalletBilling.wallet()` | The remembered wallet or `null` |
| `WalletBilling.status()` | `{ active, usable, reason }` from the last check |
| `WalletBilling.refresh()` | Checks again (promise) |
| `WalletBilling.reset()` | Forgets the wallet (e.g. on log out) |
| `WalletBilling.url()` | The billing page link with the way back, for your own redirects |

---

## 4. Check before serving (on your server)

Anyone can type a wallet into a URL, so **never trust the browser**. Before you serve a request, your server asks the billing server:

```bash
curl -X POST https://billing.yourdomain.com/api/service/check \
  -H "x-service-key: YOUR_SERVICE_API_KEY" -H "content-type: application/json" \
  -d '{"wallet":"0x1234…"}'
```

```json
{ "ok": true, "chain": "bsc", "wallet": "0x1234…", "symbol": "USDT",
  "creditLeft": "18.50", "tokensLeft": 9250, "due": "1.50", "reason": null }
```

- `ok: false` → don't serve; show `reason` (or "Activate again" with the button).
- `tokensLeft` → never serve more than this in one request (counted in the billing server's `UNIT_NAME`).

After serving, report what was used:

```bash
curl -X POST https://billing.yourdomain.com/api/service/usage \
  -H "x-service-key: YOUR_SERVICE_API_KEY" -H "content-type: application/json" \
  -d '{"wallet":"0x1234…","tokens":1500,"note":"chat #42"}'
```

```json
{ "cost": "3.00", "due": "4.50", "creditLeft": "15.50", "tokensLeft": 7750, "stop": false, "reason": null }
```

If `stop` is `true`, refuse the next request until the customer fixes it (the button shows them how).

### Node.js (Express)

```js
const BILLING = 'https://billing.yourdomain.com';
const KEY = process.env.BILLING_SERVICE_KEY;          // = SERVICE_API_KEY of the billing server

async function billing(path, body) {
  const r = await fetch(BILLING + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-service-key': KEY },
    body: JSON.stringify(body),
  });
  return r.json();
}

app.post('/api/generate', requireLogin, async (req, res) => {
  const wallet = req.user.wallet;                     // saved in step 3
  if (!wallet) return res.status(402).json({ error: 'Connect your wallet first.' });
  const c = await billing('/api/service/check', { wallet });
  if (!c.ok) return res.status(402).json({ error: `Billing paused: ${c.reason}` });

  const result = await doTheWork(req.body, { maxUnits: c.tokensLeft });
  await billing('/api/service/usage', { wallet, tokens: result.unitsUsed, note: 'generate' });
  res.json(result);
});
```

### PHP

```php
function billing($path, $body) {
  $ch = curl_init('https://billing.yourdomain.com' . $path);
  curl_setopt_array($ch, [
    CURLOPT_POST => true, CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HTTPHEADER => ['content-type: application/json', 'x-service-key: ' . getenv('BILLING_SERVICE_KEY')],
    CURLOPT_POSTFIELDS => json_encode($body),
  ]);
  $out = json_decode(curl_exec($ch), true);
  curl_close($ch);
  return $out;
}

$c = billing('/api/service/check', ['wallet' => $user['wallet']]);
if (!$c['ok']) { http_response_code(402); exit('Billing paused: ' . $c['reason']); }
// … serve …
billing('/api/service/usage', ['wallet' => $user['wallet'], 'tokens' => $unitsUsed]);
```

### Python

```python
import os, requests
BILLING = 'https://billing.yourdomain.com'
H = {'x-service-key': os.environ['BILLING_SERVICE_KEY']}

c = requests.post(f'{BILLING}/api/service/check', json={'wallet': user.wallet}, headers=H, timeout=15).json()
if not c['ok']:
    raise PermissionError(f"Billing paused: {c['reason']}")
# … serve …
requests.post(f'{BILLING}/api/service/usage', json={'wallet': user.wallet, 'tokens': units_used}, headers=H, timeout=15)
```

---

## 5. React / Next.js sites

The two-line button works in React too: put the `<div data-wallet-billing …>` in your JSX and load `embed.js` once (for example with Next.js `<Script src="…/embed.js" strategy="afterInteractive" />`). After client-side navigation call `window.WalletBilling?.refresh()` to draw new buttons.

If you want the whole approval to happen **inside** your page instead (no trip to the billing page), use `integrations/react/` (hook `useWalletBilling` + `PayWithWalletButton`), described in `integrations/README.md`.

---

## 6. Test checklist

1. Open your page on a phone inside **Trust Wallet** (Browser tab → your URL). The button shows **Connect now**.
2. Tap it → the billing page opens on the service's network (e.g. BNB Smart Chain) → **Approve USDT and start** → confirm once.
3. You land back on your page → button shows **✓ Services active**, and your `walletbilling:active` handler saved the wallet.
4. Call your protected route → it serves, and the billing admin panel shows the usage as **due**.
5. Revoke the approval (revoke.cash or **Cancel billing** on the billing page) → within a minute `check` returns `ok: false` and your page shows **Paused**.

A test wallet with no gas coin (BNB) works too: the billing server sends it a little for the fee when the customer taps Approve (EVM networks, `GAS_DROP`).

---

## 7. Troubleshooting

| Problem | Fix |
|---|---|
| After approving, the customer stays on the billing page | Add your site to `ALLOWED_ORIGINS` exactly as it appears in the address bar (`https://` + domain, with/without `www`), restart the billing server |
| Button doesn't appear | Check the browser console: the `embed.js` URL must be the billing server's address over `https://` |
| Button says "Paused for …" | Read the reason: *approval revoked* (customer revoked it), *billing not active* (cancelled), *full (unlimited) approval required* / *own spending limits are not allowed* (customer changed the approval: they tap the button and fix it in one confirmation), *wallet balance too low* (no USDT left) |
| `check` returns `{"error":"Wrong service key."}` | Send the billing server's `SERVICE_API_KEY` in the `x-service-key` header, from your server |
| The wallet opens the page on another network | Nothing to do: the billing page switches the wallet to the service's network by itself |
| Customer opened your site in Chrome / Safari, not in a wallet | The billing page shows "Open in Trust Wallet / Binance Wallet" buttons; after approving there, they continue on your site inside that wallet's browser |

---

## 8. Security notes

- `SERVICE_API_KEY` stays on your server. The browser only ever sees the public `embed.js` and the wallet address.
- The `wb_wallet` value in your URL is only a hint: always confirm with `/api/service/check` from your server.
- The billing server returns customers only to `ALLOWED_ORIGINS` sites, so the button can't be used to send people to other websites.
- `GET /api/embed/status?wallet=…` (used by the button) is public and only says whether billing is on; it shows no amounts.
