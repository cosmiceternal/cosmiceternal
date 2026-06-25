'use strict';

/* Central, validated configuration for the tax-code reader.
 *
 * Everything is environment-driven so the service can be deployed without code
 * changes. Defaults are chosen so a bare `npm start` does something sensible
 * and *private*: it binds to localhost and, if no access token is supplied,
 * mints a random one and prints it at boot rather than running wide open. */

const crypto = require('crypto');

function intEnv(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : def;
}

// The access token gates every /api route. We never want to silently run an
// open tax service, so if the operator didn't set one we generate a single
// ephemeral token for this process and surface it at startup.
let _generatedToken = null;
function accessToken() {
  if (process.env.TAX_ACCESS_TOKEN) return process.env.TAX_ACCESS_TOKEN;
  if (!_generatedToken) _generatedToken = crypto.randomBytes(24).toString('hex');
  return _generatedToken;
}
const tokenWasGenerated = () => !process.env.TAX_ACCESS_TOKEN;

const config = {
  port: intEnv('TAX_PORT', 4000),
  // Private by default. Set TAX_HOST=0.0.0.0 only behind your own auth/proxy.
  host: process.env.TAX_HOST || '127.0.0.1',

  accessToken,
  tokenWasGenerated,

  // ---- Official data sources ----
  // govinfo (GPO) is the authoritative API for the US Code. A free api.data.gov
  // key lifts the tight DEMO_KEY rate limits; DEMO_KEY works for light use.
  govinfo: {
    base: process.env.GOVINFO_API_BASE || 'https://api.govinfo.gov',
    apiKey: process.env.GOVINFO_API_KEY || 'DEMO_KEY'
  },
  // Cornell LII — clean, deterministic per-section URLs; used as a fallback for
  // verbatim section text when govinfo granule resolution is unavailable.
  cornell: {
    base: process.env.CORNELL_BASE || 'https://www.law.cornell.edu'
  },
  // eCFR — the official, well-structured API for the Code of Federal
  // Regulations. Title 26 here is the Treasury (IRS) regulations — the
  // "everything in between" that interprets the statute.
  ecfr: {
    base: process.env.ECFR_API_BASE || 'https://www.ecfr.gov'
  },
  // Federal Register — official, clean JSON API (no key). Covers IRS-authored
  // rulemaking and guidance published in the FR: Treasury Decisions (final
  // regs), proposed regs, and IRS notices. (Rev. Ruls/Rev. Procs are published
  // only in the Internal Revenue Bulletin, which has no public API.)
  federalRegister: {
    base: process.env.FED_REGISTER_API_BASE || 'https://www.federalregister.gov'
  },
  // CourtListener (Free Law Project) — federal tax case law. Works without a
  // token at a lower rate limit; set COURTLISTENER_API_TOKEN for headroom.
  courtListener: {
    base: process.env.COURTLISTENER_BASE || 'https://www.courtlistener.com',
    token: process.env.COURTLISTENER_API_TOKEN || ''
  },

  // ---- AI answers ----
  ai: {
    enabled: !!process.env.ANTHROPIC_API_KEY,
    // Tax reasoning rewards a strong model; default to Sonnet for cost/quality,
    // override to claude-opus-4-8 for the hardest questions.
    model: process.env.TAX_AI_MODEL || 'claude-sonnet-4-6',
    maxTokens: intEnv('TAX_AI_MAX_TOKENS', 1500),
    timeoutMs: intEnv('TAX_AI_TIMEOUT_MS', 60_000)
  },

  http: {
    timeoutMs: intEnv('TAX_HTTP_TIMEOUT_MS', 15_000),
    userAgent: process.env.TAX_USER_AGENT ||
      'tax-code-reader/0.1 (+private financial-research tool)'
  },

  cache: {
    max: intEnv('TAX_CACHE_MAX', 500),
    ttlMs: intEnv('TAX_CACHE_TTL_MS', 6 * 60 * 60 * 1000) // statute changes slowly
  }
};

module.exports = config;
