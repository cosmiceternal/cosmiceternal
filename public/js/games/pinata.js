/* Piñata Pop — smash one of five piñatas; it bursts with a multiplier drawn
 * from a weighted table (server-authoritative). Big bursts fire the shared
 * WinFx celebration via GameKit.settle. */
(function (global) {
  'use strict';
  const CANDY = ['🍬', '🍭', '🍫', '🌟', '🍩', '💎'];
  function mount(container) {
    let busy = false, alive = true, timers = [];
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('pnBet')}
      <div class="divider"></div>
      <div class="stat-grid">
        <div class="stat"><span class="stat-label">Multiplier</span><span class="stat-value" id="pnMult">—</span></div>
        <div class="stat"><span class="stat-label">Last Win</span><span class="stat-value" id="pnWin">—</span></div>
      </div>
      <p class="muted" style="font-size:11px;line-height:1.5;margin:0;">Pick a piñata and smash it — each bursts with a hidden multiplier up to 50×.</p>
    `, `<div class="pinata-row" id="pnRow">
          ${Array.from({ length: 5 }, (_, i) => `<button class="pinata" data-i="${i}"><span class="pinata-body">🪅</span><span class="pinata-burst"></span></button>`).join('')}
        </div>
        <div class="crash-status" id="pnStatus">Pick a piñata to smash</div>`, 'pinata-stage');

    const betInput = container.querySelector('#pnBet');
    const row = container.querySelector('#pnRow');
    const statusEl = container.querySelector('#pnStatus');
    const multEl = container.querySelector('#pnMult');
    const winEl = container.querySelector('#pnWin');
    const pinatas = Array.from(row.querySelectorAll('.pinata'));
    GameKit.wireBet(container, betInput);

    async function smash(idx) {
      if (busy) return;
      const b = GameKit.bet(betInput);
      if (b == null) return;
      busy = true;
      pinatas.forEach(p => { p.disabled = true; p.classList.remove('smashing', 'burst', 'won'); p.querySelector('.pinata-burst').innerHTML = ''; });
      multEl.textContent = '—';
      statusEl.textContent = 'Swing…';
      const chosen = pinatas[idx];
      chosen.classList.add('smashing');
      if (global.Sound) Sound.play('spin');
      try {
        const res = await API.pinata({ bet: b, pick: idx });
        timers.push(setTimeout(() => {
          if (!alive) return;
          chosen.classList.remove('smashing');
          chosen.classList.add('burst');
          // Candy scatter.
          const burst = chosen.querySelector('.pinata-burst');
          burst.innerHTML = Array.from({ length: 9 }, () => {
            const dx = (Math.random() * 120 - 60).toFixed(0), dy = (Math.random() * 100 + 30).toFixed(0);
            const rot = (Math.random() * 360).toFixed(0);
            return `<span class="candy" style="--dx:${dx}px;--dy:${dy}px;--r:${rot}deg">${CANDY[(Math.random() * CANDY.length) | 0]}</span>`;
          }).join('');
          multEl.textContent = res.mult.toFixed(2) + '×';
          if (res.mult >= 10) chosen.classList.add('won');
          statusEl.textContent = res.mult >= 1.0001
            ? `${res.mult.toFixed(2)}× — +${Bankroll.fmt(res.payout - b)}!`
            : (res.mult > 0 ? `${res.mult.toFixed(2)}× — partial return` : 'Empty! Better luck next smash.');
          winEl.textContent = res.mult >= 1.0001 ? '+' + Bankroll.fmt(res.payout - b) : '—';
          GameKit.settle('pinata', b, res);
          busy = false; pinatas.forEach(p => p.disabled = false);
        }, 620));
      } catch (e) { Toast.error(e.message); chosen.classList.remove('smashing'); busy = false; pinatas.forEach(p => p.disabled = false); }
    }
    row.addEventListener('click', (e) => { const p = e.target.closest('.pinata'); if (p) smash(Number(p.dataset.i)); });
    return function () { alive = false; timers.forEach(clearTimeout); };
  }
  global.Games = global.Games || {};
  global.Games.pinata = mount;
})(window);
