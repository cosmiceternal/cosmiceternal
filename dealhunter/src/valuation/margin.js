'use strict';

// Turns an estimated resale value into the numbers you actually bid on: what
// the lot costs you delivered and prepped, what you net after fees and outbound
// shipping, and the highest bid that still clears your target margin.
//
// The max-bid figure is the one that matters at 11:58pm on a closing auction,
// so it is derived from the same equation as the margin rather than guessed.

const { clamp, round2 } = require('./estimate');

function premiumOn(bid, costs) {
  const raw = bid * (costs.buyerPremiumPct || 0);
  return costs.buyerPremiumMax > 0 ? Math.min(raw, costs.buyerPremiumMax) : raw;
}

// Costs that do not move with the bid: freight in, refurb, listing prep.
function fixedCosts(costs, quantity) {
  return (costs.inboundFreightFlat || 0)
    + (costs.inboundFreightPerUnit || 0) * quantity
    + (costs.refurbCostPerUnit || 0) * quantity
    + (costs.listingCostPerUnit || 0) * quantity;
}

function landedCost(bid, costs, quantity) {
  const premium = premiumOn(bid, costs);
  const tax = (bid + premium) * (costs.salesTaxPct || 0);
  const fixed = fixedCosts(costs, quantity);
  return {
    bid: round2(bid),
    premium: round2(premium),
    tax: round2(tax),
    inbound: round2((costs.inboundFreightFlat || 0) + (costs.inboundFreightPerUnit || 0) * quantity),
    prep: round2(((costs.refurbCostPerUnit || 0) + (costs.listingCostPerUnit || 0)) * quantity),
    total: round2(bid + premium + tax + fixed),
  };
}

function saleProceeds(estimatedValue, costs, quantity) {
  const sellThrough = clamp(costs.sellThroughPct ?? 1, 0, 1);
  const gross = estimatedValue * sellThrough;
  const fees = gross * ((costs.marketplaceFeePct || 0) + (costs.paymentFeePct || 0));
  const outbound = (costs.outboundShipPerUnit || 0) * quantity * sellThrough;
  return {
    gross: round2(gross),
    fees: round2(fees),
    outbound: round2(outbound),
    net: round2(gross - fees - outbound),
    sellThrough,
  };
}

// Highest bid at which profit still equals `targetMarginPct` of gross revenue.
// Everything except the bid is known, so this is a direct solve rather than a
// search: net - (bid + premium(bid) + tax(bid) + fixed) = targetMargin * gross.
function maxBid(estimatedValue, costs, quantity, targetMarginPct = 0) {
  const proceeds = saleProceeds(estimatedValue, costs, quantity);
  const fixed = fixedCosts(costs, quantity);
  const allowedVariable = proceeds.net - (targetMarginPct * proceeds.gross) - fixed;
  if (allowedVariable <= 0) return 0;

  const taxRate = costs.salesTaxPct || 0;
  const premiumRate = costs.buyerPremiumPct || 0;
  const uncapped = allowedVariable / ((1 + premiumRate) * (1 + taxRate));

  // With a capped premium the relationship is piecewise: below the cap the
  // uncapped solve holds; above it the premium stops growing with the bid.
  if (costs.buyerPremiumMax > 0 && uncapped * premiumRate > costs.buyerPremiumMax) {
    const capped = (allowedVariable - costs.buyerPremiumMax * (1 + taxRate)) / (1 + taxRate);
    return round2(Math.max(capped, 0));
  }
  return round2(Math.max(uncapped, 0));
}

// How urgent this lot is: 1 for something closing within the hour, tapering to
// 0 a week out. Deals that close tomorrow deserve to outrank identical ones
// that close next month.
function urgency(closesAt, now = Date.now()) {
  if (!closesAt) return 0.3;
  const msLeft = new Date(closesAt).getTime() - now;
  if (!Number.isFinite(msLeft)) return 0.3;
  if (msLeft <= 0) return 0;
  const hoursLeft = msLeft / 3600000;
  return round2(clamp(1 - Math.log10(Math.max(hoursLeft, 1)) / Math.log10(168), 0, 1));
}

// A single 0-100 number for ranking a board of hundreds of lots. Margin and
// profit dominate; confidence keeps unverified guesses off the top; urgency
// only breaks ties.
function scoreDeal({ marginPct, profit, confidence, closesAt }, now = Date.now()) {
  // A lot you lose money on has no rank. Without this, a high-confidence
  // disaster would still score for its confidence and its closing time.
  if (!(profit > 0)) return 0;
  const marginPart = clamp(marginPct / 0.6, 0, 1) * 0.35;
  const profitPart = clamp(profit / 2000, 0, 1) * 0.30;
  const confidencePart = clamp(confidence, 0, 1) * 0.25;
  const urgencyPart = urgency(closesAt, now) * 0.10;
  return Math.round((marginPart + profitPart + confidencePart + urgencyPart) * 1000) / 10;
}

// The whole economic picture for one lot at its current bid.
function evaluate(lot, valuation, costs, options = {}) {
  const now = options.now ? new Date(options.now).getTime() : Date.now();
  const quantity = Math.max(1, Number(valuation.quantity || lot.quantity) || 1);
  const bid = Math.max(0, Number(lot.currentBid) || 0);
  const landed = landedCost(bid, costs, quantity);
  const proceeds = saleProceeds(valuation.totalValue, costs, quantity);
  const profit = round2(proceeds.net - landed.total);
  const marginPct = proceeds.gross > 0 ? round2(profit / proceeds.gross) : 0;
  const roi = landed.total > 0 ? round2(profit / landed.total) : 0;
  const targetMargin = options.targetMarginPct ?? 0.35;

  const closesAt = lot.closesAt || null;
  const msLeft = closesAt ? new Date(closesAt).getTime() - now : null;
  const closed = msLeft !== null && msLeft <= 0;

  return {
    quantity,
    currency: lot.currency || 'USD',
    landed,
    proceeds,
    estimatedValue: valuation.totalValue,
    profit,
    marginPct,
    roi,
    perUnitProfit: round2(profit / quantity),
    breakEvenBid: maxBid(valuation.totalValue, costs, quantity, 0),
    maxBid: maxBid(valuation.totalValue, costs, quantity, targetMargin),
    targetMarginPct: targetMargin,
    headroom: round2(maxBid(valuation.totalValue, costs, quantity, targetMargin) - bid),
    hoursToClose: msLeft === null ? null : round2(msLeft / 3600000),
    closed,
    // You cannot bid on a lot that has already closed, so it never ranks —
    // however good the numbers looked while it was open.
    score: closed ? 0 : scoreDeal({ marginPct, profit, confidence: valuation.confidence, closesAt }, now),
  };
}

module.exports = {
  evaluate, landedCost, saleProceeds, maxBid, fixedCosts, premiumOn, urgency, scoreDeal,
};
