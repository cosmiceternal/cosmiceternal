/* Sugar Blast — a 7×6 cluster-pays tumble slot. Symbols drop in, clusters
 * explode, new candy tumbles down. The server settles the whole cascade; the
 * client choreographs the tumbles for `res.tumbles` waves, ending on the
 * final board. */
(function (global) {
  'use strict';
  const CANDY = ['🍬', '🍭', '🍫', '🍩', '🧁', '🍪'];
  const COLS = 7, ROWS = 6;
  function mount(container) {
    let busy = false, alive = true, timers = [];
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('sbBet')}
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="sbSpin">Drop Candy</button>
      <div class="stat-grid">
        <div class="stat"><span class="stat-label">Last win</span><span class="stat-value" id="sbLast">—</span></div>
        <div class="stat"><span class="stat-label">Tumbles</span><span class="stat-value" id="sbTumbles">—</span></div>
      </div>
      <p class="muted" style="font-size:11px;line-height:1.5;margin:0;">Groups of 5+ matching candies pay and explode — new candy tumbles in and can chain. Top hit ~150×.</p>
    `, `<div class="sugar-board" id="sbBoard"></div>
        <div class="crash-status" id="sbStatus">Drop the candy to play.</div>`, 'sugarblast-stage');

    const betInput = container.querySelector('#sbBet');
    const spinBtn = container.querySelector('#sbSpin');
    const board = container.querySelector('#sbBoard');
    const statusEl = container.querySelector('#sbStatus');
    const lastEl = container.querySelector('#sbLast');
    const tumblesEl = container.querySelector('#sbTumbles');
    GameKit.wireBet(container, betInput);

    function randCandy() { return CANDY[Math.floor(Math.random() * CANDY.length)]; }
    function fillBoard(fromGrid) {
      board.innerHTML = '';
      for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
        const cell = document.createElement('div');
        cell.className = 'sugar-cell dropping';
        cell.dataset.c = c; cell.dataset.r = r;
        cell.textContent = fromGrid ? CANDY[fromGrid[c][r]] : randCandy();
        cell.style.animationDelay = (r * 30 + c * 8) + 'ms';
        board.appendChild(cell);
      }
    }
    fillBoard(null);

    function tumbleWave(cb) {
      // Explode a random handful of cells, then refresh them.
      const cells = [...board.querySelectorAll('.sugar-cell')];
      const count = 5 + Math.floor(Math.random() * 10);
      const picked = cells.map(x => [Math.random(), x]).sort((a, b) => a[0] - b[0]).slice(0, count).map(x => x[1]);
      picked.forEach(el => el.classList.add('exploding'));
      timers.push(setTimeout(() => {
        if (!alive) return;
        picked.forEach(el => { el.classList.remove('exploding'); el.classList.add('dropping'); el.textContent = randCandy(); });
        timers.push(setTimeout(() => picked.forEach(el => el.classList.remove('dropping')), 300));
        cb();
      }, 350));
    }

    spinBtn.addEventListener('click', async () => {
      if (busy) return;
      const b = GameKit.bet(betInput);
      if (b == null) return;
      busy = true; spinBtn.disabled = true;
      statusEl.textContent = 'Dropping…';
      fillBoard(null);
      try {
        const res = await API.sugarblast({ bet: b });
        const waves = Math.max(1, res.tumbles || 1);
        let done = 0;
        const runWave = () => {
          if (!alive) return;
          if (done >= waves) return reveal(res, b);
          done++;
          statusEl.textContent = `Cascade ${done}…`;
          tumbleWave(runWave);
        };
        timers.push(setTimeout(runWave, 600));
      } catch (e) { Toast.error(e.message); busy = false; spinBtn.disabled = false; }
    });

    function reveal(res, b) {
      // Settle on the actual final board so the display matches the server.
      fillBoard(res.finalGrid);
      tumblesEl.textContent = res.tumbles;
      lastEl.textContent = res.mult > 0 ? res.mult.toFixed(2) + '×' : '—';
      statusEl.textContent = res.mult >= 1
        ? `${res.tumbles} tumble${res.tumbles === 1 ? '' : 's'} — ${res.mult.toFixed(2)}×!`
        : 'No clusters. Drop again.';
      GameKit.settle('sugarblast', b, res);
      busy = false; spinBtn.disabled = false;
    }

    return function () { alive = false; timers.forEach(clearTimeout); };
  }
  global.Games = global.Games || {};
  global.Games.sugarblast = mount;
})(window);
