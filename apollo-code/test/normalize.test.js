import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeArgs } from '../src/tools/normalize.js';
import { buildRegistry } from '../src/tools/index.js';
import { startFakeOllama, captureStream } from './helpers/fake-server.js';

const registry = buildRegistry();
const tool = (name) => registry.get(name);

test('a common wrong name is renamed to the declared parameter', () => {
  const { args, renamed } = normalizeArgs(tool('read_file'), { file_path: 'src/a.js' });
  assert.deepEqual(args, { path: 'src/a.js' });
  assert.deepEqual(renamed, [['file_path', 'path']]);
});

test('camelCase and other separators are matched to the real name', () => {
  assert.deepEqual(normalizeArgs(tool('edit_file'), {
    filePath: 'a.js', 'old-string': 'x', OldNew: 1, new_string: 'y',
  }).args.path, 'a.js');
  assert.deepEqual(normalizeArgs(tool('edit_file'), { path: 'a.js', oldString: 'x', newString: 'y' }).args, {
    path: 'a.js', old_string: 'x', new_string: 'y',
  });
});

test('a correct call is left exactly as it is', () => {
  const original = { path: 'a.js', offset: 5, limit: 10 };
  const { args, renamed } = normalizeArgs(tool('read_file'), original);
  assert.deepEqual(args, original);
  assert.deepEqual(renamed, []);
});

test('the declared parameter wins when both are present', () => {
  const { args, renamed } = normalizeArgs(tool('read_file'), { path: 'right.js', file_path: 'wrong.js' });
  assert.equal(args.path, 'right.js');
  assert.equal(args.file_path, 'wrong.js', 'the extra key is left alone, not silently dropped');
  assert.deepEqual(renamed, []);
});

test('aliases cover every tool that takes a path, command or pattern', () => {
  assert.equal(normalizeArgs(tool('run_bash'), { cmd: 'npm test' }).args.command, 'npm test');
  assert.equal(normalizeArgs(tool('grep'), { query: 'TODO' }).args.pattern, 'TODO');
  assert.equal(normalizeArgs(tool('glob'), { glob_pattern: '**/*.js' }).args.pattern, '**/*.js');
  assert.equal(normalizeArgs(tool('write_file'), { path: 'a.js', contents: 'x' }).args.content, 'x');
  assert.equal(normalizeArgs(tool('task'), { title: 'find it', question: 'where?' }).args.prompt, 'where?');
  assert.equal(normalizeArgs(tool('todo_write'), { tasks: [] }).args.todos.length, 0);
  assert.equal(normalizeArgs(tool('multi_edit'), { path: 'a.js', changes: [] }).args.edits.length, 0);
});

test('unrecognised arguments are passed through untouched', () => {
  const { args } = normalizeArgs(tool('read_file'), { path: 'a.js', nonsense: true });
  assert.equal(args.nonsense, true);
});

test('non-object arguments do not throw', () => {
  assert.deepEqual(normalizeArgs(tool('read_file'), null).args, {});
  assert.deepEqual(normalizeArgs(tool('read_file'), 'a string').args, 'a string');
  assert.deepEqual(normalizeArgs(tool('read_file'), []).args, []);
});

test('a model using the wrong parameter names still gets its work done', async () => {
  const server = await startFakeOllama({
    turns: [
      { toolCalls: [{ name: 'read_file', args: { file_path: 'index.js' } }] },
      { toolCalls: [{ name: 'edit_file', args: { filePath: 'index.js', old: '1.0.0', new: '2.0.0' } }] },
      { text: 'Bumped it.' },
    ],
  });
  try {
    const { Agent } = await import('../src/agent.js');
    const { Workspace } = await import('../src/workspace.js');
    const { UI } = await import('../src/ui.js');
    const { Session } = await import('../src/session.js');
    const { Permissions } = await import('../src/permissions.js');
    const { createProvider } = await import('../src/providers/index.js');
    const { DEFAULTS } = await import('../src/config.js');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-norm-'));
    fs.writeFileSync(path.join(root, 'index.js'), 'const version = "1.0.0";\n');

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

    await agent.run('bump the version');

    assert.match(fs.readFileSync(path.join(workspace.root, 'index.js'), 'utf8'), /2\.0\.0/,
      'the edit should land despite every parameter being misnamed');
    assert.match(stream.text, /read file_path as path/);
    assert.equal(agent.session.messages.some((m) => m.role === 'tool' && m.content.startsWith('Error')), false,
      'no turn should have been wasted on a naming error');
  } finally {
    await server.close();
  }
});
