'use strict';

/* Server-authoritative game logic (async, transactional).
 * Every wager runs inside a db transaction: balance is debited atomically, the
 * provably-fair draw advances the nonce, the outcome is computed, balance is
 * credited and the bet is recorded — all or nothing. The client cannot affect
 * results or balances. */

const crypto = require('crypto');
const db = require('./db');
const fair = require('./fair');
const { httpError } = require('./auth');

const HOUSE = 0.01;
const CRASH_BASE = 1.13;

const PLINKO = {
  8:  { low:  [5.6, 2.1, 1.1, 1.0, 0.5, 1.0, 1.1, 2.1, 5.6],
        mid:  [13, 3, 1.3, 0.7, 0.4, 0.7, 1.3, 3, 13],
        high: [29, 4, 1.5, 0.3, 0.2, 0.3, 1.5, 4, 29] },
  12: { low:  [10, 3, 1.6, 1.4, 1.1, 1.0, 0.5, 1.0, 1.1, 1.4, 1.6, 3, 10],
        mid:  [33, 11, 4, 2, 1.1, 0.6, 0.3, 0.6, 1.1, 2, 4, 11, 33],
        high: [76, 18, 7, 2, 0.7, 0.2, 0.2, 0.2, 0.7, 2, 7, 18, 76] },
  16: { low:  [16, 9, 2, 1.4, 1.4, 1.2, 1.1, 1.0, 0.5, 1.0, 1.1, 1.2, 1.4, 1.4, 2, 9, 16],
        mid:  [110, 41, 10, 5, 3, 1.5, 1.0, 0.5, 0.3, 0.5, 1.0, 1.5, 3, 5, 10, 41, 110],
        high: [1000, 130, 26, 9, 4, 2, 0.2, 0.2, 0.2, 0.2, 0.2, 2, 4, 9, 26, 130, 1000] }
};

function minesMult(safe, mines) {
  let p = 1;
  for (let i = 0; i < safe; i++) p *= (25 - i) / (25 - mines - i);
  return +(p * (1 - HOUSE)).toFixed(4);
}

function toCents(dollars) {
  const n = Number(dollars);
  if (!isFinite(n) || n <= 0) throw httpError(400, 'Invalid bet amount.');
  return Math.round(n * 100);
}

// Atomic, dialect-portable debit. Throws if the balance is insufficient.
async function debit(q, userId, betCents) {
  const r = await q('UPDATE users SET balance_cents = balance_cents - ? WHERE id = ? AND balance_cents >= ?',
    [betCents, userId, betCents]);
  if (!r.rowCount) throw httpError(400, 'Insufficient balance.');
}
async function credit(q, userId, cents) {
  if (cents > 0) await q('UPDATE users SET balance_cents = balance_cents + ? WHERE id = ?', [cents, userId]);
}
async function balanceOf(q, userId) {
  const { rows } = await q('SELECT balance_cents FROM users WHERE id = ?', [userId]);
  return Number(rows[0].balance_cents);
}
async function recordBet(q, userId, b) {
  await q(`INSERT INTO bets(user_id, game, bet_cents, mult, payout_cents, win, nonce, detail, created_at)
           VALUES(?,?,?,?,?,?,?,?,?)`,
    [userId, b.game, b.betCents, b.mult, b.payoutCents, b.win ? 1 : 0, b.nonce,
     b.detail ? JSON.stringify(b.detail) : null, Date.now()]);
}

// ---------------------------------------------------------------- DICE
function playDice(userId, { bet, target, dir }) {
  const betCents = toCents(bet);
  const t = Number(target);
  if (!isFinite(t) || t < 0.01 || t > 99.98) throw httpError(400, 'Target must be between 0.01 and 99.98.');
  if (dir !== 'over' && dir !== 'under') throw httpError(400, 'Direction must be over or under.');

  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    const { floats, nonce, serverHash } = await fair.drawTx(q, userId, 1);
    const roll = Math.floor(floats[0] * 10000) / 100;
    const win = dir === 'over' ? roll > t : roll < t;
    const winChance = dir === 'over' ? (99.99 - t) : t;
    const mult = +(99 / Math.max(0.01, winChance)).toFixed(4);
    const payoutCents = win ? Math.round(betCents * mult) : 0;
    await credit(q, userId, payoutCents);
    await recordBet(q, userId, { game: 'dice', betCents, mult: win ? mult : 0, payoutCents, win, nonce, detail: { roll, target: t, dir } });
    return { roll, win, mult, target: t, dir, payout: payoutCents / 100, balance: await balanceOf(q, userId) / 100, nonce, serverHash };
  });
}

// ---------------------------------------------------------------- PLINKO
function playPlinko(userId, { bet, rows, risk }) {
  const betCents = toCents(bet);
  rows = Number(rows);
  if (![8, 12, 16].includes(rows)) throw httpError(400, 'Rows must be 8, 12 or 16.');
  if (!['low', 'mid', 'high'].includes(risk)) throw httpError(400, 'Invalid risk.');

  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    const { floats, nonce, serverHash } = await fair.drawTx(q, userId, rows);
    const directions = floats.slice(0, rows).map(f => (f < 0.5 ? 0 : 1));
    const slot = directions.reduce((a, b) => a + b, 0);
    const mult = PLINKO[rows][risk][slot];
    const win = mult >= 1;
    const payoutCents = Math.round(betCents * mult);
    await credit(q, userId, payoutCents);
    await recordBet(q, userId, { game: 'plinko', betCents, mult, payoutCents, win, nonce, detail: { slot, rows, risk } });
    return { directions, slot, mult, payout: payoutCents / 100, balance: await balanceOf(q, userId) / 100, nonce, serverHash };
  });
}

// ---------------------------------------------------------------- CRASH
// Settled atomically against a required auto-cashout target.
function playCrash(userId, { bet, autoCashout }) {
  const betCents = toCents(bet);
  let target = Number(autoCashout);
  if (!isFinite(target) || target < 1.01) throw httpError(400, 'Set an auto-cashout of at least 1.01×.');
  target = Math.min(target, 1000000);

  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    const { floats, nonce, serverHash } = await fair.drawTx(q, userId, 1);
    const f = floats[0];
    let bust;
    if (f < 0.01) bust = 1.0;
    else bust = Math.max(1.0, Math.floor(99 / (1 - (f - 0.01) / 0.99)) / 100);
    const win = bust >= target;
    const mult = win ? target : 0;
    const payoutCents = win ? Math.round(betCents * target) : 0;
    await credit(q, userId, payoutCents);
    await recordBet(q, userId, { game: 'crash', betCents, mult, payoutCents, win, nonce, detail: { bust, target } });
    return { bust, target, win, mult, payout: payoutCents / 100, balance: await balanceOf(q, userId) / 100, nonce, serverHash };
  });
}

// ---------------------------------------------------------------- MINES
function minesStart(userId, { bet, mines }) {
  const betCents = toCents(bet);
  mines = Number(mines);
  if (!Number.isInteger(mines) || mines < 1 || mines > 24) throw httpError(400, 'Mines must be 1–24.');

  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    const { floats, nonce, serverHash } = await fair.drawTx(q, userId, mines);
    const pool = Array.from({ length: 25 }, (_, i) => i);
    const mineCells = [];
    for (let i = 0; i < mines; i++) {
      const j = Math.floor(floats[i] * pool.length);
      mineCells.push(pool[j]);
      pool.splice(j, 1);
    }
    const id = crypto.randomUUID();
    await q('INSERT INTO rounds(id, user_id, game, state, settled, created_at) VALUES(?,?,?,?,0,?)',
      [id, userId, 'mines', JSON.stringify({ betCents, mines, mineCells, revealed: [], nonce }), Date.now()]);
    return { roundId: id, mines, nonce, serverHash, balance: await balanceOf(q, userId) / 100 };
  });
}

function minesReveal(userId, { roundId, cell }) {
  cell = Number(cell);
  return db.tx(async (q) => {
    const { rows } = await q('SELECT * FROM rounds WHERE id = ? AND user_id = ? AND game = ?', [roundId, userId, 'mines']);
    const round = rows[0];
    if (!round) throw httpError(404, 'Round not found.');
    if (Number(round.settled)) throw httpError(409, 'Round already over.');
    const s = JSON.parse(round.state);
    if (!Number.isInteger(cell) || cell < 0 || cell > 24) throw httpError(400, 'Bad cell.');
    if (s.revealed.includes(cell)) throw httpError(400, 'Cell already revealed.');

    if (s.mineCells.includes(cell)) {
      await q('UPDATE rounds SET settled = 1 WHERE id = ?', [roundId]);
      await recordBet(q, userId, { game: 'mines', betCents: s.betCents, mult: 0, payoutCents: 0, win: false, nonce: s.nonce, detail: { mines: s.mines, hit: cell } });
      return { hit: true, cell, mineCells: s.mineCells, payout: 0, balance: await balanceOf(q, userId) / 100 };
    }

    s.revealed.push(cell);
    const safeCount = s.revealed.length;
    const mult = minesMult(safeCount, s.mines);
    const safeRemaining = 25 - s.mines - safeCount;

    if (safeRemaining === 0) {
      const payoutCents = Math.round(s.betCents * mult);
      await credit(q, userId, payoutCents);
      await q('UPDATE rounds SET settled = 1 WHERE id = ?', [roundId]);
      await recordBet(q, userId, { game: 'mines', betCents: s.betCents, mult, payoutCents, win: true, nonce: s.nonce, detail: { mines: s.mines, cleared: true } });
      return { hit: false, cell, cleared: true, safeCount, mult, mineCells: s.mineCells, payout: payoutCents / 100, balance: await balanceOf(q, userId) / 100 };
    }

    await q('UPDATE rounds SET state = ? WHERE id = ?', [JSON.stringify(s), roundId]);
    return { hit: false, cell, safeCount, mult, nextMult: minesMult(safeCount + 1, s.mines), balance: await balanceOf(q, userId) / 100 };
  });
}

function minesCashout(userId, { roundId }) {
  return db.tx(async (q) => {
    const { rows } = await q('SELECT * FROM rounds WHERE id = ? AND user_id = ? AND game = ?', [roundId, userId, 'mines']);
    const round = rows[0];
    if (!round) throw httpError(404, 'Round not found.');
    if (Number(round.settled)) throw httpError(409, 'Round already over.');
    const s = JSON.parse(round.state);
    if (s.revealed.length === 0) throw httpError(400, 'Reveal at least one tile first.');

    const mult = minesMult(s.revealed.length, s.mines);
    const payoutCents = Math.round(s.betCents * mult);
    await credit(q, userId, payoutCents);
    await q('UPDATE rounds SET settled = 1 WHERE id = ?', [roundId]);
    await recordBet(q, userId, { game: 'mines', betCents: s.betCents, mult, payoutCents, win: true, nonce: s.nonce, detail: { mines: s.mines, safe: s.revealed.length } });
    return { mult, payout: payoutCents / 100, mineCells: s.mineCells, balance: await balanceOf(q, userId) / 100 };
  });
}

// ---------------------------------------------------------------- HISTORY / STATS
async function history(userId, limit = 30) {
  limit = Math.max(1, Math.min(100, Number(limit) || 30));
  const { rows } = await db.query(
    'SELECT game, bet_cents, mult, payout_cents, win, created_at FROM bets WHERE user_id = ? ORDER BY id DESC LIMIT ?',
    [userId, limit]
  );
  return rows.map(r => ({
    game: r.game,
    bet: Number(r.bet_cents) / 100,
    mult: Number(r.mult),
    win: !!Number(r.win),
    payout: Number(r.payout_cents) / 100,
    profit: (Number(r.payout_cents) - Number(r.bet_cents)) / 100,
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

module.exports = {
  playDice, playPlinko, playCrash,
  minesStart, minesReveal, minesCashout,
  history, stats, PLINKO, minesMult
};
