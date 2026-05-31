/* Bankroll display. The authoritative balance lives on the server; this module
 * just holds the last-known value, animates the topbar tally, and exposes a
 * client-side affordability check for snappy UI (the server re-validates). */
(function (global) {
  'use strict';

  let balance = 0;
  const subs = new Set();

  function fmt(n) {
    return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // Compact form for dense rows (feed, leaderboard). Full precision under 10k,
  // K above 10k, M above 1M. Negative numbers keep their sign.
  function fmtCompact(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '0';
    const abs = Math.abs(n), sign = n < 0 ? '-' : '';
    if (abs < 10_000) return sign + abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (abs < 1_000_000) return sign + (abs / 1_000).toFixed(abs < 100_000 ? 2 : 1) + 'K';
    if (abs < 1_000_000_000) return sign + (abs / 1_000_000).toFixed(2) + 'M';
    return sign + (abs / 1_000_000_000).toFixed(2) + 'B';
  }

  function get() { return balance; }

  // Called with the authoritative balance from any server response.
  function set(n) {
    if (typeof n !== 'number' || isNaN(n)) return;
    const delta = n - balance;
    balance = n;
    subs.forEach(fn => { try { fn(balance, delta); } catch (e) {} });
  }

  function canAfford(amount) { return amount > 0 && amount <= balance + 1e-9; }

  function subscribe(fn) { subs.add(fn); fn(balance, 0); return () => subs.delete(fn); }

  function bindElement(el) {
    let raf = null, shown = balance;
    function tick() {
      const diff = balance - shown;
      if (Math.abs(diff) < 0.005) {
        shown = balance;
        el.textContent = fmt(balance);
        raf = null;
        return;
      }
      shown += diff * 0.18;
      el.textContent = fmt(shown);
      raf = requestAnimationFrame(tick);
    }
    subscribe((bal, delta) => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
      if (delta !== 0) {
        el.classList.remove('bump-up', 'bump-down');
        void el.offsetWidth;
        el.classList.add(delta > 0 ? 'bump-up' : 'bump-down');
      }
    });
  }

  global.Bankroll = { get, set, canAfford, subscribe, bindElement, fmt, fmtCompact };
})(window);
