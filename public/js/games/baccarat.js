/* Baccarat (Punto Banco) — bet Player, Banker, or Tie; server deals & settles. */
(function (global) {
  'use strict';
  function val(cards) { return cards.reduce((s, c) => s + (c.rank >= 10 ? 0 : c.rank), 0) % 10; }
  function mount(container) {
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('bcBet')}
      <div class="field">
        <label>Bet On</label>
        <div class="pills" id="bcType">
          <button class="pill active" data-type="player">Player · 2×</button>
          <button class="pill" data-type="banker">Banker · 1.95×</button>
          <button class="pill" data-type="tie">Tie · 9×</button>
        </div>
      </div>
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="bcAction">Deal</button>
      <p class="muted" style="font-size:11px;line-height:1.5;margin:0;">Closest to 9 wins. Banker takes 5% commission. Third-card rules applied automatically.</p>
    `, `<div class="bacc-table">
          <div class="bacc-side"><div class="bj-label">Player <span id="bcPV"></span></div><div class="cards-row" id="bcPlayer"></div></div>
          <div class="bacc-side"><div class="bj-label">Banker <span id="bcBV"></span></div><div class="cards-row" id="bcBanker"></div></div>
        </div>
        <div class="crash-status" id="bcStatus">Pick a side and deal</div>`, 'cards-stage');

    const betInput = container.querySelector('#bcBet');
    const action = container.querySelector('#bcAction');
    const playerEl = container.querySelector('#bcPlayer');
    const bankerEl = container.querySelector('#bcBanker');
    const pvEl = container.querySelector('#bcPV');
    const bvEl = container.querySelector('#bcBV');
    const statusEl = container.querySelector('#bcStatus');
    let betType = 'player', busy = false, alive = true;
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
      playerEl.innerHTML = bankerEl.innerHTML = ''; pvEl.textContent = bvEl.textContent = '';
      statusEl.textContent = 'Dealing…';
      try {
        const res = await API.baccarat({ bet, betType });
        // staged reveal
        const seq = [];
        res.player.forEach((c, i) => seq.push(() => { playerEl.insertAdjacentHTML('beforeend', GameKit.cardHTML(c)); }));
        res.banker.forEach((c, i) => seq.push(() => { bankerEl.insertAdjacentHTML('beforeend', GameKit.cardHTML(c)); }));
        seq.forEach((fn, i) => setTimeout(() => { if (alive) fn(); }, 260 * (i + 1)));
        setTimeout(() => {
          if (!alive) return;
          pvEl.textContent = res.pv; bvEl.textContent = res.bv;
          const names = { player: 'Player', banker: 'Banker', tie: 'Tie' };
          statusEl.textContent = `${names[res.result]} wins (${res.pv}–${res.bv}) — ${res.win ? 'you won!' : 'no win'}`;
          GameKit.settle('baccarat', bet, res);
          busy = false; action.disabled = false;
        }, 260 * (seq.length + 1));
      } catch (e) { Toast.error(e.message); busy = false; action.disabled = false; }
    }
    action.addEventListener('click', play);
    return function () { alive = false; };
  }
  global.Games = global.Games || {};
  global.Games.baccarat = mount;
})(window);
