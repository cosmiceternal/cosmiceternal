'use strict';

/* Live AI dealer banter via the Anthropic API, with an in-memory LRU cache so
 * repeat events for the same dealer + state don't re-hit the API. If no
 * ANTHROPIC_API_KEY is set the endpoint returns { line: null } and the client
 * transparently falls back to its built-in scripted persona library.
 *
 * Design notes:
 *  - Tiny model (haiku) — fast and cheap; we want sub-second responses.
 *  - Hard-coded ~50-token cap so a runaway prompt can't rack up bills.
 *  - Cache key is intentionally coarse (dealer + event + bucketed state) so a
 *    busy table hits warm cache after the first few hands. */

const crypto = require('crypto');
const { httpError } = require('./auth');

const ENABLED = !!process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.DEALER_MODEL || 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = Number(process.env.DEALER_TIMEOUT_MS || 1500);
const CACHE_MAX = 500;
const CACHE_TTL_MS = 60 * 60 * 1000;

const PERSONAS = {
  vivienne: { name: 'Vivienne', style: 'a smooth, unflappable casino dealer with dry wit and elegant phrasing — short, never effusive' },
  rocco:    { name: 'Rocco',    style: 'a gruff old-school New York pit boss — terse, no nonsense, occasional ribbing' },
  luna:     { name: 'Luna',     style: 'a cheerful chatty dealer who roots for the player, warm and a little playful, light emoji okay' },
  kade:     { name: 'Kade',     style: 'a cool, dry, slightly mysterious dealer — short evocative phrasing, never sappy' }
};
// Per-persona system prompts, pre-built once at module load (instead of per call).
const SYSTEM_PROMPTS = Object.fromEntries(Object.entries(PERSONAS).map(([id, p]) => [id,
  `You are ${p.name}, ${p.style}. You are dealing a play-money blackjack hand. ` +
  `Respond with EXACTLY ONE short line (max 12 words) in character — no quotes, no preamble, no narration. ` +
  `Never reveal you are an AI; never break character; never give strategy advice.`
]));

// Per-event prompt templates. The function receives sanitized ctx (numbers
// only) and returns the user-message text. Module-scoped so we don't rebuild
// the object on every request.
const EVENT_DESCRIBE = {
  greet:      ()    => 'You are greeting a new player who just sat down.',
  bet:        ()    => 'The player is taking their time placing a bet.',
  deal:       ()    => 'You are dealing the opening cards.',
  hit:        ()    => 'The player just chose to hit.',
  stand:      (ctx) => `The player just stood on ${ctx?.playerTotal ?? '?'}.`,
  dbl:        (ctx) => `The player just doubled down on ${ctx?.playerTotal ?? '?'}.`,
  playerBJ:   ()    => 'The player got blackjack on the deal.',
  playerWin:  (ctx) => `The player won this hand (${ctx?.playerTotal ?? '?'} vs your ${ctx?.dealerTotal ?? '?'}).`,
  playerLose: (ctx) => `The player lost this hand (${ctx?.playerTotal ?? '?'} vs your ${ctx?.dealerTotal ?? '?'}).`,
  push:       ()    => 'The hand pushed (a tie).',
  bust:       (ctx) => `The player busted at ${ctx?.playerTotal ?? '?'}.`,
  dealerBust: (ctx) => `You busted at ${ctx?.dealerTotal ?? '?'}; the player wins.`
};
const EVENTS = new Set(Object.keys(EVENT_DESCRIBE));

const cache = new Map(); // key -> { line, ts }
function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL_MS) { cache.delete(key); return null; }
  // LRU: refresh insertion order
  cache.delete(key); cache.set(key, e);
  return e.line;
}
function cacheSet(key, line) {
  cache.set(key, { line, ts: Date.now() });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

function bucketState(ctx) {
  if (!ctx) return '';
  // Bucket player/dealer totals so similar hands share cache entries.
  const buckets = [];
  if (ctx.playerTotal != null) buckets.push('p' + (ctx.playerTotal >= 21 ? 21 : Math.floor(ctx.playerTotal / 3) * 3));
  if (ctx.dealerTotal != null) buckets.push('d' + (ctx.dealerTotal >= 21 ? 21 : Math.floor(ctx.dealerTotal / 3) * 3));
  return buckets.join(':');
}

let _client = null;
function client() {
  if (_client) return _client;
  const Anthropic = require('@anthropic-ai/sdk').default;
  _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

async function generate(persona, event, ctx) {
  const system = SYSTEM_PROMPTS[persona];
  const describe = EVENT_DESCRIBE[event];
  if (!system || !describe) throw new Error('unknown persona or event');
  const eventDescription = describe(ctx);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    // Cache the per-persona system prompt across calls — Anthropic prompt
    // caching keeps the cost flat across a busy table.
    const resp = await client().messages.create({
      model: MODEL,
      max_tokens: 60,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: eventDescription }]
    }, { signal: ac.signal });
    const block = (resp.content || []).find(b => b.type === 'text');
    let line = (block?.text || '').trim();
    // Strip wrapping quotes the model sometimes adds despite instructions.
    line = line.replace(/^["“'`]+|["”'`]+$/g, '').trim();
    if (line.length > 140) line = line.slice(0, 137) + '…';
    return line || null;
  } finally {
    clearTimeout(timer);
  }
}

async function line(req, { dealer, event, ctx }) {
  if (!PERSONAS[dealer]) throw httpError(400, 'Unknown dealer.');
  if (!EVENTS.has(event)) throw httpError(400, 'Unknown event.');
  if (!ENABLED) return { line: null, source: 'disabled' };
  // Hard-coerce every ctx field that ends up in the prompt to a small bounded
  // integer. Defence against client-driven prompt injection — only numbers
  // ever reach the system/user messages.
  const safeCtx = {};
  if (ctx && typeof ctx === 'object') {
    const p = Number(ctx.playerTotal), d = Number(ctx.dealerTotal);
    if (Number.isFinite(p) && p >= 0 && p <= 30) safeCtx.playerTotal = Math.floor(p);
    if (Number.isFinite(d) && d >= 0 && d <= 30) safeCtx.dealerTotal = Math.floor(d);
  }
  const key = `${dealer}|${event}|${bucketState(safeCtx)}`;
  const cached = cacheGet(key);
  if (cached) return { line: cached, source: 'cache' };
  try {
    const generated = await generate(dealer, event, safeCtx);
    if (generated) {
      // Stash a small batch of variant entries so the same key returns variety
      // across hits (we cache under a salted sub-key so different hits look
      // different). Skip for now — over-engineering; keep it simple.
      cacheSet(key, generated);
      return { line: generated, source: 'ai' };
    }
    return { line: null, source: 'empty' };
  } catch (e) {
    // Any failure (timeout, rate-limit, network) -> client falls back to scripted.
    return { line: null, source: 'error', error: e?.message?.slice(0, 80) };
  }
}

module.exports = { line, enabled: () => ENABLED };
