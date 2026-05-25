/* Coin Flip — pick a side, ride the streak; each correct flip is 1.98×. */
(function (global) {
  'use strict';
  function mount(container) {
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('cnBet')}
      <div class="field">
        <label>Your Side</label>
        <div class="toggle" id="cnSide">
          <button class="active" data-side="heads">Heads</button>
          <button data-side="tails">Tails</button>
        </div>
      </div>
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="cnFlip">Flip</button>
      <button class="btn btn-block hidden" id="cnCash">Cashout</button>
      <div class="stat-grid">
        <div class="stat"><span class="stat-label">Multiplier</span><span class="stat-value" id="cnMult">1.00×</span></div>
        <div class="stat"><span class="stat-label">Streak</span><span class="stat-value" id="cnStreak">0</span></div>
      </div>
    `, `<div class="coin" id="cnCoin"><span id="cnFace">?</span></div>
        <div class="crash-status" id="cnStatus">Pick a side and flip</div>`, 'coin-stage');

    const betInput = container.querySelector('#cnBet');
    const flip = container.querySelector('#cnFlip');
    const cash = container.querySelector('#cnCash');
    const coin = container.querySelector('#cnCoin');
    const face = container.querySelector('#cnFace');
    const statusEl = container.querySelector('#cnStatus');
    const multEl = container.querySelector('#cnMult');
    const streakEl = container.querySelector('#cnStreak');
    const sideBtns = container.querySelectorAll('#cnSide button');
    let side = 'heads', roundId = null, bet = 0, busy = false, alive = true, streak = 0;
    GameKit.wireBet(container, betInput);
    sideBtns.forEach(b => b.addEventListener('click', () => { if (busy) return; sideBtns.forEach(x => x.classList.remove('active')); b.classList.add('active'); side = b.dataset.side; }));

    function endRound() { roundId = null; busy = false; cash.classList.add('hidden'); flip.textContent = 'Flip'; betInput.disabled = false; }

    async function doFlip() {
      if (busy) return;
      busy = true; flip.disabled = true;
      try {
        if (!roundId) {
          bet = GameKit.bet(betInput);
          if (bet == null) { busy = false; flip.disabled = false; return; }
          const s = await API.coinStart({ bet });
          Bankroll.set(s.balance); roundId = s.roundId; streak = 0; betInput.disabled = true;
          multEl.textContent = '1.00×'; streakEl.textContent = '0';
        }
        coin.classList.add('spin');
        const res = await API.coinFlip({ roundId, side });
        Fair.bumpNonce();
        setTimeout(() => {
          if (!alive) return;
          coin.classList.remove('spin');
          face.textContent = res.outcome === 'heads' ? 'H' : 'T';
          if (!res.win) {
            Bankroll.set(res.balance);
            Feed.recordPlayerBet({ game: 'coin', bet, mult: 0, win: false, payout: 0 });
            Toast.loss(`−${Bankroll.fmt(bet)}`);
            statusEl.textContent = `${res.outcome} — busted on streak ${res.flips}`;
            endRound(); flip.disabled = false; return;
          }
          streak = res.flips; streakEl.textContent = streak;
          multEl.textContent = res.mult.toFixed(2) + '×';
          cash.classList.remove('hidden'); cash.textContent = `Cashout — ${Bankroll.fmt(res.cashout)}`;
          flip.textContent = 'Flip Again';
          statusEl.textContent = `${res.outcome}! Streak ${streak} — flip again or cash out`;
          busy = false; flip.disabled = false;
        }, 500);
      } catch (e) { coin.classList.remove('spin'); Toast.error(e.message); busy = false; flip.disabled = false; }
    }
    async function cashout() {
      if (busy || !roundId) return;
      busy = true;
      try {
        const res = await API.coinCashout({ roundId });
        Bankroll.set(res.balance);
        Feed.recordPlayerBet({ game: 'coin', bet, mult: res.mult, win: true, payout: res.payout });
        Toast.win(`+${Bankroll.fmt(res.payout - bet)} @ ${res.mult.toFixed(2)}×`);
        statusEl.textContent = `Cashed out ${res.mult.toFixed(2)}×`;
        endRound();
      } catch (e) { Toast.error(e.message); busy = false; }
    }
    flip.addEventListener('click', doFlip);
    cash.addEventListener('click', cashout);
    return function () { alive = false; };
  }
  global.Games = global.Games || {};
  global.Games.coin = mount;
})(window);
