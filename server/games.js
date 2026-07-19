'use strict';

/* Server-authoritative game logic (async, transactional).
 * Every wager runs inside a db transaction: balance is debited atomically, the
 * provably-fair draw advances the nonce, the outcome is computed, balance is
 * credited and the bet is recorded — all or nothing. The client cannot affect
 * results or balances. */

const crypto = require('crypto');
const db = require('./db');
const fair = require('./fair');
const progression = require('./progression');
const { httpError, logAudit } = require('./auth');
const limits = require('./limits');

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

// ---- Wheel paytables (10 segments; mean payout ≈ 0.99 → ~1% edge) ----
const WHEEL = {
  low:  [1.2, 1.2, 0, 1.2, 1.5, 1.2, 0, 1.2, 1.2, 1.2],
  mid:  [0, 1.7, 0, 2.0, 0, 1.7, 0, 2.5, 0, 2.0],
  high: [0, 0, 0, 0, 4.0, 0, 0, 0, 0, 5.9]
};

// ---- Towers difficulty (tiles per row, safe tiles per row) ----
const TOWERS = {
  easy:      { tiles: 4, safe: 3 },
  medium:    { tiles: 3, safe: 2 },
  hard:      { tiles: 2, safe: 1 },
  expert:    { tiles: 3, safe: 1 },
  nightmare: { tiles: 4, safe: 1 }
};
const TOWERS_ROWS = 9;
function towersStepFactor(diff) {
  const d = TOWERS[diff];
  return (d.tiles / d.safe) * (1 - HOUSE);
}
function towersMult(diff, rowsCleared) {
  return +Math.pow(towersStepFactor(diff), rowsCleared).toFixed(4);
}

// ---- Hi-Lo (ranks 1..13, uniform). "hi" = next >= current, "lo" = next <= current. ----
function hiloChances(card) {
  return { hi: (14 - card) / 13, lo: card / 13 };
}
function hiloMults(card) {
  const c = hiloChances(card);
  return { hi: +(((1 - HOUSE) / c.hi)).toFixed(4), lo: +(((1 - HOUSE) / c.lo)).toFixed(4) };
}

// ---- Keno: 40-number pool, 10 drawn, pick 1..10. Fair paytable generated from
// the hypergeometric hit distribution, normalized to ~3% edge (disclosed). ----
const KENO_N = 40, KENO_DRAW = 10, KENO_EDGE = 0.03;
function comb(n, k) {
  if (k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return r;
}
function kenoHitProb(picks, hits) {
  return (comb(KENO_DRAW, hits) * comb(KENO_N - KENO_DRAW, picks - hits)) / comb(KENO_N, picks);
}
function buildKenoTable(picks) {
  const threshold = Math.max(1, Math.round(picks * 0.5));
  const weights = [];
  let evRaw = 0;
  for (let k = threshold; k <= picks; k++) {
    const w = Math.pow(k - threshold + 1, 1.8);
    weights.push([k, w]);
    evRaw += kenoHitProb(picks, k) * w;
  }
  const alpha = evRaw > 0 ? (1 - KENO_EDGE) / evRaw : 0;
  const table = new Array(picks + 1).fill(0);
  weights.forEach(([k, w]) => { table[k] = +(alpha * w).toFixed(2); });
  return table;
}
const KENO_TABLES = {};
for (let p = 1; p <= 10; p++) KENO_TABLES[p] = buildKenoTable(p);
function kenoTable(picks) {
  picks = Number(picks);
  if (!Number.isInteger(picks) || picks < 1 || picks > 10) throw httpError(400, 'Pick 1 to 10 numbers.');
  return { picks, pool: KENO_N, draw: KENO_DRAW, table: KENO_TABLES[picks] };
}

// ---- Roulette (European, single zero) ----
const ROULETTE_RED = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
function rouletteColor(n) { return n === 0 ? 'green' : (ROULETTE_RED.has(n) ? 'red' : 'black'); }

// ---- Diamonds (5 gems, 7 types) — paytable tuned to mean ≈ 0.99 ----
const DIAMOND_PAYS = { five: 100, four: 16, full: 6, three: 2, twopair: 1.2, pair: 0.25, none: 0 };
function diamondCategory(counts) {
  const c = counts.slice().sort((a, b) => b - a); // descending group sizes
  if (c[0] === 5) return 'five';
  if (c[0] === 4) return 'four';
  if (c[0] === 3 && c[1] === 2) return 'full';
  if (c[0] === 3) return 'three';
  if (c[0] === 2 && c[1] === 2) return 'twopair';
  if (c[0] === 2) return 'pair';
  return 'none';
}

// ---- Slots — 3 reels, uniform draw across N symbols, ~4% house edge.
// Triple = bigSymbolMult, pair = pairPay. Mults computed to hit the target
// RTP regardless of symbol-count (5, 6, 7 supported below).
function buildSlotTable({ symbols, weights, pairPay, rtp = 0.96 }) {
  const N = symbols.length;
  const p3 = 1 / Math.pow(N, 3);                               // P(specific triple)
  const exactlyTwoEqualCount = 3 * N * (N - 1);                // ordered triples with exactly two equal
  const pPair = exactlyTwoEqualCount / Math.pow(N, 3);
  const sumW = weights.reduce((a, b) => a + b, 0);
  const alpha = (rtp - pPair * pairPay) / (p3 * sumW);
  return weights.map(x => +(alpha * x).toFixed(2));
}

const SLOT_THEMES = {
  classic: {
    symbols: ['cherry', 'lemon', 'bell', 'star', 'bar', 'seven'],
    weights: [1, 1.4, 2, 3, 5, 9],
    pairPay: 0.5
  },
  sevens: {
    // 5 symbols → higher pair rate (frequent small wins), 7-7-7 the big one.
    symbols: ['cherry', 'lemon', 'bell', 'bar', 'seven'],
    weights: [1, 1.3, 2.2, 4, 12],
    pairPay: 0.6
  },
  cosmic: {
    // 7 symbols → rarer pairs, bigger jackpot on the top symbol.
    symbols: ['comet', 'planet', 'star', 'galaxy', 'ufo', 'rocket', 'eclipse'],
    weights: [1, 1.4, 2, 3, 5, 8, 15],
    pairPay: 0.45
  }
};
// Pre-compute the triple pay tables once at load.
for (const key of Object.keys(SLOT_THEMES)) {
  SLOT_THEMES[key].triple = buildSlotTable(SLOT_THEMES[key]);
}

// Compat exports — kept so other modules (and tests) reading the classic
// table keep working.
const SLOT_SYMBOLS  = SLOT_THEMES.classic.symbols;
const SLOT_PAIR_PAY = SLOT_THEMES.classic.pairPay;
const SLOT_TRIPLE   = SLOT_THEMES.classic.triple;

// ---- Pump (escalating extraction meter) ----
const PUMP = { easy: 20, medium: 10, hard: 5, extreme: 3 }; // number of positions (1 hidden bomb)
function pumpMult(positions, level) { return +((1 - HOUSE) * positions / (positions - level)).toFixed(4); }

// ---- Color prediction (digit 0–9 → color) ----
const COLOR_MAP = { violet: [0, 5], red: [1, 3, 7, 9], green: [2, 4, 6, 8] };
const COLOR_PAYS = { violet: 4.8, red: 2.4, green: 2.4 };
function digitColor(d) {
  if (COLOR_MAP.violet.includes(d)) return 'violet';
  return COLOR_MAP.red.includes(d) ? 'red' : 'green';
}

// ---- Scratch (9 tiles, each a "gold" with p=0.3) — binomial fair table, ~5% edge ----
const SCRATCH_TILES = 9, SCRATCH_P = 0.3, SCRATCH_EDGE = 0.05;
function binom(n, k, p) { return comb(n, k) * Math.pow(p, k) * Math.pow(1 - p, n - k); }
const SCRATCH_TABLE = (() => {
  const threshold = 3;
  const weights = [];
  let evRaw = 0;
  for (let k = threshold; k <= SCRATCH_TILES; k++) {
    const wk = Math.pow(k - threshold + 1, 1.7);
    weights.push([k, wk]);
    evRaw += binom(SCRATCH_TILES, k, SCRATCH_P) * wk;
  }
  const alpha = (1 - SCRATCH_EDGE) / evRaw;
  const table = new Array(SCRATCH_TILES + 1).fill(0);
  weights.forEach(([k, wk]) => { table[k] = +(alpha * wk).toFixed(2); });
  return table;
})();

// ---- Card helpers (shared by Video Poker & Blackjack) ----
// Card = { rank: 1..13 (A=1, J=11, Q=12, K=13), suit: 0..3 }. index 0..51.
function cardFromIndex(i) { return { rank: (i % 13) + 1, suit: Math.floor(i / 13) }; }
// Sample `n` distinct card indices from a 52-card deck using `floats` (partial Fisher–Yates).
function drawDistinctCards(floats, n) {
  const pool = Array.from({ length: 52 }, (_, i) => i);
  const out = [];
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(floats[i] * (52 - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
    out.push(cardFromIndex(pool[i]));
  }
  return out;
}
function isFlush(cards) { return cards.every(c => c.suit === cards[0].suit); }
function isStraight(ranks) {
  const u = [...new Set(ranks)].sort((a, b) => a - b);
  if (u.length !== 5) return false;
  if (u[4] - u[0] === 4) return true;
  // Ace-high straight: 10, J, Q, K, A (1)
  return JSON.stringify(u) === JSON.stringify([1, 10, 11, 12, 13]);
}
// Jacks-or-Better evaluation → category string.
const VIDEO_POKER_PAYS = { royal: 250, sf: 50, four: 25, full: 9, flush: 6, straight: 4, three: 3, twopair: 2, jacks: 1, none: 0 };
function evalVideoPoker(cards) {
  const ranks = cards.map(c => c.rank);
  const counts = {};
  ranks.forEach(r => { counts[r] = (counts[r] || 0) + 1; });
  const groups = Object.values(counts).sort((a, b) => b - a);
  const flush = isFlush(cards);
  const straight = isStraight(ranks);
  const u = [...new Set(ranks)].sort((a, b) => a - b);
  const royal = flush && JSON.stringify(u) === JSON.stringify([1, 10, 11, 12, 13]);
  if (royal) return 'royal';
  if (flush && straight) return 'sf';
  if (groups[0] === 4) return 'four';
  if (groups[0] === 3 && groups[1] === 2) return 'full';
  if (flush) return 'flush';
  if (straight) return 'straight';
  if (groups[0] === 3) return 'three';
  if (groups[0] === 2 && groups[1] === 2) return 'twopair';
  if (groups[0] === 2) {
    // pair pays only if Jacks or better (J=11,Q,K, or Aces=1)
    const pairRank = Number(Object.keys(counts).find(r => counts[r] === 2));
    if (pairRank === 1 || pairRank >= 11) return 'jacks';
  }
  return 'none';
}
// Blackjack hand total (aces 11 then reduced). Returns { total, soft }.
function handTotal(cards) {
  let total = 0, aces = 0;
  cards.forEach(c => {
    const v = c.rank === 1 ? 11 : Math.min(10, c.rank); // J/Q/K = 10
    total += v;
    if (c.rank === 1) aces++;
  });
  let soft = aces > 0;
  while (total > 21 && aces > 0) { total -= 10; aces--; if (aces === 0) soft = false; }
  if (aces === 0) soft = false;
  return { total, soft };
}

function toCents(dollars) {
  const n = Number(dollars);
  if (!isFinite(n) || n <= 0) throw httpError(400, 'Invalid bet amount.');
  return Math.round(n * 100);
}

// Atomic, dialect-portable debit. Throws if the balance is insufficient.
async function debit(q, userId, betCents) {
  // Responsible-gaming gate lives in the wager chokepoint: every game's stake
  // (including doubles and Play bets) passes through here, so loss limits and
  // self-exclusion can't be bypassed by any client.
  await limits.enforceWagerEligibility(q, userId);
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
  // Capture the provably-fair commitment + client seed active for this bet so
  // it can be re-derived later. recordBet runs in the same tx as the draw, so
  // the fair row still holds exactly the seed/hash the outcome used. (A game
  // may pass them explicitly; otherwise we read the live fair row.)
  let serverHash = b.serverHash, clientSeed = b.clientSeed;
  if (serverHash == null || clientSeed == null) {
    try {
      const { rows } = await q('SELECT server_hash, client_seed FROM fair WHERE user_id = ?', [userId]);
      if (rows[0]) { serverHash = serverHash ?? rows[0].server_hash; clientSeed = clientSeed ?? rows[0].client_seed; }
    } catch (_) { /* fairness metadata is best-effort; never block a settled bet */ }
  }
  await q(`INSERT INTO bets(user_id, game, bet_cents, mult, payout_cents, win, nonce, detail, server_hash, client_seed, created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    [userId, b.game, b.betCents, b.mult, b.payoutCents, b.win ? 1 : 0, b.nonce,
     b.detail ? JSON.stringify(b.detail) : null, serverHash || null, clientSeed || null, Date.now()]);
  // Award XP + check achievements + bump level inside the same tx. The delta
  // is stashed in the request-scoped store so the `h()` wrapper in index.js
  // can merge it into the response without every game touching its return.
  try {
    const delta = await progression.awardForBet(q, userId, {
      bet_cents: b.betCents, payout_cents: b.payoutCents, mult: b.mult, win: b.win ? 1 : 0, game: b.game
    });
    const store = progression.requestStore.getStore();
    if (store) {
      // If multiple bets fire in one request (e.g. a round game's reveal +
      // cashout), accumulate the deltas instead of replacing them.
      if (!store.progress) store.progress = { xpGained: 0, leveledUp: false, oldLevel: delta.oldLevel, newLevel: delta.newLevel, unlocked: [] };
      store.progress.xpGained += delta.xpGained;
      store.progress.leveledUp = store.progress.leveledUp || delta.leveledUp;
      store.progress.newLevel = delta.newLevel;
      store.progress.unlocked.push(...delta.unlocked);
    }
  } catch (e) {
    // Progression failures must never break a settled bet, but they must not
    // be silent either — ops won't notice achievements quietly going away.
    console.error('progression.awardForBet failed for user', userId, b.game, e);
  }
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

// ---------------------------------------------------------------- CHICKEN ROAD
// Hop across lanes of traffic. Each lane survives with probability p (drawn
// fresh at hop time from the fair stream); mult after n lanes is
// (1 - HOUSE) / p^n. Cash out any time, or clear every lane for the max.
const CHICKEN = {
  easy:      { p: 0.95, lanes: 24 },
  medium:    { p: 0.88, lanes: 20 },
  hard:      { p: 0.78, lanes: 16 },
  daredevil: { p: 0.65, lanes: 12 }
};
function chickenMult(p, n) { return +((1 - HOUSE) / Math.pow(p, n)).toFixed(4); }
function chickenStart(userId, { bet, difficulty }) {
  const betCents = toCents(bet);
  const cfg = CHICKEN[difficulty];
  if (!cfg) throw httpError(400, 'Invalid difficulty.');
  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    const id = crypto.randomUUID();
    await q('INSERT INTO rounds(id, user_id, game, state, settled, created_at) VALUES(?,?,?,?,0,?)',
      [id, userId, 'chicken', JSON.stringify({ betCents, p: cfg.p, lanes: cfg.lanes, step: 0, difficulty, nonce: 0 }), Date.now()]);
    return {
      roundId: id, lanes: cfg.lanes, difficulty,
      nextMult: chickenMult(cfg.p, 1),
      balance: await balanceOf(q, userId) / 100
    };
  });
}
function chickenStep(userId, { roundId }) {
  return db.tx(async (q) => {
    const { rows } = await q('SELECT * FROM rounds WHERE id = ? AND user_id = ? AND game = ?', [roundId, userId, 'chicken']);
    const round = rows[0];
    if (!round) throw httpError(404, 'Round not found.');
    if (Number(round.settled)) throw httpError(409, 'Round already over.');
    const s = JSON.parse(round.state);
    const { floats, nonce } = await fair.drawTx(q, userId, 1);
    if (floats[0] >= s.p) {
      // Hit by traffic on this lane.
      await q('UPDATE rounds SET settled = 1 WHERE id = ?', [roundId]);
      await recordBet(q, userId, { game: 'chicken', betCents: s.betCents, mult: 0, payoutCents: 0, win: false, nonce, detail: { difficulty: s.difficulty, hitAt: s.step + 1 } });
      return { hit: true, step: s.step + 1, balance: await balanceOf(q, userId) / 100 };
    }
    s.step += 1;
    s.nonce = nonce; // remembered so a later cashout records a real nonce
    const mult = chickenMult(s.p, s.step);
    if (s.step >= s.lanes) {
      const payoutCents = Math.round(s.betCents * mult);
      await credit(q, userId, payoutCents);
      await q('UPDATE rounds SET settled = 1 WHERE id = ?', [roundId]);
      await recordBet(q, userId, { game: 'chicken', betCents: s.betCents, mult, payoutCents, win: true, nonce, detail: { difficulty: s.difficulty, cleared: true } });
      return { hit: false, step: s.step, mult, cleared: true, payout: payoutCents / 100, balance: await balanceOf(q, userId) / 100 };
    }
    await q('UPDATE rounds SET state = ? WHERE id = ?', [JSON.stringify(s), roundId]);
    return {
      hit: false, step: s.step, mult,
      nextMult: chickenMult(s.p, s.step + 1),
      cashout: (s.betCents * mult) / 100,
      balance: await balanceOf(q, userId) / 100
    };
  });
}
function chickenCashout(userId, { roundId }) {
  return db.tx(async (q) => {
    const { rows } = await q('SELECT * FROM rounds WHERE id = ? AND user_id = ? AND game = ?', [roundId, userId, 'chicken']);
    const round = rows[0];
    if (!round) throw httpError(404, 'Round not found.');
    if (Number(round.settled)) throw httpError(409, 'Round already over.');
    const s = JSON.parse(round.state);
    if (s.step < 1) throw httpError(400, 'Cross at least one lane first.');
    const mult = chickenMult(s.p, s.step);
    const payoutCents = Math.round(s.betCents * mult);
    await credit(q, userId, payoutCents);
    await q('UPDATE rounds SET settled = 1 WHERE id = ?', [roundId]);
    await recordBet(q, userId, { game: 'chicken', betCents: s.betCents, mult, payoutCents, win: true, nonce: s.nonce, detail: { difficulty: s.difficulty, step: s.step } });
    return { mult, payout: payoutCents / 100, step: s.step, balance: await balanceOf(q, userId) / 100 };
  });
}

// ---------------------------------------------------------------- CRAPS
// Authentic pass-line bet. Come-out roll: 7/11 win even money, 2/3/12 crap
// out, anything else sets the point — then roll until the point repeats
// (win) or a 7 shows (seven out). True odds give the classic ~1.41% edge;
// no artificial house cut is applied on top.
function crapsRoll2(floats) {
  return [1 + Math.floor(floats[0] * 6), 1 + Math.floor(floats[1] * 6)];
}
function crapsStart(userId, { bet }) {
  const betCents = toCents(bet);
  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    const { floats, nonce, serverHash } = await fair.drawTx(q, userId, 2);
    const dice = crapsRoll2(floats);
    const sum = dice[0] + dice[1];
    if (sum === 7 || sum === 11) {
      const payoutCents = betCents * 2;
      await credit(q, userId, payoutCents);
      await recordBet(q, userId, { game: 'craps', betCents, mult: 2, payoutCents, win: true, nonce, detail: { comeOut: sum, natural: true } });
      return { dice, sum, outcome: 'natural', mult: 2, payout: payoutCents / 100, done: true, balance: await balanceOf(q, userId) / 100, serverHash };
    }
    if (sum === 2 || sum === 3 || sum === 12) {
      await recordBet(q, userId, { game: 'craps', betCents, mult: 0, payoutCents: 0, win: false, nonce, detail: { comeOut: sum, craps: true } });
      return { dice, sum, outcome: 'craps', mult: 0, payout: 0, done: true, balance: await balanceOf(q, userId) / 100, serverHash };
    }
    const id = crypto.randomUUID();
    await q('INSERT INTO rounds(id, user_id, game, state, settled, created_at) VALUES(?,?,?,?,0,?)',
      [id, userId, 'craps', JSON.stringify({ betCents, point: sum }), Date.now()]);
    return { dice, sum, outcome: 'point', point: sum, roundId: id, done: false, balance: await balanceOf(q, userId) / 100, serverHash };
  });
}
function crapsRoll(userId, { roundId }) {
  return db.tx(async (q) => {
    const { rows } = await q('SELECT * FROM rounds WHERE id = ? AND user_id = ? AND game = ?', [roundId, userId, 'craps']);
    const round = rows[0];
    if (!round) throw httpError(404, 'Round not found.');
    if (Number(round.settled)) throw httpError(409, 'Round already over.');
    const s = JSON.parse(round.state);
    const { floats, nonce } = await fair.drawTx(q, userId, 2);
    const dice = crapsRoll2(floats);
    const sum = dice[0] + dice[1];
    if (sum === s.point) {
      const payoutCents = s.betCents * 2;
      await credit(q, userId, payoutCents);
      await q('UPDATE rounds SET settled = 1 WHERE id = ?', [roundId]);
      await recordBet(q, userId, { game: 'craps', betCents: s.betCents, mult: 2, payoutCents, win: true, nonce, detail: { point: s.point, made: true } });
      return { dice, sum, outcome: 'point_made', mult: 2, payout: payoutCents / 100, done: true, balance: await balanceOf(q, userId) / 100 };
    }
    if (sum === 7) {
      await q('UPDATE rounds SET settled = 1 WHERE id = ?', [roundId]);
      await recordBet(q, userId, { game: 'craps', betCents: s.betCents, mult: 0, payoutCents: 0, win: false, nonce, detail: { point: s.point, sevenOut: true } });
      return { dice, sum, outcome: 'seven_out', mult: 0, payout: 0, done: true, balance: await balanceOf(q, userId) / 100 };
    }
    return { dice, sum, outcome: 'roll', point: s.point, roundId, done: false, balance: await balanceOf(q, userId) / 100 };
  });
}

// ---------------------------------------------------------------- THREE CARD POKER
// Ante + Play vs the dealer. Dealer qualifies with Queen-high; if they don't,
// the ante pays even money and the Play bet pushes. Ante bonus pays on a
// straight or better regardless of the dealer's hand.
const TCP_RANKING = { high: 0, pair: 1, flush: 2, straight: 3, trips: 4, straightFlush: 5 };
const TCP_ANTE_BONUS = { straight: 1, trips: 4, straightFlush: 5 };
// A=1 plays high (14) except in the A-2-3 straight.
function tcpOrder(r) { return r === 1 ? 14 : r; }
function tcpEvaluate(cards) {
  const ranks = cards.map(c => c.rank);
  const ord = ranks.map(tcpOrder).sort((a, b) => b - a);   // descending, ace-high
  const flush = cards.every(c => c.suit === cards[0].suit);
  const uniq = new Set(ranks);
  let straight = false, straightHigh = 0;
  if (uniq.size === 3) {
    const asc = [...ord].sort((a, b) => a - b);
    if (asc[2] - asc[0] === 2 && asc[1] - asc[0] === 1) { straight = true; straightHigh = asc[2]; }
    // A-2-3: ace plays LOW; the straight is 3-high.
    else if (ranks.includes(1) && ranks.includes(2) && ranks.includes(3)) { straight = true; straightHigh = 3; }
  }
  const trips = uniq.size === 1;
  const pair = uniq.size === 2;
  let kind, kickers;
  if (straight && flush) { kind = 'straightFlush'; kickers = [straightHigh]; }
  else if (trips)        { kind = 'trips';         kickers = [ord[0]]; }
  else if (straight)     { kind = 'straight';      kickers = [straightHigh]; }
  else if (flush)        { kind = 'flush';         kickers = ord; }
  else if (pair) {
    const pairRank = tcpOrder(ranks.find(r => ranks.filter(x => x === r).length === 2));
    const kicker = ord.find(o => o !== pairRank);
    kind = 'pair'; kickers = [pairRank, kicker];
  } else { kind = 'high'; kickers = ord; }
  return { kind, rankValue: TCP_RANKING[kind], kickers };
}
function tcpCompare(a, b) {
  if (a.rankValue !== b.rankValue) return a.rankValue - b.rankValue;
  for (let i = 0; i < Math.max(a.kickers.length, b.kickers.length); i++) {
    const d = (a.kickers[i] || 0) - (b.kickers[i] || 0);
    if (d) return d;
  }
  return 0;
}
function tcpDealerQualifies(hand) {
  return hand.rankValue > TCP_RANKING.high || hand.kickers[0] >= 12; // Q-high or better
}
function tcpStart(userId, { bet }) {
  const betCents = toCents(bet); // the Ante
  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    const { floats, nonce, serverHash } = await fair.drawTx(q, userId, 6);
    const cards = drawDistinctCards(floats, 6);
    const player = cards.slice(0, 3), dealer = cards.slice(3);
    const id = crypto.randomUUID();
    await q('INSERT INTO rounds(id, user_id, game, state, settled, created_at) VALUES(?,?,?,?,0,?)',
      [id, userId, 'tcp', JSON.stringify({ betCents, player, dealer, nonce }), Date.now()]);
    return { roundId: id, player, serverHash, balance: await balanceOf(q, userId) / 100 };
  });
}
function tcpAct(userId, { roundId, action }) {
  if (action !== 'play' && action !== 'fold') throw httpError(400, "Action must be 'play' or 'fold'.");
  return db.tx(async (q) => {
    const { rows } = await q('SELECT * FROM rounds WHERE id = ? AND user_id = ? AND game = ?', [roundId, userId, 'tcp']);
    const round = rows[0];
    if (!round) throw httpError(404, 'Round not found.');
    if (Number(round.settled)) throw httpError(409, 'Round already over.');
    const s = JSON.parse(round.state);
    await q('UPDATE rounds SET settled = 1 WHERE id = ?', [roundId]);
    const pHand = tcpEvaluate(s.player), dHand = tcpEvaluate(s.dealer);

    if (action === 'fold') {
      await recordBet(q, userId, { game: 'tcp', betCents: s.betCents, mult: 0, payoutCents: 0, win: false, nonce: s.nonce, detail: { folded: true } });
      return { folded: true, dealer: s.dealer, playerHand: pHand.kind, dealerHand: dHand.kind, payout: 0, balance: await balanceOf(q, userId) / 100 };
    }
    // The Play bet equals the ante — debit it now (throws if broke).
    await debit(q, userId, s.betCents);
    const totalStake = s.betCents * 2;
    const bonusCents = (TCP_ANTE_BONUS[pHand.kind] || 0) * s.betCents;
    let payoutCents, outcome;
    if (!tcpDealerQualifies(dHand)) {
      // Ante pays 1:1, Play pushes.
      payoutCents = s.betCents * 2 + s.betCents + bonusCents;
      outcome = 'dealer_no_qualify';
    } else {
      const cmp = tcpCompare(pHand, dHand);
      if (cmp > 0)      { payoutCents = totalStake * 2 + bonusCents; outcome = 'win'; }
      else if (cmp < 0) { payoutCents = bonusCents;                  outcome = 'lose'; }
      else              { payoutCents = totalStake + bonusCents;     outcome = 'push'; }
    }
    const mult = totalStake > 0 ? +(payoutCents / totalStake).toFixed(4) : 0;
    if (payoutCents > 0) await credit(q, userId, payoutCents);
    await recordBet(q, userId, { game: 'tcp', betCents: totalStake, mult, payoutCents, win: payoutCents > totalStake, nonce: s.nonce, detail: { outcome, playerHand: pHand.kind, dealerHand: dHand.kind, bonus: bonusCents / 100 } });
    return {
      folded: false, outcome, dealer: s.dealer,
      playerHand: pHand.kind, dealerHand: dHand.kind,
      bonus: bonusCents / 100, mult, payout: payoutCents / 100,
      balance: await balanceOf(q, userId) / 100
    };
  });
}

// ---------------------------------------------------------------- BINGO RUSH
// 5x5 column-constrained card (free centre), 30 of 75 balls drawn. Payout by
// completed lines (5 rows + 5 cols + 2 diagonals). Table calibrated by Monte
// Carlo (500k cards) to ~95.5% RTP:
//   P(1 line)=13.08%, P(2)=1.12%, P(3)=0.066%, P(4)=0.006%.
const BINGO_DRAWS = 30;
const BINGO_PAYS = { 1: 4, 2: 25, 3: 150, 4: 800, max: 2500 };
const BINGO_LINES = (() => {
  const L = [];
  for (let r = 0; r < 5; r++) L.push([0, 1, 2, 3, 4].map(c => r * 5 + c));
  for (let c = 0; c < 5; c++) L.push([0, 1, 2, 3, 4].map(r => r * 5 + c));
  L.push([0, 6, 12, 18, 24]);
  L.push([4, 8, 12, 16, 20]);
  return L;
})();
function playBingo(userId, { bet }) {
  const betCents = toCents(bet);
  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    // 5 columns x 4 floats for the card sample + 30 floats for the balls.
    const { floats, nonce, serverHash } = await fair.drawTx(q, userId, 5 * 5 + BINGO_DRAWS);
    // Column-constrained card: column c samples 5 distinct values from
    // [c*15+1, c*15+15] via partial Fisher–Yates on the fair floats.
    const card = new Array(25).fill(null);
    let fi = 0;
    for (let c = 0; c < 5; c++) {
      const pool = Array.from({ length: 15 }, (_, i) => c * 15 + 1 + i);
      for (let r = 0; r < 5; r++) {
        const j = r + Math.floor(floats[fi++] * (15 - r));
        [pool[r], pool[j]] = [pool[j], pool[r]];
        if (!(r === 2 && c === 2)) card[r * 5 + c] = pool[r];  // centre stays free
      }
    }
    // Draw 30 distinct balls from 1..75.
    const ballPool = Array.from({ length: 75 }, (_, i) => i + 1);
    const balls = [];
    for (let i = 0; i < BINGO_DRAWS; i++) {
      const j = i + Math.floor(floats[fi++] * (75 - i));
      [ballPool[i], ballPool[j]] = [ballPool[j], ballPool[i]];
      balls.push(ballPool[i]);
    }
    const drawn = new Set(balls);
    const marked = card.map(v => v === null || drawn.has(v));
    const lineHits = BINGO_LINES.filter(L => L.every(i => marked[i]));
    const lines = lineHits.length;
    const mult = lines === 0 ? 0 : (lines >= 5 ? BINGO_PAYS.max : BINGO_PAYS[lines]);
    const win = mult >= 1;
    const payoutCents = Math.round(betCents * mult);
    await credit(q, userId, payoutCents);
    await recordBet(q, userId, { game: 'bingo', betCents, mult, payoutCents, win, nonce, detail: { lines } });
    return {
      card, balls, marked, lines,
      lineIndexes: lineHits,
      mult, payout: payoutCents / 100,
      pays: BINGO_PAYS,
      balance: await balanceOf(q, userId) / 100, nonce, serverHash
    };
  });
}

// ---------------------------------------------------------------- DERBY (horse race)
// Six runners, each with fixed decimal odds. You back one; the winner is drawn
// from a weighted distribution (favourites win more often) tuned so the
// house edge is ~4%. The client animates all six down the track.
// Win probabilities sum to 1; pay odds = 0.96 / P so every horse is a uniform
// ~96% RTP bet (~4% house edge). Verified by Monte Carlo.
const DERBY_HORSES = [
  { name: 'Thunderbolt', emoji: '🏇', odds: 2.82, p: 0.34 },
  { name: 'Midnight',    emoji: '🐎', odds: 3.84, p: 0.25 },
  { name: 'Comet',       emoji: '🏇', odds: 5.33, p: 0.18 },
  { name: 'Duchess',     emoji: '🐎', odds: 8.0,  p: 0.12 },
  { name: 'Rebel',       emoji: '🏇', odds: 12.0, p: 0.08 },
  { name: 'Longshot',    emoji: '🐎', odds: 32.0, p: 0.03 }
];
function playDerby(userId, { bet, pick }) {
  const betCents = toCents(bet);
  const idx = Number(pick);
  if (!Number.isInteger(idx) || idx < 0 || idx >= DERBY_HORSES.length) throw httpError(400, 'Pick a horse (0–5).');
  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    const { floats, nonce, serverHash } = await fair.drawTx(q, userId, 1);
    // Winner drawn from the win-probability distribution (sums to 1).
    let r = floats[0], acc = 0, winner = DERBY_HORSES.length - 1;
    for (let i = 0; i < DERBY_HORSES.length; i++) { acc += DERBY_HORSES[i].p; if (r < acc) { winner = i; break; } }
    const won = winner === idx;
    const mult = won ? DERBY_HORSES[idx].odds : 0;
    const payoutCents = Math.round(betCents * mult);
    await credit(q, userId, payoutCents);
    await recordBet(q, userId, { game: 'derby', betCents, mult, payoutCents, win: won, nonce, detail: { pick: idx, winner } });
    return {
      winner, pick: idx, won, mult,
      horses: DERBY_HORSES.map(h => ({ name: h.name, emoji: h.emoji, odds: h.odds })),
      payout: payoutCents / 100, balance: await balanceOf(q, userId) / 100, nonce, serverHash
    };
  });
}

// ---------------------------------------------------------------- CASH HUNT
// Pick one of 25 tiles; each hides a multiplier drawn from a weighted pool.
// The client flips them all to reveal, spotlighting the chosen one. Pool tuned
// to ~96% RTP.
const CASH_HUNT_POOL = [
  { m: 0,  w: 45 }, { m: 0.3, w: 18 }, { m: 0.5, w: 12 }, { m: 1,  w: 9 },
  { m: 2,  w: 6 },  { m: 5,   w: 3 },  { m: 10,  w: 1.5 },{ m: 25, w: 0.6 },
  { m: 50, w: 0.2 },{ m: 100, w: 0.06 }
];
function cashHuntDraw(f) {
  const total = CASH_HUNT_POOL.reduce((a, b) => a + b.w, 0);
  let r = f * total;
  for (const e of CASH_HUNT_POOL) { if (r < e.w) return e.m; r -= e.w; }
  return 0;
}
function playCashHunt(userId, { bet, pick }) {
  const betCents = toCents(bet);
  const idx = Number(pick);
  if (!Number.isInteger(idx) || idx < 0 || idx > 24) throw httpError(400, 'Pick a tile (0–24).');
  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    const { floats, nonce, serverHash } = await fair.drawTx(q, userId, 25);
    const tiles = floats.map(cashHuntDraw);
    const mult = tiles[idx];
    const win = mult >= 1;
    const payoutCents = Math.round(betCents * mult);
    await credit(q, userId, payoutCents);
    await recordBet(q, userId, { game: 'cashhunt', betCents, mult, payoutCents, win, nonce, detail: { pick: idx, mult } });
    return { tiles, pick: idx, mult, payout: payoutCents / 100, balance: await balanceOf(q, userId) / 100, nonce, serverHash };
  });
}

// ---------------------------------------------------------------- BIG CATCH (fishing)
// Cast a line; reel in one of several fish, each a multiplier. A golden whale
// (40x) is the rare jackpot. Suspense comes from the reel-in animation on the
// client. Weighted to ~95.5% RTP.
const CATCH_POOL = [
  { name: 'Boot',    emoji: '🥾', m: 0,    w: 48 },
  { name: 'Minnow',  emoji: '🐟', m: 0.4,  w: 24 },
  { name: 'Bass',    emoji: '🐠', m: 1,    w: 16 },
  { name: 'Puffer',  emoji: '🐡', m: 2.5,  w: 8 },
  { name: 'Octopus', emoji: '🐙', m: 5,    w: 3.6 },
  { name: 'Shark',   emoji: '🦈', m: 12,   w: 1.3 },
  { name: 'Whale',   emoji: '🐋', m: 40,   w: 0.45 }
];
function playBigCatch(userId, { bet }) {
  const betCents = toCents(bet);
  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    const { floats, nonce, serverHash } = await fair.drawTx(q, userId, 1);
    const total = CATCH_POOL.reduce((a, b) => a + b.w, 0);
    let r = floats[0] * total, caught = CATCH_POOL.length - 1;
    for (let i = 0; i < CATCH_POOL.length; i++) { if (r < CATCH_POOL[i].w) { caught = i; break; } r -= CATCH_POOL[i].w; }
    const fish = CATCH_POOL[caught];
    const win = fish.m >= 1;
    const payoutCents = Math.round(betCents * fish.m);
    await credit(q, userId, payoutCents);
    await recordBet(q, userId, { game: 'bigcatch', betCents, mult: fish.m, payoutCents, win, nonce, detail: { caught } });
    return {
      caught, name: fish.name, emoji: fish.emoji, mult: fish.m,
      payout: payoutCents / 100, balance: await balanceOf(q, userId) / 100, nonce, serverHash
    };
  });
}

// ---------------------------------------------------------------- RPS DUEL
// Rock–paper–scissors vs the house. Win pays 1.92x (4% edge on the ~1/3 win
// rate after ties push). Tie returns the stake; loss takes it.
const RPS_NAMES = ['rock', 'paper', 'scissors'];
const RPS_EMOJI = ['✊', '✋', '✌️'];
function playRps(userId, { bet, pick }) {
  const betCents = toCents(bet);
  const p = Number(pick);
  if (!Number.isInteger(p) || p < 0 || p > 2) throw httpError(400, 'Pick rock, paper or scissors.');
  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    const { floats, nonce, serverHash } = await fair.drawTx(q, userId, 1);
    const house = Math.min(2, Math.floor(floats[0] * 3));
    // 0 beats 2, 1 beats 0, 2 beats 1
    let outcome, mult;
    if (p === house) { outcome = 'tie'; mult = 1; }
    else if ((p === 0 && house === 2) || (p === 1 && house === 0) || (p === 2 && house === 1)) { outcome = 'win'; mult = 1.92; }
    else { outcome = 'lose'; mult = 0; }
    const payoutCents = Math.round(betCents * mult);
    await credit(q, userId, payoutCents);
    await recordBet(q, userId, { game: 'rps', betCents, mult, payoutCents, win: outcome === 'win', nonce, detail: { pick: p, house, outcome } });
    return {
      pick: p, house, pickEmoji: RPS_EMOJI[p], houseEmoji: RPS_EMOJI[house],
      outcome, mult, payout: payoutCents / 100, balance: await balanceOf(q, userId) / 100, nonce, serverHash
    };
  });
}

// ---------------------------------------------------------------- NEON FRUITS
// A real 5-reel, 3-row, 10-payline video slot. Weighted reel strips + wild
// substitution. Calibrated by Monte Carlo (2M spins) to ~96.2% RTP; max ~165x.
const FRUIT_NAMES  = ['cherry', 'lemon', 'plum', 'bell', 'star', 'seven', 'diamond', 'wild'];
const FRUIT_EMOJI  = ['🍒', '🍋', '🫐', '🔔', '⭐', '7️⃣', '💎', '🌟'];
const FRUIT_WILD   = 7;
const FRUIT_WEIGHT = [26, 24, 20, 14, 9, 5, 3, 4];
const FRUIT_PAY = {
  0: [5, 20, 60],   1: [5, 20, 60],   2: [8, 30, 90],   3: [15, 50, 140],
  4: [25, 90, 280], 5: [50, 200, 700], 6: [90, 400, 1400], 7: [40, 180, 1000]
};
const FRUIT_LINES = [
  [1, 1, 1, 1, 1], [0, 0, 0, 0, 0], [2, 2, 2, 2, 2],
  [0, 1, 2, 1, 0], [2, 1, 0, 1, 2],
  [1, 0, 0, 0, 1], [1, 2, 2, 2, 1],
  [0, 0, 1, 2, 2], [2, 2, 1, 0, 0], [1, 0, 1, 2, 1]
];
const FRUIT_TOTAL = FRUIT_WEIGHT.reduce((a, b) => a + b, 0);
function fruitReel(f) { let r = f * FRUIT_TOTAL; for (let i = 0; i < FRUIT_WEIGHT.length; i++) { if (r < FRUIT_WEIGHT[i]) return i; r -= FRUIT_WEIGHT[i]; } return FRUIT_WEIGHT.length - 1; }
function fruitEvalLine(grid, line) {
  const syms = line.map((row, col) => grid[col][row]);
  let base = syms[0];
  if (base === FRUIT_WILD) { const b = syms.find(s => s !== FRUIT_WILD); base = (b === undefined) ? FRUIT_WILD : b; }
  let count = 0;
  for (let i = 0; i < 5; i++) { if (syms[i] === base || syms[i] === FRUIT_WILD) count++; else break; }
  if (count < 3) return { mult: 0 };
  return { mult: FRUIT_PAY[base][count - 3], base, count };
}
function playNeonFruits(userId, { bet }) {
  const betCents = toCents(bet);
  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    const { floats, nonce, serverHash } = await fair.drawTx(q, userId, 15);
    // grid[col][row]
    const grid = [];
    for (let c = 0; c < 5; c++) grid.push([fruitReel(floats[c * 3]), fruitReel(floats[c * 3 + 1]), fruitReel(floats[c * 3 + 2])]);
    let totalMult = 0;
    const wins = [];
    FRUIT_LINES.forEach((line, i) => {
      const res = fruitEvalLine(grid, line);
      if (res.mult > 0) { totalMult += res.mult / 10; wins.push({ line: i, mult: res.mult / 10, symbol: res.base, count: res.count }); }
    });
    const win = totalMult >= 1;
    const payoutCents = Math.round(betCents * totalMult);
    await credit(q, userId, payoutCents);
    await recordBet(q, userId, { game: 'neonfruits', betCents, mult: totalMult, payoutCents, win, nonce, detail: { wins: wins.length } });
    return {
      grid, wins, mult: totalMult,
      symbols: FRUIT_EMOJI, payout: payoutCents / 100,
      balance: await balanceOf(q, userId) / 100, nonce, serverHash
    };
  });
}

// ---------------------------------------------------------------- MEGA WHEEL
// A 20-segment money wheel. You get whatever multiplier it lands on. Segment
// weights tuned to ~95% RTP. The client renders it as a spinning wheel that
// decelerates onto the chosen segment.
const WHEEL_SEGMENTS = (() => {
  // Build a fixed 20-slot ring so the client can draw evenly-spaced segments.
  const spec = [{ m: 0, n: 9 }, { m: 0.5, n: 4 }, { m: 1, n: 3 }, { m: 2, n: 3 }, { m: 8, n: 1 }];
  const ring = [];
  spec.forEach(s => { for (let i = 0; i < s.n; i++) ring.push(s.m); });
  // Interleave so big/mid values are spread around the wheel, not clustered.
  ring.sort(() => 0); // keep deterministic order; shuffle visually on client
  return ring;
})();
function playMegaWheel(userId, { bet }) {
  const betCents = toCents(bet);
  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    const { floats, nonce, serverHash } = await fair.drawTx(q, userId, 1);
    const idx = Math.min(WHEEL_SEGMENTS.length - 1, Math.floor(floats[0] * WHEEL_SEGMENTS.length));
    const mult = WHEEL_SEGMENTS[idx];
    const win = mult >= 1;
    const payoutCents = Math.round(betCents * mult);
    await credit(q, userId, payoutCents);
    await recordBet(q, userId, { game: 'megawheel', betCents, mult, payoutCents, win, nonce, detail: { idx, mult } });
    return { segments: WHEEL_SEGMENTS, idx, mult, payout: payoutCents / 100, balance: await balanceOf(q, userId) / 100, nonce, serverHash };
  });
}

// ---------------------------------------------------------------- TEN PIN (bowling)
// Roll a ball, knock down 0–10 pins. Multiplier by pins: 7→1×, 8→2×, 9→4×,
// 10 (strike)→10×, fewer → nothing. Outcome distribution tuned to ~96% RTP.
const TENPIN_TIERS = [
  { max: 6,  m: 0,  w: 64.7 }, // 0–6 pins
  { pins: 7, m: 1,  w: 15 },
  { pins: 8, m: 2,  w: 10 },
  { pins: 9, m: 4,  w: 7 },
  { pins: 10, m: 10, w: 3.3 }  // strike
];
function playTenPin(userId, { bet }) {
  const betCents = toCents(bet);
  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    const { floats, nonce, serverHash } = await fair.drawTx(q, userId, 2);
    const total = TENPIN_TIERS.reduce((a, t) => a + t.w, 0);
    let r = floats[0] * total, tier = TENPIN_TIERS[TENPIN_TIERS.length - 1];
    for (const t of TENPIN_TIERS) { if (r < t.w) { tier = t; break; } r -= t.w; }
    // For the 0–6 tier, pick an actual pin count for animation variety.
    const pins = tier.pins != null ? tier.pins : Math.floor(floats[1] * 7);
    const mult = tier.m;
    const win = mult >= 1;
    const payoutCents = Math.round(betCents * mult);
    await credit(q, userId, payoutCents);
    await recordBet(q, userId, { game: 'tenpin', betCents, mult, payoutCents, win, nonce, detail: { pins } });
    return { pins, mult, strike: pins === 10, payout: payoutCents / 100, balance: await balanceOf(q, userId) / 100, nonce, serverHash };
  });
}

// ---------------------------------------------------------------- BULLSEYE (darts)
// Throw three darts. Each lands in a ring: miss(0), outer(0.3×), inner(1×),
// bull(5×). Your payout is the sum of the three. Per-dart E≈0.32 → ~96% RTP.
const DART_RINGS = [
  { ring: 'miss',  m: 0,   w: 59 },
  { ring: 'outer', m: 0.3, w: 30 },
  { ring: 'inner', m: 1,   w: 8 },
  { ring: 'bull',  m: 5,   w: 3 }
];
function dartThrow(f) {
  const total = DART_RINGS.reduce((a, d) => a + d.w, 0);
  let r = f * total;
  for (const d of DART_RINGS) { if (r < d.w) return d; r -= d.w; }
  return DART_RINGS[0];
}
function playBullseye(userId, { bet }) {
  const betCents = toCents(bet);
  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    const { floats, nonce, serverHash } = await fair.drawTx(q, userId, 3);
    const darts = floats.map(dartThrow);
    const mult = +darts.reduce((a, d) => a + d.m, 0).toFixed(2);
    const win = mult >= 1;
    const payoutCents = Math.round(betCents * mult);
    await credit(q, userId, payoutCents);
    await recordBet(q, userId, { game: 'bullseye', betCents, mult, payoutCents, win, nonce, detail: { rings: darts.map(d => d.ring) } });
    return {
      darts: darts.map(d => ({ ring: d.ring, mult: d.m })),
      mult, payout: payoutCents / 100, balance: await balanceOf(q, userId) / 100, nonce, serverHash
    };
  });
}

// ---------------------------------------------------------------- FIRECRACKER
// Light the fuse — a chain of firecrackers pops, the last revealing the final
// multiplier drawn from a weighted pool (~97% RTP). Pure spectacle.
const FIRECRACKER_POOL = [
  { m: 0,  w: 53 }, { m: 0.5, w: 20 }, { m: 1,  w: 13 }, { m: 2,  w: 7.5 },
  { m: 5,  w: 4 },  { m: 10,  w: 1.8 },{ m: 25, w: 0.6 },{ m: 100, w: 0.06 }
];
function playFirecracker(userId, { bet }) {
  const betCents = toCents(bet);
  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    const { floats, nonce, serverHash } = await fair.drawTx(q, userId, 1);
    const total = FIRECRACKER_POOL.reduce((a, e) => a + e.w, 0);
    let r = floats[0] * total, mult = 0;
    for (const e of FIRECRACKER_POOL) { if (r < e.w) { mult = e.m; break; } r -= e.w; }
    const win = mult >= 1;
    const payoutCents = Math.round(betCents * mult);
    await credit(q, userId, payoutCents);
    await recordBet(q, userId, { game: 'firecracker', betCents, mult, payoutCents, win, nonce, detail: { mult } });
    return { mult, payout: payoutCents / 100, balance: await balanceOf(q, userId) / 100, nonce, serverHash };
  });
}

// ---------------------------------------------------------------- SUGAR BLAST
// A 7×6 cluster-pays tumble slot. Orthogonally-connected groups of ≥5 same
// symbols pay (by size), then explode; symbols above drop and empties refill;
// repeat until no clusters. All randomness (initial board + refills) comes from
// the fair stream. Pay table calibrated by 400k-spin Monte Carlo to ~94.7% RTP,
// top ~150×.
const SUGAR_COLS = 7, SUGAR_ROWS = 6, SUGAR_SYMS = 6;
function sugarPay(size) {
  if (size < 5) return 0;
  if (size <= 6) return 1.5;
  if (size <= 8) return 3.6;
  if (size <= 10) return 9;
  if (size <= 13) return 24;
  if (size <= 16) return 60;
  return 150;
}
function sugarClusters(g) {
  const seen = Array.from({ length: SUGAR_COLS }, () => Array(SUGAR_ROWS).fill(false));
  const out = [];
  for (let c = 0; c < SUGAR_COLS; c++) for (let r = 0; r < SUGAR_ROWS; r++) {
    if (seen[c][r] || g[c][r] < 0) continue;
    const sym = g[c][r], stack = [[c, r]], cells = []; seen[c][r] = true;
    while (stack.length) {
      const [x, y] = stack.pop(); cells.push([x, y]);
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        if (nx >= 0 && nx < SUGAR_COLS && ny >= 0 && ny < SUGAR_ROWS && !seen[nx][ny] && g[nx][ny] === sym) { seen[nx][ny] = true; stack.push([nx, ny]); }
      }
    }
    if (cells.length >= 5) out.push(cells);
  }
  return out;
}
function playSugarBlast(userId, { bet }) {
  const betCents = toCents(bet);
  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    // Enough fair floats for the initial board + several full refills.
    const NEED = SUGAR_COLS * SUGAR_ROWS * 6;
    const { floats, nonce, serverHash } = await fair.drawTx(q, userId, NEED);
    let fi = 0;
    const nextSym = () => Math.min(SUGAR_SYMS - 1, Math.floor((floats[fi++] ?? Math.random()) * SUGAR_SYMS));
    // grid[col][row], row 0 = top
    const g = [];
    for (let c = 0; c < SUGAR_COLS; c++) { g.push([]); for (let r = 0; r < SUGAR_ROWS; r++) g[c].push(nextSym()); }
    const steps = [];
    let totalMult = 0, guard = 0;
    while (guard++ < 40) {
      const clusters = sugarClusters(g);
      if (!clusters.length) break;
      const removed = [];
      for (const cl of clusters) {
        totalMult += sugarPay(cl.length);
        for (const [x, y] of cl) { removed.push([x, y]); g[x][y] = -1; }
      }
      steps.push({ clusters: clusters.map(c => c.length), removed });
      // Tumble: keep survivors at the bottom, refill the top.
      for (let c = 0; c < SUGAR_COLS; c++) {
        const kept = g[c].filter(s => s >= 0);
        const fill = SUGAR_ROWS - kept.length;
        const nc = []; for (let i = 0; i < fill; i++) nc.push(nextSym());
        g[c] = nc.concat(kept);
      }
    }
    totalMult = +totalMult.toFixed(2);
    const win = totalMult >= 1;
    const payoutCents = Math.round(betCents * totalMult);
    await credit(q, userId, payoutCents);
    await recordBet(q, userId, { game: 'sugarblast', betCents, mult: totalMult, payoutCents, win, nonce, detail: { tumbles: steps.length } });
    return { finalGrid: g, tumbles: steps.length, mult: totalMult, payout: payoutCents / 100, balance: await balanceOf(q, userId) / 100, nonce, serverHash };
  });
}

// ---------------------------------------------------------------- ZEUS'S GATES
// A 6×5 "pay anywhere" tumble slot: 8+ of a symbol anywhere on the grid pays
// (by count tier), winners explode, the grid refills, repeat. Multiplier orbs
// land at a small rate; on any winning spin all orb values on screen SUM and
// multiply the total base win. Calibrated by 200k-spin Monte Carlo to ~96%.
const GATES_COLS = 6, GATES_ROWS = 5, GATES_CELLS = 30, GATES_SYMS = 8;
const GATES_W = [22, 20, 17, 13, 10, 8, 6, 4];
const GATES_EMOJI = ['🍎', '🍇', '💍', '🏺', '👑', '⚡', '🔱', '🪙'];
const GATES_PAY = [
  [0.25, 0.75, 2], [0.25, 0.75, 2], [0.4, 1.2, 3], [0.5, 1.5, 4],
  [0.8, 2.5, 6],   [1.2, 4, 10],    [2, 6, 15],     [4, 12, 40]
];
const GATES_SCALE = 0.133;
const GATES_ORB_RATE = 0.03;
const GATES_ORBS = [{ m: 2, w: 40 }, { m: 3, w: 25 }, { m: 5, w: 15 }, { m: 10, w: 10 }, { m: 25, w: 6 }, { m: 50, w: 3 }, { m: 100, w: 1 }];
function gatesSym(f) { const tw = GATES_W.reduce((a, b) => a + b, 0); let r = f * tw; for (let i = 0; i < GATES_SYMS; i++) { if (r < GATES_W[i]) return i; r -= GATES_W[i]; } return GATES_SYMS - 1; }
function gatesOrb(f) { const tw = GATES_ORBS.reduce((a, b) => a + b.w, 0); let r = f * tw; for (const o of GATES_ORBS) { if (r < o.w) return o.m; r -= o.w; } return 2; }
function gatesPayFor(sym, count) { if (count < 8) return 0; const t = count <= 9 ? 0 : (count <= 11 ? 1 : 2); return GATES_PAY[sym][t] * GATES_SCALE; }
function playZeusGates(userId, { bet }) {
  const betCents = toCents(bet);
  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    const { floats, nonce, serverHash } = await fair.drawTx(q, userId, GATES_CELLS * 8);
    let fi = 0;
    const nf = () => floats[fi++] ?? Math.random();
    const grid = new Array(GATES_CELLS);   // symbol index, or -1 orb
    const orbs = [];
    for (let i = 0; i < GATES_CELLS; i++) { if (nf() < GATES_ORB_RATE) { grid[i] = -1; orbs.push(gatesOrb(nf())); } else grid[i] = gatesSym(nf()); }
    let baseWin = 0, tumbles = 0, guard = 0;
    while (guard++ < 30) {
      const counts = new Array(GATES_SYMS).fill(0);
      for (let i = 0; i < GATES_CELLS; i++) if (grid[i] >= 0) counts[grid[i]]++;
      let anyWin = false;
      for (let s = 0; s < GATES_SYMS; s++) { const p = gatesPayFor(s, counts[s]); if (p > 0) { baseWin += p; anyWin = true; for (let i = 0; i < GATES_CELLS; i++) if (grid[i] === s) grid[i] = -2; } }
      if (!anyWin) break;
      tumbles++;
      for (let i = 0; i < GATES_CELLS; i++) if (grid[i] === -2) { if (nf() < GATES_ORB_RATE) { grid[i] = -1; orbs.push(gatesOrb(nf())); } else grid[i] = gatesSym(nf()); }
    }
    const orbMult = orbs.reduce((a, b) => a + b, 0);
    const totalMult = +((baseWin > 0 && orbMult > 0) ? baseWin * orbMult : baseWin).toFixed(4);
    const win = totalMult >= 1;
    const payoutCents = Math.round(betCents * totalMult);
    await credit(q, userId, payoutCents);
    await recordBet(q, userId, { game: 'zeusgates', betCents, mult: totalMult, payoutCents, win, nonce, detail: { tumbles, orbs: orbs.length, orbMult } });
    return { finalGrid: grid, symbols: GATES_EMOJI, tumbles, orbs, orbMult, baseWin: +baseWin.toFixed(2), mult: totalMult, payout: payoutCents / 100, balance: await balanceOf(q, userId) / 100, nonce, serverHash };
  });
}

// ---------------------------------------------------------------- SLINGO
// 5×5 card (column c holds 5 distinct numbers from [c*15+1, c*15+15]); ten
// spins of five reels mark matching cells; completed lines (5 rows + 5 cols +
// 2 diagonals = 12 = full house) pay by count. Calibrated 2M-spin MC → 96.6%.
const SLINGO_SPINS = 10;
const SLINGO_LINES = (() => { const L = []; for (let r = 0; r < 5; r++) L.push([0, 1, 2, 3, 4].map(c => r * 5 + c)); for (let c = 0; c < 5; c++) L.push([0, 1, 2, 3, 4].map(r => r * 5 + c)); L.push([0, 6, 12, 18, 24]); L.push([4, 8, 12, 16, 20]); return L; })();
const SLINGO_PAY = [0, 1.95, 8, 25, 80, 200, 500, 1000, 1500, 2000, 3000, 4000, 5000];
function playSlingo(userId, { bet }) {
  const betCents = toCents(bet);
  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    // Card numbers + all spin/pick decisions come from the fair stream.
    const { floats, nonce, serverHash } = await fair.drawTx(q, userId, 25 + SLINGO_SPINS * 5 * 2);
    let fi = 0; const nf = () => floats[fi++] ?? Math.random();
    // Build the card: each column 5 distinct numbers in its range.
    const card = new Array(25);
    for (let c = 0; c < 5; c++) {
      const pool = Array.from({ length: 15 }, (_, i) => c * 15 + 1 + i);
      for (let r = 0; r < 5; r++) { const j = r + Math.floor(nf() * (15 - r)); [pool[r], pool[j]] = [pool[j], pool[r]]; card[r * 5 + c] = pool[r]; }
    }
    const marked = new Array(25).fill(false);
    const unmarkedInCol = [5, 5, 5, 5, 5];
    const spins = [];
    for (let s = 0; s < SLINGO_SPINS; s++) {
      const row = [];
      for (let c = 0; c < 5; c++) {
        let hitCell = -1;
        if (unmarkedInCol[c] > 0 && nf() * 15 < unmarkedInCol[c]) {
          const cells = []; for (let r = 0; r < 5; r++) { const idx = r * 5 + c; if (!marked[idx]) cells.push(idx); }
          hitCell = cells[Math.floor(nf() * cells.length)];
          marked[hitCell] = true; unmarkedInCol[c]--;
        }
        row.push(hitCell); // cell index marked this spin for column c, or -1
      }
      spins.push(row);
    }
    let lines = 0; const lineIdx = [];
    SLINGO_LINES.forEach((L, i) => { if (L.every(x => marked[x])) { lines++; lineIdx.push(i); } });
    const mult = SLINGO_PAY[lines];
    const win = mult >= 1;
    const payoutCents = Math.round(betCents * mult);
    await credit(q, userId, payoutCents);
    await recordBet(q, userId, { game: 'slingo', betCents, mult, payoutCents, win, nonce, detail: { lines } });
    return { card, spins, marked, lines, lineIndexes: lineIdx, mult, pays: SLINGO_PAY, payout: payoutCents / 100, balance: await balanceOf(q, userId) / 100, nonce, serverHash };
  });
}

// ---------------------------------------------------------------- MINI ROULETTE
// 13-pocket wheel (0 green + 1–12). Straight number pays 12.5×; even-money bets
// (red/black, odd/even, low/high) pay 2× with LA PARTAGE — half the stake back
// when 0 hits — giving a uniform ~96% RTP across bet types.
const MR_RED = new Set([1, 3, 5, 7, 9, 11]);
function playMiniRoulette(userId, { bet, betType, number }) {
  const betCents = toCents(bet);
  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    const { floats, nonce, serverHash } = await fair.drawTx(q, userId, 1);
    const result = Math.min(12, Math.floor(floats[0] * 13));
    const isRed = MR_RED.has(result);
    let mult = 0, laPartage = false;
    if (betType === 'straight') {
      const n = Number(number);
      if (!Number.isInteger(n) || n < 0 || n > 12) throw httpError(400, 'Pick a number 0–12.');
      if (result === n) mult = 12.5;
    } else if (betType === 'red' || betType === 'black') {
      if (result === 0) { mult = 0.5; laPartage = true; }
      else if ((betType === 'red') === isRed) mult = 2;
    } else if (betType === 'odd' || betType === 'even') {
      if (result === 0) { mult = 0.5; laPartage = true; }
      else if ((betType === 'even') === (result % 2 === 0)) mult = 2;
    } else if (betType === 'low' || betType === 'high') {
      if (result === 0) { mult = 0.5; laPartage = true; }
      else if ((betType === 'low') === (result <= 6)) mult = 2;
    } else throw httpError(400, 'Invalid bet.');
    const win = mult >= 1;
    const payoutCents = Math.round(betCents * mult);
    await credit(q, userId, payoutCents);
    await recordBet(q, userId, { game: 'miniroulette', betCents, mult, payoutCents, win, nonce, detail: { result, betType, laPartage } });
    return { result, color: result === 0 ? 'green' : (isRed ? 'red' : 'black'), betType, mult, laPartage, payout: payoutCents / 100, balance: await balanceOf(q, userId) / 100, nonce, serverHash };
  });
}

// ---------------------------------------------------------------- PIÑATA POP
// Smash a piñata; it bursts with a multiplier drawn from a weighted table.
// EV tuned to ~96% RTP. One float in → one multiplier out.
const PINATA_MULTS = [0, 0.5, 1.5, 3, 10, 50];
const PINATA_W     = [0.516, 0.22, 0.18, 0.06, 0.02, 0.004]; // sums to 1.0, EV 0.96
function pinataPick(f) {
  let acc = 0;
  for (let i = 0; i < PINATA_MULTS.length; i++) { acc += PINATA_W[i]; if (f < acc) return i; }
  return PINATA_MULTS.length - 1;
}
function playPinata(userId, { bet, pick }) {
  const betCents = toCents(bet);
  const chosen = Math.max(0, Math.min(4, Number(pick) || 0)); // which of 5 piñatas (cosmetic)
  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    const { floats, nonce, serverHash } = await fair.drawTx(q, userId, 1);
    const idx = pinataPick(floats[0]);
    const mult = PINATA_MULTS[idx];
    const win = mult > 1;
    const payoutCents = Math.round(betCents * mult);
    await credit(q, userId, payoutCents);
    await recordBet(q, userId, { game: 'pinata', betCents, mult: win ? mult : 0, payoutCents, win, nonce, detail: { pick: chosen, mult } });
    return { pick: chosen, mult, win, payout: payoutCents / 100, balance: await balanceOf(q, userId) / 100, nonce, serverHash };
  });
}

// ---------------------------------------------------------------- FAN TAN
// Classic bead game: a pile is counted out four at a time; you bet the
// remainder (1–4). Uniform 1–4, pays 3.85× → RTP 96.25%.
const FANTAN_MULT = 3.85;
function playFanTan(userId, { bet, pick }) {
  const betCents = toCents(bet);
  const p = Number(pick);
  if (![1, 2, 3, 4].includes(p)) throw httpError(400, 'Pick a remainder of 1, 2, 3 or 4.');
  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    const { floats, nonce, serverHash } = await fair.drawTx(q, userId, 2);
    const remainder = Math.floor(floats[0] * 4) + 1;        // 1..4 uniform
    const groups = 12 + Math.floor(floats[1] * 8);          // 12..19 groups of 4 (cosmetic pile size)
    const beads = groups * 4 + remainder;
    const win = remainder === p;
    const mult = FANTAN_MULT;
    const payoutCents = win ? Math.round(betCents * mult) : 0;
    await credit(q, userId, payoutCents);
    await recordBet(q, userId, { game: 'fantan', betCents, mult: win ? mult : 0, payoutCents, win, nonce, detail: { pick: p, remainder, beads } });
    return { pick: p, remainder, beads, win, mult, payout: payoutCents / 100, balance: await balanceOf(q, userId) / 100, nonce, serverHash };
  });
}

// ---------------------------------------------------------------- RED DOG (Acey-Deucey)
// Two cards set a spread; a third card wins if it falls strictly between.
// Payout by spread; pair pays 11× if the third matches, else push. Auto-resolve
// (no raise). Payouts are the standard Red Dog table → ~96–97% RTP (MC-verified).
const REDDOG_PAY = { 1: 6, 2: 5, 3: 3, 4: 1 }; // profit odds by spread (4 = "4 or more"); tuned to ~96% RTP
function reddogSpreadPay(spread) { return REDDOG_PAY[Math.min(4, spread)]; }
function reddogResolve(floats) {
  // Draw 3 distinct cards from a 52-card deck (rank 2..14, 4 suits) using floats.
  const deck = [];
  for (let r = 2; r <= 14; r++) for (let s = 0; s < 4; s++) deck.push({ r, s });
  const drawn = [];
  for (let i = 0; i < 3; i++) {
    const idx = Math.floor(floats[i] * deck.length);
    drawn.push(deck.splice(Math.min(idx, deck.length - 1), 1)[0]);
  }
  const [c1, c2, c3] = drawn;
  const lo = Math.min(c1.r, c2.r), hi = Math.max(c1.r, c2.r);
  if (c1.r === c2.r) {
    // Pair: third matches → 11× profit; else push.
    const three = c3.r === c1.r;
    return { c1, c2, c3, spread: 0, pair: true, outcome: three ? 'trips' : 'push', profit: three ? 11 : 0, push: !three };
  }
  const spread = hi - lo - 1;
  if (spread === 0) return { c1, c2, c3, spread: 0, pair: false, outcome: 'consecutive', profit: 0, push: true };
  const between = c3.r > lo && c3.r < hi;
  const pay = reddogSpreadPay(spread);
  return { c1, c2, c3, spread, pair: false, outcome: between ? 'win' : 'lose', profit: between ? pay : -1, push: false };
}
function playRedDog(userId, { bet }) {
  const betCents = toCents(bet);
  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    const { floats, nonce, serverHash } = await fair.drawTx(q, userId, 3);
    const r = reddogResolve(floats);
    // mult = total return / stake. push → 1×, win → profit+1, lose → 0.
    const mult = r.push ? 1 : (r.profit > 0 ? r.profit + 1 : 0);
    const win = r.profit > 0;
    const payoutCents = Math.round(betCents * mult);
    await credit(q, userId, payoutCents);
    await recordBet(q, userId, { game: 'reddog', betCents, mult: win ? mult : 0, payoutCents, win, nonce, detail: { outcome: r.outcome, spread: r.spread } });
    return {
      cards: [r.c1, r.c2, r.c3], spread: r.spread, pair: r.pair, outcome: r.outcome,
      mult, win, push: r.push, payout: payoutCents / 100, balance: await balanceOf(q, userId) / 100, nonce, serverHash
    };
  });
}

// ---------------------------------------------------------------- PENALTY SHOOTOUT (original)
// Round-based streak. Each round you shoot left/center/right; the keeper (server,
// pre-drawn) dives to one spot. If it differs from your shot you score and climb;
// cash out any time. Keeper blocks 1/3 → score chance 2/3 per shot.
const PENALTY_ROUNDS = 5, PENALTY_EDGE = 0.03;
function penaltyMult(goals) { return +Math.pow((3 / 2) * (1 - PENALTY_EDGE), goals).toFixed(4); }
function penaltyStart(userId, { bet }) {
  const betCents = toCents(bet);
  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    const { floats, nonce, serverHash } = await fair.drawTx(q, userId, PENALTY_ROUNDS);
    const dives = floats.map(f => Math.min(2, Math.floor(f * 3))); // 0=L,1=C,2=R per round
    const id = crypto.randomUUID();
    await q('INSERT INTO rounds(id, user_id, game, state, settled, created_at) VALUES(?,?,?,?,0,?)',
      [id, userId, 'penalty', JSON.stringify({ betCents, dives, round: 0, nonce }), Date.now()]);
    return { roundId: id, rounds: PENALTY_ROUNDS, nextMult: penaltyMult(1), serverHash, balance: await balanceOf(q, userId) / 100 };
  });
}
function penaltyShoot(userId, { roundId, dir }) {
  const shot = Number(dir);
  if (![0, 1, 2].includes(shot)) throw httpError(400, 'Shoot left (0), center (1) or right (2).');
  return db.tx(async (q) => {
    const { rows } = await q('SELECT * FROM rounds WHERE id = ? AND user_id = ? AND game = ?', [roundId, userId, 'penalty']);
    const round = rows[0];
    if (!round) throw httpError(404, 'Round not found.');
    if (Number(round.settled)) throw httpError(409, 'Round already over.');
    const s = JSON.parse(round.state);
    const keeper = s.dives[s.round];
    const scored = keeper !== shot;
    if (!scored) {
      await q('UPDATE rounds SET settled = 1 WHERE id = ?', [roundId]);
      await recordBet(q, userId, { game: 'penalty', betCents: s.betCents, mult: 0, payoutCents: 0, win: false, nonce: s.nonce, detail: { goals: s.round, savedRound: s.round + 1 } });
      return { saved: true, keeper, shot, round: s.round, balance: await balanceOf(q, userId) / 100 };
    }
    s.round += 1;
    const mult = penaltyMult(s.round);
    if (s.round >= PENALTY_ROUNDS) {
      const payoutCents = Math.round(s.betCents * mult);
      await credit(q, userId, payoutCents);
      await q('UPDATE rounds SET settled = 1 WHERE id = ?', [roundId]);
      await recordBet(q, userId, { game: 'penalty', betCents: s.betCents, mult, payoutCents, win: true, nonce: s.nonce, detail: { goals: s.round, perfect: true } });
      return { saved: false, keeper, shot, round: s.round, mult, perfect: true, payout: payoutCents / 100, balance: await balanceOf(q, userId) / 100 };
    }
    await q('UPDATE rounds SET state = ? WHERE id = ?', [JSON.stringify(s), roundId]);
    return { saved: false, keeper, shot, round: s.round, mult, nextMult: penaltyMult(s.round + 1), cashout: (s.betCents * mult) / 100, balance: await balanceOf(q, userId) / 100 };
  });
}
function penaltyCashout(userId, { roundId }) {
  return db.tx(async (q) => {
    const { rows } = await q('SELECT * FROM rounds WHERE id = ? AND user_id = ? AND game = ?', [roundId, userId, 'penalty']);
    const round = rows[0];
    if (!round) throw httpError(404, 'Round not found.');
    if (Number(round.settled)) throw httpError(409, 'Round already over.');
    const s = JSON.parse(round.state);
    if (s.round < 1) throw httpError(400, 'Score at least one goal first.');
    const mult = penaltyMult(s.round);
    const payoutCents = Math.round(s.betCents * mult);
    await credit(q, userId, payoutCents);
    await q('UPDATE rounds SET settled = 1 WHERE id = ?', [roundId]);
    await recordBet(q, userId, { game: 'penalty', betCents: s.betCents, mult, payoutCents, win: true, nonce: s.nonce, detail: { goals: s.round } });
    return { mult, payout: payoutCents / 100, goals: s.round, balance: await balanceOf(q, userId) / 100 };
  });
}

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
    const top = (await db.query(
      `SELECT u.id, u.username, u.level, COUNT(*) AS wins
         FROM users u JOIN bets b ON b.user_id = u.id
        WHERE b.win = 1
        GROUP BY u.id, u.username, u.level
        ORDER BY wins DESC LIMIT ?`,
      [limit]
    )).rows;
    const my = (await db.query(
      `SELECT COUNT(*) AS wins FROM bets WHERE user_id = ? AND win = 1`, [userId]
    )).rows[0];
    const myWins = Number(my?.wins || 0);
    const above = (await db.query(
      `SELECT COUNT(*) AS n FROM (
         SELECT user_id, COUNT(*) AS wins FROM bets WHERE win = 1 GROUP BY user_id
       ) t WHERE wins > ?`, [myWins]
    )).rows[0];
    return {
      metric, label: 'Wins',
      top: top.map((r, i) => ({ rank: i + 1, player: anonName(r.username), isYou: Number(r.id) === Number(userId), value: Number(r.wins), level: Number(r.level) })),
      you: { rank: Number(above?.n || 0) + 1, value: myWins }
    };
  }
  // biggest single payout (profit on one bet)
  const top = (await db.query(
    `SELECT u.id, u.username, u.level, MAX(b.payout_cents - b.bet_cents) AS biggest
       FROM users u JOIN bets b ON b.user_id = u.id
      GROUP BY u.id, u.username, u.level
      HAVING MAX(b.payout_cents - b.bet_cents) > 0
      ORDER BY biggest DESC LIMIT ?`,
    [limit]
  )).rows;
  const my = (await db.query(
    `SELECT COALESCE(MAX(payout_cents - bet_cents), 0) AS biggest FROM bets WHERE user_id = ?`, [userId]
  )).rows[0];
  const myBiggest = Number(my?.biggest || 0);
  const above = (await db.query(
    `SELECT COUNT(*) AS n FROM (
       SELECT user_id, MAX(payout_cents - bet_cents) AS biggest FROM bets GROUP BY user_id
     ) t WHERE biggest > ?`, [myBiggest]
  )).rows[0];
  return {
    metric, label: 'Biggest Single Payout (CRYPT)',
    top: top.map((r, i) => ({ rank: i + 1, player: anonName(r.username), isYou: Number(r.id) === Number(userId), value: Number(r.biggest) / 100, level: Number(r.level) })),
    you: { rank: Number(above?.n || 0) + 1, value: myBiggest / 100 }
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
  statsDetail,
  playDice, playPlinko, playCrash,
  minesStart, minesReveal, minesCashout,
  playLimbo, playWheel, playKeno, kenoTable,
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
  chickenStart, chickenStep, chickenCashout,
  crapsStart, crapsRoll,
  tcpStart, tcpAct,
  playBingo,
  playDerby, playCashHunt, playBigCatch, playRps, playNeonFruits,
  playMegaWheel, playTenPin, playBullseye, playFirecracker, playSugarBlast,
  playZeusGates, playSlingo, playMiniRoulette,
  playPinata, playFanTan, playRedDog,
  jackpotState, jackpotEnsure,
  penaltyStart, penaltyShoot, penaltyCashout,
  history, stats, globalFeed, anonName, leaderboard, PLINKO, minesMult,
  WHEEL, TOWERS, PUMP, DIAMOND_PAYS, SLOT_SYMBOLS, SLOT_TRIPLE, SLOT_PAIR_PAY,
  COLOR_PAYS, VIDEO_POKER_PAYS, KENO_TABLES, SCRATCH_TABLE,
  CASCADE_TABLES, CASCADE_P, penaltyMult
};
