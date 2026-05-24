/* Dice — the server rolls and settles; the client renders the result. */
(function (global) {
  'use strict';

  function mountDice(container) {
    container.innerHTML = `
      <div class="game-grid">
        <div class="controls">
          <div class="field">
            <label>Bet Amount <span class="muted">FUN</span></label>
            <div class="bet-row">
              <input id="dBet" type="number" min="0.01" step="0.01" value="1.00" />
              <button class="btn" data-act="half">½</button>
              <button class="btn" data-act="dbl">2×</button>
              <button class="btn" data-act="max">Max</button>
            </div>
          </div>
          <div class="field">
            <label>Direction</label>
            <div class="toggle" id="dDir">
              <button data-dir="under">Roll Under</button>
              <button class="active" data-dir="over">Roll Over</button>
            </div>
          </div>
          <div class="field">
            <label>Target <span id="dTargetVal" class="muted">50.00</span></label>
            <input id="dTarget" type="range" min="2" max="98" step="0.01" value="50" />
          </div>
          <div class="stat-grid">
            <div class="stat"><span class="stat-label">Win Chance</span><span class="stat-value" id="dChance">49.99%</span></div>
            <div class="stat"><span class="stat-label">Payout</span><span class="stat-value" id="dPayout">1.98×</span></div>
            <div class="stat"><span class="stat-label">Profit</span><span class="stat-value" id="dProfit">0.98</span></div>
            <div class="stat"><span class="stat-label">House Edge</span><span class="stat-value">1.00%</span></div>
          </div>
          <div class="divider"></div>
          <button class="btn btn-primary btn-block" id="dAction">Roll Dice</button>
          <p class="muted" style="font-size:11px;line-height:1.5;margin:0;">
            Drag the slider to set your target. Roll Over wins above it; Roll Under wins below.
          </p>
        </div>
        <div class="stage dice-stage">
          <div class="dice-result" id="dResult">0.00</div>
          <div class="dice-slider-wrap">
            <div class="dice-track" id="dTrack" style="--target-pct:50%;">
              <div class="dice-marker" id="dMarker" style="left:50%;"></div>
            </div>
          </div>
          <div class="dice-scale"><span>0</span><span>25</span><span>50</span><span>75</span><span>100</span></div>
        </div>
      </div>
    `;

    const betInput = container.querySelector('#dBet');
    const actionBtn = container.querySelector('#dAction');
    const dirBtns = container.querySelectorAll('#dDir button');
    const target = container.querySelector('#dTarget');
    const targetVal = container.querySelector('#dTargetVal');
    const track = container.querySelector('#dTrack');
    const marker = container.querySelector('#dMarker');
    const result = container.querySelector('#dResult');
    const chanceEl = container.querySelector('#dChance');
    const payoutEl = container.querySelector('#dPayout');
    const profitEl = container.querySelector('#dProfit');

    let dir = 'over';
    let busy = false;

    function updateStats() {
      const t = +target.value;
      targetVal.textContent = t.toFixed(2);
      const winChance = dir === 'over' ? (99.99 - t) : t;
      const mult = 99 / Math.max(0.01, winChance);
      chanceEl.textContent = winChance.toFixed(2) + '%';
      payoutEl.textContent = mult.toFixed(4) + '×';
      profitEl.textContent = ((+betInput.value || 0) * (mult - 1)).toFixed(2);
      const pct = t;
      track.style.setProperty('--target-pct', pct + '%');
      track.style.background = dir === 'over'
        ? `linear-gradient(90deg, var(--danger) 0%, var(--danger) ${pct}%, var(--accent) ${pct}%, var(--accent) 100%)`
        : `linear-gradient(90deg, var(--accent) 0%, var(--accent) ${pct}%, var(--danger) ${pct}%, var(--danger) 100%)`;
    }

    target.addEventListener('input', updateStats);
    betInput.addEventListener('input', updateStats);
    dirBtns.forEach(b => b.addEventListener('click', () => {
      dirBtns.forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      dir = b.dataset.dir;
      updateStats();
    }));
    container.querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.act;
        let v = +betInput.value || 0;
        if (act === 'half') v = v / 2;
        else if (act === 'dbl') v = v * 2;
        else if (act === 'max') v = Bankroll.get();
        betInput.value = Math.max(0.01, +v.toFixed(2));
        updateStats();
      });
    });
    updateStats();

    async function roll() {
      if (busy) return;
      const bet = +betInput.value;
      if (!bet || bet <= 0) return Toast.warn('Enter a bet amount');
      if (!Bankroll.canAfford(bet)) return Toast.error('Insufficient balance');
      busy = true;
      actionBtn.disabled = true;
      result.classList.remove('win', 'loss');
      result.textContent = '…';

      const preBalance = Bankroll.get();
      try {
        const res = await API.dice({ bet, target: +target.value, dir });
        Bankroll.set(preBalance - bet); // deduct now; settle when the marker lands
        Fair.bumpNonce();
        marker.style.left = Math.max(0, Math.min(100, res.roll)) + '%';
        setTimeout(() => {
          Bankroll.set(res.balance);
          result.textContent = res.roll.toFixed(2);
          result.classList.add(res.win ? 'win' : 'loss');
          if (res.win) Toast.win(`+${Bankroll.fmt(res.payout - bet)} @ ${res.mult.toFixed(2)}×`);
          else Toast.loss(`Lost ${Bankroll.fmt(bet)}`);
          Feed.recordPlayerBet({ game: 'dice', bet, mult: res.win ? res.mult : 0, win: res.win, payout: res.payout });
        }, 480);
      } catch (e) {
        Toast.error(e.message);
        result.textContent = '0.00';
      } finally {
        setTimeout(() => { busy = false; actionBtn.disabled = false; }, 520);
      }
    }

    actionBtn.addEventListener('click', roll);
    return function unmount() {};
  }

  global.Games = global.Games || {};
  global.Games.dice = mountDice;
})(window);
