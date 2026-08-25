import test from 'node:test';
import assert from 'node:assert/strict';
import { parseToolCalls, parseJsonLoose, hasCompleteToolCall, renderToolInstructions } from '../src/protocol/text-tools.js';
import { StreamFilter } from '../src/agent.js';
import { buildRegistry } from '../src/tools/index.js';

test('parses a single tool call and strips it from the prose', () => {
  const { text, calls } = parseToolCalls(
    'Let me check.\n<apollo:tool name="read_file">\n{"path": "a.js"}\n</apollo:tool>\nThen I will edit it.'
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, { path: 'a.js' });
  assert.equal(calls[0].name, 'read_file');
  assert.ok(!text.includes('apollo:tool'));
  assert.ok(text.includes('Let me check.'));
});

test('parses several calls in order', () => {
  const { calls } = parseToolCalls(
    '<apollo:tool name="glob">{"pattern":"**/*.js"}</apollo:tool>' +
    '<apollo:tool name="grep">{"pattern":"TODO"}</apollo:tool>'
  );
  assert.deepEqual(calls.map((c) => c.name), ['glob', 'grep']);
});

test('tolerates single quotes on the name attribute and no quotes at all', () => {
  assert.equal(parseToolCalls(`<apollo:tool name='glob'>{"pattern":"*"}</apollo:tool>`).calls.length, 1);
  assert.equal(parseToolCalls(`<apollo:tool name=glob>{"pattern":"*"}</apollo:tool>`).calls.length, 1);
});

test('unwraps a block the model put inside a markdown fence', () => {
  const { calls } = parseToolCalls('```xml\n<apollo:tool name="list_dir">\n{"path":"."}\n</apollo:tool>\n```');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'list_dir');
});

test('recovers a call whose closing tag never arrived', () => {
  const { calls } = parseToolCalls('<apollo:tool name="read_file">\n{"path": "a.js"}\n');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, { path: 'a.js' });
});

test('repairs trailing commas rather than dropping the call', () => {
  const { calls, errors } = parseToolCalls('<apollo:tool name="read_file">{"path":"a.js",}</apollo:tool>');
  assert.equal(errors.length, 0);
  assert.deepEqual(calls[0].args, { path: 'a.js' });
});

test('reports unparseable arguments instead of throwing', () => {
  const { calls, errors } = parseToolCalls('<apollo:tool name="read_file">not json at all</apollo:tool>');
  assert.equal(calls.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /read_file/);
});

test('output with no tool block passes through untouched', () => {
  const { text, calls } = parseToolCalls('Just an answer.');
  assert.equal(text, 'Just an answer.');
  assert.equal(calls.length, 0);
});

test('parseJsonLoose accepts an empty body and prose-wrapped JSON', () => {
  assert.deepEqual(parseJsonLoose(''), {});
  assert.deepEqual(parseJsonLoose('here you go: {"a":1} thanks'), { a: 1 });
});

test('hasCompleteToolCall detects a finished block for early stopping', () => {
  assert.equal(hasCompleteToolCall('<apollo:tool name="a">{}'), false);
  assert.equal(hasCompleteToolCall('<apollo:tool name="a">{}</apollo:tool>'), true);
  assert.equal(hasCompleteToolCall('no tools here'), false);
});

test('tool instructions name every registered tool', () => {
  const registry = buildRegistry();
  const text = renderToolInstructions(registry);
  for (const name of registry.keys()) assert.ok(text.includes(name), `${name} missing from instructions`);
});

test('StreamFilter hides a tool block from the terminal, split across chunks', () => {
  const filter = new StreamFilter();
  let shown = '';
  for (const chunk of ['I will read it.\n', '<apo', 'llo:tool name="read', '_file">{"path":"a.js"}</apollo:tool>']) {
    shown += filter.feed(chunk);
  }
  shown += filter.flush();
  assert.equal(shown, 'I will read it.\n');
});

test('StreamFilter passes through text that only looks like the marker', () => {
  const filter = new StreamFilter();
  const prose = 'the <apollo:toolbox> is not a call';
  assert.equal(filter.feed(prose) + filter.flush(), prose);
});

test('StreamFilter still suppresses a real call after a near-miss', () => {
  const filter = new StreamFilter();
  const shown = filter.feed('<apollo:toolbox> then <apollo:tool name="glob">{"pattern":"*"}</apollo:tool>')
    + filter.flush();
  assert.equal(shown, '<apollo:toolbox> then ');
});
