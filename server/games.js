'use strict';

/* Server-authoritative game logic. Every wager flows through here:
 *   - bet is validated against the live server balance
 *   - the outcome is derived from the provably-fair draw
 *   - balance + bet history are written in a single transaction
 * The client only renders what the server returns; it cannot influence results. */

const crypto = require('crypto');
const { db } = require('./db');
const fair = require('./fair');
const { httpError } = require('./auth');

const HOUSE = 0.01;

// ---- Crash multiplier curve (must match the client animation) ----
const CRASH_BASE = 1.13;
const crashMultAt = (ms) => Math.pow(CRASH_BASE, ms / 1000);

// ---- Plinko payout tables (mirror of the client) ----
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

function getBalanceCents(userId) {
  return db.prepare('SELECT balance_cents FROM users WHERE id = ?').get(userId).balance_cents;
}

// Atomically debit a bet (throws if insufficient), returning the new balance.
const debit = db.transaction((userId, betCents) => {
  const row = db.prepare('SELECT balance_cents FROM users WHERE id = ?').get(userId);
  if (!row) throw httpError(404, 'User not found.');
  if (betCents > row.balance_cents) throw httpError(400, 'Insufficient balance.');
  const next = row.balance_cents - betCents;
  db.prepare('UPDATE users SET balance_cents = ? WHERE id = ?').run(next, userId);
  return next;
});

const credit = db.transaction((userId, cents) => {
  db.prepare('UPDATE users SET balance_cents = balance_cents + ? WHERE id = ?').run(cents, userId);
  return getBalanceCents(userId);
});

function recordBet(userId, { game, betCents, mult, payoutCents, win, nonce, detail }) {
  db.prepare(`INSERT INTO bets(user_id, game, bet_cents, mult, payout_cents, win, nonce, detail, created_at)
              VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(userId, game, betCents, mult, payoutCents, win ? 1 : 0, nonce, detail ? JSON.stringify(detail) : null, Date.now());
}

// ---------------------------------------------------------------- DICE
function playDice(userId, { bet, target, dir }) {
  const betCents = toCents(bet);
  const t = Number(target);
  if (!isFinite(t) || t < 0.01 || t > 99.98) throw httpError(400, 'Target must be between 0.01 and 99.98.');
  if (dir !== 'over' && dir !== 'under') throw httpError(400, 'Direction must be over or under.');

  debit(userId, betCents);
  const { floats, nonce, serverHash } = fair.draw(userId, 1);
  const roll = Math.floor(floats[0] * 10000) / 100;
  const win = dir === 'over' ? roll > t : roll < t;
  const winChance = dir === 'over' ? (99.99 - t) : t;
  const mult = +(99 / Math.max(0.01, winChance)).toFixed(4);
  const payoutCents = win ? Math.round(betCents * mult) : 0;
  if (win) credit(userId, payoutCents);

  recordBet(userId, { game: 'dice', betCents, mult: win ? mult : 0, payoutCents, win, nonce, detail: { roll, target: t, dir } });
  return { roll, win, mult, target: t, dir, payout: payoutCents / 100, balance: getBalanceCents(userId) / 100, nonce, serverHash };
}

// ---------------------------------------------------------------- PLINKO
function playPlinko(userId, { bet, rows, risk }) {
  const betCents = toCents(bet);
  rows = Number(rows);
  if (![8, 12, 16].includes(rows)) throw httpError(400, 'Rows must be 8, 12 or 16.');
  if (!['low', 'mid', 'high'].includes(risk)) throw httpError(400, 'Invalid risk.');

  debit(userId, betCents);
  const { floats, nonce, serverHash } = fair.draw(userId, rows);
  const directions = floats.slice(0, rows).map(f => (f < 0.5 ? 0 : 1));
  const slot = directions.reduce((a, b) => a + b, 0);
  const mult = PLINKO[rows][risk][slot];
  const win = mult >= 1;
  const payoutCents = Math.round(betCents * mult);
  credit(userId, payoutCents);

  recordBet(userId, { game: 'plinko', betCents, mult, payoutCents, win, nonce, detail: { slot, rows, risk } });
  return { directions, slot, mult, payout: payoutCents / 100, balance: getBalanceCents(userId) / 100, nonce, serverHash };
}

// ---------------------------------------------------------------- CRASH
// Settled atomically at bet time against a required auto-cashout target: you win
// (at your target) if the round's bust point reaches it, otherwise you lose.
// Locking the outcome to a pre-chosen target means knowing the bust afterwards
// confers no advantage — so the client can be told the bust to drive a clean
// crash animation without opening a "cash out at bust-0.01" exploit.
const playCrashTxn = db.transaction((userId, betCents, target) => {
  const row = db.prepare('SELECT balance_cents FROM users WHERE id = ?').get(userId);
  if (!row) throw httpError(404, 'User not found.');
  if (betCents > row.balance_cents) throw httpError(400, 'Insufficient balance.');
  db.prepare('UPDATE users SET balance_cents = balance_cents - ? WHERE id = ?').run(betCents, userId);

  const { floats, nonce, serverHash } = fair.draw(userId, 1);
  const f = floats[0];
  let bust;
  if (f < 0.01) bust = 1.0;
  else bust = Math.max(1.0, Math.floor(99 / (1 - (f - 0.01) / 0.99)) / 100);

  const win = bust >= target;
  const mult = win ? target : 0;
  const payoutCents = win ? Math.round(betCents * target) : 0;
  if (win) db.prepare('UPDATE users SET balance_cents = balance_cents + ? WHERE id = ?').run(payoutCents, userId);

  recordBet(userId, { game: 'crash', betCents, mult, payoutCents, win, nonce, detail: { bust, target } });
  return { bust, target, win, mult, payout: payoutCents / 100, balance: getBalanceCents(userId) / 100, nonce, serverHash };
});

function playCrash(userId, { bet, autoCashout }) {
  const betCents = toCents(bet);
  let target = Number(autoCashout);
  if (!isFinite(target) || target < 1.01) throw httpError(400, 'Set an auto-cashout of at least 1.01×.');
  target = Math.min(target, 1000000);
  return playCrashTxn(userId, betCents, target);
}

// ---------------------------------------------------------------- MINES
function minesStart(userId, { bet, mines }) {
  const betCents = toCents(bet);
  mines = Number(mines);
  if (!Number.isInteger(mines) || mines < 1 || mines > 24) throw httpError(400, 'Mines must be 1–24.');

  debit(userId, betCents);
  const { floats, nonce, serverHash } = fair.draw(userId, mines);
  // Select `mines` distinct cells from 25 using the draw floats.
  const pool = Array.from({ length: 25 }, (_, i) => i);
  const mineCells = [];
  for (let i = 0; i < mines; i++) {
    const j = Math.floor(floats[i] * pool.length);
    mineCells.push(pool[j]);
    pool.splice(j, 1);
  }

  const id = crypto.randomUUID();
  db.prepare('INSERT INTO rounds(id, user_id, game, state, settled, created_at) VALUES(?,?,?,?,0,?)')
    .run(id, userId, 'mines', JSON.stringify({ betCents, mines, mineCells, revealed: [], nonce }), Date.now());

  return { roundId: id, mines, nonce, serverHash, balance: getBalanceCents(userId) / 100 };
}

const minesRevealTxn = db.transaction((userId, roundId, cell) => {
  const round = db.prepare('SELECT * FROM rounds WHERE id = ? AND user_id = ? AND game = ?').get(roundId, userId, 'mines');
  if (!round) throw httpError(404, 'Round not found.');
  if (round.settled) throw httpError(409, 'Round already over.');
  const s = JSON.parse(round.state);
  if (!Number.isInteger(cell) || cell < 0 || cell > 24) throw httpError(400, 'Bad cell.');
  if (s.revealed.includes(cell)) throw httpError(400, 'Cell already revealed.');

  if (s.mineCells.includes(cell)) {
    db.prepare('UPDATE rounds SET settled = 1 WHERE id = ?').run(roundId);
    recordBet(userId, { game: 'mines', betCents: s.betCents, mult: 0, payoutCents: 0, win: false, nonce: s.nonce, detail: { mines: s.mines, hit: cell } });
    return { hit: true, cell, mineCells: s.mineCells, payout: 0, balance: getBalanceCents(userId) / 100 };
  }

  s.revealed.push(cell);
  const safeCount = s.revealed.length;
  const mult = minesMult(safeCount, s.mines);
  const safeRemaining = 25 - s.mines - safeCount;

  // Auto-cashout if the board is cleared.
  if (safeRemaining === 0) {
    const payoutCents = Math.round(s.betCents * mult);
    db.prepare('UPDATE users SET balance_cents = balance_cents + ? WHERE id = ?').run(payoutCents, userId);
    db.prepare('UPDATE rounds SET settled = 1 WHERE id = ?').run(roundId);
    recordBet(userId, { game: 'mines', betCents: s.betCents, mult, payoutCents, win: true, nonce: s.nonce, detail: { mines: s.mines, cleared: true } });
    return { hit: false, cell, cleared: true, safeCount, mult, mineCells: s.mineCells, payout: payoutCents / 100, balance: getBalanceCents(userId) / 100 };
  }

  db.prepare('UPDATE rounds SET state = ? WHERE id = ?').run(JSON.stringify(s), roundId);
  const nextMult = minesMult(safeCount + 1, s.mines);
  return { hit: false, cell, safeCount, mult, nextMult, balance: getBalanceCents(userId) / 100 };
});

function minesReveal(userId, { roundId, cell }) {
  return minesRevealTxn(userId, roundId, Number(cell));
}

const minesCashoutTxn = db.transaction((userId, roundId) => {
  const round = db.prepare('SELECT * FROM rounds WHERE id = ? AND user_id = ? AND game = ?').get(roundId, userId, 'mines');
  if (!round) throw httpError(404, 'Round not found.');
  if (round.settled) throw httpError(409, 'Round already over.');
  const s = JSON.parse(round.state);
  if (s.revealed.length === 0) throw httpError(400, 'Reveal at least one tile first.');

  const mult = minesMult(s.revealed.length, s.mines);
  const payoutCents = Math.round(s.betCents * mult);
  db.prepare('UPDATE users SET balance_cents = balance_cents + ? WHERE id = ?').run(payoutCents, userId);
  db.prepare('UPDATE rounds SET settled = 1 WHERE id = ?').run(roundId);
  recordBet(userId, { game: 'mines', betCents: s.betCents, mult, payoutCents, win: true, nonce: s.nonce, detail: { mines: s.mines, safe: s.revealed.length } });

  return { mult, payout: payoutCents / 100, mineCells: s.mineCells, balance: getBalanceCents(userId) / 100 };
});

function minesCashout(userId, { roundId }) {
  return minesCashoutTxn(userId, roundId);
}

// ---------------------------------------------------------------- HISTORY / STATS
function history(userId, limit = 30) {
  limit = Math.max(1, Math.min(100, Number(limit) || 30));
  const rows = db.prepare('SELECT game, bet_cents, mult, payout_cents, win, created_at FROM bets WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    .all(userId, limit);
  return rows.map(r => ({
    game: r.game,
    bet: r.bet_cents / 100,
    mult: r.mult,
    win: !!r.win,
    payout: r.payout_cents / 100,
    profit: (r.payout_cents - r.bet_cents) / 100,
    ts: r.created_at
  }));
}

function stats(userId) {
  const agg = db.prepare(`
    SELECT COUNT(*) n,
           COALESCE(SUM(bet_cents),0) wagered,
           COALESCE(SUM(payout_cents),0) returned,
           COALESCE(SUM(win),0) wins,
           COALESCE(MAX(payout_cents - bet_cents),0) biggest
    FROM bets WHERE user_id = ?`).get(userId);
  return {
    bets: agg.n,
    wagered: agg.wagered / 100,
    profit: (agg.returned - agg.wagered) / 100,
    wins: agg.wins,
    winRate: agg.n ? agg.wins / agg.n : 0,
    biggestWin: agg.biggest / 100
  };
}

module.exports = {
  playDice, playPlinko, playCrash,
  minesStart, minesReveal, minesCashout,
  history, stats, getBalanceCents,
  PLINKO, minesMult
};
