'use strict';

// Turns whatever a source hands back into one canonical Lot shape. Everything
// downstream — valuation, margin, alerting, the UI — reads only these fields,
// so a new source only ever has to produce this object.

const taxonomy = require('./taxonomy');

const CONDITIONS = ['new', 'refurbished', 'used', 'salvage', 'unknown'];

// Ordered: the first rule that matches wins, so "used, sold for parts" reads as
// salvage rather than used.
const CONDITION_RULES = [
  ['salvage', /\b(for parts|parts only|salvage|non[- ]?functional|not working|does ?n[o']t work|scrap|damaged beyond|incomplete)\b/i],
  ['new', /\b(brand new|new in box|new,? unused|nib|nos|unopened|sealed|unused)\b/i],
  ['refurbished', /\b(refurb(ished)?|reconditioned|remanufactured|renewed)\b/i],
  ['used', /\b(used|pre[- ]?owned|second[- ]?hand|surplus|working|tested|functional|good condition|fair condition)\b/i],
];

const QUANTITY_RULES = [
  /\b(?:lots?|pallets?|boxes|box|cases?|crates?|groups?|sets?|bundles?)\s+of\s+(?:approx(?:imately)?\.?\s+)?(\d{1,5})\b/i,
  /\b(?:qty|quantity|count)\b[:.\s]*(\d{1,5})\b/i,
  /^\s*\(?(\d{1,4})\)?\s*[-–x]\s*(?=[a-z])/i,
  /^\s*\((\d{1,4})\)\s*/,
  /\b(\d{1,4})\s*(?:x|ea\.?|each|units?|pcs?\.?|pieces?)\b(?!\s*\d)/i,
  /\b(?:approx(?:imately)?\.?)\s+(\d{1,4})\s+(?=[a-z])/i,
];

const STATE_CODES = new Set(['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN',
  'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY',
  'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  'DC', 'PR', 'GU', 'VI']);

const STATE_NAMES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID',
  illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
  'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY', 'district of columbia': 'DC',
};

function parseMoney(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const cleaned = String(value).replace(/[^0-9.,-]/g, '').trim();
  if (!cleaned) return null;
  // "1.234,56" (European) vs "1,234.56" (US): whichever separator comes last is
  // the decimal point.
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  let normalized = cleaned;
  if (lastComma > lastDot) normalized = cleaned.replace(/\./g, '').replace(',', '.');
  else normalized = cleaned.replace(/,/g, '');
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'number' || /^\d+$/.test(String(value).trim())) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    // Ten-digit values are seconds; anything longer is already milliseconds.
    const ms = n < 1e11 ? n * 1000 : n;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const parsed = Date.parse(String(value));
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  return null;
}

function parseQuantity(text, explicit) {
  if (explicit !== undefined && explicit !== null && explicit !== '') {
    const n = Number(explicit);
    if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  }
  const haystack = String(text || '');
  for (const rule of QUANTITY_RULES) {
    const match = haystack.match(rule);
    if (match) {
      const n = Number(match[1]);
      if (Number.isFinite(n) && n >= 1 && n <= 100000) return Math.floor(n);
    }
  }
  return 1;
}

function parseCondition(text, explicit) {
  const stated = String(explicit || '').toLowerCase().trim();
  if (stated) {
    for (const [name, pattern] of CONDITION_RULES) {
      if (pattern.test(stated)) return name;
    }
    if (CONDITIONS.includes(stated)) return stated;
  }
  const haystack = String(text || '');
  for (const [name, pattern] of CONDITION_RULES) {
    if (pattern.test(haystack)) return name;
  }
  return 'unknown';
}

// Intel's SKU numbering encodes the generation in the leading digits, but the
// digit count is not a clean signal: 8250U is 8th gen, 1165G7 is 11th, 10510U
// is 10th. Five digits always means gen 10+; four digits mean gen 10+ only when
// they start with a 1 (everything from gen 2 to gen 9 starts with 2-9).
function intelGeneration(digits) {
  if (digits.length >= 5) return Number(digits.slice(0, 2));
  if (digits.length === 4) return Number(digits[0] === '1' ? digits.slice(0, 2) : digits[0]);
  return null;
}

// Pulls the spec bullets that actually move resale value on used business gear.
function parseSpecs(text) {
  const haystack = String(text || '');
  const specs = {};

  const cpu = haystack.match(/\b(?:intel\s+)?(?:core\s+)?(i[3579])[- ]?(\d{3,5})([a-z]{1,2}\d?)?\b/i);
  if (cpu) {
    specs.cpu = cpu[1].toLowerCase();
    if (cpu[2]) {
      specs.cpuModel = `${cpu[2]}${cpu[3] || ''}`.toLowerCase();
      specs.cpuGen = intelGeneration(cpu[2]);
    }
  }
  const xeon = haystack.match(/\bxeon\s+([a-z]?\d?[- ]?\d{3,4}\s?v?\d?)\b/i);
  if (xeon) specs.cpu = `xeon ${xeon[1].toLowerCase().replace(/\s+/g, '')}`;
  const ryzen = haystack.match(/\bryzen\s+([3579])\b/i);
  if (ryzen) specs.cpu = `ryzen ${ryzen[1]}`;
  const apple = haystack.match(/\b(m[1234])\s?(pro|max|ultra)?\b/i);
  if (apple && /\b(macbook|imac|mac\s?mini|mac\s?studio)\b/i.test(haystack)) {
    specs.cpu = `${apple[1].toLowerCase()}${apple[2] ? ' ' + apple[2].toLowerCase() : ''}`;
  }

  const ram = haystack.match(/\b(\d{1,4})\s?gb\s?(?:of\s+)?(?:ddr\d\s?)?(?:ram|memory)\b/i);
  if (ram) specs.ramGb = Number(ram[1]);

  const storage = haystack.match(/\b(\d{1,4})\s?(gb|tb)\s?(ssd|nvme|hdd|hard\s?drive)\b/i);
  if (storage) {
    specs.storageGb = Number(storage[1]) * (/tb/i.test(storage[2]) ? 1024 : 1);
    specs.storageType = /ssd|nvme/i.test(storage[3]) ? 'ssd' : 'hdd';
  }

  const screen = haystack.match(/\b(\d{2}(?:\.\d)?)\s?(?:"|”|''|-?\s?inch\b)/i);
  if (screen) specs.screenInches = Number(screen[1]);

  const ports = haystack.match(/\b(\d{1,3})[- ]?(?:port|pt)\b/i);
  if (ports) specs.ports = Number(ports[1]);

  const year = haystack.match(/\b(19[89]\d|20[0-4]\d)\b/);
  if (year) specs.year = Number(year[1]);

  const mileage = haystack.match(/\b([\d,]{3,9})\s?(?:miles|mi\.|odometer)\b/i);
  if (mileage) specs.miles = Number(mileage[1].replace(/,/g, ''));

  return specs;
}

function parseLocation(value, extra = {}) {
  const raw = String(value || '').trim();
  const location = { raw: raw || null, city: extra.city || null, state: extra.state || null, country: extra.country || 'US' };

  if (extra.state && STATE_CODES.has(String(extra.state).toUpperCase())) {
    location.state = String(extra.state).toUpperCase();
  }
  if (!raw) return location;

  const cityState = raw.match(/^(.*?),\s*([A-Za-z .]{2,20})(?:\s+\d{5}(?:-\d{4})?)?$/);
  if (cityState) {
    if (!location.city) location.city = cityState[1].trim() || null;
    const tail = cityState[2].trim();
    const upper = tail.toUpperCase();
    if (STATE_CODES.has(upper)) location.state = upper;
    else if (STATE_NAMES[tail.toLowerCase()]) location.state = STATE_NAMES[tail.toLowerCase()];
  } else {
    const bare = raw.trim().toUpperCase();
    if (STATE_CODES.has(bare)) location.state = bare;
    else if (STATE_NAMES[raw.trim().toLowerCase()]) location.state = STATE_NAMES[raw.trim().toLowerCase()];
  }
  return location;
}

function cleanTitle(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .trim();
}

function makeLotId(sourceId, externalId) {
  return `${sourceId}:${String(externalId).trim()}`;
}

// `raw` is whatever the adapter produced, already shallow-mapped onto our field
// names. Everything here is defensive: sources drop fields without warning.
function normalizeLot(raw, context = {}) {
  const sourceId = raw.source || context.sourceId || 'unknown';
  const externalId = raw.externalId ?? raw.id;
  if (externalId === undefined || externalId === null || String(externalId).trim() === '') {
    throw new Error(`${sourceId}: listing has no external id`);
  }
  const title = cleanTitle(raw.title);
  if (!title) throw new Error(`${sourceId}: listing ${externalId} has no title`);

  const description = cleanTitle(raw.description || '');
  const haystack = `${title} ${description}`;
  const { category } = taxonomy.classify(haystack, raw.category);
  const quantity = taxonomy.isSingleUnit(category) ? 1 : parseQuantity(haystack, raw.quantity);
  const now = new Date().toISOString();

  const currentBid = parseMoney(raw.currentBid ?? raw.price ?? raw.bid);
  return {
    id: makeLotId(sourceId, externalId),
    source: sourceId,
    externalId: String(externalId),
    title,
    description: description || null,
    url: raw.url || null,
    imageUrl: raw.imageUrl || null,
    category,
    categoryLabel: taxonomy.label(category),
    sourceCategory: raw.category ? String(raw.category) : null,
    condition: parseCondition(haystack, raw.condition),
    quantity,
    specs: parseSpecs(haystack),
    currency: raw.currency || 'USD',
    currentBid: currentBid === null ? 0 : currentBid,
    bidCount: Number.isFinite(Number(raw.bidCount)) ? Number(raw.bidCount) : 0,
    reserveMet: raw.reserveMet === undefined ? null : Boolean(raw.reserveMet),
    closesAt: parseDate(raw.closesAt ?? raw.endsAt ?? raw.endTime),
    seller: raw.seller ? cleanTitle(raw.seller) : null,
    location: parseLocation(raw.location, { city: raw.city, state: raw.state, country: raw.country }),
    firstSeenAt: now,
    lastSeenAt: now,
    priceHistory: currentBid === null ? [] : [{ at: now, bid: currentBid, bidCount: Number(raw.bidCount) || 0 }],
  };
}

module.exports = {
  normalizeLot, parseMoney, parseDate, parseQuantity, parseCondition,
  parseSpecs, parseLocation, cleanTitle, makeLotId, CONDITIONS,
};
