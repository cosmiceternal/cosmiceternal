import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../src/agent.js';
import { Workspace } from '../src/workspace.js';
import { UI } from '../src/ui.js';
import { Session } from '../src/session.js';
import { Permissions } from '../src/permissions.js';
import { buildRegistry } from '../src/tools/index.js';
import { createProvider } from '../src/providers/index.js';
import { DEFAULTS } from '../src/config.js';
import { startFakeOllama, startFakeOpenAI, captureStream } from './helpers/fake-server.js';

function harness({ baseUrl, provider = 'ollama', toolMode = 'native', permissionMode = 'yolo', prompt }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-agent-'));
  fs.writeFileSync(path.join(root, 'index.js'), 'const version = "1.0.0";\n');

  const config = { ...DEFAULTS, baseUrl, provider, model: 'fake-coder:7b', permissionMode, toolMode };
  const workspace = new Workspace(root);
  const stream = captureStream();
  const ui = new UI({ color: false, stream });
  const registry = buildRegistry({ readOnly: permissionMode === 'read-only' });
  const session = new Session({ root: workspace.root });

  const agent = new Agent({
    config,
    provider: createProvider(config),
    workspace,
    registry,
    permissions: new Permissions({ mode: permissionMode, config, ui, prompt }),
    ui,
    session,
    toolMode,
    rebuildSystem: () => 'system prompt',
  });
  agent.setSystemPrompt('system prompt');
  return { agent, session, root: workspace.root, stream, config };
}

test('native mode: model calls a tool, sees the result, then answers', async () => {
  const server = await startFakeOllama({
    turns: [
      { text: 'Let me look. ', toolCalls: [{ name: 'read_file', args: { path: 'index.js' } }] },
      { text: 'The version is 1.0.0.' },
    ],
  });
  try {
    const { agent, session, stream } = harness({ baseUrl: server.baseUrl });
    const answer = await agent.run('what version is this?');

    assert.equal(answer, 'The version is 1.0.0.');
    assert.equal(server.remaining(), 0, 'both turns should have been consumed');

    const toolResult = session.messages.find((m) => m.role === 'tool');
    assert.ok(toolResult, 'a tool result message must be recorded');
    assert.match(toolResult.content, /const version = "1\.0\.0";/);
    assert.equal(toolResult.name, 'read_file');

    const assistantWithCall = session.messages.find((m) => m.role === 'assistant' && m.tool_calls);
    assert.equal(assistantWithCall.tool_calls[0].function.name, 'read_file');
    assert.match(stream.text, /read_file/);
  } finally {
    await server.close();
  }
});

test('native mode: tool schemas are actually sent to the server', async () => {
  const server = await startFakeOllama({ turns: [{ text: 'hi' }] });
  try {
    const { agent } = harness({ baseUrl: server.baseUrl });
    await agent.run('hello');
    const chat = server.requests.find((r) => r.url === '/api/chat');
    const names = chat.body.tools.map((t) => t.function.name);
    assert.ok(names.includes('read_file') && names.includes('run_bash'));
    assert.equal(chat.body.messages[0].role, 'system');
  } finally {
    await server.close();
  }
});

test('text mode: a tool block is parsed, hidden from output, and answered', async () => {
  const server = await startFakeOllama({
    turns: [
      { text: 'Checking.\n<apollo:tool name="read_file">\n{"path": "index.js"}\n</apollo:tool>\nignored trailing text' },
      { text: 'It is 1.0.0.' },
    ],
  });
  try {
    const { agent, session, stream } = harness({ baseUrl: server.baseUrl, toolMode: 'text' });
    const answer = await agent.run('what version?');

    assert.equal(answer, 'It is 1.0.0.');
    assert.ok(!stream.text.includes('<apollo:tool'), 'the protocol must never reach the terminal');

    // Results go back as a user turn the chat template can always render.
    const resultTurn = session.messages.find((m) => m.role === 'user' && m.content.includes('<apollo:result'));
    assert.match(resultTurn.content, /const version/);
    assert.equal(session.messages.some((m) => m.role === 'tool'), false);
  } finally {
    await server.close();
  }
});

test('text mode: an unparseable block gets a correction rather than ending the turn', async () => {
  const server = await startFakeOllama({
    turns: [
      { text: '<apollo:tool name="read_file">{oops}</apollo:tool>' },
      { text: 'Sorry — fixed.' },
    ],
  });
  try {
    const { agent, session } = harness({ baseUrl: server.baseUrl, toolMode: 'text' });
    const answer = await agent.run('read it');
    assert.equal(answer, 'Sorry — fixed.');
    assert.ok(session.messages.some((m) => m.role === 'user' && /could not be parsed/.test(m.content)));
  } finally {
    await server.close();
  }
});

test('openai-compatible provider: split tool-call argument frames are reassembled', async () => {
  const server = await startFakeOpenAI({
    turns: [
      { toolCalls: [{ name: 'read_file', args: { path: 'index.js' } }] },
      { text: 'Version 1.0.0.' },
    ],
  });
  try {
    const { agent, session } = harness({ baseUrl: server.baseUrl, provider: 'openai' });
    const answer = await agent.run('version?');
    assert.equal(answer, 'Version 1.0.0.');
    const toolResult = session.messages.find((m) => m.role === 'tool');
    assert.match(toolResult.content, /const version/);
    assert.ok(toolResult.tool_call_id, 'openai requires the call id on the result');
  } finally {
    await server.close();
  }
});

test('a denied tool call is reported back to the model, not executed', async () => {
  const server = await startFakeOllama({
    turns: [
      { toolCalls: [{ name: 'read_file', args: { path: 'index.js' } }] },
      { toolCalls: [{ name: 'write_file', args: { path: 'index.js', content: 'wiped' } }] },
      { text: 'Understood, leaving it alone.' },
    ],
  });
  try {
    const { agent, session, root } = harness({
      baseUrl: server.baseUrl,
      permissionMode: 'ask',
      prompt: async () => 'no:do not touch that file',
    });
    await agent.run('overwrite index.js');

    assert.match(fs.readFileSync(path.join(root, 'index.js'), 'utf8'), /1\.0\.0/, 'file must be untouched');
    const denial = session.messages.find((m) => m.role === 'tool' && m.content.startsWith('Denied'));
    assert.match(denial.content, /do not touch that file/);
  } finally {
    await server.close();
  }
});

test('an approved edit is applied to disk', async () => {
  const server = await startFakeOllama({
    turns: [
      { toolCalls: [{ name: 'read_file', args: { path: 'index.js' } }] },
      { toolCalls: [{ name: 'edit_file', args: { path: 'index.js', old_string: '1.0.0', new_string: '2.0.0' } }] },
      { text: 'Bumped to 2.0.0.' },
    ],
  });
  try {
    const { agent, root } = harness({ baseUrl: server.baseUrl, permissionMode: 'ask', prompt: async () => 'yes' });
    await agent.run('bump the version');
    assert.match(fs.readFileSync(path.join(root, 'index.js'), 'utf8'), /2\.0\.0/);
  } finally {
    await server.close();
  }
});

test('a failing tool returns the error to the model, which can recover', async () => {
  const server = await startFakeOllama({
    turns: [
      { toolCalls: [{ name: 'read_file', args: { path: 'does-not-exist.js' } }] },
      { toolCalls: [{ name: 'read_file', args: { path: 'index.js' } }] },
      { text: 'Found it on the second try.' },
    ],
  });
  try {
    const { agent, session } = harness({ baseUrl: server.baseUrl });
    const answer = await agent.run('read the entry point');
    assert.equal(answer, 'Found it on the second try.');
    const failure = session.messages.find((m) => m.role === 'tool' && m.content.startsWith('Error'));
    assert.match(failure.content, /ENOENT|no such file/i);
  } finally {
    await server.close();
  }
});

test('an unknown tool name is reported with the list of real tools', async () => {
  const server = await startFakeOllama({
    turns: [
      { toolCalls: [{ name: 'delete_everything', args: {} }] },
      { text: 'Right, that tool does not exist.' },
    ],
  });
  try {
    const { agent, session } = harness({ baseUrl: server.baseUrl });
    await agent.run('go');
    const result = session.messages.find((m) => m.role === 'tool');
    assert.match(result.content, /no tool named "delete_everything"/);
    assert.match(result.content, /read_file/);
  } finally {
    await server.close();
  }
});

test('the model is told to read a file before overwriting it', async () => {
  const server = await startFakeOllama({
    turns: [
      { toolCalls: [{ name: 'write_file', args: { path: 'index.js', content: 'wiped' } }] },
      { text: 'Right, I should read it first.' },
    ],
  });
  try {
    const { agent, session, root } = harness({ baseUrl: server.baseUrl });
    await agent.run('rewrite index.js');
    assert.match(fs.readFileSync(path.join(root, 'index.js'), 'utf8'), /1\.0\.0/, 'blind overwrite must not happen');
    assert.match(session.messages.find((m) => m.role === 'tool').content, /have not read it in this session/);
  } finally {
    await server.close();
  }
});

test('read-only mode refuses a write and keeps the file intact', async () => {
  const server = await startFakeOllama({
    turns: [
      { toolCalls: [{ name: 'write_file', args: { path: 'index.js', content: 'x' } }] },
      { text: 'I cannot write in read-only mode.' },
    ],
  });
  try {
    const { agent, root, session } = harness({ baseUrl: server.baseUrl, permissionMode: 'read-only' });
    await agent.run('rewrite it');
    assert.match(fs.readFileSync(path.join(root, 'index.js'), 'utf8'), /1\.0\.0/);
    assert.match(session.messages.find((m) => m.role === 'tool').content, /no tool named "write_file"/);
  } finally {
    await server.close();
  }
});

test('the step limit stops a model that loops forever', async () => {
  const turns = Array.from({ length: 20 }, () => ({
    toolCalls: [{ name: 'list_dir', args: { path: '.' } }],
  }));
  const server = await startFakeOllama({ turns });
  try {
    const { agent, config } = harness({ baseUrl: server.baseUrl });
    config.maxSteps = 3;
    await agent.run('loop');
    assert.equal(server.requests.filter((r) => r.url === '/api/chat').length, 3);
  } finally {
    await server.close();
  }
});

test('a session round-trips through disk', async () => {
  const server = await startFakeOllama({ turns: [{ text: 'saved' }] });
  try {
    const { agent, session, root } = harness({ baseUrl: server.baseUrl });
    await agent.run('remember this');
    session.save();

    const reloaded = Session.load(root, 'last');
    assert.equal(reloaded.id, session.id);
    assert.equal(reloaded.messages.some((m) => m.content === 'remember this'), true);
    assert.equal(reloaded.messages.some((m) => m.role === 'system'), false, 'system prompt is rebuilt, not stored');
    assert.equal(Session.list(root).length, 1);
  } finally {
    await server.close();
  }
});

test('todo_write state survives into the session', async () => {
  const server = await startFakeOllama({
    turns: [
      { toolCalls: [{ name: 'todo_write', args: { todos: [{ content: 'Ship it', status: 'in_progress' }] } }] },
      { text: 'Working on it.' },
    ],
  });
  try {
    const { agent, session } = harness({ baseUrl: server.baseUrl });
    await agent.run('plan the work');
    assert.deepEqual(session.todos, [{ content: 'Ship it', status: 'in_progress' }]);
  } finally {
    await server.close();
  }
});

test('token usage reported by the server is accumulated', async () => {
  const server = await startFakeOllama({ turns: [{ text: 'hi' }] });
  try {
    const { agent, session } = harness({ baseUrl: server.baseUrl });
    await agent.run('hello');
    assert.equal(session.usage.promptTokens, 11);
    assert.equal(session.usage.completionTokens, 7);
    assert.equal(session.usage.turns, 1);
  } finally {
    await server.close();
  }
});

test('an unreachable server produces an actionable error', async () => {
  const { agent } = harness({ baseUrl: 'http://127.0.0.1:1' });
  await assert.rejects(agent.run('hello'), (err) => {
    assert.match(err.message, /could not reach/);
    assert.match(err.hint, /apollo doctor/);
    return true;
  });
});

test('a connection dropped while the model loads is retried', async () => {
  // First connection attempt is refused, then the server comes up.
  const { createServer } = await import('node:http');
  const flaky = createServer();
  let attempts = 0;
  flaky.on('request', (req, res) => {
    attempts++;
    if (attempts === 1) { req.socket.destroy(); return; }
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.end(JSON.stringify({ message: { role: 'assistant', content: 'up now' }, done: true }) + '\n');
  });
  await new Promise((r) => flaky.listen(0, '127.0.0.1', r));

  try {
    const { agent } = harness({ baseUrl: `http://127.0.0.1:${flaky.address().port}` });
    const answer = await agent.run('hello');
    assert.equal(answer, 'up now');
    assert.equal(attempts, 2, 'should have retried exactly once');
  } finally {
    await new Promise((r) => flaky.close(r));
  }
});

test('an HTTP error is surfaced immediately rather than retried', async () => {
  const { createServer } = await import('node:http');
  let attempts = 0;
  const server = createServer((req, res) => {
    attempts++;
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'model does not support tools' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  try {
    const { agent } = harness({ baseUrl: `http://127.0.0.1:${server.address().port}` });
    await assert.rejects(agent.run('hi'), /400/);
    assert.equal(attempts, 1, 'a 400 is a bug in the request, not a flake');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('ollama is asked to keep the model resident between turns', async () => {
  const server = await startFakeOllama({ turns: [{ text: 'hi' }] });
  try {
    const { agent } = harness({ baseUrl: server.baseUrl });
    await agent.run('hello');
    assert.equal(server.requests.find((r) => r.url === '/api/chat').body.keep_alive, '30m');
  } finally {
    await server.close();
  }
});

test('--no-stream holds rendering until the reply is complete', async () => {
  const server = await startFakeOllama({ turns: [{ text: 'One. Two. Three. Four.' }] });
  try {
    const { agent, stream, config } = harness({ baseUrl: server.baseUrl });
    config.stream = false;

    // Nothing should appear while the tokens are arriving...
    const seenDuring = [];
    const originalWrite = stream.write;
    stream.write = (chunk) => { seenDuring.push(chunk); return originalWrite(chunk); };

    const answer = await agent.run('count');
    assert.equal(answer, 'One. Two. Three. Four.');

    // ...and the whole reply arrives in one render, not eight token-sized ones.
    const textWrites = seenDuring.filter((c) => c.includes('One') || c.includes('Four'));
    assert.equal(textWrites.length, 1, 'the reply should be rendered once, whole');
    assert.match(stream.text, /One\. Two\. Three\. Four\./);
  } finally {
    await server.close();
  }
});

test('streaming is still incremental by default', async () => {
  const server = await startFakeOllama({ turns: [{ text: 'One. Two. Three. Four.' }] });
  try {
    const { agent, stream } = harness({ baseUrl: server.baseUrl });
    const writes = [];
    const originalWrite = stream.write;
    stream.write = (chunk) => { writes.push(chunk); return originalWrite(chunk); };

    await agent.run('count');
    assert.ok(writes.length > 2, 'default mode should emit progressively');
  } finally {
    await server.close();
  }
});

test('the answer is the last turn that actually said something', async () => {
  const server = await startFakeOllama({
    turns: [
      { text: 'Here is what I found.', toolCalls: [{ name: 'list_dir', args: { path: '.' } }] },
      { toolCalls: [{ name: 'list_dir', args: { path: '.' } }] },   // no prose
    ],
  });
  try {
    const { agent, config } = harness({ baseUrl: server.baseUrl });
    config.maxSteps = 2;
    const answer = await agent.run('look around');
    assert.equal(answer, 'Here is what I found.', 'an empty final turn must not erase the answer');
  } finally {
    await server.close();
  }
});

test('repeatedly malformed tool blocks end the turn instead of looping', async () => {
  const turns = Array.from({ length: 20 }, () => ({
    text: '<apollo:tool name="read_file">{{{broken</apollo:tool>',
  }));
  const server = await startFakeOllama({ turns });
  try {
    const { agent, stream, config } = harness({ baseUrl: server.baseUrl, toolMode: 'text' });
    config.maxSteps = 20;
    await agent.run('read something');

    // Three corrections, then a fourth turn that gives up: 4 requests, not 20.
    assert.equal(server.requests.filter((r) => r.url === '/api/chat').length, 4);
    assert.match(stream.text, /kept emitting malformed tool calls/);
  } finally {
    await server.close();
  }
});

test('a model looping on the same call is told the result will not change', async () => {
  const turns = Array.from({ length: 8 }, () => ({
    toolCalls: [{ name: 'list_dir', args: { path: '.' } }],
  }));
  const server = await startFakeOllama({ turns });
  try {
    const { agent, config } = harness({ baseUrl: server.baseUrl });
    config.maxSteps = 5;
    await agent.run('list it');

    const nudge = agent.session.messages.find(
      (m) => m.role === 'user' && /same tool call/.test(m.content)
    );
    assert.ok(nudge, 'the model should be told it is repeating itself');
    assert.match(nudge.content, /3 times/);
  } finally {
    await server.close();
  }
});

test('different tool calls are not mistaken for a loop', async () => {
  const server = await startFakeOllama({
    turns: [
      { toolCalls: [{ name: 'list_dir', args: { path: '.' } }] },
      { toolCalls: [{ name: 'glob', args: { pattern: '*.js' } }] },
      { toolCalls: [{ name: 'list_dir', args: { path: '.' } }] },
      { text: 'Done.' },
    ],
  });
  try {
    const { agent } = harness({ baseUrl: server.baseUrl });
    await agent.run('explore');
    assert.equal(agent.session.messages.some((m) => /same tool call/.test(m.content || '')), false);
  } finally {
    await server.close();
  }
});

test('argument key order does not hide a repeated call', async () => {
  const turns = [
    { toolCalls: [{ name: 'grep', args: { pattern: 'x', path: '.' } }] },
    { toolCalls: [{ name: 'grep', args: { path: '.', pattern: 'x' } }] },
    { toolCalls: [{ name: 'grep', args: { pattern: 'x', path: '.' } }] },
    { text: 'Done.' },
  ];
  const server = await startFakeOllama({ turns });
  try {
    const { agent } = harness({ baseUrl: server.baseUrl });
    await agent.run('search');
    assert.ok(agent.session.messages.some((m) => /same tool call/.test(m.content || '')));
  } finally {
    await server.close();
  }
});
