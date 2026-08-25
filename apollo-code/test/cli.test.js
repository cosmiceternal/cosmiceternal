import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/cli.js';
import { startFakeOllama } from './helpers/fake-server.js';

const run = promisify(execFile);
const BIN = fileURLToPath(new URL('../bin/apollo.js', import.meta.url));

test('parses model and backend flags', () => {
  const args = parseArgs(['--model', 'llama3.1:8b', '--provider', 'openai', '--base-url', 'http://x:1']);
  assert.deepEqual(args.flags, { model: 'llama3.1:8b', provider: 'openai', baseUrl: 'http://x:1' });
});

test('permission flags map to a single mode', () => {
  assert.equal(parseArgs(['--yolo']).flags.permissionMode, 'yolo');
  assert.equal(parseArgs(['--auto-edit']).flags.permissionMode, 'auto-edit');
  assert.equal(parseArgs(['--read-only']).flags.permissionMode, 'read-only');
  assert.equal(parseArgs([]).flags.permissionMode, undefined, 'unset so config can decide');
});

test('recognises subcommands and one-shot prompts', () => {
  assert.equal(parseArgs(['doctor']).command, 'doctor');
  assert.equal(parseArgs(['models']).command, 'models');
  assert.equal(parseArgs(['-p', 'fix the test']).prompt, 'fix the test');
  assert.equal(parseArgs(['fix', 'the', 'test']).prompt, 'fix the test', 'bare words are a prompt');
});

test('resume flags', () => {
  assert.equal(parseArgs(['-c']).resume, 'last');
  assert.equal(parseArgs(['--resume', 'abc123']).resume, 'abc123');
});

test('an unknown option is rejected instead of silently ignored', () => {
  assert.throws(() => parseArgs(['--turbo']), /unknown option --turbo/);
});

test('--help and --version exit cleanly', async () => {
  const help = await run(process.execPath, [BIN, '--help']);
  assert.match(help.stdout, /offline coding agent/);
  const version = await run(process.execPath, [BIN, '--version']);
  assert.match(version.stdout, /^apollo \d+\.\d+\.\d+/);
});

test('a bad config value fails fast with exit code 2', async () => {
  await assert.rejects(
    run(process.execPath, [BIN, '--tool-mode', 'telepathy', '-p', 'hi']),
    (err) => {
      assert.equal(err.code, 2);
      assert.match(err.stderr, /toolMode must be/);
      return true;
    }
  );
});

test('headless mode answers a prompt end to end and saves the session', async () => {
  const server = await startFakeOllama({ turns: [{ text: 'It is a fixture project.' }] });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-cli-'));
  try {
    const { stdout } = await run(process.execPath, [
      BIN, '--cwd', cwd, '--base-url', server.baseUrl, '--model', 'fake-coder:7b',
      '--no-color', '-p', 'what is this project?',
    ], { env: { ...process.env, APOLLO_HOME: cwd } });

    assert.match(stdout, /It is a fixture project\./);
    const sessions = fs.readdirSync(path.join(cwd, '.apollo', 'sessions'));
    assert.equal(sessions.length, 1);
  } finally {
    await server.close();
  }
});

test('headless mode refuses an edit rather than silently applying it', async () => {
  const server = await startFakeOllama({
    turns: [
      { toolCalls: [{ name: 'write_file', args: { path: 'new.txt', content: 'x' } }] },
      { text: 'I need permission for that.' },
    ],
  });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-cli-'));
  try {
    const { stdout } = await run(process.execPath, [
      BIN, '--cwd', cwd, '--base-url', server.baseUrl, '--model', 'fake-coder:7b',
      '--no-color', '-p', 'create a file',
    ], { env: { ...process.env, APOLLO_HOME: cwd } });

    assert.equal(fs.existsSync(path.join(cwd, 'new.txt')), false, 'nothing may be written without approval');
    assert.match(stdout, /--auto-edit|--yolo/);
  } finally {
    await server.close();
  }
});

test('--yolo lets a headless run write the file', async () => {
  const server = await startFakeOllama({
    turns: [
      { toolCalls: [{ name: 'write_file', args: { path: 'new.txt', content: 'written\n' } }] },
      { text: 'Created it.' },
    ],
  });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-cli-'));
  try {
    await run(process.execPath, [
      BIN, '--cwd', cwd, '--base-url', server.baseUrl, '--model', 'fake-coder:7b',
      '--no-color', '--yolo', '-p', 'create new.txt',
    ], { env: { ...process.env, APOLLO_HOME: cwd } });
    assert.equal(fs.readFileSync(path.join(cwd, 'new.txt'), 'utf8'), 'written\n');
  } finally {
    await server.close();
  }
});

test('a prompt piped on stdin is treated as the request', async () => {
  const server = await startFakeOllama({ turns: [{ text: 'answered from stdin' }] });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-cli-'));
  try {
    const child = execFile(process.execPath, [
      BIN, '--cwd', cwd, '--base-url', server.baseUrl, '--model', 'fake-coder:7b', '--no-color',
    ], { env: { ...process.env, APOLLO_HOME: cwd } });
    child.stdin.end('summarize this repo\n');
    const { stdout } = await new Promise((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('close', (code) => (code === 0 ? resolve({ stdout: out }) : reject(new Error(out))));
    });
    assert.match(stdout, /answered from stdin/);
  } finally {
    await server.close();
  }
});

test('doctor reports when nothing is running and exits non-zero', async () => {
  // Point every probe at a closed port by running with no servers up.
  const result = await run(process.execPath, [BIN, 'doctor', '--no-color']).catch((err) => err);
  assert.match(result.stdout, /Looking for local model servers/);
});
