'use strict';
/* Classic games (dice through pachinko) + the progressive jackpot. */
const crypto = require('crypto');
const db = require('../db');
const fair = require('../fair');
const progression = require('../progression');
const { httpError, logAudit } = require('../auth');
const limits = require('../limits');
const {
  HOUSE, PLINKO, WHEEL, TOWERS, TOWERS_ROWS, KENO_N, KENO_DRAW, KENO_EDGE, KENO_TABLES,
  ROULETTE_RED, DIAMOND_PAYS, SLOT_THEMES, SLOT_SYMBOLS, SLOT_PAIR_PAY, SLOT_TRIPLE,
  PUMP, COLOR_MAP, COLOR_PAYS, SCRATCH_TILES, SCRATCH_P, SCRATCH_EDGE, SCRATCH_TABLE,
  VIDEO_POKER_PAYS,
  minesMult, towersStepFactor, towersMult, hiloChances, hiloMults, comb, kenoHitProb,
  buildKenoTable, kenoTable, rouletteColor, diamondCategory, buildSlotTable, pumpMult,
  digitColor, binom, cardFromIndex, drawDistinctCards, isFlush, isStraight, evalVideoPoker,
  handTotal, toCents, debit, credit, balanceOf, recordBet
} = require('./core');

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

// ---------------------------------------------------------------- LIMBO
// Pick a target multiplier; the server rolls a crash-style result. Win if it
// reaches your target. P(win) = 0.99 / target → 1% house edge at any target.
function playLimbo(userId, { bet, target }) {
  const betCents = toCents(bet);
  const t = Number(target);
  if (!isFinite(t) || t < 1.01 || t > 1000000) throw httpError(400, 'Target must be between 1.01 and 1,000,000.');

  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    const { floats, nonce, serverHash } = await fair.drawTx(q, userId, 1);
    const result = Math.max(1, Math.floor((0.99 / (1 - floats[0])) * 100) / 100);
    const win = result >= t;
    const payoutCents = win ? Math.round(betCents * t) : 0;
    await credit(q, userId, payoutCents);
    await recordBet(q, userId, { game: 'limbo', betCents, mult: win ? t : 0, payoutCents, win, nonce, detail: { result, target: t } });
    return { result, target: t, win, mult: win ? t : 0, payout: payoutCents / 100, balance: await balanceOf(q, userId) / 100, nonce, serverHash };
  });
}

// ---------------------------------------------------------------- WHEEL
function playWheel(userId, { bet, risk }) {
  const betCents = toCents(bet);
  if (!WHEEL[risk]) throw httpError(400, 'Invalid risk.');
  const segments = WHEEL[risk];

  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    const { floats, nonce, serverHash } = await fair.drawTx(q, userId, 1);
    const idx = Math.min(segments.length - 1, Math.floor(floats[0] * segments.length));
    const mult = segments[idx];
    const win = mult >= 1;
    const payoutCents = Math.round(betCents * mult);
    await credit(q, userId, payoutCents);
    await recordBet(q, userId, { game: 'wheel', betCents, mult, payoutCents, win, nonce, detail: { idx, risk } });
    return { idx, mult, risk, segments, payout: payoutCents / 100, balance: await balanceOf(q, userId) / 100, nonce, serverHash };
  });
}

// ---------------------------------------------------------------- KENO
function playKeno(userId, { bet, picks }) {
  const betCents = toCents(bet);
  if (!Array.isArray(picks)) throw httpError(400, 'Pick some numbers.');
  const chosen = [...new Set(picks.map(Number))].filter(n => Number.isInteger(n) && n >= 1 && n <= KENO_N);
  if (chosen.length !== picks.length || chosen.length < 1 || chosen.length > 10) {
    throw httpError(400, 'Pick 1 to 10 distinct numbers (1–40).');
  }
  const table = KENO_TABLES[chosen.length];

  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    const { floats, nonce, serverHash } = await fair.drawTx(q, userId, KENO_DRAW);
    const pool = Array.from({ length: KENO_N }, (_, i) => i + 1);
    const drawn = [];
    for (let i = 0; i < KENO_DRAW; i++) {
      const j = Math.floor(floats[i] * pool.length);
      drawn.push(pool[j]);
      pool.splice(j, 1);
    }
    const hits = chosen.filter(n => drawn.includes(n));
    const mult = table[hits.length] || 0;
    const win = mult >= 1;
    const payoutCents = Math.round(betCents * mult);
    await credit(q, userId, payoutCents);
    await recordBet(q, userId, { game: 'keno', betCents, mult, payoutCents, win, nonce, detail: { picks: chosen, hits: hits.length } });
    return { drawn, picks: chosen, hits, hitCount: hits.length, mult, table, payout: payoutCents / 100, balance: await balanceOf(q, userId) / 100, nonce, serverHash };
  });
}

// ---------------------------------------------------------------- HI-LO
function hiloStart(userId, { bet }) {
  const betCents = toCents(bet);
  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    const { floats, nonce, serverHash } = await fair.drawTx(q, userId, 1);
    const card = Math.floor(floats[0] * 13) + 1;
    const id = crypto.randomUUID();
    await q('INSERT INTO rounds(id, user_id, game, state, settled, created_at) VALUES(?,?,?,?,0,?)',
      [id, userId, 'hilo', JSON.stringify({ betCents, card, mult: 1, history: [card], nonce }), Date.now()]);
    return { roundId: id, card, mult: 1, mults: hiloMults(card), chances: hiloChances(card), serverHash, balance: await balanceOf(q, userId) / 100 };
  });
}

function hiloGuess(userId, { roundId, choice }) {
  if (choice !== 'hi' && choice !== 'lo') throw httpError(400, 'Choose hi or lo.');
  return db.tx(async (q) => {
    const { rows } = await q('SELECT * FROM rounds WHERE id = ? AND user_id = ? AND game = ?', [roundId, userId, 'hilo']);
    const round = rows[0];
    if (!round) throw httpError(404, 'Round not found.');
    if (Number(round.settled)) throw httpError(409, 'Round already over.');
    const s = JSON.parse(round.state);

    const { floats } = await fair.drawTx(q, userId, 1);
    const next = Math.floor(floats[0] * 13) + 1;
    const win = choice === 'hi' ? next >= s.card : next <= s.card;

    if (!win) {
      await q('UPDATE rounds SET settled = 1 WHERE id = ?', [roundId]);
      await recordBet(q, userId, { game: 'hilo', betCents: s.betCents, mult: 0, payoutCents: 0, win: false, nonce: s.nonce, detail: { from: s.card, to: next, choice, steps: s.history.length - 1 } });
      return { win: false, card: next, prev: s.card, balance: await balanceOf(q, userId) / 100 };
    }

    const factor = hiloMults(s.card)[choice];
    s.mult = +(s.mult * factor).toFixed(4);
    s.card = next;
    s.history.push(next);
    await q('UPDATE rounds SET state = ? WHERE id = ?', [JSON.stringify(s), roundId]);
    return { win: true, card: next, mult: s.mult, mults: hiloMults(next), chances: hiloChances(next), cashout: (s.betCents * s.mult) / 100 };
  });
}

function hiloCashout(userId, { roundId }) {
  return db.tx(async (q) => {
    const { rows } = await q('SELECT * FROM rounds WHERE id = ? AND user_id = ? AND game = ?', [roundId, userId, 'hilo']);
    const round = rows[0];
    if (!round) throw httpError(404, 'Round not found.');
    if (Number(round.settled)) throw httpError(409, 'Round already over.');
    const s = JSON.parse(round.state);
    if (s.history.length < 2) throw httpError(400, 'Make at least one correct call first.');
    const payoutCents = Math.round(s.betCents * s.mult);
    await credit(q, userId, payoutCents);
    await q('UPDATE rounds SET settled = 1 WHERE id = ?', [roundId]);
    await recordBet(q, userId, { game: 'hilo', betCents: s.betCents, mult: s.mult, payoutCents, win: true, nonce: s.nonce, detail: { steps: s.history.length - 1 } });
    return { mult: s.mult, payout: payoutCents / 100, balance: await balanceOf(q, userId) / 100 };
  });
}

// ---------------------------------------------------------------- TOWERS
function towersStart(userId, { bet, difficulty }) {
  const betCents = toCents(bet);
  if (!TOWERS[difficulty]) throw httpError(400, 'Invalid difficulty.');
  const { tiles, safe } = TOWERS[difficulty];
  const traps = tiles - safe;

  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    const { floats, nonce, serverHash } = await fair.drawTx(q, userId, TOWERS_ROWS * traps);
    const trapRows = [];
    let fi = 0;
    for (let r = 0; r < TOWERS_ROWS; r++) {
      const pool = Array.from({ length: tiles }, (_, i) => i);
      const rowTraps = [];
      for (let t = 0; t < traps; t++) {
        const j = Math.floor(floats[fi++] * pool.length);
        rowTraps.push(pool[j]);
        pool.splice(j, 1);
      }
      trapRows.push(rowTraps);
    }
    const id = crypto.randomUUID();
    await q('INSERT INTO rounds(id, user_id, game, state, settled, created_at) VALUES(?,?,?,?,0,?)',
      [id, userId, 'towers', JSON.stringify({ betCents, difficulty, tiles, trapRows, row: 0, nonce }), Date.now()]);
    return {
      roundId: id, difficulty, tiles, rows: TOWERS_ROWS,
      nextMult: towersMult(difficulty, 1), serverHash, balance: await balanceOf(q, userId) / 100
    };
  });
}

function towersReveal(userId, { roundId, tile }) {
  tile = Number(tile);
  return db.tx(async (q) => {
    const { rows } = await q('SELECT * FROM rounds WHERE id = ? AND user_id = ? AND game = ?', [roundId, userId, 'towers']);
    const round = rows[0];
    if (!round) throw httpError(404, 'Round not found.');
    if (Number(round.settled)) throw httpError(409, 'Round already over.');
    const s = JSON.parse(round.state);
    if (!Number.isInteger(tile) || tile < 0 || tile >= s.tiles) throw httpError(400, 'Bad tile.');

    const rowTraps = s.trapRows[s.row];
    if (rowTraps.includes(tile)) {
      await q('UPDATE rounds SET settled = 1 WHERE id = ?', [roundId]);
      await recordBet(q, userId, { game: 'towers', betCents: s.betCents, mult: 0, payoutCents: 0, win: false, nonce: s.nonce, detail: { difficulty: s.difficulty, row: s.row } });
      return { hit: true, tile, row: s.row, trapRows: s.trapRows, payout: 0, balance: await balanceOf(q, userId) / 100 };
    }

    s.row += 1;
    const mult = towersMult(s.difficulty, s.row);

    if (s.row >= TOWERS_ROWS) {
      const payoutCents = Math.round(s.betCents * mult);
      await credit(q, userId, payoutCents);
      await q('UPDATE rounds SET settled = 1 WHERE id = ?', [roundId]);
      await recordBet(q, userId, { game: 'towers', betCents: s.betCents, mult, payoutCents, win: true, nonce: s.nonce, detail: { difficulty: s.difficulty, cleared: true } });
      return { hit: false, tile, row: s.row - 1, cleared: true, mult, trapRows: s.trapRows, payout: payoutCents / 100, balance: await balanceOf(q, userId) / 100 };
    }

    await q('UPDATE rounds SET state = ? WHERE id = ?', [JSON.stringify(s), roundId]);
    return { hit: false, tile, row: s.row - 1, mult, nextMult: towersMult(s.difficulty, s.row + 1), cashout: (s.betCents * mult) / 100, balance: await balanceOf(q, userId) / 100 };
  });
}

function towersCashout(userId, { roundId }) {
  return db.tx(async (q) => {
    const { rows } = await q('SELECT * FROM rounds WHERE id = ? AND user_id = ? AND game = ?', [roundId, userId, 'towers']);
    const round = rows[0];
    if (!round) throw httpError(404, 'Round not found.');
    if (Number(round.settled)) throw httpError(409, 'Round already over.');
    const s = JSON.parse(round.state);
    if (s.row < 1) throw httpError(400, 'Clear at least one row first.');
    const mult = towersMult(s.difficulty, s.row);
    const payoutCents = Math.round(s.betCents * mult);
    await credit(q, userId, payoutCents);
    await q('UPDATE rounds SET settled = 1 WHERE id = ?', [roundId]);
    await recordBet(q, userId, { game: 'towers', betCents: s.betCents, mult, payoutCents, win: true, nonce: s.nonce, detail: { difficulty: s.difficulty, rows: s.row } });
    return { mult, payout: payoutCents / 100, trapRows: s.trapRows, row: s.row, balance: await balanceOf(q, userId) / 100 };
  });
}

// ---------------------------------------------------------------- ROULETTE
const ROULETTE_PAYS = { red: 2, black: 2, even: 2, odd: 2, low: 2, high: 2, green: 36, straight: 36, dozen1: 3, dozen2: 3, dozen3: 3 };
function playRoulette(userId, { bet, betType, number }) {
  const betCents = toCents(bet);
  if (!ROULETTE_PAYS[betType]) throw httpError(400, 'Invalid bet.');
  let num = null;
  if (betType === 'straight') {
    num = Number(number);
    if (!Number.isInteger(num) || num < 0 || num > 36) throw httpError(400, 'Pick a number 0–36.');
  }
  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    const { floats, nonce, serverHash } = await fair.drawTx(q, userId, 1);
    const pocket = Math.min(36, Math.floor(floats[0] * 37));
    const color = rouletteColor(pocket);
    let win = false;
    switch (betType) {
      case 'red': win = color === 'red'; break;
      case 'black': win = color === 'black'; break;
      case 'even': win = pocket !== 0 && pocket % 2 === 0; break;
      case 'odd': win = pocket % 2 === 1; break;
      case 'low': win = pocket >= 1 && pocket <= 18; break;
      case 'high': win = pocket >= 19 && pocket <= 36; break;
      case 'green': win = pocket === 0; break;
      case 'straight': win = pocket === num; break;
      case 'dozen1': win = pocket >= 1 && pocket <= 12; break;
      case 'dozen2': win = pocket >= 13 && pocket <= 24; break;
      case 'dozen3': win = pocket >= 25 && pocket <= 36; break;
    }
    const mult = win ? ROULETTE_PAYS[betType] : 0;
    const payoutCents = Math.round(betCents * mult);
    await credit(q, userId, payoutCents);
    await recordBet(q, userId, { game: 'roulette', betCents, mult, payoutCents, win, nonce, detail: { pocket, color, betType, number: num } });
    return { pocket, color, win, mult, betType, payout: payoutCents / 100, balance: await balanceOf(q, userId) / 100, nonce, serverHash };
  });
}

// ---------------------------------------------------------------- COIN FLIP (streak)
function coinStart(userId, { bet }) {
  const betCents = toCents(bet);
  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    const { rows } = await q('SELECT nonce, server_hash FROM fair WHERE user_id = ?', [userId]);
    const id = crypto.randomUUID();
    await q('INSERT INTO rounds(id, user_id, game, state, settled, created_at) VALUES(?,?,?,?,0,?)',
      [id, userId, 'coin', JSON.stringify({ betCents, mult: 1, flips: 0, nonce: Number(rows[0].nonce) }), Date.now()]);
    return { roundId: id, serverHash: rows[0].server_hash, balance: await balanceOf(q, userId) / 100 };
  });
}
function coinFlip(userId, { roundId, side }) {
  if (side !== 'heads' && side !== 'tails') throw httpError(400, 'Pick heads or tails.');
  return db.tx(async (q) => {
    const { rows } = await q('SELECT * FROM rounds WHERE id = ? AND user_id = ? AND game = ?', [roundId, userId, 'coin']);
    const round = rows[0];
    if (!round) throw httpError(404, 'Round not found.');
    if (Number(round.settled)) throw httpError(409, 'Round already over.');
    const s = JSON.parse(round.state);
    const { floats } = await fair.drawTx(q, userId, 1);
    const outcome = floats[0] < 0.5 ? 'heads' : 'tails';
    if (outcome !== side) {
      await q('UPDATE rounds SET settled = 1 WHERE id = ?', [roundId]);
      await recordBet(q, userId, { game: 'coin', betCents: s.betCents, mult: 0, payoutCents: 0, win: false, nonce: s.nonce, detail: { flips: s.flips, lostOn: outcome } });
      return { win: false, outcome, flips: s.flips, balance: await balanceOf(q, userId) / 100 };
    }
    s.flips += 1;
    s.mult = +(s.mult * ((1 - HOUSE) / 0.5)).toFixed(4);
    await q('UPDATE rounds SET state = ? WHERE id = ?', [JSON.stringify(s), roundId]);
    return { win: true, outcome, flips: s.flips, mult: s.mult, cashout: (s.betCents * s.mult) / 100 };
  });
}
function coinCashout(userId, { roundId }) {
  return db.tx(async (q) => {
    const { rows } = await q('SELECT * FROM rounds WHERE id = ? AND user_id = ? AND game = ?', [roundId, userId, 'coin']);
    const round = rows[0];
    if (!round) throw httpError(404, 'Round not found.');
    if (Number(round.settled)) throw httpError(409, 'Round already over.');
    const s = JSON.parse(round.state);
    if (s.flips < 1) throw httpError(400, 'Flip at least once first.');
    const payoutCents = Math.round(s.betCents * s.mult);
    await credit(q, userId, payoutCents);
    await q('UPDATE rounds SET settled = 1 WHERE id = ?', [roundId]);
    await recordBet(q, userId, { game: 'coin', betCents: s.betCents, mult: s.mult, payoutCents, win: true, nonce: s.nonce, detail: { flips: s.flips } });
    return { mult: s.mult, payout: payoutCents / 100, flips: s.flips, balance: await balanceOf(q, userId) / 100 };
  });
}

// ---------------------------------------------------------------- DIAMONDS
function playDiamonds(userId, { bet }) {
  const betCents = toCents(bet);
  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    const { floats, nonce, serverHash } = await fair.drawTx(q, userId, 5);
    const gems = floats.map(f => Math.min(6, Math.floor(f * 7)));
    const counts = {};
    gems.forEach(g => { counts[g] = (counts[g] || 0) + 1; });
    const cat = diamondCategory(Object.values(counts));
    const mult = DIAMOND_PAYS[cat];
    const win = mult >= 1;
    const payoutCents = Math.round(betCents * mult);
    await credit(q, userId, payoutCents);
    await recordBet(q, userId, { game: 'diamonds', betCents, mult, payoutCents, win, nonce, detail: { gems, cat } });
    return { gems, category: cat, mult, payout: payoutCents / 100, balance: await balanceOf(q, userId) / 100, nonce, serverHash };
  });
}

// ---------------------------------------------------------------- SLOTS
// ---- Progressive jackpot (shared across all slot themes) ----
// The pot lives in the settings table, seeded at 1,000 CRYPT and fed 1.5% of
// every slot wager (house-funded — spin RTP is unchanged). Each spin draws
// one extra fair float; the drop chance scales with the bet
// (1.00 CRYPT ≈ 1-in-50,000), so grinding pennies can't fish the pot.
// Read-modify-write is safe on SQLite (tx is fully serialized); on Postgres a
// concurrent-contribution race can drop a few cents of contribution, which is
// acceptable for a play-money pot.
const JACKPOT_KEY = 'jackpot_cents';
const JACKPOT_SEED_CENTS = 100_000;
const JACKPOT_CONTRIB = 0.015;
const JACKPOT_ODDS_PER_CENT = 1 / 5_000_000; // per-cent-of-bet drop probability
async function jackpotGet(q) {
  const { rows } = await q('SELECT value FROM settings WHERE key = ?', [JACKPOT_KEY]);
  if (!rows[0]) {
    await q('INSERT INTO settings(key, value) VALUES(?, ?)', [JACKPOT_KEY, String(JACKPOT_SEED_CENTS)]);
    return JACKPOT_SEED_CENTS;
  }
  return Number(rows[0].value) || JACKPOT_SEED_CENTS;
}
// Seed the pot row at boot so two first-ever spins on Postgres can't race the
// INSERT inside their transactions (unique violation would fail a spin).
async function jackpotEnsure() {
  try { await jackpotGet(db.query); } catch (_) { /* concurrent boot seeded it */ }
}
async function jackpotTick(q, userId, betCents, dropFloat) {
  const pot = await jackpotGet(q) + Math.round(betCents * JACKPOT_CONTRIB);
  const pWin = Math.min(0.01, betCents * JACKPOT_ODDS_PER_CENT);
  if (dropFloat < pWin) {
    await credit(q, userId, pot);
    await q('UPDATE settings SET value = ? WHERE key = ?', [String(JACKPOT_SEED_CENTS), JACKPOT_KEY]);
    return { won: true, amount: pot / 100, pot: JACKPOT_SEED_CENTS / 100 };
  }
  await q('UPDATE settings SET value = ? WHERE key = ?', [String(pot), JACKPOT_KEY]);
  return { won: false, amount: 0, pot: pot / 100 };
}
async function jackpotState() {
  const { rows } = await db.query('SELECT value FROM settings WHERE key = ?', [JACKPOT_KEY]);
  return { pot: (Number(rows[0]?.value) || JACKPOT_SEED_CENTS) / 100 };
}

// Shared engine: any theme key from SLOT_THEMES routes through here. The
// per-bet record's `game` column is the theme key so leaderboards / history
// can tell Lucky Sevens spins apart from classic Slots.
async function playSlotsThemed(userId, { bet }, themeKey) {
  const theme = SLOT_THEMES[themeKey];
  if (!theme) throw httpError(400, 'Unknown slot theme.');
  const betCents = toCents(bet);
  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    const { floats, nonce, serverHash } = await fair.drawTx(q, userId, 4); // 3 reels + 1 jackpot drop
    const N = theme.symbols.length;
    const reels = floats.slice(0, 3).map(f => Math.min(N - 1, Math.floor(f * N)));
    let mult = 0, kind = 'none';
    if (reels[0] === reels[1] && reels[1] === reels[2]) { mult = theme.triple[reels[0]]; kind = 'triple'; }
    else if (reels[0] === reels[1] || reels[1] === reels[2] || reels[0] === reels[2]) { mult = theme.pairPay; kind = 'pair'; }
    const win = mult >= 1;
    const payoutCents = Math.round(betCents * mult);
    await credit(q, userId, payoutCents);
    await recordBet(q, userId, { game: themeKey === 'classic' ? 'slots' : themeKey, betCents, mult, payoutCents, win, nonce, detail: { reels, kind, theme: themeKey } });
    const jackpot = await jackpotTick(q, userId, betCents, floats[3]);
    if (jackpot.won) logAudit(null, 'jackpot.won', userId, { amount: jackpot.amount, theme: themeKey });
    return { reels, symbols: reels.map(i => theme.symbols[i]), kind, mult, payout: payoutCents / 100, jackpot, balance: await balanceOf(q, userId) / 100, nonce, serverHash, theme: themeKey };
  });
}

function playSlots(userId, body)        { return playSlotsThemed(userId, body, 'classic'); }
function playLuckySevens(userId, body)  { return playSlotsThemed(userId, body, 'sevens'); }
function playCosmicReels(userId, body)  { return playSlotsThemed(userId, body, 'cosmic'); }

// ---------------------------------------------------------------- PUMP (escalating meter)
function pumpStart(userId, { bet, difficulty }) {
  const betCents = toCents(bet);
  if (!PUMP[difficulty]) throw httpError(400, 'Invalid difficulty.');
  const positions = PUMP[difficulty];
  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    const { floats, nonce, serverHash } = await fair.drawTx(q, userId, 1);
    const bomb = 1 + Math.floor(floats[0] * positions);
    const id = crypto.randomUUID();
    await q('INSERT INTO rounds(id, user_id, game, state, settled, created_at) VALUES(?,?,?,?,0,?)',
      [id, userId, 'pump', JSON.stringify({ betCents, positions, bomb, level: 0, nonce }), Date.now()]);
    return { roundId: id, positions, difficulty, nextMult: pumpMult(positions, 1), serverHash, balance: await balanceOf(q, userId) / 100 };
  });
}
function pumpPump(userId, { roundId }) {
  return db.tx(async (q) => {
    const { rows } = await q('SELECT * FROM rounds WHERE id = ? AND user_id = ? AND game = ?', [roundId, userId, 'pump']);
    const round = rows[0];
    if (!round) throw httpError(404, 'Round not found.');
    if (Number(round.settled)) throw httpError(409, 'Round already over.');
    const s = JSON.parse(round.state);
    s.level += 1;
    if (s.level === s.bomb) {
      await q('UPDATE rounds SET settled = 1 WHERE id = ?', [roundId]);
      await recordBet(q, userId, { game: 'pump', betCents: s.betCents, mult: 0, payoutCents: 0, win: false, nonce: s.nonce, detail: { positions: s.positions, burst: s.level } });
      return { burst: true, level: s.level, bomb: s.bomb, balance: await balanceOf(q, userId) / 100 };
    }
    const mult = pumpMult(s.positions, s.level);
    if (s.level === s.positions - 1) {
      const payoutCents = Math.round(s.betCents * mult);
      await credit(q, userId, payoutCents);
      await q('UPDATE rounds SET settled = 1 WHERE id = ?', [roundId]);
      await recordBet(q, userId, { game: 'pump', betCents: s.betCents, mult, payoutCents, win: true, nonce: s.nonce, detail: { positions: s.positions, maxed: true } });
      return { burst: false, level: s.level, mult, maxed: true, payout: payoutCents / 100, balance: await balanceOf(q, userId) / 100 };
    }
    await q('UPDATE rounds SET state = ? WHERE id = ?', [JSON.stringify(s), roundId]);
    return { burst: false, level: s.level, mult, nextMult: pumpMult(s.positions, s.level + 1), cashout: (s.betCents * mult) / 100, balance: await balanceOf(q, userId) / 100 };
  });
}
function pumpCashout(userId, { roundId }) {
  return db.tx(async (q) => {
    const { rows } = await q('SELECT * FROM rounds WHERE id = ? AND user_id = ? AND game = ?', [roundId, userId, 'pump']);
    const round = rows[0];
    if (!round) throw httpError(404, 'Round not found.');
    if (Number(round.settled)) throw httpError(409, 'Round already over.');
    const s = JSON.parse(round.state);
    if (s.level < 1) throw httpError(400, 'Pump at least once first.');
    const mult = pumpMult(s.positions, s.level);
    const payoutCents = Math.round(s.betCents * mult);
    await credit(q, userId, payoutCents);
    await q('UPDATE rounds SET settled = 1 WHERE id = ?', [roundId]);
    await recordBet(q, userId, { game: 'pump', betCents: s.betCents, mult, payoutCents, win: true, nonce: s.nonce, detail: { positions: s.positions, level: s.level } });
    return { mult, payout: payoutCents / 100, level: s.level, balance: await balanceOf(q, userId) / 100 };
  });
}

// ---------------------------------------------------------------- SIC BO
const SICBO_COUNT = { 3:1,4:3,5:6,6:10,7:15,8:21,9:25,10:27,11:27,12:25,13:21,14:15,15:10,16:6,17:3,18:1 };
function playSicbo(userId, { bet, betType, total }) {
  const betCents = toCents(bet);
  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    const { floats, nonce, serverHash } = await fair.drawTx(q, userId, 3);
    const dice = floats.map(f => 1 + Math.floor(f * 6));
    const sum = dice[0] + dice[1] + dice[2];
    const triple = dice[0] === dice[1] && dice[1] === dice[2];
    let mult = 0, t = null;
    if (betType === 'small') { if (!triple && sum >= 4 && sum <= 10) mult = 2; }
    else if (betType === 'big') { if (!triple && sum >= 11 && sum <= 17) mult = 2; }
    else if (betType === 'triple') { if (triple) mult = 31; }
    else if (betType === 'total') {
      t = Number(total);
      if (!Number.isInteger(t) || t < 4 || t > 17) throw httpError(400, 'Total must be 4–17.');
      if (sum === t) mult = +(0.97 * 216 / SICBO_COUNT[t]).toFixed(2);
    } else throw httpError(400, 'Invalid bet.');
    const win = mult >= 1;
    const payoutCents = Math.round(betCents * mult);
    await credit(q, userId, payoutCents);
    await recordBet(q, userId, { game: 'sicbo', betCents, mult, payoutCents, win, nonce, detail: { dice, sum, betType, total: t } });
    return { dice, sum, triple, win, mult, betType, payout: payoutCents / 100, balance: await balanceOf(q, userId) / 100, nonce, serverHash };
  });
}

// ---------------------------------------------------------------- COLOR
function playColor(userId, { bet, choice }) {
  const betCents = toCents(bet);
  if (!COLOR_PAYS[choice]) throw httpError(400, 'Pick red, green or violet.');
  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    const { floats, nonce, serverHash } = await fair.drawTx(q, userId, 1);
    const digit = Math.min(9, Math.floor(floats[0] * 10));
    const color = digitColor(digit);
    const win = color === choice;
    const mult = win ? COLOR_PAYS[choice] : 0;
    const payoutCents = Math.round(betCents * mult);
    await credit(q, userId, payoutCents);
    await recordBet(q, userId, { game: 'color', betCents, mult, payoutCents, win, nonce, detail: { digit, color, choice } });
    return { digit, color, win, mult, choice, payout: payoutCents / 100, balance: await balanceOf(q, userId) / 100, nonce, serverHash };
  });
}

// ---------------------------------------------------------------- SCRATCH
function playScratch(userId, { bet }) {
  const betCents = toCents(bet);
  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    const { floats, nonce, serverHash } = await fair.drawTx(q, userId, SCRATCH_TILES);
    const tiles = floats.map(f => (f < SCRATCH_P ? 1 : 0));
    const golds = tiles.reduce((a, b) => a + b, 0);
    const mult = SCRATCH_TABLE[golds] || 0;
    const win = mult >= 1;
    const payoutCents = Math.round(betCents * mult);
    await credit(q, userId, payoutCents);
    await recordBet(q, userId, { game: 'scratch', betCents, mult, payoutCents, win, nonce, detail: { golds } });
    return { tiles, golds, mult, table: SCRATCH_TABLE, payout: payoutCents / 100, balance: await balanceOf(q, userId) / 100, nonce, serverHash };
  });
}

// ---------------------------------------------------------------- VIDEO POKER
function videoPokerStart(userId, { bet }) {
  const betCents = toCents(bet);
  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    const { floats, nonce, serverHash } = await fair.drawTx(q, userId, 10);
    const cards = drawDistinctCards(floats, 10);
    const id = crypto.randomUUID();
    await q('INSERT INTO rounds(id, user_id, game, state, settled, created_at) VALUES(?,?,?,?,0,?)',
      [id, userId, 'videopoker', JSON.stringify({ betCents, cards, nonce }), Date.now()]);
    return { roundId: id, hand: cards.slice(0, 5), pays: VIDEO_POKER_PAYS, serverHash, balance: await balanceOf(q, userId) / 100 };
  });
}
function videoPokerDraw(userId, { roundId, holds }) {
  return db.tx(async (q) => {
    const { rows } = await q('SELECT * FROM rounds WHERE id = ? AND user_id = ? AND game = ?', [roundId, userId, 'videopoker']);
    const round = rows[0];
    if (!round) throw httpError(404, 'Round not found.');
    if (Number(round.settled)) throw httpError(409, 'Round already over.');
    const s = JSON.parse(round.state);
    const held = Array.isArray(holds) ? holds.map(Boolean) : [false, false, false, false, false];
    const hand = s.cards.slice(0, 5);
    let next = 5;
    const final = hand.map((c, i) => (held[i] ? c : s.cards[next++]));
    const cat = evalVideoPoker(final);
    const mult = VIDEO_POKER_PAYS[cat];
    const win = mult >= 1;
    const payoutCents = Math.round(s.betCents * mult);
    await credit(q, userId, payoutCents);
    await q('UPDATE rounds SET settled = 1 WHERE id = ?', [roundId]);
    await recordBet(q, userId, { game: 'videopoker', betCents: s.betCents, mult, payoutCents, win, nonce: s.nonce, detail: { category: cat } });
    return { hand: final, category: cat, mult, payout: payoutCents / 100, balance: await balanceOf(q, userId) / 100 };
  });
}

// ---------------------------------------------------------------- BLACKJACK
function settleBlackjack(s) {
  while (handTotal(s.dealer).total < 17) s.dealer.push(s.shoe[s.idx++]);
  const pv = handTotal(s.player).total, dv = handTotal(s.dealer).total;
  if (pv > 21) return { outcome: 'bust', payoutCents: 0 };
  if (dv > 21) return { outcome: 'dealer_bust', payoutCents: s.stake * 2 };
  if (pv > dv) return { outcome: 'win', payoutCents: s.stake * 2 };
  if (pv < dv) return { outcome: 'lose', payoutCents: 0 };
  return { outcome: 'push', payoutCents: s.stake };
}
async function finishBlackjack(q, userId, roundId, s, outcome, payoutCents) {
  await credit(q, userId, payoutCents);
  if (roundId) await q('UPDATE rounds SET settled = 1 WHERE id = ?', [roundId]);
  await recordBet(q, userId, {
    game: 'blackjack', betCents: s.stake, mult: +(payoutCents / s.stake).toFixed(4),
    payoutCents, win: payoutCents > s.stake, nonce: s.nonce, detail: { outcome }
  });
}
function blackjackStart(userId, { bet }) {
  const betCents = toCents(bet);
  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    const { floats, nonce, serverHash } = await fair.drawTx(q, userId, 20);
    const shoe = drawDistinctCards(floats, 20);
    const player = [shoe[0], shoe[2]];
    const dealer = [shoe[1], shoe[3]];
    const s = { betCents, shoe, idx: 4, player, dealer, stake: betCents, nonce };
    const pv = handTotal(player).total, dv = handTotal(dealer).total;
    if (pv === 21 || dv === 21) {
      let outcome, payoutCents;
      if (pv === 21 && dv === 21) { outcome = 'push'; payoutCents = betCents; }
      else if (pv === 21) { outcome = 'blackjack'; payoutCents = Math.round(betCents * 2.5); }
      else { outcome = 'dealer_bj'; payoutCents = 0; }
      await finishBlackjack(q, userId, null, s, outcome, payoutCents);
      return { roundId: null, done: true, player, dealer, outcome, payout: payoutCents / 100, balance: await balanceOf(q, userId) / 100, serverHash };
    }
    const id = crypto.randomUUID();
    await q('INSERT INTO rounds(id, user_id, game, state, settled, created_at) VALUES(?,?,?,?,0,?)',
      [id, userId, 'blackjack', JSON.stringify(s), Date.now()]);
    return { roundId: id, done: false, player, dealerUp: dealer[0], total: pv, canDouble: true, serverHash, balance: await balanceOf(q, userId) / 100 };
  });
}
async function loadBlackjack(q, userId, roundId) {
  const { rows } = await q('SELECT * FROM rounds WHERE id = ? AND user_id = ? AND game = ?', [roundId, userId, 'blackjack']);
  const round = rows[0];
  if (!round) throw httpError(404, 'Round not found.');
  if (Number(round.settled)) throw httpError(409, 'Round already over.');
  return JSON.parse(round.state);
}
function blackjackHit(userId, { roundId }) {
  return db.tx(async (q) => {
    const s = await loadBlackjack(q, userId, roundId);
    s.player.push(s.shoe[s.idx++]);
    const pv = handTotal(s.player).total;
    if (pv > 21) {
      await finishBlackjack(q, userId, roundId, s, 'bust', 0);
      return { player: s.player, dealer: s.dealer, total: pv, done: true, outcome: 'bust', payout: 0, balance: await balanceOf(q, userId) / 100 };
    }
    await q('UPDATE rounds SET state = ? WHERE id = ?', [JSON.stringify(s), roundId]);
    return { player: s.player, total: pv, done: false, canDouble: false, balance: await balanceOf(q, userId) / 100 };
  });
}
function blackjackStand(userId, { roundId }) {
  return db.tx(async (q) => {
    const s = await loadBlackjack(q, userId, roundId);
    const { outcome, payoutCents } = settleBlackjack(s);
    await finishBlackjack(q, userId, roundId, s, outcome, payoutCents);
    return { player: s.player, dealer: s.dealer, done: true, outcome, payout: payoutCents / 100, balance: await balanceOf(q, userId) / 100 };
  });
}
function blackjackDouble(userId, { roundId }) {
  return db.tx(async (q) => {
    const s = await loadBlackjack(q, userId, roundId);
    if (s.player.length !== 2) throw httpError(400, 'You can only double on your first move.');
    await debit(q, userId, s.betCents);
    s.stake = s.betCents * 2;
    s.player.push(s.shoe[s.idx++]);
    let outcome, payoutCents;
    if (handTotal(s.player).total > 21) { outcome = 'bust'; payoutCents = 0; }
    else ({ outcome, payoutCents } = settleBlackjack(s));
    await finishBlackjack(q, userId, roundId, s, outcome, payoutCents);
    return { player: s.player, dealer: s.dealer, done: true, doubled: true, outcome, payout: payoutCents / 100, balance: await balanceOf(q, userId) / 100 };
  });
}

// ---------------------------------------------------------------- BACCARAT
// Punto Banco. A=1, 2-9 face, 10/J/Q/K=0; hand value = sum mod 10.
// Standard third-card rules. Bets: player 1:1, banker 0.95:1 (5% commission),
// tie 8:1. Classic edges (player ~1.24%, banker ~1.06%, tie ~14.4%).
function baccValue(cards) { return cards.reduce((s, c) => s + (c.rank >= 10 ? 0 : c.rank), 0) % 10; }
function playBaccarat(userId, { bet, betType }) {
  const betCents = toCents(bet);
  if (!['player', 'banker', 'tie'].includes(betType)) throw httpError(400, 'Bet player, banker, or tie.');
  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    const { floats, nonce, serverHash } = await fair.drawTx(q, userId, 6);
    const cards = drawDistinctCards(floats, 6);
    const player = [cards[0], cards[1]];
    const banker = [cards[2], cards[3]];
    let next = 4;
    let pv = baccValue(player), bv = baccValue(banker);
    const natural = pv >= 8 || bv >= 8;
    let playerThird = null;
    if (!natural) {
      if (pv <= 5) { playerThird = cards[next++]; player.push(playerThird); }
      const pt = playerThird ? (playerThird.rank >= 10 ? 0 : playerThird.rank) : null;
      // Banker draw rules
      let bankerDraws = false;
      if (playerThird === null) { bankerDraws = bv <= 5; }
      else if (bv <= 2) bankerDraws = true;
      else if (bv === 3) bankerDraws = pt !== 8;
      else if (bv === 4) bankerDraws = pt >= 2 && pt <= 7;
      else if (bv === 5) bankerDraws = pt >= 4 && pt <= 7;
      else if (bv === 6) bankerDraws = pt === 6 || pt === 7;
      if (bankerDraws) banker.push(cards[next++]);
      pv = baccValue(player); bv = baccValue(banker);
    }
    const result = pv > bv ? 'player' : (bv > pv ? 'banker' : 'tie');
    let mult = 0;
    if (betType === 'tie') mult = result === 'tie' ? 9 : 0;            // 8:1 win + stake
    else if (result === 'tie') mult = 1;                               // player/banker push on tie
    else if (betType === result) mult = betType === 'banker' ? 1.95 : 2;
    const payoutCents = Math.round(betCents * mult);
    await credit(q, userId, payoutCents);
    const win = payoutCents > betCents;
    await recordBet(q, userId, { game: 'baccarat', betCents, mult: win ? mult : 0, payoutCents, win, nonce, detail: { betType, result, pv, bv } });
    return { player, banker, pv, bv, result, betType, win, mult, payout: payoutCents / 100, balance: await balanceOf(q, userId) / 100, nonce, serverHash };
  });
}

// ---------------------------------------------------------------- DRAGON TIGER
// One card to Dragon, one to Tiger; higher rank wins (A low ... K high).
// Dragon/Tiger pay 1:1 (lose on tie). Tie bet pays 11:1.
function playDragonTiger(userId, { bet, betType }) {
  const betCents = toCents(bet);
  if (!['dragon', 'tiger', 'tie'].includes(betType)) throw httpError(400, 'Bet dragon, tiger, or tie.');
  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    const { floats, nonce, serverHash } = await fair.drawTx(q, userId, 2);
    // Independent (infinite-shoe) draws so P(tie) = 1/13, the standard rate.
    const dragon = cardFromIndex(Math.min(51, Math.floor(floats[0] * 52)));
    const tiger = cardFromIndex(Math.min(51, Math.floor(floats[1] * 52)));
    if (dragon.rank === tiger.rank && dragon.suit === tiger.suit) tiger.suit = (tiger.suit + 1) % 4;
    const result = dragon.rank > tiger.rank ? 'dragon' : (tiger.rank > dragon.rank ? 'tiger' : 'tie');
    let mult = 0;
    if (betType === 'tie') mult = result === 'tie' ? 12 : 0;
    else if (result === 'tie') mult = 0.5;                              // half-back on tie
    else if (betType === result) mult = 2;
    const payoutCents = Math.round(betCents * mult);
    await credit(q, userId, payoutCents);
    const win = payoutCents > betCents;
    await recordBet(q, userId, { game: 'dragontiger', betCents, mult: win ? mult : 0, payoutCents, win, nonce, detail: { betType, result } });
    return { dragon, tiger, result, betType, win, mult, payout: payoutCents / 100, balance: await balanceOf(q, userId) / 100, nonce, serverHash };
  });
}

// ---------------------------------------------------------------- ANDAR BAHAR
// A middle card is shown; cards are dealt alternately to Andar (first) and Bahar
// until one matches the middle card's rank. Bet which side matches first.
// Andar pays 0.9:1 (positionally favoured), Bahar pays 1:1.
function playAndarBahar(userId, { bet, side }) {
  const betCents = toCents(bet);
  if (!['andar', 'bahar'].includes(side)) throw httpError(400, 'Bet andar or bahar.');
  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    const { floats, nonce, serverHash } = await fair.drawTx(q, userId, 52);
    const deck = drawDistinctCards(floats, 52);
    const middle = deck[0];
    const andar = [], bahar = [];
    let winner = null, idx = 1;
    while (idx < deck.length) {
      const card = deck[idx++];
      if (andar.length <= bahar.length) { andar.push(card); if (card.rank === middle.rank) { winner = 'andar'; break; } }
      else { bahar.push(card); if (card.rank === middle.rank) { winner = 'bahar'; break; } }
    }
    const mult = winner === side ? (side === 'andar' ? 1.9 : 2) : 0;
    const payoutCents = Math.round(betCents * mult);
    await credit(q, userId, payoutCents);
    const win = payoutCents > betCents;
    await recordBet(q, userId, { game: 'andarbahar', betCents, mult: win ? mult : 0, payoutCents, win, nonce, detail: { side, winner, count: andar.length + bahar.length } });
    return { middle, andar, bahar, winner, side, win, mult, payout: payoutCents / 100, balance: await balanceOf(q, userId) / 100, nonce, serverHash };
  });
}

// ---------------------------------------------------------------- CASCADE (original)
// Energy cascades through 6 cells. Each cell "ignites" with probability p (set by
// risk). The cascade stops at the first cell that fails; you're paid by how many
// cells ignited in a row. Auto-revealed, no decisions. Paytables generated to a
// disclosed ~3.5% edge.
const CASCADE_CELLS = 6, CASCADE_EDGE = 0.035;
const CASCADE_P = { low: 0.72, mid: 0.55, high: 0.40 };
function buildCascadeTable(p) {
  // weight by ignition count (more ignitions → exponentially bigger), normalized to edge.
  const threshold = 2;
  const probExactly = k => (k === CASCADE_CELLS ? Math.pow(p, k) : Math.pow(p, k) * (1 - p));
  const weights = [];
  let evRaw = 0;
  for (let k = threshold; k <= CASCADE_CELLS; k++) {
    const w = Math.pow(k - threshold + 1, 2.0);
    weights.push([k, w]);
    evRaw += probExactly(k) * w;
  }
  const alpha = evRaw > 0 ? (1 - CASCADE_EDGE) / evRaw : 0;
  const table = new Array(CASCADE_CELLS + 1).fill(0);
  weights.forEach(([k, w]) => { table[k] = +(alpha * w).toFixed(2); });
  return table;
}
const CASCADE_TABLES = { low: buildCascadeTable(CASCADE_P.low), mid: buildCascadeTable(CASCADE_P.mid), high: buildCascadeTable(CASCADE_P.high) };
function playCascade(userId, { bet, risk }) {
  const betCents = toCents(bet);
  if (!CASCADE_P[risk]) throw httpError(400, 'Invalid risk.');
  const p = CASCADE_P[risk], table = CASCADE_TABLES[risk];
  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    const { floats, nonce, serverHash } = await fair.drawTx(q, userId, CASCADE_CELLS);
    const cells = [];
    let ignited = 0, broken = false;
    for (let i = 0; i < CASCADE_CELLS; i++) {
      const ok = !broken && floats[i] < p;
      cells.push(ok);
      if (ok) ignited++; else broken = true;
    }
    const mult = table[ignited] || 0;
    const win = mult >= 1;
    const payoutCents = Math.round(betCents * mult);
    await credit(q, userId, payoutCents);
    await recordBet(q, userId, { game: 'cascade', betCents, mult, payoutCents, win, nonce, detail: { ignited, risk } });
    return { cells, ignited, mult, risk, table, payout: payoutCents / 100, balance: await balanceOf(q, userId) / 100, nonce, serverHash };
  });
}

// ---------------------------------------------------------------- WAR
// You vs dealer — each gets one card (uniform rank 1..13). Higher rank wins
// 2x bet, lower loses, tie returns half the bet. RTP ≈ 96.2%.
function playWar(userId, { bet }) {
  const betCents = toCents(bet);
  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    const { floats, nonce, serverHash } = await fair.drawTx(q, userId, 4);
    const playerRank = 1 + Math.floor(floats[0] * 13);
    const dealerRank = 1 + Math.floor(floats[1] * 13);
    const playerSuit = Math.floor(floats[2] * 4);
    const dealerSuit = Math.floor(floats[3] * 4);
    let mult = 0, outcome;
    if (playerRank > dealerRank)      { mult = 2;   outcome = 'win'; }
    else if (playerRank < dealerRank) { mult = 0;   outcome = 'lose'; }
    else                              { mult = 0.5; outcome = 'tie'; }
    const win = mult >= 1;
    const payoutCents = Math.round(betCents * mult);
    await credit(q, userId, payoutCents);
    await recordBet(q, userId, { game: 'war', betCents, mult, payoutCents, win, nonce, detail: { playerRank, dealerRank, outcome } });
    return {
      player: { rank: playerRank, suit: playerSuit },
      dealer: { rank: dealerRank, suit: dealerSuit },
      outcome, mult, payout: payoutCents / 100,
      balance: await balanceOf(q, userId) / 100, nonce, serverHash
    };
  });
}

// ---------------------------------------------------------------- PACHINKO
// 6 rows of pegs, 7 slots at the bottom. Slot probabilities follow a binomial
// distribution (1/6/15/20/15/6/1 over 64); multipliers are symmetric with a
// modest 4x jackpot on the outer slots. RTP ≈ 0.95.
const PACHINKO_ROWS = 6;
const PACHINKO_SLOTS = [4, 0.4, 0.8, 1.2, 0.8, 0.4, 4];
function playPachinko(userId, { bet }) {
  const betCents = toCents(bet);
  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    const { floats, nonce, serverHash } = await fair.drawTx(q, userId, PACHINKO_ROWS);
    // Each row deflects the ball left (0) or right (1); the column count
    // determines which of the 7 slots the ball lands in.
    const path = floats.map(f => f < 0.5 ? 0 : 1);
    const slot = path.reduce((s, b) => s + b, 0);
    const mult = PACHINKO_SLOTS[slot];
    const win = mult >= 1;
    const payoutCents = Math.round(betCents * mult);
    await credit(q, userId, payoutCents);
    await recordBet(q, userId, { game: 'pachinko', betCents, mult, payoutCents, win, nonce, detail: { slot, path } });
    return { path, slot, mult, slots: PACHINKO_SLOTS, payout: payoutCents / 100, balance: await balanceOf(q, userId) / 100, nonce, serverHash };
  });
}


module.exports = {
  playDice, playPlinko, playCrash,
  minesStart, minesReveal, minesCashout,
  playLimbo, playWheel, playKeno,
  hiloStart, hiloGuess, hiloCashout,
  towersStart, towersReveal, towersCashout,
  playRoulette,
  coinStart, coinFlip, coinCashout,
  playDiamonds, playSlots, playLuckySevens, playCosmicReels,
  pumpStart, pumpPump, pumpCashout,
  playSicbo, playColor, playScratch,
  videoPokerStart, videoPokerDraw,
  blackjackStart, blackjackHit, blackjackStand, blackjackDouble,
  playBaccarat, playDragonTiger, playAndarBahar, playCascade,
  playWar, playPachinko,
  jackpotState, jackpotEnsure,
  CASCADE_TABLES, CASCADE_P
};
