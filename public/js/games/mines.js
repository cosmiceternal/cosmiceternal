/* Mines — the server holds the secret board. Each tile reveal and the cashout
 * are server calls; the client only animates what the server reports. */
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
            <label>Bet Amount <span class="muted">CRYPT</span></label>
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
            Reveal gems to grow your multiplier. One mine ends the round. Cash out any time to lock your profit.
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
    let busy = false;
    let roundId = null;
    let revealedCount = 0;
    let bet = 0;

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
      updateIdleStats();
    }
    pills.forEach(p => p.addEventListener('click', () => { if (!active) setMineCount(+p.dataset.mines); }));
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

    function updateIdleStats() {
      multEl.textContent = '1.00×';
      nextEl.textContent = multForSafe(1, mines).toFixed(2) + '×';
    }
    function updateActiveStats(curMult, nextMult) {
      multEl.textContent = curMult.toFixed(2) + '×';
      nextEl.textContent = (nextMult != null ? nextMult.toFixed(2) : '—') + (nextMult != null ? '×' : '');
      cashoutBtn.textContent = `Cashout — ${Bankroll.fmt(bet * curMult)}`;
      cashoutBtn.disabled = revealedCount === 0;
    }

    async function startGame() {
      if (busy) return;
      const amount = +betInput.value;
      if (!amount || amount <= 0) return Toast.warn('Enter a bet amount');
      if (!Bankroll.canAfford(amount)) return Toast.error('Insufficient balance');
      busy = true;
      try {
        const res = await API.minesStart({ bet: amount, mines });
        Bankroll.set(res.balance);
        Fair.bumpNonce();
        roundId = res.roundId;
        bet = amount;
        revealedCount = 0;
        active = true;
        grid.querySelectorAll('.mine-cell').forEach(c => {
          c.classList.remove('revealed', 'gem', 'bomb', 'dim', 'disabled');
          c.textContent = '';
        });
        actionBtn.classList.add('hidden');
        cashoutBtn.classList.remove('hidden');
        updateActiveStats(1, multForSafe(1, mines));
        pills.forEach(p => p.style.pointerEvents = 'none');
        betInput.disabled = true;
      } catch (e) { Toast.error(e.message); }
      finally { busy = false; }
    }

    function revealAll(mineCells, exceptHit) {
      const cells = grid.querySelectorAll('.mine-cell');
      cells.forEach(c => c.classList.add('disabled'));
      mineCells.forEach(idx => {
        const c = cells[idx];
        if (!c.classList.contains('revealed')) {
          c.classList.add('revealed', 'bomb', 'dim');
          c.textContent = '✸';
        }
      });
      for (let i = 0; i < 25; i++) {
        if (!mineCells.includes(i) && !cells[i].classList.contains('revealed')) cells[i].classList.add('dim');
      }
    }

    function finishRound() {
      active = false;
      roundId = null;
      cashoutBtn.classList.add('hidden');
      actionBtn.classList.remove('hidden');
      actionBtn.textContent = 'Bet';
      betInput.disabled = false;
      pills.forEach(p => p.style.pointerEvents = '');
      setTimeout(() => {
        if (!alive || active) return;
        grid.querySelectorAll('.mine-cell').forEach(c => {
          c.classList.remove('revealed', 'gem', 'bomb', 'dim', 'disabled');
          c.textContent = '';
        });
        updateIdleStats();
      }, 2200);
    }

    async function onCell(i, cell) {
      if (!active || busy || cell.classList.contains('revealed')) return;
      busy = true;
      try {
        const res = await API.minesReveal({ roundId, cell: i });
        Bankroll.set(res.balance);
        if (res.hit) {
          cell.classList.add('revealed', 'bomb');
          cell.textContent = '✸';
          revealAll(res.mineCells);
          Toast.loss(`Mine! Lost ${Bankroll.fmt(bet)}`);
          Feed.recordPlayerBet({ game: 'mines', bet, mult: 0, win: false, payout: 0 });
          finishRound();
          return;
        }
        cell.classList.add('revealed', 'gem');
        cell.textContent = '◆';
        revealedCount = res.safeCount;
        if (res.cleared) {
          Toast.win(`Cleared! +${Bankroll.fmt(res.payout - bet)} @ ${res.mult.toFixed(2)}×`);
          Feed.recordPlayerBet({ game: 'mines', bet, mult: res.mult, win: true, payout: res.payout });
          finishRound();
        } else {
          updateActiveStats(res.mult, res.nextMult);
        }
      } catch (e) { Toast.error(e.message); }
      finally { busy = false; }
    }

    async function cashout() {
      if (!active || busy || revealedCount === 0) return;
      busy = true;
      try {
        const res = await API.minesCashout({ roundId });
        Bankroll.set(res.balance);
        revealAll(res.mineCells);
        Toast.win(`+${Bankroll.fmt(res.payout - bet)} @ ${res.mult.toFixed(2)}×`);
        Feed.recordPlayerBet({ game: 'mines', bet, mult: res.mult, win: true, payout: res.payout });
        finishRound();
      } catch (e) { Toast.error(e.message); }
      finally { busy = false; }
    }

    actionBtn.addEventListener('click', startGame);
    cashoutBtn.addEventListener('click', cashout);
    setMineCount(3);

    let alive = true;
    return function unmount() { alive = false; };
  }

  global.Games = global.Games || {};
  global.Games.mines = mountMines;
})(window);
