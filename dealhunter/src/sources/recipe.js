'use strict';

// Auction sites change their markup and their endpoints without notice, and
// there are dozens of ITAD houses each running a different platform. Rather
// than a hand-written adapter per site, a source is a JSON *recipe*: where to
// fetch, how to find the listing records, and which field maps to which. Adding
// a site — or repairing one that moved — is a data edit, not a code change.
//
// Two shapes are supported:
//   kind: "json"  — hit a search API and walk a path to the array of listings
//   kind: "html"  — fetch a listing page and either pull rows out with regexes
//                   or lift the embedded JSON blob modern sites ship anyway

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'", '#x2F': '/',
};

function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const key = entity.toLowerCase();
    if (ENTITIES[entity] !== undefined) return ENTITIES[entity];
    if (ENTITIES[key] !== undefined) return ENTITIES[key];
    if (key.startsWith('#x')) {
      const code = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (key.startsWith('#')) {
      const code = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return match;
  });
}

function stripTags(html) {
  return decodeEntities(
    String(html)
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]*>/g, ' '),
  ).replace(/\s+/g, ' ').trim();
}

// Dot path with numeric indices: "data.results.0.title". A `[]` segment maps
// over an array, which search APIs need surprisingly often.
function getPath(source, path) {
  if (path === undefined || path === null || path === '') return undefined;
  let current = source;
  for (const segment of String(path).split('.')) {
    if (current === null || current === undefined) return undefined;
    if (segment === '[]') {
      if (!Array.isArray(current)) return undefined;
      continue;
    }
    current = current[segment];
  }
  return current;
}

function applyTemplate(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (match, key) => (
    vars[key] === undefined || vars[key] === null ? '' : encodeURIComponent(String(vars[key]))
  ));
}

// Same as applyTemplate but without URL-encoding — for building a value out of
// fields already extracted from a record (e.g. a canonical listing URL).
// Returns undefined when a placeholder has no value, so a half-filled template
// ("…/asset/") never masks the next candidate in a fallback list.
function fillFromRecord(template, record) {
  let complete = true;
  const filled = String(template).replace(/\{([\w.]+)\}/g, (match, key) => {
    const value = getPath(record, key);
    if (value === undefined || value === null || value === '') {
      complete = false;
      return '';
    }
    return String(value);
  });
  return complete ? filled : undefined;
}

const TRANSFORMS = {
  text: (value) => (typeof value === 'string' ? stripTags(value) : value),
  trim: (value) => (typeof value === 'string' ? value.trim() : value),
  money: (value) => require('../normalize').parseMoney(value),
  date: (value) => require('../normalize').parseDate(value),
  int: (value) => {
    const n = Number.parseInt(String(value).replace(/[^0-9-]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  },
  number: (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  },
  bool: (value) => Boolean(value) && !/^(0|false|no)$/i.test(String(value)),
  lower: (value) => String(value).toLowerCase(),
  upper: (value) => String(value).toUpperCase(),
};

function applyTransforms(value, spec, context) {
  let out = value;
  const names = spec.transform ? [].concat(spec.transform) : [];
  for (const name of names) {
    const fn = TRANSFORMS[name];
    if (!fn) throw new Error(`unknown transform "${name}" in recipe ${context.recipeId}`);
    if (out === undefined || out === null) break;
    out = fn(out);
  }
  if ((out === undefined || out === null || out === '') && spec.default !== undefined) return spec.default;
  if (typeof out === 'string' && spec.baseUrl && out && !/^https?:/i.test(out)) {
    try {
      return new URL(out, spec.baseUrl).toString();
    } catch {
      return out;
    }
  }
  return out;
}

// One field of the output record. A spec is a shorthand path string, an object
// with { path | regex | template | const }, or an array of those tried in order
// until one yields a value — which is how one recipe can read both a site's
// embedded JSON and its raw HTML rows.
function extractField(spec, record, rawChunk, context) {
  if (Array.isArray(spec)) {
    for (const candidate of spec) {
      const value = extractField(candidate, record, rawChunk, context);
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return undefined;
  }
  const normalized = typeof spec === 'string' ? { path: spec } : { ...spec };
  let value;
  if (normalized.const !== undefined) {
    value = normalized.const;
  } else if (normalized.template !== undefined) {
    value = fillFromRecord(normalized.template, record);
  } else if (normalized.regex !== undefined) {
    const flags = normalized.flags || 'i';
    const match = String(rawChunk === undefined ? '' : rawChunk).match(new RegExp(normalized.regex, flags));
    value = match ? (match[normalized.group ?? 1] ?? match[0]) : undefined;
  } else {
    value = getPath(record, normalized.path);
  }
  return applyTransforms(value, normalized, context);
}

function mapRecord(map, record, rawChunk, context) {
  const out = {};
  for (const [field, spec] of Object.entries(map)) {
    const value = extractField(spec, record, rawChunk, context);
    if (value !== undefined && value !== null && value !== '') out[field] = value;
  }
  return out;
}

function findEmbeddedJson(html, spec) {
  const pattern = new RegExp(spec.pattern, spec.flags || 'i');
  const match = String(html).match(pattern);
  if (!match) return undefined;
  const text = match[spec.group ?? 1];
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function collectRows(html, recipe) {
  const flags = recipe.rowFlags || 'gi';
  const pattern = new RegExp(recipe.rowPattern, flags.includes('g') ? flags : `${flags}g`);
  const rows = [];
  let match;
  while ((match = pattern.exec(html)) !== null) {
    rows.push(match[recipe.rowGroup ?? 0]);
    if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
  }
  return rows;
}

function validateRecipe(recipe) {
  if (!recipe || typeof recipe !== 'object') throw new Error('recipe must be an object');
  const problems = [];
  if (!recipe.id) problems.push('missing id');
  if (!recipe.url) problems.push('missing url');
  if (!['json', 'html'].includes(recipe.kind)) problems.push('kind must be "json" or "html"');
  if (!recipe.map || typeof recipe.map !== 'object') problems.push('missing map');
  else {
    if (!recipe.map.externalId) problems.push('map must include externalId');
    if (!recipe.map.title) problems.push('map must include title');
  }
  if (recipe.kind === 'html' && !recipe.rowPattern && !recipe.embeddedJson) {
    problems.push('html recipes need rowPattern or embeddedJson');
  }
  if (problems.length) throw new Error(`recipe ${recipe.id || '(unnamed)'} is invalid: ${problems.join('; ')}`);
  return true;
}

async function fetchPage(recipe, http, vars) {
  const url = applyTemplate(recipe.url, vars);
  const init = { headers: recipe.headers || {} };
  if (recipe.method && recipe.method.toUpperCase() !== 'GET') {
    init.method = recipe.method.toUpperCase();
    if (recipe.body !== undefined) {
      const body = typeof recipe.body === 'string' ? recipe.body : JSON.stringify(recipe.body);
      init.body = body.replace(/\{(\w+)\}/g, (match, key) => (vars[key] === undefined ? '' : String(vars[key])));
      init.headers = { 'content-type': 'application/json', ...init.headers };
    }
  }
  const res = await http.request(url, init);
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} from ${url}`);
    err.status = res.status;
    throw err;
  }
  return { url, text: res.text };
}

function recordsFromPage(recipe, pageText, context) {
  if (recipe.kind === 'json') {
    let payload;
    try {
      payload = JSON.parse(pageText);
    } catch (err) {
      throw new Error(`${recipe.id}: expected JSON but got something else (${err.message})`);
    }
    const items = recipe.itemsPath ? getPath(payload, recipe.itemsPath) : payload;
    if (!Array.isArray(items)) {
      throw new Error(`${recipe.id}: itemsPath "${recipe.itemsPath || '(root)'}" did not resolve to an array`);
    }
    return items.map((item) => mapRecord(recipe.map, item, JSON.stringify(item), context));
  }

  if (recipe.embeddedJson) {
    const payload = findEmbeddedJson(pageText, recipe.embeddedJson);
    if (payload !== undefined) {
      const items = recipe.itemsPath ? getPath(payload, recipe.itemsPath) : payload;
      if (Array.isArray(items)) {
        return items.map((item) => mapRecord(recipe.map, item, JSON.stringify(item), context));
      }
    }
    // Embedded JSON is the happy path; fall through to row scraping when the
    // blob is missing or has moved.
    if (!recipe.rowPattern) return [];
  }

  return collectRows(pageText, recipe).map((row) => mapRecord(recipe.map, {}, row, context));
}

// Runs one recipe across its pages and returns mapped records plus anything
// that went wrong, so one broken source never aborts a whole scrape.
async function runRecipe(recipe, options = {}) {
  validateRecipe(recipe);
  const http = options.http;
  const log = options.log || { debug() {}, warn() {}, info() {} };
  const maxPages = Math.max(1, Math.min(options.maxPages ?? recipe.pages ?? 1, recipe.maxPages ?? 25));
  const pageStart = recipe.pageStart ?? 1;
  const context = { recipeId: recipe.id };
  const records = [];
  const warnings = [];
  const seen = new Set();
  let pagesFetched = 0;

  for (let i = 0; i < maxPages; i += 1) {
    const page = pageStart + i;
    const vars = { ...(recipe.vars || {}), ...(options.vars || {}), page, offset: i * (recipe.pageSize || 0) };
    let pageText;
    let pageUrl;
    try {
      const fetched = await fetchPage(recipe, http, vars);
      pageText = fetched.text;
      pageUrl = fetched.url;
      pagesFetched += 1;
    } catch (err) {
      warnings.push(`${recipe.id} page ${page}: ${err.message}`);
      break;
    }

    let pageRecords;
    try {
      pageRecords = recordsFromPage(recipe, pageText, context);
    } catch (err) {
      warnings.push(`${recipe.id} page ${page}: ${err.message}`);
      break;
    }

    log.debug('scraped page', { source: recipe.id, page, url: pageUrl, records: pageRecords.length });
    let added = 0;
    for (const record of pageRecords) {
      if (record.externalId === undefined || record.externalId === null || record.externalId === '') continue;
      const key = String(record.externalId);
      if (seen.has(key)) continue;
      seen.add(key);
      records.push({ ...record, source: recipe.sourceId || recipe.id });
      added += 1;
    }
    // An empty page (or one that only repeats what we already have) means we
    // have walked off the end of the result set.
    if (added === 0) break;
  }

  return { records, warnings, pagesFetched };
}

module.exports = {
  runRecipe, validateRecipe, recordsFromPage, mapRecord, extractField,
  getPath, applyTemplate, fillFromRecord, stripTags, decodeEntities, collectRows, TRANSFORMS,
};
