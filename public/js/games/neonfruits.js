/* Neon Fruits — a 5-reel, 3-row, 10-payline video slot. Reels spin and stop
 * left-to-right; winning paylines flash. Server decides the grid. */
(function (global) {
  'use strict';
  const EMOJI = ['🍒', '🍋', '🫐', '🔔', '⭐', '7️⃣', '💎', '🌟'];
  const ALL = [0, 1, 2, 3, 4, 5, 6, 7];
  function mount(container) {
    let busy = false, alive = true, spins = [], timers = [];
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('nfBet')}
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="nfSpin">Spin</button>
      <div class="stat-grid">
        <div class="stat"><span class="stat-label">Last win</span><span class="stat-value" id="nfLast">—</span></div>
        <div class="stat"><span class="stat-label">Lines</span><span class="stat-value">10</span></div>
      </div>
      <p class="muted" style="font-size:11px;line-height:1.5;margin:0;">10 paylines, 🌟 wild substitutes. Three or more matching from the left pays. Top hit ~165×.</p>
    `, `<div class="nf-machine">
          <div class="nf-reels" id="nfReels">
            ${[0,1,2,3,4].map(c => `<div class="nf-reel" data-col="${c}">
              ${[0,1,2].map(r => `<div class="nf-cell" id="nf-${c}-${r}">🍒</div>`).join('')}
            </div>`).join('')}
          </div>
        </div>
        <div class="crash-status" id="nfStatus">Spin the reels.</div>`, 'neonfruits-stage');

    const betInput = container.querySelector('#nfBet');
    const spinBtn = container.querySelector('#nfSpin');
    const statusEl = container.querySelector('#nfStatus');
    const lastEl = container.querySelector('#nfLast');
    const cell = (c, r) => container.querySelector(`#nf-${c}-${r}`);
    GameKit.wireBet(container, betInput);

    function spinReel(col, stopGrid, delay) {
      const iv = setInterval(() => {
        for (let r = 0; r < 3; r++) cell(col, r).textContent = EMOJI[ALL[Math.floor(Math.random() * ALL.length)]];
      }, 70);
      spins.push(iv);
      timers.push(setTimeout(() => {
        if (!alive) return;
        clearInterval(iv);
        for (let r = 0; r < 3; r++) {
          const el = cell(col, r);
          el.textContent = EMOJI[stopGrid[col][r]];
          el.classList.add('land');
          setTimeout(() => el.classList.remove('land'), 300);
        }
      }, delay));
    }

    spinBtn.addEventListener('click', async () => {
      if (busy) return;
      const b = GameKit.bet(betInput);
      if (b == null) return;
      busy = true; spinBtn.disabled = true;
      container.querySelectorAll('.nf-cell').forEach(el => el.classList.remove('win'));
      statusEl.textContent = 'Spinning…';
      try {
        const res = await API.neonfruits({ bet: b });
        // res.grid[col][row]
        for (let c = 0; c < 5; c++) spinReel(c, res.grid, 500 + c * 260);
        timers.push(setTimeout(() => {
          if (!alive) return;
          // Flash winning-line cells.
          const LINES = [
            [1,1,1,1,1],[0,0,0,0,0],[2,2,2,2,2],
            [0,1,2,1,0],[2,1,0,1,2],
            [1,0,0,0,1],[1,2,2,2,1],
            [0,0,1,2,2],[2,2,1,0,0],[1,0,1,2,1]
          ];
          (res.wins || []).forEach(w => {
            const line = LINES[w.line];
            for (let c = 0; c < 5; c++) {
              const el = cell(c, line[c]);
              if (el) el.classList.add('win');
            }
          });
          lastEl.textContent = res.mult > 0 ? res.mult.toFixed(2) + '×' : '—';
          statusEl.textContent = res.mult >= 1
            ? `${res.wins.length} line${res.wins.length === 1 ? '' : 's'} — ${res.mult.toFixed(2)}×!`
            : 'No win. Spin again.';
          GameKit.settle('neonfruits', b, res);
          busy = false; spinBtn.disabled = false;
        }, 500 + 4 * 260 + 400));
      } catch (e) { Toast.error(e.message); busy = false; spinBtn.disabled = false; }
    });

    return function () { alive = false; spins.forEach(clearInterval); timers.forEach(clearTimeout); };
  }
  global.Games = global.Games || {};
  global.Games.neonfruits = mount;
})(window);
