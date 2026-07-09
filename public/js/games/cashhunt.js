/* Cash Hunt — pick one of 25 tiles, then all of them flip to reveal their
 * hidden multipliers with a staggered cascade. Your tile gets the spotlight. */
(function (global) {
  'use strict';
  function mult2class(m) {
    if (m === 0) return 'zero';
    if (m < 1) return 'low';
    if (m < 5) return 'mid';
    if (m < 25) return 'high';
    return 'jackpot';
  }
  function mount(container) {
    let pick = -1, busy = false, alive = true, timers = [];
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('chBet2')}
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="chGo" disabled>Pick a tile first</button>
      <div class="stat-grid">
        <div class="stat"><span class="stat-label">Your tile</span><span class="stat-value" id="chPickLbl">—</span></div>
        <div class="stat"><span class="stat-label">Top prize</span><span class="stat-value">100×</span></div>
      </div>
      <p class="muted" style="font-size:11px;line-height:1.5;margin:0;">Choose a tile, then reveal the board. You win whatever multiplier is under your pick.</p>
    `, `<div class="cashhunt-grid" id="chGrid">
          ${Array.from({ length: 25 }, (_, i) => `<button class="ch-tile" data-i="${i}"><span class="ch-face">?</span></button>`).join('')}
        </div>
        <div class="crash-status" id="chStatus2">Pick your tile.</div>`, 'cashhunt-stage');

    const betInput = container.querySelector('#chBet2');
    const go = container.querySelector('#chGo');
    const grid = container.querySelector('#chGrid');
    const statusEl = container.querySelector('#chStatus2');
    const pickLbl = container.querySelector('#chPickLbl');
    GameKit.wireBet(container, betInput);

    grid.addEventListener('click', (e) => {
      const t = e.target.closest('.ch-tile');
      if (!t || busy) return;
      pick = Number(t.dataset.i);
      container.querySelectorAll('.ch-tile').forEach(x => x.classList.toggle('picked', x === t));
      pickLbl.textContent = '#' + (pick + 1);
      go.disabled = false;
      go.textContent = 'Reveal Board';
    });

    go.addEventListener('click', async () => {
      if (busy || pick < 0) return;
      const b = GameKit.bet(betInput);
      if (b == null) return;
      busy = true; go.disabled = true;
      statusEl.textContent = 'Revealing…';
      try {
        const res = await API.cashhunt({ bet: b, pick });
        const tiles = container.querySelectorAll('.ch-tile');
        // Cascade reveal — nearest to the pick first for a spotlight effect.
        const order = [...res.tiles.keys()].sort((a, c) =>
          Math.abs(a - pick) - Math.abs(c - pick));
        order.forEach((idx, step) => {
          timers.push(setTimeout(() => {
            if (!alive) return;
            const el = tiles[idx];
            const m = res.tiles[idx];
            el.classList.add('revealed', mult2class(m));
            el.querySelector('.ch-face').textContent = m === 0 ? '✕' : m + '×';
            if (idx === pick) el.classList.add('yours');
            if (step === order.length - 1) {
              statusEl.textContent = res.mult >= 1
                ? `Your tile: ${res.mult}× — nice!`
                : (res.mult === 0 ? 'Empty tile. Try again.' : `Your tile: ${res.mult}× back.`);
              GameKit.settle('cashhunt', b, res);
              setTimeout(() => { if (alive) reset(); }, 1600);
            }
          }, step * 45));
        });
      } catch (e) { Toast.error(e.message); busy = false; go.disabled = false; }
    });

    function reset() {
      pick = -1; busy = false;
      pickLbl.textContent = '—';
      go.disabled = true; go.textContent = 'Pick a tile first';
      container.querySelectorAll('.ch-tile').forEach(t => {
        t.className = 'ch-tile';
        t.querySelector('.ch-face').textContent = '?';
      });
      statusEl.textContent = 'Pick your tile.';
    }

    return function () { alive = false; timers.forEach(clearTimeout); };
  }
  global.Games = global.Games || {};
  global.Games.cashhunt = mount;
})(window);
