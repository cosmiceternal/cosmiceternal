'use strict';

// Delivers an alert to wherever you actually look: a webhook, Slack, Discord,
// a file, or just the log. Delivery never throws — a dead webhook must not stop
// the rest of a scrape — but every failure is returned so the caller can record
// and surface it.
const fs = require('node:fs');
const path = require('node:path');

function money(value, currency = 'USD') {
  const symbol = currency === 'USD' ? '$' : `${currency} `;
  const rounded = Math.round(Number(value) || 0);
  return `${value < 0 ? '-' : ''}${symbol}${Math.abs(rounded).toLocaleString('en-US')}`;
}

function pct(value) {
  return `${Math.round((Number(value) || 0) * 100)}%`;
}

function timeLeft(hours) {
  if (hours === null || hours === undefined) return 'no closing time';
  if (hours <= 0) return 'closed';
  if (hours < 1) return `${Math.round(hours * 60)}m left`;
  if (hours < 48) return `${Math.round(hours)}h left`;
  return `${Math.round(hours / 24)}d left`;
}

function summarize(entry) {
  const { lot, valuation, deal } = entry;
  const qty = lot.quantity > 1 ? `${lot.quantity}x ` : '';
  return {
    headline: `${money(deal.profit)} profit · ${pct(deal.marginPct)} margin · score ${deal.score}`,
    title: `${qty}${lot.title}`,
    bidLine: `Bid ${money(lot.currentBid, lot.currency)} · max bid ${money(deal.maxBid, lot.currency)} · ${timeLeft(deal.hoursToClose)}`,
    valueLine: `Est. resale ${money(valuation.totalValue)} (${valuation.method === 'comp' ? valuation.compLabel : 'category default'}, confidence ${pct(valuation.confidence)})`,
    location: lot.location && lot.location.state ? `${lot.location.city ? `${lot.location.city}, ` : ''}${lot.location.state}` : 'location unknown',
    url: lot.url,
    warnings: valuation.notes || [],
  };
}

function plainText(entry, rule) {
  const s = summarize(entry);
  const lines = [
    `[${rule.name}] ${s.headline}`,
    s.title,
    s.bidLine,
    s.valueLine,
    `${lot0(entry)} · ${s.location}`,
  ];
  if (s.warnings.length) lines.push(`⚠ ${s.warnings.join(' | ')}`);
  if (s.url) lines.push(s.url);
  return lines.join('\n');
}

function lot0(entry) {
  return `${entry.lot.source} ${entry.lot.externalId}`;
}

function slackPayload(entry, rule) {
  const s = summarize(entry);
  const fields = [
    `*Profit*\n${money(entry.deal.profit)}`,
    `*Margin*\n${pct(entry.deal.marginPct)}`,
    `*Current bid*\n${money(entry.lot.currentBid, entry.lot.currency)}`,
    `*Max bid*\n${money(entry.deal.maxBid, entry.lot.currency)}`,
    `*Closes*\n${timeLeft(entry.deal.hoursToClose)}`,
    `*Confidence*\n${pct(entry.valuation.confidence)}`,
  ];
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: `*<${s.url || 'https://example.invalid'}|${s.title}>*\n${s.valueLine}` } },
    { type: 'section', fields: fields.map((text) => ({ type: 'mrkdwn', text })) },
  ];
  if (s.warnings.length) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `⚠ ${s.warnings.join(' · ')}` }] });
  }
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `${rule.name} · ${lot0(entry)} · ${s.location}` }] });
  return { text: `${rule.name}: ${s.headline} — ${s.title}`, blocks };
}

function discordPayload(entry, rule) {
  const s = summarize(entry);
  return {
    content: `**${rule.name}** — ${s.headline}`,
    embeds: [{
      title: s.title.slice(0, 250),
      url: s.url || undefined,
      description: [s.valueLine, s.warnings.length ? `⚠ ${s.warnings.join(' · ')}` : null].filter(Boolean).join('\n'),
      color: entry.deal.marginPct >= 0.5 ? 0x2ecc71 : 0x3498db,
      fields: [
        { name: 'Profit', value: money(entry.deal.profit), inline: true },
        { name: 'Margin', value: pct(entry.deal.marginPct), inline: true },
        { name: 'ROI', value: pct(entry.deal.roi), inline: true },
        { name: 'Current bid', value: money(entry.lot.currentBid, entry.lot.currency), inline: true },
        { name: 'Max bid', value: money(entry.deal.maxBid, entry.lot.currency), inline: true },
        { name: 'Closes', value: timeLeft(entry.deal.hoursToClose), inline: true },
      ],
      footer: { text: `${lot0(entry)} · ${s.location} · confidence ${pct(entry.valuation.confidence)}` },
    }],
  };
}

function webhookPayload(entry, rule, reason) {
  return {
    rule: { id: rule.id, name: rule.name },
    reason,
    lot: {
      id: entry.lot.id,
      source: entry.lot.source,
      externalId: entry.lot.externalId,
      title: entry.lot.title,
      url: entry.lot.url,
      category: entry.lot.category,
      condition: entry.lot.condition,
      quantity: entry.lot.quantity,
      currentBid: entry.lot.currentBid,
      bidCount: entry.lot.bidCount,
      closesAt: entry.lot.closesAt,
      location: entry.lot.location,
    },
    valuation: entry.valuation,
    economics: entry.deal,
    sentAt: new Date().toISOString(),
  };
}

async function postJson(url, body, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 10000);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text().catch(() => '');
    return { ok: res.ok, status: res.status, body: text.slice(0, 500) };
  } finally {
    clearTimeout(timer);
  }
}

async function deliver(channel, entry, rule, reason, options = {}) {
  const log = options.log || { info() {}, warn() {} };
  try {
    switch (channel.type) {
      case 'console':
        log.info(plainText(entry, rule).replace(/\n/g, ' | '), { rule: rule.id, lot: entry.lot.id });
        return { channel: 'console', ok: true };
      case 'file': {
        const file = path.resolve(options.dataDir || '.', channel.path);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, JSON.stringify(webhookPayload(entry, rule, reason)) + '\n');
        return { channel: 'file', ok: true, path: file };
      }
      case 'slack': {
        const res = await postJson(channel.url, slackPayload(entry, rule), options);
        return { channel: 'slack', ok: res.ok, status: res.status, error: res.ok ? undefined : res.body };
      }
      case 'discord': {
        const res = await postJson(channel.url, discordPayload(entry, rule), options);
        return { channel: 'discord', ok: res.ok, status: res.status, error: res.ok ? undefined : res.body };
      }
      case 'webhook': {
        const res = await postJson(channel.url, webhookPayload(entry, rule, reason), {
          ...options,
          headers: channel.headers || {},
        });
        return { channel: 'webhook', ok: res.ok, status: res.status, error: res.ok ? undefined : res.body };
      }
      default:
        return { channel: channel.type, ok: false, error: `unknown channel type ${channel.type}` };
    }
  } catch (err) {
    log.warn('alert delivery failed', { channel: channel.type, rule: rule.id, error: err.message });
    return { channel: channel.type, ok: false, error: err.message };
  }
}

async function dispatch(rule, entry, reason, options = {}) {
  const results = [];
  for (const channel of rule.channels || []) {
    results.push(await deliver(channel, entry, rule, reason, options));
  }
  return results;
}

module.exports = {
  dispatch, deliver, postJson, summarize, plainText,
  slackPayload, discordPayload, webhookPayload, money, pct, timeLeft,
};
