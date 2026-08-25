import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSelftest, SCENARIO_IDS } from '../src/selftest.js';
import { createProvider } from '../src/providers/index.js';
import { UI } from '../src/ui.js';
import { DEFAULTS } from '../src/config.js';
import { startFakeOllama, captureStream } from './helpers/fake-server.js';

/** Turns for a model that handles every scenario correctly. */
const COMPETENT = [
  { toolCalls: [{ name: 'read_file', args: { path: 'src/index.js' } }] },
  { text: '3' },
  { toolCalls: [{ name: 'grep', args: { pattern: 'function format' } }] },
  { text: 'src/format.js' },
  { toolCalls: [{ name: 'read_file', args: { path: 'src/index.js' } }] },
  { toolCalls: [{ name: 'edit_file', args: { path: 'src/index.js', old_string: 'MAX_RETRIES = 3', new_string: 'MAX_RETRIES = 5' } }] },
  { text: 'Done.' },
  { toolCalls: [{ name: 'write_file', args: { path: 'src/math.js', content: 'export function double(n) {\n  return n * 2;\n}\n' } }] },
  { text: 'Created.' },
  { toolCalls: [{ name: 'run_bash', args: { command: 'node -e "console.log(6*7)"' } }] },
  { text: '42' },
  { toolCalls: [{ name: 'read_file', args: { path: 'package.json' } }] },
  { toolCalls: [{ name: 'edit_file', args: { path: 'package.json', old_string: '1.4.2', new_string: '1.5.0' } }] },
  { toolCalls: [{ name: 'read_file', args: { path: 'README.md' } }] },
  { toolCalls: [{ name: 'edit_file', args: { path: 'README.md', old_string: 'A small library.', new_string: 'A small library.\n\nVersion 1.5.0' } }] },
  { text: 'Both done.' },
];

async function selftest(turns, options = {}) {
  const server = await startFakeOllama({ turns });
  const stream = captureStream();
  const ui = new UI({ color: false, stream });
  const config = { ...DEFAULTS, baseUrl: server.baseUrl, model: 'fake-coder:7b' };
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-st-home-'));
  try {
    const outcome = await runSelftest({
      config, provider: createProvider(config), toolMode: 'native', userDir, ui, ...options,
    });
    return { ...outcome, output: stream.text };
  } finally {
    await server.close();
  }
}

test('a model that does everything right passes every scenario', async () => {
  const { code, results, output } = await selftest(COMPETENT);
  assert.equal(code, 0);
  assert.equal(results.length, SCENARIO_IDS.length);
  assert.equal(results.every((r) => r.ok), true, JSON.stringify(results.filter((r) => !r.ok), null, 2));
  assert.match(output, /6\/6 passed/);
  assert.match(output, /drives Apollo well/);
});

test('scenarios are checked against the filesystem, not the model\'s claim', async () => {
  // The model says it made the edit, and does nothing.
  const turns = [
    { toolCalls: [{ name: 'read_file', args: { path: 'src/index.js' } }] },
    { text: '3' },
    { text: 'src/format.js' },
    { text: 'I have changed MAX_RETRIES to 5.' },        // a lie
    { text: 'I created src/math.js.' },                   // also a lie
    { text: '42' },                                       // answered without running it
    { text: 'Both files updated.' },                      // a lie
  ];
  const { results } = await selftest(turns);
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));

  assert.equal(byId.edit.ok, false);
  assert.match(byId.edit.why, /MAX_RETRIES was not set to 5/);
  assert.equal(byId.create.ok, false);
  assert.equal(byId.bash.ok, false, 'claiming an answer without run_bash must not pass');
  assert.match(byId.bash.why, /did not use run_bash/);
  assert.equal(byId.multistep.ok, false);
});

test('an edit that damages the rest of the file fails', async () => {
  const turns = [
    { toolCalls: [{ name: 'read_file', args: { path: 'src/index.js' } }] },
    { text: '3' },
    { text: 'src/format.js' },
    // Reads the file, then replaces it with only the changed line.
    { toolCalls: [{ name: 'read_file', args: { path: 'src/index.js' } }] },
    { toolCalls: [{ name: 'write_file', args: { path: 'src/index.js', content: 'export const MAX_RETRIES = 5;\n' } }] },
    { text: 'Replaced the file.' },
  ];
  const { results } = await selftest(turns);
  const edit = results.find((r) => r.id === 'edit');
  assert.equal(edit.ok, false);
  assert.match(edit.why, /rest of the file was damaged/);
});

test('the read-before-write guard applies during the self-test too', async () => {
  const turns = [
    { toolCalls: [{ name: 'read_file', args: { path: 'src/index.js' } }] },
    { text: '3' },
    { text: 'src/format.js' },
    // Straight to an overwrite, having never read the file in this scenario.
    { toolCalls: [{ name: 'write_file', args: { path: 'src/index.js', content: 'wiped' } }] },
    { text: 'Replaced it.' },
  ];
  const { results } = await selftest(turns);
  const edit = results.find((r) => r.id === 'edit');
  assert.equal(edit.ok, false);
  assert.match(edit.why, /MAX_RETRIES was not set to 5/, 'the blind overwrite was refused, so nothing changed');
});

test('multistep fails if the manifest is left as invalid JSON', async () => {
  const turns = [
    { text: '3' }, { text: 'src/format.js' }, { text: 'x' }, { text: 'x' }, { text: 'x' },
    { toolCalls: [{ name: 'read_file', args: { path: 'package.json' } }] },
    { toolCalls: [{ name: 'write_file', args: { path: 'package.json', content: '{ "version": 1.5.0 }}' } }] },
    { toolCalls: [{ name: 'read_file', args: { path: 'README.md' } }] },
    { toolCalls: [{ name: 'write_file', args: { path: 'README.md', content: 'Version 1.5.0\n' } }] },
    { text: 'Done.' },
  ];
  const { results } = await selftest(turns);
  const multistep = results.find((r) => r.id === 'multistep');
  assert.equal(multistep.ok, false);
  assert.match(multistep.why, /no longer valid JSON/);
});

test('--only runs a single scenario', async () => {
  const turns = [
    { toolCalls: [{ name: 'read_file', args: { path: 'src/index.js' } }] },
    { text: '3' },
  ];
  const { results, code } = await selftest(turns, { only: 'read' });
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'read');
  assert.equal(code, 0);
});

test('an unknown scenario name is rejected with the list', async () => {
  const { code, output } = await selftest([], { only: 'nonsense' });
  assert.equal(code, 2);
  assert.match(output, /No such scenario "nonsense"/);
  for (const id of SCENARIO_IDS) assert.ok(output.includes(id));
});

test('a model that fails most scenarios gets a blunt verdict', async () => {
  const { code, output } = await selftest(Array.from({ length: 20 }, () => ({ text: 'I am not sure.' })));
  assert.equal(code, 1);
  assert.match(output, /struggles to drive an agent/);
});

test('each scenario starts from a clean workspace', async () => {
  // The edit scenario changes src/index.js; the read scenario runs first and
  // must still see the original value even though they share a fixture shape.
  const { results } = await selftest(COMPETENT);
  assert.equal(results.find((r) => r.id === 'read').ok, true);
  assert.equal(results.find((r) => r.id === 'edit').ok, true);
});

test('a provider failure is reported as a scenario failure, not a crash', async () => {
  const stream = captureStream();
  const config = { ...DEFAULTS, baseUrl: 'http://127.0.0.1:1', model: 'fake-coder:7b' };
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-st-home-'));

  const { code, results } = await runSelftest({
    config, provider: createProvider(config), toolMode: 'native', userDir,
    ui: new UI({ color: false, stream }), only: 'read',
  });

  assert.equal(code, 1);
  assert.equal(results[0].ok, false);
  assert.match(results[0].why, /the request failed/);
});
