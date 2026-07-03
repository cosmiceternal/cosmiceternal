'use strict';

/* Responsible gaming. Two server-enforced tools:
 *   - Daily loss limit: once today's net loss (wagered − returned) reaches
 *     the user-set cap, new wagers are refused until midnight.
 *   - Self-exclusion: the user locks themselves out of wagering and
 *     depositing for 1/7/30 days. Deliberately NOT reversible by the user —
 *     and withdrawals stay available the whole time, matching how licensed
 *     operators are required to behave.
 * Both are enforced in the wager path itself (games.debit), so no client
 * can bypass them. */

const db = require('./db');
const { httpError, logAudit } = require('./auth');

const EXCLUDE_DAYS = new Set([1, 7, 30]);

function startOfDay() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }

// Called from the wager path with the tx query fn. Throws a clear 403 when
// the user is excluded or the loss limit is spent.
async function enforceWagerEligibility(q, userId) {
  const { rows } = await q('SELECT loss_limit_cents, excluded_until FROM users WHERE id = ?', [userId]);
  const u = rows[0];
  if (!u) return;
  const now = Date.now();
  if (u.excluded_until && Number(u.excluded_until) > now) {
    const days = Math.ceil((Number(u.excluded_until) - now) / 86_400_000);
    throw httpError(403, `Self-exclusion active — wagering unlocks in ${days} day${days === 1 ? '' : 's'}. Withdrawals remain available.`);
  }
  const limit = Number(u.loss_limit_cents);
  if (limit > 0) {
    const { rows: agg } = await q(
      'SELECT COALESCE(SUM(bet_cents - payout_cents), 0) AS net FROM bets WHERE user_id = ? AND created_at >= ?',
      [userId, startOfDay()]
    );
    if (Number(agg[0]?.net || 0) >= limit) {
      throw httpError(403, `Daily loss limit reached (${(limit / 100).toFixed(2)} CRYPT). It resets at midnight — take a break.`);
    }
  }
}

// Deposits are blocked during self-exclusion too (loss limits only govern wagers).
async function enforceDepositEligibility(q, userId) {
  const { rows } = await q('SELECT excluded_until FROM users WHERE id = ?', [userId]);
  const u = rows[0];
  if (u && u.excluded_until && Number(u.excluded_until) > Date.now()) {
    throw httpError(403, 'Self-exclusion active — deposits are paused. Withdrawals remain available.');
  }
}

async function state(userId) {
  const { rows } = await db.query('SELECT loss_limit_cents, excluded_until FROM users WHERE id = ?', [userId]);
  const u = rows[0] || {};
  const { rows: agg } = await db.query(
    'SELECT COALESCE(SUM(bet_cents - payout_cents), 0) AS net FROM bets WHERE user_id = ? AND created_at >= ?',
    [userId, startOfDay()]
  );
  const excludedUntil = Number(u.excluded_until) || 0;
  return {
    lossLimit: u.loss_limit_cents ? Number(u.loss_limit_cents) / 100 : null,
    netLossToday: Math.max(0, Number(agg[0]?.net || 0)) / 100,
    excludedUntil: excludedUntil > Date.now() ? excludedUntil : null
  };
}

async function setLossLimit(req, userId, { lossLimit }) {
  if (lossLimit === null || lossLimit === undefined || lossLimit === 0) {
    // Removing a limit is intentionally delayed in real casinos; for the
    // play-money build we allow it immediately but audit it loudly.
    await db.query('UPDATE users SET loss_limit_cents = NULL WHERE id = ?', [userId]);
    logAudit(req, 'limits.loss_limit_removed', userId, null);
    return state(userId);
  }
  const v = Number(lossLimit);
  if (!isFinite(v) || v < 1 || v > 1_000_000) throw httpError(400, 'Loss limit must be between 1 and 1,000,000 CRYPT.');
  await db.query('UPDATE users SET loss_limit_cents = ? WHERE id = ?', [Math.round(v * 100), userId]);
  logAudit(req, 'limits.loss_limit_set', userId, { lossLimit: v });
  return state(userId);
}

async function selfExclude(req, userId, { days }) {
  const d = Number(days);
  if (!EXCLUDE_DAYS.has(d)) throw httpError(400, 'Exclusion period must be 1, 7 or 30 days.');
  const until = Date.now() + d * 86_400_000;
  // Never shorten an existing exclusion.
  const { rows } = await db.query('SELECT excluded_until FROM users WHERE id = ?', [userId]);
  const current = Number(rows[0]?.excluded_until) || 0;
  const target = Math.max(current, until);
  await db.query('UPDATE users SET excluded_until = ? WHERE id = ?', [target, userId]);
  logAudit(req, 'limits.self_exclude', userId, { days: d, until: target });
  return state(userId);
}

module.exports = { state, setLossLimit, selfExclude, enforceWagerEligibility, enforceDepositEligibility };
