'use strict';

/* Skeleton card dealer.
 *
 * Every card game renders through GameKit.cardHTML() into a .cards-row, so one
 * observer covers all of them: mount a skeleton croupier above the table, and
 * whenever cards appear, fly them out of his hands into place.
 *
 * Only NEW cards animate. The games rebuild a whole row with innerHTML on each
 * update, so animating "everything present" would re-deal the player's entire
 * hand every time they hit. We track the previous count per row and animate the
 * tail; a row that shrank (a fresh round) deals from the start.
 *
 * The AI Dealer game is skipped — it already has its own dealer portrait, and
 * two dealers at one table reads as a bug. */
(function (global) {
  // 460/165, not 340/90: the whole four-card deal used to be over in ~600ms
  // with every card at full opacity by 190ms, so it read as one clump landing
  // rather than cards being dealt one at a time.
  const DEAL_MS = 460;
  const STAGGER_MS = 165;

  let observer = null;

  const reduced = () => global.matchMedia
    && global.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function dealerSVG() {
    // Layer order matters: arms and deck first, then neck, collar, skull, hat.
    // Earlier passes put the bowtie across his teeth and clipped his hands off
    // the bottom of the viewBox.
    return '' +
      '<svg class="cd-bones" viewBox="0 0 200 158" role="img" aria-label="Skeleton dealer holding a deck of cards">' +
        '<defs>' +
          '<linearGradient id="cdBone" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0" stop-color="#fbf8ee"/><stop offset="1" stop-color="#ddd6c2"/>' +
          '</linearGradient>' +
          '<linearGradient id="cdFelt" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0" stop-color="#1e2634"/><stop offset="1" stop-color="#121a26"/>' +
          '</linearGradient>' +
        '</defs>' +
        '<g class="cd-body">' +
          // shoulders, with a waistcoat suggestion so he reads as a croupier
          '<path d="M62 106 q38 -14 76 0 v6 q-38 -12 -76 0 z" fill="url(#cdFelt)"/>' +
          '<rect x="60" y="96" width="80" height="11" rx="5.5" fill="url(#cdBone)" stroke="#c9c1a7" stroke-width="1"/>' +
          // arms angling in toward the deck
          '<g class="cd-arm cd-arm-l">' +
            '<rect x="62" y="102" width="10.5" height="26" rx="5.25" transform="rotate(17 67 104)" fill="url(#cdBone)" stroke="#c9c1a7" stroke-width="1"/>' +
            '<circle cx="82" cy="128" r="7.5" fill="url(#cdBone)" stroke="#c9c1a7" stroke-width="1"/>' +
          '</g>' +
          '<g class="cd-arm cd-arm-r">' +
            '<rect x="127.5" y="102" width="10.5" height="26" rx="5.25" transform="rotate(-17 133 104)" fill="url(#cdBone)" stroke="#c9c1a7" stroke-width="1"/>' +
            '<circle cx="118" cy="128" r="7.5" fill="url(#cdBone)" stroke="#c9c1a7" stroke-width="1"/>' +
          '</g>' +
          // the deck he deals from
          '<g class="cd-deck">' +
            '<rect x="88" y="122" width="25" height="19" rx="3" fill="#b9c2cd" stroke="#94a0ad" stroke-width="1"/>' +
            '<rect x="89.5" y="119" width="25" height="19" rx="3" fill="#dbe2ea" stroke="#94a0ad" stroke-width="1"/>' +
            '<rect x="91" y="116" width="25" height="19" rx="3" fill="#fffdf6" stroke="#b4ab8d" stroke-width="1"/>' +
            '<circle class="cd-pip" cx="103.5" cy="125.5" r="3.2"/>' +
          '</g>' +
          // neck
          '<rect x="94" y="78" width="12" height="9" rx="3" fill="url(#cdBone)"/>' +
          // bow tie at the collar, well clear of the jaw
          '<g class="cd-bow"><path d="M100 92 l-10 -5 v10 z M100 92 l10 -5 v10 z"/><circle cx="100" cy="92" r="3"/></g>' +
          '<g class="cd-skull">' +
            // cranium + cheekbones + jaw
            '<path fill="url(#cdBone)" stroke="#cdc5aa" stroke-width="1.2" d="' +
              'M100 14 c-23 0 -37 16 -37 35 c0 11 5 19 11 24 q3 2 3.5 6 l1 7 c0.4 3 3 5 6 5 h31 c3 0 5.6 -2 6 -5 l1 -7 q0.5 -4 3.5 -6 c6 -5 11 -13 11 -24 c0 -19 -14 -35 -37 -35 z"/>' +
            // temple shading gives the dome some form
            '<path d="M100 16 c-20 0 -33 14 -33 31 0 5 1 9 3 13 -1 -16 9 -33 30 -37 z" fill="#fff" opacity=".45"/>' +
            // sockets: deep, slightly angled inward so he looks friendly not grim
            '<ellipse cx="87.5" cy="49" rx="9.5" ry="11" fill="#0b0f16"/>' +
            '<ellipse cx="112.5" cy="49" rx="9.5" ry="11" fill="#0b0f16"/>' +
            '<g class="cd-lid">' +
              '<circle class="cd-eye" cx="87.5" cy="50" r="4.7"/><circle cx="85.8" cy="48.3" r="1.6" fill="#fff"/>' +
              '<circle class="cd-eye" cx="112.5" cy="50" r="4.7"/><circle cx="110.8" cy="48.3" r="1.6" fill="#fff"/>' +
            '</g>' +
            // cheek hollows
            '<path d="M76 60 q4 5 9 6" fill="none" stroke="#cdc5aa" stroke-width="1.4" stroke-linecap="round" opacity=".8"/>' +
            '<path d="M124 60 q-4 5 -9 6" fill="none" stroke="#cdc5aa" stroke-width="1.4" stroke-linecap="round" opacity=".8"/>' +
            '<path d="M100 57 l-4.5 9 h9 z" fill="#0b0f16"/>' +
            // grin
            '<path d="M87 70 q13 11 26 0" fill="none" stroke="#0b0f16" stroke-width="2.2" stroke-linecap="round"/>' +
            '<g stroke="#0b0f16" stroke-width="1.5">' +
              '<line x1="93" y1="71.5" x2="93" y2="77"/><line x1="100" y1="73.5" x2="100" y2="79"/><line x1="107" y1="71.5" x2="107" y2="77"/>' +
            '</g>' +
          '</g>' +
          // croupier hat with a banded brim
          '<g class="cd-hat">' +
            '<ellipse cx="100" cy="29" rx="36" ry="7.5" fill="#0e131c"/>' +
            '<path d="M81 29 c0 -5 1 -21 2 -23 c1.2 -2.4 32.8 -2.4 34 0 c1 2 2 18 2 23 z" fill="#18202e"/>' +
            '<rect class="cd-band" x="81" y="21" width="38" height="7" rx="2"/>' +
            '<ellipse cx="100" cy="6.5" rx="17" ry="4" fill="#1d2636"/>' +
          '</g>' +
        '</g>' +
      '</svg>';
  }

  function mountDealer(stage) {
    if (stage.querySelector(':scope > .card-dealer')) return stage.querySelector(':scope > .card-dealer');
    const host = document.createElement('div');
    host.className = 'card-dealer';
    host.setAttribute('aria-hidden', 'true');
    host.innerHTML = dealerSVG();
    stage.insertBefore(host, stage.firstChild);
    return host;
  }

  // Flick the croupier's hands. Fires once per card as that card leaves, so a
  // four-card deal is four flicks rather than one shrug at the start.
  function dealGesture(stage, delay) {
    const host = stage.querySelector(':scope > .card-dealer');
    if (!host || reduced()) return;
    setTimeout(() => {
      if (!host.isConnected) return;
      host.classList.remove('dealing');
      void host.offsetWidth;                     // restart the animation
      host.classList.add('dealing');
      setTimeout(() => host.classList.remove('dealing'), 420);
    }, delay || 0);
  }

  // Fly one card from the dealer's hands into its slot.
  function flyIn(card, stage, order) {
    const host = stage.querySelector(':scope > .card-dealer');
    const cr = card.getBoundingClientRect();
    if (!cr.width) return;
    // Yield to a game that animates its own cards. Red Dog flips each card with
    // `.rd-card.flip .pcard { animation: rdFlip }`, and because our rule is
    // later in the stylesheet the fly-in silently replaced that reveal. If the
    // card already has an animation of its own, let it play.
    const own = global.getComputedStyle(card).animationName;
    if (own && own !== 'none' && own !== 'cdDeal') return;
    let dx = 0, dy = -140;
    // Measure the deck in his hands, not the dealer container: the container is
    // full-width, so its centre only lines up with the deck by coincidence.
    const src = (host && host.querySelector('.cd-deck')) || host;
    if (src) {
      const hr = src.getBoundingClientRect();
      dx = (hr.left + hr.width / 2) - (cr.left + cr.width / 2);
      dy = (hr.top + hr.height / 2) - (cr.top + cr.height / 2);
    }
    card.style.setProperty('--cd-dx', dx.toFixed(1) + 'px');
    card.style.setProperty('--cd-dy', dy.toFixed(1) + 'px');
    // A little variation per card so a dealt hand doesn't look stamped out.
    const jitter = -22 + ((order * 7) % 11);
    card.style.setProperty('--cd-rot', jitter + 'deg');
    card.style.setProperty('--cd-dur', (DEAL_MS + ((order * 13) % 70)) + 'ms');
    card.style.animationDelay = (order * STAGGER_MS) + 'ms';
    card.classList.add('cd-deal');
    const done = () => {
      card.classList.remove('cd-deal');
      card.style.animationDelay = '';
      card.style.removeProperty('--cd-dx');
      card.style.removeProperty('--cd-dy');
      card.style.removeProperty('--cd-rot');
      card.style.removeProperty('--cd-dur');
    };
    setTimeout(done, DEAL_MS + 70 + order * STAGGER_MS + 90);
  }

  // Card containers differ per game: most use .cards-row, reddog drops .pcard
  // straight into its felt, video poker wraps each card in a .vp-slot, and war
  // uses .war-card.
  //
  // Deciding what is NEW took three tries. Counting cards per container broke
  // video poker, whose slot holds exactly one card: the count never grew, so
  // every unrelated mutation in the pane re-dealt it forever. Tracking card
  // ELEMENTS broke blackjack, which rebuilds its whole row with innerHTML, so
  // hitting replaced every element and re-dealt the entire hand.
  //
  // What actually identifies a card is its face. Remember the faces a container
  // last held, keep the matching prefix, and deal the rest.
  const CARD_SEL = '.pcard, .war-card';
  const lastFaces = new WeakMap();          // container -> [face, ...]
  const faceOf = (c) => c.className + '|' + (c.textContent || '');

  // Which stages are card tables. Keyed on the stage class the game passes to
  // GameKit.frame, so the croupier is present the moment the game opens rather
  // than popping in only once the first card lands. aidealer-stage is absent on
  // purpose: it ships its own dealer portrait.
  const CARD_STAGES = ['bj-stage', 'cards-stage', 'tcp-stage', 'andar-stage', 'war-stage', 'reddog-stage'];
  const isCardStage = (st) => CARD_STAGES.some((c) => st.classList.contains(c));

  function containersIn(stage) {
    const set = new Set();
    stage.querySelectorAll(CARD_SEL).forEach((c) => { if (c.parentElement) set.add(c.parentElement); });
    return set;
  }

  function refresh() {
    const pane = document.getElementById('gamePane');
    if (!pane) return;
    pane.querySelectorAll('.stage').forEach((stage) => {
      if (stage.classList.contains('aidealer-stage')) return;
      if (!isCardStage(stage) && !stage.querySelector(CARD_SEL)) return;
      mountDealer(stage);
      if (reduced()) return;

      // Collect what to deal first, then stagger across the whole table, so a
      // hand spread over several containers still deals one card at a time.
      const fresh = [];
      containersIn(stage).forEach((box) => {
        const cards = [...box.children].filter((c) => c.matches && c.matches(CARD_SEL));
        if (!cards.length) return;
        const faces = cards.map(faceOf);
        const prev = lastFaces.get(box) || [];
        let keep = 0;
        while (keep < faces.length && keep < prev.length && faces[keep] === prev[keep]) keep++;
        lastFaces.set(box, faces);
        for (let i = keep; i < cards.length; i++) fresh.push(cards[i]);
      });
      if (!fresh.length) return;
      // Deal in visual order rather than container order.
      fresh.sort((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        return (ra.top - rb.top) || (ra.left - rb.left);
      });
      fresh.forEach((card, order) => {
        flyIn(card, stage, order);
        dealGesture(stage, order * STAGGER_MS);
      });
    });
  }

  function scan() { refresh(); }

  function start() {
    const pane = document.getElementById('gamePane');
    if (!pane || observer) return;
    let queued = false;
    observer = new MutationObserver(() => {
      if (queued) return;            // coalesce bursts into one pass per frame
      queued = true;
      requestAnimationFrame(() => { queued = false; refresh(); });
    });
    observer.observe(pane, { childList: true, subtree: true });
    scan();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  global.CardDealer = { start, scan };
})(window);
