/* AI Dealer — your real, provably-fair Blackjack hand hosted by a personable AI
 * croupier. Pick a dealer; they greet you, narrate every deal/hit/stand, and
 * react to wins, busts and pushes in character.
 *
 * Honest design: the dealer is a SCRIPTED PERSONA (no LLM) — clearly labeled as
 * such. Reuses /api/play/blackjack/* so outcomes are 100% server-decided and
 * provably fair. The dealer is pure atmosphere; they never affect the math. */
(function (global) {
  'use strict';

  const DEALERS = [
    {
      id: 'vivienne', name: 'Vivienne', img: 'img/dealers/vivienne.svg', color: '#f48fb1',
      bio: 'Smooth, unflappable',
      lines: {
        greet:      ['Welcome, darling.', 'Take a seat — fortune favors the bold.', 'Pleasure to deal for you tonight.'],
        bet:        ['Place your bet, please.', 'When you’re ready.', 'No rush.'],
        deal:       ['Cards on the felt.', 'Two for you, one up for me.', 'And we’re off.'],
        hit:        ['A bold choice.', 'Another card incoming.', 'Pushing your luck — I like it.'],
        stand:      ['You stand on {t}. Wise.', 'Holding at {t} — let me work.', 'A measured move.'],
        dbl:        ['Doubling. Confident.', 'Doubling down — bold.'],
        playerBJ:   ['Blackjack. Beautifully played. 🎯', 'A natural — congratulations.'],
        playerWin:  ['You win. Well done.', 'The house bows to you.'],
        playerLose: ['House takes it. Better luck next hand.', 'Almost. So close.'],
        push:       ['Push. The cards know no master tonight.', 'A draw. Bet returned.'],
        bust:       ['Bust. The cards have spoken.', '{t} — tough break.'],
        dealerBust: ['I bust. Pay the player.', '{t} on my side. Your hand.']
      }
    },
    {
      id: 'rocco', name: 'Rocco', img: 'img/dealers/rocco.svg', color: '#ff8a65',
      bio: 'Old-school, gruff but fair',
      lines: {
        greet:      ['Sit. Let’s play cards.', 'Money up.', 'Hope you brought your luck.'],
        bet:        ['Bet, pal.', 'C’mon, place it.', 'I ain’t got all night.'],
        deal:       ['Dealing.', 'Here.', 'Two and one. Get to it.'],
        hit:        ['Another?', 'You sure?', 'Brave.'],
        stand:      ['Standing on {t}, eh?', 'Locked in. My turn.', 'Alright then.'],
        dbl:        ['Doubling — bold move.', 'Twice the bet, twice the heart.'],
        playerBJ:   ['Blackjack! Ya killer.', 'Natural twenty-one. Big swing.'],
        playerWin:  ['Ya got me.', 'Pay the man.'],
        playerLose: ['House wins.', 'Tough break, kid.'],
        push:       ['Push. Splits even.'],
        bust:       ['Busted. Tough.', '{t}. Done.'],
        dealerBust: ['I busted. Pay up.', 'Whoops. You win this one.']
      }
    },
    {
      id: 'luna', name: 'Luna', img: 'img/dealers/luna.svg', color: '#80d8ff',
      bio: 'Cheerful and chatty',
      lines: {
        greet:      ['Hi there! Ready to win some?', 'Yay, a player! Let’s go!', 'Hope you brought good vibes ✨'],
        bet:        ['Bet whenever you’re ready!', 'No pressure, take your time!'],
        deal:       ['Here come the cards! 🎴', 'Dealing dealing dealing!', 'Lookin’ good already!'],
        hit:        ['Hitting — brave!', 'Card incoming~', 'You got this!'],
        stand:      ['Standing on {t}, smart!', 'Locking it in!', 'Okay — my turn to sweat!'],
        dbl:        ['Double down energy! 💪', 'Big moves only!'],
        playerBJ:   ['BLACKJACK 🎉🎉', 'Natural 21! Amazing!'],
        playerWin:  ['You win! Yayyy 🎉', 'Nice nice nice!'],
        playerLose: ['Aww, house wins this one.', 'So close! Next one for sure!'],
        push:       ['Push! Tie game ⚖️'],
        bust:       ['Oh no, busted! 😬', '{t} — one too many.'],
        dealerBust: ['I bust! You win! 🎊', 'Oopsie, paying out!']
      }
    },
    {
      id: 'kade', name: 'Kade', img: 'img/dealers/kade.svg', color: '#b39ddb',
      bio: 'Cool, dry, a little mysterious',
      lines: {
        greet:      ['Welcome.', 'A player. Interesting.', 'The cards have been waiting.'],
        bet:        ['Your move.', 'Whenever.', 'The stake.'],
        deal:       ['And so it begins.', 'Two and one.', 'The hand is set.'],
        hit:        ['Another card. Curious.', 'You want more. So be it.', 'Bold.'],
        stand:      ['You stand on {t}. Acceptable.', 'Holding. Perhaps wise.', 'A finished thought.'],
        dbl:        ['Doubling. The stakes rise.', 'A statement.'],
        playerBJ:   ['Twenty-one. A clean read.', 'Natural. The fates align.'],
        playerWin:  ['Your hand. This time.', 'The cards favor you.'],
        playerLose: ['The house claims it.', 'Not this round.'],
        push:       ['A draw. Neither wins.'],
        bust:       ['{t}. The thread snaps.', 'Too far.'],
        dealerBust: ['I exceed. Your hand.', 'The fates flip. You win.']
      }
    }
  ];
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => vars[k] != null ? vars[k] : '');

  function value(cards) {
    let t = 0, aces = 0;
    cards.forEach(c => { const v = c.rank === 1 ? 11 : Math.min(10, c.rank); t += v; if (c.rank === 1) aces++; });
    while (t > 21 && aces > 0) { t -= 10; aces--; }
    return t;
  }
  function outcomeKey(outcome) {
    if (outcome === 'blackjack') return 'playerBJ';
    if (outcome === 'win' || outcome === 'dealer_bust') return outcome === 'dealer_bust' ? 'dealerBust' : 'playerWin';
    if (outcome === 'push') return 'push';
    if (outcome === 'bust') return 'bust';
    return 'playerLose'; // 'lose', 'dealer_bj'
  }

  function mount(container) {
    let dealer = DEALERS[Math.floor(Math.random() * DEALERS.length)];

    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('adBet')}
      <div class="field">
        <label>Your Dealer</label>
        <div class="ad-picker-chips" id="adPicker">
          ${DEALERS.map(d => `
            <button type="button" class="ad-chip" data-dealer="${d.id}" style="--chip-accent:${d.color}">
              <img class="ad-chip-portrait" src="${d.img}" alt="${d.name}" />
              <span class="ad-chip-body">
                <span class="ad-chip-name">${d.name}</span>
                <span class="ad-chip-bio">${d.bio}</span>
              </span>
            </button>`).join('')}
        </div>
      </div>
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="adDeal">Deal</button>
      <div class="row hidden" id="adActions">
        <button class="btn btn-primary" id="adHit" style="flex:1">Hit</button>
        <button class="btn" id="adStand" style="flex:1">Stand</button>
        <button class="btn" id="adDouble" style="flex:1">Double</button>
      </div>
      <div class="ai-note">🎰 The dealer is a <b>scripted AI persona</b> — voice and reactions only. The game itself is the same <b>provably-fair</b> Blackjack: every card is server-decided and verifiable. Pays 3:2 on blackjack, dealer stands on all 17s.</div>
      <div class="ad-log" id="adLog"></div>
    `, `<div class="ad-dealer">
          <div class="ad-avatar" id="adAvatar" style="border-color:${dealer.color}">
            <img class="ad-portrait" id="adPortrait" src="${dealer.img}" alt="${dealer.name}" />
            <span class="ai-badge">AI</span>
          </div>
          <div class="ad-info">
            <div class="ad-name" id="adName" style="color:${dealer.color}">${dealer.name}</div>
            <div class="ad-bubble" id="adBubble">Welcome to the table.</div>
          </div>
        </div>
        <div class="ad-felt">
          <div class="ad-side">
            <div class="bj-label">Dealer <span id="adDV"></span></div>
            <div class="cards-row" id="adDealer"></div>
          </div>
          <div class="ad-side">
            <div class="bj-label">You <span id="adPV"></span></div>
            <div class="cards-row" id="adPlayer"></div>
          </div>
        </div>
        <div class="crash-status" id="adStatus">Pick your dealer and deal</div>`, 'aidealer-stage');

    const betInput = container.querySelector('#adBet');
    const picker = container.querySelector('#adPicker');
    // Custom picker API so the rest of this file reads like a native form
    // control: setValue(id), setDisabled(bool), on('change', fn).
    const chips = () => picker.querySelectorAll('.ad-chip');
    picker.setValue = (id) => chips().forEach(c => c.classList.toggle('active', c.dataset.dealer === id));
    picker.setDisabled = (b) => { picker.classList.toggle('locked', !!b); chips().forEach(c => c.disabled = !!b); };
    picker.getValue = () => (picker.querySelector('.ad-chip.active') || {}).dataset?.dealer;
    const deal = container.querySelector('#adDeal');
    const actions = container.querySelector('#adActions');
    const hitBtn = container.querySelector('#adHit');
    const standBtn = container.querySelector('#adStand');
    const dblBtn = container.querySelector('#adDouble');
    const avatar = container.querySelector('#adAvatar');
    const nameEl = container.querySelector('#adName');
    const bubble = container.querySelector('#adBubble');
    const dealerEl = container.querySelector('#adDealer');
    const playerEl = container.querySelector('#adPlayer');
    const dvEl = container.querySelector('#adDV');
    const pvEl = container.querySelector('#adPV');
    const statusEl = container.querySelector('#adStatus');
    const logEl = container.querySelector('#adLog');
    let roundId = null, bet = 0, stake = 0, busy = false, alive = true, inflight = null;
    let sayGen = 0;       // monotonic counter — defends every .then() callback from being applied after a later say() supersedes it.
    let portraitLoader = null; // pending Image() preload so unmount can null its onload.
    playerEl.dataset.cards = '[]'; // initialise so a fast-fired act() can't read undefined.
    GameKit.wireBet(container, betInput);

    function showBubble(text, ai) {
      bubble.classList.remove('show'); void bubble.offsetWidth;
      bubble.textContent = text; bubble.classList.add('show');
      bubble.classList.toggle('ai-live', !!ai);
    }
    // Capture dealer-at-the-time-of-say so the entry doesn't get re-coloured if
    // the player swaps dealers mid-request.
    function entryHTML(text, ai, who) {
      const pill = ai ? ` <span class="ai-pill">LIVE</span>` : '';
      return `<span class="ai-who" style="color:${who.color}">${who.name}</span> ${text}${pill}`;
    }
    // Show a scripted line instantly (no perceived latency), then try the live
    // AI endpoint in the background and silently upgrade if it returns in time.
    function say(key, vars) {
      const lines = dealer.lines[key]; if (!lines) return;
      const scripted = fill(pick(lines), vars || {});
      showBubble(scripted, false);
      const who = dealer;          // freeze persona reference for this entry
      const myGen = ++sayGen;      // generation token: stale callbacks bail.
      const entry = document.createElement('div');
      entry.className = 'ai-line';
      entry.innerHTML = entryHTML(scripted, false, who);
      logEl.prepend(entry);
      while (logEl.children.length > 12) logEl.lastChild.remove();

      if (inflight) { inflight.abort(); inflight = null; }
      const ac = new AbortController(); inflight = ac;
      API.dealerLine({ dealer: who.id, event: key, ctx: vars || {} }, { signal: ac.signal })
        .then(r => {
          // Three guards: unmounted, this controller aborted, or a later say()
          // already superseded us (sayGen has moved on). Any one => bail.
          if (!alive || ac.signal.aborted || myGen !== sayGen) return;
          if (r && r.line && (r.source === 'ai' || r.source === 'cache')) {
            showBubble(r.line, true);
            entry.innerHTML = entryHTML(r.line, true, who);
          }
        })
        .catch(() => { /* silently fall back to the scripted line */ })
        .finally(() => { if (inflight === ac) inflight = null; });
    }
    function repaintDealer() {
      picker.setValue(dealer.id);
      avatar.style.borderColor = dealer.color;
      nameEl.style.color = dealer.color;
      nameEl.textContent = dealer.name;
      // Preload the new portrait before swapping `src`, so the 84px circle never
      // briefly shows a broken-image placeholder on slow connections / cache miss.
      const portrait = avatar.querySelector('.ad-portrait');
      const target = dealer.img;
      if (portraitLoader) portraitLoader.onload = null;
      const loader = new Image();
      portraitLoader = loader;
      loader.onload = () => {
        if (!alive || portraitLoader !== loader) return;
        portrait.src = target;
        portrait.alt = dealer.name;
        portraitLoader = null;
      };
      loader.onerror = () => { if (portraitLoader === loader) portraitLoader = null; };
      loader.src = target;
    }
    picker.addEventListener('click', (e) => {
      const chip = e.target.closest('.ad-chip');
      if (!chip || chip.disabled) return;
      const id = chip.dataset.dealer;
      if (id === dealer.id) return;
      if (busy) return;
      // Abort any in-flight AI request for the OLD persona BEFORE we swap
      // so its .then() can never paint under the new dealer's name.
      if (inflight) { inflight.abort(); inflight = null; }
      dealer = DEALERS.find(d => d.id === id) || dealer;
      repaintDealer();
      say('greet');
    });

    function renderPlayer(cards) { playerEl.innerHTML = cards.map(c => GameKit.cardHTML(c)).join(''); pvEl.textContent = value(cards); playerEl.dataset.cards = JSON.stringify(cards); }
    function renderDealer(cards, hideHole) {
      if (hideHole) { dealerEl.innerHTML = GameKit.cardHTML(cards[0]) + GameKit.cardHTML(null, true); dvEl.textContent = value([cards[0]]) + ' +'; }
      else { dealerEl.innerHTML = cards.map(c => GameKit.cardHTML(c)).join(''); dvEl.textContent = value(cards); }
    }
    function showActions(canDouble) { actions.classList.remove('hidden'); dblBtn.style.display = canDouble ? '' : 'none'; }

    function finish(res, outcome) {
      roundId = null; busy = false;
      actions.classList.add('hidden'); deal.classList.remove('hidden'); deal.disabled = false; betInput.disabled = false; picker.setDisabled(false);
      const t = value(res.player);
      say(outcomeKey(outcome), { t: outcome === 'dealer_bust' ? value(res.dealer) : t });
      const win = res.payout > stake + 1e-9, push = Math.abs(res.payout - stake) < 1e-9;
      Bankroll.set(res.balance);
      Feed.recordPlayerBet({ game: 'blackjack', bet: stake, mult: win ? res.payout / stake : 0, win, payout: res.payout, profit: res.payout - stake });
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
      busy = true; deal.disabled = true; picker.setDisabled(true);
      say('deal');
      try {
        const res = await API.bjStart({ bet });
        Fair.bumpNonce(); stake = bet;
        renderPlayer(res.player);
        if (res.done) { renderDealer(res.dealer, false); finish(res, res.outcome); return; }
        roundId = res.roundId; betInput.disabled = true;
        renderDealer([res.dealerUp], true);
        deal.classList.add('hidden'); showActions(res.canDouble);
        statusEl.textContent = `You have ${res.total} — your move`;
        busy = false;
      } catch (e) { Toast.error(e.message); busy = false; deal.disabled = false; picker.setDisabled(false); }
    }
    async function act(fn, sayKey) {
      if (busy || !roundId) return;
      busy = true; actions.classList.add('hidden');
      const preTotal = value(JSON.parse(playerEl.dataset.cards || '[]'));
      try {
        if (sayKey === 'stand' || sayKey === 'dbl') say(sayKey, { t: preTotal });
        else say(sayKey);
        const res = await fn();
        renderPlayer(res.player);
        if (res.done) { renderDealer(res.dealer, false); finish(res, res.outcome); return; }
        showActions(false);
        statusEl.textContent = `You have ${res.total} — hit or stand`;
        busy = false;
      } catch (e) { Toast.error(e.message); showActions(false); busy = false; }
    }

    deal.addEventListener('click', start);
    hitBtn.addEventListener('click', () => act(() => API.bjHit({ roundId }), 'hit'));
    standBtn.addEventListener('click', () => act(() => API.bjStand({ roundId }), 'stand'));
    dblBtn.addEventListener('click', () => { stake = bet * 2; act(() => API.bjDouble({ roundId }), 'dbl'); });

    repaintDealer();
    say('greet');
    return function () {
      alive = false;
      if (inflight) inflight.abort();
      if (portraitLoader) { portraitLoader.onload = null; portraitLoader = null; }
    };
  }
  global.Games = global.Games || {};
  global.Games.aidealer = mount;
})(window);
