import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { tracer } from '../src/trace.js';
import { startFakeOllama } from './helpers/fake-server.js';

const run = promisify(execFile);
const BIN = fileURLToPath(new URL('../bin/apollo.js', import.meta.url));

function readTrace(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

test('tracing is off unless it is asked for', () => {
  assert.equal(tracer.enabled, false);
  assert.doesNotThrow(() => tracer.request('http://x', { a: 1 }));
});

test('an unopenable trace file disables tracing instead of throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-trace-'));
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'not a directory');
  assert.equal(tracer.enable(path.join(blocker, 'sub', 'trace.jsonl')), null);
  assert.equal(tracer.enabled, false);
});

test('--trace records the request, the stream frames and the tool calls', async () => {
  const server = await startFakeOllama({
    turns: [
      { toolCalls: [{ name: 'read_file', args: { file_path: 'a.txt' } }] },
      { text: 'It says hello.' },
    ],
  });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-trace-'));
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'hello\n');
  const traceFile = path.join(cwd, 'trace.jsonl');

  try {
    const { stdout } = await run(process.execPath, [
      BIN, '--cwd', cwd, '--base-url', server.baseUrl, '--model', 'fake-coder:7b',
      '--no-color', '--trace', traceFile, '-p', 'what does a.txt say?',
    ], { env: { ...process.env, APOLLO_HOME: cwd } });

    assert.match(stdout, /Tracing to/);
    const entries = readTrace(traceFile);

    assert.equal(entries[0].kind, 'session');

    const request = entries.find((e) => e.kind === 'request' && e.url.endsWith('/api/chat'));
    assert.ok(request, 'the outgoing request must be recorded');
    assert.equal(request.body.model, 'fake-coder:7b');
    assert.equal(request.body.messages[0].role, 'system', 'the exact prompt the model saw');

    assert.ok(entries.some((e) => e.kind === 'frame'), 'raw stream frames must be recorded');

    const call = entries.find((e) => e.kind === 'event' && e.type === 'tool_call');
    assert.equal(call.name, 'read_file');
    assert.deepEqual(call.args, { path: 'a.txt' });
    assert.deepEqual(call.renamed, [['file_path', 'path']], 'argument renames are visible in the trace');

    // Entries are ordered and individually parseable — it is a JSONL log.
    assert.deepEqual(entries.map((e) => e.n), entries.map((_, i) => i + 1));
  } finally {
    await server.close();
  }
});

test('APOLLO_TRACE enables tracing without a flag', async () => {
  const server = await startFakeOllama({ turns: [{ text: 'ok' }] });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-trace-'));
  const traceFile = path.join(cwd, 'env-trace.jsonl');
  try {
    await run(process.execPath, [
      BIN, '--cwd', cwd, '--base-url', server.baseUrl, '--model', 'fake-coder:7b',
      '--no-color', '-p', 'hi',
    ], { env: { ...process.env, APOLLO_HOME: cwd, APOLLO_TRACE: traceFile } });

    assert.ok(readTrace(traceFile).some((e) => e.kind === 'request'));
  } finally {
    await server.close();
  }
});

test('without tracing no file is written', async () => {
  const server = await startFakeOllama({ turns: [{ text: 'ok' }] });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-trace-'));
  try {
    await run(process.execPath, [
      BIN, '--cwd', cwd, '--base-url', server.baseUrl, '--model', 'fake-coder:7b',
      '--no-color', '-p', 'hi',
    ], { env: { ...process.env, APOLLO_HOME: cwd } });
    assert.deepEqual(fs.readdirSync(cwd).filter((f) => f.endsWith('.jsonl')), []);
  } finally {
    await server.close();
  }
});
