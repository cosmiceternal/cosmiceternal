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

  // Validate a bet amount; returns the number or null (with a toast). A valid
  // wager plays the chip cue so every game gets a "bet placed" sound for free.
  function bet(input) {
    const b = +input.value;
    if (!b || b <= 0) { Toast.warn('Enter a bet amount'); return null; }
    if (!Bankroll.canAfford(b)) { Toast.error('Insufficient balance'); return null; }
    if (global.Sound) Sound.play('chip');
    return b;
  }

  // Apply a settled result: sync balance, bump nonce, record to feed, toast.
  function settle(game, betAmt, res) {
    if (typeof res.balance === 'number') Bankroll.set(res.balance);
    Fair.bumpNonce();
    const win = (typeof res.win === 'boolean') ? res.win : ((res.payout || 0) > betAmt - 1e-9);
    const mult = win ? (res.mult != null ? res.mult : (betAmt > 0 ? (res.payout || 0) / betAmt : 0)) : 0;
    const payout = res.payout || 0;
    const net = payout - betAmt;
    // Feed profit is the TRUE net (payout − bet) so pushes read as 0 and partial
    // returns (la partage, piñata 0.5×, baccarat ties) don't look like full losses.
    Feed.recordPlayerBet({ game, bet: betAmt, mult, win, payout, profit: net });
    if (win) Toast.win(`+${Bankroll.fmt(net)} @ ${mult.toFixed(2)}×`);
    else if (Math.abs(net) < 1e-9) Toast.info('Push — stake returned');
    else Toast.loss(`−${Bankroll.fmt(-net)}`);
    if (win) flashWin();
    // Big multiplier → centered celebration banner (owns its own confetti).
    // Fall back to a plain burst if WinFx isn't present for some reason.
    if (win && mult >= 10) {
      if (global.WinFx) WinFx.show({ amount: (res.payout || 0) - betAmt, mult });
      else if (global.Confetti) Confetti.burst({ count: mult >= 50 ? 140 : 90 });
    }
    if (global.Sound) Sound.play(win ? (mult >= 10 ? 'bigwin' : 'win') : 'loss');
    // Progressive jackpot piggybacks on slot responses: keep the ticker live,
    // and go loud when it actually drops.
    if (res.jackpot && global.Jackpot) {
      Jackpot.setPot(res.jackpot.pot);
      if (res.jackpot.won) Jackpot.celebrate(res.jackpot.amount);
    }
  }

  // Brief green glow on the game pane — tactile "you won" feedback. Round-based
  // games (towers, pump, hi-lo…) that settle outside GameKit call this directly.
  function flashWin() {
    const pane = document.querySelector('.game-pane');
    if (!pane) return;
    pane.classList.remove('flash-win'); void pane.offsetWidth; pane.classList.add('flash-win');
  }

  // ---- Reels -------------------------------------------------------------
  // Reels used to strobe a random glyph in place every 70ms, which reads as
  // teleporting rather than spinning. These build a vertical strip of symbols
  // and scroll it to a stop, easing out so the landing has weight. The server
  // still chooses the symbols; this only animates the arrival.

  function reduceMotion() {
    return !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function pick(pool) { return pool[Math.floor(Math.random() * pool.length)]; }

  // Scroll `strip` down into place over `delay`ms. Returns a cancel function.
  function runStrip(strip, travel, delay, onLand) {
    let anim = null, done = false;
    function land() {
      if (done) return;
      done = true;
      if (anim) { try { anim.cancel(); } catch (e) { /* already finished */ } }
      onLand();
    }
    if (strip.animate) {
      anim = strip.animate(
        [{ transform: 'translateY(' + (-travel) + 'px)' }, { transform: 'translateY(0px)' }],
        // Steep at the start, long glide out: a reel losing momentum.
        { duration: delay, easing: 'cubic-bezier(0.17, 0.67, 0.21, 1)', fill: 'both' }
      );
      anim.onfinish = land;
    }
    // Belt and braces: WAAPI animations are paused in background tabs, so a
    // timer guarantees the reel still resolves.
    const timer = setTimeout(land, delay + 60);
    return function cancel() {
      done = true;
      clearTimeout(timer);
      if (anim) { try { anim.cancel(); } catch (e) { /* already finished */ } }
      if (strip.parentNode) strip.parentNode.removeChild(strip);
    };
  }

  // One single-symbol reel (slots, Cosmic, Crypt, Pirate, Dragon, Frost,
  // Lucky Sevens). `pool` supplies the symbols that blur past on the way.
  function spinReel(el, stopIcon, pool, delay) {
    if (!el) return function () {};
    function settle() {
      el.textContent = stopIcon;
      el.classList.add('land');
      setTimeout(() => el.classList.remove('land'), 300);
    }
    if (reduceMotion() || !el.animate) {
      const t = setTimeout(settle, delay);
      return function () { clearTimeout(t); };
    }

    const h = el.clientHeight || 110;
    const count = Math.max(6, Math.round(delay / 70));
    const strip = document.createElement('div');
    strip.className = 'reel-strip';
    strip.style.setProperty('--reel-sym-h', h + 'px');
    // The landing symbol sits at the top, so the strip travels DOWN into
    // place and the reel reads like symbols falling past the window.
    let html = '<span class="reel-sym">' + stopIcon + '</span>';
    for (let i = 1; i < count; i++) html += '<span class="reel-sym">' + pick(pool) + '</span>';
    strip.innerHTML = html;
    el.textContent = '';
    el.appendChild(strip);

    return runStrip(strip, (count - 1) * h, delay, function () {
      if (strip.parentNode) strip.parentNode.removeChild(strip);
      settle();
    });
  }

  // A multi-row column (Neon Fruits: five columns of three). `stopIcons` are
  // the symbols the column rests on, top to bottom; `cellClass` is the game's
  // own cell class so the strip is styled like the board it covers.
  function spinColumn(colEl, stopIcons, pool, delay, cellClass, onLand) {
    if (!colEl) return function () {};
    const cells = Array.prototype.slice.call(colEl.children);
    if (reduceMotion() || !colEl.animate || !cells.length) {
      const t = setTimeout(onLand, delay);
      return function () { clearTimeout(t); };
    }

    const cs = global.getComputedStyle(colEl);
    const gap = parseFloat(cs.rowGap || cs.gap) || 0;
    const cellH = cells[0].offsetHeight || 0;
    const step = cellH + gap;
    if (!step) { const t = setTimeout(onLand, delay); return function () { clearTimeout(t); }; }

    const rows = stopIcons.length;
    const groups = Math.max(3, Math.round(delay / (60 * rows)));
    const strip = document.createElement('div');
    strip.className = 'reel-strip reel-strip-col';
    strip.style.top = cs.paddingTop;
    strip.style.left = cs.paddingLeft;
    strip.style.right = cs.paddingRight;
    strip.style.gap = gap + 'px';
    let html = stopIcons.map(s => '<span class="' + cellClass + '">' + s + '</span>').join('');
    for (let g = 1; g < groups; g++) {
      for (let r = 0; r < rows; r++) html += '<span class="' + cellClass + '">' + pick(pool) + '</span>';
    }
    strip.innerHTML = html;
    cells.forEach(c => { c.style.visibility = 'hidden'; });
    colEl.appendChild(strip);

    function restore() {
      cells.forEach(c => { c.style.visibility = ''; });
      if (strip.parentNode) strip.parentNode.removeChild(strip);
    }
    const cancel = runStrip(strip, (groups - 1) * rows * step, delay, function () {
      restore();
      onLand();
    });
    return function () { restore(); cancel(); };
  }

  // A value that slows to a stop instead of being cut off mid-strobe. Games
  // used to flick a random face or pocket every 70ms and then swap in the
  // real one, which reads as a teleport at both ends. `onStep` paints a
  // passing frame; the gap between frames stretches as the spin runs down,
  // and `landOn` paints the real result as the final frame — whether the
  // server answered before or after the wheel stopped.
  function spinSteps(onStep, duration, opts) {
    opts = opts || {};
    const minMs = opts.minMs || 55, maxMs = opts.maxMs || 260;
    const pulse = opts.pulse ? [].concat(opts.pulse) : [];
    const pulseClass = opts.pulseClass || 'spin-tick';
    const now = () => (global.performance ? performance.now() : Date.now());
    const start = now();
    let timer = null, i = 0, landFn = null, landed = false;

    function land() {
      if (landed) return;
      landed = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (landFn) landFn();
    }
    function tick() {
      const t = Math.min(1, (now() - start) / duration);
      if (t >= 1) { land(); return; }
      onStep(i++, t);
      pulse.forEach(el => {
        if (!el) return;
        el.classList.remove(pulseClass);
        void el.offsetWidth;
        el.classList.add(pulseClass);
      });
      // Each frame is held longer than the last: the spin losing momentum.
      timer = setTimeout(tick, minMs + (maxMs - minMs) * Math.pow(t, 2.4));
    }
    if (reduceMotion()) timer = setTimeout(land, Math.min(200, duration));
    else tick();

    const handle = function cancel() {
      landed = true;
      if (timer) { clearTimeout(timer); timer = null; }
      pulse.forEach(el => el && el.classList.remove(pulseClass));
    };
    // Hand it the real result. Painted once the spin has run down, or at
    // once if it already has.
    handle.landOn = function (fn) {
      landFn = function () {
        pulse.forEach(el => el && el.classList.remove(pulseClass));
        fn();
      };
      if (landed) landFn();
    };
    return handle;
  }

  function cardLabel(rank) { return RANKS[rank] || String(rank); }
  function cardHTML(c, faceDown) {
    if (faceDown) return `<div class="pcard back"></div>`;
    const red = c.suit === 1 || c.suit === 2;
    return `<div class="pcard${red ? ' red' : ''}"><span class="pc-r">${cardLabel(c.rank)}</span><span class="pc-s">${SUITS[c.suit]}</span></div>`;
  }

  global.GameKit = { betRow, frame, wireBet, bet, settle, flashWin, cardHTML, cardLabel, SUITS,
                     spinReel, spinColumn, spinSteps, reduceMotion };
})(window);
