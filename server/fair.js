'use strict';

/* Server-authoritative provably-fair engine (async storage).
 *
 * Each user has a secret server_seed, its committed server_hash = sha256(seed),
 * a player-editable client_seed, and a monotonic nonce (one per bet).
 * Outcome floats come from HMAC-SHA256(server_seed, "clientSeed:nonce:round"),
 * 4 bytes at a time as a base-256 fraction — the standard verifiable method. */

const crypto = require('crypto');
const db = require('./db');

function sha256Hex(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function hmac(serverSeed, message) { return crypto.createHmac('sha256', serverSeed).update(message).digest(); }
function randomHex(bytes) { return crypto.randomBytes(bytes).toString('hex'); }

async function getFair(userId) {
  const { rows } = await db.query('SELECT * FROM fair WHERE user_id = ?', [userId]);
  return rows[0] || null;
}

async function ensureFair(userId) {
  let row = await getFair(userId);
  if (!row) {
    const serverSeed = randomHex(32);
    await db.query(
      'INSERT INTO fair(user_id, server_seed, server_hash, client_seed, nonce, revealed_seed) VALUES(?,?,?,?,?,?)',
      [userId, serverSeed, sha256Hex(serverSeed), randomHex(8), 0, null]
    );
    row = await getFair(userId);
  }
  return row;
}

async function publicState(userId) {
  const f = await ensureFair(userId);
  return {
    serverHash: f.server_hash,
    clientSeed: f.client_seed,
    nonce: Number(f.nonce),
    revealedSeed: f.revealed_seed
  };
}

async function setClientSeed(userId, seed) {
  await ensureFair(userId);
  const clean = String(seed || '').slice(0, 64) || randomHex(8);
  // Deliberately DO NOT reset the nonce here. Outcomes are a pure function of
  // (server_seed, client_seed, nonce); the server seed stays secret until a
  // rotate. If we reset the nonce to 0 on a client-seed change, a player could
  // set their client seed back to a value they've already seen win at nonce 0
  // and deterministically replay that winning outcome. Keeping the nonce
  // monotonic means a (server_seed, nonce) pair can never recur while the seed
  // is secret, which closes the replay. Fairness verification is unaffected —
  // you still verify each bet with its own nonce once the seed is revealed.
  await db.query('UPDATE fair SET client_seed = ? WHERE user_id = ?', [clean, userId]);
  return publicState(userId);
}

async function rotate(userId) {
  const old = await ensureFair(userId);
  const newSeed = randomHex(32);
  await db.query(
    'UPDATE fair SET server_seed = ?, server_hash = ?, nonce = 0, revealed_seed = ? WHERE user_id = ?',
    [newSeed, sha256Hex(newSeed), old.server_seed, userId]
  );
  return {
    revealedSeed: old.server_seed,
    revealedHash: old.server_hash,
    finalNonce: Number(old.nonce),
    newHash: sha256Hex(newSeed)
  };
}

// Compute `count` floats from a seed row at a given nonce (pure, no I/O).
function floatsFrom(serverSeed, clientSeed, nonce, count) {
  const out = [];
  let round = 0;
  while (out.length < count) {
    const h = hmac(serverSeed, `${clientSeed}:${nonce}:${round}`);
    for (let i = 0; i + 4 <= h.length && out.length < count; i += 4) {
      out.push(h[i] / 256 + h[i + 1] / 65536 + h[i + 2] / 16777216 + h[i + 3] / 4294967296);
    }
    round++;
  }
  return out;
}

// Draw `count` floats for the CURRENT nonce within a transaction, advancing the
// nonce. `q` is the transaction query fn from db.tx.
async function drawTx(q, userId, count) {
  const { rows } = await q('SELECT server_seed, client_seed, nonce, server_hash FROM fair WHERE user_id = ?', [userId]);
  const f = rows[0];
  const nonce = Number(f.nonce);
  const floats = floatsFrom(f.server_seed, f.client_seed, nonce, count);
  await q('UPDATE fair SET nonce = nonce + 1 WHERE user_id = ?', [userId]);
  return { floats, nonce, serverHash: f.server_hash };
}

module.exports = { sha256Hex, randomHex, ensureFair, publicState, setClientSeed, rotate, drawTx, floatsFrom };
