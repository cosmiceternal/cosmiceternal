/* Blackjack — hit, stand, or double against the dealer (stands on 17). */
(function (global) {
  'use strict';
  const OUTCOME = { blackjack: 'Blackjack!', win: 'You win', dealer_bust: 'Dealer busts — you win', push: 'Push', bust: 'Bust', lose: 'Dealer wins', dealer_bj: 'Dealer blackjack' };
  function value(cards) {
    let total = 0, aces = 0;
    cards.forEach(c => { const v = c.rank === 1 ? 11 : Math.min(10, c.rank); total += v; if (c.rank === 1) aces++; });
    while (total > 21 && aces > 0) { total -= 10; aces--; }
    return total;
  }
  function mount(container) {
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('bjBet')}
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="bjDeal">Deal</button>
      <div class="row hidden" id="bjActions">
        <button class="btn btn-primary" id="bjHit" style="flex:1">Hit</button>
        <button class="btn" id="bjStand" style="flex:1">Stand</button>
        <button class="btn" id="bjDouble" style="flex:1">Double</button>
      </div>
      <p class="muted" style="font-size:11px;line-height:1.5;margin:0;">Blackjack pays 3:2. Dealer stands on all 17s. Double on your first two cards.</p>
    `, `<div class="bj-area">
          <div class="bj-side"><div class="bj-label">Dealer <span id="bjDV"></span></div><div class="cards-row" id="bjDealer"></div></div>
          <div class="bj-side"><div class="bj-label">You <span id="bjPV"></span></div><div class="cards-row" id="bjPlayer"></div></div>
        </div>
        <div class="crash-status" id="bjStatus">Deal to begin</div>`, 'bj-stage');

    const betInput = container.querySelector('#bjBet');
    const deal = container.querySelector('#bjDeal');
    const actions = container.querySelector('#bjActions');
    const hitBtn = container.querySelector('#bjHit');
    const standBtn = container.querySelector('#bjStand');
    const dblBtn = container.querySelector('#bjDouble');
    const dealerEl = container.querySelector('#bjDealer');
    const playerEl = container.querySelector('#bjPlayer');
    const dvEl = container.querySelector('#bjDV');
    const pvEl = container.querySelector('#bjPV');
    const statusEl = container.querySelector('#bjStatus');
    let roundId = null, bet = 0, stake = 0, busy = false, alive = true;
    GameKit.wireBet(container, betInput);

    function renderPlayer(cards) { playerEl.innerHTML = cards.map(c => GameKit.cardHTML(c)).join(''); pvEl.textContent = value(cards); }
    function renderDealer(cards, hideHole) {
      if (hideHole) { dealerEl.innerHTML = GameKit.cardHTML(cards[0]) + GameKit.cardHTML(null, true); dvEl.textContent = value([cards[0]]) + ' +'; }
      else { dealerEl.innerHTML = cards.map(c => GameKit.cardHTML(c)).join(''); dvEl.textContent = value(cards); }
    }
    function showActions(canDouble) { actions.classList.remove('hidden'); dblBtn.style.display = canDouble ? '' : 'none'; }
    function endRound(res, outcome) {
      roundId = null; busy = false;
      actions.classList.add('hidden'); deal.classList.remove('hidden'); deal.disabled = false; betInput.disabled = false;
      const win = res.payout > stake + 1e-9, push = Math.abs(res.payout - stake) < 1e-9;
      Bankroll.set(res.balance);
      Feed.recordPlayerBet({ game: 'blackjack', bet: stake, mult: win ? res.payout / stake : 0, win, payout: res.payout, profit: res.payout - stake });
      if (win) Toast.win(`${OUTCOME[outcome]} — +${Bankroll.fmt(res.payout - stake)}`);
      else if (push) Toast.info('Push — bet returned');
      else Toast.loss(`${OUTCOME[outcome]} — −${Bankroll.fmt(stake)}`);
      statusEl.textContent = OUTCOME[outcome] || outcome;
    }

    async function start() {
      if (busy || roundId) return;
      bet = GameKit.bet(betInput);
      if (bet == null) return;
      busy = true; deal.disabled = true;
      try {
        const res = await API.bjStart({ bet });
        Fair.bumpNonce(); stake = bet;
        renderPlayer(res.player);
        if (res.done) { renderDealer(res.dealer, false); deal.classList.remove('hidden'); endRound(res, res.outcome); return; }
        roundId = res.roundId; betInput.disabled = true;
        renderDealer([res.dealerUp], true);
        deal.classList.add('hidden'); showActions(res.canDouble);
        statusEl.textContent = 'Hit, stand, or double';
        busy = false;
      } catch (e) { Toast.error(e.message); busy = false; deal.disabled = false; }
    }
    async function act(fn, allowDoubleAfter) {
      if (busy || !roundId) return;
      busy = true; actions.classList.add('hidden');
      try {
        const res = await fn();
        renderPlayer(res.player);
        if (res.done) { renderDealer(res.dealer, false); endRound(res, res.outcome); return; }
        showActions(false); statusEl.textContent = `You have ${res.total} — hit or stand`;
        busy = false;
      } catch (e) { Toast.error(e.message); showActions(false); busy = false; }
    }
    deal.addEventListener('click', start);
    hitBtn.addEventListener('click', () => act(() => API.bjHit({ roundId })));
    standBtn.addEventListener('click', () => act(() => API.bjStand({ roundId })));
    dblBtn.addEventListener('click', () => { stake = bet * 2; act(() => API.bjDouble({ roundId })); });
    return function () { alive = false; };
  }
  global.Games = global.Games || {};
  global.Games.blackjack = mount;
})(window);
