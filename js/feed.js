/* Live bet feed. Mixes the player's real bets with an endless stream of
 * fake players placing bets. Rendered into the right sidebar. */
(function (global) {
  'use strict';

  const NAMES = [
    'lunar_wolf','crispy','jpeg.eater','mr.mustard','quantum','vortex',
    'sunbeam','ace_high','silentowl','degen42','kennyG','vapor','redline',
    'twoshoes','copper','solo','frostbyte','mintleaf','tinker','glasshouse',
    'shadowfax','bingobongo','peachfuzz','octopus_prime','rainmaker','slick',
    'nebula','crash.king','plinko.gawd','dicefiend','minimax','bandit',
    'gigachad','prism','tempest','olive','noodle','wraith','pollen','goose',
    'milkshake','hexx','ronin','starlight','flick','fizzy','arrow','onyx'
  ];

  const GAMES = ['crash', 'mines', 'plinko', 'dice'];

  const MAX_ROWS = 60;
  let rows = [];
  let listEl = null;
  let filter = 'all';

  function pickName() {
    return NAMES[Math.floor(Math.random() * NAMES.length)];
  }

  function fmtMoney(n) {
    if (Math.abs(n) >= 10000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
    return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function rowEl(r) {
    const li = document.createElement('li');
    if (r.win) li.classList.add('win'); else li.classList.add('loss');
    if (r.me) li.classList.add('me-row');

    const game = document.createElement('span');
    const tag = document.createElement('span');
    tag.className = 'game-tag ' + r.game;
    tag.textContent = r.game;
    game.appendChild(tag);

    const player = document.createElement('span');
    player.className = 'player';
    player.textContent = r.me ? 'you' : r.player;

    const bet = document.createElement('span');
    bet.textContent = fmtMoney(r.bet);

    const mult = document.createElement('span');
    mult.textContent = (r.mult >= 100 ? r.mult.toFixed(0) : r.mult.toFixed(2)) + '×';
    mult.style.color = r.mult >= 2 ? 'var(--accent)' : (r.mult > 1 ? 'var(--text)' : 'var(--muted)');

    const payout = document.createElement('span');
    payout.className = 'payout';
    payout.textContent = (r.win ? '+' : '−') + fmtMoney(Math.abs(r.payout));

    li.append(game, player, bet, mult, payout);
    return li;
  }

  function render() {
    if (!listEl) return;
    let visible = rows;
    if (filter === 'high') visible = rows.filter(r => r.bet >= 100 || r.payout >= 500);
    else if (filter === 'me') visible = rows.filter(r => r.me);
    listEl.innerHTML = '';
    // Show newest at top
    visible.slice(-MAX_ROWS).reverse().forEach(r => listEl.appendChild(rowEl(r)));
  }

  function push(r) {
    rows.push(r);
    if (rows.length > MAX_ROWS * 2) rows = rows.slice(-MAX_ROWS);
    render();
  }

  // Generate a plausible random fake bet for a given game
  function generateFake() {
    const game = GAMES[Math.floor(Math.random() * GAMES.length)];
    let bet, mult, win;
    // Bet size distribution — mostly small, occasional whale
    const r = Math.random();
    if (r < 0.6) bet = +(Math.random() * 9 + 1).toFixed(2);
    else if (r < 0.92) bet = +(Math.random() * 90 + 10).toFixed(2);
    else if (r < 0.99) bet = +(Math.random() * 900 + 100).toFixed(2);
    else bet = +(Math.random() * 4500 + 500).toFixed(2);

    switch (game) {
      case 'crash': {
        // Bust distribution: 1 / (1-u). About half lose under 2x, tail to huge wins.
        const u = Math.random();
        const bust = Math.max(1, Math.floor(99 / (1 - u + 0.01)) / 100);
        const target = +(Math.random() * 4 + 1.2).toFixed(2);
        win = bust >= target;
        mult = win ? target : 0;
        break;
      }
      case 'mines': {
        const safe = Math.floor(Math.random() * 8) + 1;
        const mines = [1,3,5,8][Math.floor(Math.random() * 4)];
        mult = computeMinesMult(safe, mines);
        // Win probability ≈ (25-mines) / 25 chained
        let p = 1;
        for (let i = 0; i < safe; i++) p *= (25 - mines - i) / (25 - i);
        win = Math.random() < p;
        if (!win) mult = 0;
        break;
      }
      case 'plinko': {
        const choices = [0.3, 0.5, 0.8, 1.1, 1.5, 2, 5, 13, 33];
        const weights = [25, 25, 20, 15, 8, 4, 2, 0.7, 0.3];
        mult = weightedPick(choices, weights);
        win = mult >= 1;
        break;
      }
      case 'dice': {
        const target = +(Math.random() * 80 + 10).toFixed(2);
        const over = Math.random() < 0.5;
        const winChance = over ? (99.99 - target) : target;
        const m = +(99 / Math.max(0.01, winChance)).toFixed(4);
        win = Math.random() * 100 < winChance;
        mult = win ? m : 0;
        break;
      }
    }
    const payout = win ? bet * mult : bet;
    return {
      player: pickName(),
      game, bet,
      mult: win ? mult : 0,
      win,
      payout: win ? payout - bet : bet,
      ts: Date.now()
    };
  }

  function weightedPick(values, weights) {
    let total = 0; weights.forEach(w => total += w);
    let r = Math.random() * total;
    for (let i = 0; i < values.length; i++) {
      r -= weights[i];
      if (r <= 0) return values[i];
    }
    return values[values.length - 1];
  }

  function computeMinesMult(safe, mines) {
    // Same formula as game, but accessible to the feed.
    let prod = 1;
    for (let i = 0; i < safe; i++) prod *= (25 - i) / (25 - mines - i);
    return +(prod * 0.99).toFixed(4);
  }

  let timer = null;
  function start() {
    if (timer) return;
    function loop() {
      // 1-3 fake bets per cycle
      const n = 1 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) push(generateFake());
      // Variable cadence
      const wait = 600 + Math.random() * 1800;
      timer = setTimeout(loop, wait);
    }
    // Pre-fill so the feed isn't empty
    for (let i = 0; i < 12; i++) push(generateFake());
    loop();
  }

  function stop() {
    if (timer) { clearTimeout(timer); timer = null; }
  }

  function init(el) {
    listEl = el;
    document.querySelectorAll('.feed-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.feed-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        filter = btn.dataset.feed;
        render();
      });
    });
    start();
  }

  // Player-originated bet
  function recordPlayerBet({ game, bet, mult, win, payout }) {
    push({
      player: 'you',
      me: true,
      game, bet,
      mult: win ? mult : 0,
      win,
      payout: win ? (payout - bet) : bet,
      ts: Date.now()
    });
  }

  global.Feed = { init, recordPlayerBet, start, stop };
})(window);
