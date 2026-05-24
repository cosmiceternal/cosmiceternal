'use strict';

/* Dual-driver async storage.
 *   - If DATABASE_URL is set → PostgreSQL (via pg). Used in production so data
 *     survives restarts on free hosts like Neon / Render Postgres.
 *   - Otherwise → SQLite (via better-sqlite3), zero-config for local dev.
 *
 * All callers use `query(sql, params)` and `tx(fn)` with `?` placeholders;
 * the Postgres adapter rewrites `?` to `$1, $2, …`. SQL is kept to the subset
 * both engines share (INSERT … RETURNING, ON CONFLICT … DO UPDATE). */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const USE_PG = !!process.env.DATABASE_URL;

let pool = null;     // pg Pool
let sqlite = null;   // better-sqlite3 Database
let _secret = null;

// ---- placeholder translation for Postgres ----
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => '$' + (++i));
}

// ---- unified query ----
async function query(sql, params = []) {
  if (USE_PG) {
    const res = await pool.query(toPg(sql), params);
    return { rows: res.rows, rowCount: res.rowCount };
  }
  const stmt = sqlite.prepare(sql);
  if (stmt.reader) return { rows: stmt.all(...params) };
  const info = stmt.run(...params);
  return { rows: [], rowCount: info.changes, lastInsertRowid: info.lastInsertRowid };
}

// ---- transactions ----
// fn receives a `q(sql, params)` bound to the transaction.
async function tx(fn) {
  if (USE_PG) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const q = async (sql, params = []) => {
        const r = await client.query(toPg(sql), params);
        return { rows: r.rows, rowCount: r.rowCount };
      };
      const out = await fn(q);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally {
      client.release();
    }
  }
  // SQLite: better-sqlite3 is synchronous, so the whole callback runs within a
  // single microtask chain (our q does no real async I/O) — no other request
  // can interleave between BEGIN and COMMIT.
  sqlite.exec('BEGIN');
  try {
    const out = await fn(query);
    sqlite.exec('COMMIT');
    return out;
  } catch (e) {
    try { sqlite.exec('ROLLBACK'); } catch (_) {}
    throw e;
  }
}

// ---- schema ----
const SCHEMA_SQLITE = `
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    pass_hash     TEXT NOT NULL,
    pass_salt     TEXT NOT NULL,
    balance_cents INTEGER NOT NULL,
    created_at    INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS fair (
    user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    server_seed   TEXT NOT NULL,
    server_hash   TEXT NOT NULL,
    client_seed   TEXT NOT NULL,
    nonce         INTEGER NOT NULL DEFAULT 0,
    revealed_seed TEXT
  );
  CREATE TABLE IF NOT EXISTS bets (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game         TEXT NOT NULL,
    bet_cents    INTEGER NOT NULL,
    mult         REAL NOT NULL,
    payout_cents INTEGER NOT NULL,
    win          INTEGER NOT NULL,
    nonce        INTEGER NOT NULL,
    detail       TEXT,
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_bets_user ON bets(user_id, id DESC);
  CREATE TABLE IF NOT EXISTS rounds (
    id         TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game       TEXT NOT NULL,
    state      TEXT NOT NULL,
    settled    INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

const SCHEMA_PG = `
  CREATE TABLE IF NOT EXISTS users (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username      TEXT UNIQUE NOT NULL,
    pass_hash     TEXT NOT NULL,
    pass_salt     TEXT NOT NULL,
    balance_cents BIGINT NOT NULL,
    created_at    BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS fair (
    user_id       BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    server_seed   TEXT NOT NULL,
    server_hash   TEXT NOT NULL,
    client_seed   TEXT NOT NULL,
    nonce         BIGINT NOT NULL DEFAULT 0,
    revealed_seed TEXT
  );
  CREATE TABLE IF NOT EXISTS bets (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game         TEXT NOT NULL,
    bet_cents    BIGINT NOT NULL,
    mult         DOUBLE PRECISION NOT NULL,
    payout_cents BIGINT NOT NULL,
    win          INTEGER NOT NULL,
    nonce        BIGINT NOT NULL,
    detail       TEXT,
    created_at   BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_bets_user ON bets(user_id, id DESC);
  CREATE TABLE IF NOT EXISTS rounds (
    id         TEXT PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game       TEXT NOT NULL,
    state      TEXT NOT NULL,
    settled    INTEGER NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

async function init() {
  if (USE_PG) {
    const pg = require('pg');
    // BIGINT (int8, OID 20) defaults to string in node-postgres; our values are
    // cents/nonces well under 2^53, so parse them as numbers for clean math.
    pg.types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));
    const { Pool } = pg;
    const url = process.env.DATABASE_URL;
    const local = /localhost|127\.0\.0\.1/.test(url);
    pool = new Pool({
      connectionString: url,
      ssl: local ? false : { rejectUnauthorized: false }
    });
    // pg can't run multiple statements with parameters, but plain multi-statement
    // DDL via a single query string is fine.
    await pool.query(SCHEMA_PG);
    console.log('Storage: PostgreSQL');
  } else {
    const Database = require('better-sqlite3');
    const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'neonstake.db');
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    sqlite = new Database(DB_PATH);
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(SCHEMA_SQLITE);
    console.log('Storage: SQLite at ' + DB_PATH);
  }
  await ensureSecret();
}

async function getSetting(key) {
  const { rows } = await query('SELECT value FROM settings WHERE key = ?', [key]);
  return rows.length ? rows[0].value : null;
}
async function setSetting(key, value) {
  await query(
    'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value]
  );
}

async function ensureSecret() {
  if (process.env.SESSION_SECRET) { _secret = process.env.SESSION_SECRET; return; }
  let s = await getSetting('session_secret');
  if (!s) {
    s = crypto.randomBytes(32).toString('hex');
    await setSetting('session_secret', s);
  }
  _secret = s;
}
function sessionSecret() { return _secret; }

module.exports = { init, query, tx, getSetting, setSetting, sessionSecret, USE_PG };
