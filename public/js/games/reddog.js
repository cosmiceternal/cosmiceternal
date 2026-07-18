/* Red Dog (Acey-Deucey) — two cards set a spread; a third wins if it falls
 * strictly between them. Pays by spread (wider gaps pay less); a pair pays 11×
 * if the third matches, otherwise a push. Auto-resolved, server-authoritative. */
(function (global) {
  'use strict';
  const SUITS = ['♠', '♥', '♦', '♣'];
  const RANKS = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
  const label = (r) => RANKS[r] || String(r);
  function cardHTML(c, faceDown) {
    if (faceDown) return `<div class="pcard back"></div>`;
    const red = c.s === 1 || c.s === 2;
    return `<div class="pcard${red ? ' red' : ''}"><span class="pc-r">${label(c.r)}</span><span class="pc-s">${SUITS[c.s]}</span></div>`;
  }
  function mount(container) {
    let busy = false, alive = true, timers = [];
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('rdBet')}
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="rdDeal">Deal</button>
      <div class="stat-grid">
        <div class="stat"><span class="stat-label">Spread</span><span class="stat-value" id="rdSpread">—</span></div>
        <div class="stat"><span class="stat-label">Multiplier</span><span class="stat-value" id="rdMult">—</span></div>
      </div>
      <p class="muted" style="font-size:11px;line-height:1.5;margin:0;">A third card between the two posts wins. Tighter spreads pay more: 1&nbsp;→&nbsp;6×, 2&nbsp;→&nbsp;5×, 3&nbsp;→&nbsp;3×, 4+&nbsp;→&nbsp;1×. A matching pair pays 11×.</p>
    `, `<div class="reddog-felt">
          <div class="rd-slot"><div class="rd-card" id="rdC1"></div><span class="rd-tag">post</span></div>
          <div class="rd-gap" id="rdGap">?</div>
          <div class="rd-slot"><div class="rd-card" id="rdC2"></div><span class="rd-tag">post</span></div>
          <div class="rd-slot"><div class="rd-card" id="rdC3"></div><span class="rd-tag">the dog</span></div>
        </div>
        <div class="crash-status" id="rdStatus">Place a bet and deal</div>`, 'reddog-stage');

    const betInput = container.querySelector('#rdBet');
    const dealBtn = container.querySelector('#rdDeal');
    const statusEl = container.querySelector('#rdStatus');
    const spreadEl = container.querySelector('#rdSpread');
    const multEl = container.querySelector('#rdMult');
    const c1El = container.querySelector('#rdC1'), c2El = container.querySelector('#rdC2'), c3El = container.querySelector('#rdC3');
    const gapEl = container.querySelector('#rdGap');
    GameKit.wireBet(container, betInput);
    // Show face-down backs so the felt reads as a real table before the deal.
    [c1El, c2El, c3El].forEach(el => { el.innerHTML = cardHTML(null, true); });

    async function deal() {
      if (busy) return;
      const b = GameKit.bet(betInput);
      if (b == null) return;
      busy = true; dealBtn.disabled = true;
      [c1El, c2El, c3El].forEach(el => { el.innerHTML = cardHTML(null, true); el.classList.remove('flip'); });
      gapEl.textContent = '?'; gapEl.className = 'rd-gap';
      spreadEl.textContent = '—'; multEl.textContent = '—';
      statusEl.textContent = 'Dealing…';
      try {
        const res = await API.reddog({ bet: b });
        const [a, c, d] = res.cards;
        // Reveal the two posts.
        timers.push(setTimeout(() => { if (!alive) return; c1El.innerHTML = cardHTML(a); c1El.classList.add('flip'); if (global.Sound) Sound.play('card'); }, 250));
        timers.push(setTimeout(() => { if (!alive) return; c2El.innerHTML = cardHTML(c); c2El.classList.add('flip'); if (global.Sound) Sound.play('card'); }, 550));
        timers.push(setTimeout(() => {
          if (!alive) return;
          spreadEl.textContent = res.pair ? 'pair' : (res.spread === 0 ? 'consecutive' : res.spread);
          gapEl.textContent = res.pair ? '=' : (res.spread === 0 ? '–' : res.spread);
          statusEl.textContent = res.pair ? 'Pair! Third card must match…' : (res.spread === 0 ? 'Consecutive — push.' : 'Will the dog land between?');
        }, 850));
        // Reveal the dog.
        timers.push(setTimeout(() => {
          if (!alive) return;
          c3El.innerHTML = cardHTML(d); c3El.classList.add('flip'); if (global.Sound) Sound.play('reveal');
          multEl.textContent = res.mult.toFixed(2) + '×';
          if (res.win) { gapEl.classList.add('win'); statusEl.textContent = `Between! ${res.mult.toFixed(2)}× — +${Bankroll.fmt(res.payout - b)}`; }
          else if (res.push) { gapEl.classList.add('push'); statusEl.textContent = 'Push — your stake is returned.'; }
          else { gapEl.classList.add('lose'); statusEl.textContent = 'Missed the gap. No win.'; }
          GameKit.settle('reddog', b, res);
          busy = false; dealBtn.disabled = false;
        }, 1350));
      } catch (e) { Toast.error(e.message); busy = false; dealBtn.disabled = false; }
    }
    dealBtn.addEventListener('click', deal);
    return function () { alive = false; timers.forEach(clearTimeout); };
  }
  global.Games = global.Games || {};
  global.Games.reddog = mount;
})(window);
