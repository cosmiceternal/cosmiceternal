/* Bingo Rush — instant bingo. One card, 30 balls, paid by completed lines
 * (rows, columns, diagonals; centre free). Balls animate in one by one. */
(function (global) {
  'use strict';
  const COLS = ['B', 'I', 'N', 'G', 'O'];

  function mount(container) {
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('bgBet')}
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="bgPlay">Play Card</button>
      <div class="stat-grid">
        <div class="stat"><span class="stat-label">Lines</span><span class="stat-value" id="bgLines">—</span></div>
        <div class="stat"><span class="stat-label">Last Win</span><span class="stat-value" id="bgLast">—</span></div>
      </div>
      <div class="bg-paytable muted">
        1 line ×4 &nbsp;·&nbsp; 2 ×25 &nbsp;·&nbsp; 3 ×150 &nbsp;·&nbsp; 4 ×800 &nbsp;·&nbsp; 5+ ×2500
      </div>
    `, `<div class="bingo-wrap">
          <div class="bingo-head">${COLS.map(c => `<div class="bingo-col-h">${c}</div>`).join('')}</div>
          <div class="bingo-grid" id="bgGrid"></div>
          <div class="bingo-balls" id="bgBalls"></div>
        </div>
        <div class="crash-status" id="bgStatus">Buy a card to play.</div>`, 'bingo-stage');

    const betInput = container.querySelector('#bgBet');
    const playBtn = container.querySelector('#bgPlay');
    const grid = container.querySelector('#bgGrid');
    const ballsEl = container.querySelector('#bgBalls');
    const linesEl = container.querySelector('#bgLines');
    const lastEl = container.querySelector('#bgLast');
    const statusEl = container.querySelector('#bgStatus');
    let busy = false, alive = true, timers = [];
    GameKit.wireBet(container, betInput);

    function renderCard(card) {
      grid.innerHTML = card.map((v, i) =>
        `<div class="bingo-cell${v === null ? ' free' : ''}" data-i="${i}">${v === null ? '★' : v}</div>`
      ).join('');
    }
    renderCard(new Array(25).fill(null).map((_, i) => i === 12 ? null : '·'));

    playBtn.addEventListener('click', async () => {
      if (busy) return;
      const b = GameKit.bet(betInput);
      if (b == null) return;
      busy = true; playBtn.disabled = true;
      ballsEl.innerHTML = '';
      linesEl.textContent = '—';
      statusEl.textContent = 'Calling the balls…';
      try {
        const res = await API.bingo({ bet: b });
        renderCard(res.card);
        const cardSet = new Map();
        res.card.forEach((v, i) => { if (v !== null) cardSet.set(v, i); });
        // Reveal balls one at a time (fast — ~60ms each, 30 balls ≈ 1.8s).
        res.balls.forEach((ball, i) => {
          timers.push(setTimeout(() => {
            if (!alive) return;
            const span = document.createElement('span');
            span.className = 'bingo-ball';
            span.textContent = ball;
            ballsEl.appendChild(span);
            const cell = cardSet.has(ball) ? grid.querySelector(`[data-i="${cardSet.get(ball)}"]`) : null;
            if (cell) { cell.classList.add('marked'); span.classList.add('hit'); }
            if (i === res.balls.length - 1) {
              timers.push(setTimeout(() => {
                if (!alive) return;
                // Glow the completed lines.
                (res.lineIndexes || []).forEach(L => L.forEach(idx => {
                  const c = grid.querySelector(`[data-i="${idx}"]`);
                  if (c) c.classList.add('line');
                }));
                linesEl.textContent = res.lines;
                lastEl.textContent = res.mult > 0 ? res.mult.toFixed(0) + '×' : '—';
                statusEl.textContent = res.lines === 0 ? 'No lines this card.'
                  : res.lines === 1 ? 'BINGO — 1 line!' : `BINGO — ${res.lines} lines!`;
                GameKit.settle('bingo', b, res);
                busy = false; playBtn.disabled = false;
              }, 350));
            }
          }, 60 * i));
        });
      } catch (e) { Toast.error(e.message); busy = false; playBtn.disabled = false; }
    });

    return function () { alive = false; timers.forEach(clearTimeout); };
  }
  global.Games = global.Games || {};
  global.Games.bingo = mount;
})(window);
