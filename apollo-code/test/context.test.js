import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, messageTokens, conversationTokens, needsCompaction, usageReport, compact, TokenCalibration } from '../src/context.js';
import { DEFAULTS } from '../src/config.js';

const config = { ...DEFAULTS, contextTokens: 1000, maxTokens: 200, compactAt: 0.75 };

/** A provider stand-in that returns a fixed summary. */
const fakeProvider = (summary = 'The user asked about X. Files A and B were read.') => ({
  seen: [],
  async *chat({ messages }) {
    this.seen.push(messages);
    yield { type: 'text', delta: summary };
    yield { type: 'usage', promptTokens: 1, completionTokens: 1 };
  },
});

test('token estimates scale with text length', () => {
  assert.equal(estimateTokens(''), 0);
  assert.ok(estimateTokens('a'.repeat(400)) > estimateTokens('a'.repeat(40)));
});

test('tool calls count toward the conversation total', () => {
  const plain = [{ role: 'assistant', content: 'hi' }];
  const withCall = [{
    role: 'assistant',
    content: 'hi',
    tool_calls: [{ function: { name: 'read_file', arguments: '{"path":"a-very-long-path.js"}' } }],
  }];
  assert.ok(conversationTokens(withCall) > conversationTokens(plain));
});

test('usage is measured against the window minus the reply reservation', () => {
  const report = usageReport([{ role: 'user', content: 'x'.repeat(1600) }], config);
  assert.equal(report.budget, 800);
  assert.ok(report.fraction > 0.4 && report.fraction < 0.6);
});

test('compaction triggers only once the threshold is crossed', () => {
  assert.equal(needsCompaction([{ role: 'user', content: 'short' }], config), false);
  assert.equal(needsCompaction([{ role: 'user', content: 'x'.repeat(2600) }], config), true);
});

test('compact replaces old turns with a summary and keeps the system prompt', async () => {
  const messages = [
    { role: 'system', content: 'system prompt' },
    ...Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i} ` + 'x'.repeat(400) })),
  ];
  const before = conversationTokens(messages);
  const result = await compact(messages, fakeProvider());

  assert.equal(result.compacted, true);
  assert.equal(result.messages[0].role, 'system');
  assert.equal(result.messages[0].content, 'system prompt');
  assert.match(result.messages[1].content, /conversation summary/);
  assert.match(result.messages[1].content, /Files A and B/);
  assert.ok(conversationTokens(result.messages) < before);
  assert.ok(result.freed > 0);

  // The most recent exchanges must survive verbatim.
  assert.equal(result.messages.at(-1).content, messages.at(-1).content);
});

test('compact leaves a short conversation alone', async () => {
  const messages = [
    { role: 'system', content: 's' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ];
  const result = await compact(messages, fakeProvider());
  assert.equal(result.compacted, false);
  assert.equal(result.messages, messages);
});

test('compact never orphans a tool result from its assistant turn', async () => {
  const messages = [
    { role: 'system', content: 's' },
    ...Array.from({ length: 8 }, (_, i) => ({ role: 'user', content: `old ${i}` })),
    { role: 'assistant', content: '', tool_calls: [{ id: '1', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: '1', name: 'read_file', content: 'contents' },
    { role: 'assistant', content: 'done' },
  ];
  const result = await compact(messages, fakeProvider(), { keepRecent: 2 });
  const kept = result.messages.filter((m) => m.role === 'tool');
  for (const toolMsg of kept) {
    const idx = result.messages.indexOf(toolMsg);
    const priorRoles = result.messages.slice(0, idx).map((m) => m.role);
    assert.ok(priorRoles.includes('assistant'), 'a tool result must follow an assistant turn');
  }
});

test('an empty summary aborts compaction rather than losing history', async () => {
  const messages = [
    { role: 'system', content: 's' },
    ...Array.from({ length: 12 }, (_, i) => ({ role: 'user', content: `turn ${i}` })),
  ];
  const result = await compact(messages, fakeProvider('   '));
  assert.equal(result.compacted, false);
  assert.equal(result.messages.length, messages.length);
});

test('calibration scales estimates toward what the server actually reported', () => {
  const cal = new TokenCalibration();
  assert.equal(cal.ratio, 1);

  // The server says the prompt was 1500 tokens where we guessed 1000.
  cal.observe(1500, 1000);
  assert.equal(cal.ratio, 1.5, 'the first measurement is taken at face value');

  // A second, similar reading barely moves it.
  cal.observe(1520, 1000);
  assert.ok(cal.ratio > 1.4 && cal.ratio < 1.6);
});

test('calibration ignores nonsense readings and clamps extremes', () => {
  const cal = new TokenCalibration();
  for (const [actual, estimated] of [[0, 100], [-5, 100], [100, 0], [NaN, 100]]) {
    cal.observe(actual, estimated);
    assert.equal(cal.ratio, 1, `${actual}/${estimated} should be ignored`);
  }
  cal.observe(100000, 10);   // absurd
  assert.equal(cal.ratio, 3, 'clamped to the upper bound');
});

test('a calibrated estimate shifts the compaction threshold', () => {
  const messages = [{ role: 'user', content: 'x'.repeat(2000) }];   // ~500 raw tokens
  const cfg = { ...DEFAULTS, contextTokens: 1000, maxTokens: 200, compactAt: 0.75 };

  assert.equal(needsCompaction(messages, cfg), false, 'raw estimate fits');

  const cal = new TokenCalibration();
  cal.observe(1000, 500);   // this model really uses twice what we guessed
  assert.equal(needsCompaction(messages, cfg, cal), true, 'calibrated estimate does not');
});

test('usageReport exposes both the raw and calibrated figures', () => {
  const messages = [{ role: 'user', content: 'x'.repeat(800) }];
  const cfg = { ...DEFAULTS, contextTokens: 1000, maxTokens: 200 };

  const cal = new TokenCalibration();
  cal.observe(300, 200);   // ratio 1.5

  const report = usageReport(messages, cfg, cal);
  assert.equal(report.raw, conversationTokens(messages), 'raw is the uncalibrated estimate');
  assert.equal(report.used, Math.round(report.raw * 1.5));
  assert.equal(usageReport(messages, cfg).used, report.raw, 'no calibration means no scaling');
});

test('messageTokens accounts for role framing and tool-call payloads', () => {
  const plain = messageTokens({ role: 'user', content: 'hello' });
  assert.ok(plain > estimateTokens('hello'), 'framing overhead is included');

  const withCall = messageTokens({
    role: 'assistant',
    content: '',
    tool_calls: [{ function: { name: 'read_file', arguments: '{"path":"src/a-long-file-name.js"}' } }],
  });
  assert.ok(withCall > plain, 'a tool call costs more than an empty message');

  assert.equal(messageTokens({ role: 'user', content: '' }), 4, 'an empty message is just framing');
});
