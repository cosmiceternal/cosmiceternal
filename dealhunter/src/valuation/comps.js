'use strict';

// The comps table is the tool's opinion about what things are worth. It ships
// seeded so the pipeline produces numbers on day one, but the seed values are
// starting assumptions — the whole point of `confidence` is that you can filter
// alerts down to the entries you have actually verified against your own sales.
const fs = require('node:fs');
const path = require('node:path');

const SEED_FILE = path.join(__dirname, '..', '..', 'seed', 'comps.json');

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9.+/-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Terms always match on a left token boundary, so "5490" never matches
// "154900". The right-hand rule differs by term shape, because model numbers
// and English words behave differently in listing titles: a term containing a
// digit ("u2419", "310", "dl380") may be followed by a suffix, since sellers
// write U2419H and 310SL, but never by another digit, which would make it a
// different model. A purely alphabetic term ("deere", "air") must fill the
// whole token — bar a plural 's' — so it cannot match inside "airport" but
// still matches "chromebooks".
function hasTerm(haystack, term) {
  const needle = normalizeText(term);
  if (!needle) return false;
  const tail = /\d/.test(needle) ? '(?![0-9])' : '(e?s)?([^a-z0-9]|$)';
  return new RegExp(`(^|[^a-z0-9])${escapeRegex(needle)}${tail}`).test(haystack);
}

function matchScore(comp, haystack, category) {
  const rule = comp.match || {};
  const all = rule.all || [];
  const any = rule.any || [];
  const none = rule.none || [];

  for (const term of all) if (!hasTerm(haystack, term)) return null;
  for (const term of none) if (hasTerm(haystack, term)) return null;
  if (any.length && !any.some((term) => hasTerm(haystack, term))) return null;
  if (rule.regex && !new RegExp(rule.regex, rule.flags || 'i').test(haystack)) return null;
  if (!all.length && !any.length && !rule.regex) return null;

  // Specificity: more terms and longer terms beat a loose one-word match, and a
  // comp filed under the lot's own category beats one that is not.
  let score = 0;
  for (const term of all) score += 2 + normalizeText(term).length;
  for (const term of any) if (hasTerm(haystack, term)) score += 1 + normalizeText(term).length / 2;
  if (rule.regex) score += 4;
  if (comp.category && comp.category === category) score += 6;
  return score;
}

function findComp(table, lot) {
  const haystack = normalizeText(`${lot.title || ''} ${lot.description || ''}`);
  let best = null;
  for (const comp of table.comps) {
    const score = matchScore(comp, haystack, lot.category);
    if (score === null) continue;
    if (!best || score > best.score
        || (score === best.score && (comp.confidence || 0) > (best.comp.confidence || 0))) {
      best = { comp, score };
    }
  }
  return best;
}

function validateTable(table) {
  if (!table || !Array.isArray(table.comps)) throw new Error('comps table must have a "comps" array');
  const seen = new Set();
  for (const comp of table.comps) {
    if (!comp.id) throw new Error('every comp needs an id');
    if (seen.has(comp.id)) throw new Error(`duplicate comp id: ${comp.id}`);
    seen.add(comp.id);
    if (!Number.isFinite(Number(comp.unitValue))) throw new Error(`comp ${comp.id} has no numeric unitValue`);
    if (!comp.match || (!comp.match.all && !comp.match.any && !comp.match.regex)) {
      throw new Error(`comp ${comp.id} has no match rule`);
    }
  }
  return true;
}

// Later tables win: a user comp with the same id replaces the seeded one, and a
// new id is appended. Penalties and defaults merge the same way.
function mergeTables(base, overlay) {
  if (!overlay) return base;
  const byId = new Map(base.comps.map((c) => [c.id, c]));
  for (const comp of overlay.comps || []) byId.set(comp.id, comp);
  const penalties = new Map((base.penalties || []).map((p) => [p.id, p]));
  for (const penalty of overlay.penalties || []) penalties.set(penalty.id, penalty);
  return {
    ...base,
    ...overlay,
    comps: Array.from(byId.values()),
    penalties: Array.from(penalties.values()),
    conditionMultipliers: { ...base.conditionMultipliers, ...(overlay.conditionMultipliers || {}) },
    categoryDefaults: { ...base.categoryDefaults, ...(overlay.categoryDefaults || {}) },
    bulk: { ...base.bulk, ...(overlay.bulk || {}) },
  };
}

function readTable(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadComps(options = {}) {
  const base = readTable(options.seedFile || SEED_FILE);
  validateTable(base);
  let table = base;
  const userFile = options.userFile;
  if (userFile && fs.existsSync(userFile)) {
    const overlay = readTable(userFile);
    if (!Array.isArray(overlay.comps)) overlay.comps = [];
    table = mergeTables(base, overlay);
    validateTable(table);
  }
  return table;
}

// CSV import for the common case: you exported your own sold comps from a
// spreadsheet. Columns id,category,label,terms,unitValue,confidence — `terms`
// is pipe-separated and becomes match.all.
function parseCompsCsv(text) {
  const rows = String(text).split(/\r?\n/).filter((line) => line.trim());
  if (!rows.length) return [];
  const header = rows[0].split(',').map((h) => h.trim().toLowerCase());
  const required = ['id', 'terms', 'unitvalue'];
  for (const column of required) {
    if (!header.includes(column)) throw new Error(`comps CSV needs a "${column}" column`);
  }
  const out = [];
  for (const line of rows.slice(1)) {
    const cells = splitCsvLine(line);
    const record = {};
    header.forEach((name, i) => { record[name] = (cells[i] || '').trim(); });
    if (!record.id) continue;
    out.push({
      id: record.id,
      category: record.category || 'misc',
      label: record.label || record.id,
      match: { all: record.terms.split('|').map((t) => t.trim()).filter(Boolean) },
      unitValue: Number(record.unitvalue),
      basisCondition: record.basiscondition || 'used',
      confidence: record.confidence === undefined || record.confidence === '' ? 0.8 : Number(record.confidence),
    });
  }
  return out;
}

function splitCsvLine(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') { current += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else current += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { cells.push(current); current = ''; }
    else current += char;
  }
  cells.push(current);
  return cells;
}

function importComps(file) {
  const text = fs.readFileSync(file, 'utf8');
  if (file.toLowerCase().endsWith('.csv')) return { comps: parseCompsCsv(text) };
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? { comps: parsed } : parsed;
}

module.exports = {
  loadComps, findComp, matchScore, mergeTables, validateTable,
  importComps, parseCompsCsv, normalizeText, hasTerm, SEED_FILE,
};
