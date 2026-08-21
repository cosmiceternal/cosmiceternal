'use strict';

/* Skin toggle — Moonlit Boneyard (graveyard) <-> Neon (original).
   The skin itself is pure CSS keyed off html[data-skin]; this only flips the
   attribute, persists the choice, and swaps the brand glyph. The pre-paint
   inline script in <head> sets the initial attribute so there's no flash. */
(function () {
  const root = document.documentElement;

  function isBone() { return root.dataset.skin !== 'neon'; }

  function paintBrand() {
    const bone = isBone();
    // Brand marks (auth card + topbar): skull in the crypt, star in neon.
    document.querySelectorAll('.brand-mark').forEach(function (el) {
      el.textContent = bone ? '💀' : '✦';
    });
    const btn = document.getElementById('btnSkin');
    if (btn) {
      btn.textContent = bone ? '💀' : '✦';
      btn.title = bone ? 'Graveyard theme: on — switch to Neon' : 'Graveyard theme: off — switch to Boneyard';
      btn.setAttribute('aria-pressed', String(bone));
    }
  }

  function apply(skin) {
    root.dataset.skin = skin;
    try { localStorage.setItem('crypt.skin', skin); } catch (e) { /* ignore */ }
    paintBrand();
  }

  function toggle() { apply(isBone() ? 'neon' : 'boneyard'); }

  function init() {
    paintBrand();
    const btn = document.getElementById('btnSkin');
    if (btn) btn.addEventListener('click', toggle);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.CryptSkin = { toggle: toggle, apply: apply, isBoneyard: isBone };
})();
