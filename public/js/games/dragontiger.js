/* Dragon Tiger — one card each; higher rank wins. Fast and simple. */
(function (global) {
  'use strict';
  function mount(container) {
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('dtBet')}
      <div class="field">
        <label>Bet On</label>
        <div class="pills" id="dtType">
          <button class="pill active" data-type="dragon">Dragon · 2×</button>
          <button class="pill" data-type="tiger">Tiger · 2×</button>
          <button class="pill" data-type="tie">Tie · 12×</button>
        </div>
      </div>
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="dtAction">Deal</button>
      <p class="muted" style="font-size:11px;line-height:1.5;margin:0;">Higher card wins (Ace low, King high). Dragon/Tiger return half on a tie.</p>
    `, `<div class="dt-table">
          <div class="dt-spot"><div class="bj-label">🐉 Dragon</div><div class="cards-row" id="dtDragon"></div></div>
          <div class="dt-vs">VS</div>
          <div class="dt-spot"><div class="bj-label">🐅 Tiger</div><div class="cards-row" id="dtTiger"></div></div>
        </div>
        <div class="crash-status" id="dtStatus">Pick a side and deal</div>`, 'cards-stage');

    const betInput = container.querySelector('#dtBet');
    const action = container.querySelector('#dtAction');
    const dragonEl = container.querySelector('#dtDragon');
    const tigerEl = container.querySelector('#dtTiger');
    const statusEl = container.querySelector('#dtStatus');
    let betType = 'dragon', busy = false, alive = true;
    GameKit.wireBet(container, betInput);
    container.querySelectorAll('[data-type]').forEach(b => b.addEventListener('click', () => {
      if (busy) return;
      container.querySelectorAll('[data-type]').forEach(x => x.classList.remove('active'));
      b.classList.add('active'); betType = b.dataset.type;
    }));

    async function play() {
      if (busy) return;
      const bet = GameKit.bet(betInput);
      if (bet == null) return;
      busy = true; action.disabled = true;
      dragonEl.innerHTML = GameKit.cardHTML(null, true);
      tigerEl.innerHTML = GameKit.cardHTML(null, true);
      statusEl.textContent = 'Dealing…';
      try {
        const res = await API.dragontiger({ bet, betType });
        setTimeout(() => { if (alive) dragonEl.innerHTML = GameKit.cardHTML(res.dragon); }, 360);
        setTimeout(() => { if (alive) tigerEl.innerHTML = GameKit.cardHTML(res.tiger); }, 720);
        setTimeout(() => {
          if (!alive) return;
          const names = { dragon: 'Dragon', tiger: 'Tiger', tie: 'Tie' };
          statusEl.textContent = `${names[res.result]} wins — ${res.win ? 'you won!' : (res.result === 'tie' && res.betType !== 'tie' ? 'tie, half back' : 'no win')}`;
          GameKit.settle('dragontiger', bet, res);
          busy = false; action.disabled = false;
        }, 1050);
      } catch (e) { Toast.error(e.message); busy = false; action.disabled = false; }
    }
    action.addEventListener('click', play);
    return function () { alive = false; };
  }
  global.Games = global.Games || {};
  global.Games.dragontiger = mount;
})(window);
