'use strict';

// translate.js — free, no-API-key translation to English.
//
// Uses a public translation endpoint that does not require a key. It's an
// unofficial endpoint, so it can be rate-limited or change over time; every
// failure degrades gracefully (the caller just keeps the original text). All
// translations are cached so repeated headlines aren't re-fetched.
//
// To swap in a different engine later (e.g. a paid/AI translator), only
// translate() below needs to change.

const https = require('https');

const TIMEOUT_MS = 8000;
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours
const cache = new Map(); // key `${sl}:${text}` -> { time, value }

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (news reader)' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// Translate a single piece of text to English. Returns the translation, or
// null if it can't be translated (caller should fall back to the original).
async function translate(text, sourceLang = 'auto') {
  const clean = (text || '').trim();
  if (!clean) return null;
  if (sourceLang === 'en') return null; // already English

  const key = `${sourceLang}:${clean}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < CACHE_TTL) return hit.value;

  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx' +
    `&sl=${encodeURIComponent(sourceLang)}&tl=en&dt=t&q=${encodeURIComponent(clean)}`;

  try {
    const json = await httpGetJson(url);
    // json[0] is an array of segments: [ [translated, original, ...], ... ]
    const out = (json[0] || []).map((seg) => (seg && seg[0]) || '').join('').trim();
    const value = out || null;
    cache.set(key, { time: Date.now(), value });
    return value;
  } catch {
    return null; // network/parse failure -> caller keeps original text
  }
}

// Run an async mapper over items with limited concurrency, so a station with
// many headlines doesn't fire dozens of requests at once.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

module.exports = { translate, mapLimit };
