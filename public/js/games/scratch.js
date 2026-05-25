/* Scratch — buy a card, reveal 9 tiles; 3+ gold tiles win (more = bigger). */
(function (global) {
  'use strict';
  function mount(container) {
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('scBet')}
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="scAction">Buy &amp; Scratch</button>
      <div class="stat-grid">
        <div class="stat"><span class="stat-label">Gold Found</span><span class="stat-value" id="scGold">0</span></div>
        <div class="stat"><span class="stat-label">Multiplier</span><span class="stat-value" id="scMult">0×</span></div>
      </div>
      <p class="muted" style="font-size:11px;line-height:1.5;margin:0;">Find 3 or more gold coins to win — the more you find, the bigger the prize.</p>
    `, `<div class="scratch-grid" id="scGrid">
          ${Array.from({ length: 9 }).map(() => `<div class="scratch-cell">?</div>`).join('')}
        </div>
        <div class="crash-status" id="scStatus">Buy a card to scratch</div>`, 'scratch-stage');

    const betInput = container.querySelector('#scBet');
    const action = container.querySelector('#scAction');
    const cells = Array.from(container.querySelectorAll('#scGrid .scratch-cell'));
    const statusEl = container.querySelector('#scStatus');
    const goldEl = container.querySelector('#scGold');
    const multEl = container.querySelector('#scMult');
    let busy = false, alive = true, timers = [];
    GameKit.wireBet(container, betInput);

    async function play() {
      if (busy) return;
      const b = GameKit.bet(betInput);
      if (b == null) return;
      busy = true; action.disabled = true;
      cells.forEach(c => { c.className = 'scratch-cell'; c.textContent = '?'; });
      goldEl.textContent = '0'; multEl.textContent = '0×';
      statusEl.textContent = 'Scratching…';
      try {
        const res = await API.scratch({ bet: b });
        let shown = 0;
        res.tiles.forEach((t, i) => timers.push(setTimeout(() => {
          if (!alive) return;
          cells[i].classList.add(t ? 'gold' : 'blank', 'revealed');
          cells[i].textContent = t ? '★' : '·';
          if (t) goldEl.textContent = String(++shown);
        }, 120 * (i + 1))));
        timers.push(setTimeout(() => {
          if (!alive) return;
          multEl.textContent = (res.mult || 0).toFixed(2) + '×';
          statusEl.textContent = res.golds >= 3 ? `${res.golds} gold — ${res.mult.toFixed(2)}×!` : `${res.golds} gold — not enough`;
          GameKit.settle('scratch', b, res);
          busy = false; action.disabled = false;
        }, 120 * 10));
      } catch (e) { Toast.error(e.message); busy = false; action.disabled = false; }
    }
    action.addEventListener('click', play);
    return function () { alive = false; timers.forEach(clearTimeout); };
  }
  global.Games = global.Games || {};
  global.Games.scratch = mount;
})(window);
