'use strict';

/* Parsing and formatting of US tax citations. Pure functions only — these are
 * the unit-tested core that the source fetchers and the AI layer rely on.
 *
 * We deliberately handle the many ways people write a tax cite:
 *   "61", "§61", "section 61", "26 USC 61", "26 U.S.C. § 61", "IRC 162(a)(1)"
 *   → US Code, Title 26, section 61 / 162.
 *   "1.61-1", "26 CFR 1.61-1", "Treas. Reg. § 1.501(c)(3)-1"
 *   → Code of Federal Regulations, Title 26, section 1.61-1. */

// A CFR section number looks like "1.61-1" — a part number, a dot, then a
// section that may itself contain dots and a trailing "-N". USC sections are
// plain integers, optionally with a letter suffix (e.g. 280F, 6662A).
const CFR_SECTION_RE = /^\d+\.[0-9A-Za-z().-]+$/;
const USC_SECTION_RE = /^\d+[A-Za-z]?$/;

// Trailing subdivision like "(a)(1)(B)" — captured but not required.
const SUBDIV_RE = /((?:\([0-9A-Za-z]+\))+)\s*$/;

function clean(raw) {
  return String(raw || '')
    .replace(/§/g, ' ') // section sign
    .replace(/sections?|§|U\.?S\.?C\.?|I\.?R\.?C\.?|Treas\.?|Reg\.?|Title|title/gi, ' ')
    .replace(/[,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* Returns { type: 'usc'|'cfr', title: 26, section, subdivision|null, label }
 * or null if nothing section-like can be found. Only Title 26 is in scope. */
function parse(raw) {
  if (raw == null) return null;
  let text = clean(raw);
  if (!text) return null;

  // Pull a trailing subdivision off the end before isolating the section token.
  let subdivision = null;
  const subMatch = text.match(SUBDIV_RE);
  if (subMatch) {
    subdivision = subMatch[1];
    text = text.slice(0, subMatch.index).trim();
  }

  // Drop a leading title number ("26") if present, leaving the section token.
  const tokens = text.split(' ').filter(Boolean);
  let token = tokens[tokens.length - 1] || '';
  if (token === '26' && tokens.length > 1) token = tokens[tokens.length - 2];

  if (CFR_SECTION_RE.test(token)) {
    return finalize('cfr', token, subdivision);
  }
  if (USC_SECTION_RE.test(token)) {
    return finalize('usc', token.toUpperCase(), subdivision);
  }
  return null;
}

function finalize(type, section, subdivision) {
  return { type, title: 26, section, subdivision: subdivision || null, label: format(type, section, subdivision) };
}

function format(type, section, subdivision) {
  const sub = subdivision || '';
  return type === 'cfr'
    ? `26 C.F.R. § ${section}${sub}`
    : `26 U.S.C. § ${section}${sub}`;
}

/* Build the canonical public URLs for a parsed citation. */
function urls(parsed, { cornellBase = 'https://www.law.cornell.edu', ecfrBase = 'https://www.ecfr.gov' } = {}) {
  if (!parsed) return {};
  if (parsed.type === 'usc') {
    return { cornell: `${cornellBase}/uscode/text/26/${encodeURIComponent(parsed.section)}` };
  }
  // CFR: split "1.61-1" into part (1) and the rest for the eCFR reader URL.
  const dot = parsed.section.indexOf('.');
  const part = dot > 0 ? parsed.section.slice(0, dot) : parsed.section;
  return {
    cornell: `${cornellBase}/cfr/text/26/${encodeURIComponent(parsed.section)}`,
    ecfr: `${ecfrBase}/current/title-26/part-${encodeURIComponent(part)}/section-${encodeURIComponent(parsed.section)}`
  };
}

module.exports = { parse, format, urls, CFR_SECTION_RE, USC_SECTION_RE };
