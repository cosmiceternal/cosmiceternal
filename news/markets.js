'use strict';

// markets.js — free, no-API-key international stock index quotes.
//
// Uses Stooq's lightweight CSV quote endpoint, which needs no key. If it's
// unreachable the caller just shows nothing. Change shown is the latest
// session's move (close vs open), which is a good glanceable indicator.

const https = require('https');

const TIMEOUT_MS = 8000;
const CACHE_TTL = 60 * 1000;
let cache = { time: 0, data: null };

// Stooq symbol -> display name + flag. (^ prefixes are index symbols.)
const INDICES = [
  { sym: '^spx', name: 'S&P 500', flag: '🇺🇸' },
  { sym: '^ndq', name: 'Nasdaq', flag: '🇺🇸' },
  { sym: '^dji', name: 'Dow Jones', flag: '🇺🇸' },
  { sym: '^ftse', name: 'FTSE 100', flag: '🇬🇧' },
  { sym: '^dax', name: 'DAX', flag: '🇩🇪' },
  { sym: '^cac', name: 'CAC 40', flag: '🇫🇷' },
  { sym: '^nkx', name: 'Nikkei 225', flag: '🇯🇵' },
  { sym: '^hsi', name: 'Hang Seng', flag: '🇭🇰' },
];

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (news reader)' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(data));
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function num(x) {
  const n = parseFloat(x);
  return Number.isFinite(n) ? n : null;
}

// Returns [{ name, flag, price, change, pct }] (best-effort; may be []).
async function getIndices() {
  if (cache.data && Date.now() - cache.time < CACHE_TTL) return cache.data;

  const symbols = INDICES.map((i) => i.sym).join(',');
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(symbols)}&f=sd2t2ohlc&h&e=csv`;

  let rows;
  try {
    const csv = await httpGet(url);
    rows = csv.trim().split('\n').slice(1); // drop header
  } catch {
    return cache.data || []; // serve stale on failure, else empty
  }

  const bySym = {};
  for (const line of rows) {
    const [sym, , , open, , , close] = line.split(',');
    if (sym) bySym[sym.toUpperCase()] = { open: num(open), close: num(close) };
  }

  const out = INDICES.map((idx) => {
    const q = bySym[idx.sym.toUpperCase()] || {};
    let change = null;
    let pct = null;
    if (q.open != null && q.close != null && q.open !== 0) {
      change = q.close - q.open;
      pct = (change / q.open) * 100;
    }
    return { name: idx.name, flag: idx.flag, price: q.close, change, pct };
  });

  cache = { time: Date.now(), data: out };
  return out;
}

module.exports = { getIndices };
