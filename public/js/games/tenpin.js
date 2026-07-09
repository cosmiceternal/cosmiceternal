/* Ten Pin — roll the ball down the lane, watch pins scatter. Knock 7+ for a
 * payout, a strike (all 10) pays 10×. */
(function (global) {
  'use strict';
  function mount(container) {
    let busy = false, alive = true, timers = [];
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('tpBet')}
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="tpRoll">Roll 🎳</button>
      <div class="stat-grid">
        <div class="stat"><span class="stat-label">Pins</span><span class="stat-value" id="tpPins">—</span></div>
        <div class="stat"><span class="stat-label">Strike</span><span class="stat-value">10× 🎳</span></div>
      </div>
      <p class="muted" style="font-size:11px;line-height:1.5;margin:0;">7 pins pays 1×, 8→2×, 9→4×, a strike pays 10×.</p>
    `, `<div class="bowling-lane">
          <div class="bowling-pins" id="tpPinsWrap">
            ${['','','','','','','','','',''].map((_, i) => `<span class="bowl-pin" data-pin="${i}">🎳</span>`).join('')}
          </div>
          <span class="bowling-ball" id="tpBall">⚫</span>
        </div>
        <div class="crash-status" id="tpStatus">Roll the ball.</div>`, 'tenpin-stage');

    const betInput = container.querySelector('#tpBet');
    const roll = container.querySelector('#tpRoll');
    const ball = container.querySelector('#tpBall');
    const pinsWrap = container.querySelector('#tpPinsWrap');
    const statusEl = container.querySelector('#tpStatus');
    const pinsEl = container.querySelector('#tpPins');
    GameKit.wireBet(container, betInput);

    roll.addEventListener('click', async () => {
      if (busy) return;
      const b = GameKit.bet(betInput);
      if (b == null) return;
      busy = true; roll.disabled = true;
      pinsWrap.querySelectorAll('.bowl-pin').forEach(p => { p.classList.remove('down'); });
      ball.classList.remove('rolled'); void ball.offsetWidth;
      statusEl.textContent = 'Rolling…';
      ball.classList.add('rolling');
      try {
        const res = await API.tenpin({ bet: b });
        timers.push(setTimeout(() => {
          if (!alive) return;
          ball.classList.remove('rolling'); ball.classList.add('rolled');
          // Knock down `res.pins` pins (randomised which ones).
          const all = [...pinsWrap.querySelectorAll('.bowl-pin')];
          const shuffled = all.map(p => [Math.random(), p]).sort((a, c) => a[0] - c[0]).map(x => x[1]);
          shuffled.slice(0, res.pins).forEach((p, i) => {
            timers.push(setTimeout(() => { if (alive) p.classList.add('down'); }, i * 40));
          });
          timers.push(setTimeout(() => {
            if (!alive) return;
            pinsEl.textContent = res.pins + '/10';
            statusEl.textContent = res.strike ? 'STRIKE! 🎳 10×!'
              : res.mult >= 1 ? `${res.pins} pins — ${res.mult}×!`
              : `${res.pins} pins. Not enough — roll again.`;
            GameKit.settle('tenpin', b, res);
            busy = false; roll.disabled = false;
          }, res.pins * 40 + 300));
        }, 900));
      } catch (e) { Toast.error(e.message); busy = false; roll.disabled = false; ball.classList.remove('rolling'); }
    });

    return function () { alive = false; timers.forEach(clearTimeout); };
  }
  global.Games = global.Games || {};
  global.Games.tenpin = mount;
})(window);
