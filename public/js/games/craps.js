/* Craps — authentic pass-line bet. Come-out roll: 7/11 wins, 2/3/12 craps
 * out, anything else sets the point; then roll until the point repeats
 * (win) or a 7 shows. True-odds payout, the classic ~1.4% edge. */
(function (global) {
  'use strict';
  const DIE = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

  function mount(container) {
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('crpBet')}
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="crpStart">Come Out Roll</button>
      <button class="btn btn-primary btn-block hidden" id="crpRoll">Roll for the Point</button>
      <div class="stat-grid">
        <div class="stat"><span class="stat-label">Point</span><span class="stat-value" id="crpPoint">—</span></div>
        <div class="stat"><span class="stat-label">Last Roll</span><span class="stat-value" id="crpLast">—</span></div>
      </div>
      <p class="muted" style="font-size:11px;line-height:1.5;margin:0;">Pass line: 7 or 11 wins on the come-out, 2/3/12 loses. Anything else sets the point — hit it again before a 7 to win even money.</p>
    `, `<div class="craps-table">
          <div class="craps-dice">
            <div class="craps-die" id="crpD1">⚀</div>
            <div class="craps-die" id="crpD2">⚀</div>
          </div>
          <div class="craps-point-row" id="crpPointRow">
            ${[4,5,6,8,9,10].map(n => `<div class="craps-puck" data-point="${n}">${n}</div>`).join('')}
          </div>
        </div>
        <div class="crash-status" id="crpStatus">Place your bet and come out.</div>`, 'craps-stage');

    const betInput = container.querySelector('#crpBet');
    const startBtn = container.querySelector('#crpStart');
    const rollBtn = container.querySelector('#crpRoll');
    const d1 = container.querySelector('#crpD1');
    const d2 = container.querySelector('#crpD2');
    const pointEl = container.querySelector('#crpPoint');
    const lastEl = container.querySelector('#crpLast');
    const statusEl = container.querySelector('#crpStatus');
    let roundId = null, busy = false, alive = true, stake = 0, spins = [];
    GameKit.wireBet(container, betInput);

    function rollAnim(dice, onDone) {
      const iv = setInterval(() => {
        d1.textContent = DIE[1 + Math.floor(Math.random() * 6)];
        d2.textContent = DIE[1 + Math.floor(Math.random() * 6)];
      }, 70);
      spins.push(iv);
      setTimeout(() => {
        if (!alive) return;
        clearInterval(iv);
        d1.textContent = DIE[dice[0]];
        d2.textContent = DIE[dice[1]];
        [d1, d2].forEach(el => { el.classList.add('land'); setTimeout(() => el.classList.remove('land'), 300); });
        onDone();
      }, 650);
    }
    function setPuck(point) {
      container.querySelectorAll('.craps-puck').forEach(p =>
        p.classList.toggle('on', Number(p.dataset.point) === point));
      pointEl.textContent = point ? point : '—';
    }
    function idle() {
      roundId = null; busy = false;
      rollBtn.classList.add('hidden');
      startBtn.classList.remove('hidden');
      startBtn.disabled = false;
      betInput.disabled = false;
    }
    function finish(res) {
      const NAMES = { natural: 'Natural — you win!', craps: 'Craps. House takes it.', point_made: 'Point made — you win!', seven_out: 'Seven out.' };
      statusEl.textContent = NAMES[res.outcome] || res.outcome;
      setPuck(null);
      GameKit.settle('craps', stake, res);
      idle();
    }

    startBtn.addEventListener('click', async () => {
      if (busy || roundId) return;
      const b = GameKit.bet(betInput);
      if (b == null) return;
      busy = true; startBtn.disabled = true; stake = b;
      try {
        const res = await API.crapsStart({ bet: b });
        rollAnim(res.dice, () => {
          lastEl.textContent = res.sum;
          if (res.done) { finish(res); return; }
          roundId = res.roundId;
          setPuck(res.point);
          betInput.disabled = true;
          startBtn.classList.add('hidden');
          rollBtn.classList.remove('hidden');
          statusEl.textContent = `Point is ${res.point}. Roll it again before a 7.`;
          busy = false;
        });
      } catch (e) { Toast.error(e.message); idle(); }
    });

    rollBtn.addEventListener('click', async () => {
      if (busy || !roundId) return;
      busy = true;
      try {
        const res = await API.crapsRoll({ roundId });
        Fair.bumpNonce();
        rollAnim(res.dice, () => {
          lastEl.textContent = res.sum;
          if (res.done) { finish(res); return; }
          statusEl.textContent = `${res.sum} — no decision. Point is still ${res.point}.`;
          busy = false;
        });
      } catch (e) { Toast.error(e.message); busy = false; }
    });

    return function () { alive = false; spins.forEach(clearInterval); };
  }
  global.Games = global.Games || {};
  global.Games.craps = mount;
})(window);
