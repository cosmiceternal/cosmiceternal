import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSystemPrompt, loadMemory, MEMORY_FILES } from '../src/prompt.js';
import { Workspace } from '../src/workspace.js';
import { buildRegistry } from '../src/tools/index.js';
import { DEFAULTS } from '../src/config.js';

function setup(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-prompt-'));
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-prompt-home-'));
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  return { workspace: new Workspace(root), userDir, root };
}

test('the prompt states the environment the model is working in', () => {
  const { workspace, userDir } = setup();
  const prompt = buildSystemPrompt({
    config: { ...DEFAULTS }, workspace, registry: buildRegistry(), toolMode: 'native', userDir,
  });
  assert.match(prompt, /You are Apollo/);
  assert.match(prompt, new RegExp(`Working directory: ${workspace.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(prompt, /Model: /);
  assert.match(prompt, /cannot read or write outside it/);
});

test('native mode omits the text protocol; text mode includes it', () => {
  const { workspace, userDir } = setup();
  const base = { config: { ...DEFAULTS }, workspace, registry: buildRegistry(), userDir };
  assert.ok(!buildSystemPrompt({ ...base, toolMode: 'native' }).includes('<apollo:tool name="TOOL_NAME">'));
  assert.match(buildSystemPrompt({ ...base, toolMode: 'text' }), /<apollo:tool name="TOOL_NAME">/);
});

test('read-only mode tells the model it cannot change anything', () => {
  const { workspace, userDir } = setup();
  const prompt = buildSystemPrompt({
    config: { ...DEFAULTS, permissionMode: 'read-only' },
    workspace, registry: buildRegistry({ readOnly: true }), toolMode: 'native', userDir,
  });
  assert.match(prompt, /read-only mode/);
});

test('APOLLO.md is loaded into the prompt', () => {
  const { workspace, userDir } = setup({ 'APOLLO.md': 'Always run `make check` before finishing.' });
  const prompt = buildSystemPrompt({
    config: { ...DEFAULTS }, workspace, registry: buildRegistry(), toolMode: 'native', userDir,
  });
  assert.match(prompt, /Instructions from the user/);
  assert.match(prompt, /make check/);
});

test('only the first memory file found is used, in priority order', () => {
  const { workspace, userDir } = setup({ 'APOLLO.md': 'apollo wins', 'AGENTS.md': 'agents loses' });
  const memory = loadMemory(workspace.root, userDir);
  assert.match(memory, /apollo wins/);
  assert.ok(!memory.includes('agents loses'));
});

test('CLAUDE.md and AGENTS.md are accepted as fallbacks', () => {
  for (const name of MEMORY_FILES.slice(1)) {
    const { workspace, userDir } = setup({ [name]: `from ${name}` });
    assert.match(loadMemory(workspace.root, userDir), new RegExp(`from ${name.replace('.', '\\.')}`));
  }
});

test('a global APOLLO.md is combined with the project one', () => {
  const { workspace, userDir } = setup({ 'APOLLO.md': 'project rule' });
  fs.writeFileSync(path.join(userDir, 'APOLLO.md'), 'global rule');
  const memory = loadMemory(workspace.root, userDir);
  assert.match(memory, /global rule/);
  assert.match(memory, /project rule/);
});

test('the efficiency guidance appears only when task is available', () => {
  const { workspace, userDir } = setup();
  const base = { config: { ...DEFAULTS }, workspace, toolMode: 'native', userDir };
  assert.match(buildSystemPrompt({ ...base, registry: buildRegistry() }), /Delegate wide searches to task/);
  assert.ok(!buildSystemPrompt({ ...base, registry: buildRegistry({ nested: true }) }).includes('Delegate wide searches'));
});

test('the prompt tells the model to read before editing', () => {
  const { workspace, userDir } = setup();
  const prompt = buildSystemPrompt({
    config: { ...DEFAULTS }, workspace, registry: buildRegistry(), toolMode: 'native', userDir,
  });
  assert.match(prompt, /read_file before you edit/);
});
