'use strict';
/* Player-facing reads: public feed, leaderboards, stats & history. */
const db = require('../db');

// ---------------------------------------------------------------- HISTORY / STATS
// Anonymise usernames for the public feed. Keeps the first letter + last digit
// so consecutive wins from the same player still look like a streak from one
// person, without leaking the full handle.
function anonName(u) {
  if (!u) return '???';
  const s = String(u);
  if (s.length <= 2) return s[0] + '*';
  return s[0] + '***' + s[s.length - 1];
}

// Recent winning bets across ALL users. For a single-user deploy this is your
// own highlight reel; for a busy table it's the live wins ticker that drives
// FOMO and social proof. Capped at 50 and indexed by id DESC so it's cheap.
async function globalFeed(limit = 30, minPayoutCents = 0) {
  limit = Math.max(1, Math.min(50, Number(limit) || 30));
  minPayoutCents = Math.max(0, Number(minPayoutCents) || 0);
  const { rows } = await db.query(
    `SELECT b.game, b.bet_cents, b.mult, b.payout_cents, b.created_at, u.username
       FROM bets b
       JOIN users u ON u.id = b.user_id
      WHERE b.win = 1 AND b.payout_cents >= ?
      ORDER BY b.id DESC LIMIT ?`,
    [minPayoutCents, limit]
  );
  return rows.map(r => ({
    game: r.game,
    player: anonName(r.username),
    bet: Number(r.bet_cents) / 100,
    mult: Number(r.mult),
    payout: Number(r.payout_cents) / 100,
    profit: (Number(r.payout_cents) - Number(r.bet_cents)) / 100,
    ts: Number(r.created_at)
  }));
}

// Top players for a given metric. Returns the top N + the requesting user's
// own rank for the same metric (so they always see where they stand even
// when they're not in the top). All usernames anonymised.
const LEADERBOARD_METRICS = {
  xp:      { col: 'xp',                     table: 'users', having: 'xp > 0',                    asc: false, valueLabel: 'XP' },
  level:   { col: 'level',                  table: 'users', having: '1 = 1',                     asc: false, valueLabel: 'Level' },
  wins:    { col: 'wins',                   table: 'bets_wins',                                  asc: false, valueLabel: 'Wins' },
  biggest: { col: 'biggest_payout_cents',   table: 'bets_biggest',                               asc: false, valueLabel: 'Biggest Payout (CRYPT)' }
};

// The wins/biggest leaderboards need a full-table GROUP BY over every bet to
// build the top list and the value distribution used for ranking. That result
// is identical for every viewer, so recomputing it on each open doesn't scale.
// Cache the shared aggregate for a few seconds; each viewer's own value/rank
// stays a cheap index lookup against bets(user_id, …). A few seconds of
// staleness on a leaderboard is imperceptible.
const LB_CACHE_MS = 15_000;
const lbCache = new Map(); // `${metric}:${limit}` -> { at, top, dist }
async function lbAggregate(metric, limit, build) {
  const key = `${metric}:${limit}`;
  const hit = lbCache.get(key);
  if (hit && Date.now() - hit.at < LB_CACHE_MS) return hit;
  const fresh = { at: Date.now(), ...(await build()) };
  lbCache.set(key, fresh);
  return fresh;
}

async function leaderboard(userId, metric = 'xp', limit = 10) {
  metric = String(metric).toLowerCase();
  if (!LEADERBOARD_METRICS[metric]) metric = 'xp';
  limit = Math.max(1, Math.min(50, Number(limit) || 10));

  if (metric === 'xp' || metric === 'level') {
    const orderCol = metric === 'level' ? 'level DESC, xp DESC' : 'xp DESC';
    const filter = metric === 'xp' ? 'WHERE xp > 0' : '';
    const top = (await db.query(
      `SELECT id, username, xp, level FROM users ${filter} ORDER BY ${orderCol} LIMIT ?`,
      [limit]
    )).rows;
    // Rank for the requesting user — count users strictly above them.
    const me = (await db.query('SELECT xp, level FROM users WHERE id = ?', [userId])).rows[0];
    let myRank = null, myValue = null;
    if (me) {
      myValue = metric === 'level' ? Number(me.level) : Number(me.xp);
      const { rows } = metric === 'level'
        ? await db.query('SELECT COUNT(*) AS n FROM users WHERE level > ? OR (level = ? AND xp > ?)',
            [Number(me.level), Number(me.level), Number(me.xp)])
        : await db.query('SELECT COUNT(*) AS n FROM users WHERE xp > ?', [Number(me.xp)]);
      myRank = Number(rows[0]?.n || 0) + 1;
    }
    return {
      metric, label: LEADERBOARD_METRICS[metric].valueLabel,
      top: top.map((r, i) => ({ rank: i + 1, player: anonName(r.username), isYou: Number(r.id) === Number(userId), value: metric === 'level' ? Number(r.level) : Number(r.xp), level: Number(r.level) })),
      you: me ? { rank: myRank, value: myValue, level: Number(me.level) } : null
    };
  }
  if (metric === 'wins') {
    const agg = await lbAggregate('wins', limit, async () => ({
      top: (await db.query(
        `SELECT u.id, u.username, u.level, COUNT(*) AS wins
           FROM users u JOIN bets b ON b.user_id = u.id
          WHERE b.win = 1
          GROUP BY u.id, u.username, u.level
          ORDER BY wins DESC LIMIT ?`, [limit])).rows,
      dist: (await db.query(
        `SELECT COUNT(*) AS wins FROM bets WHERE win = 1 GROUP BY user_id`)).rows.map(r => Number(r.wins))
    }));
    const my = (await db.query(
      `SELECT COUNT(*) AS wins FROM bets WHERE user_id = ? AND win = 1`, [userId]
    )).rows[0];
    const myWins = Number(my?.wins || 0);
    const rank = agg.dist.filter(v => v > myWins).length + 1;
    return {
      metric, label: 'Wins',
      top: agg.top.map((r, i) => ({ rank: i + 1, player: anonName(r.username), isYou: Number(r.id) === Number(userId), value: Number(r.wins), level: Number(r.level) })),
      you: { rank, value: myWins }
    };
  }
  // biggest single payout (profit on one bet)
  const agg = await lbAggregate('biggest', limit, async () => ({
    top: (await db.query(
      `SELECT u.id, u.username, u.level, MAX(b.payout_cents - b.bet_cents) AS biggest
         FROM users u JOIN bets b ON b.user_id = u.id
        GROUP BY u.id, u.username, u.level
        HAVING MAX(b.payout_cents - b.bet_cents) > 0
        ORDER BY biggest DESC LIMIT ?`, [limit])).rows,
    dist: (await db.query(
      `SELECT MAX(payout_cents - bet_cents) AS biggest FROM bets GROUP BY user_id`)).rows.map(r => Number(r.biggest))
  }));
  const my = (await db.query(
    `SELECT COALESCE(MAX(payout_cents - bet_cents), 0) AS biggest FROM bets WHERE user_id = ?`, [userId]
  )).rows[0];
  const myBiggest = Number(my?.biggest || 0);
  const rank = agg.dist.filter(v => v > myBiggest).length + 1;
  return {
    metric, label: 'Biggest Single Payout (CRYPT)',
    top: agg.top.map((r, i) => ({ rank: i + 1, player: anonName(r.username), isYou: Number(r.id) === Number(userId), value: Number(r.biggest) / 100, level: Number(r.level) })),
    you: { rank, value: myBiggest / 100 }
  };
}

async function history(userId, limit = 30) {
  limit = Math.max(1, Math.min(100, Number(limit) || 30));
  const { rows } = await db.query(
    'SELECT game, bet_cents, mult, payout_cents, win, nonce, server_hash, client_seed, created_at FROM bets WHERE user_id = ? ORDER BY id DESC LIMIT ?',
    [userId, limit]
  );
  return rows.map(r => ({
    game: r.game,
    bet: Number(r.bet_cents) / 100,
    mult: Number(r.mult),
    win: !!Number(r.win),
    payout: Number(r.payout_cents) / 100,
    profit: (Number(r.payout_cents) - Number(r.bet_cents)) / 100,
    // Provably-fair coordinates for independent verification (null on old rows).
    nonce: r.nonce != null ? Number(r.nonce) : null,
    serverHash: r.server_hash || null,
    clientSeed: r.client_seed || null,
    ts: Number(r.created_at)
  }));
}

async function stats(userId) {
  const { rows } = await db.query(`
    SELECT COUNT(*) n,
           COALESCE(SUM(bet_cents),0) wagered,
           COALESCE(SUM(payout_cents),0) returned,
           COALESCE(SUM(win),0) wins,
           COALESCE(MAX(payout_cents - bet_cents),0) biggest
    FROM bets WHERE user_id = ?`, [userId]);
  const a = rows[0];
  const n = Number(a.n);
  return {
    bets: n,
    wagered: Number(a.wagered) / 100,
    profit: (Number(a.returned) - Number(a.wagered)) / 100,
    wins: Number(a.wins),
    winRate: n ? Number(a.wins) / n : 0,
    biggestWin: Number(a.biggest) / 100
  };
}

// Richer per-player breakdown for the stats dashboard: performance by game and
// a daily cumulative-profit trend.
async function statsDetail(userId, days = 14) {
  const DAY = 86_400_000;
  const n = Math.min(60, Math.max(1, Number(days) || 14));
  const todayDay = Math.floor(Date.now() / DAY);
  const since = (todayDay - n + 1) * DAY;
  const [perGame, daily] = await Promise.all([
    db.query(`SELECT game, COUNT(*) c, COALESCE(SUM(bet_cents),0) wagered, COALESCE(SUM(payout_cents),0) returned, COALESCE(SUM(win),0) wins
              FROM bets WHERE user_id = ? GROUP BY game ORDER BY c DESC LIMIT 12`, [userId]),
    db.query(`SELECT (created_at/86400000) day, COUNT(*) c, COALESCE(SUM(bet_cents),0) wagered, COALESCE(SUM(payout_cents),0) returned
              FROM bets WHERE user_id = ? AND created_at >= ? GROUP BY (created_at/86400000)`, [userId, since])
  ]);
  const dayMap = new Map(); daily.rows.forEach(r => dayMap.set(Number(r.day), r));
  const series = [];
  let cum = 0;
  for (let d = todayDay - n + 1; d <= todayDay; d++) {
    const r = dayMap.get(d);
    const profit = r ? (Number(r.returned) - Number(r.wagered)) / 100 : 0;
    cum += profit;
    series.push({ ts: d * DAY, profit: +profit.toFixed(2), cumulative: +cum.toFixed(2), bets: r ? Number(r.c) : 0 });
  }
  return {
    days: n,
    perGame: perGame.rows.map(r => {
      const w = Number(r.wagered), ret = Number(r.returned), c = Number(r.c);
      return { game: r.game, bets: c, wagered: w / 100, profit: (ret - w) / 100, wins: Number(r.wins), winRate: c ? Number(r.wins) / c : 0 };
    }),
    series
  };
}


module.exports = {
  anonName, globalFeed, leaderboard, history, stats, statsDetail
};
