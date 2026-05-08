/* Dice — provably-fair roll in [0.00, 99.99]. Player picks a target and Over/Under.
 * Win chance = (99.99 - target) for "over" and (target) for "under".
 * Multiplier = 99 / win_chance  (1% house edge). */
(function (global) {
  'use strict';

  const HOUSE = 1.0;

  function mountDice(container) {
    container.innerHTML = `
      <div class="game-grid">
        <div class="controls">
          <div class="field">
            <label>Bet Amount <span class="muted">USD</span></label>
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
            Drag the slider to set your target. Roll Over wins on rolls greater than the target; Roll Under wins on rolls below it.
          </p>
        </div>
        <div class="stage dice-stage">
          <div class="dice-result" id="dResult">0.00</div>
          <div class="dice-slider-wrap">
            <div class="dice-track" id="dTrack" style="--target-pct:50%;">
              <div class="dice-marker" id="dMarker" style="left:50%;"></div>
            </div>
          </div>
          <div class="dice-scale">
            <span>0</span><span>25</span><span>50</span><span>75</span><span>100</span>
          </div>
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

    function updateStats() {
      const t = +target.value;
      targetVal.textContent = t.toFixed(2);
      const winChance = dir === 'over' ? (99.99 - t) : t;
      const safeWC = Math.max(0.01, winChance);
      const mult = (99 / safeWC);
      chanceEl.textContent = winChance.toFixed(2) + '%';
      payoutEl.textContent = mult.toFixed(4) + '×';
      const bet = +betInput.value || 0;
      profitEl.textContent = (bet * (mult - 1)).toFixed(2);
      const pct = (t / 100) * 100;
      track.style.setProperty('--target-pct', pct + '%');
      // Color order swaps for under/over
      if (dir === 'over') {
        track.style.background = `linear-gradient(90deg, var(--danger) 0%, var(--danger) ${pct}%, var(--accent) ${pct}%, var(--accent) 100%)`;
      } else {
        track.style.background = `linear-gradient(90deg, var(--accent) 0%, var(--accent) ${pct}%, var(--danger) ${pct}%, var(--danger) 100%)`;
      }
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

    function roll() {
      const amount = +betInput.value;
      if (!amount || amount <= 0) return Toast.warn('Enter a bet amount');
      if (!Bankroll.canAfford(amount)) return Toast.error('Insufficient balance');
      Bankroll.add(-amount);

      const sample = Fair.sampleDice();
      const v = sample.roll;
      const t = +target.value;
      const win = dir === 'over' ? v > t : v < t;
      const winChance = dir === 'over' ? (99.99 - t) : t;
      const mult = 99 / Math.max(0.01, winChance);
      const payout = win ? amount * mult : 0;

      Fair.recordRoll({
        game: 'dice', nonce: sample.fair.nonce, hash: sample.fair.hash,
        result: v.toFixed(2), ts: Date.now()
      });

      // Animate marker
      const pct = Math.max(0, Math.min(100, v));
      marker.style.left = pct + '%';
      result.classList.remove('win','loss');
      result.textContent = '…';

      // Settle after the marker animation roughly completes
      setTimeout(() => {
        result.textContent = v.toFixed(2);
        result.classList.add(win ? 'win' : 'loss');
        if (win) {
          Bankroll.add(payout);
          Toast.win(`+${Bankroll.fmt(payout - amount)} @ ${mult.toFixed(2)}×`);
        } else {
          Toast.loss(`Lost ${Bankroll.fmt(amount)}`);
        }
        Feed.recordPlayerBet({ game: 'dice', bet: amount, mult: win ? mult : 0, win, payout });
      }, 520);
    }

    actionBtn.addEventListener('click', roll);

    return function unmount() {};
  }

  global.Games = global.Games || {};
  global.Games.dice = mountDice;
})(window);
