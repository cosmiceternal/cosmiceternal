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

// Fixed-rate conversion table. Real processors will quote market rates; the
// play-money processor uses these as the displayed "exchange rate". `rate` is
// FUN per currency-unit, so funCents = units * rate * 100. Tuned so the
// preset chips line up cleanly with the per-day cap (default 5000 FUN).
//   1 BTC  ->  50,000 FUN   (0.001 BTC = 50 FUN)
//   1 ETH  ->   3,000 FUN   (0.01 ETH = 30 FUN)
//   1 USDT ->       1 FUN
//   1 SOL  ->     150 FUN   (0.1 SOL = 15 FUN)
const CURRENCIES = {
  BTC:  { rate: 50_000, decimals: 8, presets: [0.001, 0.005, 0.01, 0.05], min: 0.0005 },
  ETH:  { rate:  3_000, decimals: 6, presets: [0.01, 0.05, 0.1, 0.5],     min: 0.005 },
  USDT: { rate:      1, decimals: 2, presets: [10, 50, 100, 500],         min: 5 },
  SOL:  { rate:    150, decimals: 4, presets: [0.1, 0.5, 1, 5],           min: 0.05 }
};
const DEFAULT_CAP_CENTS = Math.round(Number(process.env.DAILY_DEPOSIT_CAP_FUN || 5000) * 100);
const MAX_PENDING = Number(process.env.MAX_PENDING_DEPOSITS || 5);

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
  return {
    processor: p.name,
    processorLabel: p.label,
    playmoney: isPlaymoney(),
    currencies: Object.entries(CURRENCIES).map(([code, cfg]) => ({
      code, presets: cfg.presets, decimals: cfg.decimals,
      funPerUnit: cfg.rate, min: cfg.min
    })),
    dailyCapFun: DEFAULT_CAP_CENTS / 100,
    dailyUsedFun: (await dailyTotal(userId)) / 100
  };
}

async function createDeposit(req, userId, { currency, amount }) {
  const cfg = CURRENCIES[currency];
  if (!cfg) throw httpError(400, 'Unsupported currency.');
  const units = Number(amount);
  if (!isFinite(units) || units <= 0) throw httpError(400, 'Invalid amount.');
  if (units < cfg.min) throw httpError(400, `Minimum ${currency} deposit is ${fmtCurrency(currency, cfg.min)}.`);
  const funCents = Math.round(units * cfg.rate * 100);
  if (funCents <= 0) throw httpError(400, 'Amount too small to credit any FUN.');

  // Daily cap (applied across all completed deposits today + this in-flight one).
  // dailyTotal() returns cents — same units as DEFAULT_CAP_CENTS and funCents.
  const usedCents = await dailyTotal(userId);
  if (usedCents + funCents > DEFAULT_CAP_CENTS) {
    const remaining = Math.max(0, (DEFAULT_CAP_CENTS - usedCents) / 100);
    throw httpError(429, `Daily deposit cap reached. Remaining today: ${remaining.toFixed(2)} FUN.`);
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
    if (usedCents + Number(dep.fun_credited) > DEFAULT_CAP_CENTS) {
      await q("UPDATE deposits SET status = 'cancelled' WHERE id = ?", [depositId]);
      throw httpError(429, 'Daily cap would be exceeded by this deposit.');
    }
    await q('UPDATE users SET balance_cents = balance_cents + ? WHERE id = ?', [Number(dep.fun_credited), userId]);
    await q("UPDATE deposits SET status = 'completed' WHERE id = ?", [depositId]);
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
  validate,
  CURRENCIES, DEFAULT_CAP_CENTS, MAX_PENDING, isPlaymoney
};
