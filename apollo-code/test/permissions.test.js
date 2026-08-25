import test from 'node:test';
import assert from 'node:assert/strict';
import { Permissions } from '../src/permissions.js';
import { DEFAULTS } from '../src/config.js';

const readTool = { name: 'read_file', readOnly: true };
const editTool = { name: 'edit_file', readOnly: false };
const bashTool = { name: 'run_bash', readOnly: false };

const perms = (mode, extra = {}) =>
  new Permissions({ mode, config: { ...DEFAULTS, ...extra }, prompt: extra.prompt });

test('read-only tools never need approval', async () => {
  for (const mode of ['ask', 'auto-edit', 'yolo', 'read-only']) {
    assert.equal((await perms(mode).check(readTool, {})).allow, true, mode);
  }
});

test('read-only mode refuses every mutating tool', async () => {
  const p = perms('read-only');
  assert.equal((await p.check(editTool, {})).allow, false);
  const decision = await p.check(bashTool, {});
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /read-only mode/);
});

test('yolo approves everything without prompting', async () => {
  let prompted = false;
  const p = perms('yolo', { prompt: async () => { prompted = true; return 'yes'; } });
  assert.equal((await p.check(bashTool, { command: 'rm -rf ./dist' })).allow, true);
  assert.equal(prompted, false);
});

test('auto-edit applies edits silently but still asks before a command', async () => {
  const asked = [];
  const p = perms('auto-edit', { prompt: async (_preview, tool) => { asked.push(tool.name); return 'yes'; } });
  assert.equal((await p.check(editTool, {})).allow, true);
  assert.deepEqual(asked, []);
  assert.equal((await p.check(bashTool, { command: 'npm test' })).allow, true);
  assert.deepEqual(asked, ['run_bash']);
});

test('ask mode relays a decline, with the user feedback attached', async () => {
  const p = perms('ask', { prompt: async () => 'no:use a helper instead' });
  const decision = await p.check(editTool, {});
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /use a helper instead/);
});

test('"always" remembers the tool for the rest of the session', async () => {
  let prompts = 0;
  const p = perms('ask', { prompt: async () => { prompts++; return 'always'; } });
  assert.equal((await p.check(editTool, {})).allow, true);
  assert.equal((await p.check(editTool, {})).allow, true);
  assert.equal(prompts, 1);
});

test('allowedCommands auto-approve matching shell commands only', async () => {
  let prompts = 0;
  const p = perms('ask', {
    allowedCommands: ['^npm (test|run lint)$', '^git (status|diff)'],
    prompt: async () => { prompts++; return 'no'; },
  });
  assert.equal((await p.check(bashTool, { command: 'npm test' })).allow, true);
  assert.equal((await p.check(bashTool, { command: 'git status' })).allow, true);
  assert.equal(prompts, 0);
  assert.equal((await p.check(bashTool, { command: 'npm publish' })).allow, false);
  assert.equal(prompts, 1);
});

test('without a terminal, approval fails closed with a usable hint', async () => {
  const decision = await perms('ask').check(editTool, {});
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /--auto-edit|--yolo/);
});

test('setMode changes enforcement immediately', async () => {
  const p = perms('read-only');
  assert.equal((await p.check(editTool, {})).allow, false);
  p.setMode('yolo');
  assert.equal((await p.check(editTool, {})).allow, true);
});
