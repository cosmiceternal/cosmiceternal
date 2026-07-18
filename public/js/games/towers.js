/* Towers — climb the tower one row at a time; one trap per row ends it. */
(function (global) {
  'use strict';
  const DIFFS = ['easy', 'medium', 'hard', 'expert', 'nightmare'];
  function mount(container) {
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('twBet')}
      <div class="field">
        <label>Difficulty</label>
        <div class="pills" id="twDiff">
          ${DIFFS.map((d, i) => `<button class="pill ${i === 0 ? 'active' : ''}" data-diff="${d}">${d[0].toUpperCase() + d.slice(1)}</button>`).join('')}
        </div>
      </div>
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="twAction">Bet</button>
      <button class="btn btn-block hidden" id="twCash">Cashout</button>
      <div class="stat-grid">
        <div class="stat"><span class="stat-label">Current</span><span class="stat-value" id="twMult">1.00×</span></div>
        <div class="stat"><span class="stat-label">Next Row</span><span class="stat-value" id="twNext">—</span></div>
      </div>
    `, `<div class="towers-grid" id="twGrid"></div>
        <div class="crash-status" id="twStatus">Pick a difficulty and bet</div>`, 'towers-stage');

    const betInput = container.querySelector('#twBet');
    const action = container.querySelector('#twAction');
    const cash = container.querySelector('#twCash');
    const grid = container.querySelector('#twGrid');
    const statusEl = container.querySelector('#twStatus');
    const multEl = container.querySelector('#twMult');
    const nextEl = container.querySelector('#twNext');
    const diffPills = container.querySelectorAll('[data-diff]');
    let diff = 'easy', roundId = null, bet = 0, tiles = 4, rows = 9, cur = 0, busy = false, alive = true;
    GameKit.wireBet(container, betInput);
    diffPills.forEach(p => p.addEventListener('click', () => { if (roundId) return; diffPills.forEach(x => x.classList.remove('active')); p.classList.add('active'); diff = p.dataset.diff; }));

    function build() {
      grid.innerHTML = '';
      for (let r = rows - 1; r >= 0; r--) {
        const row = document.createElement('div');
        row.className = 'tw-row'; row.dataset.row = r;
        for (let t = 0; t < tiles; t++) {
          const cell = document.createElement('div');
          cell.className = 'tw-cell'; cell.dataset.row = r; cell.dataset.tile = t;
          cell.addEventListener('click', () => reveal(r, t));
          row.appendChild(cell);
        }
        grid.appendChild(row);
      }
      highlight();
    }
    function highlight() {
      grid.querySelectorAll('.tw-row').forEach(row => row.classList.toggle('active', +row.dataset.row === cur && roundId));
    }
    function endRound() { roundId = null; busy = false; cash.classList.add('hidden'); action.classList.remove('hidden'); action.textContent = 'Bet'; betInput.disabled = false; diffPills.forEach(p => p.style.pointerEvents = ''); highlight(); }

    async function start() {
      if (busy || roundId) return;
      bet = GameKit.bet(betInput);
      if (bet == null) return;
      busy = true; action.disabled = true;
      try {
        const res = await API.towersStart({ bet, difficulty: diff });
        Bankroll.set(res.balance); Fair.bumpNonce();
        roundId = res.roundId; tiles = res.tiles; rows = res.rows; cur = 0;
        build();
        multEl.textContent = '1.00×'; nextEl.textContent = res.nextMult.toFixed(2) + '×';
        action.classList.add('hidden'); cash.classList.add('hidden');
        betInput.disabled = true; diffPills.forEach(p => p.style.pointerEvents = 'none');
        statusEl.textContent = 'Pick a tile in the bottom row';
      } catch (e) { Toast.error(e.message); }
      finally { busy = false; action.disabled = false; }
    }
    function revealTraps(trapRows) {
      grid.querySelectorAll('.tw-cell').forEach(c => {
        const r = +c.dataset.row, t = +c.dataset.tile;
        if (trapRows[r] && trapRows[r].includes(t) && !c.classList.contains('safe')) { c.classList.add('trap'); c.textContent = '✸'; }
        c.style.pointerEvents = 'none';
      });
    }
    async function reveal(r, t) {
      if (busy || !roundId || r !== cur) return;
      busy = true;
      try {
        const res = await API.towersReveal({ roundId, tile: t });
        Bankroll.set(res.balance);
        const cell = grid.querySelector(`.tw-cell[data-row="${r}"][data-tile="${t}"]`);
        if (res.hit) {
          cell.classList.add('trap'); cell.textContent = '✸';
          revealTraps(res.trapRows);
          Feed.recordPlayerBet({ game: 'towers', bet, mult: 0, win: false, payout: 0 });
          if (global.Sound) Sound.play('loss');
          Toast.loss(`−${Bankroll.fmt(bet)}`);
          statusEl.textContent = 'Hit a trap — round over';
          endRound(); return;
        }
        cell.classList.add('safe'); cell.textContent = '◆';
        if (global.Sound) Sound.play('climb', { n: r });
        grid.querySelectorAll(`.tw-cell[data-row="${r}"]`).forEach(c => c.style.pointerEvents = 'none');
        multEl.textContent = res.mult.toFixed(2) + '×';
        if (res.cleared) {
          Bankroll.set(res.balance);
          Feed.recordPlayerBet({ game: 'towers', bet, mult: res.mult, win: true, payout: res.payout });
          if (global.Sound) Sound.play(res.mult >= 10 ? 'bigwin' : 'win');
          GameKit.flashWin();
          Toast.win(`Cleared! +${Bankroll.fmt(res.payout - bet)} @ ${res.mult.toFixed(2)}×`);
          statusEl.textContent = `Tower cleared! ${res.mult.toFixed(2)}×`;
          endRound(); return;
        }
        cur = res.row + 1; highlight();
        nextEl.textContent = res.nextMult.toFixed(2) + '×';
        cash.classList.remove('hidden'); cash.textContent = `Cashout — ${Bankroll.fmt(res.cashout)}`;
        statusEl.textContent = 'Climb higher or cash out';
      } catch (e) { Toast.error(e.message); }
      finally { busy = false; }
    }
    async function cashout() {
      if (busy || !roundId) return;
      busy = true;
      try {
        const res = await API.towersCashout({ roundId });
        Bankroll.set(res.balance);
        revealTraps(res.trapRows);
        Feed.recordPlayerBet({ game: 'towers', bet, mult: res.mult, win: true, payout: res.payout });
        if (global.Sound) Sound.play('cashout');
        GameKit.flashWin();
        Toast.win(`+${Bankroll.fmt(res.payout - bet)} @ ${res.mult.toFixed(2)}×`);
        statusEl.textContent = `Cashed out ${res.mult.toFixed(2)}×`;
        endRound();
      } catch (e) { Toast.error(e.message); busy = false; }
    }
    action.addEventListener('click', start);
    cash.addEventListener('click', cashout);
    return function () { alive = false; };
  }
  global.Games = global.Games || {};
  global.Games.towers = mount;
})(window);
