'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const citation = require('../lib/citation');
const http = require('../lib/http');
const usc = require('../lib/sources/usc');
const ecfr = require('../lib/sources/ecfr');
const ai = require('../lib/ai');

test('citation.parse — USC forms normalize to section + label', () => {
  for (const raw of ['61', '§61', '§ 61', 'section 61', '26 USC 61', '26 U.S.C. § 61', 'IRC 61']) {
    const p = citation.parse(raw);
    assert.equal(p.type, 'usc', raw);
    assert.equal(p.section, '61', raw);
    assert.equal(p.label, '26 U.S.C. § 61', raw);
  }
});

test('citation.parse — subdivisions are captured', () => {
  const p = citation.parse('162(a)(1)');
  assert.equal(p.type, 'usc');
  assert.equal(p.section, '162');
  assert.equal(p.subdivision, '(a)(1)');
  assert.equal(p.label, '26 U.S.C. § 162(a)(1)');
});

test('citation.parse — lettered statute sections (e.g. 280F, 6662A)', () => {
  assert.equal(citation.parse('280F').section, '280F');
  assert.equal(citation.parse('26 USC 6662A').section, '6662A');
});

test('citation.parse — CFR section numbers route to cfr', () => {
  const p = citation.parse('1.61-1');
  assert.equal(p.type, 'cfr');
  assert.equal(p.section, '1.61-1');
  assert.equal(p.label, '26 C.F.R. § 1.61-1');
  const q = citation.parse('26 CFR 1.501(c)(3)-1');
  assert.equal(q.type, 'cfr');
  assert.equal(q.section, '1.501(c)(3)-1');
});

test('citation.parse — junk returns null', () => {
  assert.equal(citation.parse(''), null);
  assert.equal(citation.parse('the quick brown fox'), null);
  assert.equal(citation.parse(null), null);
});

test('citation.urls — builds expected official links', () => {
  const usc61 = citation.urls(citation.parse('61'));
  assert.match(usc61.cornell, /\/uscode\/text\/26\/61$/);
  const cfr = citation.urls(citation.parse('1.61-1'));
  assert.match(cfr.cornell, /\/cfr\/text\/26\/1\.61-1$/);
  assert.match(cfr.ecfr, /title-26\/part-1\/section-1\.61-1$/);
});

test('http.stripMarkup — strips tags, decodes entities, keeps structure', () => {
  const out = http.stripMarkup('<p>Gross income &sect; means <b>all income</b></p><p>from whatever source</p>');
  assert.match(out, /Gross income § means all income/);
  assert.match(out, /\n/); // block break preserved
  assert.doesNotMatch(out, /</);
});

test('http.decodeEntities — numeric + named', () => {
  assert.equal(http.decodeEntities('A&#38;B'), 'A&B');
  assert.equal(http.decodeEntities('&#x27;quote&#x27;'), "'quote'");
  assert.equal(http.decodeEntities('a&nbsp;b'), 'a b'.replace(' ',' '));
});

test('usc.granuleMatchesSection — only exact section suffix', () => {
  const m = usc._internal.granuleMatchesSection;
  assert.equal(m('USCODE-2023-title26-subtitleA-chap1-sec61', '61'), true);
  assert.equal(m('USCODE-2023-title26-subtitleA-chap1-sec611', '61'), false);
  assert.equal(m('USCODE-2023-title26-subtitleA-chap1-sec162', '162'), true);
  assert.equal(m(null, '61'), false);
});

test('usc.extractCornellBody — pulls field-item region, drops toolbox', () => {
  const html = '<html><nav>chrome</nav><div class="field-item even">Section text here, plenty of words to pass the length gate.</div><div id="usc-toolbox">junk</div></html>';
  const body = usc._internal.extractCornellBody(html);
  assert.match(body, /Section text here/);
  assert.doesNotMatch(body, /junk/);
});

test('ecfr.partOf — derives part from section number', () => {
  assert.equal(ecfr._internal.partOf('1.61-1'), '1');
  assert.equal(ecfr._internal.partOf('301.7701-3'), '301');
});

test('ai.truncate — bounds long excerpts', () => {
  const long = 'x'.repeat(9000);
  const t = ai._internal.truncate(long, 5000);
  assert.ok(t.length < 5100);
  assert.match(t, /truncated/);
  assert.equal(ai._internal.truncate('short', 5000), 'short');
});

test('ai.buildUserMessage — embeds citations and question', () => {
  const msg = ai._internal.buildUserMessage('Is X taxable?', [
    { citation: '26 U.S.C. § 61', heading: 'Gross income defined', text: 'all income from whatever source' }
  ]);
  assert.match(msg, /\[Source 1\] 26 U\.S\.C\. § 61 — Gross income defined/);
  assert.match(msg, /all income from whatever source/);
  assert.match(msg, /Question: Is X taxable\?/);
});

test('ai.buildUserMessage — no-docs path asks model to flag missing sources', () => {
  const msg = ai._internal.buildUserMessage('q', []);
  assert.match(msg, /No authoritative excerpts/);
});
