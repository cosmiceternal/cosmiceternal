'use strict';

/* Hourly wagering race. Standings are computed straight off the bets table
 * for the current clock hour; the previous hour is settled lazily — the
 * first request that notices an unpaid hour pays it inside a transaction,
 * guarded by a settings-key INSERT so double-settlement is impossible even
 * across replicas. Prize pool is house-funded. */

const db = require('./db');
const { logAudit } = require('./auth');

const HOUR_MS = 3_600_000;
const PRIZES_CENTS = [25_000, 15_000, 10_000];  // 250 / 150 / 100 CRYPT
const MIN_WAGER_CENTS = 10_00;                  // wager ≥ 10 CRYPT to qualify

const hourKey = (ts = Date.now()) => Math.floor(ts / HOUR_MS);

async function standingsFor(key, limit = 10) {
  const start = key * HOUR_MS, end = start + HOUR_MS;
  const { rows } = await db.query(
    `SELECT b.user_id, u.username, u.level, SUM(b.bet_cents) AS wagered
     FROM bets b JOIN users u ON u.id = b.user_id
     WHERE b.created_at >= ? AND b.created_at < ?
     GROUP BY b.user_id, u.username, u.level
     ORDER BY wagered DESC, b.user_id ASC
     LIMIT ?`,
    [start, end, limit]
  );
  return rows.map((r, i) => ({
    rank: i + 1,
    userId: Number(r.user_id),
    player: r.username,
    level: Number(r.level || 1),
    wagered: Number(r.wagered) / 100
  }));
}

// Pay the previous hour once. The settings INSERT is the idempotency lock:
// whoever gets the row in wins the right to pay; every later caller hits the
// duplicate-key error and backs off.
async function settlePrevious() {
  const prev = hourKey() - 1;
  const lockKey = `race_paid_${prev}`;
  const paid = [];
  // Fast path: once the hour is paid, every subsequent caller sees the lock
  // row and skips the transaction entirely (no throwaway INSERT + exception
  // per /api/race request).
  const { rows: existing } = await db.query('SELECT 1 FROM settings WHERE key = ?', [lockKey]);
  if (existing[0]) return paid;
  try {
    await db.tx(async (q) => {
      await q('INSERT INTO settings(key, value) VALUES(?, ?)', [lockKey, 'paying']);
      const top = (await standingsFor(prev, PRIZES_CENTS.length))
        .filter(s => s.wagered * 100 >= MIN_WAGER_CENTS);
      for (let i = 0; i < top.length; i++) {
        await q('UPDATE users SET balance_cents = balance_cents + ? WHERE id = ?', [PRIZES_CENTS[i], top[i].userId]);
        paid.push({ userId: top[i].userId, player: top[i].player, rank: i + 1, prize: PRIZES_CENTS[i] / 100 });
      }
      await q('UPDATE settings SET value = ? WHERE key = ?', [JSON.stringify(paid), lockKey]);
    });
    if (paid.length) logAudit(null, 'race.paid', null, { hour: prev, winners: paid });
  } catch (e) {
    // Duplicate key = someone else settled (or is settling). Anything else is
    // worth a log line but must not break the caller's request.
    if (!/unique|duplicate/i.test(e.message || '')) console.error('race settle:', e);
  }
  return paid;
}

async function state(userId) {
  await settlePrevious();
  const key = hourKey();
  const top = await standingsFor(key, 10);
  let you = top.find(s => s.userId === Number(userId)) || null;
  if (!you) {
    const start = key * HOUR_MS;
    const { rows } = await db.query(
      'SELECT COALESCE(SUM(bet_cents), 0) AS wagered FROM bets WHERE user_id = ? AND created_at >= ?',
      [userId, start]
    );
    const wagered = Number(rows[0]?.wagered || 0) / 100;
    if (wagered > 0) you = { rank: null, userId: Number(userId), player: 'you', wagered };
  }
  // Last hour's results (if paid) for the "previous winners" strip.
  const { rows: prevRows } = await db.query('SELECT value FROM settings WHERE key = ?', [`race_paid_${key - 1}`]);
  let lastWinners = [];
  try { lastWinners = prevRows[0] ? JSON.parse(prevRows[0].value) : []; } catch (_) {}
  return {
    endsAt: (key + 1) * HOUR_MS,
    prizes: PRIZES_CENTS.map(c => c / 100),
    minWager: MIN_WAGER_CENTS / 100,
    top, you,
    lastWinners: Array.isArray(lastWinners) ? lastWinners : []
  };
}

module.exports = { state, settlePrevious, hourKey, PRIZES_CENTS, MIN_WAGER_CENTS };
