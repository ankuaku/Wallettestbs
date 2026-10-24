/*
 * Drop-in "Pay with crypto wallet" button with a network picker.
 *
 *   import * as solanaWeb3 from '@solana/web3.js';   // only if Solana is enabled
 *   <PayWithWalletButton
 *     apiBase="https://billing.yourdomain.com"
 *     solanaWeb3={solanaWeb3}
 *     onActivated={async ({ chain, wallet, apiKey }) => {
 *       await fetch('/api/me/billing', { method: 'POST', headers: { 'content-type': 'application/json' },
 *         body: JSON.stringify({ chain, wallet, apiKey }) });
 *     }}
 *   />
 *
 * Props: chain (fix one chain and hide the picker), options ({ unlimited, approve, maxPerCharge, maxPerPeriod }),
 * className (your button class), children (button text), onError.
 */
import { useEffect, useState } from 'react';
import { useWalletBilling } from './useWalletBilling.js';

const STEP_TEXT = {
  connect: 'Connecting wallet…',
  gas: 'Adding a little gas coin to your wallet for the network fee…',
  approve: 'Confirm the approval in your wallet…',
  activate: 'Confirm the activation in your wallet…',
  confirming: 'Waiting for the blockchain…',
  signin: 'Finishing setup…',
};

export default function PayWithWalletButton({ apiBase, solanaWeb3, chain: fixedChain, onActivated, onError, options, className, children = 'Pay with crypto wallet' }) {
  const { chains, activate, busy, step, error, hasWallet, walletLinks } = useWalletBilling(apiBase, { solanaWeb3 });
  const [chain, setChain] = useState(fixedChain || null);
  useEffect(() => { if (!chain && chains.length) setChain(chains[0].key); }, [chains, chain]);
  useEffect(() => { if (error) onError?.(error); }, [error]); // eslint-disable-line react-hooks/exhaustive-deps

  const current = chains.find((c) => c.key === chain);
  const family = current?.family || 'evm';

  const click = async () => {
    const r = await activate({ ...(family === 'solana' ? { unlimited: false, approve: 100 } : {}), ...options, chain });
    if (r) await onActivated?.(r);
  };

  return (
    <div className="wallet-billing">
      {!fixedChain && chains.length > 1 && (
        <div className="wallet-billing-chains" role="group" aria-label="Network">
          {chains.map((c) => (
            <button key={c.key} type="button" aria-pressed={c.key === chain} onClick={() => setChain(c.key)} disabled={busy}>
              {c.short} · {c.token.symbol}
            </button>
          ))}
        </div>
      )}
      {current && !hasWallet(family) ? (
        <div className="wallet-billing-open">
          <p>Open this page in your wallet app to continue:</p>
          {family === 'solana' && <a className={className} href={walletLinks?.phantom}>Open in Phantom</a>}
          {family === 'evm' && <><a className={className} href={walletLinks?.metamask}>Open in MetaMask</a>{' '}<a className={className} href={walletLinks?.trust}>Open in Trust Wallet</a></>}
          {family === 'tron' && <span>Open it in TronLink (or install the TronLink extension).</span>}
        </div>
      ) : (
        <button type="button" className={className} onClick={click} disabled={busy || !current}>
          {busy ? (STEP_TEXT[step] || 'Please wait…') : children}
        </button>
      )}
      {error && error.code !== 'REJECTED' && <p className="wallet-billing-error" role="alert">{error.message}</p>}
    </div>
  );
}
