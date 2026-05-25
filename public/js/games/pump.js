/* Pump — inflate the balloon for a rising multiplier; one pump too many pops it. */
(function (global) {
  'use strict';
  const DIFFS = ['easy', 'medium', 'hard', 'extreme'];
  function mount(container) {
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('puBet')}
      <div class="field">
        <label>Difficulty</label>
        <div class="pills" id="puDiff">
          ${DIFFS.map((d, i) => `<button class="pill ${i === 0 ? 'active' : ''}" data-diff="${d}">${d[0].toUpperCase() + d.slice(1)}</button>`).join('')}
        </div>
      </div>
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="puAction">Bet</button>
      <div class="row hidden" id="puActive">
        <button class="btn btn-primary" id="puPump" style="flex:1">Pump</button>
        <button class="btn" id="puCash" style="flex:1">Cashout</button>
      </div>
      <div class="stat-grid">
        <div class="stat"><span class="stat-label">Multiplier</span><span class="stat-value" id="puMult">1.00×</span></div>
        <div class="stat"><span class="stat-label">Next Pump</span><span class="stat-value" id="puNext">—</span></div>
      </div>
    `, `<div class="pump-area"><div class="balloon" id="puBalloon"><span id="puBalloonMult">1.00×</span></div></div>
        <div class="crash-status" id="puStatus">Pick a difficulty and bet</div>`, 'pump-stage');

    const betInput = container.querySelector('#puBet');
    const action = container.querySelector('#puAction');
    const active = container.querySelector('#puActive');
    const pumpBtn = container.querySelector('#puPump');
    const cashBtn = container.querySelector('#puCash');
    const balloon = container.querySelector('#puBalloon');
    const balloonMult = container.querySelector('#puBalloonMult');
    const statusEl = container.querySelector('#puStatus');
    const multEl = container.querySelector('#puMult');
    const nextEl = container.querySelector('#puNext');
    const diffPills = container.querySelectorAll('[data-diff]');
    let diff = 'easy', roundId = null, bet = 0, level = 0, busy = false, alive = true;
    GameKit.wireBet(container, betInput);
    diffPills.forEach(p => p.addEventListener('click', () => { if (roundId) return; diffPills.forEach(x => x.classList.remove('active')); p.classList.add('active'); diff = p.dataset.diff; }));

    function scale() { balloon.style.transform = `scale(${Math.min(2.1, 1 + level * 0.13)})`; }
    function endRound() { roundId = null; busy = false; active.classList.add('hidden'); action.classList.remove('hidden'); betInput.disabled = false; diffPills.forEach(p => p.style.pointerEvents = ''); }

    async function start() {
      if (busy || roundId) return;
      bet = GameKit.bet(betInput);
      if (bet == null) return;
      busy = true; action.disabled = true;
      try {
        const res = await API.pumpStart({ bet, difficulty: diff });
        Bankroll.set(res.balance); Fair.bumpNonce();
        roundId = res.roundId; level = 0;
        balloon.className = 'balloon'; scale();
        balloonMult.textContent = '1.00×'; multEl.textContent = '1.00×';
        nextEl.textContent = res.nextMult.toFixed(2) + '×';
        action.classList.add('hidden'); active.classList.remove('hidden');
        betInput.disabled = true; diffPills.forEach(p => p.style.pointerEvents = 'none');
        statusEl.textContent = 'Pump it up!';
      } catch (e) { Toast.error(e.message); }
      finally { busy = false; action.disabled = false; }
    }
    async function pump() {
      if (busy || !roundId) return;
      busy = true;
      try {
        const res = await API.pumpPump({ roundId });
        Fair.bumpNonce();
        if (res.burst) {
          Bankroll.set(res.balance);
          balloon.classList.add('pop'); balloonMult.textContent = '💥';
          Feed.recordPlayerBet({ game: 'pump', bet, mult: 0, win: false, payout: 0 });
          Toast.loss(`Popped! −${Bankroll.fmt(bet)}`);
          statusEl.textContent = 'Popped!';
          endRound(); return;
        }
        level = res.level; scale();
        balloonMult.textContent = res.mult.toFixed(2) + '×'; multEl.textContent = res.mult.toFixed(2) + '×';
        if (res.maxed) {
          Bankroll.set(res.balance);
          Feed.recordPlayerBet({ game: 'pump', bet, mult: res.mult, win: true, payout: res.payout });
          Toast.win(`Maxed! +${Bankroll.fmt(res.payout - bet)} @ ${res.mult.toFixed(2)}×`);
          statusEl.textContent = `Maxed out at ${res.mult.toFixed(2)}×`;
          endRound(); return;
        }
        nextEl.textContent = res.nextMult.toFixed(2) + '×';
        cashBtn.textContent = `Cashout ${Bankroll.fmt(res.cashout)}`;
        statusEl.textContent = 'Bigger… or cash out?';
      } catch (e) { Toast.error(e.message); }
      finally { busy = false; }
    }
    async function cashout() {
      if (busy || !roundId || level < 1) return;
      busy = true;
      try {
        const res = await API.pumpCashout({ roundId });
        Bankroll.set(res.balance);
        Feed.recordPlayerBet({ game: 'pump', bet, mult: res.mult, win: true, payout: res.payout });
        Toast.win(`+${Bankroll.fmt(res.payout - bet)} @ ${res.mult.toFixed(2)}×`);
        statusEl.textContent = `Cashed out ${res.mult.toFixed(2)}×`;
        endRound();
      } catch (e) { Toast.error(e.message); busy = false; }
    }
    action.addEventListener('click', start);
    pumpBtn.addEventListener('click', pump);
    cashBtn.addEventListener('click', cashout);
    return function () { alive = false; };
  }
  global.Games = global.Games || {};
  global.Games.pump = mount;
})(window);
