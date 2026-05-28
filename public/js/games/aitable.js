/* AI Blackjack Table — the headline "live table" mode.
 *
 * YOUR hand is the real, provably-fair blackjack game (reuses /api/play/blackjack/*,
 * settled on the server). Seated around you are SIMULATED AI table-mates: each has a
 * name, play style and reactive chat. Their hands are cosmetic (client-side, no real
 * stake) and exist purely for table atmosphere — they are clearly badged "AI" and
 * never affect your odds or balance. This is honest social flavor, not fake humans. */
(function (global) {
  'use strict';

  const PERSONAS = [
    { name: 'Nova',   emoji: '🦊', style: 'aggressive', color: '#ff8a65' },
    { name: 'Bishop', emoji: '🎩', style: 'cautious',   color: '#80d8ff' },
    { name: 'Echo',   emoji: '👾', style: 'wildcard',   color: '#b39ddb' },
    { name: 'Ruby',   emoji: '💎', style: 'aggressive', color: '#f48fb1' },
    { name: 'Sage',   emoji: '🦉', style: 'cautious',   color: '#80cbc4' },
    { name: 'Blitz',  emoji: '⚡', style: 'wildcard',   color: '#ffd54f' }
  ];
  const LINES = {
    deal: {
      aggressive: ['Let’s run it up 😤', 'Big bet, big energy.', 'No fear at this table.', 'Press it.'],
      cautious:   ['Playing it tight.', 'Small and steady.', 'Patience pays.', 'Let’s see the cards…'],
      wildcard:   ['Feeling chaotic today 🎲', 'Trust the vibes.', 'Who needs strategy?', 'YOLO seat checking in.']
    },
    win:  ['That’s what I’m talking about! 🔥', 'Easy money.', 'Called it.', 'Booked it. 💰', 'Heater continues 🌶️'],
    lose: ['Ugh, dealer’s rigged 😅', 'One more, one more.', 'I had a read…', 'Pain.', 'Shake it off.'],
    push: ['Push. Snooze.', 'Money back, fine by me.', 'Stalemate.'],
    bust: ['Too greedy 💀', 'One card too many!', 'Why did I hit??'],
    bj:   ['BLACKJACK baby! 🃏', 'Naturals only 😎', 'Twenty-one, thank you.'],
    playerWin: ['Nice hand, neighbor 👏', 'Carry us!', 'Respect.'],
    playerBust:['Oof, tough one.', 'Happens to the best.', 'Next one’s yours.']
  };
  const pick = a => a[Math.floor(Math.random() * a.length)];

  function randCard() { return { rank: 1 + Math.floor(Math.random() * 13), suit: Math.floor(Math.random() * 4) }; }
  function total(cards) {
    let t = 0, aces = 0;
    cards.forEach(c => { const v = c.rank === 1 ? 11 : Math.min(10, c.rank); t += v; if (c.rank === 1) aces++; });
    while (t > 21 && aces > 0) { t -= 10; aces--; }
    return t;
  }
  function aiThreshold(style) { return style === 'cautious' ? 15 : style === 'aggressive' ? 17 : 14 + Math.floor(Math.random() * 5); }

  function mount(container) {
    const seats = PERSONAS.slice().sort(() => Math.random() - 0.5).slice(0, 3)
      .map(p => ({ ...p, bankroll: 500 + Math.floor(Math.random() * 4000), cards: [], bet: 0, result: null }));

    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('atBet')}
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="atDeal">Deal</button>
      <div class="row hidden" id="atActions">
        <button class="btn btn-primary" id="atHit" style="flex:1">Hit</button>
        <button class="btn" id="atStand" style="flex:1">Stand</button>
        <button class="btn" id="atDouble" style="flex:1">Double</button>
      </div>
      <div class="ai-note">🤖 <b>AI players</b> are simulated table-mates (their own styles &amp; chatter) for atmosphere. Only <b>your</b> hand is a real, provably-fair bet.</div>
      <div class="ai-chat" id="atChat"></div>
    `, `<div class="at-dealer"><div class="bj-label">Dealer <span id="atDV"></span></div><div class="cards-row" id="atDealer"></div></div>
        <div class="at-seats" id="atSeats"></div>
        <div class="crash-status" id="atStatus">Take your seat and deal</div>`, 'aitable-stage');

    const betInput = container.querySelector('#atBet');
    const deal = container.querySelector('#atDeal');
    const actions = container.querySelector('#atActions');
    const hitBtn = container.querySelector('#atHit');
    const standBtn = container.querySelector('#atStand');
    const dblBtn = container.querySelector('#atDouble');
    const dealerEl = container.querySelector('#atDealer');
    const dvEl = container.querySelector('#atDV');
    const seatsEl = container.querySelector('#atSeats');
    const statusEl = container.querySelector('#atStatus');
    const chatEl = container.querySelector('#atChat');
    let roundId = null, bet = 0, stake = 0, busy = false, alive = true;
    GameKit.wireBet(container, betInput);

    function chat(who, text, color) {
      const line = document.createElement('div');
      line.className = 'ai-line';
      line.innerHTML = `<span class="ai-who" style="color:${color || 'var(--muted)'}">${who}</span> ${text}`;
      chatEl.prepend(line);
      while (chatEl.children.length > 10) chatEl.lastChild.remove();
    }

    function renderSeats(showCards) {
      seatsEl.innerHTML = seats.map((s, i) => `
        <div class="at-seat ${s.result || ''}" data-i="${i}">
          <div class="at-avatar" style="border-color:${s.color}">${s.emoji}<span class="ai-badge">AI</span></div>
          <div class="at-name" style="color:${s.color}">${s.name}</div>
          <div class="at-cards">${showCards ? s.cards.map(c => GameKit.cardHTML(c)).join('') : ''}</div>
          <div class="at-meta">${s.bet ? Bankroll.fmt(s.bet) : ''}${showCards && s.cards.length ? ' · ' + total(s.cards) : ''}</div>
        </div>`).join('') + `
        <div class="at-seat you">
          <div class="at-avatar you-av">🧑<span class="ai-badge you-badge">YOU</span></div>
          <div class="at-name accent">You <span id="atPV"></span></div>
          <div class="cards-row at-cards" id="atPlayer"></div>
        </div>`;
    }

    function dealAiCosmetic() {
      seats.forEach(s => {
        s.cards = [randCard(), randCard()];
        s.result = null;
        const sizes = { aggressive: [50, 500], cautious: [10, 80], wildcard: [5, 800] };
        const [lo, hi] = sizes[s.style];
        s.bet = Math.min(s.bankroll, lo + Math.floor(Math.random() * (hi - lo)));
        chat(s.name, pick(LINES.deal[s.style]), s.color);
      });
    }
    function settleAi(dealerTotal, dealerBust) {
      seats.forEach(s => {
        const thr = aiThreshold(s.style);
        while (total(s.cards) < thr && total(s.cards) < 21) s.cards.push(randCard());
        const t = total(s.cards);
        let res;
        if (t > 21) res = 'loss';
        else if (dealerBust || t > dealerTotal) res = 'win';
        else if (t < dealerTotal) res = 'loss';
        else res = 'push';
        s.result = res;
        if (res === 'win') { s.bankroll += s.bet; chat(s.name, t === 21 && s.cards.length === 2 ? pick(LINES.bj) : pick(LINES.win), s.color); }
        else if (res === 'loss') { s.bankroll = Math.max(0, s.bankroll - s.bet); chat(s.name, t > 21 ? pick(LINES.bust) : pick(LINES.lose), s.color); }
        else chat(s.name, pick(LINES.push), s.color);
      });
    }
    function reactToPlayer(outcome) {
      const s = seats[Math.floor(Math.random() * seats.length)];
      if (['win', 'dealer_bust', 'blackjack'].includes(outcome)) chat(s.name, pick(LINES.playerWin), s.color);
      else if (outcome === 'bust') chat(s.name, pick(LINES.playerBust), s.color);
    }

    function renderPlayer(cards) { const el = container.querySelector('#atPlayer'); if (el) el.innerHTML = cards.map(c => GameKit.cardHTML(c)).join(''); const pv = container.querySelector('#atPV'); if (pv) pv.textContent = total(cards); }
    function renderDealer(cards, hideHole) {
      if (hideHole) { dealerEl.innerHTML = GameKit.cardHTML(cards[0]) + GameKit.cardHTML(null, true); dvEl.textContent = total([cards[0]]) + ' +'; }
      else { dealerEl.innerHTML = cards.map(c => GameKit.cardHTML(c)).join(''); dvEl.textContent = total(cards); }
    }
    function showActions(canDouble) { actions.classList.remove('hidden'); dblBtn.style.display = canDouble ? '' : 'none'; }

    function finish(res, outcome, dealerCards) {
      roundId = null; busy = false;
      actions.classList.add('hidden'); deal.classList.remove('hidden'); deal.disabled = false; betInput.disabled = false;
      const dealerTotal = total(dealerCards), dealerBust = dealerTotal > 21;
      settleAi(dealerTotal, dealerBust);
      reactToPlayer(outcome);
      renderSeats(true); renderPlayer(res.player);
      const win = res.payout > stake + 1e-9, push = Math.abs(res.payout - stake) < 1e-9;
      Bankroll.set(res.balance);
      Feed.recordPlayerBet({ game: 'blackjack', bet: stake, mult: win ? res.payout / stake : 0, win, payout: res.payout });
      const NAMES = { blackjack: 'Blackjack!', win: 'You win', dealer_bust: 'Dealer busts — you win', push: 'Push', bust: 'Bust', lose: 'Dealer wins', dealer_bj: 'Dealer blackjack' };
      if (win) Toast.win(`${NAMES[outcome]} — +${Bankroll.fmt(res.payout - stake)}`);
      else if (push) Toast.info('Push — bet returned');
      else Toast.loss(`${NAMES[outcome]} — −${Bankroll.fmt(stake)}`);
      statusEl.textContent = NAMES[outcome] || outcome;
    }

    async function start() {
      if (busy || roundId) return;
      bet = GameKit.bet(betInput);
      if (bet == null) return;
      busy = true; deal.disabled = true;
      dealAiCosmetic();
      renderSeats(true);
      try {
        const res = await API.bjStart({ bet });
        Fair.bumpNonce(); stake = bet;
        renderPlayer(res.player);
        if (res.done) { renderDealer(res.dealer, false); finish(res, res.outcome, res.dealer); return; }
        roundId = res.roundId; betInput.disabled = true;
        renderDealer([res.dealerUp], true);
        deal.classList.add('hidden'); showActions(res.canDouble);
        statusEl.textContent = 'Your move — hit, stand, or double';
        busy = false;
      } catch (e) { Toast.error(e.message); busy = false; deal.disabled = false; }
    }
    async function act(fn) {
      if (busy || !roundId) return;
      busy = true; actions.classList.add('hidden');
      try {
        const res = await fn();
        renderPlayer(res.player);
        if (res.done) { renderDealer(res.dealer, false); finish(res, res.outcome, res.dealer); return; }
        showActions(false); statusEl.textContent = `You have ${res.total} — hit or stand`;
        busy = false;
      } catch (e) { Toast.error(e.message); showActions(false); busy = false; }
    }

    renderSeats(false);
    chat('Dealer', 'Welcome to the table. Place your bet 🂡', 'var(--gold)');
    deal.addEventListener('click', start);
    hitBtn.addEventListener('click', () => act(() => API.bjHit({ roundId })));
    standBtn.addEventListener('click', () => act(() => API.bjStand({ roundId })));
    dblBtn.addEventListener('click', () => { stake = bet * 2; act(() => API.bjDouble({ roundId })); });
    return function () { alive = false; };
  }
  global.Games = global.Games || {};
  global.Games.aitable = mount;
})(window);
