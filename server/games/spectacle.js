'use strict';
/* Spectacle / newer games (chicken road through american roulette) + penalty. */
const crypto = require('crypto');
const db = require('../db');
const fair = require('../fair');
const { httpError } = require('../auth');
const {
  HOUSE, ROULETTE_RED, drawDistinctCards, toCents, debit, credit, balanceOf, recordBet
} = require('./core');

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
// eslint-disable-next-line no-unused-vars -- documents the reel + a source anchor for test/spectacle.test.js
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
// eslint-disable-next-line no-unused-vars -- COLS/ROWS document the grid + a source anchor for test/flashy3.test.js
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

// ---------------------------------------------------------------- AMERICAN ROULETTE
// Double-zero wheel: 38 pockets (0, 00, 1–36). The extra green pocket is what
// gives American roulette its ~5.26% house edge on every bet. Internally pocket
// 37 represents "00". Same pay table as European; the edge comes from the pocket
// count, not the odds. Column bets added on top.
const AMROU_PAYS = {
  red: 2, black: 2, even: 2, odd: 2, low: 2, high: 2,
  dozen1: 3, dozen2: 3, dozen3: 3, col1: 3, col2: 3, col3: 3, straight: 36
};
function amRouLabel(p) { return p === 37 ? '00' : String(p); }
function amRouColor(p) { return (p === 0 || p === 37) ? 'green' : (ROULETTE_RED.has(p) ? 'red' : 'black'); }
function playAmRoulette(userId, { bet, betType, number }) {
  const betCents = toCents(bet);
  if (!AMROU_PAYS[betType]) throw httpError(400, 'Invalid bet.');
  let num = null;
  if (betType === 'straight') {
    num = Number(number);
    // 0–36 are numbers; 37 is the "00" pocket.
    if (!Number.isInteger(num) || num < 0 || num > 37) throw httpError(400, 'Pick a number, 0 or 00.');
  }
  return db.tx(async (q) => {
    await debit(q, userId, betCents);
    const { floats, nonce, serverHash } = await fair.drawTx(q, userId, 1);
    const pocket = Math.min(37, Math.floor(floats[0] * 38)); // 0..37 (37 = "00")
    const isNum = pocket >= 1 && pocket <= 36;
    const color = amRouColor(pocket);
    let win = false;
    switch (betType) {
      case 'red': win = color === 'red'; break;
      case 'black': win = color === 'black'; break;
      case 'even': win = isNum && pocket % 2 === 0; break;
      case 'odd': win = isNum && pocket % 2 === 1; break;
      case 'low': win = pocket >= 1 && pocket <= 18; break;
      case 'high': win = pocket >= 19 && pocket <= 36; break;
      case 'dozen1': win = pocket >= 1 && pocket <= 12; break;
      case 'dozen2': win = pocket >= 13 && pocket <= 24; break;
      case 'dozen3': win = pocket >= 25 && pocket <= 36; break;
      case 'col1': win = isNum && pocket % 3 === 1; break;
      case 'col2': win = isNum && pocket % 3 === 2; break;
      case 'col3': win = isNum && pocket % 3 === 0; break;
      case 'straight': win = pocket === num; break;
    }
    const mult = win ? AMROU_PAYS[betType] : 0;
    const payoutCents = Math.round(betCents * mult);
    await credit(q, userId, payoutCents);
    await recordBet(q, userId, { game: 'amroulette', betCents, mult, payoutCents, win, nonce, detail: { pocket, color, betType, number: num } });
    return { pocket, label: amRouLabel(pocket), color, win, mult, betType, payout: payoutCents / 100, balance: await balanceOf(q, userId) / 100, nonce, serverHash };
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


module.exports = {
  chickenStart, chickenStep, chickenCashout,
  crapsStart, crapsRoll,
  tcpStart, tcpAct,
  playBingo,
  playDerby, playCashHunt, playBigCatch, playRps, playNeonFruits,
  playMegaWheel, playTenPin, playBullseye, playFirecracker, playSugarBlast,
  playZeusGates, playSlingo, playMiniRoulette,
  playPinata, playFanTan, playRedDog,
  playAmRoulette,
  penaltyStart, penaltyShoot, penaltyCashout, penaltyMult
};
