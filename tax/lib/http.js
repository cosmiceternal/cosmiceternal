'use strict';

/* Small fetch wrapper: timeout, identifying User-Agent, and bounded retry with
 * exponential backoff for transient failures (network errors, 429, 5xx).
 *
 * Also exports text helpers used to turn the official HTML/XML payloads into
 * clean plain text without pulling in a heavyweight parser dependency. */

const { http: cfg } = require('./config');

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* Raw fetch with timeout + retries. Returns the Response on a non-retryable
 * status (including 4xx like 404) so callers can branch on res.ok / res.status.
 * Throws only when every attempt fails to produce a response. */
async function request(url, { method = 'GET', headers = {}, body, retries = 2, timeoutMs = cfg.timeoutMs } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: { 'User-Agent': cfg.userAgent, 'Accept': '*/*', ...headers },
        body,
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (RETRYABLE_STATUS.has(res.status) && attempt < retries) {
        await sleep(400 * 2 ** attempt + Math.floor(Math.random() * 200));
        continue;
      }
      return res;
    } catch (e) {
      // Network/abort error — retry if attempts remain.
      lastErr = e;
      if (attempt < retries) {
        await sleep(400 * 2 ** attempt + Math.floor(Math.random() * 200));
        continue;
      }
    }
  }
  const err = new Error(`Request failed: ${url} — ${lastErr?.message || 'no response'}`);
  err.cause = lastErr;
  err.network = true;
  throw err;
}

async function getJson(url, opts) {
  const res = await request(url, { ...opts, headers: { Accept: 'application/json', ...(opts?.headers || {}) } });
  if (!res.ok) {
    const e = new Error(`HTTP ${res.status} for ${url}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

async function postJson(url, payload, opts) {
  const res = await request(url, {
    ...opts,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(opts?.headers || {}) },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const e = new Error(`HTTP ${res.status} for ${url}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

async function getText(url, opts) {
  const res = await request(url, opts);
  if (!res.ok) {
    const e = new Error(`HTTP ${res.status} for ${url}`);
    e.status = res.status;
    throw e;
  }
  return res.text();
}

// ---- HTML / XML → text ----

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&apos;': "'", '&nbsp;': ' ', '&mdash;': '—', '&ndash;': '–', '&sect;': '§'
};

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&[a-zA-Z]+;/g, (m) => ENTITIES[m] ?? m);
}

function safeCodePoint(n) {
  try { return Number.isFinite(n) ? String.fromCodePoint(n) : ''; }
  catch { return ''; }
}

/* Strip markup to readable plain text. Block-level tags become line breaks so
 * the statute's structure (subsections, paragraphs) survives as whitespace. */
function stripMarkup(input) {
  if (!input) return '';
  let s = String(input);
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  // Block elements → newline before strip.
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|section|subsection|paragraph|heading|content|chapeau)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ');
  return s.trim();
}

module.exports = { request, getJson, postJson, getText, stripMarkup, decodeEntities };
