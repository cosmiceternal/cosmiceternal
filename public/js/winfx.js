/* Big-win celebration banner. A centered, non-interactive flourish that
 * fires on large multipliers (via GameKit.settle) and on the progressive
 * jackpot. Pure DOM + CSS, auto-removes, respects reduced-motion. The
 * server is still the source of truth — this only dramatises the result. */
(function (global) {
  'use strict';

  const reduce = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let host = null, current = null, hideTimer = null, rafId = null;

  function ensureHost() {
    if (host && host.isConnected) return host;
    host = document.getElementById('winfxHost');
    if (!host) {
      host = document.createElement('div');
      host.id = 'winfxHost';
      host.setAttribute('aria-hidden', 'true');
      document.body.appendChild(host);
    }
    return host;
  }

  // Pick the celebration tier from the multiplier (or force jackpot).
  function tierFor(mult, jackpot) {
    if (jackpot) return { key: 'jackpot', label: 'JACKPOT', hold: 3200, confetti: 200 };
    if (mult >= 200) return { key: 'ultra', label: 'ULTRA WIN', hold: 2800, confetti: 170 };
    if (mult >= 50)  return { key: 'mega',  label: 'MEGA WIN',  hold: 2600, confetti: 140 };
    return { key: 'big', label: 'BIG WIN', hold: 2100, confetti: 90 };
  }

  function fmt(n) {
    return (global.Bankroll && Bankroll.fmt) ? Bankroll.fmt(n) : (Math.round(n * 100) / 100).toFixed(2);
  }

  function clear() {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (current && current.parentNode) current.parentNode.removeChild(current);
    current = null;
  }

  // opts: { amount:Number, mult:Number, jackpot:Bool }
  function show(opts) {
    opts = opts || {};
    const amount = Math.max(0, +opts.amount || 0);
    const mult = +opts.mult || 0;
    const t = tierFor(mult, opts.jackpot);
    clear();

    const root = ensureHost();
    const el = document.createElement('div');
    el.className = 'winfx';
    el.dataset.tier = t.key;
    const multLine = opts.jackpot
      ? 'progressive jackpot'
      : (mult ? `${mult.toFixed(2)}× multiplier` : '');
    el.innerHTML =
      '<div class="winfx-rays"></div>' +
      '<div class="winfx-inner">' +
        '<div class="winfx-title">' + t.label + '</div>' +
        '<div class="winfx-amount"><span class="winfx-plus">+</span><span data-role="amt">' + fmt(amount) + '</span></div>' +
        (multLine ? '<div class="winfx-mult">' + multLine + '</div>' : '') +
      '</div>';
    root.appendChild(el);
    current = el;

    // Particles ride along (WinFx owns the burst so callers don't double up).
    if (global.Confetti) Confetti.burst({ count: t.confetti, y: window.innerHeight * 0.42 });

    // Count the amount up for a satisfying tick (skipped under reduced-motion).
    const amtEl = el.querySelector('[data-role="amt"]');
    if (amtEl && amount > 0 && !reduce) {
      const dur = 780, start = performance.now();
      let lastTick = 0;
      const step = (now) => {
        if (!current || !amtEl.isConnected) return;
        const p = Math.min(1, (now - start) / dur);
        const eased = 1 - Math.pow(1 - p, 3);
        amtEl.textContent = fmt(amount * eased);
        // Soft coin shimmer every ~90ms as the total races up.
        if (global.Sound && now - lastTick > 90 && p < 0.98) { lastTick = now; Sound.play('coin'); }
        if (p < 1) rafId = requestAnimationFrame(step);
      };
      amtEl.textContent = fmt(0);
      rafId = requestAnimationFrame(step);
    }

    // Fade out, then remove.
    hideTimer = setTimeout(() => {
      if (!el.isConnected) return;
      el.classList.add('winfx-out');
      hideTimer = setTimeout(clear, 420);
    }, t.hold);
  }

  global.WinFx = { show };
})(window);
