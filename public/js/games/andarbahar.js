/* Andar Bahar — a middle card shows; cards deal alternately until a rank match.
 * Bet which side (Andar/Bahar) lands the match first. */
(function (global) {
  'use strict';
  function mount(container) {
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('abBet')}
      <div class="field">
        <label>Bet On</label>
        <div class="toggle" id="abSide">
          <button class="active" data-side="andar">Andar · 1.9×</button>
          <button data-side="bahar">Bahar · 2×</button>
        </div>
      </div>
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="abAction">Deal</button>
      <div class="stat-grid">
        <div class="stat"><span class="stat-label">Match Card</span><span class="stat-value" id="abMatch">—</span></div>
        <div class="stat"><span class="stat-label">Cards Dealt</span><span class="stat-value" id="abCount">0</span></div>
      </div>
    `, `<div class="ab-middle"><div class="bj-label">Middle</div><div id="abMiddle"></div></div>
        <div class="ab-rows">
          <div class="ab-row"><span class="ab-tag andar">ANDAR</span><div class="cards-row ab-stream" id="abAndar"></div></div>
          <div class="ab-row"><span class="ab-tag bahar">BAHAR</span><div class="cards-row ab-stream" id="abBahar"></div></div>
        </div>
        <div class="crash-status" id="abStatus">Pick a side and deal</div>`, 'andar-stage');

    const betInput = container.querySelector('#abBet');
    const action = container.querySelector('#abAction');
    const middleEl = container.querySelector('#abMiddle');
    const andarEl = container.querySelector('#abAndar');
    const baharEl = container.querySelector('#abBahar');
    const statusEl = container.querySelector('#abStatus');
    const matchEl = container.querySelector('#abMatch');
    const countEl = container.querySelector('#abCount');
    let side = 'andar', busy = false, alive = true, timers = [];
    GameKit.wireBet(container, betInput);
    container.querySelectorAll('[data-side]').forEach(b => b.addEventListener('click', () => {
      if (busy) return;
      container.querySelectorAll('[data-side]').forEach(x => x.classList.remove('active'));
      b.classList.add('active'); side = b.dataset.side;
    }));

    async function play() {
      if (busy) return;
      const bet = GameKit.bet(betInput);
      if (bet == null) return;
      busy = true; action.disabled = true;
      timers.forEach(clearTimeout); timers = [];
      middleEl.innerHTML = ''; andarEl.innerHTML = ''; baharEl.innerHTML = '';
      matchEl.textContent = '—'; countEl.textContent = '0';
      statusEl.textContent = 'Dealing…';
      try {
        const res = await API.andarbahar({ bet, side });
        middleEl.innerHTML = GameKit.cardHTML(res.middle);
        matchEl.textContent = GameKit.cardLabel(res.middle.rank);
        // interleave the two streams in dealing order (Andar first)
        const order = [];
        const maxLen = Math.max(res.andar.length, res.bahar.length);
        for (let i = 0; i < maxLen; i++) {
          if (i < res.andar.length) order.push(['andar', res.andar[i]]);
          if (i < res.bahar.length) order.push(['bahar', res.bahar[i]]);
        }
        order.forEach(([sideName, card], i) => timers.push(setTimeout(() => {
          if (!alive) return;
          (sideName === 'andar' ? andarEl : baharEl).insertAdjacentHTML('beforeend', GameKit.cardHTML(card));
          countEl.textContent = i + 1;
        }, 180 * (i + 1))));
        timers.push(setTimeout(() => {
          if (!alive) return;
          statusEl.textContent = `${res.winner === 'andar' ? 'Andar' : 'Bahar'} matched first — ${res.win ? 'you won!' : 'no win'}`;
          GameKit.settle('andarbahar', bet, res);
          busy = false; action.disabled = false;
        }, 180 * (order.length + 1)));
      } catch (e) { Toast.error(e.message); busy = false; action.disabled = false; }
    }
    action.addEventListener('click', play);
    return function () { alive = false; timers.forEach(clearTimeout); };
  }
  global.Games = global.Games || {};
  global.Games.andarbahar = mount;
})(window);
