/* Confetti burst. Pure-DOM, no canvas, no external dep. Used by GameKit on
 * big multiplier wins (>= 10x). Particles auto-remove after their CSS
 * animation ends so we never leak nodes. */
(function (global) {
  'use strict';

  const COLORS = ['#ff5e9c', '#ffb449', '#6dd9b8', '#a07bff', '#ffe066'];
  const PIECE_LIFETIME_MS = 1600;

  let host = null;
  function ensureHost() {
    if (host && host.isConnected) return host;
    host = document.getElementById('confettiHost');
    if (!host) {
      host = document.createElement('div');
      host.id = 'confettiHost';
      host.setAttribute('aria-hidden', 'true');
      document.body.appendChild(host);
    }
    return host;
  }

  // Spawn `count` particles drifting down from an origin. x/y are viewport
  // coords; default is screen centre.
  function burst(opts) {
    opts = opts || {};
    const count = Math.max(8, Math.min(160, opts.count || 80));
    const x = (typeof opts.x === 'number') ? opts.x : window.innerWidth / 2;
    const y = (typeof opts.y === 'number') ? opts.y : window.innerHeight / 3;
    const root = ensureHost();
    for (let i = 0; i < count; i++) {
      const p = document.createElement('span');
      p.className = 'confetti-piece';
      const color = COLORS[(Math.random() * COLORS.length) | 0];
      const angle = Math.random() * Math.PI * 2;
      const dist = 80 + Math.random() * 280;
      const dx = Math.cos(angle) * dist;
      const dy = Math.sin(angle) * dist * 0.55 + 280 + Math.random() * 220;
      const rot = (Math.random() * 720 - 360) | 0;
      const dur = 1100 + Math.random() * 700;
      const w = 6 + Math.random() * 6;
      const h = 8 + Math.random() * 10;
      p.style.cssText =
        `left:${x}px;top:${y}px;width:${w}px;height:${h}px;` +
        `background:${color};--dx:${dx}px;--dy:${dy}px;--rot:${rot}deg;` +
        `animation-duration:${dur}ms;` +
        `animation-delay:${(Math.random() * 120) | 0}ms;`;
      root.appendChild(p);
      setTimeout(() => { if (p.parentNode) p.parentNode.removeChild(p); }, PIECE_LIFETIME_MS + 200);
    }
  }

  global.Confetti = { burst };
})(window);
