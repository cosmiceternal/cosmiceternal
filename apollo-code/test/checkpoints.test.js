import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CheckpointStore } from '../src/checkpoints.js';
import { startFakeOllama } from './helpers/fake-server.js';
import { Agent } from '../src/agent.js';
import { Workspace } from '../src/workspace.js';
import { UI } from '../src/ui.js';
import { Session } from '../src/session.js';
import { Permissions } from '../src/permissions.js';
import { buildRegistry } from '../src/tools/index.js';
import { createProvider } from '../src/providers/index.js';
import { DEFAULTS } from '../src/config.js';
import { captureStream } from './helpers/fake-server.js';

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-ckpt-'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'original\n');
  return root;
}

test('undo restores a modified file', () => {
  const root = tmpRoot();
  const store = new CheckpointStore({ root });
  const file = path.join(root, 'a.txt');

  const snapshot = store.capture([file]);
  fs.writeFileSync(file, 'modified\n');
  store.commit('edit_file a.txt', snapshot);

  const result = store.undo();
  assert.equal(fs.readFileSync(file, 'utf8'), 'original\n');
  assert.deepEqual(result.restored, ['a.txt']);
  assert.equal(result.label, 'edit_file a.txt');
});

test('undo deletes a file that did not exist before', () => {
  const root = tmpRoot();
  const store = new CheckpointStore({ root });
  const file = path.join(root, 'new.txt');

  const snapshot = store.capture([file]);
  fs.writeFileSync(file, 'created\n');
  store.commit('write_file new.txt', snapshot);

  const result = store.undo();
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(result.deleted, ['new.txt']);
});

test('undo walks back one change at a time', () => {
  const root = tmpRoot();
  const store = new CheckpointStore({ root });
  const file = path.join(root, 'a.txt');

  for (const version of ['v1\n', 'v2\n', 'v3\n']) {
    const snapshot = store.capture([file]);
    fs.writeFileSync(file, version);
    store.commit(`write ${version.trim()}`, snapshot);
  }

  store.undo();
  assert.equal(fs.readFileSync(file, 'utf8'), 'v2\n');
  store.undo();
  assert.equal(fs.readFileSync(file, 'utf8'), 'v1\n');
  store.undo();
  assert.equal(fs.readFileSync(file, 'utf8'), 'original\n');
  assert.throws(() => store.undo(), /nothing to undo/);
});

test('a specific checkpoint can be reverted by id', () => {
  const root = tmpRoot();
  const store = new CheckpointStore({ root });
  const a = path.join(root, 'a.txt');
  const b = path.join(root, 'b.txt');

  const first = store.capture([a]);
  fs.writeFileSync(a, 'changed a\n');
  const entry = store.commit('edit a', first);

  const second = store.capture([b]);
  fs.writeFileSync(b, 'changed b\n');
  store.commit('edit b', second);

  store.undo(entry.id);
  assert.equal(fs.readFileSync(a, 'utf8'), 'original\n', 'the targeted file is reverted');
  assert.equal(fs.readFileSync(b, 'utf8'), 'changed b\n', 'the later change is left alone');
});

test('checkpoints survive a restart of the store', () => {
  const root = tmpRoot();
  const file = path.join(root, 'a.txt');

  const first = new CheckpointStore({ root });
  const snapshot = first.capture([file]);
  fs.writeFileSync(file, 'modified\n');
  first.commit('edit', snapshot);

  const reopened = new CheckpointStore({ root });
  assert.equal(reopened.list().length, 1);
  reopened.undo();
  assert.equal(fs.readFileSync(file, 'utf8'), 'original\n');
});

test('the history is pruned to the configured limit', () => {
  const root = tmpRoot();
  const store = new CheckpointStore({ root, limit: 3 });
  const file = path.join(root, 'a.txt');
  for (let i = 0; i < 6; i++) {
    const snapshot = store.capture([file]);
    fs.writeFileSync(file, `v${i}\n`);
    store.commit(`v${i}`, snapshot);
  }
  assert.equal(store.list(99).length, 3);
});

test('an empty snapshot records nothing', () => {
  const store = new CheckpointStore({ root: tmpRoot() });
  assert.equal(store.commit('noop', []), null);
  assert.equal(store.list().length, 0);
});

test('an agent edit is checkpointed and can be undone', async () => {
  const server = await startFakeOllama({
    turns: [
      { toolCalls: [{ name: 'read_file', args: { path: 'index.js' } }] },
      { toolCalls: [{ name: 'edit_file', args: { path: 'index.js', old_string: '1.0.0', new_string: '9.9.9' } }] },
      { text: 'Done.' },
    ],
  });
  try {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-ckpt-agent-'));
    fs.writeFileSync(path.join(root, 'index.js'), 'const version = "1.0.0";\n');

    const config = { ...DEFAULTS, baseUrl: server.baseUrl, model: 'fake-coder:7b', permissionMode: 'yolo' };
    const workspace = new Workspace(root);
    const agent = new Agent({
      config,
      provider: createProvider(config),
      workspace,
      registry: buildRegistry(),
      permissions: new Permissions({ mode: 'yolo', config }),
      ui: new UI({ color: false, stream: captureStream() }),
      session: new Session({ root: workspace.root }),
      toolMode: 'native',
      rebuildSystem: () => 'system',
    });
    agent.setSystemPrompt('system');

    await agent.run('bump the version');
    assert.match(fs.readFileSync(path.join(workspace.root, 'index.js'), 'utf8'), /9\.9\.9/);

    const entries = agent.checkpoints.list();
    assert.equal(entries.length, 1);
    assert.match(entries[0].label, /edit_file index\.js/);

    agent.checkpoints.undo();
    assert.match(fs.readFileSync(path.join(workspace.root, 'index.js'), 'utf8'), /1\.0\.0/);
  } finally {
    await server.close();
  }
});

test('a failed tool leaves no checkpoint behind', async () => {
  const server = await startFakeOllama({
    turns: [
      { toolCalls: [{ name: 'edit_file', args: { path: 'missing.js', old_string: 'a', new_string: 'b' } }] },
      { text: 'That file is not there.' },
    ],
  });
  try {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-ckpt-fail-'));
    const config = { ...DEFAULTS, baseUrl: server.baseUrl, model: 'fake-coder:7b', permissionMode: 'yolo' };
    const workspace = new Workspace(root);
    const agent = new Agent({
      config,
      provider: createProvider(config),
      workspace,
      registry: buildRegistry(),
      permissions: new Permissions({ mode: 'yolo', config }),
      ui: new UI({ color: false, stream: captureStream() }),
      session: new Session({ root: workspace.root }),
      toolMode: 'native',
      rebuildSystem: () => 'system',
    });
    agent.setSystemPrompt('system');
    await agent.run('edit a missing file');
    assert.equal(agent.checkpoints.list().length, 0);
  } finally {
    await server.close();
  }
});

test('saved sessions are pruned so the directory does not grow forever', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-prune-'));
  for (let i = 0; i < 8; i++) {
    const session = new Session({ root });
    session.messages.push({ role: 'user', content: `session ${i}` });
    session.save({ keep: 3 });
  }
  assert.equal(fs.readdirSync(path.join(root, '.apollo', 'sessions')).length, 3);

  // The survivors are the most recent ones.
  const titles = Session.list(root, 99).map((s) => s.title);
  assert.deepEqual(titles.sort(), ['session 5', 'session 6', 'session 7']);
});

test('/resume adopts a saved session in place, keeping the system prompt', async () => {
  const { runCommand } = await import('../src/commands.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-resume-'));

  const earlier = new Session({ root });
  earlier.messages.push({ role: 'user', content: 'the earlier question' });
  earlier.usage = { promptTokens: 5, completionTokens: 6, turns: 1 };
  earlier.save();

  const current = new Session({ root });
  current.messages.push({ role: 'system', content: 'current system prompt' });
  current.messages.push({ role: 'user', content: 'something else' });

  const stream = captureStream();
  const agent = { state: { todos: [] } };
  await runCommand(`/resume ${earlier.id}`, {
    ui: new UI({ color: false, stream }), session: current,
    workspace: { root }, agent,
  });

  assert.equal(current.id, earlier.id);
  assert.equal(current.messages[0].content, 'current system prompt', 'the live system prompt is kept');
  assert.equal(current.messages[1].content, 'the earlier question');
  assert.equal(current.usage.turns, 1);
  assert.match(stream.text, /Resumed/);
});

test('/undo turn reverts every file the last turn touched', () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'b.txt'), 'b original\n');
  const store = new CheckpointStore({ root });
  const a = path.join(root, 'a.txt');
  const b = path.join(root, 'b.txt');

  // Turn 1: one change we want to keep.
  store.beginTurn(1);
  let snapshot = store.capture([a]);
  fs.writeFileSync(a, 'turn one\n');
  store.commit('edit a', snapshot);

  // Turn 2: three changes across two files, plus a new file.
  store.beginTurn(2);
  for (const [file, content] of [[a, 'turn two\n'], [b, 'turn two b\n']]) {
    snapshot = store.capture([file]);
    fs.writeFileSync(file, content);
    store.commit(`edit ${path.basename(file)}`, snapshot);
  }
  const created = path.join(root, 'new.txt');
  snapshot = store.capture([created]);
  fs.writeFileSync(created, 'created in turn two\n');
  store.commit('write new.txt', snapshot);

  const result = store.undo('turn');
  assert.equal(result.count, 3);
  assert.equal(fs.readFileSync(a, 'utf8'), 'turn one\n', 'turn 1 change is preserved');
  assert.equal(fs.readFileSync(b, 'utf8'), 'b original\n');
  assert.equal(fs.existsSync(created), false);
  assert.deepEqual(result.deleted, ['new.txt']);
  assert.deepEqual(result.restored.sort(), ['a.txt', 'b.txt']);

  // Turn 1's checkpoint survives and can still be undone.
  assert.equal(store.list().length, 1);
  store.undo();
  assert.equal(fs.readFileSync(a, 'utf8'), 'original\n');
});

test('a file edited twice in one turn is restored to its pre-turn state', () => {
  const root = tmpRoot();
  const store = new CheckpointStore({ root });
  const file = path.join(root, 'a.txt');

  store.beginTurn(1);
  for (const content of ['first edit\n', 'second edit\n', 'third edit\n']) {
    const snapshot = store.capture([file]);
    fs.writeFileSync(file, content);
    store.commit('edit', snapshot);
  }

  store.undo('turn');
  assert.equal(fs.readFileSync(file, 'utf8'), 'original\n', 'the earliest snapshot must win');
});

test('/undo all reverts everything still recorded', () => {
  const root = tmpRoot();
  const store = new CheckpointStore({ root });
  const file = path.join(root, 'a.txt');

  for (let turn = 1; turn <= 3; turn++) {
    store.beginTurn(turn);
    const snapshot = store.capture([file]);
    fs.writeFileSync(file, `turn ${turn}\n`);
    store.commit(`edit turn ${turn}`, snapshot);
  }

  const result = store.undo('all');
  assert.equal(result.count, 3);
  assert.equal(fs.readFileSync(file, 'utf8'), 'original\n');
  assert.equal(store.list().length, 0);
  assert.throws(() => store.undo(), /nothing to undo/);
});

test('a file created and then edited in one turn is deleted, not restored', () => {
  const root = tmpRoot();
  const store = new CheckpointStore({ root });
  const file = path.join(root, 'fresh.txt');

  store.beginTurn(1);
  let snapshot = store.capture([file]);
  fs.writeFileSync(file, 'v1\n');
  store.commit('write fresh.txt', snapshot);

  snapshot = store.capture([file]);
  fs.writeFileSync(file, 'v2\n');
  store.commit('edit fresh.txt', snapshot);

  const result = store.undo('turn');
  assert.equal(fs.existsSync(file), false, 'the file never existed before the turn');
  assert.deepEqual(result.deleted, ['fresh.txt']);
  assert.deepEqual(result.restored, []);
});

test('an unknown selector is reported rather than reverting something else', () => {
  const root = tmpRoot();
  const store = new CheckpointStore({ root });
  const snapshot = store.capture([path.join(root, 'a.txt')]);
  fs.writeFileSync(path.join(root, 'a.txt'), 'changed\n');
  store.commit('edit', snapshot);

  assert.throws(() => store.undo('9999-nope'), /no checkpoint matching/);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'changed\n', 'nothing was reverted');
});

test('an agent turn tags its checkpoints with the turn number', async () => {
  const server = await startFakeOllama({
    turns: [
      { toolCalls: [{ name: 'write_file', args: { path: 'one.txt', content: 'a' } }] },
      { toolCalls: [{ name: 'write_file', args: { path: 'two.txt', content: 'b' } }] },
      { text: 'Made both.' },
    ],
  });
  try {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-turn-'));
    const config = { ...DEFAULTS, baseUrl: server.baseUrl, model: 'fake-coder:7b', permissionMode: 'yolo' };
    const workspace = new Workspace(root);
    const agent = new Agent({
      config, provider: createProvider(config), workspace,
      registry: buildRegistry(),
      permissions: new Permissions({ mode: 'yolo', config }),
      ui: new UI({ color: false, stream: captureStream() }),
      session: new Session({ root: workspace.root }),
      toolMode: 'native', rebuildSystem: () => 'system',
    });
    agent.setSystemPrompt('system');

    await agent.run('make two files');
    const entries = agent.checkpoints.list();
    assert.equal(entries.length, 2);
    assert.ok(entries.every((e) => e.turn === 1), 'both belong to turn 1');

    agent.checkpoints.undo('turn');
    assert.equal(fs.existsSync(path.join(workspace.root, 'one.txt')), false);
    assert.equal(fs.existsSync(path.join(workspace.root, 'two.txt')), false);
  } finally {
    await server.close();
  }
});
