/* Diamonds — reveal 5 gems; matching groups pay (poker-style). */
(function (global) {
  'use strict';
  const GEM = ['#ff4d6d', '#ffb454', '#f5c542', '#00e676', '#00b8d4', '#7c4dff', '#ff6fd8'];
  const CAT_LABEL = { five: '5 of a kind', four: '4 of a kind', full: 'Full house', three: '3 of a kind', twopair: 'Two pair', pair: 'Pair', none: 'No match' };
  const PAYS = [['5 of a kind', '100×'], ['4 of a kind', '16×'], ['Full house', '6×'], ['3 of a kind', '2×'], ['Two pair', '1.2×'], ['Pair', '0.25×']];
  function mount(container) {
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('dmBet')}
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="dmAction">Reveal</button>
      <div class="pay-list">
        ${PAYS.map(p => `<div class="pay-row"><span>${p[0]}</span><span>${p[1]}</span></div>`).join('')}
      </div>
    `, `<div class="diamonds-row" id="dmRow">
          ${[0,1,2,3,4].map(() => `<div class="gem-cell"><svg viewBox="0 0 24 24" width="46" height="46"><path d="M6 3h12l4 6-10 12L2 9z" fill="#23313f"/></svg></div>`).join('')}
        </div>
        <div class="crash-status" id="dmStatus">Reveal your gems</div>`, 'diamonds-stage');

    const betInput = container.querySelector('#dmBet');
    const action = container.querySelector('#dmAction');
    const cells = Array.from(container.querySelectorAll('#dmRow .gem-cell'));
    const statusEl = container.querySelector('#dmStatus');
    let busy = false, alive = true, timers = [];
    GameKit.wireBet(container, betInput);

    function paint(cell, color, on) {
      cell.innerHTML = `<svg viewBox="0 0 24 24" width="46" height="46"><path d="M6 3h12l4 6-10 12L2 9z" fill="${on ? color : '#23313f'}"/></svg>`;
      if (on) { cell.classList.add('pop'); timers.push(setTimeout(() => cell.classList.remove('pop'), 350)); }
    }

    async function play() {
      if (busy) return;
      const b = GameKit.bet(betInput);
      if (b == null) return;
      busy = true; action.disabled = true;
      cells.forEach(c => paint(c, '', false));
      statusEl.textContent = 'Revealing…';
      try {
        const res = await API.diamonds({ bet: b });
        res.gems.forEach((g, i) => timers.push(setTimeout(() => { if (alive) paint(cells[i], GEM[g], true); }, 150 * (i + 1))));
        timers.push(setTimeout(() => {
          if (!alive) return;
          statusEl.textContent = `${CAT_LABEL[res.category]}${res.mult > 0 ? ' — ' + res.mult.toFixed(2) + '×' : ''}`;
          GameKit.settle('diamonds', b, res);
          busy = false; action.disabled = false;
        }, 150 * 6));
      } catch (e) { Toast.error(e.message); busy = false; action.disabled = false; }
    }
    action.addEventListener('click', play);
    return function () { alive = false; timers.forEach(clearTimeout); };
  }
  global.Games = global.Games || {};
  global.Games.diamonds = mount;
})(window);
