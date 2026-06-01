'use strict';

/* Admin API. Every state-changing handler audits to `admin.*` so an admin's
 * actions are themselves traceable. All endpoints require requireAdmin. */

const db = require('./db');
const { httpError, logAudit } = require('./auth');

async function overview() {
  const [{ rows: u }, { rows: b }, { rows: a }] = await Promise.all([
    db.query('SELECT COUNT(*) AS n, COALESCE(SUM(balance_cents), 0) AS balance, COALESCE(SUM(xp), 0) AS xp FROM users'),
    db.query('SELECT COUNT(*) AS n, COALESCE(SUM(bet_cents), 0) AS wagered, COALESCE(SUM(payout_cents), 0) AS paid FROM bets'),
    db.query("SELECT COUNT(*) AS n FROM users WHERE locked = 1")
  ]);
  return {
    users:        Number(u[0].n),
    totalBalance: Number(u[0].balance) / 100,
    totalXp:      Number(u[0].xp),
    bets:         Number(b[0].n),
    wagered:      Number(b[0].wagered) / 100,
    paidOut:      Number(b[0].paid) / 100,
    houseEdge:    Number(b[0].wagered) > 0 ? (1 - Number(b[0].paid) / Number(b[0].wagered)) : 0,
    lockedUsers:  Number(a[0].n)
  };
}

async function listUsers({ search = '', limit = 50, offset = 0 } = {}) {
  limit  = Math.min(200, Math.max(1, Number(limit)  || 50));
  offset = Math.max(0, Number(offset) || 0);
  const like = '%' + String(search).slice(0, 32).replace(/[%_]/g, '') + '%';
  const { rows } = await db.query(
    `SELECT u.id, u.username, u.balance_cents, u.xp, u.level, u.streak_day, u.is_admin, u.locked, u.created_at,
            (SELECT COUNT(*) FROM bets b WHERE b.user_id = u.id) AS bet_count,
            (SELECT COALESCE(SUM(b.bet_cents), 0) FROM bets b WHERE b.user_id = u.id) AS wagered
     FROM users u
     WHERE u.username LIKE ?
     ORDER BY u.id DESC
     LIMIT ? OFFSET ?`,
    [like, limit, offset]
  );
  return {
    users: rows.map(r => ({
      id: Number(r.id),
      username: r.username,
      balance: Number(r.balance_cents) / 100,
      xp: Number(r.xp || 0),
      level: Number(r.level || 1),
      streakDay: Number(r.streak_day || 0),
      isAdmin: Number(r.is_admin || 0) === 1,
      locked: Number(r.locked || 0) === 1,
      createdAt: Number(r.created_at),
      betCount: Number(r.bet_count || 0),
      wagered: Number(r.wagered || 0) / 100
    }))
  };
}

async function userDetail(userId) {
  const { rows } = await db.query('SELECT * FROM users WHERE id = ?', [userId]);
  const u = rows[0];
  if (!u) throw httpError(404, 'User not found.');
  const [{ rows: bets }, { rows: audit }, { rows: deposits }] = await Promise.all([
    db.query('SELECT id, game, bet_cents, mult, payout_cents, win, created_at FROM bets WHERE user_id = ? ORDER BY id DESC LIMIT 25', [userId]),
    db.query('SELECT event, ip, user_agent, meta, created_at FROM audit_log WHERE user_id = ? ORDER BY id DESC LIMIT 25', [userId]),
    db.query('SELECT id, processor, currency, amount_units, fun_credited, status, created_at FROM deposits WHERE user_id = ? ORDER BY id DESC LIMIT 10', [userId])
  ]);
  return {
    user: {
      id: Number(u.id), username: u.username,
      balance: Number(u.balance_cents) / 100,
      xp: Number(u.xp || 0), level: Number(u.level || 1),
      streakDay: Number(u.streak_day || 0),
      isAdmin: Number(u.is_admin || 0) === 1,
      locked: Number(u.locked || 0) === 1,
      createdAt: Number(u.created_at)
    },
    bets: bets.map(b => ({
      id: Number(b.id), game: b.game,
      bet: Number(b.bet_cents) / 100,
      mult: Number(b.mult),
      payout: Number(b.payout_cents) / 100,
      win: Number(b.win) === 1,
      ts: Number(b.created_at)
    })),
    audit: audit.map(a => ({
      event: a.event, ip: a.ip, userAgent: a.user_agent,
      meta: a.meta ? (typeof a.meta === 'string' ? safeJson(a.meta) : a.meta) : null,
      ts: Number(a.created_at)
    })),
    deposits: deposits.map(d => ({
      id: Number(d.id), processor: d.processor, currency: d.currency,
      amount: Number(d.amount_units), funCredited: Number(d.fun_credited) / 100,
      status: d.status, ts: Number(d.created_at)
    }))
  };
}
function safeJson(s) { try { return JSON.parse(s); } catch (_) { return s; } }

async function adjustBalance(req, userId, { mode, amount }) {
  const a = Number(amount);
  if (!isFinite(a)) throw httpError(400, 'Amount must be a number.');
  const cents = Math.round(a * 100);
  if (mode !== 'set' && mode !== 'add') throw httpError(400, "mode must be 'set' or 'add'.");
  return db.tx(async (q) => {
    const { rows } = await q('SELECT balance_cents FROM users WHERE id = ?', [userId]);
    if (!rows[0]) throw httpError(404, 'User not found.');
    const oldCents = Number(rows[0].balance_cents);
    let newCents;
    if (mode === 'set') {
      if (cents < 0) throw httpError(400, 'Set value cannot be negative.');
      newCents = cents;
    } else {
      newCents = oldCents + cents;
      if (newCents < 0) throw httpError(400, 'Adjustment would put balance below zero.');
    }
    await q('UPDATE users SET balance_cents = ? WHERE id = ?', [newCents, userId]);
    logAudit(req, 'admin.balance_change', req.user.id, { target: Number(userId), mode, amount: a, oldBalance: oldCents / 100, newBalance: newCents / 100 });
    return { id: Number(userId), oldBalance: oldCents / 100, newBalance: newCents / 100 };
  });
}

async function setLock(req, userId, { locked }) {
  const flag = locked ? 1 : 0;
  const r = await db.query('UPDATE users SET locked = ? WHERE id = ?', [flag, userId]);
  if (!r.rowCount) throw httpError(404, 'User not found.');
  logAudit(req, flag ? 'admin.lock' : 'admin.unlock', req.user.id, { target: Number(userId) });
  return { id: Number(userId), locked: !!flag };
}

async function setAdmin(req, userId, { isAdmin }) {
  // Guard: an admin can't demote themselves (last-admin lockout).
  if (Number(userId) === Number(req.user.id) && !isAdmin) {
    throw httpError(400, 'You cannot demote yourself.');
  }
  const flag = isAdmin ? 1 : 0;
  const r = await db.query('UPDATE users SET is_admin = ? WHERE id = ?', [flag, userId]);
  if (!r.rowCount) throw httpError(404, 'User not found.');
  logAudit(req, flag ? 'admin.promote' : 'admin.demote', req.user.id, { target: Number(userId) });
  return { id: Number(userId), isAdmin: !!flag };
}

async function recentBets({ limit = 100 } = {}) {
  limit = Math.min(500, Math.max(1, Number(limit) || 100));
  const { rows } = await db.query(
    `SELECT b.id, b.user_id, u.username, b.game, b.bet_cents, b.mult, b.payout_cents, b.win, b.created_at
     FROM bets b
     JOIN users u ON u.id = b.user_id
     ORDER BY b.id DESC LIMIT ?`, [limit]
  );
  return {
    bets: rows.map(r => ({
      id: Number(r.id), userId: Number(r.user_id), username: r.username,
      game: r.game, bet: Number(r.bet_cents) / 100, mult: Number(r.mult),
      payout: Number(r.payout_cents) / 100, win: Number(r.win) === 1,
      ts: Number(r.created_at)
    }))
  };
}

async function recentAudit({ limit = 100, event = null } = {}) {
  limit = Math.min(500, Math.max(1, Number(limit) || 100));
  let sql = `SELECT a.id, a.event, a.user_id, u.username, a.ip, a.meta, a.created_at
             FROM audit_log a
             LEFT JOIN users u ON u.id = a.user_id`;
  const params = [];
  if (event) { sql += ' WHERE a.event = ?'; params.push(event); }
  sql += ' ORDER BY a.id DESC LIMIT ?';
  params.push(limit);
  const { rows } = await db.query(sql, params);
  return {
    events: rows.map(r => ({
      id: Number(r.id), event: r.event, userId: r.user_id ? Number(r.user_id) : null,
      username: r.username, ip: r.ip,
      meta: r.meta ? safeJson(r.meta) : null,
      ts: Number(r.created_at)
    }))
  };
}

module.exports = {
  overview, listUsers, userDetail,
  adjustBalance, setLock, setAdmin,
  recentBets, recentAudit
};
