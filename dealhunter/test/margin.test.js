'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { evaluate, landedCost, saleProceeds, maxBid, urgency, scoreDeal } = require('../src/valuation/margin');

const COSTS = {
  buyerPremiumPct: 0.1,
  buyerPremiumMax: 0,
  salesTaxPct: 0,
  inboundFreightFlat: 100,
  inboundFreightPerUnit: 0,
  refurbCostPerUnit: 10,
  listingCostPerUnit: 0,
  marketplaceFeePct: 0.13,
  paymentFeePct: 0,
  outboundShipPerUnit: 15,
  sellThroughPct: 1,
};

test('landed cost adds premium, tax and the fixed costs', () => {
  const landed = landedCost(1000, { ...COSTS, salesTaxPct: 0.08 }, 10);
  assert.equal(landed.premium, 100);
  assert.equal(landed.tax, 88, 'tax applies to the bid plus the premium');
  assert.equal(landed.inbound, 100);
  assert.equal(landed.prep, 100);
  assert.equal(landed.total, 1388);
});

test("a capped buyer's premium stops growing with the bid", () => {
  const capped = { ...COSTS, buyerPremiumMax: 250 };
  assert.equal(landedCost(1000, capped, 1).premium, 100);
  assert.equal(landedCost(10000, capped, 1).premium, 250);
});

test('sale proceeds net out fees, shipping and sell-through', () => {
  const proceeds = saleProceeds(1000, { ...COSTS, sellThroughPct: 0.9 }, 10);
  assert.equal(proceeds.gross, 900);
  assert.equal(proceeds.fees, 117);
  assert.equal(proceeds.outbound, 135);
  assert.equal(proceeds.net, 648);
});

test('max bid is the exact break-even solve, not an approximation', () => {
  const value = 5000;
  const quantity = 10;
  const bid = maxBid(value, COSTS, quantity, 0);
  const deal = evaluate(
    { currentBid: bid, quantity, closesAt: null },
    { totalValue: value, quantity, confidence: 0.8 },
    COSTS,
  );
  assert.ok(Math.abs(deal.profit) < 0.05, `bidding the break-even should net ~0, got ${deal.profit}`);
});

test('max bid at a target margin leaves exactly that margin', () => {
  const value = 5000;
  const quantity = 10;
  const target = 0.35;
  const bid = maxBid(value, COSTS, quantity, target);
  const deal = evaluate(
    { currentBid: bid, quantity, closesAt: null },
    { totalValue: value, quantity, confidence: 0.8 },
    COSTS,
    { targetMarginPct: target },
  );
  assert.ok(Math.abs(deal.marginPct - target) < 0.005, `expected ~${target}, got ${deal.marginPct}`);
});

test('max bid solves correctly with tax and a premium cap in play', () => {
  const costs = { ...COSTS, salesTaxPct: 0.0825, buyerPremiumMax: 300 };
  const bid = maxBid(20000, costs, 5, 0);
  const deal = evaluate(
    { currentBid: bid, quantity: 5, closesAt: null },
    { totalValue: 20000, quantity: 5, confidence: 0.8 },
    costs,
  );
  assert.ok(Math.abs(deal.profit) < 0.05, `expected break-even, got ${deal.profit}`);
});

test('max bid is zero when a lot cannot be bought profitably at any price', () => {
  assert.equal(maxBid(50, COSTS, 10, 0), 0, 'fixed costs already exceed the resale value');
});

test('urgency decays from now to a week out', () => {
  const now = Date.now();
  assert.equal(urgency(new Date(now - 1000).toISOString(), now), 0, 'closed lots are not urgent');
  assert.ok(urgency(new Date(now + 3600000).toISOString(), now) > 0.9);
  assert.ok(urgency(new Date(now + 168 * 3600000).toISOString(), now) < 0.05);
});

test('a lot you lose money on scores zero', () => {
  const closesAt = new Date(Date.now() + 3600000).toISOString();
  assert.equal(scoreDeal({ marginPct: -0.5, profit: -100, confidence: 0.9, closesAt }), 0);
  assert.ok(scoreDeal({ marginPct: 0.5, profit: 900, confidence: 0.9, closesAt }) > 50);
});

test('evaluate reports headroom against the max bid and flags closed lots', () => {
  const closesAt = new Date(Date.now() - 60000).toISOString();
  const deal = evaluate(
    { currentBid: 100, quantity: 1, closesAt },
    { totalValue: 1000, quantity: 1, confidence: 0.8 },
    COSTS,
    { targetMarginPct: 0.35 },
  );
  assert.equal(deal.closed, true);
  assert.equal(deal.score, 0, 'a closed lot never ranks');
  assert.equal(deal.headroom, Math.round((deal.maxBid - 100) * 100) / 100);
});
