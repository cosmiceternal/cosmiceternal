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

// ---------------- Deposit limits (graduated + admin override) ----------------
// New accounts get a reduced daily deposit cap until they've wagered enough
// (turnover gate), then the full cap unlocks. Admins can tune the three knobs
// globally, or set a hard per-user override that wins over the ramp entirely.
const DEP_KEYS = {
  newCap:  'deposit_new_cap_cents',
  unlock:  'deposit_unlock_turnover_cents',
  fullCap: 'deposit_full_cap_cents'
};
// Full-cap default mirrors vault's DEFAULT_CAP_CENTS so behaviour is unchanged
// until an admin configures the ramp.
const DEP_DEFAULTS = {
  newCap:  Math.round(Number(process.env.DEPOSIT_NEW_CAP_CRYPT || 500) * 100),
  unlock:  Math.round(Number(process.env.DEPOSIT_UNLOCK_CRYPT || 2500) * 100),
  fullCap: Math.round(Number(process.env.DAILY_DEPOSIT_CAP_CRYPT || process.env.DAILY_DEPOSIT_CAP_FUN || 5000) * 100)
};

async function depositConfig() {
  const [n, u, f] = await Promise.all([
    db.getSetting(DEP_KEYS.newCap),
    db.getSetting(DEP_KEYS.unlock),
    db.getSetting(DEP_KEYS.fullCap)
  ]);
  const num = (v, d) => { const x = Number(v); return v != null && isFinite(x) && x >= 0 ? x : d; };
  return {
    newCapCents:  num(n, DEP_DEFAULTS.newCap),
    unlockCents:  num(u, DEP_DEFAULTS.unlock),
    fullCapCents: num(f, DEP_DEFAULTS.fullCap)
  };
}

async function setDepositConfig(req, { newCap, unlock, fullCap } = {}) {
  const toCents = (v, label) => {
    const x = Number(v);
    if (!isFinite(x) || x < 0 || x > 10_000_000) throw httpError(400, `${label} must be between 0 and 10,000,000 CRYPT.`);
    return Math.round(x * 100);
  };
  const cfg = await depositConfig();
  const next = {
    newCapCents:  newCap  === undefined ? cfg.newCapCents  : toCents(newCap,  'New-account cap'),
    unlockCents:  unlock  === undefined ? cfg.unlockCents  : toCents(unlock,  'Unlock threshold'),
    fullCapCents: fullCap === undefined ? cfg.fullCapCents : toCents(fullCap, 'Full cap')
  };
  if (next.newCapCents > next.fullCapCents) throw httpError(400, 'New-account cap cannot exceed the full cap.');
  await Promise.all([
    db.setSetting(DEP_KEYS.newCap,  String(next.newCapCents)),
    db.setSetting(DEP_KEYS.unlock,  String(next.unlockCents)),
    db.setSetting(DEP_KEYS.fullCap, String(next.fullCapCents))
  ]);
  logAudit(req, 'admin.deposit_config', req.user.id, {
    newCap: next.newCapCents / 100, unlock: next.unlockCents / 100, fullCap: next.fullCapCents / 100
  });
  return depositConfig();
}

// Effective daily deposit cap for a user: a hard admin override wins; otherwise
// the ramp — reduced cap until lifetime turnover clears the unlock threshold.
async function effectiveDepositCap(userId) {
  const { rows } = await db.query('SELECT deposit_limit_cents FROM users WHERE id = ?', [userId]);
  const override = rows[0] && rows[0].deposit_limit_cents != null ? Number(rows[0].deposit_limit_cents) : null;
  const cfg = await depositConfig();
  const { rows: t } = await db.query('SELECT COALESCE(SUM(bet_cents), 0) AS w FROM bets WHERE user_id = ?', [userId]);
  const turnoverCents = Number(t[0]?.w || 0);
  if (override != null) {
    return { capCents: override, tier: 'override', turnoverCents, unlockCents: cfg.unlockCents, override: true };
  }
  const unlocked = turnoverCents >= cfg.unlockCents;
  return {
    capCents: unlocked ? cfg.fullCapCents : cfg.newCapCents,
    tier: unlocked ? 'full' : 'new',
    turnoverCents, unlockCents: cfg.unlockCents, override: false
  };
}

// Admin sets/clears a per-user hard deposit cap (in CRYPT; null clears it).
async function setUserDepositLimit(req, userId, { limit } = {}) {
  if (limit === null || limit === undefined || limit === '') {
    const r = await db.query('UPDATE users SET deposit_limit_cents = NULL WHERE id = ?', [userId]);
    if (!r.rowCount) throw httpError(404, 'User not found.');
    logAudit(req, 'admin.deposit_limit_cleared', req.user.id, { target: Number(userId) });
    return effectiveDepositCap(userId);
  }
  const v = Number(limit);
  if (!isFinite(v) || v < 0 || v > 10_000_000) throw httpError(400, 'Deposit limit must be between 0 and 10,000,000 CRYPT.');
  const r = await db.query('UPDATE users SET deposit_limit_cents = ? WHERE id = ?', [Math.round(v * 100), userId]);
  if (!r.rowCount) throw httpError(404, 'User not found.');
  logAudit(req, 'admin.deposit_limit_set', req.user.id, { target: Number(userId), limit: v });
  return effectiveDepositCap(userId);
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

module.exports = {
  state, setLossLimit, selfExclude, enforceWagerEligibility, enforceDepositEligibility,
  depositConfig, setDepositConfig, effectiveDepositCap, setUserDepositLimit
};
