'use strict';

// A polite HTTP client for scraping: per-host rate limiting, robots.txt
// compliance, bounded retries with exponential backoff, and hard timeouts.
//
// Auction sites are small operations behind CDNs. Hammering them gets you
// blocked and is rude, so the default is one request every two seconds per
// host and we honour both robots.txt and Retry-After.

const DEFAULT_UA = 'dealhunter/1.0';

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// Token bucket, one per host. `ratePerSecond` of 0.5 means a request every 2s.
class RateLimiter {
  constructor(ratePerSecond, burst = 1) {
    this.rate = Math.max(ratePerSecond, 0.01);
    this.capacity = Math.max(burst, 1);
    this.tokens = this.capacity;
    this.last = Date.now();
    this.minIntervalMs = 0;
  }

  setMinInterval(ms) {
    this.minIntervalMs = Math.max(this.minIntervalMs, ms || 0);
  }

  async take() {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.rate);
      this.last = now;
      const effectiveWait = this.minIntervalMs ? Math.max(0, this.lastTakeAt ? this.lastTakeAt + this.minIntervalMs - now : 0) : 0;
      if (this.tokens >= 1 && effectiveWait === 0) {
        this.tokens -= 1;
        this.lastTakeAt = now;
        return;
      }
      const tokenWait = this.tokens >= 1 ? 0 : ((1 - this.tokens) / this.rate) * 1000;
      await sleep(Math.max(10, Math.ceil(Math.max(tokenWait, effectiveWait))));
    }
  }
}

// robots.txt is a line-oriented format with agent groups. We keep only the
// group for our agent (or `*`) and apply the longest-match rule, with Allow
// winning ties, which is what the major crawlers do.
function parseRobots(text, agent) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], crawlDelay: 0 };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    if (!current) continue;
    lastWasAgent = false;
    if (field === 'disallow') current.rules.push({ allow: false, path: value });
    else if (field === 'allow') current.rules.push({ allow: true, path: value });
    else if (field === 'crawl-delay') {
      const delay = Number(value);
      if (Number.isFinite(delay)) current.crawlDelay = delay;
    }
  }

  const token = String(agent || DEFAULT_UA).toLowerCase();
  const named = groups.find((g) => g.agents.some((a) => a !== '*' && token.includes(a)));
  const wildcard = groups.find((g) => g.agents.includes('*'));
  const group = named || wildcard;
  if (!group) return { allows: () => true, crawlDelay: 0 };

  return {
    crawlDelay: group.crawlDelay,
    allows(pathname) {
      let best = null;
      for (const rule of group.rules) {
        if (rule.path === '') {
          // "Disallow:" with an empty value means allow everything.
          if (!rule.allow) continue;
        }
        if (!matchesRobotsPattern(rule.path, pathname)) continue;
        const weight = rule.path.length;
        if (!best || weight > best.weight || (weight === best.weight && rule.allow)) {
          best = { allow: rule.allow, weight };
        }
      }
      return best ? best.allow : true;
    },
  };
}

// Supports the two wildcards the spec added: `*` (any run of characters) and
// `$` (end of path).
function matchesRobotsPattern(pattern, pathname) {
  if (pattern === '') return false;
  if (!pattern.includes('*') && !pattern.endsWith('$')) return pathname.startsWith(pattern);
  const anchoredEnd = pattern.endsWith('$');
  const body = anchoredEnd ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}${anchoredEnd ? '$' : ''}`).test(pathname);
}

function createHttpClient(options = {}) {
  const userAgent = options.userAgent || DEFAULT_UA;
  const timeoutMs = options.timeoutMs || 20000;
  const retries = options.retries ?? 3;
  const ratePerSecond = options.requestsPerSecond ?? 0.5;
  const respectRobots = options.respectRobots !== false;
  const log = options.log || { debug() {}, warn() {}, info() {}, error() {} };
  const fetchImpl = options.fetch || globalThis.fetch;
  const limiters = new Map();
  const robotsCache = new Map();

  function limiterFor(host) {
    let limiter = limiters.get(host);
    if (!limiter) {
      limiter = new RateLimiter(ratePerSecond);
      limiters.set(host, limiter);
    }
    return limiter;
  }

  async function rawFetch(url, init, attemptTimeout) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), attemptTimeout);
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function robotsFor(origin) {
    if (!respectRobots) return { allows: () => true, crawlDelay: 0 };
    if (robotsCache.has(origin)) return robotsCache.get(origin);
    const promise = (async () => {
      try {
        const res = await rawFetch(`${origin}/robots.txt`, {
          headers: { 'user-agent': userAgent, accept: 'text/plain' },
          redirect: 'follow',
        }, Math.min(timeoutMs, 10000));
        if (res.status >= 400) return { allows: () => true, crawlDelay: 0 };
        return parseRobots(await res.text(), userAgent);
      } catch (err) {
        // If robots.txt is unreachable we stay conservative on rate but do not
        // block the crawl outright, matching common crawler behaviour.
        log.debug('robots.txt unreachable, proceeding', { origin, error: err.message });
        return { allows: () => true, crawlDelay: 0 };
      }
    })();
    robotsCache.set(origin, promise);
    return promise;
  }

  function backoffMs(attempt, retryAfterHeader) {
    if (retryAfterHeader) {
      const seconds = Number(retryAfterHeader);
      if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 60000);
      const at = Date.parse(retryAfterHeader);
      if (Number.isFinite(at)) return Math.min(Math.max(at - Date.now(), 0), 60000);
    }
    const base = 500 * 2 ** attempt;
    return Math.min(base + Math.random() * 250, 30000);
  }

  async function request(url, init = {}) {
    const target = new URL(url);
    const robots = await robotsFor(target.origin);
    if (!robots.allows(target.pathname)) {
      const err = new Error(`robots.txt disallows ${target.pathname} on ${target.origin}`);
      err.code = 'ROBOTS_DISALLOWED';
      throw err;
    }
    const limiter = limiterFor(target.host);
    if (robots.crawlDelay) limiter.setMinInterval(robots.crawlDelay * 1000);

    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      await limiter.take();
      try {
        const res = await rawFetch(url, {
          ...init,
          headers: {
            'user-agent': userAgent,
            accept: init.accept || 'application/json, text/html;q=0.9, */*;q=0.5',
            'accept-language': 'en-US,en;q=0.9',
            ...(init.headers || {}),
          },
          redirect: 'follow',
        }, timeoutMs);

        if (res.status === 429 || res.status >= 500) {
          lastError = new Error(`HTTP ${res.status} from ${url}`);
          lastError.status = res.status;
          if (attempt === retries) break;
          const wait = backoffMs(attempt, res.headers.get('retry-after'));
          log.debug('retrying after server pushback', { url, status: res.status, waitMs: Math.round(wait) });
          await sleep(wait);
          continue;
        }

        const text = await res.text();
        return {
          ok: res.ok,
          status: res.status,
          url: res.url || url,
          headers: res.headers,
          text,
          json() {
            try {
              return JSON.parse(text);
            } catch (err) {
              throw new Error(`response from ${url} was not JSON: ${err.message}`);
            }
          },
        };
      } catch (err) {
        lastError = err;
        if (err.code === 'ROBOTS_DISALLOWED') throw err;
        if (attempt === retries) break;
        const wait = backoffMs(attempt);
        log.debug('retrying after network error', { url, error: err.message, waitMs: Math.round(wait) });
        await sleep(wait);
      }
    }
    const failure = new Error(`request to ${url} failed after ${retries + 1} attempts: ${lastError && lastError.message}`);
    failure.cause = lastError;
    if (lastError && lastError.status) failure.status = lastError.status;
    throw failure;
  }

  async function getJson(url, init) {
    const res = await request(url, { ...init, accept: 'application/json' });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} from ${url}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  async function getText(url, init) {
    const res = await request(url, init);
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} from ${url}`);
      err.status = res.status;
      throw err;
    }
    return res.text;
  }

  return { request, getJson, getText, parseRobots, userAgent };
}

module.exports = { createHttpClient, parseRobots, matchesRobotsPattern, RateLimiter, sleep };
