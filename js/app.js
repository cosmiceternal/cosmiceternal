/* App router. Wires the topbar tabs to the four game mounters, hooks up the
 * Fair modal, the bankroll display, the bet feed, and a tiny toast utility. */
(function (global) {
  'use strict';

  // ----- Toast -----
  const toastStack = document.getElementById('toasts');
  function makeToast(msg, kind, ttl = 2400) {
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    toastStack.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity 0.3s, transform 0.3s';
      el.style.opacity = '0';
      el.style.transform = 'translateX(40px)';
      setTimeout(() => el.remove(), 320);
    }, ttl);
  }
  global.Toast = {
    info:  m => makeToast(m, ''),
    win:   m => makeToast(m, ''),
    loss:  m => makeToast(m, 'warn'),
    warn:  m => makeToast(m, 'warn'),
    error: m => makeToast(m, 'error'),
  };

  // ----- Bankroll wiring -----
  Bankroll.bindElement(document.getElementById('balanceValue'));
  document.getElementById('btnReset').addEventListener('click', () => {
    if (confirm('Reset your balance to 1000.00?')) {
      Bankroll.reset();
      Toast.info('Balance reset to 1,000.00');
    }
  });

  // ----- Feed -----
  Feed.init(document.getElementById('feedList'));

  // ----- Fair modal -----
  const fairModal = document.getElementById('fairModal');
  const btnFair = document.getElementById('btnFair');
  const btnFairClose = document.getElementById('fairClose');
  const fairServerHash = document.getElementById('fairServerHash');
  const fairServerSeed = document.getElementById('fairServerSeed');
  const fairClientSeed = document.getElementById('fairClientSeed');
  const fairNonce = document.getElementById('fairNonce');
  const fairRotate = document.getElementById('fairRotate');
  const fairUpdateClient = document.getElementById('fairUpdateClient');
  const fairHistory = document.getElementById('fairHistory');

  function refreshFair() {
    const s = Fair.getState();
    fairServerHash.value = s.serverHash;
    fairServerSeed.value = s.revealedSeed || '';
    fairClientSeed.value = s.clientSeed;
    fairNonce.value = s.nonce;
    const h = Fair.getHistory().slice(-30).reverse();
    fairHistory.innerHTML = '';
    h.forEach(e => {
      const li = document.createElement('li');
      const t = new Date(e.ts);
      const time = t.toLocaleTimeString(undefined, { hour12: false });
      li.innerHTML = `
        <span style="color:var(--muted)">#${e.nonce}</span>
        <span style="color:var(--accent)">${e.game}</span>
        <span style="color:var(--text)">${e.result}</span>
        <span style="color:var(--muted);text-align:right">${time}</span>
      `;
      fairHistory.appendChild(li);
    });
  }

  btnFair.addEventListener('click', () => {
    refreshFair();
    fairModal.classList.remove('hidden');
  });
  btnFairClose.addEventListener('click', () => fairModal.classList.add('hidden'));
  fairModal.addEventListener('click', (e) => {
    if (e.target === fairModal) fairModal.classList.add('hidden');
  });
  fairRotate.addEventListener('click', () => {
    const old = Fair.rotate();
    refreshFair();
    Toast.info(`Server seed rotated. Old seed revealed (used for ${old.finalNonce} rolls).`);
  });
  fairUpdateClient.addEventListener('click', () => {
    const v = fairClientSeed.value.trim();
    if (!v) return Toast.warn('Client seed cannot be empty');
    Fair.setClientSeed(v);
    refreshFair();
    Toast.info('Client seed updated. Nonce reset.');
  });
  Fair.subscribe(refreshFair);

  // ----- Game router -----
  const pane = document.getElementById('gamePane');
  let unmount = null;
  function mount(game) {
    if (typeof unmount === 'function') {
      try { unmount(); } catch (e) {}
      unmount = null;
    }
    const fn = (global.Games || {})[game];
    if (!fn) {
      pane.innerHTML = `<div style="padding:40px;text-align:center;color:var(--muted)">Game "${game}" not found.</div>`;
      return;
    }
    unmount = fn(pane);
  }

  const tabs = document.querySelectorAll('.tab');
  tabs.forEach(t => {
    t.addEventListener('click', () => {
      tabs.forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      const g = t.dataset.game;
      try { localStorage.setItem('neonstake.lastGame', g); } catch (e) {}
      mount(g);
    });
  });

  // Restore last game
  const initial = (() => {
    try { return localStorage.getItem('neonstake.lastGame') || 'crash'; }
    catch (e) { return 'crash'; }
  })();
  const initTab = Array.from(tabs).find(t => t.dataset.game === initial) || tabs[0];
  tabs.forEach(x => x.classList.remove('active'));
  initTab.classList.add('active');
  mount(initial);

  // Esc closes the modal
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !fairModal.classList.contains('hidden')) {
      fairModal.classList.add('hidden');
    }
  });
})(window);
