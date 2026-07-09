/* Firecracker — light the fuse and watch a chain of firecrackers pop, the last
 * bursting to reveal the multiplier. Pure spectacle. */
(function (global) {
  'use strict';
  function mount(container) {
    let busy = false, alive = true, timers = [];
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('fcBet')}
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="fcLight">Light the Fuse 🧨</button>
      <div class="stat-grid">
        <div class="stat"><span class="stat-label">Last</span><span class="stat-value" id="fcLast">—</span></div>
        <div class="stat"><span class="stat-label">Top</span><span class="stat-value">100×</span></div>
      </div>
      <p class="muted" style="font-size:11px;line-height:1.5;margin:0;">Light it up — the final burst reveals your multiplier. Up to 100×.</p>
    `, `<div class="fc-scene">
          <div class="fc-chain" id="fcChain">
            <span class="fc-cracker">🧨</span><span class="fc-cracker">🧨</span>
            <span class="fc-cracker">🧨</span><span class="fc-cracker">🧨</span>
          </div>
          <div class="fc-burst" id="fcBurst"></div>
        </div>
        <div class="crash-status" id="fcStatus">Light the fuse.</div>`, 'firecracker-stage');

    const betInput = container.querySelector('#fcBet');
    const light = container.querySelector('#fcLight');
    const chain = container.querySelector('#fcChain');
    const burst = container.querySelector('#fcBurst');
    const statusEl = container.querySelector('#fcStatus');
    const lastEl = container.querySelector('#fcLast');
    GameKit.wireBet(container, betInput);

    light.addEventListener('click', async () => {
      if (busy) return;
      const b = GameKit.bet(betInput);
      if (b == null) return;
      busy = true; light.disabled = true;
      burst.textContent = ''; burst.className = 'fc-burst';
      const crackers = [...chain.querySelectorAll('.fc-cracker')];
      crackers.forEach(c => c.classList.remove('popped'));
      statusEl.textContent = 'Fuse lit…';
      try {
        const res = await API.firecracker({ bet: b });
        // Pop the crackers one by one.
        crackers.forEach((c, i) => {
          timers.push(setTimeout(() => { if (alive) { c.classList.add('popped'); if (global.Sound) Sound.play('click'); } }, 350 + i * 300));
        });
        timers.push(setTimeout(() => {
          if (!alive) return;
          burst.textContent = res.mult >= 1 ? res.mult + '×' : '💨';
          burst.classList.add('show', res.mult >= 25 ? 'huge' : (res.mult >= 5 ? 'big' : 'small'));
          lastEl.textContent = res.mult > 0 ? res.mult + '×' : '—';
          statusEl.textContent = res.mult >= 25 ? `💥 ${res.mult}× — MASSIVE!`
            : res.mult >= 1 ? `💥 ${res.mult}×!`
            : 'A dud. Light another.';
          GameKit.settle('firecracker', b, res);
          timers.push(setTimeout(() => { if (alive) { busy = false; light.disabled = false; } }, 1400));
        }, 350 + crackers.length * 300 + 200));
      } catch (e) { Toast.error(e.message); busy = false; light.disabled = false; }
    });

    return function () { alive = false; timers.forEach(clearTimeout); };
  }
  global.Games = global.Games || {};
  global.Games.firecracker = mount;
})(window);
