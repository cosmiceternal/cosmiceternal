/* Zeus's Gates — a 6×5 pay-anywhere tumble slot. 8+ of a symbol anywhere pays,
 * winners explode, new symbols drop, and glowing multiplier orbs stack up on a
 * win. The server settles the whole cascade; the client choreographs it. */
(function (global) {
  'use strict';
  const COLS = 6, ROWS = 5;
  function mount(container) {
    let busy = false, alive = true, timers = [];
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('zgBet')}
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="zgSpin">Spin</button>
      <div class="stat-grid">
        <div class="stat"><span class="stat-label">Multiplier</span><span class="stat-value" id="zgMult">—</span></div>
        <div class="stat"><span class="stat-label">Last win</span><span class="stat-value" id="zgLast">—</span></div>
      </div>
      <p class="muted" style="font-size:11px;line-height:1.5;margin:0;">8 or more of any symbol anywhere pays. Wins tumble and ⚡ orbs multiply the whole payout.</p>
    `, `<div class="zg-machine">
          <div class="zg-grid" id="zgGrid"></div>
          <div class="zg-mult-banner hidden" id="zgBanner"></div>
        </div>
        <div class="crash-status" id="zgStatus">Spin to enter the gates.</div>`, 'zeusgates-stage');

    const betInput = container.querySelector('#zgBet');
    const spinBtn = container.querySelector('#zgSpin');
    const grid = container.querySelector('#zgGrid');
    const banner = container.querySelector('#zgBanner');
    const statusEl = container.querySelector('#zgStatus');
    const multEl = container.querySelector('#zgMult');
    const lastEl = container.querySelector('#zgLast');
    const SYM = ['🍎', '🍇', '💍', '🏺', '👑', '⚡', '🔱', '🪙'];
    GameKit.wireBet(container, betInput);

    function paint(cells) {
      grid.innerHTML = '';
      for (let i = 0; i < COLS * ROWS; i++) {
        const el = document.createElement('div');
        el.className = 'zg-cell dropping';
        const v = cells ? cells[i] : (Math.random() * 8) | 0;
        if (cells && cells[i] === -1) { el.classList.add('orb'); el.textContent = '⚡'; }
        else el.textContent = SYM[(cells ? cells[i] : v) | 0] || SYM[(Math.random() * 8) | 0];
        el.style.animationDelay = ((i % COLS) * 20 + Math.floor(i / COLS) * 30) + 'ms';
        grid.appendChild(el);
      }
    }
    paint(null);

    function shimmer(cb) {
      const cells = [...grid.querySelectorAll('.zg-cell')];
      const n = 6 + ((Math.random() * 10) | 0);
      const picks = cells.map(x => [Math.random(), x]).sort((a, b) => a[0] - b[0]).slice(0, n).map(x => x[1]);
      picks.forEach(el => el.classList.add('exploding'));
      timers.push(setTimeout(() => {
        if (!alive) return;
        picks.forEach(el => { el.classList.remove('exploding'); el.classList.add('dropping'); el.textContent = SYM[(Math.random() * 8) | 0]; });
        timers.push(setTimeout(() => picks.forEach(el => el.classList.remove('dropping')), 300));
        cb();
      }, 340));
    }

    spinBtn.addEventListener('click', async () => {
      if (busy) return;
      const b = GameKit.bet(betInput);
      if (b == null) return;
      busy = true; spinBtn.disabled = true;
      banner.classList.add('hidden');
      statusEl.textContent = 'The gates open…';
      if (global.Sound) Sound.play('spin');
      paint(null);
      try {
        const res = await API.zeusgates({ bet: b });
        const waves = Math.max(1, res.tumbles || 1);
        let done = 0;
        const runWave = () => {
          if (!alive) return;
          if (done >= waves) return reveal(res, b);
          done++;
          statusEl.textContent = `Cascade ${done}…`;
          shimmer(runWave);
        };
        timers.push(setTimeout(runWave, 500));
      } catch (e) { Toast.error(e.message); busy = false; spinBtn.disabled = false; }
    });

    function reveal(res, b) {
      paint(res.finalGrid);
      if (res.orbMult > 0 && res.mult > 0) {
        banner.textContent = `⚡ ${res.orbMult}× ORBS ⚡`;
        banner.classList.remove('hidden');
      }
      multEl.textContent = res.orbMult > 0 ? res.orbMult + '×' : '—';
      lastEl.textContent = res.mult > 0 ? res.mult.toFixed(2) + '×' : '—';
      statusEl.textContent = res.mult >= 1
        ? `${res.tumbles} tumble${res.tumbles === 1 ? '' : 's'}${res.orbMult > 0 ? ` × ${res.orbMult} orbs` : ''} — ${res.mult.toFixed(2)}×!`
        : 'No favour from Olympus. Spin again.';
      GameKit.settle('zeusgates', b, res);
      busy = false; spinBtn.disabled = false;
    }

    return function () { alive = false; timers.forEach(clearTimeout); };
  }
  global.Games = global.Games || {};
  global.Games.zeusgates = mount;
})(window);
