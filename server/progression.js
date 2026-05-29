'use strict';

const { AsyncLocalStorage } = require('async_hooks');

/* Progression — XP, levels, daily streak, achievements.
 *
 * Design principles:
 *  - Server is the source of truth for everything. The client renders the
 *    snapshot it gets back; it never decides level-ups or unlocks itself.
 *  - Every bet awards XP (win or lose) proportional to wager — keeps active
 *    players progressing without rewarding chasing losses.
 *  - Daily bonus is opt-in via a separate POST; we never auto-credit on /me.
 *  - Achievements are append-only (`achievements(user_id, key)` unique) so
 *    nothing can be re-unlocked or revoked client-side. */

const db = require('./db');
const { httpError } = require('./auth');

// Level curve: XP needed to reach level L from level L-1 = LEVEL_STEP * (L-1).
// Cumulative XP at level L = LEVEL_STEP * L*(L-1)/2.
//   level 1 = 0 XP, level 2 = 1000, level 3 = 3000, level 5 = 10000,
//   level 10 = 45k, level 25 = 300k. Long-tail but not punishing.
const LEVEL_STEP = 1000;
const XP_PER_CENT_WAGERED = 0.1; // $1 wager = 10 XP. Tunable via env.
const XP_PER_CENT = Number(process.env.XP_PER_CENT_WAGERED || XP_PER_CENT_WAGERED);

// Daily bonus: base + scaling streak bonus, capped. Reset window: 36h.
const STREAK_BASE_CENTS = Number(process.env.DAILY_BONUS_BASE_FUN || 50) * 100;
const STREAK_STEP_CENTS = Number(process.env.DAILY_BONUS_STEP_FUN || 5)  * 100;
const STREAK_CAP_CENTS  = Number(process.env.DAILY_BONUS_CAP_FUN  || 500) * 100;
const STREAK_WINDOW_MS  = 36 * 60 * 60 * 1000;
const STREAK_COOLDOWN_MS = 20 * 60 * 60 * 1000; // can claim once per ~day

function cumulativeXp(level) { return LEVEL_STEP * (level * (level - 1)) / 2; }
function levelFromXp(xp) {
  // Inverse of cumulativeXp: solve xp = STEP * L*(L-1)/2 → L = (1 + sqrt(1 + 8*xp/STEP)) / 2.
  let L = Math.floor((1 + Math.sqrt(1 + 8 * xp / LEVEL_STEP)) / 2);
  if (L < 1) L = 1;
  // Numerical safety — bracket-check.
  if (cumulativeXp(L + 1) <= xp) L += 1;
  if (cumulativeXp(L) > xp) L -= 1;
  return Math.max(1, L);
}
function xpForNext(xp) {
  const L = levelFromXp(xp);
  return { level: L, currentXp: xp, nextLevelXp: cumulativeXp(L + 1), xpIntoLevel: xp - cumulativeXp(L), xpPerLevel: LEVEL_STEP * L };
}

// ---- Achievements catalogue -----------------------------------------------
// Predicate signature: ({user, totals, bet}) => boolean. `totals` is fresh from
// the bets table; `bet` is the row just recorded (so achievements can react to
// the bet that triggered the check).
const ACHIEVEMENTS = [
  { key: 'first_bet',     name: 'First Hand',      desc: 'Place your first wager.',                xp: 250,  test: ({ totals }) => totals.bets >= 1 },
  { key: 'first_win',     name: 'First Win',       desc: 'Win any bet for the first time.',         xp: 500,  test: ({ totals }) => totals.wins >= 1 },
  { key: 'high_roller',   name: 'High Roller',     desc: 'Wager 1,000 FUN total.',                  xp: 1000, test: ({ totals }) => totals.wagered_cents >= 100_000 },
  { key: 'whale',         name: 'Whale',           desc: 'Wager 10,000 FUN total.',                 xp: 3000, test: ({ totals }) => totals.wagered_cents >= 1_000_000 },
  { key: 'big_payout',    name: 'Big Payout',      desc: 'Land a payout of 100+ FUN on one bet.',   xp: 500,  test: ({ bet }) => Number(bet.payout_cents) >= 10_000 },
  { key: 'mega_payout',   name: 'Mega Payout',     desc: 'Land a payout of 1,000+ FUN on one bet.', xp: 2000, test: ({ bet }) => Number(bet.payout_cents) >= 100_000 },
  { key: 'multiplier_50', name: 'Multiplier 50×',  desc: 'Hit a 50× or higher multiplier.',         xp: 1000, test: ({ bet }) => Number(bet.mult) >= 50 },
  { key: 'multiplier_500',name: 'Jackpot Hunter',  desc: 'Hit a 500× or higher multiplier.',        xp: 5000, test: ({ bet }) => Number(bet.mult) >= 500 },
  { key: 'explorer',      name: 'Explorer',        desc: 'Play 5 different games.',                 xp: 750,  test: ({ totals }) => totals.distinct_games >= 5 },
  { key: 'globetrotter',  name: 'Globetrotter',    desc: 'Play 15 different games.',                xp: 2000, test: ({ totals }) => totals.distinct_games >= 15 },
  { key: 'level_5',       name: 'Level 5',         desc: 'Reach level 5.',                          xp: 0,    test: ({ user }) => Number(user.level) >= 5 },
  { key: 'level_10',      name: 'Level 10',        desc: 'Reach level 10.',                         xp: 0,    test: ({ user }) => Number(user.level) >= 10 },
  { key: 'level_25',      name: 'Level 25',        desc: 'Reach level 25.',                         xp: 0,    test: ({ user }) => Number(user.level) >= 25 },
  { key: 'streak_3',      name: 'Heating Up',      desc: 'Claim a daily bonus for 3 days in a row.', xp: 500,  test: ({ user }) => Number(user.streak_day) >= 3 },
  { key: 'streak_7',      name: 'Week Warrior',    desc: '7-day login streak.',                     xp: 1500, test: ({ user }) => Number(user.streak_day) >= 7 },
  { key: 'streak_30',     name: 'Diehard',         desc: '30-day login streak.',                    xp: 7500, test: ({ user }) => Number(user.streak_day) >= 30 }
];
const ACHIEVEMENT_BY_KEY = Object.fromEntries(ACHIEVEMENTS.map(a => [a.key, a]));

// ---- Internal helpers -----------------------------------------------------
async function fetchUser(q, userId) {
  const { rows } = await q('SELECT id, balance_cents, xp, level, streak_day, last_bonus_at FROM users WHERE id = ?', [userId]);
  return rows[0] || null;
}
async function fetchTotals(q, userId) {
  const { rows } = await q(`SELECT
      COUNT(*)                                AS bets,
      COALESCE(SUM(win), 0)                   AS wins,
      COALESCE(SUM(bet_cents), 0)             AS wagered_cents,
      COALESCE(SUM(payout_cents), 0)          AS returned_cents,
      COUNT(DISTINCT game)                    AS distinct_games
    FROM bets WHERE user_id = ?`, [userId]);
  const a = rows[0] || {};
  return {
    bets: Number(a.bets || 0),
    wins: Number(a.wins || 0),
    wagered_cents: Number(a.wagered_cents || 0),
    returned_cents: Number(a.returned_cents || 0),
    distinct_games: Number(a.distinct_games || 0)
  };
}
async function fetchUnlocked(q, userId) {
  const { rows } = await q('SELECT key, unlocked_at FROM achievements WHERE user_id = ? ORDER BY unlocked_at DESC', [userId]);
  return rows.map(r => ({ key: r.key, ts: Number(r.unlocked_at) }));
}

// Insert an achievement row only if not already unlocked. Returns the bonus
// XP to credit on first unlock, or 0 if it was already there.
async function unlockOnce(q, userId, key) {
  const cfg = ACHIEVEMENT_BY_KEY[key];
  if (!cfg) return 0;
  const r = await q(
    'INSERT INTO achievements(user_id, key, unlocked_at) VALUES(?, ?, ?) ON CONFLICT(user_id, key) DO NOTHING',
    [userId, key, Date.now()]
  );
  return r.rowCount ? cfg.xp || 0 : 0;
}

// ---- Public API -----------------------------------------------------------

// Award XP for a bet. Returns { xpGained, leveledUp, oldLevel, newLevel,
// unlocked: [keys] } for the client to render any UI cues. Runs INSIDE the
// caller's transaction so XP, level, achievements, and the bet all commit
// atomically.
async function awardForBet(q, userId, betRow) {
  const xpGain = Math.max(1, Math.floor(Number(betRow.bet_cents || 0) * XP_PER_CENT));
  await q('UPDATE users SET xp = xp + ? WHERE id = ?', [xpGain, userId]);

  // Read the fresh user row + aggregates inside the same tx so achievement
  // predicates see the just-updated state.
  const user = await fetchUser(q, userId);
  const totals = await fetchTotals(q, userId);
  const oldLevel = Number(user.level);
  const newLevel = levelFromXp(Number(user.xp));
  let leveledUp = false;
  if (newLevel !== oldLevel) {
    await q('UPDATE users SET level = ? WHERE id = ?', [newLevel, userId]);
    user.level = newLevel;
    leveledUp = newLevel > oldLevel;
  }
  // Achievement sweep — every bet re-evaluates all predicates against the
  // fresh user + totals + the bet that triggered the check.
  const unlocked = [];
  let bonusXp = 0;
  for (const a of ACHIEVEMENTS) {
    let pass;
    try { pass = !!a.test({ user, totals, bet: betRow }); } catch (_) { pass = false; }
    if (!pass) continue;
    const gained = await unlockOnce(q, userId, a.key);
    if (gained > 0) { bonusXp += gained; unlocked.push(a.key); }
  }
  if (bonusXp > 0) {
    await q('UPDATE users SET xp = xp + ? WHERE id = ?', [bonusXp, userId]);
    // Re-check level after the achievement XP credit.
    const afterXp = Number(user.xp) + bonusXp;
    const finalLevel = levelFromXp(afterXp);
    if (finalLevel !== Number(user.level)) {
      await q('UPDATE users SET level = ? WHERE id = ?', [finalLevel, userId]);
      if (finalLevel > Number(user.level)) leveledUp = true;
      user.level = finalLevel;
    }
  }
  return { xpGained: xpGain + bonusXp, leveledUp, oldLevel, newLevel: Number(user.level), unlocked };
}

// Daily bonus computation: returns { available, streakIfClaimed, amountCents,
// hoursUntilNext }. The "streak" increments if the user claims within
// STREAK_WINDOW_MS of their last claim; otherwise resets to 1.
function bonusState(user, now = Date.now()) {
  const last = user.last_bonus_at ? Number(user.last_bonus_at) : null;
  const sinceMs = last == null ? Infinity : now - last;
  const available = sinceMs >= STREAK_COOLDOWN_MS;
  const continuing = last != null && sinceMs <= STREAK_WINDOW_MS;
  const streakIfClaimed = continuing ? Number(user.streak_day || 0) + 1 : 1;
  const amount = Math.min(STREAK_CAP_CENTS, STREAK_BASE_CENTS + (streakIfClaimed - 1) * STREAK_STEP_CENTS);
  const hoursUntilNext = available ? 0 : Math.max(0, (STREAK_COOLDOWN_MS - sinceMs) / 3600_000);
  return { available, streakIfClaimed, amountCents: amount, hoursUntilNext };
}

async function claimDaily(userId) {
  return db.tx(async (q) => {
    const user = await fetchUser(q, userId);
    if (!user) throw httpError(404, 'User not found.');
    const state = bonusState(user);
    if (!state.available) {
      throw httpError(409, `Daily bonus already claimed. Next claim in ${state.hoursUntilNext.toFixed(1)}h.`);
    }
    const now = Date.now();
    await q('UPDATE users SET balance_cents = balance_cents + ?, streak_day = ?, last_bonus_at = ? WHERE id = ?',
      [state.amountCents, state.streakIfClaimed, now, userId]);
    // Streak achievements check.
    const userAfter = await fetchUser(q, userId);
    const totals = await fetchTotals(q, userId);
    const unlocked = [];
    let bonusXp = 0;
    for (const a of ACHIEVEMENTS) {
      if (!a.key.startsWith('streak_') && a.key !== 'first_bet' && !a.key.startsWith('level_')) continue;
      try {
        if (!a.test({ user: userAfter, totals, bet: { bet_cents: 0, payout_cents: 0, mult: 0 } })) continue;
      } catch (_) { continue; }
      const gained = await unlockOnce(q, userAfter.id, a.key);
      if (gained > 0) { bonusXp += gained; unlocked.push(a.key); }
    }
    if (bonusXp > 0) {
      await q('UPDATE users SET xp = xp + ? WHERE id = ?', [bonusXp, userId]);
      const refetch = await fetchUser(q, userId);
      const finalLevel = levelFromXp(Number(refetch.xp));
      if (finalLevel !== Number(refetch.level)) {
        await q('UPDATE users SET level = ? WHERE id = ?', [finalLevel, userId]);
      }
    }
    const final = await fetchUser(q, userId);
    return {
      claimed: true,
      amount: state.amountCents / 100,
      streakDay: Number(final.streak_day),
      balance: Number(final.balance_cents) / 100,
      level: Number(final.level),
      xp: Number(final.xp),
      unlocked
    };
  });
}

async function snapshot(userId) {
  const user = await fetchUser(db.query, userId);
  if (!user) throw httpError(404, 'User not found.');
  const [unlocked, totals] = await Promise.all([
    fetchUnlocked(db.query, userId),
    fetchTotals(db.query, userId)
  ]);
  const xp = Number(user.xp || 0);
  const lvl = xpForNext(xp);
  return {
    level: Number(user.level || 1),
    xp,
    xpIntoLevel: lvl.xpIntoLevel,
    xpPerLevel: lvl.xpPerLevel,
    nextLevelXp: lvl.nextLevelXp,
    streakDay: Number(user.streak_day || 0),
    daily: bonusState(user),
    totals: {
      bets: totals.bets,
      wins: totals.wins,
      wageredFun: totals.wagered_cents / 100,
      distinctGames: totals.distinct_games
    },
    achievements: ACHIEVEMENTS.map(a => {
      const u = unlocked.find(x => x.key === a.key);
      return { key: a.key, name: a.name, desc: a.desc, xp: a.xp, unlocked: !!u, unlockedAt: u ? u.ts : null };
    })
  };
}

// Request-scoped progression delta — lets recordBet stash the XP/level-up
// info during a request and h() merge it into the response, without every
// game function having to thread the value through its return shape.
const requestStore = new AsyncLocalStorage();

module.exports = {
  awardForBet, claimDaily, snapshot, bonusState,
  ACHIEVEMENTS, ACHIEVEMENT_BY_KEY, XP_PER_CENT,
  levelFromXp, cumulativeXp, xpForNext,
  requestStore
};
