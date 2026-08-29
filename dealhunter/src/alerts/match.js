'use strict';

// Decides whether a valued lot matches a rule, and — separately — whether we
// should actually send anything about it. Those are two different questions:
// a lot can keep matching for days without deserving a second notification.

function includesAny(haystack, needles) {
  const text = String(haystack).toLowerCase();
  return needles.some((needle) => text.includes(String(needle).toLowerCase()));
}

// Returns { matched, failures } — failures name the first-failing conditions so
// the UI can answer "why didn't this alert?" without guesswork.
function matchRule(rule, entry) {
  const { lot, valuation, deal } = entry;
  const filters = rule.filters || {};
  const thresholds = rule.thresholds || {};
  const failures = [];
  const haystack = `${lot.title} ${lot.description || ''}`;

  if (deal.closed) failures.push('auction has closed');
  if (filters.sources && !filters.sources.includes(lot.source)) failures.push(`source ${lot.source} not in rule`);
  if (filters.categories && !filters.categories.includes(lot.category)) failures.push(`category ${lot.category} not in rule`);
  if (filters.conditions && !filters.conditions.includes(lot.condition)) failures.push(`condition ${lot.condition} not in rule`);
  if (filters.states) {
    const state = lot.location && lot.location.state;
    if (!state || !filters.states.map((s) => s.toUpperCase()).includes(state)) {
      failures.push(`location ${state || 'unknown'} not in rule`);
    }
  }
  if (filters.keywords && !includesAny(haystack, filters.keywords)) failures.push('no rule keyword present');
  if (filters.excludeKeywords && includesAny(haystack, filters.excludeKeywords)) failures.push('excluded keyword present');
  if (filters.minQuantity !== undefined && lot.quantity < filters.minQuantity) failures.push(`quantity ${lot.quantity} below minimum`);
  if (filters.maxQuantity !== undefined && lot.quantity > filters.maxQuantity) failures.push(`quantity ${lot.quantity} above maximum`);
  if (filters.maxCurrentBid !== undefined && lot.currentBid > filters.maxCurrentBid) failures.push(`bid ${lot.currentBid} above maximum`);
  if (filters.maxLandedCost !== undefined && deal.landed.total > filters.maxLandedCost) failures.push(`landed cost ${deal.landed.total} above maximum`);
  if (filters.maxBidCount !== undefined && lot.bidCount > filters.maxBidCount) failures.push(`already has ${lot.bidCount} bids`);
  if (filters.closingWithinHours !== undefined) {
    if (deal.hoursToClose === null || deal.hoursToClose > filters.closingWithinHours) {
      failures.push('closes outside the rule window');
    }
  }

  if (thresholds.minMarginPct !== undefined && deal.marginPct < thresholds.minMarginPct) {
    failures.push(`margin ${(deal.marginPct * 100).toFixed(0)}% below ${(thresholds.minMarginPct * 100).toFixed(0)}%`);
  }
  if (thresholds.minProfit !== undefined && deal.profit < thresholds.minProfit) {
    failures.push(`profit ${deal.profit} below ${thresholds.minProfit}`);
  }
  if (thresholds.minRoi !== undefined && deal.roi < thresholds.minRoi) {
    failures.push(`ROI ${(deal.roi * 100).toFixed(0)}% below ${(thresholds.minRoi * 100).toFixed(0)}%`);
  }
  if (thresholds.minConfidence !== undefined && valuation.confidence < thresholds.minConfidence) {
    failures.push(`confidence ${valuation.confidence} below ${thresholds.minConfidence}`);
  }
  if (thresholds.minScore !== undefined && deal.score < thresholds.minScore) {
    failures.push(`score ${deal.score} below ${thresholds.minScore}`);
  }

  return { matched: failures.length === 0, failures };
}

function stateKey(ruleId, lotId) {
  return `${ruleId}::${lotId}`;
}

// Why send (or not send) again. Auction lots stay matched for their whole run,
// so without this every scrape would re-notify every match.
function shouldNotify(rule, entry, previous, now = Date.now()) {
  if (!previous) return { send: true, reason: 'new' };

  const cooldownMs = (rule.cooldownMinutes ?? 360) * 60000;
  const elapsed = now - new Date(previous.lastAlertAt).getTime();
  if (elapsed < cooldownMs) return { send: false, reason: 'within cooldown' };

  const lastBid = Number(previous.lastBid) || 0;
  const bid = Number(entry.lot.currentBid) || 0;
  const move = lastBid > 0 ? Math.abs(bid - lastBid) / lastBid : (bid > 0 ? 1 : 0);
  if (move >= (rule.rebidPct ?? 0.15)) {
    return { send: true, reason: `bid moved ${(move * 100).toFixed(0)}% to ${bid}` };
  }

  // Last call: one final nudge for a lot that is still a deal as it closes.
  const hoursLeft = entry.deal.hoursToClose;
  if (hoursLeft !== null && hoursLeft <= 2 && !previous.closingAlertSent) {
    return { send: true, reason: 'closing within 2 hours' };
  }

  return { send: false, reason: 'nothing material changed' };
}

function recordNotification(previous, rule, entry, decision, now = Date.now()) {
  return {
    id: stateKey(rule.id, entry.lot.id),
    ruleId: rule.id,
    lotId: entry.lot.id,
    lastAlertAt: new Date(now).toISOString(),
    lastBid: entry.lot.currentBid,
    alertCount: (previous ? previous.alertCount : 0) + 1,
    closingAlertSent: (previous && previous.closingAlertSent) || decision.reason === 'closing within 2 hours',
  };
}

module.exports = { matchRule, shouldNotify, recordNotification, stateKey };
