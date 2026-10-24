/*!
 * Wallet Billing: "Activate" button for any website.
 *
 *   <div data-wallet-billing></div>
 *   <script src="https://billing.yourdomain.com/embed.js" async></script>
 *
 * Options (attributes on the div, all optional):
 *   data-label="Activate services"     button text
 *   data-active-label="Services active" text once billing is on
 *   data-chain="bsc"                    network (single-network installs need nothing)
 *   data-return="https://…"             page to come back to (default: this page)
 *   data-theme="dark"                   dark button
 *
 * Your own button instead (any design): give it data-wallet-billing-link, the script makes it open the billing page.
 *   <button data-wallet-billing-link>Connect now</button>   (also <a>, data-chain / data-return work on it)
 *   While billing is on, the element gets the class "wb-is-active" (style it as you like).
 *
 * Add your site to ALLOWED_ORIGINS in the billing server's .env (e.g. https://www.yoursite.com) so the
 * customer is sent back to it after approving.
 *
 * Events on window, for your own code:
 *   walletbilling:active  detail { wallet, chain }  (customer just came back with billing on, or already had it)
 *   walletbilling:paused  detail { wallet, chain, reason }
 * window.WalletBilling.wallet() returns the remembered wallet (or null); .reset() forgets it.
 * The wallet in the URL can be typed by anyone: before serving, your server checks it with
 * POST /api/service/check { wallet } (service key), see the documentation.
 */
(function () {
  'use strict';
  var me = document.currentScript || (function () { var s = document.querySelectorAll('script[src*="embed.js"]'); return s[s.length - 1]; })();
  var BASE = new URL(me.src, location.href).origin;
  var KEY = 'walletbilling:wallet';
  var store = {
    get: function () { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } },
    set: function (v) { try { if (v) localStorage.setItem(KEY, JSON.stringify(v)); else localStorage.removeItem(KEY); } catch (e) { /* private mode */ } },
  };
  var fire = function (name, detail) { try { window.dispatchEvent(new CustomEvent('walletbilling:' + name, { detail: detail })); } catch (e) { /* old browser */ } };
  var esc = function (t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]; }); };
  var short = function (w) { w = esc(w); return w.length > 12 ? w.slice(0, 6) + '…' + w.slice(-4) : w; };

  // Back from the billing page: ?wb_wallet=…&wb_chain=…&wb_status=active
  var q = new URLSearchParams(location.search);
  if (q.get('wb_wallet')) {
    // only real-looking addresses / chain names are kept (they end up on the page)
    var w = q.get('wb_wallet'); var c = q.get('wb_chain') || '';
    if (/^[A-Za-z0-9]{20,64}$/.test(w) && /^[a-z0-9-]{0,24}$/.test(c)) store.set({ wallet: w, chain: c });
    ['wb_wallet', 'wb_chain', 'wb_status'].forEach(function (k) { q.delete(k); });
    var clean = location.pathname + (q.toString() ? '?' + q.toString() : '') + location.hash;
    try { history.replaceState(null, '', clean); } catch (e) { /* ignore */ }
  }

  var css = '.wb-btn{display:inline-flex;align-items:center;gap:8px;border:0;border-radius:10px;padding:12px 20px;font:600 15px/1.2 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;cursor:pointer;background:#F0B90B;color:#1E2026;text-decoration:none;transition:filter .15s}'
    + '.wb-btn:hover{filter:brightness(1.05)}.wb-btn:focus-visible{outline:3px solid #1E2026;outline-offset:2px}'
    + '.wb-btn.wb-dark{background:#1E2026;color:#fff}.wb-btn.wb-on{background:#E7F4EE;color:#0E7C4A;cursor:default}'
    + '.wb-wrap{display:inline-flex;flex-direction:column;gap:6px;align-items:flex-start}.wb-note{font:13px/1.4 system-ui,sans-serif;color:#6B7280}'
    + '.wb-note a,.wb-note button{color:inherit;text-decoration:underline;background:none;border:0;padding:0;font:inherit;cursor:pointer}';
  var style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

  function billingUrl(el) {
    var u = new URL('/', BASE);
    u.searchParams.set('return', el.getAttribute('data-return') || location.href.split('#')[0]);
    if (el.getAttribute('data-chain')) u.searchParams.set('chain', el.getAttribute('data-chain'));
    return u.toString();
  }

  function defLabel() { return cfg && cfg.prepaid ? ('Pay with ' + (cfg.symbol || 'USDT')) : 'Activate services'; }
  function defActive() { return cfg && cfg.prepaid ? ('Credit active · ' + (cfg.symbol || 'USDT')) : 'Services active'; }
  function draw(el, state) {
    var label = esc(el.getAttribute('data-label') || defLabel());
    var dark = el.getAttribute('data-theme') === 'dark' ? ' wb-dark' : '';
    var saved = store.get();
    var html;
    if (state && state.usable) {
      html = '<span class="wb-btn wb-on" role="status">✓ ' + esc(el.getAttribute('data-active-label') || defActive()) + '</span>'
        + '<span class="wb-note">Wallet ' + short(saved && saved.wallet) + ' · <a href="' + esc(billingUrl(el)) + '">Manage</a></span>';
    } else if (state && saved) {
      html = '<a class="wb-btn' + dark + '" href="' + esc(billingUrl(el)) + '">' + label + '</a>'
        + '<span class="wb-note">Paused for ' + short(saved.wallet) + (state.reason ? ': ' + esc(state.reason) : '') + '. <button type="button" data-wb-forget>Use another wallet</button></span>';
    } else {
      html = '<a class="wb-btn' + dark + '" href="' + esc(billingUrl(el)) + '">' + label + '</a>';
    }
    el.innerHTML = '<span class="wb-wrap">' + html + '</span>';
    var f = el.querySelector('[data-wb-forget]');
    if (f) f.addEventListener('click', function () { store.set(null); draw(el, null); });
  }

  var cfg = null;
  function loadCfg() {
    return fetch(new URL('/api/billing/config', BASE).toString()).then(function (r) { return r.json(); })
      .then(function (c) { cfg = { prepaid: !!c.prepaid, symbol: c.symbol || (c.network && c.network.token && c.network.token.symbol) || 'USDT' }; })
      .catch(function () { /* keep defaults */ });
  }

  var status = null;
  function check() {
    var saved = store.get();
    if (!saved || !saved.wallet) return Promise.resolve(null);
    var u = new URL('/api/embed/status', BASE);
    u.searchParams.set('wallet', saved.wallet); if (saved.chain) u.searchParams.set('chain', saved.chain);
    return fetch(u.toString()).then(function (r) { return r.json(); }).then(function (s) {
      status = s;
      fire(s.usable ? 'active' : 'paused', { wallet: saved.wallet, chain: s.chain || saved.chain, reason: s.reason || null });
      return s;
    }).catch(function () { return null; });
  }

  function mountAll() {
    var els = document.querySelectorAll('[data-wallet-billing]');
    for (var i = 0; i < els.length; i++) draw(els[i], status);
    // the site's own buttons / links
    var own = document.querySelectorAll('[data-wallet-billing-link]');
    for (var j = 0; j < own.length; j++) {
      var el = own[j];
      if (el.classList) el.classList.toggle('wb-is-active', !!(status && status.usable));
      if (el.tagName === 'A') el.setAttribute('href', billingUrl(el));
      if (!el.__wb) {
        el.__wb = true;
        el.addEventListener('click', function (e) { e.preventDefault(); location.href = billingUrl(e.currentTarget); });
      }
    }
  }

  window.WalletBilling = {
    wallet: function () { var s = store.get(); return s ? s.wallet : null; },
    status: function () { return status; },
    refresh: function () { return check().then(function (s) { mountAll(); return s; }); },
    reset: function () { store.set(null); status = null; mountAll(); },
    url: function (opts) { var d = document.createElement('div'); if (opts && opts.chain) d.setAttribute('data-chain', opts.chain); if (opts && opts.returnUrl) d.setAttribute('data-return', opts.returnUrl); return billingUrl(d); },
  };

  var start = function () { mountAll(); loadCfg().then(mountAll); check().then(mountAll); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  // came back to the tab (e.g. after approving in another tab): look again
  document.addEventListener('visibilitychange', function () { if (!document.hidden && store.get()) check().then(mountAll); });
})();
