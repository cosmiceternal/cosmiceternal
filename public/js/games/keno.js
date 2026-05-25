/* Keno — pick up to 10 of 40 numbers; the server draws 10. */
(function (global) {
  'use strict';
  function mount(container) {
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('keBet')}
      <div class="field">
        <label>Your Picks <span id="keCount" class="muted">0 / 10</span></label>
        <div class="row">
          <button class="btn" id="keClear">Clear</button>
          <button class="btn" id="keQuick">Quick Pick</button>
        </div>
      </div>
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="keAction" disabled>Pick numbers</button>
      <div class="pay-list" id="kePays"></div>
    `, `<div class="keno-grid" id="keGrid"></div>
        <div class="crash-status" id="keStatus">Select 1–10 numbers</div>`, 'keno-stage');

    const betInput = container.querySelector('#keBet');
    const action = container.querySelector('#keAction');
    const grid = container.querySelector('#keGrid');
    const statusEl = container.querySelector('#keStatus');
    const countEl = container.querySelector('#keCount');
    const paysEl = container.querySelector('#kePays');
    const picks = new Set();
    let busy = false, alive = true;
    GameKit.wireBet(container, betInput);

    const cells = [];
    for (let n = 1; n <= 40; n++) {
      const c = document.createElement('div');
      c.className = 'keno-cell'; c.textContent = n; c.dataset.n = n;
      c.addEventListener('click', () => toggle(n, c));
      grid.appendChild(c); cells[n] = c;
    }

    function toggle(n, c) {
      if (busy) return;
      if (picks.has(n)) { picks.delete(n); c.classList.remove('picked'); }
      else { if (picks.size >= 10) return Toast.warn('Max 10 numbers'); picks.add(n); c.classList.add('picked'); }
      refresh();
    }
    async function refresh() {
      countEl.textContent = `${picks.size} / 10`;
      action.disabled = picks.size < 1;
      action.textContent = picks.size < 1 ? 'Pick numbers' : 'Play';
      if (picks.size >= 1) {
        try {
          const t = await API.kenoTable(picks.size);
          if (!alive) return;
          paysEl.innerHTML = t.table.map((m, k) => m > 0 ? `<div class="pay-row"><span>${k} hits</span><span>${m}×</span></div>` : '').join('');
        } catch (e) {}
      } else paysEl.innerHTML = '';
    }
    container.querySelector('#keClear').addEventListener('click', () => { if (busy) return; picks.clear(); cells.forEach(c => c && c.classList.remove('picked', 'drawn', 'hit')); refresh(); });
    container.querySelector('#keQuick').addEventListener('click', () => {
      if (busy) return;
      picks.clear(); cells.forEach(c => c && c.classList.remove('picked', 'drawn', 'hit'));
      const k = 1 + Math.floor(Math.random() * 10);
      while (picks.size < k) { const n = 1 + Math.floor(Math.random() * 40); if (!picks.has(n)) { picks.add(n); cells[n].classList.add('picked'); } }
      refresh();
    });

    async function play() {
      if (busy || picks.size < 1) return;
      const bet = GameKit.bet(betInput);
      if (bet == null) return;
      busy = true; action.disabled = true;
      cells.forEach(c => c && c.classList.remove('drawn', 'hit'));
      statusEl.textContent = 'Drawing…';
      try {
        const res = await API.keno({ bet, picks: [...picks] });
        res.drawn.forEach((n, i) => setTimeout(() => {
          if (!alive) return;
          const c = cells[n];
          c.classList.add(res.picks.includes(n) ? 'hit' : 'drawn');
          if (i === res.drawn.length - 1) {
            statusEl.textContent = `${res.hitCount} hit${res.hitCount === 1 ? '' : 's'} — ${res.mult > 0 ? res.mult.toFixed(2) + '×' : 'no win'}`;
            GameKit.settle('keno', bet, res);
            busy = false; action.disabled = false;
          }
        }, 90 * (i + 1)));
      } catch (e) { Toast.error(e.message); busy = false; action.disabled = false; statusEl.textContent = 'Select 1–10 numbers'; }
    }
    action.addEventListener('click', play);
    return function () { alive = false; };
  }
  global.Games = global.Games || {};
  global.Games.keno = mount;
})(window);
