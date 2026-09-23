/* Let It Ride — three equal bets, three cards, two community cards turned one
 * at a time. Before each you may pull a bet back; the third always rides.
 *
 * Cards render into .cards-row through GameKit.cardHTML, so the skeleton
 * croupier deals them like every other card table.
 *
 * The payout table is the server's (games.LIR_PAYS) and is read from the play
 * response rather than restated here. */
(function (global) {
  'use strict';

  const NAMES = {
    royal: 'Royal Flush', sf: 'Straight Flush', four: 'Four of a Kind',
    full: 'Full House', flush: 'Flush', straight: 'Straight',
    three: 'Three of a Kind', twopair: 'Two Pair', tens: 'Pair of Tens or Better',
    none: 'No Qualifying Hand'
  };
  const TABLE = [
    ['Royal Flush', '1500×'], ['Straight Flush', '300×'], ['Four of a Kind', '80×'],
    ['Full House', '18×'], ['Flush', '12×'], ['Straight', '8×'],
    ['Three of a Kind', '5×'], ['Two Pair', '4×'], ['Tens or Better', '2×']
  ];

  function mount(container) {
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('lirBet')}
      <p class="muted" style="font-size:11px;margin:6px 0 0;">Three equal bets are placed — you stake 3× the amount above.</p>
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="lirDeal">Deal</button>
      <div class="row hidden" id="lirActions">
        <button class="btn" id="lirPull" style="flex:1">Pull Back</button>
        <button class="btn btn-primary" id="lirRide" style="flex:1">Let It Ride</button>
      </div>
      <div class="stat-grid">
        <div class="stat"><span class="stat-label">Riding</span><span class="stat-value" id="lirRiding">—</span></div>
        <div class="stat"><span class="stat-label">Last Hand</span><span class="stat-value" id="lirLast">—</span></div>
      </div>
      <div class="lir-paytable" id="lirPaytable">
        ${TABLE.map(([n, p]) => `<div class="lir-pay"><span>${n}</span><b>${p}</b></div>`).join('')}
      </div>
      <p class="muted" style="font-size:11px;line-height:1.5;margin:0;">Every paying hand is scored against all five cards. Each bet still riding is paid separately.</p>
    `, `<div class="lir-table">
          <div class="lir-label">Your Cards</div>
          <div class="cards-row" id="lirPlayer"></div>
          <div class="lir-label">Community</div>
          <div class="cards-row" id="lirBoard"></div>
          <div class="lir-bets" id="lirBets">
            ${[1, 2, 3].map(i => `<div class="lir-chip" id="lirChip${i}"><span>${i === 3 ? '★' : i}</span></div>`).join('')}
          </div>
        </div>
        <div class="crash-status" id="lirStatus">Place three bets and deal</div>`, 'cards-stage');

    const betInput = container.querySelector('#lirBet');
    const dealBtn = container.querySelector('#lirDeal');
    const actions = container.querySelector('#lirActions');
    const pullBtn = container.querySelector('#lirPull');
    const rideBtn = container.querySelector('#lirRide');
    const playerEl = container.querySelector('#lirPlayer');
    const boardEl = container.querySelector('#lirBoard');
    const statusEl = container.querySelector('#lirStatus');
    const ridingEl = container.querySelector('#lirRiding');
    const lastEl = container.querySelector('#lirLast');
    const chips = [1, 2, 3].map(i => container.querySelector('#lirChip' + i));

    let roundId = null, unit = 0, stage = 0, busy = false, alive = true;
    GameKit.wireBet(container, betInput);

    function setChips(state) {
      chips.forEach((c, i) => {
        c.classList.toggle('pulled', state[i] === 'pulled');
        c.classList.toggle('riding', state[i] === 'riding');
        c.classList.toggle('live', state[i] === 'live');
      });
    }

    function reset() {
      roundId = null; stage = 0;
      actions.classList.add('hidden');
      dealBtn.classList.remove('hidden');
      dealBtn.disabled = false;
      ridingEl.textContent = '—';
      setChips(['', '', '']);
    }

    async function deal() {
      if (busy) return;
      const b = GameKit.bet(betInput);
      if (b == null) return;
      // Three equal bets are posted, so the stake is 3x what the box shows.
      if (!Bankroll.canAfford(b * 3)) return Toast.error('Insufficient balance for three bets');
      busy = true; dealBtn.disabled = true;
      playerEl.innerHTML = ''; boardEl.innerHTML = '';
      statusEl.textContent = 'Dealing…';
      if (global.Sound) Sound.play('card');
      try {
        const res = await API.lirStart({ bet: b });
        if (!alive) return;
        // Three bets leave the balance the moment they are posted; without this
        // the player watches a stale number for the whole hand.
        Bankroll.set(res.balance);
        roundId = res.roundId; unit = b; stage = 1;
        playerEl.innerHTML = res.player.map(c => GameKit.cardHTML(c)).join('');
        boardEl.innerHTML = GameKit.cardHTML(null, true) + GameKit.cardHTML(null, true);
        setChips(['live', 'riding', 'riding']);
        ridingEl.textContent = '3 × ' + b.toFixed(2);
        statusEl.textContent = 'Pull the first bet back, or let it ride';
        dealBtn.classList.add('hidden');
        actions.classList.remove('hidden');
        pullBtn.disabled = rideBtn.disabled = false;
      } catch (e) { Toast.error(e.message); dealBtn.disabled = false; }
      busy = false;
    }

    async function act(action) {
      if (busy || !roundId) return;
      busy = true; pullBtn.disabled = rideBtn.disabled = true;
      try {
        const res = await API.lirAct({ roundId, action });
        if (!alive) return;
        if (global.Sound) Sound.play('card');
        // A pulled bet is returned straight away — reflect it before the hand ends.
        if (res.stage === 2) Bankroll.set(res.balance);

        const idx = stage - 1;
        const state = [
          idx === 0 ? (action === 'pull' ? 'pulled' : 'riding') : chips[0].classList.contains('pulled') ? 'pulled' : 'riding',
          idx === 1 ? (action === 'pull' ? 'pulled' : 'riding') : (stage === 1 ? 'live' : 'riding'),
          'riding'
        ];

        if (res.stage === 2) {
          stage = 2;
          // turn the first community card face up
          boardEl.innerHTML = GameKit.cardHTML(res.revealed) + GameKit.cardHTML(null, true);
          state[1] = 'live';
          setChips(state);
          statusEl.textContent = 'Pull the second bet back, or let it ride';
          pullBtn.disabled = rideBtn.disabled = false;
          busy = false;
          return;
        }

        // settled
        boardEl.innerHTML = res.cards.slice(3).map(c => GameKit.cardHTML(c)).join('');
        setChips([state[0], state[1], 'riding']);
        ridingEl.textContent = res.riding + ' × ' + unit.toFixed(2);
        lastEl.textContent = NAMES[res.kind] || res.kind;
        const stake = unit * 3;
        statusEl.textContent = res.payout > 0
          ? `${NAMES[res.kind]} — ${res.per}× on ${res.riding} bet${res.riding > 1 ? 's' : ''}, paid ${res.payout.toFixed(2)}`
          : 'No qualifying hand';
        GameKit.settle('letitride', stake, res);
        reset();
      } catch (e) {
        Toast.error(e.message);
        pullBtn.disabled = rideBtn.disabled = false;
      }
      busy = false;
    }

    dealBtn.addEventListener('click', deal);
    pullBtn.addEventListener('click', () => act('pull'));
    rideBtn.addEventListener('click', () => act('ride'));
    return function () { alive = false; };
  }

  global.Games = global.Games || {};
  global.Games.letitride = mount;
})(window);
