'use strict';

// Full-floor smoke test: play EVERY game and exercise every player-facing
// feature through the real HTTP API.
//
// The unit tests cover payout math and specific races; this one answers a
// different question — "is the whole app actually functioning?" It caught
// nothing on the day it was written (all 50 games passed), which is exactly
// why it is worth keeping: after a refactor like the games.js split or the
// settle-guard change, this is the test that proves nothing silently broke.
//
// Note on the multi-step games: outcomes are random, so a round may end on its
// first action (bust, board cleared, losing flip). Each flow below only cashes
// out while the round is genuinely still live — otherwise the assertion would
// flake roughly one run in three.
//
// The "round is over" signal differs per game and is NOT uniform. Verified
// against the server's return statements:
//   mines / towers / chicken   hit: true  |  cleared: true
//   hilo / coin                win: false
//   pump                       burst: true  |  maxed: true
//   penalty                    saved: true  |  perfect: true
//   craps / blackjack          done: true
// Guessing these is how this test flaked in CI while passing locally.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { waitForReady } = require('./helpers/server-ready');

const REPO = path.join(__dirname, '..');
const PORT = 7000 + (process.pid % 100);   // unique base — see test/ports.test.js
const BASE = `http://localhost:${PORT}`;
const DB = `/tmp/crypt-test-allgames-${process.pid}.db`;

function rmDb() { for (const f of [DB, DB + '-shm', DB + '-wal']) { try { fs.unlinkSync(f); } catch (_) {} } }
const sess = { csrf: '', jar: '' };
async function req(method, p, body) {
  const headers = { Cookie: sess.jar };
  if (body != null) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && sess.csrf) headers['X-CSRF-Token'] = sess.csrf;
  const r = await fetch(BASE + p, { method, headers, body: body != null ? JSON.stringify(body) : undefined });
  for (const s of (r.headers.getSetCookie ? r.headers.getSetCookie() : [])) {
    const [pair] = s.split(';'); const [k, ...v] = pair.split('='); const key = k.trim(), val = v.join('=');
    if (key === 'csrf') sess.csrf = val;
    const parts = sess.jar ? sess.jar.split('; ').filter(x => !x.startsWith(key + '=')) : [];
    parts.push(`${key}=${val}`); sess.jar = parts.join('; ');
  }
  let data = null; try { data = await r.json(); } catch (_) {}
  return { status: r.status, data };
}

// Every single-shot game and the body it needs.
const SINGLE_SHOT = [
  ['dice', '/api/play/dice', { bet: 1, target: 50, dir: 'over' }],
  ['plinko', '/api/play/plinko', { bet: 1, rows: 12, risk: 'low' }],
  ['crash', '/api/play/crash', { bet: 1, autoCashout: 2 }],
  ['limbo', '/api/play/limbo', { bet: 1, target: 2 }],
  ['wheel', '/api/play/wheel', { bet: 1, risk: 'low' }],
  ['keno', '/api/play/keno', { bet: 1, picks: [1, 2, 3, 4] }],
  ['roulette', '/api/play/roulette', { bet: 1, betType: 'red' }],
  ['diamonds', '/api/play/diamonds', { bet: 1 }],
  ['slots', '/api/play/slots', { bet: 1 }],
  ['luckysevens', '/api/play/luckysevens', { bet: 1 }],
  ['cosmic', '/api/play/cosmic', { bet: 1 }],
  ['sicbo', '/api/play/sicbo', { bet: 1, betType: 'big' }],
  ['color', '/api/play/color', { bet: 1, choice: 'red' }],
  ['scratch', '/api/play/scratch', { bet: 1 }],
  ['baccarat', '/api/play/baccarat', { bet: 1, betType: 'player' }],
  ['dragontiger', '/api/play/dragontiger', { bet: 1, betType: 'dragon' }],
  ['andarbahar', '/api/play/andarbahar', { bet: 1, side: 'andar' }],
  ['cascade', '/api/play/cascade', { bet: 1, risk: 'low' }],
  ['war', '/api/play/war', { bet: 1 }],
  ['pachinko', '/api/play/pachinko', { bet: 1 }],
  ['bingo', '/api/play/bingo', { bet: 1 }],
  ['derby', '/api/play/derby', { bet: 1, pick: 0 }],
  ['cashhunt', '/api/play/cashhunt', { bet: 1, pick: 0 }],
  ['bigcatch', '/api/play/bigcatch', { bet: 1 }],
  ['rps', '/api/play/rps', { bet: 1, pick: 0 }],
  ['neonfruits', '/api/play/neonfruits', { bet: 1 }],
  ['megawheel', '/api/play/megawheel', { bet: 1 }],
  ['tenpin', '/api/play/tenpin', { bet: 1 }],
  ['bullseye', '/api/play/bullseye', { bet: 1 }],
  ['firecracker', '/api/play/firecracker', { bet: 1 }],
  ['sugarblast', '/api/play/sugarblast', { bet: 1 }],
  ['zeusgates', '/api/play/zeusgates', { bet: 1 }],
  ['slingo', '/api/play/slingo', { bet: 1 }],
  ['miniroulette', '/api/play/miniroulette', { bet: 1, betType: 'red' }],
  ['pinata', '/api/play/pinata', { bet: 1, pick: 0 }],
  ['fantan', '/api/play/fantan', { bet: 1, pick: 1 }],
  ['reddog', '/api/play/reddog', { bet: 1 }],
  ['amroulette', '/api/play/amroulette', { bet: 1, betType: 'red' }],
];

test('every game and feature is functional', async (t) => {
  rmDb();
  const child = spawn(process.execPath, [path.join(REPO, 'server/index.js')], {
    env: {
      ...process.env, PORT: String(PORT), DB_PATH: DB, SESSION_SECRET: 'allgames-test',
      SECURE_COOKIES: '0', RATE_API_MAX: '1000000', RATE_AUTH_MAX: '10000', STARTING_BALANCE: '100000'
    },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  try {
    await waitForReady(`${BASE}/healthz`, { child });
    await req('GET', '/api/me');
    const reg = await req('POST', '/api/auth/register', { username: 'floortest', password: 'longpassword1' });
    assert.equal(reg.status, 200, 'register');

    await t.test('all single-shot games settle', async () => {
      for (const [name, ep, body] of SINGLE_SHOT) {
        const r = await req('POST', ep, body);
        assert.equal(r.status, 200, `${name} returned ${r.status}: ${JSON.stringify(r.data).slice(0, 120)}`);
        assert.equal(typeof r.data.balance, 'number', `${name} must return a balance`);
      }
    });

    await t.test('all multi-step games play through', async () => {
      // mines — `hit` busts, `cleared` finishes the board.
      let st = await req('POST', '/api/play/mines/start', { bet: 1, mines: 3 });
      assert.equal(st.status, 200, 'mines start');
      let step = await req('POST', '/api/play/mines/reveal', { roundId: st.data.roundId, cell: 0 });
      assert.equal(step.status, 200, 'mines reveal');
      if (!step.data.hit && !step.data.cleared) {
        assert.equal((await req('POST', '/api/play/mines/cashout', { roundId: st.data.roundId })).status, 200, 'mines cashout');
      }

      // hilo — a wrong guess ends the round.
      st = await req('POST', '/api/play/hilo/start', { bet: 1 });
      assert.equal(st.status, 200, 'hilo start');
      step = await req('POST', '/api/play/hilo/guess', { roundId: st.data.roundId, choice: 'hi' });
      assert.equal(step.status, 200, 'hilo guess');
      if (step.data.win) {
        assert.equal((await req('POST', '/api/play/hilo/cashout', { roundId: st.data.roundId })).status, 200, 'hilo cashout');
      }

      // towers
      st = await req('POST', '/api/play/towers/start', { bet: 1, difficulty: 'easy' });
      assert.equal(st.status, 200, 'towers start');
      step = await req('POST', '/api/play/towers/reveal', { roundId: st.data.roundId, tile: 0 });
      assert.equal(step.status, 200, 'towers reveal');
      if (!step.data.hit && !step.data.cleared) {
        assert.equal((await req('POST', '/api/play/towers/cashout', { roundId: st.data.roundId })).status, 200, 'towers cashout');
      }

      // pump — `burst` is the bomb, `maxed` is every position cleared. Both
      // settle the round server-side. (Guessing `done`/`hit` here made this
      // flake roughly 1 run in 20, whenever the bomb came up on the first pump.)
      st = await req('POST', '/api/play/pump/start', { bet: 1, difficulty: 'easy' });
      assert.equal(st.status, 200, 'pump start');
      step = await req('POST', '/api/play/pump/pump', { roundId: st.data.roundId });
      assert.equal(step.status, 200, 'pump pump');
      if (!step.data.burst && !step.data.maxed) {
        assert.equal((await req('POST', '/api/play/pump/cashout', { roundId: st.data.roundId })).status, 200, 'pump cashout');
      }

      // coin — the round ends on a losing flip.
      st = await req('POST', '/api/play/coin/start', { bet: 1 });
      assert.equal(st.status, 200, 'coin start');
      step = await req('POST', '/api/play/coin/flip', { roundId: st.data.roundId, side: 'heads' });
      assert.equal(step.status, 200, 'coin flip');
      if (step.data.win) {
        assert.equal((await req('POST', '/api/play/coin/cashout', { roundId: st.data.roundId })).status, 200, 'coin cashout');
      }

      // chicken
      st = await req('POST', '/api/play/chicken/start', { bet: 1, difficulty: 'easy' });
      assert.equal(st.status, 200, 'chicken start');
      step = await req('POST', '/api/play/chicken/step', { roundId: st.data.roundId });
      assert.equal(step.status, 200, 'chicken step');
      if (!step.data.hit && !step.data.cleared) {
        assert.equal((await req('POST', '/api/play/chicken/cashout', { roundId: st.data.roundId })).status, 200, 'chicken cashout');
      }

      // craps — a natural/craps settles immediately.
      st = await req('POST', '/api/play/craps/start', { bet: 1 });
      assert.equal(st.status, 200, 'craps start');
      if (!st.data.done) {
        assert.equal((await req('POST', '/api/play/craps/roll', { roundId: st.data.roundId })).status, 200, 'craps roll');
      }

      // three card poker
      st = await req('POST', '/api/play/tcp/start', { bet: 1 });
      assert.equal(st.status, 200, 'tcp start');
      assert.equal((await req('POST', '/api/play/tcp/act', { roundId: st.data.roundId, action: 'play' })).status, 200, 'tcp act');

      // blackjack — a natural settles at deal.
      st = await req('POST', '/api/play/blackjack/start', { bet: 1 });
      assert.equal(st.status, 200, 'blackjack start');
      if (!st.data.done) {
        assert.equal((await req('POST', '/api/play/blackjack/stand', { roundId: st.data.roundId })).status, 200, 'blackjack stand');
      }

      // video poker
      st = await req('POST', '/api/play/videopoker/start', { bet: 1 });
      assert.equal(st.status, 200, 'videopoker start');
      assert.equal((await req('POST', '/api/play/videopoker/draw', { roundId: st.data.roundId, holds: [0, 1] })).status, 200, 'videopoker draw');

      // penalty — `saved` means the keeper stopped it (round over).
      st = await req('POST', '/api/play/penalty/start', { bet: 1 });
      assert.equal(st.status, 200, 'penalty start');
      step = await req('POST', '/api/play/penalty/shoot', { roundId: st.data.roundId, dir: 0 });
      assert.equal(step.status, 200, 'penalty shoot');
      if (!step.data.saved && !step.data.perfect) {
        assert.equal((await req('POST', '/api/play/penalty/cashout', { roundId: st.data.roundId })).status, 200, 'penalty cashout');
      }
    });

    await t.test('player-facing read endpoints all respond', async () => {
      const reads = [
        '/api/me', '/api/stats', '/api/stats/detail', '/api/history?limit=10',
        '/api/feed/global', '/api/leaderboard?metric=xp', '/api/leaderboard?metric=wins',
        '/api/leaderboard?metric=biggest', '/api/fair', '/api/fair/history?limit=5',
        '/api/progression', '/api/jackpot', '/api/race', '/api/chat', '/api/vault',
        '/api/vault/history', '/api/vault/withdrawals', '/api/play/keno/table?picks=4',
        '/api/auth/audit?limit=5',
      ];
      for (const p of reads) {
        const r = await req('GET', p);
        assert.equal(r.status, 200, `${p} returned ${r.status}`);
      }
    });

    await t.test('player-facing actions work', async () => {
      assert.equal((await req('POST', '/api/fair/rotate')).status, 200, 'rotate seed');
      assert.equal((await req('POST', '/api/fair/client', { clientSeed: 'my-seed' })).status, 200, 'set client seed');
      assert.equal((await req('POST', '/api/limits/loss-limit', { amount: 1000 })).status, 200, 'set loss limit');

      const chat = await req('POST', '/api/chat/send', { text: 'gg' });
      assert.ok(chat.status === 200 || chat.status === 429, `chat send returned ${chat.status}`);

      const dealer = await req('POST', '/api/dealer/line', { dealer: 'vivienne', event: 'greet' });
      assert.equal(dealer.status, 200, 'dealer line'); // returns {line:null} when no API key

      const daily = await req('POST', '/api/progression/claim-daily');
      assert.ok(daily.status === 200 || daily.status === 409, `claim-daily returned ${daily.status}`);
    });

    await t.test('the deposit → confirm → withdraw path works', async () => {
      const dep = await req('POST', '/api/vault/deposit', { currency: 'USDT', amount: 10 });
      assert.equal(dep.status, 200, `deposit: ${JSON.stringify(dep.data).slice(0, 120)}`);
      const conf = await req('POST', '/api/vault/confirm', { depositId: dep.data.depositId });
      assert.equal(conf.status, 200, `confirm: ${JSON.stringify(conf.data).slice(0, 120)}`);
      const wd = await req('POST', '/api/vault/withdraw', { currency: 'USDT', amount: 20 });
      assert.ok(wd.status === 200 || wd.status === 400, `withdraw returned ${wd.status}`);
    });
  } finally {
    child.kill('SIGTERM');
    rmDb();
  }
});
