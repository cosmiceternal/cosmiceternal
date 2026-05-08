/* Persistent bankroll, stored in localStorage. Animates on change. */
(function (global) {
  'use strict';

  const KEY = 'neonstake.bankroll.v1';
  const STARTING = 1000.00;

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw != null) {
        const n = Number(raw);
        if (!isNaN(n)) return n;
      }
    } catch (e) {}
    return STARTING;
  }

  let balance = load();
  const subs = new Set();

  function save() {
    try { localStorage.setItem(KEY, balance.toFixed(2)); } catch (e) {}
  }

  function fmt(n) {
    return n.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function get() { return balance; }
  function set(n) {
    balance = Math.max(0, Math.round(n * 100) / 100);
    save();
    notify(0);
  }

  function add(delta) {
    balance = Math.max(0, Math.round((balance + delta) * 100) / 100);
    save();
    notify(delta);
    return balance;
  }

  function reset() {
    balance = STARTING;
    save();
    notify(0);
  }

  function canAfford(amount) {
    return amount > 0 && amount <= balance + 1e-9;
  }

  function subscribe(fn) {
    subs.add(fn);
    fn(balance, 0);
    return () => subs.delete(fn);
  }

  function notify(delta) {
    subs.forEach(fn => { try { fn(balance, delta); } catch(e) {} });
  }

  // Bind to topbar element
  function bindElement(el) {
    let raf = null, last = balance;
    function tick() {
      const diff = balance - last;
      if (Math.abs(diff) < 0.005) {
        last = balance;
        el.textContent = fmt(balance);
        raf = null;
        return;
      }
      last += diff * 0.18;
      el.textContent = fmt(last);
      raf = requestAnimationFrame(tick);
    }
    subscribe((bal, delta) => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
      if (delta !== 0) {
        el.classList.remove('bump-up', 'bump-down');
        // force reflow so the animation can replay
        void el.offsetWidth;
        el.classList.add(delta > 0 ? 'bump-up' : 'bump-down');
      }
    });
  }

  global.Bankroll = { get, set, add, reset, canAfford, subscribe, bindElement, fmt };
})(window);
