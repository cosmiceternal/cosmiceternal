/* Penalty Shootout (original) — pick a corner; the keeper dives. Score to climb
 * the multiplier, cash out any time. Five rounds for a perfect run. */
(function (global) {
  'use strict';
  const DIRS = [['0', '◀ Left'], ['1', '▲ Center'], ['2', 'Right ▶']];
  function mount(container) {
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('peBet')}
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="peAction">Step Up</button>
      <div class="pen-shoot hidden" id="peShoot">
        <label class="muted" style="font-size:11px;letter-spacing:1px;text-transform:uppercase;">Shoot where?</label>
        <div class="pen-dirs">
          ${DIRS.map(d => `<button class="btn" data-dir="${d[0]}">${d[1]}</button>`).join('')}
        </div>
      </div>
      <button class="btn btn-block hidden" id="peCash">Cashout</button>
      <div class="stat-grid">
        <div class="stat"><span class="stat-label">Goals</span><span class="stat-value" id="peGoals">0 / 5</span></div>
        <div class="stat"><span class="stat-label">Multiplier</span><span class="stat-value" id="peMult">1.00×</span></div>
      </div>
    `, `<div class="pen-pitch">
          <div class="pen-goal">
            <div class="pen-keeper" id="peKeeper">🧤</div>
            <div class="pen-net"></div>
          </div>
          <div class="pen-ball" id="peBall">⚽</div>
        </div>
        <div class="crash-status" id="peStatus">Place a bet and step up</div>`, 'penalty-stage');

    const betInput = container.querySelector('#peBet');
    const action = container.querySelector('#peAction');
    const shoot = container.querySelector('#peShoot');
    const cash = container.querySelector('#peCash');
    const keeper = container.querySelector('#peKeeper');
    const ball = container.querySelector('#peBall');
    const statusEl = container.querySelector('#peStatus');
    const goalsEl = container.querySelector('#peGoals');
    const multEl = container.querySelector('#peMult');
    let roundId = null, bet = 0, goals = 0, busy = false, alive = true;
    GameKit.wireBet(container, betInput);
    const POS = { 0: '18%', 1: '50%', 2: '82%' };

    function endRound() { roundId = null; busy = false; shoot.classList.add('hidden'); cash.classList.add('hidden'); action.classList.remove('hidden'); betInput.disabled = false; }
    function resetVisual() { keeper.style.left = '50%'; ball.style.left = '50%'; ball.style.bottom = '12%'; ball.style.opacity = '1'; }

    async function start() {
      if (busy || roundId) return;
      bet = GameKit.bet(betInput);
      if (bet == null) return;
      busy = true; action.disabled = true;
      try {
        const res = await API.penaltyStart({ bet });
        Bankroll.set(res.balance); Fair.bumpNonce();
        roundId = res.roundId; goals = 0;
        goalsEl.textContent = '0 / 5'; multEl.textContent = '1.00×';
        resetVisual();
        action.classList.add('hidden'); shoot.classList.remove('hidden'); cash.classList.add('hidden');
        betInput.disabled = true;
        statusEl.textContent = 'Pick your corner';
      } catch (e) { Toast.error(e.message); }
      finally { busy = false; action.disabled = false; }
    }
    async function takeShot(dir) {
      if (busy || !roundId) return;
      busy = true; shoot.classList.add('hidden');
      try {
        const res = await API.penaltyShoot({ roundId, dir });
        Fair.bumpNonce();
        keeper.style.left = POS[res.keeper];
        ball.style.left = POS[res.shot]; ball.style.bottom = '64%';
        await new Promise(r => setTimeout(r, 450));
        if (!alive) return;
        if (res.saved) {
          ball.style.opacity = '0.3';
          Bankroll.set(res.balance);
          Feed.recordPlayerBet({ game: 'penalty', bet, mult: 0, win: false, payout: 0 });
          Toast.loss(`Saved! −${Bankroll.fmt(bet)}`);
          statusEl.textContent = `Keeper saves it! Out after ${res.round} goal${res.round === 1 ? '' : 's'}`;
          endRound(); return;
        }
        goals = res.round; goalsEl.textContent = `${goals} / 5`;
        multEl.textContent = res.mult.toFixed(2) + '×';
        if (res.perfect) {
          Bankroll.set(res.balance);
          Feed.recordPlayerBet({ game: 'penalty', bet, mult: res.mult, win: true, payout: res.payout });
          Toast.win(`Perfect! +${Bankroll.fmt(res.payout - bet)} @ ${res.mult.toFixed(2)}×`);
          statusEl.textContent = `GOAL! Perfect 5/5 — ${res.mult.toFixed(2)}×`;
          endRound(); return;
        }
        setTimeout(() => { if (alive) resetVisual(); }, 350);
        cash.classList.remove('hidden'); cash.textContent = `Cashout — ${Bankroll.fmt(res.cashout)}`;
        shoot.classList.remove('hidden');
        statusEl.textContent = `GOAL! ${goals} scored — shoot again or cash out`;
        busy = false;
      } catch (e) { Toast.error(e.message); shoot.classList.remove('hidden'); busy = false; }
    }
    async function cashout() {
      if (busy || !roundId) return;
      busy = true;
      try {
        const res = await API.penaltyCashout({ roundId });
        Bankroll.set(res.balance);
        Feed.recordPlayerBet({ game: 'penalty', bet, mult: res.mult, win: true, payout: res.payout });
        Toast.win(`+${Bankroll.fmt(res.payout - bet)} @ ${res.mult.toFixed(2)}×`);
        statusEl.textContent = `Cashed out ${res.mult.toFixed(2)}× after ${res.goals} goals`;
        endRound();
      } catch (e) { Toast.error(e.message); busy = false; }
    }
    action.addEventListener('click', start);
    container.querySelectorAll('[data-dir]').forEach(b => b.addEventListener('click', () => takeShot(b.dataset.dir)));
    cash.addEventListener('click', cashout);
    return function () { alive = false; };
  }
  global.Games = global.Games || {};
  global.Games.penalty = mount;
})(window);
