'use strict';

/* Pre-paint skin boot. Loaded synchronously in <head> so the saved skin is on
   <html> before the body renders — no flash. Kept external (not inline) because
   the page's CSP is script-src 'self' with no unsafe-inline. Default: Boneyard. */
(function () {
  try {
    const s = localStorage.getItem('crypt.skin');
    document.documentElement.dataset.skin = (s === 'neon') ? 'neon' : 'boneyard';
  } catch (e) {
    document.documentElement.dataset.skin = 'boneyard';
  }
})();
