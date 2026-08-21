'use strict';

/* Bones — the graveyard floor host. A friendly animated skeleton dealer.
   Provides the SVG markup (used by the lobby greeter) and a one-shot "cheer"
   that fires on big wins. All motion lives in CSS (.bones *), so this file is
   just markup + a win listener. Shows only in the Boneyard skin (the greeter's
   container is display:none off-skin). */
(function (global) {
  const SVG =
  '<svg class="bones" viewBox="0 0 260 300" role="img" aria-label="Bones, a friendly skeleton dealer holding cards">' +
    '<ellipse class="b-aura" cx="130" cy="150" rx="96" ry="108"/>' +
    '<g class="b-char">' +
      '<g fill="var(--text)">' +
        '<rect x="122" y="150" width="16" height="9" rx="3"/>' +
        '<rect x="121" y="161" width="18" height="9" rx="3"/>' +
      '</g>' +
      '<g fill="var(--text)" stroke="#cbc3a8" stroke-width="1">' +
        '<rect x="78" y="176" width="104" height="13" rx="6.5"/>' +
        '<rect x="80" y="182" width="13" height="40" rx="6.5"/>' +
        '<rect x="167" y="182" width="13" height="40" rx="6.5"/>' +
        '<circle cx="86" cy="224" r="10"/><circle cx="174" cy="224" r="10"/>' +
      '</g>' +
      '<g class="b-cards">' +
        '<g transform="rotate(-17 130 250)"><rect x="106" y="196" width="40" height="58" rx="6" fill="#f4eede" stroke="#cbb" stroke-width="1"/></g>' +
        '<g transform="rotate(-6 130 250)"><rect x="108" y="192" width="40" height="58" rx="6" fill="#fbf6e6" stroke="#cbb" stroke-width="1"/></g>' +
        '<g transform="rotate(6 130 250)"><rect x="112" y="192" width="40" height="58" rx="6" fill="#fbf6e6" stroke="#cbb" stroke-width="1"/></g>' +
        '<g transform="rotate(16 130 250)">' +
          '<rect x="114" y="196" width="42" height="60" rx="6" fill="#fffdf4" stroke="#b9b090" stroke-width="1"/>' +
          '<text class="b-pip" x="121" y="213" font-family="Georgia, serif" font-size="14" font-weight="700">A</text>' +
          '<path class="b-pip" d="M135 218 c-9 9 -14 13 -14 20 a6 6 0 0 0 11 3 c-1 4 -2 6 -4 8 h14 c-2 -2 -3 -4 -4 -8 a6 6 0 0 0 11 -3 c0 -7 -5 -11 -14 -20 z"/>' +
        '</g>' +
      '</g>' +
      '<g class="b-skull">' +
        '<path fill="var(--text)" stroke="#d7cfb4" stroke-width="1.4" d="M130 52 c-34 0 -56 24 -56 54 c0 20 10 33 22 40 c2 8 1 15 5 18 c4 3 10 2 15 2 h28 c5 0 11 1 15 -2 c4 -3 3 -10 5 -18 c12 -7 22 -20 22 -40 c0 -30 -22 -54 -56 -54 z"/>' +
        '<ellipse cx="110" cy="104" rx="15" ry="17" fill="#0c1018"/>' +
        '<ellipse cx="150" cy="104" rx="15" ry="17" fill="#0c1018"/>' +
        '<g class="b-lid">' +
          '<circle class="b-glow" cx="110" cy="106" r="8"/><circle class="b-pupil" cx="110" cy="106" r="6"/><circle cx="107.5" cy="103.5" r="2.2" fill="#fff"/>' +
          '<circle class="b-glow" cx="150" cy="106" r="8"/><circle class="b-pupil" cx="150" cy="106" r="6"/><circle cx="147.5" cy="103.5" r="2.2" fill="#fff"/>' +
        '</g>' +
        '<ellipse class="b-blush" cx="94" cy="126" rx="9" ry="6"/><ellipse class="b-blush" cx="166" cy="126" rx="9" ry="6"/>' +
        '<path d="M130 116 l-6 12 h12 z" fill="#0c1018"/>' +
        '<path d="M108 138 q22 20 44 0" fill="none" stroke="#0c1018" stroke-width="3" stroke-linecap="round"/>' +
        '<g stroke="#0c1018" stroke-width="2"><line x1="118" y1="140" x2="118" y2="147"/><line x1="130" y1="143" x2="130" y2="150"/><line x1="142" y1="140" x2="142" y2="147"/></g>' +
        '<path class="b-bow" d="M130 170 l-16 -8 v16 z M130 170 l16 -8 v16 z"/><circle class="b-bow" cx="130" cy="170" r="4"/>' +
      '</g>' +
      '<g class="b-hat">' +
        '<ellipse cx="130" cy="86" rx="50" ry="11" fill="#10151f"/>' +
        '<path d="M104 86 c0 -6 2 -40 3 -44 c1 -4 40 -4 46 0 c1 4 3 38 3 44 z" fill="#161c28"/>' +
        '<rect class="b-band" x="104" y="74" width="52" height="9" rx="2"/>' +
        '<ellipse cx="130" cy="42" rx="26" ry="6" fill="#1b2333"/>' +
      '</g>' +
    '</g>' +
  '</svg>';

  function markup() { return SVG; }

  // One-shot cheer: hat pops, eyes flare. Applied to every mounted Bones.
  function cheer() {
    document.querySelectorAll('.bones').forEach(function (el) {
      el.classList.remove('cheer');
      void el.offsetWidth;          // restart the animation
      el.classList.add('cheer');
      setTimeout(function () { el.classList.remove('cheer'); }, 1200);
    });
  }

  // Big wins (WinFx) dispatch crypt:win — Bones celebrates in the Boneyard skin.
  document.addEventListener('crypt:win', function () {
    if (document.documentElement.dataset.skin !== 'neon') cheer();
  });

  global.Bones = { markup: markup, cheer: cheer };
})(window);
