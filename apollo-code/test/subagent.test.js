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
import { startFakeOllama, captureStream } from './helpers/fake-server.js';

function harness(baseUrl, { permissionMode = 'yolo' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-sub-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/auth.js'), 'export function requireLogin() {}\n');

  const config = { ...DEFAULTS, baseUrl, model: 'fake-coder:7b', permissionMode };
  const workspace = new Workspace(root);
  const stream = captureStream();
  const agent = new Agent({
    config,
    provider: createProvider(config),
    workspace,
    registry: buildRegistry(),
    permissions: new Permissions({ mode: permissionMode, config }),
    ui: new UI({ color: false, stream }),
    session: new Session({ root: workspace.root }),
    toolMode: 'native',
    rebuildSystem: () => 'system',
  });
  agent.setSystemPrompt('system');
  return { agent, stream, root: workspace.root };
}

test('the task tool runs a sub-agent and returns only its answer', async () => {
  const server = await startFakeOllama({
    turns: [
      // main agent delegates
      { toolCalls: [{ name: 'task', args: { description: 'find auth', prompt: 'Where is login enforced?' } }] },
      // sub-agent: searches, reads, concludes
      { toolCalls: [{ name: 'grep', args: { pattern: 'requireLogin' } }] },
      { toolCalls: [{ name: 'read_file', args: { path: 'src/auth.js' } }] },
      { text: 'Login is enforced by requireLogin at src/auth.js:1.' },
      // main agent answers
      { text: 'It is enforced in src/auth.js.' },
    ],
  });
  try {
    const { agent, stream } = harness(server.baseUrl);
    const answer = await agent.run('where is login enforced?');

    assert.equal(answer, 'It is enforced in src/auth.js.');

    // The main conversation gets the conclusion, not the search transcript.
    const taskResult = agent.session.messages.find((m) => m.role === 'tool' && m.name === 'task');
    assert.match(taskResult.content, /requireLogin at src\/auth\.js:1/);
    assert.equal(
      agent.session.messages.some((m) => m.role === 'tool' && m.name === 'grep'),
      false,
      'sub-agent tool results must not leak into the parent conversation'
    );

    // But the user can see it worked.
    assert.match(stream.text, /↳ grep/);
    assert.match(stream.text, /↳ read_file/);
  } finally {
    await server.close();
  }
});

test('a sub-agent cannot write, run commands, or spawn another sub-agent', async () => {
  const server = await startFakeOllama({
    turns: [
      { toolCalls: [{ name: 'task', args: { description: 'try to write', prompt: 'Create a file.' } }] },
      { toolCalls: [{ name: 'write_file', args: { path: 'evil.txt', content: 'x' } }] },
      { toolCalls: [{ name: 'task', args: { description: 'recurse', prompt: 'go deeper' } }] },
      { text: 'I have no write or delegation tools.' },
      { text: 'Confirmed read-only.' },
    ],
  });
  try {
    const { agent, root, stream } = harness(server.baseUrl);
    await agent.run('make a file via a sub-agent');

    assert.equal(fs.existsSync(path.join(root, 'evil.txt')), false, 'the sub-agent must not be able to write');

    // Both attempts were refused as unknown tools, and the user saw it happen.
    assert.match(stream.text, /↳ write_file/);
    assert.match(stream.text, /↳ task/);
    assert.equal((stream.text.match(/no such tool/g) || []).length, 2);

    // The parent gets the sub-agent's final answer, not its failed attempts.
    const result = agent.session.messages.find((m) => m.role === 'tool' && m.name === 'task');
    assert.equal(result.content, 'I have no write or delegation tools.');
  } finally {
    await server.close();
  }
});

test('sub-agent token usage is billed to the session', async () => {
  const server = await startFakeOllama({
    turns: [
      { toolCalls: [{ name: 'task', args: { description: 'look', prompt: 'What is here?' } }] },
      { text: 'Just one file.' },
      { text: 'One file.' },
    ],
  });
  try {
    const { agent } = harness(server.baseUrl);
    await agent.run('what is here?');
    // Three /api/chat turns at 11 prompt + 7 completion tokens each.
    assert.equal(agent.session.usage.completionTokens, 21);
    assert.equal(agent.session.usage.promptTokens, 33);
  } finally {
    await server.close();
  }
});

test('a sub-agent failure is returned to the parent as a tool error', async () => {
  const server = await startFakeOllama({
    turns: [
      { toolCalls: [{ name: 'task', args: { description: 'bad', prompt: '' } }] },
      { text: 'I need to give it a real question.' },
    ],
  });
  try {
    const { agent } = harness(server.baseUrl);
    await agent.run('delegate badly');
    const result = agent.session.messages.find((m) => m.role === 'tool' && m.name === 'task');
    assert.match(result.content, /Error:.*self-contained question/);
  } finally {
    await server.close();
  }
});

test('the sub-agent registry excludes task and every mutating tool', () => {
  const nested = buildRegistry({ readOnly: true, nested: true });
  for (const name of ['task', 'write_file', 'edit_file', 'multi_edit', 'run_bash']) {
    assert.equal(nested.has(name), false, `${name} must not be available to a sub-agent`);
  }
  for (const name of ['read_file', 'grep', 'glob', 'list_dir']) {
    assert.equal(nested.has(name), true, `${name} should be available to a sub-agent`);
  }
});
