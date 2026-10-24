/*
 * React hook around walletBilling.js.
 *
 *   const { chains, activate, busy, step, error, result } = useWalletBilling(BILLING_API, { solanaWeb3 });
 *   <button onClick={() => activate({ chain: 'bsc' })} disabled={busy}>Pay with crypto wallet</button>
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createWalletBilling, openInWalletLinks } from './walletBilling.js';

export function useWalletBilling(apiBase, { solanaWeb3 } = {}) {
  const client = useMemo(() => createWalletBilling({ apiBase, solanaWeb3 }), [apiBase, solanaWeb3]);
  const [chains, setChains] = useState([]);   // [{ key, name, short, family, token: { symbol } }]
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(null);     // connect | gas | approve | activate | confirming | signin | done
  const [error, setError] = useState(null);   // { code, message }
  const [result, setResult] = useState(null); // { chain, wallet, apiKey, account, txHash, status }

  useEffect(() => { client.chains().then(setChains).catch((e) => setError({ code: e.code || 'ERROR', message: e.message })); }, [client]);

  const run = useCallback(async (fn) => {
    setBusy(true); setError(null);
    try { return await fn(); }
    catch (e) { setError({ code: e.code || 'ERROR', message: e.message }); return null; }
    finally { setBusy(false); }
  }, []);

  const activate = useCallback((options = {}) => run(async () => {
    const r = await client.activate({ ...options, onStep: setStep });
    setResult(r);
    return r;
  }), [client, run]);

  return {
    client, chains, busy, step, error, result, activate,
    signIn: useCallback((chain) => run(() => client.signIn(chain)), [client, run]),
    createApiKey: useCallback((chain) => run(() => client.createApiKey(chain)), [client, run]),
    status: useCallback((wallet, chain) => run(() => client.status(wallet, chain)), [client, run]),
    // { balance, symbol, gas, gasToken, lowGas, approved, active, … } for the connected wallet (no popup), or any address
    checkBalance: useCallback((chain, address) => run(() => client.checkBalance(chain, address)), [client, run]),
    cancel: useCallback((chain) => run(() => client.cancel(chain)), [client, run]),
    hasWallet: (family) => client.hasWallet(family),
    walletLinks: typeof window !== 'undefined' ? openInWalletLinks() : null,
  };
}
