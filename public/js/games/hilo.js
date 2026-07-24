/* Hi-Lo — call whether the next card is higher or lower; ride the streak. */
(function (global) {
  'use strict';
  function mount(container) {
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('hlBet')}
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="hlDeal">Deal</button>
      <div class="hilo-calls hidden" id="hlCalls">
        <button class="btn btn-block" id="hlHi">▲ Higher / same</button>
        <button class="btn btn-block" id="hlLo">▼ Lower / same</button>
      </div>
      <button class="btn btn-block hidden" id="hlCash">Cashout</button>
      <div class="stat-grid">
        <div class="stat"><span class="stat-label">Multiplier</span><span class="stat-value" id="hlMult">1.00×</span></div>
        <div class="stat"><span class="stat-label">Streak</span><span class="stat-value" id="hlStreak">0</span></div>
      </div>
    `, `<div class="hilo-card" id="hlCard">?</div>
        <div class="hilo-hist" id="hlHist"></div>
        <div class="crash-status" id="hlStatus">Deal to begin</div>`, 'hilo-stage');

    const betInput = container.querySelector('#hlBet');
    const deal = container.querySelector('#hlDeal');
    const calls = container.querySelector('#hlCalls');
    const hiBtn = container.querySelector('#hlHi');
    const loBtn = container.querySelector('#hlLo');
    const cash = container.querySelector('#hlCash');
    const cardEl = container.querySelector('#hlCard');
    const hist = container.querySelector('#hlHist');
    const statusEl = container.querySelector('#hlStatus');
    const multEl = container.querySelector('#hlMult');
    const streakEl = container.querySelector('#hlStreak');
    let roundId = null, bet = 0, busy = false, streak = 0;
    GameKit.wireBet(container, betInput);

    function setCard(rank) { cardEl.textContent = GameKit.cardLabel(rank); cardEl.classList.remove('flip'); void cardEl.offsetWidth; cardEl.classList.add('flip'); }
    function pushHist(rank, good) { const s = document.createElement('span'); s.className = 'hl-chip ' + (good ? 'good' : 'bad'); s.textContent = GameKit.cardLabel(rank); hist.prepend(s); while (hist.children.length > 12) hist.lastChild.remove(); }
    function setButtons(m) {
      hiBtn.textContent = `▲ Higher / same  ${m.hi.toFixed(2)}×`;
      loBtn.textContent = `▼ Lower / same  ${m.lo.toFixed(2)}×`;
    }
    function endRound() {
      roundId = null; busy = false;
      calls.classList.add('hidden'); cash.classList.add('hidden'); deal.classList.remove('hidden');
    }

    async function start() {
      if (busy || roundId) return;
      bet = GameKit.bet(betInput);
      if (bet == null) return;
      busy = true; deal.disabled = true;
      try {
        const res = await API.hiloStart({ bet });
        Bankroll.set(res.balance); Fair.bumpNonce();
        roundId = res.roundId; streak = 0;
        setCard(res.card); hist.innerHTML = '';
        multEl.textContent = '1.00×'; streakEl.textContent = '0';
        setButtons(res.mults);
        deal.classList.add('hidden'); calls.classList.remove('hidden'); cash.classList.add('hidden');
        statusEl.textContent = 'Higher or lower?';
      } catch (e) { Toast.error(e.message); }
      finally { busy = false; deal.disabled = false; }
    }
    async function guess(choice) {
      if (busy || !roundId) return;
      busy = true;
      try {
        const res = await API.hiloGuess({ roundId, choice });
        Fair.bumpNonce();
        if (!res.win) {
          setCard(res.card); pushHist(res.card, false);
          statusEl.textContent = `It was ${GameKit.cardLabel(res.card)} — busted!`;
          Bankroll.set(res.balance);
          Feed.recordPlayerBet({ game: 'hilo', bet, mult: 0, win: false, payout: 0 });
          if (global.Sound) Sound.play('loss');
          Toast.loss(`−${Bankroll.fmt(bet)}`);
          endRound(); return;
        }
        setCard(res.card); pushHist(res.card, true);
        streak++; streakEl.textContent = streak;
        if (global.Sound) Sound.play('climb', { n: streak });
        multEl.textContent = res.mult.toFixed(2) + '×';
        setButtons(res.mults);
        cash.classList.remove('hidden');
        cash.textContent = `Cashout — ${Bankroll.fmt(res.cashout)}`;
        statusEl.textContent = 'Keep going or cash out?';
      } catch (e) { Toast.error(e.message); }
      finally { busy = false; }
    }
    async function cashout() {
      if (busy || !roundId) return;
      busy = true;
      try {
        const res = await API.hiloCashout({ roundId });
        Bankroll.set(res.balance);
        statusEl.textContent = `Cashed out ${res.mult.toFixed(2)}× — +${Bankroll.fmt(res.payout - bet)}`;
        Feed.recordPlayerBet({ game: 'hilo', bet, mult: res.mult, win: true, payout: res.payout });
        if (global.Sound) Sound.play('cashout');
        GameKit.flashWin();
        Toast.win(`+${Bankroll.fmt(res.payout - bet)} @ ${res.mult.toFixed(2)}×`);
        endRound();
      } catch (e) { Toast.error(e.message); busy = false; }
    }
    deal.addEventListener('click', start);
    hiBtn.addEventListener('click', () => guess('hi'));
    loBtn.addEventListener('click', () => guess('lo'));
    cash.addEventListener('click', cashout);
    return function () {};
  }
  global.Games = global.Games || {};
  global.Games.hilo = mount;
})(window);
