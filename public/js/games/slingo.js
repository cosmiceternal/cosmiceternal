/* Slingo — a 5×5 number card with a slot reel below. Ten spins reveal five
 * numbers (one per column); matches mark the card. Completing lines (rows,
 * columns, diagonals) are "Slingos" that pay. Server settles; client animates
 * the ten spins marking cells, then flashes completed lines. */
(function (global) {
  'use strict';
  const COLS = ['B', 'I', 'N', 'G', 'O'];
  function mount(container) {
    let busy = false, alive = true, timers = [];
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('slgBet')}
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="slgPlay">Play (10 spins)</button>
      <div class="stat-grid">
        <div class="stat"><span class="stat-label">Slingos</span><span class="stat-value" id="slgLines">—</span></div>
        <div class="stat"><span class="stat-label">Last win</span><span class="stat-value" id="slgLast">—</span></div>
      </div>
      <div class="bg-paytable muted">1 line ×2 · 2 ×8 · 3 ×25 · 4 ×80 · 5 ×200 · full house ×5000</div>
    `, `<div class="slingo-wrap">
          <div class="slingo-head">${COLS.map(c => `<div class="slingo-col-h">${c}</div>`).join('')}</div>
          <div class="slingo-grid" id="slgGrid"></div>
          <div class="slingo-reel" id="slgReel">${COLS.map((_, i) => `<div class="slingo-slot" id="slgReel${i}">—</div>`).join('')}</div>
        </div>
        <div class="crash-status" id="slgStatus">Buy a card to play.</div>`, 'slingo-stage');

    const betInput = container.querySelector('#slgBet');
    const playBtn = container.querySelector('#slgPlay');
    const grid = container.querySelector('#slgGrid');
    const statusEl = container.querySelector('#slgStatus');
    const linesEl = container.querySelector('#slgLines');
    const lastEl = container.querySelector('#slgLast');
    GameKit.wireBet(container, betInput);

    function renderCard(card) {
      grid.innerHTML = card.map((v, i) => `<div class="slingo-cell" data-i="${i}">${v}</div>`).join('');
    }
    renderCard(Array.from({ length: 25 }, (_, i) => ((i % 5) * 15 + Math.floor(i / 5) + 1)));

    playBtn.addEventListener('click', async () => {
      if (busy) return;
      const b = GameKit.bet(betInput);
      if (b == null) return;
      busy = true; playBtn.disabled = true;
      grid.querySelectorAll('.slingo-cell').forEach(c => c.classList.remove('marked', 'line'));
      linesEl.textContent = '—';
      statusEl.textContent = 'Spinning…';
      try {
        const res = await API.slingo({ bet: b });
        renderCard(res.card);
        const cells = [...grid.querySelectorAll('.slingo-cell')];
        // Play the 10 spins with a short cadence.
        res.spins.forEach((row, s) => {
          timers.push(setTimeout(() => {
            if (!alive) return;
            if (global.Sound) Sound.play('tick');
            row.forEach((cellIdx, c) => {
              const reel = container.querySelector('#slgReel' + c);
              if (cellIdx >= 0) { reel.textContent = res.card[cellIdx]; cells[cellIdx].classList.add('marked'); reel.classList.add('hit'); }
              else { reel.textContent = '✕'; reel.classList.remove('hit'); }
            });
            if (s === res.spins.length - 1) {
              timers.push(setTimeout(() => {
                if (!alive) return;
                (res.lineIndexes || []).forEach(li => {
                  const LINES = SLINGO_LINES();
                  LINES[li].forEach(idx => cells[idx].classList.add('line'));
                });
                linesEl.textContent = res.lines;
                lastEl.textContent = res.mult > 0 ? res.mult.toFixed(0) + '×' : '—';
                statusEl.textContent = res.lines === 0 ? 'No Slingos this card.'
                  : (res.lines >= 12 ? 'FULL HOUSE! 🎉' : `${res.lines} Slingo${res.lines === 1 ? '' : 's'}!`);
                GameKit.settle('slingo', b, res);
                busy = false; playBtn.disabled = false;
              }, 400));
            }
          }, 300 + s * 260));
        });
      } catch (e) { Toast.error(e.message); busy = false; playBtn.disabled = false; }
    });

    function SLINGO_LINES() {
      const L = [];
      for (let r = 0; r < 5; r++) L.push([0, 1, 2, 3, 4].map(c => r * 5 + c));
      for (let c = 0; c < 5; c++) L.push([0, 1, 2, 3, 4].map(r => r * 5 + c));
      L.push([0, 6, 12, 18, 24]); L.push([4, 8, 12, 16, 20]);
      return L;
    }

    return function () { alive = false; timers.forEach(clearTimeout); };
  }
  global.Games = global.Games || {};
  global.Games.slingo = mount;
})(window);
