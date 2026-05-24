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

  global.Bankroll = { get, set, canAfford, subscribe, bindElement, fmt };
})(window);
