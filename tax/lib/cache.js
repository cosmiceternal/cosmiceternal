'use strict';

/* Tiny TTL + LRU cache shared by the source fetchers. Statute and regulation
 * text changes on the order of months, so caching aggressively keeps us well
 * under govinfo's rate limits and makes repeat lookups instant. */

const { cache: cfg } = require('./config');

class TtlLru {
  constructor(max = cfg.max, ttlMs = cfg.ttlMs) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.map = new Map(); // key -> { value, ts }
  }

  get(key) {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (Date.now() - e.ts > this.ttlMs) { this.map.delete(key); return undefined; }
    // refresh recency
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  set(key, value) {
    this.map.set(key, { value, ts: Date.now() });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
    return value;
  }

  /* Convenience: return cached value or compute, store, and return it.
   * Failures are never cached, so a transient network error doesn't get
   * pinned for the whole TTL. */
  async wrap(key, fn) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const value = await fn();
    return this.set(key, value);
  }
}

module.exports = { TtlLru };
