/* App bootstrap: auth gate, topbar wiring, Fair + Stats modals, game router,
 * and a small toast utility. The server is the source of truth for balance,
 * seeds and history; this file orchestrates the UI around it. */
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

  // ----- Elements -----
  const authGate = document.getElementById('authGate');
  const appEl = document.getElementById('app');
  const authForm = document.getElementById('authForm');
  const authUser = document.getElementById('authUser');
  const authPass = document.getElementById('authPass');
  const authError = document.getElementById('authError');
  const authSubmit = document.getElementById('authSubmit');
  const authTabs = document.querySelectorAll('.auth-tab');
  let authMode = 'login';

  // ----- Auth gate -----
  authTabs.forEach(t => t.addEventListener('click', () => {
    authTabs.forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    authMode = t.dataset.auth;
    authSubmit.textContent = authMode === 'login' ? 'Sign In' : 'Create Account';
    authPass.setAttribute('autocomplete', authMode === 'login' ? 'current-password' : 'new-password');
    authError.textContent = '';
  }));

  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    authError.textContent = '';
    const u = authUser.value.trim();
    const p = authPass.value;
    if (!u || !p) { authError.textContent = 'Enter a username and password.'; return; }
    authSubmit.disabled = true;
    try {
      const res = authMode === 'login' ? await API.login(u, p) : await API.register(u, p);
      bootApp(res.user);
    } catch (err) {
      authError.textContent = err.message || 'Something went wrong.';
    } finally {
      authSubmit.disabled = false;
    }
  });

  // ----- Topbar / user menu -----
  const userName = document.getElementById('userName');
  const btnUser = document.getElementById('btnUser');
  const userDropdown = document.getElementById('userDropdown');
  const btnLogout = document.getElementById('btnLogout');

  btnUser.addEventListener('click', (e) => {
    e.stopPropagation();
    userDropdown.classList.toggle('hidden');
  });
  document.addEventListener('click', () => userDropdown.classList.add('hidden'));
  btnLogout.addEventListener('click', async () => {
    try { await API.logout(); } catch (e) {}
    location.reload();
  });

  // ----- Fair modal -----
  const fairModal = document.getElementById('fairModal');
  const fairServerHash = document.getElementById('fairServerHash');
  const fairServerSeed = document.getElementById('fairServerSeed');
  const fairClientSeed = document.getElementById('fairClientSeed');
  const fairNonce = document.getElementById('fairNonce');
  const fairHistory = document.getElementById('fairHistory');

  function renderFairState(s) {
    fairServerHash.value = s.serverHash || '';
    fairServerSeed.value = s.revealedSeed || '';
    fairClientSeed.value = s.clientSeed || '';
    fairNonce.value = s.nonce || 0;
  }
  async function renderFairHistory() {
    let rolls = [];
    try { rolls = await Fair.getHistory(30); } catch (e) {}
    fairHistory.innerHTML = '';
    rolls.forEach(e => {
      const li = document.createElement('li');
      const time = new Date(e.ts).toLocaleTimeString(undefined, { hour12: false });
      const result = e.win ? `${e.mult.toFixed(2)}×` : 'loss';
      li.innerHTML =
        `<span style="color:var(--muted)">${e.game}</span>` +
        `<span style="color:${e.win ? 'var(--accent)' : 'var(--danger)'}">${result}</span>` +
        `<span style="color:var(--text)">${Bankroll.fmt(e.bet)}</span>` +
        `<span style="color:var(--muted);text-align:right">${time}</span>`;
      fairHistory.appendChild(li);
    });
  }
  async function openFair() {
    await Fair.refresh();
    renderFairState(Fair.getState());
    renderFairHistory();
    fairModal.classList.remove('hidden');
  }
  document.getElementById('btnFair').addEventListener('click', openFair);
  document.getElementById('fairClose').addEventListener('click', () => fairModal.classList.add('hidden'));
  fairModal.addEventListener('click', (e) => { if (e.target === fairModal) fairModal.classList.add('hidden'); });
  document.getElementById('fairRotate').addEventListener('click', async () => {
    try {
      const r = await Fair.rotate();
      renderFairState(Fair.getState());
      renderFairHistory();
      Toast.info(`Seed rotated — previous seed revealed (${r.finalNonce} bets).`);
    } catch (e) { Toast.error(e.message); }
  });
  document.getElementById('fairUpdateClient').addEventListener('click', async () => {
    const v = fairClientSeed.value.trim();
    if (!v) return Toast.warn('Client seed cannot be empty');
    try {
      await Fair.setClientSeed(v);
      renderFairState(Fair.getState());
      Toast.info('Client seed updated. Nonce reset.');
    } catch (e) { Toast.error(e.message); }
  });
  Fair.subscribe(renderFairState);

  // ----- Stats modal -----
  const statsModal = document.getElementById('statsModal');
  document.getElementById('btnStats').addEventListener('click', async () => {
    try {
      const s = await API.stats();
      document.getElementById('stBets').textContent = s.bets;
      document.getElementById('stWagered').textContent = Bankroll.fmt(s.wagered);
      const profitEl = document.getElementById('stProfit');
      profitEl.textContent = (s.profit >= 0 ? '+' : '−') + Bankroll.fmt(Math.abs(s.profit));
      profitEl.style.color = s.profit >= 0 ? 'var(--accent)' : 'var(--danger)';
      document.getElementById('stWinRate').textContent = (s.winRate * 100).toFixed(1) + '%';
      document.getElementById('stBiggest').textContent = Bankroll.fmt(s.biggestWin);
      document.getElementById('stWins').textContent = s.wins;
      // Refresh progression snapshot so the achievements list is current,
      // then render unlocked + locked rows with short descriptions and XP rewards.
      try {
        const ps = await Progression.refresh();
        const ul = document.getElementById('achList');
        const cnt = document.getElementById('achCount');
        const unlocked = ps.achievements.filter(a => a.unlocked).length;
        cnt.textContent = `${unlocked} / ${ps.achievements.length}`;
        ul.innerHTML = ps.achievements.map(a => `
          <li class="ach-row ${a.unlocked ? 'unlocked' : 'locked'}">
            <div class="ach-icon">${a.unlocked ? '🏆' : '·'}</div>
            <div class="ach-body">
              <div class="ach-name">${a.name}</div>
              <div class="ach-desc muted">${a.desc}</div>
            </div>
            <div class="ach-xp ${a.unlocked ? 'unlocked' : 'muted'}">${a.xp ? '+' + a.xp + ' XP' : ''}</div>
          </li>
        `).join('');
      } catch (_) {}
      statsModal.classList.remove('hidden');
    } catch (e) { Toast.error(e.message); }
  });
  document.getElementById('statsClose').addEventListener('click', () => statsModal.classList.add('hidden'));
  statsModal.addEventListener('click', (e) => { if (e.target === statsModal) statsModal.classList.add('hidden'); });

  // ----- Leaderboard modal -----
  const leadersModal = document.getElementById('leadersModal');
  let lbMetric = 'xp';
  function fmtLbValue(v, metric) {
    if (metric === 'biggest') return (+v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (metric === 'xp')      return (+v).toLocaleString();
    return v;
  }
  async function loadLeaderboard(metric) {
    try {
      const r = await API.leaderboard(metric, 10);
      const list = document.getElementById('lbList');
      list.innerHTML = r.top.length
        ? r.top.map(row => `
            <li class="lb-row ${row.isYou ? 'you' : ''}">
              <span class="lb-rank">${row.rank}</span>
              <span class="lb-player">${row.player}${row.isYou ? ' <span class="muted">(you)</span>' : ''}</span>
              <span class="lb-level">L${row.level}</span>
              <span class="lb-value">${fmtLbValue(row.value, metric)}</span>
            </li>`).join('')
        : `<li class="feed-empty">No data yet — be the first.</li>`;
      const youEl = document.getElementById('lbYou');
      if (r.you && r.top.every(t => !t.isYou)) {
        youEl.innerHTML = `
          <span class="lb-rank">#${r.you.rank}</span>
          <span class="lb-player">You</span>
          ${r.you.level ? `<span class="lb-level">L${r.you.level}</span>` : ''}
          <span class="lb-value">${fmtLbValue(r.you.value, metric)}</span>`;
        youEl.classList.remove('hidden');
      } else {
        youEl.classList.add('hidden');
      }
    } catch (e) { Toast.error(e.message); }
  }
  document.getElementById('btnLeaders').addEventListener('click', () => {
    leadersModal.classList.remove('hidden');
    loadLeaderboard(lbMetric);
  });
  document.getElementById('leadersClose').addEventListener('click', () => leadersModal.classList.add('hidden'));
  leadersModal.addEventListener('click', e => { if (e.target === leadersModal) leadersModal.classList.add('hidden'); });
  document.querySelectorAll('.lb-tab').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.lb-tab').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    lbMetric = b.dataset.metric;
    loadLeaderboard(lbMetric);
  }));

  document.addEventListener('keydown', e => {
    // Don't hijack typing in form fields.
    const t = e.target;
    const isFormField = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);

    if (e.key === 'Escape') {
      fairModal.classList.add('hidden');
      statsModal.classList.add('hidden');
      const daily = document.getElementById('dailyModal');
      if (daily) daily.classList.add('hidden');
      const leaders = document.getElementById('leadersModal');
      if (leaders) leaders.classList.add('hidden');
      return;
    }
    // Space / Enter trigger the primary action of the currently mounted game,
    // or claim the daily bonus if its modal is up. Instant gratification.
    if (!isFormField && (e.key === ' ' || e.key === 'Enter')) {
      const daily = document.getElementById('dailyModal');
      if (daily && !daily.classList.contains('hidden')) {
        e.preventDefault();
        const claim = document.getElementById('dailyClaim');
        if (claim && !claim.disabled) claim.click();
        return;
      }
      const primary = document.querySelector('#gamePane .btn-primary:not([disabled])');
      if (primary) {
        e.preventDefault();
        primary.click();
      }
    }
  });

  // ----- Game router -----
  const pane = document.getElementById('gamePane');
  const tabs = document.querySelectorAll('.tab');
  let unmount = null;
  function mount(game) {
    if (typeof unmount === 'function') { try { unmount(); } catch (e) {} unmount = null; }
    const fn = (global.Games || {})[game];
    if (!fn) { pane.innerHTML = `<div style="padding:40px;text-align:center;color:var(--muted)">Game not found.</div>`; return; }
    unmount = fn(pane);
  }
  tabs.forEach(t => t.addEventListener('click', () => {
    tabs.forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    const g = t.dataset.game;
    try { localStorage.setItem('neonstake.lastGame', g); } catch (e) {}
    mount(g);
  }));

  // ----- Boot -----
  function bootApp(user) {
    Bankroll.set(user.balance);
    userName.textContent = user.username;
    Bankroll.bindElement(document.getElementById('balanceValue'));
    Feed.init(document.getElementById('feedList'));
    Fair.refresh();
    // Seed progression UI from the cheap fields on /api/me, then init() pulls
    // the full snapshot (achievements list + daily state) and pops the bonus
    // modal if today's claim is available.
    if (global.Progression) { Progression.seed(user); Progression.init(); }

    authGate.classList.add('hidden');
    appEl.classList.remove('hidden');

    let initial = 'crash';
    try { initial = localStorage.getItem('neonstake.lastGame') || 'crash'; } catch (e) {}
    const initTab = Array.from(tabs).find(t => t.dataset.game === initial) || tabs[0];
    tabs.forEach(x => x.classList.remove('active'));
    initTab.classList.add('active');
    mount(initTab.dataset.game);
  }

  // Check for an existing session.
  (async function init() {
    try {
      const { user } = await API.me();
      if (user) { bootApp(user); return; }
    } catch (e) {}
    authGate.classList.remove('hidden');
    authUser.focus();
  })();
})(window);
