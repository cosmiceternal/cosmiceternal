/* Bet feed. Has two modes:
 *   - "Yours" (default): your own bet history from /api/history; new bets get
 *     prepended live as you play.
 *   - "Live": recent wins across all players (anonymised). Polls every 8s so
 *     it actually feels like a ticker. For a single-user deploy this is your
 *     own highlight reel — for a busier table it's the social-proof ticker. */
(function (global) {
  'use strict';

  const MAX_ROWS = 60;
  const POLL_MS = 8000;
  let yoursRows = [];
  let liveRows  = [];
  let listEl = null;
  let mode = 'all';            // 'all' | 'high' | 'me' | 'live'
  let pollTimer = null;

  function fmtMoney(n) {
    return (global.Bankroll && Bankroll.fmtCompact) ? Bankroll.fmtCompact(n) : n.toFixed(2);
  }
  function fmtAgo(ts) {
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 5)    return 'now';
    if (s < 60)   return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    return Math.floor(s / 86400) + 'd';
  }

  function rowEl(r, isLive) {
    const li = document.createElement('li');
    li.classList.add(r.win ? 'win' : 'loss');
    if (!isLive) li.classList.add('me-row');

    const game = document.createElement('span');
    const tag = document.createElement('span');
    tag.className = 'game-tag ' + r.game;
    tag.textContent = r.game;
    game.appendChild(tag);

    const player = document.createElement('span');
    player.className = 'player';
    player.textContent = isLive ? (r.player || '???') : 'you';

    const bet = document.createElement('span');
    bet.textContent = fmtMoney(r.bet);

    const mult = document.createElement('span');
    mult.textContent = (r.mult >= 100 ? r.mult.toFixed(0) : r.mult.toFixed(2)) + '×';
    mult.style.color = r.mult >= 2 ? 'var(--accent)' : (r.mult > 1 ? 'var(--text)' : 'var(--muted)');

    const payout = document.createElement('span');
    payout.className = 'payout';
    const profit = (typeof r.profit === 'number') ? r.profit : (r.win ? r.payout - r.bet : -r.bet);
    payout.textContent = (profit >= 0 ? '+' : '−') + fmtMoney(Math.abs(profit));
    if (isLive && r.ts) payout.title = fmtAgo(r.ts) + ' ago';

    li.append(game, player, bet, mult, payout);
    return li;
  }

  function emptyMsg() { return mode === 'live' ? 'No live wins yet — be the first.' : 'Your bets will appear here'; }
  function renderEmpty() { if (listEl) listEl.innerHTML = `<li class="feed-empty">${emptyMsg()}</li>`; }

  function visibleRows() {
    if (mode === 'live') return liveRows;
    if (mode === 'high') return yoursRows.filter(r => r.bet >= 100 || r.payout >= 500);
    return yoursRows;
  }

  function render() {
    if (!listEl) return;
    const visible = visibleRows();
    listEl.innerHTML = '';
    if (visible.length === 0) { renderEmpty(); return; }
    visible.slice(0, MAX_ROWS).forEach(r => listEl.appendChild(rowEl(r, mode === 'live')));
  }

  async function loadYours() {
    try {
      const r = await API.history(MAX_ROWS);
      yoursRows = r.bets || [];
      if (mode !== 'live') render();
    } catch (e) { if (mode !== 'live') renderEmpty(); }
  }
  async function loadLive() {
    try {
      const r = await API.globalFeed(MAX_ROWS);
      liveRows = r.wins || [];
      if (mode === 'live') render();
    } catch (e) { if (mode === 'live') renderEmpty(); }
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(() => { if (mode === 'live') loadLive(); }, POLL_MS);
  }
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  function prepend(r) {
    yoursRows.unshift(r);
    if (yoursRows.length > MAX_ROWS * 2) yoursRows = yoursRows.slice(0, MAX_ROWS);
    if (mode !== 'live') render();
  }
  function recordPlayerBet({ game, bet, mult, win, payout }) {
    prepend({ game, bet, mult: win ? mult : 0, win, payout, profit: win ? payout - bet : -bet, ts: Date.now() });
  }

  function setMode(m) {
    mode = m;
    if (mode === 'live') { loadLive(); startPolling(); }
    else { stopPolling(); render(); }
  }

  function init(el) {
    listEl = el;
    document.querySelectorAll('.feed-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.feed-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        setMode(btn.dataset.feed);
      });
    });
    renderEmpty();
    loadYours();
  }

  global.Feed = { init, recordPlayerBet, load: loadYours };
})(window);
