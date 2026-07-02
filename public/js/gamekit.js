/* Shared helpers for the game modules: standard controls, bet validation,
 * settle/feed/toast plumbing, and card rendering. Keeps each game small and
 * consistent. The server remains the source of truth for every outcome. */
(function (global) {
  'use strict';

  const SUITS = ['♠', '♥', '♦', '♣']; // ♠ ♥ ♦ ♣
  const RANKS = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };

  function betRow(id) {
    return `<div class="field">
      <label>Bet Amount <span class="muted">CRYPT</span></label>
      <div class="bet-row">
        <input id="${id}" type="number" min="0.01" step="0.01" value="1.00" />
        <button class="btn" data-act="half">½</button>
        <button class="btn" data-act="dbl">2×</button>
        <button class="btn" data-act="max">Max</button>
      </div>
    </div>`;
  }

  function frame(controlsHTML, stageHTML, stageClass) {
    return `<div class="game-grid">
      <div class="controls">${controlsHTML}</div>
      <div class="stage ${stageClass || ''}">${stageHTML}</div>
    </div>`;
  }

  // Wire the ½ / 2× / Max buttons. Fires a 'betchange' event on container.
  function wireBet(container, input) {
    container.querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', () => {
        let v = +input.value || 0;
        const a = btn.dataset.act;
        if (a === 'half') v /= 2;
        else if (a === 'dbl') v *= 2;
        else if (a === 'max') v = Bankroll.get();
        input.value = Math.max(0.01, +v.toFixed(2));
        container.dispatchEvent(new Event('betchange'));
      });
    });
  }

  // Validate a bet amount; returns the number or null (with a toast).
  function bet(input) {
    const b = +input.value;
    if (!b || b <= 0) { Toast.warn('Enter a bet amount'); return null; }
    if (!Bankroll.canAfford(b)) { Toast.error('Insufficient balance'); return null; }
    return b;
  }

  // Apply a settled result: sync balance, bump nonce, record to feed, toast.
  function settle(game, betAmt, res) {
    if (typeof res.balance === 'number') Bankroll.set(res.balance);
    Fair.bumpNonce();
    const win = (typeof res.win === 'boolean') ? res.win : ((res.payout || 0) > betAmt - 1e-9);
    const mult = win ? (res.mult != null ? res.mult : (betAmt > 0 ? (res.payout || 0) / betAmt : 0)) : 0;
    Feed.recordPlayerBet({ game, bet: betAmt, mult, win, payout: res.payout || 0 });
    if (win) Toast.win(`+${Bankroll.fmt((res.payout || 0) - betAmt)} @ ${mult.toFixed(2)}×`);
    else Toast.loss(`−${Bankroll.fmt(betAmt)}`);
    if (win && mult >= 10 && global.Confetti) Confetti.burst({ count: mult >= 50 ? 140 : 90 });
    if (global.Sound) Sound.play(win ? (mult >= 10 ? 'bigwin' : 'win') : 'loss');
    // Progressive jackpot piggybacks on slot responses: keep the ticker live,
    // and go loud when it actually drops.
    if (res.jackpot && global.Jackpot) {
      Jackpot.setPot(res.jackpot.pot);
      if (res.jackpot.won) Jackpot.celebrate(res.jackpot.amount);
    }
  }

  function cardLabel(rank) { return RANKS[rank] || String(rank); }
  function cardHTML(c, faceDown) {
    if (faceDown) return `<div class="pcard back"></div>`;
    const red = c.suit === 1 || c.suit === 2;
    return `<div class="pcard${red ? ' red' : ''}"><span class="pc-r">${cardLabel(c.rank)}</span><span class="pc-s">${SUITS[c.suit]}</span></div>`;
  }

  global.GameKit = { betRow, frame, wireBet, bet, settle, cardHTML, cardLabel, SUITS };
})(window);
