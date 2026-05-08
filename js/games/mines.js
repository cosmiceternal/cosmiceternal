/* Mines — 5x5 grid. Choose mine count, click safe tiles to grow multiplier,
 * cash out any time. Hitting a mine ends the round and loses the bet.
 *
 * Multiplier formula: prod_{i=0..safe-1} (25 - i) / (25 - mines - i) * (1 - house),
 * with house = 0.01.
 */
(function (global) {
  'use strict';

  const HOUSE = 0.01;

  function multForSafe(safe, mines) {
    let p = 1;
    for (let i = 0; i < safe; i++) p *= (25 - i) / (25 - mines - i);
    return p * (1 - HOUSE);
  }

  function mountMines(container) {
    container.innerHTML = `
      <div class="game-grid">
        <div class="controls">
          <div class="field">
            <label>Bet Amount <span class="muted">USD</span></label>
            <div class="bet-row">
              <input id="mBet" type="number" min="0.01" step="0.01" value="1.00" />
              <button class="btn" data-act="half">½</button>
              <button class="btn" data-act="dbl">2×</button>
              <button class="btn" data-act="max">Max</button>
            </div>
          </div>
          <div class="field">
            <label>Mines <span id="mMineCount" class="muted">3</span></label>
            <div class="pills" id="mPills">
              ${[1,3,5,8,12,18,24].map(n => `<button class="pill ${n===3?'active':''}" data-mines="${n}">${n}</button>`).join('')}
            </div>
          </div>
          <div class="divider"></div>
          <button class="btn btn-primary btn-block" id="mAction">Bet</button>
          <button class="btn btn-block hidden" id="mCashout">Cashout — 0.00</button>
          <div class="stat-grid">
            <div class="stat"><span class="stat-label">Next Tile</span><span class="stat-value" id="mNext">—</span></div>
            <div class="stat"><span class="stat-label">Total Mult</span><span class="stat-value" id="mMult">1.00×</span></div>
          </div>
          <div class="divider"></div>
          <p class="muted" style="font-size:11px;line-height:1.5;margin:0;">
            Reveal gems to grow your multiplier. One mine ends the round. Cash out any time to lock in your profit.
          </p>
        </div>
        <div class="stage mines-stage">
          <div class="mines-grid" id="mGrid"></div>
        </div>
      </div>
    `;

    const grid = container.querySelector('#mGrid');
    const betInput = container.querySelector('#mBet');
    const actionBtn = container.querySelector('#mAction');
    const cashoutBtn = container.querySelector('#mCashout');
    const pills = container.querySelectorAll('.pill');
    const mineCountEl = container.querySelector('#mMineCount');
    const nextEl = container.querySelector('#mNext');
    const multEl = container.querySelector('#mMult');

    let mines = 3;
    let active = false;
    let mineSet = null;
    let revealed = new Set();
    let bet = 0;
    let currentMult = 1;

    function buildGrid() {
      grid.innerHTML = '';
      for (let i = 0; i < 25; i++) {
        const cell = document.createElement('div');
        cell.className = 'mine-cell';
        cell.dataset.idx = i;
        cell.addEventListener('click', () => onCell(i, cell));
        grid.appendChild(cell);
      }
    }
    buildGrid();

    function setMineCount(n) {
      mines = n;
      mineCountEl.textContent = n;
      pills.forEach(p => p.classList.toggle('active', +p.dataset.mines === n));
      updateNext();
    }
    pills.forEach(p => p.addEventListener('click', () => {
      if (active) return;
      setMineCount(+p.dataset.mines);
    }));

    container.querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.act;
        let v = +betInput.value || 0;
        if (act === 'half') v = v / 2;
        else if (act === 'dbl') v = v * 2;
        else if (act === 'max') v = Bankroll.get();
        betInput.value = Math.max(0.01, +v.toFixed(2));
      });
    });

    function updateNext() {
      const safe = revealed.size;
      const next = multForSafe(safe + 1, mines);
      const cur = safe === 0 ? 1 : multForSafe(safe, mines);
      currentMult = cur;
      multEl.textContent = cur.toFixed(2) + '×';
      nextEl.textContent = next.toFixed(2) + '×';
      if (active) {
        cashoutBtn.textContent = `Cashout — ${Bankroll.fmt(bet * cur)}`;
        cashoutBtn.disabled = safe === 0;
      }
    }

    function startGame() {
      const amount = +betInput.value;
      if (!amount || amount <= 0) return Toast.warn('Enter a bet amount');
      if (!Bankroll.canAfford(amount)) return Toast.error('Insufficient balance');
      Bankroll.add(-amount);
      bet = amount;
      const sample = Fair.sampleMines(mines);
      mineSet = sample.mines;
      revealed = new Set();
      active = true;
      Fair.recordRoll({
        game: 'mines', nonce: sample.fair[0].nonce, hash: sample.fair[0].hash,
        result: `${mines} mines`, ts: Date.now()
      });

      grid.querySelectorAll('.mine-cell').forEach(c => {
        c.classList.remove('revealed','gem','bomb','dim','disabled');
        c.textContent = '';
      });

      actionBtn.classList.add('hidden');
      cashoutBtn.classList.remove('hidden');
      updateNext();
      pills.forEach(p => p.style.pointerEvents = 'none');
      betInput.disabled = true;
    }

    function endGame(win) {
      active = false;
      const cells = grid.querySelectorAll('.mine-cell');
      cells.forEach(c => c.classList.add('disabled'));
      // Reveal everything
      mineSet.forEach(idx => {
        const c = cells[idx];
        if (!c.classList.contains('revealed')) {
          c.classList.add('revealed','bomb','dim');
          c.textContent = '✸';
        }
      });
      for (let i = 0; i < 25; i++) {
        if (!mineSet.has(i) && !revealed.has(i)) {
          cells[i].classList.add('dim');
        }
      }

      const finalMult = win ? multForSafe(revealed.size, mines) : 0;
      const payout = win ? bet * finalMult : 0;
      if (win) {
        Bankroll.add(payout);
        Toast.win(`+${Bankroll.fmt(payout - bet)} @ ${finalMult.toFixed(2)}×`);
        Feed.recordPlayerBet({ game: 'mines', bet, mult: finalMult, win: true, payout });
      } else {
        Toast.loss(`Mine! Lost ${Bankroll.fmt(bet)}`);
        Feed.recordPlayerBet({ game: 'mines', bet, mult: 0, win: false, payout: 0 });
      }

      cashoutBtn.classList.add('hidden');
      actionBtn.classList.remove('hidden');
      actionBtn.textContent = 'Bet';
      betInput.disabled = false;
      pills.forEach(p => p.style.pointerEvents = '');
      // Auto-clear after a moment
      setTimeout(() => {
        if (!alive) return;
        if (!active) {
          grid.querySelectorAll('.mine-cell').forEach(c => {
            c.classList.remove('revealed','gem','bomb','dim','disabled');
            c.textContent = '';
          });
          updateNext();
        }
      }, 2200);
    }

    function onCell(i, cell) {
      if (!active || revealed.has(i) || cell.classList.contains('revealed')) return;
      if (mineSet.has(i)) {
        cell.classList.add('revealed','bomb');
        cell.textContent = '✸';
        endGame(false);
        return;
      }
      revealed.add(i);
      cell.classList.add('revealed','gem');
      cell.textContent = '◆';
      updateNext();
      const safeRemaining = 25 - mines - revealed.size;
      if (safeRemaining === 0) {
        // Cleared the board — auto cashout
        endGame(true);
      }
    }

    actionBtn.addEventListener('click', startGame);
    cashoutBtn.addEventListener('click', () => {
      if (!active || revealed.size === 0) return;
      endGame(true);
    });

    setMineCount(3);

    let alive = true;
    return function unmount() { alive = false; };
  }

  global.Games = global.Games || {};
  global.Games.mines = mountMines;
})(window);
