/* Cascade (original) — energy cascades through 6 cells, each igniting with a
 * risk-based chance. The cascade stops at the first miss; you're paid by how
 * many cells lit in a row. */
(function (global) {
  'use strict';
  const N = 6;
  function mount(container) {
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('caBet')}
      <div class="field">
        <label>Risk</label>
        <div class="pills" id="caRisk">
          ${['low', 'mid', 'high'].map((r, i) => `<button class="pill ${i === 1 ? 'active' : ''}" data-risk="${r}">${r[0].toUpperCase() + r.slice(1)}</button>`).join('')}
        </div>
      </div>
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="caAction">Ignite</button>
      <div class="pay-list" id="caPays"></div>
    `, `<div class="cascade-track" id="caTrack">
          ${Array.from({ length: N }).map((_, i) => `<div class="cascade-cell" data-i="${i}"><span>${i + 1}</span></div>`).join('')}
        </div>
        <div class="cascade-mult" id="caMult">—</div>
        <div class="crash-status" id="caStatus">Pick risk and ignite</div>`, 'cascade-stage');

    const betInput = container.querySelector('#caBet');
    const action = container.querySelector('#caAction');
    const cells = Array.from(container.querySelectorAll('.cascade-cell'));
    const statusEl = container.querySelector('#caStatus');
    const multEl = container.querySelector('#caMult');
    const paysEl = container.querySelector('#caPays');
    let risk = 'mid', busy = false, alive = true, timers = [];
    GameKit.wireBet(container, betInput);

    // Static paytable hint (mirrors server; server still decides).
    const TABLES = {
      low:  [0, 0, 0.17, 0.69, 1.55, 2.76, 4.32],
      mid:  [0, 0, 0.52, 2.07, 4.67, 8.30, 12.97],
      high: [0, 0, 1.64, 6.56, 14.76, 26.23, 40.99]
    };
    function renderPays() {
      const t = TABLES[risk];
      paysEl.innerHTML = t.map((m, k) => m > 0 ? `<div class="pay-row"><span>${k} in a row</span><span>${m}×</span></div>` : '').join('');
    }
    renderPays();
    container.querySelectorAll('[data-risk]').forEach(b => b.addEventListener('click', () => {
      if (busy) return;
      container.querySelectorAll('[data-risk]').forEach(x => x.classList.remove('active'));
      b.classList.add('active'); risk = b.dataset.risk; renderPays();
    }));

    async function play() {
      if (busy) return;
      const bet = GameKit.bet(betInput);
      if (bet == null) return;
      busy = true; action.disabled = true;
      timers.forEach(clearTimeout); timers = [];
      cells.forEach(c => c.className = 'cascade-cell');
      multEl.textContent = '—'; multEl.className = 'cascade-mult';
      statusEl.textContent = 'Cascading…';
      try {
        const res = await API.cascade({ bet, risk });
        res.cells.forEach((on, i) => timers.push(setTimeout(() => {
          if (!alive) return;
          cells[i].classList.add(on ? 'lit' : 'dead');
        }, 220 * (i + 1))));
        timers.push(setTimeout(() => {
          if (!alive) return;
          multEl.textContent = (res.mult || 0).toFixed(2) + '×';
          multEl.classList.add(res.mult >= 1 ? 'win' : 'loss');
          statusEl.textContent = res.ignited >= 2 ? `${res.ignited} in a row — ${res.mult.toFixed(2)}×!` : `Only ${res.ignited} lit — no win`;
          GameKit.settle('cascade', bet, res);
          busy = false; action.disabled = false;
        }, 220 * (N + 1)));
      } catch (e) { Toast.error(e.message); busy = false; action.disabled = false; }
    }
    action.addEventListener('click', play);
    return function () { alive = false; timers.forEach(clearTimeout); };
  }
  global.Games = global.Games || {};
  global.Games.cascade = mount;
})(window);
