'use strict';

// An alert rule is "tell me about lots that look like this and clear these
// numbers". Filters decide which lots are even considered; thresholds decide
// whether a considered lot is worth waking you up for.
const crypto = require('node:crypto');

const CHANNEL_TYPES = ['console', 'webhook', 'slack', 'discord', 'file'];

const FILTER_KEYS = ['sources', 'categories', 'conditions', 'states', 'keywords', 'excludeKeywords',
  'minQuantity', 'maxQuantity', 'maxLandedCost', 'maxCurrentBid', 'closingWithinHours', 'maxBidCount'];
const THRESHOLD_KEYS = ['minMarginPct', 'minProfit', 'minRoi', 'minConfidence', 'minScore'];

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
}

function asArray(value) {
  if (value === undefined || value === null || value === '') return [];
  return (Array.isArray(value) ? value : String(value).split(','))
    .map((entry) => String(entry).trim())
    .filter(Boolean);
}

function asNumber(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// Percentages are a classic foot-gun here: "35" means 35%, "0.35" means the
// same thing. Anything above 1 is read as a percentage.
function asFraction(value) {
  const parsed = asNumber(value);
  if (parsed === undefined) return undefined;
  return parsed > 1 ? parsed / 100 : parsed;
}

function normalizeChannel(channel) {
  const type = String(channel && channel.type || 'console').toLowerCase();
  if (!CHANNEL_TYPES.includes(type)) {
    throw new Error(`unknown channel type "${type}" (expected one of ${CHANNEL_TYPES.join(', ')})`);
  }
  if (['webhook', 'slack', 'discord'].includes(type)) {
    if (!channel.url) throw new Error(`${type} channel needs a url`);
    let parsed;
    try {
      parsed = new URL(channel.url);
    } catch {
      throw new Error(`${type} channel url is not a valid URL: ${channel.url}`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(`${type} channel url must be http or https`);
    }
  }
  if (type === 'file' && !channel.path) throw new Error('file channel needs a path');
  return { ...channel, type };
}

function normalizeRule(input, defaults = {}) {
  if (!input || typeof input !== 'object') throw new Error('rule must be an object');
  const name = String(input.name || '').trim();
  if (!name) throw new Error('rule needs a name');

  const filters = {};
  const rawFilters = input.filters || {};
  for (const key of FILTER_KEYS) {
    const value = rawFilters[key];
    if (value === undefined || value === null || value === '') continue;
    if (key.startsWith('min') || key.startsWith('max') || key === 'closingWithinHours') {
      const parsed = asNumber(value);
      if (parsed !== undefined) filters[key] = parsed;
    } else {
      const parsed = asArray(value);
      if (parsed.length) filters[key] = parsed;
    }
  }

  const thresholds = {};
  const rawThresholds = { ...(defaults.thresholds || {}), ...(input.thresholds || {}) };
  for (const key of THRESHOLD_KEYS) {
    const value = rawThresholds[key];
    if (value === undefined || value === null || value === '') continue;
    const parsed = key === 'minMarginPct' || key === 'minRoi' || key === 'minConfidence'
      ? asFraction(value)
      : asNumber(value);
    if (parsed !== undefined) thresholds[key] = parsed;
  }

  const channels = (input.channels && input.channels.length ? input.channels : [{ type: 'console' }])
    .map(normalizeChannel);

  const now = new Date().toISOString();
  return {
    id: String(input.id || `${slug(name)}-${crypto.randomBytes(3).toString('hex')}`),
    name,
    enabled: input.enabled === undefined ? true : Boolean(input.enabled),
    notes: input.notes ? String(input.notes) : null,
    filters,
    thresholds,
    channels,
    cooldownMinutes: asNumber(input.cooldownMinutes) ?? defaults.cooldownMinutes ?? 360,
    rebidPct: asFraction(input.rebidPct) ?? defaults.rebidPct ?? 0.15,
    createdAt: input.createdAt || now,
    updatedAt: now,
  };
}

// The rule a first-time user gets: everything the default thresholds consider a
// deal, delivered to the console and the dashboard.
function defaultRule(config) {
  return normalizeRule({
    id: 'default',
    name: 'Any deal clearing my thresholds',
    notes: 'Created automatically on first run. Edit or disable it once you have rules of your own.',
    thresholds: config.thresholds,
    channels: channelsFromConfig(config),
  }, { cooldownMinutes: config.alertCooldownMinutes, rebidPct: config.alertRebidPct });
}

function channelsFromConfig(config) {
  const channels = [{ type: 'console' }];
  if (config.webhookUrl) channels.push({ type: 'webhook', url: config.webhookUrl });
  if (config.slackWebhookUrl) channels.push({ type: 'slack', url: config.slackWebhookUrl });
  if (config.discordWebhookUrl) channels.push({ type: 'discord', url: config.discordWebhookUrl });
  return channels;
}

function listRules(store) {
  return store.collection('rules').all().sort((a, b) => a.name.localeCompare(b.name));
}

function saveRule(store, input, defaults) {
  const rule = normalizeRule(input, defaults);
  const existing = store.collection('rules').get(rule.id);
  if (existing) rule.createdAt = existing.createdAt;
  store.collection('rules').put(rule);
  return rule;
}

function deleteRule(store, id) {
  return store.collection('rules').delete(id);
}

function ensureDefaultRule(store, config) {
  const rules = store.collection('rules');
  if (rules.count() > 0) return null;
  const rule = defaultRule(config);
  rules.put(rule);
  return rule;
}

module.exports = {
  normalizeRule, defaultRule, ensureDefaultRule, channelsFromConfig,
  listRules, saveRule, deleteRule, asFraction, asArray, CHANNEL_TYPES,
};
