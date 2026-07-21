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
  document.getElementById('btnMenuHelp')?.addEventListener('click', () => {
    userDropdown.classList.add('hidden');
    if (window.Help) Help.open();
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
      // Any bet recorded with its fairness coordinates can be loaded straight
      // into the verifier and re-derived once its server seed is revealed.
      if (e.nonce != null && e.serverHash) {
        li.classList.add('verifiable');
        li.title = 'Click to verify this bet';
        li.addEventListener('click', () => loadBetIntoVerifier(e));
      }
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
  // Remember the seed→hash commitment disclosed at the last rotation, so the
  // verifier can prove the revealed seed matches the hash it was committed
  // under (NOT the freshly-minted current hash).
  let lastRevealed = { seed: '', hash: '' };
  let fvExpectedHash = ''; // the commitment the loaded seed/bet should match
  document.getElementById('fairRotate').addEventListener('click', async () => {
    try {
      const r = await Fair.rotate();
      lastRevealed = { seed: r.revealedSeed || '', hash: r.revealedHash || '' };
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
      Toast.info('Client seed updated.');
    } catch (e) { Toast.error(e.message); }
  });
  Fair.subscribe(renderFairState);

  // Copy buttons on the seed / hash fields (long hex → easy to paste elsewhere).
  document.querySelectorAll('#fairModal .copy-btn').forEach(btn => btn.addEventListener('click', async () => {
    const el = document.getElementById(btn.dataset.copy);
    const val = (el && el.value) || '';
    if (!val) return;
    try { await navigator.clipboard.writeText(val); }
    catch (_) { try { el.select(); document.execCommand('copy'); } catch (e2) {} }
    const old = btn.textContent; btn.textContent = '✓'; btn.classList.add('copied');
    setTimeout(() => { btn.textContent = old; btn.classList.remove('copied'); }, 1000);
  }));

  // Independent verifier: recompute the raw HMAC float stream in-browser.
  const fvSeed = document.getElementById('fvSeed'), fvClient = document.getElementById('fvClient'),
        fvNonce = document.getElementById('fvNonce'), fvCount = document.getElementById('fvCount'),
        fvResult = document.getElementById('fvResult');
  document.getElementById('fvPrefill').addEventListener('click', () => {
    const s = Fair.getState();
    fvSeed.value = s.revealedSeed || '';
    fvClient.value = s.clientSeed || '';
    fvNonce.value = 0;
    fvExpectedHash = lastRevealed.hash || '';
    if (!s.revealedSeed) Toast.warn('Rotate the server seed first to reveal one.');
  });
  // Load a past bet (from the Recent Rolls list) into the verifier.
  function loadBetIntoVerifier(roll) {
    if (roll.nonce == null || !roll.serverHash) { Toast.warn('This bet predates per-bet verification.'); return; }
    fvExpectedHash = roll.serverHash;
    fvClient.value = roll.clientSeed || '';
    fvNonce.value = roll.nonce;
    if (lastRevealed.hash && lastRevealed.hash === roll.serverHash && lastRevealed.seed) {
      // The seed this bet used has already been revealed → verify immediately.
      fvSeed.value = lastRevealed.seed;
      document.getElementById('fvRun').click();
    } else {
      fvSeed.value = '';
      fvResult.innerHTML = `<div class="fv-commit">Loaded <b>${roll.game}</b> at nonce ${roll.nonce}. Rotate the server seed this bet used to reveal it, then press Verify — or paste the revealed seed.</div>`;
    }
    const box = document.querySelector('.fair-verify');
    if (box) box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  document.getElementById('fvRun').addEventListener('click', async () => {
    const seed = fvSeed.value.trim(), client = fvClient.value.trim();
    const nonce = Math.max(0, parseInt(fvNonce.value, 10) || 0);
    const count = Math.min(20, Math.max(1, parseInt(fvCount.value, 10) || 8));
    if (!Fair.hasSubtle()) { fvResult.innerHTML = '<span class="fv-bad">Verification needs a secure (https) page.</span>'; return; }
    if (!seed) { fvResult.innerHTML = '<span class="fv-bad">Enter a server seed to verify.</span>'; return; }
    fvResult.innerHTML = '<span class="muted">Computing…</span>';
    try {
      const [hash, floats] = await Promise.all([Fair.sha256Hex(seed), Fair.floatsFrom(seed, client, nonce, count)]);
      // Compare sha256(seed) against the commitment we're verifying against — a
      // loaded past bet's hash, or the seed disclosed at the last rotation.
      const target = fvExpectedHash || (seed === lastRevealed.seed ? lastRevealed.hash : '');
      let commit;
      if (target) {
        const ok = hash === target;
        commit = `<div class="fv-commit ${ok ? 'ok' : 'bad'}">${ok ? '✓ sha256(seed) matches the hash committed before this bet — genuine.' : '✕ sha256(seed) does NOT match the committed hash for this bet.'}</div>`;
      } else {
        commit = `<div class="fv-commit">sha256(seed) = <code>${hash.slice(0, 24)}…</code> <span class="muted">— compare this to the hash you saved before playing.</span></div>`;
      }
      const list = floats.map((f, i) => `<li><span class="fvf-i">#${i}</span><code>${f.toFixed(8)}</code></li>`).join('');
      fvResult.innerHTML = commit + `<ol class="fv-floats">${list}</ol>` +
        `<p class="muted fv-foot">Raw floats HMAC-SHA256 draws for nonce ${nonce}. Each game turns them into its result (a card, a multiplier, a grid…). Same inputs → same floats, every time.</p>`;
    } catch (e) {
      fvResult.innerHTML = `<span class="fv-bad">Could not compute: ${e.message}</span>`;
    }
  });

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
            <div class="ach-icon">${a.unlocked ? '🏆' : '🔒'}</div>
            <div class="ach-body">
              <div class="ach-name">${a.name}</div>
              <div class="ach-desc muted">${a.desc}</div>
            </div>
            <div class="ach-xp ${a.unlocked ? 'unlocked' : ''}">${a.xp ? '+' + a.xp + ' XP' : ''}</div>
          </li>
        `).join('');
      } catch (_) {}
      // Overview charts: profit trend + per-game breakdown (non-blocking).
      API.statsDetail().then(d => {
        if (window.PlayerStats) {
          PlayerStats.renderTrend(document.getElementById('stChart'), d.series);
          PlayerStats.renderGames(document.getElementById('stGames'), d.perGame);
        }
        const lbl = document.getElementById('stTrendLabel');
        if (lbl) lbl.textContent = 'last ' + d.days + ' days';
      }).catch(() => {});
      if (window.PlayerStats) PlayerStats.reset();
      statsModal.classList.remove('hidden');
    } catch (e) { Toast.error(e.message); }
  });
  // Tab switching + lazy-load the bet History the first time it's opened.
  if (window.PlayerStats) {
    PlayerStats.init(async () => {
      try { const r = await API.history(60); PlayerStats.renderHistory(document.getElementById('stHistory'), r.bets); }
      catch (_) {}
    });
  }
  document.getElementById('statsClose').addEventListener('click', () => statsModal.classList.add('hidden'));
  statsModal.addEventListener('click', (e) => { if (e.target === statsModal) statsModal.classList.add('hidden'); });

  // ----- Leaderboard modal -----
  const leadersModal = document.getElementById('leadersModal');
  let lbMetric = 'xp';
  function fmtLbValue(v, metric) {
    if (metric === 'biggest') return Bankroll.fmtCompact(+v);
    if (metric === 'xp')      return Bankroll.fmtCompact(+v);
    return v;
  }
  // ----- Hourly race (inside the leaderboard modal) -----
  let raceTimer = null;
  function stopRaceCountdown() { if (raceTimer) { clearInterval(raceTimer); raceTimer = null; } }
  async function loadRace() {
    try {
      const r = await API.race();
      const list = document.getElementById('lbList');
      const banner = document.getElementById('raceBanner');
      banner.classList.remove('hidden');
      document.getElementById('racePrizes').textContent =
        `Prizes ${r.prizes.map((p, i) => `#${i + 1} ${Bankroll.fmt(p)}`).join(' · ')} — wager ${Bankroll.fmt(r.minWager)}+ to qualify`;
      stopRaceCountdown();
      const cd = document.getElementById('raceCountdown');
      const tick = () => {
        const left = Math.max(0, r.endsAt - Date.now());
        const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
        cd.textContent = `🏁 Ends in ${m}:${String(s).padStart(2, '0')}`;
        if (left <= 0) { stopRaceCountdown(); loadRace(); }
      };
      tick();
      raceTimer = setInterval(tick, 1000);
      list.innerHTML = r.top.length
        ? r.top.map(row => `
            <li class="lb-row">
              <span class="lb-rank">${row.rank <= 3 ? ['🥇','🥈','🥉'][row.rank - 1] : row.rank}</span>
              <span class="lb-player">${row.player}</span>
              <span class="lb-level">L${row.level}</span>
              <span class="lb-value">${Bankroll.fmtCompact(row.wagered)}</span>
            </li>`).join('')
        : `<li class="feed-empty">No wagers this hour yet — every bet counts toward the race.</li>`;
      const youEl = document.getElementById('lbYou');
      if (r.you && !r.top.some(t => t.userId === r.you.userId)) {
        youEl.innerHTML = `
          <span class="lb-rank">${r.you.rank ? '#' + r.you.rank : '—'}</span>
          <span class="lb-player">You</span>
          <span class="lb-value">${Bankroll.fmtCompact(r.you.wagered)}</span>`;
        youEl.classList.remove('hidden');
      } else youEl.classList.add('hidden');
    } catch (e) { Toast.error(e.message); }
  }

  async function loadLeaderboard(metric) {
    document.getElementById('raceBanner').classList.add('hidden');
    stopRaceCountdown();
    if (metric === 'race') return loadRace();
    try {
      const r = await API.leaderboard(metric, 10);
      const list = document.getElementById('lbList');
      list.innerHTML = r.top.length
        ? r.top.map(row => `
            <li class="lb-row ${row.isYou ? 'you' : ''}">
              <span class="lb-rank ${row.rank <= 3 ? 'medal' : ''}">${row.rank <= 3 ? ['🥇','🥈','🥉'][row.rank - 1] : row.rank}</span>
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
  document.getElementById('leadersClose').addEventListener('click', () => { stopRaceCountdown(); leadersModal.classList.add('hidden'); });
  leadersModal.addEventListener('click', e => { if (e.target === leadersModal) { stopRaceCountdown(); leadersModal.classList.add('hidden'); } });
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
      if (leaders) { stopRaceCountdown(); leaders.classList.add('hidden'); }
      return;
    }
    // Space / Enter trigger the primary action of the currently mounted game,
    // or claim the daily bonus if its modal is up. Scoped to focus inside the
    // game pane / on a button — otherwise tapping Space to scroll the page or
    // Enter while reading the feed would fire an unintended wager.
    if (!isFormField && (e.key === ' ' || e.key === 'Enter')) {
      const daily = document.getElementById('dailyModal');
      if (daily && !daily.classList.contains('hidden')) {
        e.preventDefault();
        const claim = document.getElementById('dailyClaim');
        if (claim && !claim.disabled) claim.click();
        return;
      }
      // Bail if any other modal is open (vault, leaders, fair, tour) — the
      // user isn't trying to wager.
      const ddOpen = (() => { const p = document.getElementById('gamesDdPanel'); return p && !p.classList.contains('hidden'); })();
      if (ddOpen) return;
      const blocking = ['vaultModal', 'leadersModal', 'fairModal', 'statsModal']
        .some(id => { const el = document.getElementById(id); return el && !el.classList.contains('hidden'); });
      const tour = document.getElementById('tourOverlay');
      if (blocking || (tour && !tour.classList.contains('hidden'))) return;
      // Only fire when focus is actually inside the game pane or on a button —
      // pressing Space on document.body should still scroll, not place a bet.
      const focused = document.activeElement;
      const gamePane = document.getElementById('gamePane');
      const inGame = focused && (focused.tagName === 'BUTTON' || (gamePane && gamePane.contains(focused)));
      if (!inGame) return;
      const primary = document.querySelector('#gamePane .btn-primary:not([disabled])');
      if (primary) {
        e.preventDefault();
        primary.click();
      }
    }
  });

  // ----- Game router -----
  const pane = document.getElementById('gamePane');
  const lobbyPill = document.querySelector('.nav-pill[data-game="lobby"]');
  const ddBtn = document.getElementById('gamesDdBtn');
  const ddPanel = document.getElementById('gamesDdPanel');
  const ddLabel = document.getElementById('gamesDdLabel');
  let unmount = null, current = 'lobby';

  function mount(game) {
    if (typeof unmount === 'function') { try { unmount(); } catch (e) {} unmount = null; }
    const fn = (global.Games || {})[game];
    if (!fn) { pane.innerHTML = `<div style="padding:40px;text-align:center;color:var(--muted)">Game not found.</div>`; return; }
    unmount = fn(pane);
    pane.classList.remove('pane-enter');
    void pane.offsetWidth;
    pane.classList.add('pane-enter');
  }

  // Central navigation entry point — used by the Lobby pill, the All-Games
  // dropdown, and the lobby grid cards. Keeps active state + last-game memory
  // in one place regardless of how many games exist.
  function switchGame(game) {
    current = game;
    try { localStorage.setItem('neonstake.lastGame', game); } catch (e) {}
    lobbyPill.classList.toggle('active', game === 'lobby');
    ddBtn.classList.toggle('active', game !== 'lobby');
    const cat = global.GameCatalog;
    ddLabel.textContent = (game !== 'lobby' && cat && cat.byKey[game]) ? cat.byKey[game].name : 'All Games';
    // Reflect selection inside the open panel.
    ddPanel.querySelectorAll('.dd-game').forEach(el => el.classList.toggle('on', el.dataset.game === game));
    closeDropdown();
    if (global.Sound) Sound.play('nav');
    mount(game);
  }
  global.CryptNav = { select: switchGame, current: () => current };

  // Build the dropdown panel from the shared catalog, grouped by category.
  function buildDropdown() {
    const cat = global.GameCatalog;
    if (!cat) return;
    const groups = cat.GROUPS.map(grp => {
      const items = cat.GAMES.filter(g => g.cat === grp.key).map(g =>
        `<button class="dd-game" data-game="${g.key}"><span class="dd-ic">${g.icon}</span><span class="dd-nm">${g.name}</span></button>`
      ).join('');
      return `<div class="dd-group"><div class="dd-group-h">${grp.label}</div><div class="dd-group-items">${items}</div></div>`;
    }).join('');
    ddPanel.innerHTML =
      `<input id="ddSearch" class="dd-search" type="search" placeholder="Search ${cat.GAMES.length} games…" autocomplete="off" />` +
      `<div class="dd-scroll">${groups}</div>`;
    ddPanel.querySelectorAll('.dd-game').forEach(el =>
      el.addEventListener('click', () => switchGame(el.dataset.game)));
    const search = ddPanel.querySelector('#ddSearch');
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      ddPanel.querySelectorAll('.dd-game').forEach(el => {
        const hit = !q || el.querySelector('.dd-nm').textContent.toLowerCase().includes(q) || el.dataset.game.includes(q);
        el.style.display = hit ? '' : 'none';
      });
      ddPanel.querySelectorAll('.dd-group').forEach(grp =>
        grp.style.display = grp.querySelector('.dd-game:not([style*="none"])') ? '' : 'none');
    });
  }
  function openDropdown() {
    ddPanel.classList.remove('hidden');
    ddBtn.setAttribute('aria-expanded', 'true');
    const s = ddPanel.querySelector('#ddSearch');
    if (s) { s.value = ''; s.dispatchEvent(new Event('input')); setTimeout(() => s.focus(), 30); }
  }
  function closeDropdown() {
    ddPanel.classList.add('hidden');
    ddBtn.setAttribute('aria-expanded', 'false');
  }
  buildDropdown();
  lobbyPill.addEventListener('click', () => switchGame('lobby'));
  ddBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (ddPanel.classList.contains('hidden')) openDropdown(); else closeDropdown();
  });
  document.addEventListener('click', (e) => {
    if (!ddPanel.contains(e.target) && e.target !== ddBtn && !ddBtn.contains(e.target)) closeDropdown();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDropdown(); });

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
    if (global.Vault) Vault.wire();
    if (global.Admin) Admin.wire(user);
    if (global.Jackpot) Jackpot.init();
    if (global.Limits) Limits.wire(user);
    if (global.Help) Help.wire();

    // Sound: mute toggle + a soft click on primary buttons.
    const muteBtn = document.getElementById('btnMute');
    if (muteBtn && global.Sound) {
      muteBtn.textContent = Sound.isMuted() ? '🔇' : '🔊';
      muteBtn.addEventListener('click', () => {
        muteBtn.textContent = Sound.toggleMute() ? '🔇' : '🔊';
        Sound.play('click');
      });
      document.addEventListener('click', (e) => {
        if (e.target.closest && e.target.closest('.btn-primary')) Sound.play('click');
      });
    }

    authGate.classList.add('hidden');
    appEl.classList.remove('hidden');

    // Onboarding tour for fresh accounts (or ?tour=1 to replay). Waits for the
    // daily-bonus modal to be gone — otherwise the tour mask intercepts clicks
    // and traps the user behind it.
    try {
      const replay = /[?&]tour=1\b/.test(location.search);
      const seen = localStorage.getItem('crypt.onboarded');
      const looksFresh = user && (user.level === 1 || user.level == null) && (!user.xp || user.xp < 50);
      if (global.Tour && (replay || (!seen && looksFresh))) {
        const tryStart = (tries = 0) => {
          const daily = document.getElementById('dailyModal');
          const blocked = daily && !daily.classList.contains('hidden');
          if (blocked && tries < 60) return setTimeout(() => tryStart(tries + 1), 250);
          Tour.start();
        };
        setTimeout(tryStart, 600);
      }
    } catch (e) {}

    // The lobby is the front door; returning players land on their last game.
    let initial = 'lobby';
    try { initial = localStorage.getItem('neonstake.lastGame') || 'lobby'; } catch (e) {}
    // Guard against a stale key pointing at a game that no longer exists.
    if (initial !== 'lobby' && !(global.Games || {})[initial]) initial = 'lobby';
    switchGame(initial);
  }

  // Check for an existing session. On free-tier hosting the server sleeps
  // when idle and the first request can take ~30s — tell the visitor what's
  // happening instead of showing a dead page.
  (async function init() {
    const wakeHint = setTimeout(() => {
      const el = document.createElement('div');
      el.id = 'wakeHint';
      el.className = 'wake-hint';
      el.textContent = '☕ Waking the casino up — first visit after a quiet spell takes ~30 seconds…';
      document.body.appendChild(el);
    }, 2500);
    try {
      const { user } = await API.me();
      clearTimeout(wakeHint);
      document.getElementById('wakeHint')?.remove();
      if (user) { bootApp(user); return; }
    } catch (e) {
      clearTimeout(wakeHint);
      document.getElementById('wakeHint')?.remove();
    }
    authGate.classList.remove('hidden');
    authUser.focus();
  })();
})(window);
