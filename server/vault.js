'use strict';

/* Crypto Vault — deposit portal.
 *
 * Architecture: every deposit goes through a `processor` adapter, so the same
 * server code drives play-money today (the only built-in processor, clearly
 * labelled) and a real licensed crypto processor (NowPayments, Coinpayments,
 * BTCPayServer, …) tomorrow via a config swap. Real-money deposits require
 * the operator to plug in a real processor — this file deliberately ships
 * with ONLY the play-money processor.
 *
 * Daily cap and accounting are applied around the processor call, so the
 * faucet behaviour and the audit story are processor-agnostic. */

const crypto = require('crypto');
const db = require('./db');
const { httpError, logAudit } = require('./auth');
const limits = require('./limits');

// Fixed-rate conversion table. Real processors will quote market rates; the
// play-money processor uses these as the displayed "exchange rate". `rate` is
// CRYPT per currency-unit, so funCents = units * rate * 100. Tuned so the
// preset chips line up cleanly with the per-day cap (default 5000 CRYPT).
//   1 BTC  ->  50,000 CRYPT   (0.001 BTC = 50 CRYPT)
//   1 ETH  ->   3,000 CRYPT   (0.01 ETH = 30 CRYPT)
//   1 USDT ->       1 CRYPT
//   1 SOL  ->     150 CRYPT   (0.1 SOL = 15 CRYPT)
const CURRENCIES = {
  BTC:  { rate: 50_000, decimals: 8, presets: [0.001, 0.005, 0.01, 0.05], min: 0.0005 },
  ETH:  { rate:  3_000, decimals: 6, presets: [0.01, 0.05, 0.1, 0.5],     min: 0.005 },
  USDT: { rate:      1, decimals: 2, presets: [10, 50, 100, 500],         min: 5 },
  SOL:  { rate:    150, decimals: 4, presets: [0.1, 0.5, 1, 5],           min: 0.05 }
};
const MAX_PENDING = Number(process.env.MAX_PENDING_DEPOSITS || 5);
const WITHDRAW_CAP_CENTS = Math.round(Number(process.env.DAILY_WITHDRAW_CAP_CRYPT || 5000) * 100);
const WITHDRAW_MIN_CENTS = Math.round(Number(process.env.MIN_WITHDRAW_CRYPT || 10) * 100);

function fmtCurrency(currency, units) {
  const cfg = CURRENCIES[currency];
  return Number(units).toFixed(cfg ? cfg.decimals : 4);
}
function startOfDay() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }

// Processor adapter interface — all methods take a deposit row and return
// either { status, txid, address } (sync settle for play-money) or schedule
// a webhook callback (real processors).
const PROCESSORS = {
  playmoney: {
    name: 'playmoney',
    label: 'Play-money simulator',
    async createDeposit(deposit) {
      // Fake but plausibly-shaped deposit address (for visual flavour only).
      const buf = crypto.randomBytes(20);
      const fakeAddr =
        deposit.currency === 'BTC'  ? 'bc1q' + buf.toString('hex').slice(0, 38) :
        deposit.currency === 'ETH'  ? '0x'   + buf.toString('hex') :
        deposit.currency === 'USDT' ? '0x'   + buf.toString('hex') :
        deposit.currency === 'SOL'  ? buf.toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 44)
                                    : buf.toString('hex');
      const fakeTxid = crypto.randomBytes(32).toString('hex');
      return { address: fakeAddr, txid: fakeTxid, status: 'pending', confirmsRequired: 3 };
    }
    // NOTE: a real processor would also implement: verifyWebhook(req), settleFromWebhook(payload).
  },

  // CoinPayments adapter. Set VAULT_PROCESSOR=coinpayments and the four
  // COINPAYMENTS_* env vars on your host. IPN URL on CoinPayments must point
  // at https://<your-domain>/api/vault/webhook.
  coinpayments: {
    name: 'coinpayments',
    label: 'CoinPayments',
    async createDeposit(deposit) {
      const key    = process.env.COINPAYMENTS_KEY;
      const secret = process.env.COINPAYMENTS_SECRET;
      if (!key || !secret) throw new Error('COINPAYMENTS_KEY / COINPAYMENTS_SECRET not configured.');
      const params = new URLSearchParams({
        version:    '1',
        cmd:        'create_transaction',
        key,
        amount:     String(deposit.units),
        currency1:  deposit.currency,
        currency2:  deposit.currency,
        buyer_email: deposit.email || `user${deposit.userId}@crypt-casino.local`,
        item_name:  `CRYPT credit (deposit #${deposit.id})`,
        custom:     `${deposit.userId}:${deposit.id}`,
        ipn_url:    process.env.COINPAYMENTS_IPN_URL || ''
      });
      const body = params.toString();
      const hmac = crypto.createHmac('sha512', secret).update(body).digest('hex');
      const res = await fetch('https://www.coinpayments.net/api.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', HMAC: hmac },
        body
      });
      const data = await res.json();
      if (data.error !== 'ok') throw new Error('CoinPayments: ' + (data.error || 'unknown error'));
      return {
        address: data.result.address,
        txid:    data.result.txn_id,
        status:  'pending',
        confirmsRequired: Number(data.result.confirms_needed || 1)
      };
    },
    // Verify the IPN HMAC over the raw request body. Returns the parsed
    // payload on success, or null on tamper / missing header.
    verifyWebhook(req) {
      const ipnSecret = process.env.COINPAYMENTS_IPN_SECRET;
      if (!ipnSecret) return null;
      const header = req.headers && req.headers.hmac;
      if (!header || typeof header !== 'string') return null;
      const raw = req.rawBody;
      if (!raw) return null;
      const expected = crypto.createHmac('sha512', ipnSecret).update(raw).digest('hex');
      // Length-checked timing-safe compare.
      const a = Buffer.from(expected, 'utf8');
      const b = Buffer.from(header, 'utf8');
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
      const payload = Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
      // Optional belt-and-braces: merchant id check.
      const merchant = process.env.COINPAYMENTS_MERCHANT_ID;
      if (merchant && payload.merchant && payload.merchant !== merchant) return null;
      return payload;
    },
    // CoinPayments status code map (https://www.coinpayments.net/merchant-tools-ipn):
    //   100, 2 = complete; <0 = failed/cancelled; else pending.
    settleFromWebhook(payload) {
      const status = Number(payload.status);
      let nextStatus = 'pending';
      if (status >= 100 || status === 2) nextStatus = 'completed';
      else if (status < 0) nextStatus = 'cancelled';
      const custom = String(payload.custom || '');
      const [userIdStr, depositIdStr] = custom.split(':');
      return {
        userId:    Number(userIdStr) || null,
        depositId: Number(depositIdStr) || null,
        status:    nextStatus,
        txid:      payload.txn_id || null
      };
    }
  }
};
const PROCESSOR_NAME = process.env.VAULT_PROCESSOR || 'playmoney';
function processor() {
  const p = PROCESSORS[PROCESSOR_NAME];
  if (!p) throw new Error('Unknown VAULT_PROCESSOR: ' + PROCESSOR_NAME);
  return p;
}
const isPlaymoney = () => PROCESSOR_NAME === 'playmoney';

async function dailyTotal(userId) {
  const { rows } = await db.query(
    "SELECT COALESCE(SUM(fun_credited), 0) AS t FROM deposits WHERE user_id = ? AND status = 'completed' AND created_at >= ?",
    [userId, startOfDay()]
  );
  return Number(rows[0]?.t || 0);
}

async function publicSnapshot(userId) {
  const p = processor();
  const [cap, used] = await Promise.all([limits.effectiveDepositCap(userId), dailyTotal(userId)]);
  return {
    processor: p.name,
    processorLabel: p.label,
    playmoney: isPlaymoney(),
    currencies: Object.entries(CURRENCIES).map(([code, cfg]) => ({
      code, presets: cfg.presets, decimals: cfg.decimals,
      funPerUnit: cfg.rate, min: cfg.min
    })),
    dailyCapFun: cap.capCents / 100,
    dailyUsedFun: used / 100,
    // Ramp context so the client can nudge new accounts toward the full cap.
    capTier: cap.tier,                          // 'new' | 'full' | 'override'
    unlockTurnoverFun: cap.unlockCents / 100,
    turnoverFun: cap.turnoverCents / 100
  };
}

async function createDeposit(req, userId, { currency, amount }) {
  await limits.enforceDepositEligibility(db.query, userId);
  const cfg = CURRENCIES[currency];
  if (!cfg) throw httpError(400, 'Unsupported currency.');
  const units = Number(amount);
  if (!isFinite(units) || units <= 0) throw httpError(400, 'Invalid amount.');
  if (units < cfg.min) throw httpError(400, `Minimum ${currency} deposit is ${fmtCurrency(currency, cfg.min)}.`);
  const funCents = Math.round(units * cfg.rate * 100);
  if (funCents <= 0) throw httpError(400, 'Amount too small to credit any CRYPT.');

  // Daily cap (applied across all completed deposits today + this in-flight one).
  // The cap is the user's effective cap: a reduced ramp for new accounts, the
  // full cap once turnover unlocks it, or an admin per-user override.
  // dailyTotal() returns cents — same units as capCents and funCents.
  const { capCents } = await limits.effectiveDepositCap(userId);
  const usedCents = await dailyTotal(userId);
  if (usedCents + funCents > capCents) {
    const remaining = Math.max(0, (capCents - usedCents) / 100);
    throw httpError(429, `Daily deposit cap reached. Remaining today: ${remaining.toFixed(2)} CRYPT.`);
  }
  // Limit the number of in-flight pending deposits so a user can't spam orphan rows.
  const { rows: pendingRows } = await db.query(
    "SELECT COUNT(*) AS n FROM deposits WHERE user_id = ? AND status = 'pending'", [userId]
  );
  if (Number(pendingRows[0]?.n || 0) >= MAX_PENDING) {
    throw httpError(429, `You have ${MAX_PENDING} pending deposits — confirm or cancel one first.`);
  }

  const proc = processor();
  // Insert the pending row first so we have an id to pass to the processor.
  const ins = await db.query(
    `INSERT INTO deposits(user_id, processor, currency, amount_units, fun_credited, status, txid, created_at)
     VALUES(?,?,?,?,?,?,?,?) RETURNING id`,
    [userId, proc.name, currency, units, funCents, 'pending', null, Date.now()]
  );
  const depositId = Number(ins.rows[0].id);
  const procResp = await proc.createDeposit({ id: depositId, userId, currency, units, funCents });
  await db.query('UPDATE deposits SET txid = ? WHERE id = ?', [procResp.txid || null, depositId]);
  logAudit(req, 'vault.deposit_created', userId, { depositId, currency, units, funCents });

  return {
    depositId, currency, amount: units, funCredited: funCents / 100,
    address: procResp.address, txid: procResp.txid,
    confirmsRequired: procResp.confirmsRequired || 3,
    status: procResp.status || 'pending',
    playmoney: isPlaymoney()
  };
}

// Settle the deposit. Play-money mode lets the client call this after the
// confirmation animation. REAL processors must NOT expose this to the client —
// they settle via verified webhook only (see processor.verifyWebhook above).
async function confirmDeposit(req, userId, { depositId }) {
  if (!isPlaymoney()) throw httpError(403, 'Real-processor deposits settle via webhook only.');
  return db.tx(async (q) => {
    const { rows } = await q('SELECT * FROM deposits WHERE id = ? AND user_id = ?', [depositId, userId]);
    const dep = rows[0];
    if (!dep) throw httpError(404, 'Deposit not found.');
    if (dep.status !== 'pending') throw httpError(409, 'Deposit already settled.');
    // Re-check the cap atomically inside the tx (another deposit could have raced in).
    const { rows: agg } = await q(
      "SELECT COALESCE(SUM(fun_credited), 0) AS t FROM deposits WHERE user_id = ? AND status = 'completed' AND created_at >= ?",
      [userId, startOfDay()]
    );
    const usedCents = Number(agg[0]?.t || 0);
    const { capCents } = await limits.effectiveDepositCap(userId);
    if (usedCents + Number(dep.fun_credited) > capCents) {
      await q("UPDATE deposits SET status = 'cancelled' WHERE id = ?", [depositId]);
      throw httpError(429, 'Daily cap would be exceeded by this deposit.');
    }
    // Conditional update FIRST so two concurrent confirms can't both pass.
    // Postgres default READ COMMITTED can let two SELECTs both see 'pending';
    // the row-locking UPDATE here is what serializes them. The second one
    // updates 0 rows and we abort before crediting.
    const upd = await q("UPDATE deposits SET status = 'completed' WHERE id = ? AND status = 'pending'", [depositId]);
    if (!upd.rowCount) throw httpError(409, 'Deposit already settled.');
    await q('UPDATE users SET balance_cents = balance_cents + ? WHERE id = ?', [Number(dep.fun_credited), userId]);
    const { rows: balRow } = await q('SELECT balance_cents FROM users WHERE id = ?', [userId]);
    logAudit(req, 'vault.deposit_completed', userId, { depositId, funCredited: Number(dep.fun_credited) });
    return {
      depositId, status: 'completed',
      funCredited: Number(dep.fun_credited) / 100,
      balance: Number(balRow[0].balance_cents) / 100
    };
  });
}

async function cancelDeposit(req, userId, { depositId }) {
  const r = await db.query(
    "UPDATE deposits SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status = 'pending'",
    [depositId, userId]
  );
  if (!r.rowCount) throw httpError(404, 'No pending deposit with that id.');
  logAudit(req, 'vault.deposit_cancelled', userId, { depositId });
  return { depositId: Number(depositId), status: 'cancelled' };
}

// Webhook entry point. Verifies the signature via the active processor, then
// settles the matching deposit atomically inside a tx. Returns
// { ok: true|false, status?, depositId? }.
async function handleWebhook(req) {
  const proc = processor();
  if (!proc.verifyWebhook || !proc.settleFromWebhook) {
    return { ok: false, reason: 'processor-not-webhook-capable' };
  }
  const payload = proc.verifyWebhook(req);
  if (!payload) return { ok: false, reason: 'invalid-signature' };
  const event = proc.settleFromWebhook(payload);
  if (!event.depositId) return { ok: false, reason: 'no-deposit-id' };
  return db.tx(async (q) => {
    const { rows } = await q('SELECT * FROM deposits WHERE id = ? AND user_id = ?', [event.depositId, event.userId]);
    const dep = rows[0];
    if (!dep) return { ok: false, reason: 'unknown-deposit' };
    // Idempotency: already-settled deposits are a no-op (CoinPayments retries
    // an IPN until it gets a 200, so duplicates are normal).
    if (dep.status !== 'pending') return { ok: true, status: dep.status, depositId: dep.id };
    if (event.status === 'completed') {
      // Conditional update FIRST — IPN retries can deliver the same payload in
      // parallel; only the row-update that actually flipped pending→completed
      // is allowed to credit the balance.
      const upd = await q(
        "UPDATE deposits SET status = 'completed', txid = COALESCE(?, txid) WHERE id = ? AND status = 'pending'",
        [event.txid, dep.id]
      );
      if (!upd.rowCount) return { ok: true, status: 'completed', depositId: dep.id, dedup: true };
      await q('UPDATE users SET balance_cents = balance_cents + ? WHERE id = ?', [Number(dep.fun_credited), dep.user_id]);
      logAudit(req, 'vault.deposit_completed', dep.user_id, { depositId: dep.id, funCredited: Number(dep.fun_credited), via: 'webhook' });
    } else if (event.status === 'cancelled') {
      await q("UPDATE deposits SET status = 'cancelled' WHERE id = ? AND status = 'pending'", [dep.id]);
      logAudit(req, 'vault.deposit_cancelled', dep.user_id, { depositId: dep.id, via: 'webhook' });
    }
    return { ok: true, status: event.status, depositId: dep.id };
  });
}

async function listDeposits(userId, limit = 25) {
  limit = Math.max(1, Math.min(100, Number(limit) || 25));
  const { rows } = await db.query(
    'SELECT id, processor, currency, amount_units, fun_credited, status, txid, created_at FROM deposits WHERE user_id = ? ORDER BY id DESC LIMIT ?',
    [userId, limit]
  );
  return rows.map(r => ({
    id: Number(r.id), processor: r.processor, currency: r.currency,
    amount: Number(r.amount_units), funCredited: Number(r.fun_credited) / 100,
    status: r.status, txid: r.txid, ts: Number(r.created_at)
  }));
}

// ---------------- Withdrawals ----------------
// Play-money mode completes instantly with a simulated txid. Real-processor
// mode records the request as 'pending' — the operator settles it manually
// (or via the admin console) after the on-chain payout; the balance is
// debited up-front atomically so a user can't spend CRYPT that's queued to
// leave. Cancelling a pending withdrawal refunds it.
async function withdrawnToday(q, userId) {
  const { rows } = await q(
    "SELECT COALESCE(SUM(fun_debited), 0) AS t FROM withdrawals WHERE user_id = ? AND status IN ('pending','completed') AND created_at >= ?",
    [userId, startOfDay()]
  );
  return Number(rows[0]?.t || 0);
}

async function createWithdrawal(req, userId, { currency, amount, address }) {
  const cfg = CURRENCIES[currency];
  if (!cfg) throw httpError(400, 'Unsupported currency.');
  const units = Number(amount);
  if (!isFinite(units) || units <= 0) throw httpError(400, 'Invalid amount.');
  const addr = String(address || '').trim();
  if (addr.length < 10 || addr.length > 120) throw httpError(400, 'Enter a valid destination address.');
  const funCents = Math.round(units * cfg.rate * 100);
  if (funCents < WITHDRAW_MIN_CENTS) {
    throw httpError(400, `Minimum withdrawal is ${(WITHDRAW_MIN_CENTS / 100).toFixed(2)} CRYPT.`);
  }
  return db.tx(async (q) => {
    // Debit FIRST: the conditional UPDATE doubles as the balance check AND
    // (on Postgres) takes the user row lock, serializing concurrent
    // withdrawals for the same user. The cap check runs after, so the second
    // of two racing requests sees the first's committed row and can't
    // breach the daily cap. Throwing rolls the debit back.
    const upd = await q(
      'UPDATE users SET balance_cents = balance_cents - ? WHERE id = ? AND balance_cents >= ?',
      [funCents, userId, funCents]
    );
    if (!upd.rowCount) throw httpError(400, 'Insufficient balance.');
    const used = await withdrawnToday(q, userId);
    if (used + funCents > WITHDRAW_CAP_CENTS) {
      const remaining = Math.max(0, (WITHDRAW_CAP_CENTS - used) / 100);
      throw httpError(429, `Daily withdrawal cap reached. Remaining today: ${remaining.toFixed(2)} CRYPT.`);
    }
    const instant = isPlaymoney();
    const status = instant ? 'completed' : 'pending';
    const txid = instant ? crypto.randomBytes(32).toString('hex') : null;
    const ins = await q(
      `INSERT INTO withdrawals(user_id, processor, currency, amount_units, fun_debited, address, status, txid, created_at)
       VALUES(?,?,?,?,?,?,?,?,?) RETURNING id`,
      [userId, PROCESSOR_NAME, currency, units, funCents, addr, status, txid, Date.now()]
    );
    const id = Number(ins.rows[0].id);
    logAudit(req, 'vault.withdrawal_created', userId, { withdrawalId: id, currency, units, funCents, status });
    const { rows: balRow } = await q('SELECT balance_cents FROM users WHERE id = ?', [userId]);
    return {
      withdrawalId: id, currency, amount: units,
      funDebited: funCents / 100, address: addr, status, txid,
      playmoney: instant,
      balance: Number(balRow[0].balance_cents) / 100
    };
  });
}

async function cancelWithdrawal(req, userId, { withdrawalId }) {
  return db.tx(async (q) => {
    const upd = await q(
      "UPDATE withdrawals SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status = 'pending'",
      [withdrawalId, userId]
    );
    if (!upd.rowCount) throw httpError(404, 'No pending withdrawal with that id.');
    const { rows } = await q('SELECT fun_debited FROM withdrawals WHERE id = ?', [withdrawalId]);
    await q('UPDATE users SET balance_cents = balance_cents + ? WHERE id = ?', [Number(rows[0].fun_debited), userId]);
    logAudit(req, 'vault.withdrawal_cancelled', userId, { withdrawalId: Number(withdrawalId) });
    const { rows: balRow } = await q('SELECT balance_cents FROM users WHERE id = ?', [userId]);
    return { withdrawalId: Number(withdrawalId), status: 'cancelled', balance: Number(balRow[0].balance_cents) / 100 };
  });
}

async function listWithdrawals(userId, limit = 25) {
  limit = Math.max(1, Math.min(100, Number(limit) || 25));
  const { rows } = await db.query(
    'SELECT id, processor, currency, amount_units, fun_debited, address, status, txid, created_at FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT ?',
    [userId, limit]
  );
  return rows.map(r => ({
    id: Number(r.id), processor: r.processor, currency: r.currency,
    amount: Number(r.amount_units), funDebited: Number(r.fun_debited) / 100,
    address: r.address, status: r.status, txid: r.txid, ts: Number(r.created_at)
  }));
}

// Admin: complete (operator has paid out on-chain) or cancel-with-refund a
// pending withdrawal, for any user.
async function adminSettleWithdrawal(req, { withdrawalId, action, txid }) {
  if (action !== 'complete' && action !== 'cancel') throw httpError(400, "Action must be 'complete' or 'cancel'.");
  return db.tx(async (q) => {
    const next = action === 'complete' ? 'completed' : 'cancelled';
    const upd = await q(
      "UPDATE withdrawals SET status = ?, txid = COALESCE(?, txid) WHERE id = ? AND status = 'pending'",
      [next, txid || null, withdrawalId]
    );
    if (!upd.rowCount) throw httpError(404, 'No pending withdrawal with that id.');
    const { rows } = await q('SELECT user_id, fun_debited FROM withdrawals WHERE id = ?', [withdrawalId]);
    if (action === 'cancel') {
      await q('UPDATE users SET balance_cents = balance_cents + ? WHERE id = ?', [Number(rows[0].fun_debited), Number(rows[0].user_id)]);
    }
    logAudit(req, `admin.withdrawal_${action}`, req.user.id, { withdrawalId: Number(withdrawalId), target: Number(rows[0].user_id) });
    return { withdrawalId: Number(withdrawalId), status: next };
  });
}

async function adminListWithdrawals({ status = null, limit = 100 } = {}) {
  limit = Math.min(500, Math.max(1, Number(limit) || 100));
  let sql = `SELECT w.id, w.user_id, u.username, w.processor, w.currency, w.amount_units, w.fun_debited, w.address, w.status, w.txid, w.created_at
             FROM withdrawals w JOIN users u ON u.id = w.user_id`;
  const params = [];
  if (status) { sql += ' WHERE w.status = ?'; params.push(String(status)); }
  sql += ' ORDER BY w.id DESC LIMIT ?';
  params.push(limit);
  const { rows } = await db.query(sql, params);
  return {
    withdrawals: rows.map(r => ({
      id: Number(r.id), userId: Number(r.user_id), username: r.username,
      processor: r.processor, currency: r.currency,
      amount: Number(r.amount_units), funDebited: Number(r.fun_debited) / 100,
      address: r.address, status: r.status, txid: r.txid, ts: Number(r.created_at)
    }))
  };
}

// Throws at startup if VAULT_PROCESSOR points at something this build doesn't
// know about. Surfaces the typo at deploy instead of on the first user request.
function validate() {
  if (!PROCESSORS[PROCESSOR_NAME]) {
    throw new Error(
      `Unknown VAULT_PROCESSOR '${PROCESSOR_NAME}'. Available: ${Object.keys(PROCESSORS).join(', ')}.`
    );
  }
}

module.exports = {
  publicSnapshot, createDeposit, confirmDeposit, cancelDeposit, listDeposits,
  createWithdrawal, cancelWithdrawal, listWithdrawals,
  adminSettleWithdrawal, adminListWithdrawals,
  handleWebhook, validate,
  CURRENCIES, MAX_PENDING, WITHDRAW_CAP_CENTS, WITHDRAW_MIN_CENTS, isPlaymoney
};
