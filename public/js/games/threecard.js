/* Three Card Poker — ante + play vs the dealer. Dealer needs Queen-high to
 * qualify; ante bonus pays on a straight or better no matter what. */
(function (global) {
  'use strict';
  const HAND_NAMES = {
    high: 'High card', pair: 'Pair', flush: 'Flush',
    straight: 'Straight', trips: 'Three of a kind', straightFlush: 'Straight flush'
  };

  function mount(container) {
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('tcpBet')}
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="tcpDeal">Deal (Ante)</button>
      <div class="row hidden" id="tcpActions">
        <button class="btn btn-primary" id="tcpPlay" style="flex:1">Play (2× total)</button>
        <button class="btn" id="tcpFold" style="flex:1">Fold</button>
      </div>
      <div class="stat-grid">
        <div class="stat"><span class="stat-label">Your Hand</span><span class="stat-value" id="tcpHand">—</span></div>
        <div class="stat"><span class="stat-label">Bonus</span><span class="stat-value" id="tcpBonus">—</span></div>
      </div>
      <p class="muted" style="font-size:11px;line-height:1.5;margin:0;">Dealer qualifies with Queen-high. If they don't, your ante wins and the Play bet pushes. Ante bonus: straight +1×, trips +4×, straight flush +5× — even if the dealer wins.</p>
    `, `<div class="tcp-table">
          <div class="tcp-side">
            <div class="bj-label">Dealer <span id="tcpDealerHand"></span></div>
            <div class="cards-row" id="tcpDealer"></div>
          </div>
          <div class="tcp-side">
            <div class="bj-label">You <span id="tcpPlayerHand"></span></div>
            <div class="cards-row" id="tcpPlayer"></div>
          </div>
        </div>
        <div class="crash-status" id="tcpStatus">Ante up and deal.</div>`, 'tcp-stage');

    const betInput = container.querySelector('#tcpBet');
    const dealBtn = container.querySelector('#tcpDeal');
    const actions = container.querySelector('#tcpActions');
    const playBtn = container.querySelector('#tcpPlay');
    const foldBtn = container.querySelector('#tcpFold');
    const playerEl = container.querySelector('#tcpPlayer');
    const dealerEl = container.querySelector('#tcpDealer');
    const playerHandEl = container.querySelector('#tcpPlayerHand');
    const dealerHandEl = container.querySelector('#tcpDealerHand');
    const handEl = container.querySelector('#tcpHand');
    const bonusEl = container.querySelector('#tcpBonus');
    const statusEl = container.querySelector('#tcpStatus');
    let roundId = null, busy = false, ante = 0;
    GameKit.wireBet(container, betInput);

    function idle() {
      roundId = null; busy = false;
      actions.classList.add('hidden');
      dealBtn.classList.remove('hidden');
      dealBtn.disabled = false;
      betInput.disabled = false;
    }
    function showDealer(cards) { dealerEl.innerHTML = cards.map(c => GameKit.cardHTML(c)).join(''); }
    function hideDealer()      { dealerEl.innerHTML = [0,1,2].map(() => GameKit.cardHTML(null, true)).join(''); }

    dealBtn.addEventListener('click', async () => {
      if (busy || roundId) return;
      const b = GameKit.bet(betInput);
      if (b == null) return;
      // Warn early if they can't afford the Play bet that Play would add.
      if (!Bankroll.canAfford(b * 2)) { Toast.warn('Keep enough for the Play bet (2× ante total).'); return; }
      busy = true; dealBtn.disabled = true; ante = b;
      try {
        const res = await API.tcpStart({ bet: b });
        Fair.bumpNonce();
        Bankroll.set(res.balance);
        roundId = res.roundId;
        playerEl.innerHTML = res.player.map(c => GameKit.cardHTML(c)).join('');
        hideDealer();
        playerHandEl.textContent = ''; dealerHandEl.textContent = '';
        handEl.textContent = '—'; bonusEl.textContent = '—';
        dealBtn.classList.add('hidden');
        actions.classList.remove('hidden');
        betInput.disabled = true;
        statusEl.textContent = 'Play or fold?';
        busy = false;
      } catch (e) { Toast.error(e.message); idle(); }
    });

    async function act(action) {
      if (busy || !roundId) return;
      busy = true;
      try {
        const res = await API.tcpAct({ roundId, action });
        showDealer(res.dealer);
        playerHandEl.textContent = HAND_NAMES[res.playerHand] || '';
        dealerHandEl.textContent = HAND_NAMES[res.dealerHand] || '';
        handEl.textContent = HAND_NAMES[res.playerHand] || '—';
        bonusEl.textContent = res.bonus > 0 ? '+' + Bankroll.fmt(res.bonus) : '—';
        Bankroll.set(res.balance);
        if (res.folded) {
          statusEl.textContent = 'Folded — ante forfeited.';
          Feed.recordPlayerBet({ game: 'tcp', bet: ante, mult: 0, win: false, payout: 0 });
          Toast.loss(`−${Bankroll.fmt(ante)}`);
        } else {
          const staked = ante * 2;
          const NAMES = {
            win: 'You beat the dealer!',
            lose: 'Dealer wins.',
            push: 'Push — bets returned.',
            dealer_no_qualify: "Dealer doesn't qualify — ante pays, Play pushes."
          };
          statusEl.textContent = NAMES[res.outcome] || res.outcome;
          const win = res.payout > staked + 1e-9;
          Feed.recordPlayerBet({ game: 'tcp', bet: staked, mult: win ? res.mult : 0, win, payout: res.payout, profit: res.payout - staked });
          if (win) Toast.win(`+${Bankroll.fmt(res.payout - staked)} @ ${res.mult.toFixed(2)}×`);
          else if (Math.abs(res.payout - staked) < 1e-9) Toast.info('Push — bets returned.');
          else Toast.loss(`−${Bankroll.fmt(staked - res.payout)}`);
          if (res.mult >= 5 && global.Confetti) Confetti.burst({ count: 100 });
        }
        idle();
      } catch (e) { Toast.error(e.message); busy = false; }
    }
    playBtn.addEventListener('click', () => act('play'));
    foldBtn.addEventListener('click', () => act('fold'));

    hideDealer();
    return function () {};
  }
  global.Games = global.Games || {};
  global.Games.threecard = mount;
})(window);
