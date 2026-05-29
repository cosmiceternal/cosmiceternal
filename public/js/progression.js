/* Progression UI client.
 *
 * Holds a local mirror of the player's XP, level, streak and achievements,
 * applies the per-response `progress` deltas the server emits on every bet,
 * and fires the celebratory bits (level-up flash, achievement toasts). Server
 * is the source of truth — this module only renders what the server tells it. */
(function (global) {
  'use strict';

  let state = {
    level: 1, xp: 0,
    xpIntoLevel: 0, xpPerLevel: 1000, nextLevelXp: 1000,
    streakDay: 0,
    daily: null,
    totals: null,
    achievements: []
  };
  const subs = new Set();

  function snapshot() { return Object.assign({}, state); }
  function subscribe(fn) { subs.add(fn); try { fn(snapshot()); } catch (_) {} return () => subs.delete(fn); }
  function notify() { subs.forEach(fn => { try { fn(snapshot()); } catch (_) {} }); }

  function recomputeLevelDerived() {
    // Cumulative XP at level L = 1000 * L*(L-1)/2 (mirrors server LEVEL_STEP).
    const STEP = 1000;
    const xp = state.xp;
    let L = Math.max(1, Math.floor((1 + Math.sqrt(1 + 8 * xp / STEP)) / 2));
    while (STEP * L * (L - 1) / 2 > xp) L--;
    while (STEP * (L + 1) * L / 2 <= xp) L++;
    state.level = Math.max(1, L);
    const base = STEP * L * (L - 1) / 2;
    state.xpPerLevel = STEP * L;
    state.xpIntoLevel = xp - base;
    state.nextLevelXp = base + state.xpPerLevel;
  }

  function seed(user) {
    if (!user) return;
    state.level = user.level || 1;
    state.xp = user.xp || 0;
    state.streakDay = user.streakDay || 0;
    recomputeLevelDerived();
    notify();
  }

  async function refresh() {
    try {
      const snap = await API.progression();
      state.level = snap.level;
      state.xp = snap.xp;
      state.xpIntoLevel = snap.xpIntoLevel;
      state.xpPerLevel = snap.xpPerLevel;
      state.nextLevelXp = snap.nextLevelXp;
      state.streakDay = snap.streakDay;
      state.daily = snap.daily;
      state.totals = snap.totals;
      state.achievements = snap.achievements;
      notify();
    } catch (_) {}
    return snapshot();
  }

  // Called by api.js whenever a response carries a `progress` field.
  function apply(progress) {
    if (!progress || typeof progress !== 'object') return;
    if (progress.xpGained) {
      state.xp += progress.xpGained;
      recomputeLevelDerived();
    }
    const announcedLevel = Number(progress.newLevel || state.level);
    const prevLevel = Number(progress.oldLevel || state.level);
    if (announcedLevel > prevLevel && global.Toast) {
      Toast.win(`✨ Level Up! ${prevLevel} → ${announcedLevel}`);
      flashLevelBadge();
    }
    if (Array.isArray(progress.unlocked) && progress.unlocked.length) {
      progress.unlocked.forEach(key => {
        const ach = state.achievements.find(a => a.key === key);
        if (ach && !ach.unlocked) { ach.unlocked = true; ach.unlockedAt = Date.now(); }
        const label = ach ? ach.name : key;
        if (global.Toast) Toast.win(`🏆 ${label} unlocked`);
      });
    }
    notify();
  }

  function flashLevelBadge() {
    const el = document.getElementById('lvlBadge');
    if (!el) return;
    el.classList.remove('levelup');
    void el.offsetWidth;
    el.classList.add('levelup');
    setTimeout(() => el.classList.remove('levelup'), 1200);
  }

  // Render the topbar level badge whenever state changes.
  function bindBadge() {
    const badge = document.getElementById('lvlBadge');
    if (!badge) return;
    function render(s) {
      const pct = Math.max(0, Math.min(100, s.xpPerLevel > 0 ? (s.xpIntoLevel / s.xpPerLevel) * 100 : 0));
      badge.innerHTML = `
        <span class="lvl-tag">LVL</span>
        <span class="lvl-num">${s.level}</span>
        <span class="lvl-bar"><span class="lvl-bar-fill" style="width:${pct.toFixed(1)}%"></span></span>
        ${s.streakDay > 0 ? `<span class="lvl-streak" title="${s.streakDay}-day streak">🔥 ${s.streakDay}</span>` : ''}
      `;
      badge.title = `Level ${s.level} — ${s.xpIntoLevel.toLocaleString()} / ${s.xpPerLevel.toLocaleString()} XP to next`;
    }
    subscribe(render);
  }

  // Daily bonus modal: pops up automatically on the first session of the day
  // when the bonus is available.
  async function maybeShowDaily() {
    if (state.daily?.available) showDailyModal();
  }
  function showDailyModal() {
    const modal = document.getElementById('dailyModal');
    if (!modal) return;
    const d = state.daily;
    if (!d) return;
    modal.querySelector('#dailyAmount').textContent = (d.amountCents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    modal.querySelector('#dailyStreak').textContent = d.streakIfClaimed;
    modal.querySelector('#dailyTitle').textContent = state.streakDay > 0 ? `Day ${state.streakDay + 1} — keep your streak alive` : 'Welcome back!';
    modal.classList.remove('hidden');
  }
  function hideDailyModal() {
    const modal = document.getElementById('dailyModal');
    if (modal) modal.classList.add('hidden');
  }

  async function claimDaily() {
    try {
      const r = await API.claimDaily();
      state.streakDay = r.streakDay;
      state.xp = r.xp;
      state.level = r.level;
      state.daily = { available: false, streakIfClaimed: r.streakDay + 1, amountCents: 0, hoursUntilNext: 24 };
      recomputeLevelDerived();
      if (global.Bankroll) Bankroll.set(r.balance);
      if (Array.isArray(r.unlocked)) {
        r.unlocked.forEach(key => {
          const ach = state.achievements.find(a => a.key === key);
          if (ach && !ach.unlocked) { ach.unlocked = true; ach.unlockedAt = Date.now(); }
          const label = ach ? ach.name : key;
          if (global.Toast) Toast.win(`🏆 ${label} unlocked`);
        });
      }
      if (global.Toast) Toast.win(`+${(r.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })} FUN — Day ${r.streakDay} streak 🔥`);
      hideDailyModal();
      notify();
      return r;
    } catch (e) {
      if (global.Toast) Toast.error(e.message);
    }
  }

  function init() {
    bindBadge();
    refresh().then(() => maybeShowDaily());
    const claimBtn = document.getElementById('dailyClaim');
    const skipBtn = document.getElementById('dailySkip');
    if (claimBtn) claimBtn.addEventListener('click', claimDaily);
    if (skipBtn)  skipBtn.addEventListener('click', hideDailyModal);
  }

  global.Progression = { init, seed, refresh, apply, subscribe, snapshot, claimDaily, showDailyModal, hideDailyModal };
})(window);
