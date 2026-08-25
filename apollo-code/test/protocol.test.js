import test from 'node:test';
import assert from 'node:assert/strict';
import { parseToolCalls, parseJsonLoose, parseLooseToolCalls, hasCompleteToolCall, renderToolInstructions } from '../src/protocol/text-tools.js';
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

// --- lenient JSON fallback for models that ignore the tagged format ---

const TOOLS = ['read_file', 'grep', 'write_file'];

test('a bare OpenAI-style JSON call is accepted', () => {
  const { calls, text } = parseLooseToolCalls('{"name": "read_file", "arguments": {"path": "a.js"}}', TOOLS);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'read_file');
  assert.deepEqual(calls[0].args, { path: 'a.js' });
  assert.equal(text, '');
});

test('the alternative key spellings models use are accepted', () => {
  for (const body of [
    '{"tool": "grep", "parameters": {"pattern": "TODO"}}',
    '{"tool_name": "grep", "args": {"pattern": "TODO"}}',
    '{"name": "grep", "input": {"pattern": "TODO"}}',
    '{"type": "function", "name": "grep", "arguments": {"pattern": "TODO"}}',
  ]) {
    const { calls } = parseLooseToolCalls(body, TOOLS);
    assert.equal(calls.length, 1, body);
    assert.deepEqual(calls[0].args, { pattern: 'TODO' }, body);
  }
});

test('a fenced JSON call is found inside prose', () => {
  const { calls, text } = parseLooseToolCalls(
    'I will read it.\n```json\n{"name": "read_file", "arguments": {"path": "a.js"}}\n```\nThen edit.',
    TOOLS
  );
  assert.equal(calls.length, 1);
  assert.match(text, /I will read it\./);
  assert.ok(!text.includes('read_file'), 'the call is removed from the prose');
});

test('several calls in one JSON array are accepted', () => {
  const { calls } = parseLooseToolCalls(
    '[{"name":"read_file","arguments":{"path":"a.js"}},{"name":"grep","arguments":{"pattern":"x"}}]',
    TOOLS
  );
  assert.deepEqual(calls.map((c) => c.name), ['read_file', 'grep']);
});

test('a tool that does not exist is not treated as a call', () => {
  assert.equal(parseLooseToolCalls('{"name": "rm_rf", "arguments": {}}', TOOLS).calls.length, 0);
});

test('JSON that is genuinely part of an answer is not mistaken for a call', () => {
  for (const body of [
    '{"name": "read_file", "arguments": {"path": "a.js"}, "reason": "because"}',  // extra keys
    '{"name": "Alice", "age": 30}',                                              // not a tool
    'Here is the config: {"name": "read_file"} — as you can see it is JSON.',     // fragment in prose
    '{"path": "a.js"}',                                                          // no name
  ]) {
    assert.equal(parseLooseToolCalls(body, TOOLS).calls.length, 0, body);
  }
});

test('a fenced example of a config file is left alone', () => {
  const answer = 'Your package.json should look like:\n```json\n{"name": "widget", "version": "1.0.0"}\n```\n';
  const { calls, text } = parseLooseToolCalls(answer, TOOLS);
  assert.equal(calls.length, 0);
  assert.equal(text, answer.trim());
});

test('a mixed array is rejected wholesale rather than half-accepted', () => {
  const { calls } = parseLooseToolCalls(
    '[{"name":"read_file","arguments":{"path":"a.js"}},{"name":"not_a_tool","arguments":{}}]',
    TOOLS
  );
  assert.equal(calls.length, 0);
});

test('the fallback only runs when the tagged format produced nothing', async () => {
  const { startFakeOllama, captureStream } = await import('./helpers/fake-server.js');
  const { Agent } = await import('../src/agent.js');
  const { Workspace } = await import('../src/workspace.js');
  const { UI } = await import('../src/ui.js');
  const { Session } = await import('../src/session.js');
  const { Permissions } = await import('../src/permissions.js');
  const { createProvider } = await import('../src/providers/index.js');
  const { DEFAULTS } = await import('../src/config.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');

  const server = await startFakeOllama({
    turns: [
      { text: '{"name": "read_file", "arguments": {"path": "a.txt"}}' },
      { text: 'It says hello.' },
    ],
  });
  try {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-loose-'));
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello\n');
    const config = { ...DEFAULTS, baseUrl: server.baseUrl, model: 'fake-coder:7b', permissionMode: 'yolo' };
    const workspace = new Workspace(root);
    const stream = captureStream();
    const agent = new Agent({
      config, provider: createProvider(config), workspace,
      registry: buildRegistry(),
      permissions: new Permissions({ mode: 'yolo', config }),
      ui: new UI({ color: false, stream }),
      session: new Session({ root: workspace.root }),
      toolMode: 'text', rebuildSystem: () => 'system',
    });
    agent.setSystemPrompt('system');

    assert.equal(await agent.run('what does a.txt say?'), 'It says hello.');
    assert.match(stream.text, /read_file/);
  } finally {
    await server.close();
  }
});
