'use strict';

// Filtering and sorting for the lot board. Shared by the HTTP API and the CLI
// so `dealhunter lots --min-margin 40` and the dashboard's margin slider mean
// exactly the same thing.

const SORTS = {
  score: (a, b) => b.deal.score - a.deal.score,
  profit: (a, b) => b.deal.profit - a.deal.profit,
  margin: (a, b) => b.deal.marginPct - a.deal.marginPct,
  roi: (a, b) => b.deal.roi - a.deal.roi,
  closing: (a, b) => {
    const av = a.deal.hoursToClose;
    const bv = b.deal.hoursToClose;
    if (av === null) return 1;
    if (bv === null) return -1;
    return av - bv;
  },
  bid: (a, b) => b.currentBid - a.currentBid,
  newest: (a, b) => new Date(b.firstSeenAt) - new Date(a.firstSeenAt),
};

function num(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// Accepts either 0.35 or 35 for a percentage, same as alert rules do.
function fraction(value) {
  const parsed = num(value);
  if (parsed === undefined) return undefined;
  return parsed > 1 ? parsed / 100 : parsed;
}

function truthy(value) {
  return value !== undefined && value !== null && value !== '' && !/^(0|false|no)$/i.test(String(value));
}

function filterLots(lots, params = {}) {
  const q = params.q ? String(params.q).toLowerCase() : null;
  const sources = params.source ? String(params.source).split(',').filter(Boolean) : null;
  const categories = params.category ? String(params.category).split(',').filter(Boolean) : null;
  const conditions = params.condition ? String(params.condition).split(',').filter(Boolean) : null;
  const states = params.state ? String(params.state).toUpperCase().split(',').filter(Boolean) : null;
  const minMargin = fraction(params.minMargin);
  const minRoi = fraction(params.minRoi);
  const minConfidence = fraction(params.minConfidence);
  const minProfit = num(params.minProfit);
  const minScore = num(params.minScore);
  const maxBid = num(params.maxBid);
  const closingWithin = num(params.closingWithin);
  const dealsOnly = truthy(params.dealsOnly);
  const includeClosed = truthy(params.includeClosed);

  return lots.filter((lot) => {
    const deal = lot.deal || {};
    const valuation = lot.valuation || {};
    if (!includeClosed && deal.closed) return false;
    if (dealsOnly && !(deal.score > 0)) return false;
    if (q && !`${lot.title} ${lot.description || ''}`.toLowerCase().includes(q)) return false;
    if (sources && !sources.includes(lot.source)) return false;
    if (categories && !categories.includes(lot.category)) return false;
    if (conditions && !conditions.includes(lot.condition)) return false;
    if (states && !states.includes((lot.location && lot.location.state) || '')) return false;
    if (minMargin !== undefined && !(deal.marginPct >= minMargin)) return false;
    if (minRoi !== undefined && !(deal.roi >= minRoi)) return false;
    if (minProfit !== undefined && !(deal.profit >= minProfit)) return false;
    if (minScore !== undefined && !(deal.score >= minScore)) return false;
    if (minConfidence !== undefined && !(valuation.confidence >= minConfidence)) return false;
    if (maxBid !== undefined && !(lot.currentBid <= maxBid)) return false;
    if (closingWithin !== undefined) {
      if (deal.hoursToClose === null || deal.hoursToClose === undefined) return false;
      if (deal.hoursToClose > closingWithin) return false;
    }
    return true;
  });
}

function sortLots(lots, sort = 'score') {
  const comparator = SORTS[sort] || SORTS.score;
  return lots.slice().sort(comparator);
}

function queryLots(allLots, params = {}) {
  const filtered = sortLots(filterLots(allLots, params), params.sort);
  const limit = Math.max(1, Math.min(num(params.limit) ?? 100, 1000));
  const offset = Math.max(0, num(params.offset) ?? 0);
  return { total: filtered.length, limit, offset, lots: filtered.slice(offset, offset + limit) };
}

// Board-level numbers for the dashboard header: how much is on the table right
// now, and where it is.
function summarize(lots) {
  const live = lots.filter((lot) => !(lot.deal && lot.deal.closed));
  const deals = live.filter((lot) => lot.deal && lot.deal.score > 0);
  const byCategory = {};
  const bySource = {};
  let potentialProfit = 0;
  for (const lot of deals) {
    potentialProfit += lot.deal.profit;
    byCategory[lot.category] = (byCategory[lot.category] || 0) + 1;
    bySource[lot.source] = (bySource[lot.source] || 0) + 1;
  }
  const closingSoon = live.filter((lot) => lot.deal && lot.deal.hoursToClose !== null
    && lot.deal.hoursToClose <= 24 && lot.deal.score > 0).length;
  const best = deals.slice().sort((a, b) => b.deal.score - a.deal.score)[0] || null;
  return {
    tracked: lots.length,
    live: live.length,
    deals: deals.length,
    closingSoon,
    potentialProfit: Math.round(potentialProfit),
    byCategory,
    bySource,
    best: best && { id: best.id, title: best.title, profit: best.deal.profit, score: best.deal.score },
  };
}

module.exports = { queryLots, filterLots, sortLots, summarize, SORTS };
