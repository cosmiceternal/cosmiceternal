/* Bullseye — throw three darts at the board. Each lands in a ring worth a
 * multiplier; your payout is the sum. Bull is 5×. */
(function (global) {
  'use strict';
  // Ring → radius fraction (from centre) and colour band for the dart marker.
  const RING_POS = { bull: 0.08, inner: 0.28, outer: 0.55, miss: 0.86 };
  function mount(container) {
    let busy = false, alive = true, timers = [];
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('beBet')}
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="beThrow">Throw Darts 🎯</button>
      <div class="stat-grid">
        <div class="stat"><span class="stat-label">Total</span><span class="stat-value" id="beTotal">—</span></div>
        <div class="stat"><span class="stat-label">Bull</span><span class="stat-value">5×</span></div>
      </div>
      <p class="muted" style="font-size:11px;line-height:1.5;margin:0;">Three darts. Outer 0.3×, inner 1×, bull 5× — summed into your payout.</p>
    `, `<div class="darts-board" id="beBoard">
          <div class="dart-ring dart-r1"></div>
          <div class="dart-ring dart-r2"></div>
          <div class="dart-ring dart-r3"></div>
          <div class="dart-bull"></div>
        </div>
        <div class="crash-status" id="beStatus">Throw to play.</div>`, 'bullseye-stage');

    const betInput = container.querySelector('#beBet');
    const throwBtn = container.querySelector('#beThrow');
    const board = container.querySelector('#beBoard');
    const statusEl = container.querySelector('#beStatus');
    const totalEl = container.querySelector('#beTotal');
    GameKit.wireBet(container, betInput);

    throwBtn.addEventListener('click', async () => {
      if (busy) return;
      const b = GameKit.bet(betInput);
      if (b == null) return;
      busy = true; throwBtn.disabled = true;
      board.querySelectorAll('.dart-marker').forEach(d => d.remove());
      statusEl.textContent = 'Throwing…';
      try {
        const res = await API.bullseye({ bet: b });
        res.darts.forEach((d, i) => {
          timers.push(setTimeout(() => {
            if (!alive) return;
            const marker = document.createElement('span');
            marker.className = 'dart-marker';
            marker.textContent = '🎯';
            const rFrac = RING_POS[d.ring] ?? 0.5;
            const theta = Math.random() * Math.PI * 2;
            const jitter = (Math.random() - 0.5) * 0.1;
            marker.style.left = (50 + Math.cos(theta) * (rFrac + jitter) * 46) + '%';
            marker.style.top = (50 + Math.sin(theta) * (rFrac + jitter) * 46) + '%';
            board.appendChild(marker);
            if (i === res.darts.length - 1) {
              timers.push(setTimeout(() => {
                if (!alive) return;
                totalEl.textContent = res.mult.toFixed(2) + '×';
                statusEl.textContent = res.mult >= 1
                  ? `${res.darts.map(x => x.ring).join(' + ')} = ${res.mult.toFixed(2)}×!`
                  : `Only ${res.mult.toFixed(2)}× this round.`;
                GameKit.settle('bullseye', b, res);
                busy = false; throwBtn.disabled = false;
              }, 400));
            }
          }, i * 500));
        });
      } catch (e) { Toast.error(e.message); busy = false; throwBtn.disabled = false; }
    });

    return function () { alive = false; timers.forEach(clearTimeout); };
  }
  global.Games = global.Games || {};
  global.Games.bullseye = mount;
})(window);
