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

// Mutable: if DATABASE_URL is set but the database cannot be reached at boot,
// init() downgrades this to false and runs on SQLite rather than refusing to
// start (see init). Nothing outside this module reads it directly.
let usePg = !!process.env.DATABASE_URL;

// What the process actually ended up running on, for /healthz and the logs.
const storage = { engine: 'unknown', degraded: false, reason: '' };

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
  if (usePg) {
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
  if (usePg) {
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
    created_at    INTEGER NOT NULL,
    xp            INTEGER NOT NULL DEFAULT 0,
    level         INTEGER NOT NULL DEFAULT 1,
    streak_day    INTEGER NOT NULL DEFAULT 0,
    last_bonus_at INTEGER
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
  CREATE INDEX IF NOT EXISTS idx_bets_user_created ON bets(user_id, created_at);
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
  CREATE TABLE IF NOT EXISTS login_attempts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT NOT NULL,
    ip         TEXT,
    success    INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts(username, created_at DESC);
  CREATE TABLE IF NOT EXISTS audit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    event      TEXT NOT NULL,
    user_id    INTEGER,
    ip         TEXT,
    ua         TEXT,
    meta       TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_event ON audit_log(event, id DESC);
  CREATE TABLE IF NOT EXISTS deposits (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    processor    TEXT NOT NULL,
    currency     TEXT NOT NULL,
    amount_units REAL NOT NULL,
    fun_credited INTEGER NOT NULL,
    status       TEXT NOT NULL,
    txid         TEXT,
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_deposits_user ON deposits(user_id, id DESC);
  CREATE TABLE IF NOT EXISTS achievements (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key         TEXT NOT NULL,
    unlocked_at INTEGER NOT NULL,
    UNIQUE(user_id, key)
  );
  CREATE INDEX IF NOT EXISTS idx_achievements_user ON achievements(user_id, unlocked_at DESC);
  CREATE TABLE IF NOT EXISTS chat_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chat_recent ON chat_messages(id DESC);
  CREATE TABLE IF NOT EXISTS withdrawals (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    processor    TEXT NOT NULL,
    currency     TEXT NOT NULL,
    amount_units REAL NOT NULL,
    fun_debited  INTEGER NOT NULL,
    address      TEXT NOT NULL,
    status       TEXT NOT NULL,
    txid         TEXT,
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_id, id DESC);
`;

const SCHEMA_PG = `
  CREATE TABLE IF NOT EXISTS users (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username      TEXT UNIQUE NOT NULL,
    pass_hash     TEXT NOT NULL,
    pass_salt     TEXT NOT NULL,
    balance_cents BIGINT NOT NULL,
    created_at    BIGINT NOT NULL,
    xp            BIGINT NOT NULL DEFAULT 0,
    level         INTEGER NOT NULL DEFAULT 1,
    streak_day    INTEGER NOT NULL DEFAULT 0,
    last_bonus_at BIGINT
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
  CREATE INDEX IF NOT EXISTS idx_bets_user_created ON bets(user_id, created_at);
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
  CREATE TABLE IF NOT EXISTS login_attempts (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username   TEXT NOT NULL,
    ip         TEXT,
    success    INTEGER NOT NULL,
    created_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts(username, created_at DESC);
  CREATE TABLE IF NOT EXISTS audit_log (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event      TEXT NOT NULL,
    user_id    BIGINT,
    ip         TEXT,
    ua         TEXT,
    meta       TEXT,
    created_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_event ON audit_log(event, id DESC);
  CREATE TABLE IF NOT EXISTS deposits (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    processor    TEXT NOT NULL,
    currency     TEXT NOT NULL,
    amount_units DOUBLE PRECISION NOT NULL,
    fun_credited BIGINT NOT NULL,
    status       TEXT NOT NULL,
    txid         TEXT,
    created_at   BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_deposits_user ON deposits(user_id, id DESC);
  CREATE TABLE IF NOT EXISTS achievements (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key         TEXT NOT NULL,
    unlocked_at BIGINT NOT NULL,
    UNIQUE(user_id, key)
  );
  CREATE INDEX IF NOT EXISTS idx_achievements_user ON achievements(user_id, unlocked_at DESC);
  CREATE TABLE IF NOT EXISTS chat_messages (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text       TEXT NOT NULL,
    created_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chat_recent ON chat_messages(id DESC);
  CREATE TABLE IF NOT EXISTS withdrawals (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    processor    TEXT NOT NULL,
    currency     TEXT NOT NULL,
    amount_units DOUBLE PRECISION NOT NULL,
    fun_debited  BIGINT NOT NULL,
    address      TEXT NOT NULL,
    status       TEXT NOT NULL,
    txid         TEXT,
    created_at   BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_id, id DESC);
`;

// Idempotent migrations for already-deployed installs. SQLite doesn't support
// IF NOT EXISTS on ADD COLUMN, so we rely on catching the duplicate-column
// error in init() instead.
const MIGRATIONS = [
  "ALTER TABLE users ADD COLUMN xp BIGINT NOT NULL DEFAULT 0",
  "ALTER TABLE users ADD COLUMN level INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE users ADD COLUMN streak_day INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE users ADD COLUMN last_bonus_at BIGINT",
  "ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE users ADD COLUMN locked INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE users ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE users ADD COLUMN loss_limit_cents BIGINT",
  "ALTER TABLE users ADD COLUMN excluded_until BIGINT",
  "ALTER TABLE users ADD COLUMN deposit_limit_cents BIGINT",
  // Per-bet provably-fair commitment + client seed, so any past bet can be
  // independently re-derived once its server seed is revealed.
  "ALTER TABLE bets ADD COLUMN server_hash TEXT",
  "ALTER TABLE bets ADD COLUMN client_seed TEXT"
];

function openSqlite() {
  const Database = require('better-sqlite3');
  const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'neonstake.db');
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  sqlite = new Database(DB_PATH);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(SCHEMA_SQLITE);
  return DB_PATH;
}

// A managed Postgres can be briefly unreachable while it wakes, so a single
// refused connection is not proof it is gone: try a few times with backoff.
async function connectPg(url) {
  const pg = require('pg');
  // BIGINT (int8, OID 20) defaults to string in node-postgres; our values are
  // cents/nonces well under 2^53, so parse them as numbers for clean math.
  pg.types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));
  const local = /localhost|127\.0\.0\.1/.test(url);
  const attempts = Number(process.env.DB_CONNECT_ATTEMPTS || 3);
  let lastErr = null;
  for (let i = 1; i <= attempts; i++) {
    const p = new pg.Pool({
      connectionString: url,
      ssl: local ? false : { rejectUnauthorized: false },
      connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS || 8000)
    });
    try {
      // pg can't run multiple statements with parameters, but plain
      // multi-statement DDL via a single query string is fine.
      await p.query(SCHEMA_PG);
      return p;
    } catch (e) {
      lastErr = e;
      try { await p.end(); } catch (_) { /* pool never came up */ }
      if (i < attempts) await new Promise((r) => { setTimeout(r, 1000 * 2 ** (i - 1)); });
    }
  }
  throw lastErr;
}

async function init() {
  if (usePg) {
    const url = process.env.DATABASE_URL;
    try {
      pool = await connectPg(url);
      storage.engine = 'postgres';
      console.log('Storage: PostgreSQL');
    } catch (e) {
      // The database is configured but unreachable — most often a free-tier
      // Postgres that has expired. Refusing to boot takes the whole site down
      // and shows visitors nothing at all; running on local SQLite keeps the
      // casino playable. That disk is ephemeral on most hosts, so this is a
      // loud, visible degradation, not a silent one. DB_FALLBACK=0 opts out
      // and restores fail-fast for deployments where losing writes is worse
      // than being down.
      if (process.env.DB_FALLBACK === '0') throw e;
      usePg = false;
      storage.engine = 'sqlite';
      storage.degraded = true;
      storage.reason = 'postgres-unreachable: ' + (e && e.message ? e.message : String(e));
      console.error('=================================================================');
      console.error('DATABASE_URL is set but Postgres could not be reached:');
      console.error('  ' + storage.reason);
      console.error('Falling back to SQLite so the site still runs. THIS DISK IS');
      console.error('EPHEMERAL on free hosting — accounts and balances will reset');
      console.error('on the next deploy or restart. Recreate/repair the database');
      console.error('and redeploy to restore persistence. Set DB_FALLBACK=0 to');
      console.error('fail fast instead of degrading.');
      console.error('=================================================================');
      const at = openSqlite();
      console.log('Storage: SQLite (DEGRADED fallback) at ' + at);
    }
  } else {
    storage.engine = 'sqlite';
    console.log('Storage: SQLite at ' + openSqlite());
  }
  // Run idempotent migrations after the base schema. Both engines throw a
  // recognisable duplicate-column message when the column already exists;
  // anything else is real and should bubble up.
  const dupRe = /duplicate column|already exists/i;
  for (const sql of MIGRATIONS) {
    try { await query(sql); }
    catch (e) { if (!dupRe.test(String(e?.message))) throw e; }
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

module.exports = {
  init, query, tx, getSetting, setSetting, sessionSecret,
  get USE_PG() { return usePg; },
  storage
};
