'use strict';

// Estimates what a lot's contents are worth if you resold them, and — just as
// importantly — how much to trust that number. Every step is recorded in
// `adjustments` so the UI can show its working rather than a bare figure.
const { findComp } = require('./comps');

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

// Numeric spec keys are thresholds (the largest key the lot meets wins), string
// keys are exact. That means a 24GB machine picks up the "16" bonus rather than
// nothing at all.
function specMultiplier(specAdjust, specs) {
  const applied = [];
  let multiplier = 1;
  for (const [specName, mapping] of Object.entries(specAdjust || {})) {
    const value = specs ? specs[specName] : undefined;
    if (value === undefined || value === null) continue;
    const numericKeys = Object.keys(mapping)
      .map((key) => ({ key, num: Number(key) }))
      .filter((entry) => Number.isFinite(entry.num));

    if (typeof value === 'number' && numericKeys.length) {
      const eligible = numericKeys.filter((entry) => value >= entry.num).sort((a, b) => b.num - a.num)[0];
      if (eligible) {
        multiplier *= mapping[eligible.key];
        applied.push({ label: `${specName} ≥ ${eligible.key}`, multiplier: mapping[eligible.key] });
      }
      continue;
    }
    const key = String(value);
    if (mapping[key] !== undefined) {
      multiplier *= mapping[key];
      applied.push({ label: `${specName} = ${key}`, multiplier: mapping[key] });
    }
  }
  return { multiplier, applied };
}

// A penalty fires when its pattern matches; `requires` is a second pattern that
// must also match, which is how "Meraki" plus "unlicensed" can be a much bigger
// deduction than either alone.
function applyPenalties(penalties, haystack) {
  const matched = [];
  for (const penalty of penalties || []) {
    if (!new RegExp(penalty.pattern, penalty.flags || 'i').test(haystack)) continue;
    if (penalty.requires && !new RegExp(penalty.requires, penalty.flags || 'i').test(haystack)) continue;
    matched.push(penalty);
  }
  // A specific penalty can swallow a general one it already accounts for, so a
  // Meraki switch with a dead licence is not deducted twice for the same fact.
  const superseded = new Set();
  for (const penalty of matched) {
    for (const id of penalty.supersedes || []) superseded.add(id);
  }
  const applied = [];
  let multiplier = 1;
  for (const penalty of matched) {
    if (superseded.has(penalty.id)) continue;
    multiplier *= penalty.multiplier;
    applied.push({ id: penalty.id, multiplier: penalty.multiplier, note: penalty.note });
  }
  return { multiplier, applied };
}

// Twenty identical laptops sell for close to list. Two hundred do not: you are
// now competing with yourself for months. The curve is deliberately gentle and
// floored, and it only ever reduces.
function bulkMultiplier(bulk, quantity) {
  if (!quantity || quantity <= 1) return 1;
  const slope = bulk && Number.isFinite(bulk.slope) ? bulk.slope : 0.08;
  const floor = bulk && Number.isFinite(bulk.floor) ? bulk.floor : 0.6;
  return clamp(1 - slope * Math.log10(quantity), floor, 1);
}

function estimateValue(lot, table) {
  const adjustments = [];
  const haystack = `${lot.title || ''} ${lot.description || ''}`;
  const match = findComp(table, lot);
  const categoryDefault = (table.categoryDefaults || {})[lot.category] || (table.categoryDefaults || {}).misc;

  let unitValue;
  let confidence;
  let method;
  let compId = null;
  let compLabel = null;
  let basisCondition = 'used';

  if (match) {
    unitValue = Number(match.comp.unitValue);
    confidence = Number(match.comp.confidence ?? 0.6);
    method = 'comp';
    compId = match.comp.id;
    compLabel = match.comp.label || match.comp.id;
    basisCondition = match.comp.basisCondition || 'used';
    adjustments.push({ step: 'comp', label: `Comp: ${compLabel}`, value: round2(unitValue) });
  } else if (categoryDefault) {
    unitValue = Number(categoryDefault.unitValue);
    confidence = Number(categoryDefault.confidence ?? 0.15);
    method = 'category';
    adjustments.push({ step: 'category', label: `Category default: ${lot.categoryLabel || lot.category}`, value: round2(unitValue) });
  } else {
    return {
      unitValue: 0, totalValue: 0, confidence: 0, method: 'none', compId: null, compLabel: null,
      adjustments: [], penalties: [], notes: ['No comp and no category default — cannot value this lot'],
    };
  }

  const spec = specMultiplier(match ? match.comp.specAdjust : null, lot.specs);
  if (spec.multiplier !== 1) {
    unitValue *= spec.multiplier;
    for (const entry of spec.applied) {
      adjustments.push({ step: 'spec', label: `Spec ${entry.label}`, multiplier: entry.multiplier });
    }
  }

  // The comp is quoted at some condition; move it to this lot's condition.
  const conditionMultipliers = table.conditionMultipliers || {};
  const lotFactor = conditionMultipliers[lot.condition] ?? 1;
  const basisFactor = conditionMultipliers[basisCondition] ?? 1;
  const conditionFactor = basisFactor === 0 ? 1 : lotFactor / basisFactor;
  if (conditionFactor !== 1) {
    unitValue *= conditionFactor;
    adjustments.push({
      step: 'condition',
      label: `Condition ${lot.condition} (comp quoted ${basisCondition})`,
      multiplier: round2(conditionFactor),
    });
  }

  const penalties = applyPenalties(table.penalties, haystack);
  if (penalties.multiplier !== 1) {
    unitValue *= penalties.multiplier;
    for (const entry of penalties.applied) {
      adjustments.push({ step: 'penalty', label: entry.note, multiplier: entry.multiplier });
    }
  }

  const quantity = Math.max(1, Number(lot.quantity) || 1);
  const bulk = bulkMultiplier(table.bulk, quantity);
  if (bulk !== 1) {
    adjustments.push({ step: 'bulk', label: `Bulk discount on ${quantity} units`, multiplier: round2(bulk) });
  }

  // Confidence erodes with every assumption we stack on top of the comp.
  if (lot.condition === 'unknown') confidence *= 0.9;
  confidence *= clamp(1 - 0.05 * penalties.applied.length, 0.7, 1);
  if (quantity > 20) confidence *= 0.92;
  if (!lot.description) confidence *= 0.95;

  const unit = round2(Math.max(unitValue, 0));
  return {
    unitValue: unit,
    totalValue: round2(unit * quantity * bulk),
    quantity,
    bulkMultiplier: round2(bulk),
    confidence: round2(clamp(confidence, 0.05, 0.95)),
    method,
    compId,
    compLabel,
    adjustments,
    penalties: penalties.applied,
    notes: penalties.applied.map((entry) => entry.note),
  };
}

module.exports = { estimateValue, bulkMultiplier, specMultiplier, applyPenalties, clamp, round2 };
