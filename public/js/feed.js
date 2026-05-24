/* Bet feed. Shows the signed-in player's real bet history from the server,
 * newest first, and prepends new results as they happen. */
(function (global) {
  'use strict';

  const MAX_ROWS = 60;
  let rows = [];
  let listEl = null;
  let filter = 'all';

  function fmtMoney(n) {
    if (Math.abs(n) >= 10000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
    return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function rowEl(r) {
    const li = document.createElement('li');
    li.classList.add(r.win ? 'win' : 'loss', 'me-row');

    const game = document.createElement('span');
    const tag = document.createElement('span');
    tag.className = 'game-tag ' + r.game;
    tag.textContent = r.game;
    game.appendChild(tag);

    const player = document.createElement('span');
    player.className = 'player';
    player.textContent = 'you';

    const bet = document.createElement('span');
    bet.textContent = fmtMoney(r.bet);

    const mult = document.createElement('span');
    mult.textContent = (r.mult >= 100 ? r.mult.toFixed(0) : r.mult.toFixed(2)) + '×';
    mult.style.color = r.mult >= 2 ? 'var(--accent)' : (r.mult > 1 ? 'var(--text)' : 'var(--muted)');

    const payout = document.createElement('span');
    payout.className = 'payout';
    const profit = (typeof r.profit === 'number') ? r.profit : (r.win ? r.payout - r.bet : -r.bet);
    payout.textContent = (profit >= 0 ? '+' : '−') + fmtMoney(Math.abs(profit));

    li.append(game, player, bet, mult, payout);
    return li;
  }

  function renderEmpty() {
    if (listEl) listEl.innerHTML = '<li class="feed-empty">Your bets will appear here</li>';
  }

  function render() {
    if (!listEl) return;
    let visible = rows;
    if (filter === 'high') visible = rows.filter(r => r.bet >= 100 || r.payout >= 500);
    else if (filter === 'me') visible = rows; // all rows are already "me"
    listEl.innerHTML = '';
    if (visible.length === 0) { renderEmpty(); return; }
    visible.slice(0, MAX_ROWS).forEach(r => listEl.appendChild(rowEl(r)));
  }

  // Load existing history (newest first from the server).
  async function load() {
    try {
      const r = await API.history(MAX_ROWS);
      rows = r.bets || [];
      render();
    } catch (e) { renderEmpty(); }
  }

  function prepend(r) {
    rows.unshift(r);
    if (rows.length > MAX_ROWS * 2) rows = rows.slice(0, MAX_ROWS);
    render();
  }

  // Called by games after a settled bet. profit is signed.
  function recordPlayerBet({ game, bet, mult, win, payout }) {
    prepend({ game, bet, mult: win ? mult : 0, win, payout, profit: win ? payout - bet : -bet, ts: Date.now() });
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
    renderEmpty();
    load();
  }

  global.Feed = { init, recordPlayerBet, load };
})(window);
