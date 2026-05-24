'use strict';

/* Server-authoritative provably-fair engine.
 *
 * Each user has: server_seed (secret), server_hash = sha256(server_seed)
 * shown to the player as a commitment, client_seed (player-editable), and a
 * monotonic nonce. Each bet consumes one nonce.
 *
 * Outcome floats are derived from HMAC-SHA256(server_seed, "clientSeed:nonce:round")
 * by taking 4 bytes at a time as a base-256 fraction — the standard Stake-style
 * method, so any player can independently verify a roll once the seed is revealed.
 *
 * Verification (after seed rotation reveals the server seed):
 *   hmac = HMAC_SHA256(serverSeed, `${clientSeed}:${nonce}:0`)
 *   f0   = hmac[0]/256 + hmac[1]/256^2 + hmac[2]/256^3 + hmac[3]/256^4
 *   (subsequent floats use bytes 4..7, 8..11, …; increment the :round suffix
 *    after 8 floats are exhausted from one HMAC.)
 */

const crypto = require('crypto');
const { db } = require('./db');

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}
function hmac(serverSeed, message) {
  return crypto.createHmac('sha256', serverSeed).update(message).digest(); // Buffer(32)
}
function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function ensureFair(userId) {
  let row = db.prepare('SELECT * FROM fair WHERE user_id = ?').get(userId);
  if (!row) {
    const serverSeed = randomHex(32);
    const fairRow = {
      user_id: userId,
      server_seed: serverSeed,
      server_hash: sha256Hex(serverSeed),
      client_seed: randomHex(8),
      nonce: 0,
      revealed_seed: null
    };
    db.prepare(`INSERT INTO fair(user_id, server_seed, server_hash, client_seed, nonce, revealed_seed)
                VALUES(@user_id, @server_seed, @server_hash, @client_seed, @nonce, @revealed_seed)`).run(fairRow);
    row = db.prepare('SELECT * FROM fair WHERE user_id = ?').get(userId);
  }
  return row;
}

// Public state — never leaks the active server seed.
function publicState(userId) {
  const f = ensureFair(userId);
  return {
    serverHash: f.server_hash,
    clientSeed: f.client_seed,
    nonce: f.nonce,
    revealedSeed: f.revealed_seed
  };
}

function setClientSeed(userId, seed) {
  ensureFair(userId);
  const clean = String(seed).slice(0, 64) || randomHex(8);
  db.prepare('UPDATE fair SET client_seed = ?, nonce = 0 WHERE user_id = ?').run(clean, userId);
  return publicState(userId);
}

// Reveal the active seed, mint a new one, reset nonce.
function rotate(userId) {
  const old = ensureFair(userId);
  const newSeed = randomHex(32);
  db.prepare('UPDATE fair SET server_seed = ?, server_hash = ?, nonce = 0, revealed_seed = ? WHERE user_id = ?')
    .run(newSeed, sha256Hex(newSeed), old.server_seed, userId);
  return {
    revealedSeed: old.server_seed,
    revealedHash: old.server_hash,
    finalNonce: old.nonce,
    newHash: sha256Hex(newSeed)
  };
}

// Draw `count` floats in [0,1) for the CURRENT nonce, then advance the nonce.
// Returns { floats, nonce, serverHash }. Atomic per call.
const drawTxn = db.transaction((userId, count) => {
  const f = ensureFair(userId);
  const nonce = f.nonce;
  const floats = [];
  let round = 0;
  while (floats.length < count) {
    const h = hmac(f.server_seed, `${f.client_seed}:${nonce}:${round}`);
    for (let i = 0; i + 4 <= h.length && floats.length < count; i += 4) {
      const val = h[i] / 256 + h[i + 1] / 65536 + h[i + 2] / 16777216 + h[i + 3] / 4294967296;
      floats.push(val);
    }
    round++;
  }
  db.prepare('UPDATE fair SET nonce = nonce + 1 WHERE user_id = ?').run(userId);
  return { floats, nonce, serverHash: f.server_hash };
});

function draw(userId, count) {
  return drawTxn(userId, count);
}

module.exports = { sha256Hex, randomHex, ensureFair, publicState, setClientSeed, rotate, draw };
