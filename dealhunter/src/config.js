'use strict';

// Configuration resolution order (last wins):
//   built-in defaults  ->  dealhunter.config.json  ->  environment variables
//
// Every knob has a sane default, so `dealhunter serve` works with no setup at
// all. The economics defaults are deliberately conservative: they are the
// numbers a US reseller flipping GovDeals/ITAD lots on a general marketplace
// would start from, and they are meant to be calibrated to your own operation.
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  // --- Runtime ---
  port: 3100,
  host: '0.0.0.0',
  dataDir: './var',
  logLevel: 'info',
  logFormat: 'text',
  apiToken: '',

  // --- Scraping ---
  sources: ['sample'],
  scrapeIntervalMs: 15 * 60 * 1000,
  scrapeJitterMs: 60 * 1000,
  scrapeOnStart: true,
  userAgent: 'dealhunter/1.0 (personal deal alerts; contact via repository issues)',
  requestTimeoutMs: 20000,
  requestRetries: 3,
  requestsPerSecond: 0.5,
  respectRobots: true,
  maxPagesPerSource: 3,

  // --- What we hunt ---
  categories: [],          // empty = every category
  keywords: [],            // empty = no keyword pre-filter
  excludeKeywords: ['parts only', 'scrap metal'],

  // --- Economics (all rates are fractions, not percents) ---
  costs: {
    buyerPremiumPct: 0.10,        // GovDeals buyer's premium, seller-dependent
    buyerPremiumMax: 0,           // 0 = uncapped
    salesTaxPct: 0,               // 0 if you hold a resale certificate
    inboundFreightFlat: 150,      // pallet freight / your own truck+time per lot
    inboundFreightPerUnit: 3,
    refurbCostPerUnit: 15,        // wipe, test, clean, parts
    listingCostPerUnit: 2,        // photos, packaging, labels
    marketplaceFeePct: 0.13,      // marketplace final-value fee
    paymentFeePct: 0,             // folded into the fee above on most venues
    outboundShipPerUnit: 18,      // what you eat on shipping, per unit sold
    sellThroughPct: 0.9,          // fraction of units you actually expect to sell
    // Per-category overrides, merged over the flat numbers above.
    byCategory: {
      servers: { refurbCostPerUnit: 45, outboundShipPerUnit: 65, inboundFreightFlat: 250 },
      networking: { refurbCostPerUnit: 20, outboundShipPerUnit: 22 },
      laptops: { refurbCostPerUnit: 25, outboundShipPerUnit: 18 },
      desktops: { refurbCostPerUnit: 20, outboundShipPerUnit: 25 },
      monitors: { refurbCostPerUnit: 8, outboundShipPerUnit: 30 },
      phones: { refurbCostPerUnit: 12, outboundShipPerUnit: 8 },
      tablets: { refurbCostPerUnit: 12, outboundShipPerUnit: 10 },
      storage: { refurbCostPerUnit: 10, outboundShipPerUnit: 12 },
      testequipment: { refurbCostPerUnit: 35, outboundShipPerUnit: 25 },
      printers: { refurbCostPerUnit: 25, outboundShipPerUnit: 45 },
      vehicles: { refurbCostPerUnit: 0, outboundShipPerUnit: 0, marketplaceFeePct: 0.02, inboundFreightFlat: 0, inboundFreightPerUnit: 0 },
      heavyequipment: { refurbCostPerUnit: 0, outboundShipPerUnit: 0, marketplaceFeePct: 0.05, inboundFreightFlat: 0, inboundFreightPerUnit: 0 },
    },
  },

  // --- Default thresholds a lot must clear to count as a "deal" ---
  thresholds: {
    minMarginPct: 0.35,
    minProfit: 150,
    minRoi: 0.4,
    minConfidence: 0.35,
  },

  // --- Alerting ---
  alertCooldownMinutes: 360,
  alertRebidPct: 0.15,     // re-alert if the bid moves this much and it still clears
  notifyTimeoutMs: 10000,
};

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return patch === undefined ? base : patch;
  }
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const target = base && base[key];
    if (value && typeof value === 'object' && !Array.isArray(value)
        && target && typeof target === 'object' && !Array.isArray(target)) {
      out[key] = deepMerge(target, value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function num(raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

function list(raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

// Only variables that are actually set produce a patch key, so an unset
// variable never clobbers a value that came from the config file.
function fromEnv(env) {
  const patch = { costs: {}, thresholds: {} };
  const scalars = [
    ['host', 'HOST', (v) => v],
    ['dataDir', 'DEALHUNTER_DATA_DIR', (v) => v],
    ['logLevel', 'LOG_LEVEL', (v) => v],
    ['logFormat', 'LOG_FORMAT', (v) => v],
    ['apiToken', 'API_TOKEN', (v) => v],
    ['userAgent', 'USER_AGENT', (v) => v],
    ['webhookUrl', 'WEBHOOK_URL', (v) => v],
    ['slackWebhookUrl', 'SLACK_WEBHOOK_URL', (v) => v],
    ['discordWebhookUrl', 'DISCORD_WEBHOOK_URL', (v) => v],
    ['govdealsSearchUrl', 'GOVDEALS_SEARCH_URL', (v) => v],
    ['itadRecipesPath', 'ITAD_RECIPES', (v) => v],
    ['port', 'PORT', (v) => num(v, DEFAULTS.port)],
    ['scrapeIntervalMs', 'SCRAPE_INTERVAL_MS', (v) => num(v, DEFAULTS.scrapeIntervalMs)],
    ['requestTimeoutMs', 'REQUEST_TIMEOUT_MS', (v) => num(v, DEFAULTS.requestTimeoutMs)],
    ['requestsPerSecond', 'REQUESTS_PER_SECOND', (v) => num(v, DEFAULTS.requestsPerSecond)],
    ['maxPagesPerSource', 'MAX_PAGES_PER_SOURCE', (v) => num(v, DEFAULTS.maxPagesPerSource)],
    ['alertCooldownMinutes', 'ALERT_COOLDOWN_MINUTES', (v) => num(v, DEFAULTS.alertCooldownMinutes)],
    ['scrapeOnStart', 'SCRAPE_ON_START', (v) => bool(v, true)],
    ['respectRobots', 'RESPECT_ROBOTS', (v) => bool(v, true)],
    ['sources', 'SOURCES', (v) => list(v, DEFAULTS.sources)],
    ['categories', 'CATEGORIES', (v) => list(v, [])],
    ['keywords', 'KEYWORDS', (v) => list(v, [])],
    ['excludeKeywords', 'EXCLUDE_KEYWORDS', (v) => list(v, [])],
  ];
  for (const [key, envName, parse] of scalars) {
    if (env[envName] !== undefined && env[envName] !== '') patch[key] = parse(env[envName]);
  }

  const costVars = [
    ['buyerPremiumPct', 'BUYER_PREMIUM_PCT'],
    ['salesTaxPct', 'SALES_TAX_PCT'],
    ['marketplaceFeePct', 'MARKETPLACE_FEE_PCT'],
    ['inboundFreightFlat', 'INBOUND_FREIGHT_FLAT'],
    ['refurbCostPerUnit', 'REFURB_COST_PER_UNIT'],
    ['outboundShipPerUnit', 'OUTBOUND_SHIP_PER_UNIT'],
    ['sellThroughPct', 'SELL_THROUGH_PCT'],
  ];
  for (const [key, envName] of costVars) {
    if (env[envName] !== undefined && env[envName] !== '') patch.costs[key] = num(env[envName], DEFAULTS.costs[key]);
  }

  const thresholdVars = [
    ['minMarginPct', 'MIN_MARGIN_PCT'],
    ['minProfit', 'MIN_PROFIT'],
    ['minRoi', 'MIN_ROI'],
    ['minConfidence', 'MIN_CONFIDENCE'],
  ];
  for (const [key, envName] of thresholdVars) {
    if (env[envName] !== undefined && env[envName] !== '') patch.thresholds[key] = num(env[envName], DEFAULTS.thresholds[key]);
  }

  if (!Object.keys(patch.costs).length) delete patch.costs;
  if (!Object.keys(patch.thresholds).length) delete patch.thresholds;
  return patch;
}

function readConfigFile(file) {
  if (!file || !fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`config file ${file} is not valid JSON: ${err.message}`);
  }
}

function loadConfig(options = {}) {
  const env = options.env || process.env;
  const root = options.root || process.cwd();
  const file = options.configFile !== undefined
    ? options.configFile
    : (env.DEALHUNTER_CONFIG || path.join(root, 'dealhunter.config.json'));

  let config = deepMerge(DEFAULTS, readConfigFile(file));
  config = deepMerge(config, fromEnv(env));
  config = deepMerge(config, options.overrides || {});
  config.dataDir = path.resolve(root, config.dataDir);
  config.configFile = file || null;
  return config;
}

// Flatten the cost model for one category: the flat numbers with that
// category's overrides applied on top.
function costsFor(config, category) {
  const { byCategory, ...flat } = config.costs;
  return { ...flat, ...((byCategory && byCategory[category]) || {}) };
}

module.exports = { loadConfig, costsFor, deepMerge, DEFAULTS };
