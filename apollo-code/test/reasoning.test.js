import test from 'node:test';
import assert from 'node:assert/strict';
import { ReasoningFilter } from '../src/protocol/reasoning.js';
import { startFakeOllama, captureStream } from './helpers/fake-server.js';

function run(chunks, options = {}) {
  const filter = new ReasoningFilter(options);
  let visible = '';
  let thinking = '';
  for (const chunk of chunks) {
    const step = filter.feed(chunk);
    visible += step.visible;
    thinking += step.thinking;
  }
  const last = filter.flush();
  return { visible: visible + last.visible, thinking: thinking + last.thinking, filter };
}

test('a reasoning block is removed from the visible output', () => {
  const { visible, filter } = run(['<think>Let me work this out. 2+2=4.</think>The answer is 4.']);
  assert.equal(visible, 'The answer is 4.');
  assert.equal(filter.sawReasoning, true);
});

test('text before and after a block is kept', () => {
  const { visible } = run(['Sure. <think>hmm</think>Here it is.']);
  assert.equal(visible, 'Sure. Here it is.');
});

test('a tag split across chunks is still recognised', () => {
  const { visible } = run(['Answer: <thi', 'nk>secret reasoning</thi', 'nk>42']);
  assert.equal(visible, 'Answer: 42');
});

test('several blocks in one reply are all removed', () => {
  const { visible } = run(['<think>a</think>one <think>b</think>two']);
  assert.equal(visible, 'one two');
});

test('the alternative tag spellings are handled', () => {
  assert.equal(run(['<thinking>x</thinking>done']).visible, 'done');
  assert.equal(run(['<reasoning>x</reasoning>done']).visible, 'done');
});

test('an unterminated block is treated as reasoning, not as the answer', () => {
  const { visible, filter } = run(['<think>I was cut off mid-thought']);
  assert.equal(visible, '');
  assert.equal(filter.sawReasoning, true);
});

test('output with no reasoning passes through byte for byte', () => {
  const text = 'Just a normal answer with < and > in it: a < b > c.';
  const { visible, filter } = run([text]);
  assert.equal(visible, text);
  assert.equal(filter.sawReasoning, false);
});

test('text that merely starts like a tag is not swallowed', () => {
  const { visible } = run(['the <thin blue line> is not a tag']);
  assert.equal(visible, 'the <thin blue line> is not a tag');
});

test('show:true surfaces the reasoning separately from the answer', () => {
  const { visible, thinking } = run(['<think>step one, step two</think>done'], { show: true });
  assert.equal(visible, 'done');
  assert.equal(thinking, 'step one, step two');
});

test('nothing is emitted as thinking unless show is set', () => {
  const { thinking } = run(['<think>hidden</think>done']);
  assert.equal(thinking, '');
});

test('a streamed reasoning model reaches the terminal and history clean', async () => {
  const { Agent } = await import('../src/agent.js');
  const { Workspace } = await import('../src/workspace.js');
  const { UI } = await import('../src/ui.js');
  const { Session } = await import('../src/session.js');
  const { Permissions } = await import('../src/permissions.js');
  const { buildRegistry } = await import('../src/tools/index.js');
  const { createProvider } = await import('../src/providers/index.js');
  const { DEFAULTS } = await import('../src/config.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');

  const server = await startFakeOllama({
    turns: [{ text: '<think>The user wants a greeting. I should be brief.</think>Hello.' }],
  });
  try {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-think-'));
    const config = { ...DEFAULTS, baseUrl: server.baseUrl, model: 'fake-coder:7b', permissionMode: 'yolo' };
    const workspace = new Workspace(root);
    const stream = captureStream();
    const agent = new Agent({
      config, provider: createProvider(config), workspace,
      registry: buildRegistry(),
      permissions: new Permissions({ mode: 'yolo', config }),
      ui: new UI({ color: false, stream }),
      session: new Session({ root: workspace.root }),
      toolMode: 'native', rebuildSystem: () => 'system',
    });
    agent.setSystemPrompt('system');

    const answer = await agent.run('say hello');
    assert.equal(answer, 'Hello.');
    assert.ok(!stream.text.includes('<think>'), 'the tag must never reach the terminal');
    assert.ok(!stream.text.includes('wants a greeting'), 'nor the scratchpad');

    const assistant = agent.session.messages.find((m) => m.role === 'assistant');
    assert.equal(assistant.content, 'Hello.', 'history must not carry the scratchpad forward');
  } finally {
    await server.close();
  }
});

test('a tool call inside a reasoning model reply still fires', async () => {
  const { Agent } = await import('../src/agent.js');
  const { Workspace } = await import('../src/workspace.js');
  const { UI } = await import('../src/ui.js');
  const { Session } = await import('../src/session.js');
  const { Permissions } = await import('../src/permissions.js');
  const { buildRegistry } = await import('../src/tools/index.js');
  const { createProvider } = await import('../src/providers/index.js');
  const { DEFAULTS } = await import('../src/config.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');

  const server = await startFakeOllama({
    turns: [
      { text: '<think>I need to look at the file first.</think>Checking.\n<apollo:tool name="read_file">\n{"path": "a.txt"}\n</apollo:tool>' },
      { text: '<think>Now I know.</think>It says hello.' },
    ],
  });
  try {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-think-'));
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

    const answer = await agent.run('what does a.txt say?');
    assert.equal(answer, 'It says hello.');
    assert.match(stream.text, /read_file/);
    assert.ok(!stream.text.includes('<think>'));
  } finally {
    await server.close();
  }
});
