'use strict';

// Unit-level proof that the round-settle guard is genuinely CONDITIONAL.
//
// The HTTP-level race test can't prove this on SQLite: transactions there are
// serialized, so the pre-existing `SELECT ... settled` gate rejects a replay
// before settleRound is even reached — that test passes with or without the
// guard. This one calls settleRound directly, twice on the same row, which is
// exactly what two racing transactions do on Postgres once the unlocked SELECT
// lets them both through. It fails if anyone reverts settleRound to a blind
// `UPDATE rounds SET settled = 1 WHERE id = ?` (verified against that revert).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const DB = `/tmp/crypt-test-settleguard-${process.pid}.db`;
process.env.DB_PATH = DB;
process.env.SESSION_SECRET = 'settle-guard-test';

const db = require('../server/db');
const { settleRound } = require('../server/games/core');

function rmDb() { for (const f of [DB, DB + '-shm', DB + '-wal']) { try { fs.unlinkSync(f); } catch (_) {} } }

test('settleRound claims a round exactly once', async (t) => {
  rmDb();
  await db.init();
  try {
    // A user + an unsettled round to claim.
    await db.query(
      'INSERT INTO users(username, pass_hash, pass_salt, balance_cents, created_at) VALUES(?,?,?,?,?)',
      ['settler', 'x', 'y', 100000, Date.now()]
    );
    const uid = Number((await db.query('SELECT id FROM users WHERE username = ?', ['settler'])).rows[0].id);
    const mkRound = async (id) => db.query(
      'INSERT INTO rounds(id, user_id, game, state, settled, created_at) VALUES(?,?,?,?,0,?)',
      [id, uid, 'mines', '{}', Date.now()]
    );

    await t.test('second claim on the same round is rejected', async () => {
      await mkRound('r-double');
      await db.tx(async (q) => {
        await settleRound(q, 'r-double');           // first claim wins
        await assert.rejects(
          () => settleRound(q, 'r-double'),          // the racing loser
          (e) => e.status === 409,
          'a round already claimed must throw 409'
        );
      });
      const row = (await db.query('SELECT settled FROM rounds WHERE id = ?', ['r-double'])).rows[0];
      assert.equal(Number(row.settled), 1, 'round is settled exactly once');
    });

    await t.test('first claim succeeds and is not rejected', async () => {
      await mkRound('r-single');
      await db.tx(async (q) => { await settleRound(q, 'r-single'); });
      const row = (await db.query('SELECT settled FROM rounds WHERE id = ?', ['r-single'])).rows[0];
      assert.equal(Number(row.settled), 1);
    });

    await t.test('claiming a nonexistent round is rejected, not silently ignored', async () => {
      await assert.rejects(
        () => db.tx(async (q) => settleRound(q, 'no-such-round')),
        (e) => e.status === 409
      );
    });
  } finally {
    rmDb();
  }
});
