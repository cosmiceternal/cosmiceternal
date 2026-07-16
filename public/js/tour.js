/* Onboarding tour. Pure DOM, no deps. 4 coachmarks that punch a hole
 * around a target element and float a small card next to it. Triggered
 * once per browser (localStorage) on first successful login of a fresh
 * account, or via ?tour=1 for replays. */
(function (global) {
  'use strict';

  const STEPS = [
    { sel: '#lvlBadge',  title: 'Level up as you play',
      body: 'Every wager earns XP. Hit milestones, unlock achievements, climb the leaderboard.' },
    { sel: '#btnDeposit', title: 'Crypto deposits',
      body: 'Top up with BTC / ETH / USDT / SOL. (Play-money mode for the demo.)' },
    { sel: '#btnFair',   title: 'Provably fair',
      body: 'Every roll is cryptographically verifiable. Rotate the seed to reveal it and replay any past bet.' },
    { sel: '#gamesDdBtn', title: 'All 43 games',
      body: 'Open this to jump to any game — AI Dealer blackjack, slots, live races and more.' }
  ];

  let overlay, hole, card, idx = 0;

  function ensureOverlay() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.id = 'tourOverlay';
    overlay.className = 'tour-overlay hidden';
    overlay.innerHTML = `
      <div class="tour-mask">
        <div class="tour-hole" id="tourHole"></div>
      </div>
      <div class="tour-card" id="tourCard">
        <div class="tour-step" id="tourStep"></div>
        <h3 class="tour-title" id="tourTitle"></h3>
        <p class="tour-body" id="tourBody"></p>
        <div class="tour-buttons">
          <button class="btn btn-ghost" id="tourSkip">Skip</button>
          <button class="btn btn-primary" id="tourNext">Next</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    hole = overlay.querySelector('#tourHole');
    card = overlay.querySelector('#tourCard');
    overlay.querySelector('#tourSkip').addEventListener('click', finish);
    overlay.querySelector('#tourNext').addEventListener('click', next);
    const reposition = () => { if (!overlay.classList.contains('hidden')) renderStep(); };
    window.addEventListener('resize', reposition);
    // Scroll listener — without this the hole/card freeze in viewport coords
    // while the targeted element scrolls away, leaving a dark mask over nothing.
    window.addEventListener('scroll', reposition, true);
  }

  function start() {
    ensureOverlay();
    idx = 0;
    overlay.classList.remove('hidden');
    renderStep();
  }

  function next() {
    idx++;
    if (idx >= STEPS.length) finish();
    else renderStep();
  }

  function finish() {
    try { localStorage.setItem('crypt.onboarded', '1'); } catch (e) {}
    if (overlay) overlay.classList.add('hidden');
  }

  function renderStep() {
    const step = STEPS[idx];
    const target = document.querySelector(step.sel);
    if (!target) { next(); return; }
    const r = target.getBoundingClientRect();
    const pad = 10;
    const left   = Math.max(0, r.left - pad);
    const top    = Math.max(0, r.top - pad);
    const width  = r.width  + pad * 2;
    const height = r.height + pad * 2;
    hole.style.left   = left + 'px';
    hole.style.top    = top + 'px';
    hole.style.width  = width + 'px';
    hole.style.height = height + 'px';

    document.getElementById('tourStep').textContent  = `Step ${idx + 1} of ${STEPS.length}`;
    document.getElementById('tourTitle').textContent = step.title;
    document.getElementById('tourBody').textContent  = step.body;
    document.getElementById('tourNext').textContent  = (idx === STEPS.length - 1) ? 'Finish' : 'Next';

    // Position the card below the hole if there's room, otherwise above.
    const cardHeight = 200;
    const vh = window.innerHeight, vw = window.innerWidth;
    const below = (top + height + cardHeight + 24 <= vh);
    let cardTop = below ? (top + height + 14) : Math.max(14, top - cardHeight - 14);
    let cardLeft = Math.min(vw - 340, Math.max(14, left + width / 2 - 160));
    card.style.top  = cardTop + 'px';
    card.style.left = cardLeft + 'px';
  }

  global.Tour = { start, finish };
})(window);
