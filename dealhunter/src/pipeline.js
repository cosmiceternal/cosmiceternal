'use strict';

// The scrape → value → alert loop. One run touches every enabled source,
// normalises what came back, prices it, writes it to the store with its price
// history, and then asks every enabled rule whether it wants to say something.
//
// A run never throws for one bad source: failures are collected as warnings so
// a GovDeals outage does not stop the ITAD feeds from alerting.
const { normalizeLot } = require('./normalize');
const { estimateValue } = require('./valuation/estimate');
const { evaluate } = require('./valuation/margin');
const { costsFor } = require('./config');
const { matchRule, shouldNotify, recordNotification, stateKey } = require('./alerts/match');
const { dispatch } = require('./alerts/notify');
const { selectSources } = require('./sources');

const MAX_PRICE_HISTORY = 60;

function passesGlobalFilter(lot, config) {
  const haystack = `${lot.title} ${lot.description || ''}`.toLowerCase();
  if (config.categories && config.categories.length && !config.categories.includes(lot.category)) return false;
  if (config.keywords && config.keywords.length
      && !config.keywords.some((word) => haystack.includes(word.toLowerCase()))) return false;
  if (config.excludeKeywords && config.excludeKeywords.length
      && config.excludeKeywords.some((word) => haystack.includes(word.toLowerCase()))) return false;
  return true;
}

// Merges a freshly scraped lot over what we already had, keeping the first-seen
// timestamp and appending to the price history only when the bid actually moved.
function mergeLot(existing, incoming, now) {
  if (!existing) return incoming;
  const history = existing.priceHistory || [];
  const lastBid = history.length ? history[history.length - 1].bid : null;
  const nextHistory = lastBid === incoming.currentBid
    ? history
    : history.concat([{ at: now, bid: incoming.currentBid, bidCount: incoming.bidCount }]).slice(-MAX_PRICE_HISTORY);
  return {
    ...existing,
    ...incoming,
    firstSeenAt: existing.firstSeenAt || incoming.firstSeenAt,
    lastSeenAt: now,
    priceHistory: nextHistory,
  };
}

function createPipeline(deps) {
  const { config, store, log, http, registry, comps } = deps;
  const lots = store.collection('lots');
  const alerts = store.collection('alerts');
  const alertState = store.collection('alertstate');
  const runs = store.collection('runs');

  function valueLot(lot, now) {
    const valuation = estimateValue(lot, comps);
    const deal = evaluate(lot, valuation, costsFor(config, lot.category), {
      now,
      targetMarginPct: config.thresholds.minMarginPct,
    });
    return { valuation, deal };
  }

  // Re-prices everything already in the store — used after a comps or cost
  // change, so the board reflects new assumptions without waiting for a scrape.
  function revalueAll(now = Date.now()) {
    let count = 0;
    for (const stored of lots.all()) {
      const { valuation, deal } = valueLot(stored, now);
      lots.put({ ...stored, valuation, deal, valuedAt: new Date(now).toISOString() });
      count += 1;
    }
    return count;
  }

  async function collectFrom(source, options) {
    const started = Date.now();
    try {
      const result = await source.collect({
        http,
        log: log.child(source.id),
        query: options.query || '',
        maxPages: options.maxPages ?? config.maxPagesPerSource,
        now: options.now,
      });
      return {
        id: source.id,
        ok: true,
        records: result.records || [],
        warnings: result.warnings || [],
        durationMs: Date.now() - started,
      };
    } catch (err) {
      log.warn('source failed', { source: source.id, error: err.message });
      return { id: source.id, ok: false, records: [], warnings: [`${source.id}: ${err.message}`], durationMs: Date.now() - started };
    }
  }

  async function evaluateRules(entries, options) {
    const now = options.now;
    const enabledRules = store.collection('rules').all().filter((rule) => rule.enabled);
    let sent = 0;
    const skipped = [];

    for (const rule of enabledRules) {
      for (const entry of entries) {
        const match = matchRule(rule, entry);
        if (!match.matched) continue;

        const key = stateKey(rule.id, entry.lot.id);
        const previous = alertState.get(key);
        const decision = shouldNotify(rule, entry, previous, now);
        if (!decision.send) {
          skipped.push({ rule: rule.id, lot: entry.lot.id, reason: decision.reason });
          continue;
        }

        const deliveries = options.dryRun
          ? [{ channel: 'dry-run', ok: true }]
          : await dispatch(rule, entry, decision.reason, {
            log: log.child('alerts'),
            dataDir: config.dataDir,
            timeoutMs: config.notifyTimeoutMs,
          });

        alerts.put({
          id: `${key}::${now}`,
          ruleId: rule.id,
          ruleName: rule.name,
          lotId: entry.lot.id,
          title: entry.lot.title,
          url: entry.lot.url,
          source: entry.lot.source,
          reason: decision.reason,
          profit: entry.deal.profit,
          marginPct: entry.deal.marginPct,
          score: entry.deal.score,
          currentBid: entry.lot.currentBid,
          maxBid: entry.deal.maxBid,
          confidence: entry.valuation.confidence,
          closesAt: entry.lot.closesAt,
          deliveries,
          sentAt: new Date(now).toISOString(),
        });
        alertState.put(recordNotification(previous, rule, entry, decision, now));
        sent += 1;
      }
    }
    return { sent, skipped, rulesEvaluated: enabledRules.length };
  }

  // Drops lots that closed a while ago so the store does not grow forever.
  function prune(now, retentionDays = 14) {
    const cutoff = now - retentionDays * 86400000;
    let removed = 0;
    for (const lot of lots.all()) {
      const closed = lot.closesAt ? new Date(lot.closesAt).getTime() : null;
      const lastSeen = new Date(lot.lastSeenAt).getTime();
      if ((closed !== null && closed < cutoff) || (closed === null && lastSeen < cutoff)) {
        lots.delete(lot.id);
        removed += 1;
      }
    }
    return removed;
  }

  async function runOnce(options = {}) {
    const now = options.now ? new Date(options.now).getTime() : Date.now();
    const startedAt = new Date(now).toISOString();
    const started = Date.now();
    const ids = options.sourceIds && options.sourceIds.length ? options.sourceIds : config.sources;
    const { selected, unknown } = selectSources(registry, ids);
    const warnings = unknown.map((id) => `unknown source "${id}" — run \`dealhunter sources\` to list what is available`);

    const sourceResults = [];
    for (const source of selected) {
      sourceResults.push(await collectFrom(source, { ...options, now }));
    }

    const entries = [];
    const stats = { scraped: 0, kept: 0, filtered: 0, invalid: 0, added: 0, updated: 0 };

    for (const result of sourceResults) {
      warnings.push(...result.warnings);
      for (const record of result.records) {
        stats.scraped += 1;
        let lot;
        try {
          lot = normalizeLot(record, { sourceId: record.source || result.id });
        } catch (err) {
          stats.invalid += 1;
          warnings.push(err.message);
          continue;
        }
        if (!passesGlobalFilter(lot, config)) {
          stats.filtered += 1;
          continue;
        }
        const existing = lots.get(lot.id);
        const merged = mergeLot(existing, lot, new Date(now).toISOString());
        const { valuation, deal } = valueLot(merged, now);
        const stored = { ...merged, valuation, deal, valuedAt: new Date(now).toISOString() };
        lots.put(stored);
        if (existing) stats.updated += 1; else stats.added += 1;
        stats.kept += 1;
        entries.push({ lot: stored, valuation, deal });
      }
    }

    const alerting = options.skipAlerts
      ? { sent: 0, skipped: [], rulesEvaluated: 0 }
      : await evaluateRules(entries, { now, dryRun: options.dryRun });

    const pruned = options.skipPrune ? 0 : prune(now, options.retentionDays);
    const deals = entries.filter((entry) => entry.deal.score > 0).length;

    const summary = {
      id: `run-${now}`,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      sources: sourceResults.map((r) => ({ id: r.id, ok: r.ok, records: r.records.length, durationMs: r.durationMs })),
      ...stats,
      deals,
      alertsSent: alerting.sent,
      alertsSuppressed: alerting.skipped.length,
      rulesEvaluated: alerting.rulesEvaluated,
      pruned,
      warnings,
    };
    runs.put(summary);
    log.info('scrape complete', {
      sources: selected.length, scraped: stats.scraped, kept: stats.kept,
      deals, alerts: alerting.sent, ms: summary.durationMs,
    });
    return summary;
  }

  return { runOnce, revalueAll, valueLot, prune, mergeLot };
}

module.exports = { createPipeline, mergeLot, passesGlobalFilter, MAX_PRICE_HISTORY };
