'use strict';

/* AI answers grounded in the actual statute/regulation text.
 *
 * Flow (retrieval-augmented):
 *   1. Gather source sections — either the citations the caller named, or the
 *      top hits from a full-text search of the question.
 *   2. Fetch each section's verbatim text from the official sources.
 *   3. Ask Claude to answer USING ONLY those excerpts, with section citations,
 *      and to say plainly when the excerpts don't settle the question.
 *
 * The model never free-associates tax law: every answer is anchored to text we
 * actually retrieved, and the retrieved sources are returned alongside it so a
 * human can verify. This is research assistance, not tax/legal advice. */

const cfg = require('./config');
const sources = require('./sources');
const citation = require('./citation');

const MAX_DOCS = 5;
const PER_DOC_CHARS = 5000;

const SYSTEM = [
  'You are a tax-law research assistant for a financial company. You help staff',
  'understand the U.S. Internal Revenue Code (Title 26, U.S.C.) and Treasury',
  'regulations (Title 26, C.F.R.).',
  '',
  'Rules:',
  '- Answer USING ONLY the authoritative excerpts provided in the user message.',
  '- Cite the specific section for every assertion, e.g. "26 U.S.C. § 61(a)".',
  '- If the provided excerpts do not fully answer the question, say so explicitly',
  '  and state what additional section(s) would need to be consulted.',
  '- Do not invent section numbers, dollar thresholds, dates, or holdings.',
  '- Be precise and concise. Use short paragraphs or bullets.',
  '- End with a one-line disclaimer: this is general legal information, not legal',
  '  or tax advice, and a qualified professional should confirm before reliance.'
].join('\n');

let _client = null;
function client() {
  if (_client) return _client;
  const Anthropic = require('@anthropic-ai/sdk').default;
  _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

function truncate(text, n = PER_DOC_CHARS) {
  if (!text) return '';
  return text.length > n ? text.slice(0, n) + '\n…[excerpt truncated]…' : text;
}

/* Resolve the set of source sections to ground the answer in. */
async function gatherSources({ question, cite, scope }) {
  const wanted = [];

  // Explicit citations the caller asked us to read.
  if (Array.isArray(cite)) {
    for (const c of cite.slice(0, MAX_DOCS)) wanted.push(c);
  }

  // Otherwise (or to top up), search the question text.
  if (wanted.length < MAX_DOCS) {
    const found = await sources.search(question, { scope, limit: 12 }).catch(() => ({ results: [] }));
    for (const r of found.results) {
      if (wanted.length >= MAX_DOCS) break;
      if (!r.citation) continue;
      if (!wanted.includes(r.citation)) wanted.push(r.citation);
    }
  }

  const docs = [];
  for (const c of wanted) {
    const sec = await sources.getSection(c).catch(() => null);
    if (sec && sec.ok && sec.text) {
      docs.push({
        citation: sec.citation,
        heading: sec.heading,
        text: truncate(sec.text),
        sourceUrl: sec.sourceUrl,
        strategy: sec.strategy
      });
    }
  }
  return docs;
}

function buildUserMessage(question, docs) {
  if (!docs.length) {
    return `Question: ${question}\n\n` +
      'No authoritative excerpts could be retrieved. Tell the user you cannot ' +
      'answer without the source text and suggest the likely Title 26 section(s) ' +
      'to look up, clearly flagging that you are not citing retrieved text.';
  }
  const blocks = docs.map((d, i) =>
    `[Source ${i + 1}] ${d.citation}${d.heading ? ` — ${d.heading}` : ''}\n${d.text}`
  ).join('\n\n----------------------------------------\n\n');
  return `Authoritative excerpts:\n\n${blocks}\n\n========================================\n\nQuestion: ${question}`;
}

async function answer({ question, cite, scope = 'all' } = {}) {
  if (typeof question !== 'string' || !question.trim()) {
    const e = new Error('A non-empty "question" is required.'); e.status = 400; throw e;
  }
  if (!cfg.ai.enabled) {
    const e = new Error('AI answers are disabled — set ANTHROPIC_API_KEY to enable them. Section lookup and search still work without it.');
    e.status = 503; throw e;
  }

  const docs = await gatherSources({ question: question.trim(), cite, scope });
  const userMessage = buildUserMessage(question.trim(), docs);

  const resp = await client().messages.create({
    model: cfg.ai.model,
    max_tokens: cfg.ai.maxTokens,
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userMessage }]
  }, { signal: AbortSignal.timeout(cfg.ai.timeoutMs) });

  const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();

  return {
    question: question.trim(),
    answer: text,
    model: cfg.ai.model,
    grounded: docs.length > 0,
    sources: docs.map((d) => ({ citation: d.citation, heading: d.heading, sourceUrl: d.sourceUrl, strategy: d.strategy })),
    usage: resp.usage || null
  };
}

module.exports = { answer, _internal: { buildUserMessage, truncate, gatherSources } };
