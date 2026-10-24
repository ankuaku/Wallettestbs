/*
 * Example: how YOUR backend (Node/Express) uses Wallet Billing.
 * Any language works: these are plain HTTPS POST calls. Works the same for every chain.
 *
 * .env of your backend:
 *   BILLING_API=https://billing.yourdomain.com
 *   BILLING_SERVICE_KEY=<the SERVICE_API_KEY from the billing server's .env>
 */
const BILLING_API = process.env.BILLING_API;
const SERVICE_KEY = process.env.BILLING_SERVICE_KEY;

async function billing(path, body) {
  const res = await fetch(`${BILLING_API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-service-key': SERVICE_KEY },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error || `billing ${res.status}`);
  return j;
}

// 1) The React button calls onActivated({ chain, wallet, apiKey }) -> your frontend POSTs it here.
//    Verify it (the key must be valid and belong to that wallet), then save it on the logged-in user.
app.post('/api/me/billing', requireLogin, async (req, res) => {
  const { wallet, apiKey } = req.body;
  const check = await billing('/api/service/check', { apiKey });
  // EVM addresses are case-insensitive; TRON and Solana addresses are compared exactly
  const same = check.wallet && (check.wallet === wallet || check.wallet.toLowerCase() === String(wallet).toLowerCase());
  if (!same) return res.status(400).json({ error: 'Invalid billing key' });
  await db.users.update(req.user.id, { billingAccount: check.account, billingKey: apiKey });   // account = "<chain>:<address>"
  res.json({ ok: true, chain: check.chain, creditLeft: check.creditLeft, symbol: check.symbol });
});

// 2) Before doing paid work for a user: check they can still pay.
async function canServe(user, estimatedUnits = 0) {
  if (!user.billingKey) return { ok: false, reason: 'Set up wallet billing first' };
  const c = await billing('/api/service/check', { apiKey: user.billingKey });
  if (!c.ok) return { ok: false, reason: c.reason };                 // e.g. "approval revoked"
  if (estimatedUnits > c.tokensLeft) return { ok: false, reason: 'Not enough credit left' };
  return { ok: true, unitsLeft: c.tokensLeft };
}

// 3) After the work is done: report how many units were used.
async function reportUsage(user, units, note) {
  const u = await billing('/api/service/usage', { apiKey: user.billingKey, tokens: units, note });
  if (u.stop) await db.users.update(user.id, { billingPaused: true });   // refuse the next request
  return u;   // { cost, due, creditLeft, tokensLeft, stop, symbol, chain }
}

// Charging stays manual: the admin presses "Charge" in the billing admin panel.
