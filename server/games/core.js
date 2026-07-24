'use strict';
/* Shared game-engine core: the wager chokepoint (toCents/debit/credit/recordBet),
 * plus the constant tables and math helpers used across games. Split out of the
 * former monolithic games.js — behaviour is byte-for-byte unchanged. */
const progression = require('../progression');
const { httpError } = require('../auth');
const limits = require('../limits');

const HOUSE = 0.01;

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
  // Reject sub-cent stakes that round to 0: debit(0) succeeds for everyone
  // (subtract nothing), so a zero-stake wager would still settle and farm
  // XP / achievements / stats for free. Enforce a real 1-cent minimum here —
  // the shared chokepoint every game's stake passes through.
  const cents = Math.round(n * 100);
  if (cents <= 0) throw httpError(400, 'Bet is too small.');
  return cents;
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


module.exports = {
  HOUSE, PLINKO, WHEEL, TOWERS, TOWERS_ROWS, KENO_N, KENO_DRAW, KENO_EDGE, KENO_TABLES,
  ROULETTE_RED, DIAMOND_PAYS, SLOT_THEMES, SLOT_SYMBOLS, SLOT_PAIR_PAY, SLOT_TRIPLE,
  PUMP, COLOR_MAP, COLOR_PAYS, SCRATCH_TILES, SCRATCH_P, SCRATCH_EDGE, SCRATCH_TABLE,
  VIDEO_POKER_PAYS,
  minesMult, towersStepFactor, towersMult, hiloChances, hiloMults, comb, kenoHitProb,
  buildKenoTable, kenoTable, rouletteColor, diamondCategory, buildSlotTable, pumpMult,
  digitColor, binom, cardFromIndex, drawDistinctCards, isFlush, isStraight, evalVideoPoker,
  handTotal, toCents, debit, credit, balanceOf, recordBet
};
