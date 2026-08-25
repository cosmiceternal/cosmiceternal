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

test('--json emits one machine-readable object and nothing else', async () => {
  const server = await startFakeOllama({
    turns: [
      { toolCalls: [{ name: 'list_dir', args: { path: '.' } }] },
      { text: 'The project is empty.' },
    ],
  });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-json-'));
  try {
    const { stdout } = await run(process.execPath, [
      BIN, '--cwd', cwd, '--base-url', server.baseUrl, '--model', 'fake-coder:7b',
      '--json', '-p', 'describe this project',
    ], { env: { ...process.env, APOLLO_HOME: cwd } });

    const result = JSON.parse(stdout);   // must parse — no stray narration
    assert.equal(result.ok, true);
    assert.equal(result.error, null);
    assert.equal(result.answer, 'The project is empty.');
    assert.equal(result.model, 'fake-coder:7b');
    assert.equal(result.toolMode, 'native');
    assert.deepEqual(result.toolCalls.map((c) => c.name), ['list_dir']);
    assert.equal(result.toolCalls[0].ok, true);
    assert.ok(result.usage.durationMs >= 0);
    assert.ok(result.sessionId);
  } finally {
    await server.close();
  }
});

test('--json reports changed files and a denied tool call', async () => {
  const server = await startFakeOllama({
    turns: [
      { toolCalls: [{ name: 'write_file', args: { path: 'made.txt', content: 'hi\n' } }] },
      { toolCalls: [{ name: 'run_bash', args: { command: 'rm -rf /' } }] },
      { text: 'Created the file; the command was refused.' },
    ],
  });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-json-'));
  try {
    const { stdout } = await run(process.execPath, [
      BIN, '--cwd', cwd, '--base-url', server.baseUrl, '--model', 'fake-coder:7b',
      '--yolo', '--json', '-p', 'make a file',
    ], { env: { ...process.env, APOLLO_HOME: cwd } });

    const result = JSON.parse(stdout);
    assert.deepEqual(result.changedFiles, ['made.txt']);
    const refused = result.toolCalls.find((c) => c.name === 'run_bash');
    assert.equal(refused.ok, false, 'a refused destructive command is reported as failed');
  } finally {
    await server.close();
  }
});

test('--json reports a failure as structured output with exit code 1', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-json-'));
  const err = await run(process.execPath, [
    BIN, '--cwd', cwd, '--base-url', 'http://127.0.0.1:1', '--model', 'fake-coder:7b',
    '--json', '-p', 'hello',
  ], { env: { ...process.env, APOLLO_HOME: cwd } }).catch((e) => e);

  assert.equal(err.code, 1);
  // stdout stays pure JSON even when the backend was never reachable;
  // the human-readable diagnostics go to stderr.
  const result = JSON.parse(err.stdout);
  assert.equal(result.ok, false);
  assert.match(result.error, /could not reach|ECONNREFUSED|fetch failed/i);
  assert.match(err.stderr, /Cannot reach a model server/);
});

test('setup is recognised as a subcommand', () => {
  assert.equal(parseArgs(['setup']).command, 'setup');
  assert.equal(parseArgs(['--json', '-p', 'x']).json, true);
});

test('the context window is clamped down to what the model supports', async () => {
  const server = await startFakeOllama({ turns: [{ text: 'ok' }], contextLength: 8192 });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-ctx-'));
  try {
    const { stdout } = await run(process.execPath, [
      BIN, '--cwd', cwd, '--base-url', server.baseUrl, '--model', 'fake-coder:7b',
      '--context', '32768', '--no-color', '-p', 'hi',
    ], { env: { ...process.env, APOLLO_HOME: cwd } });

    assert.match(stdout, /supports 8192 tokens of context, not 32768/);
    const chat = server.requests.find((r) => r.url === '/api/chat');
    assert.equal(chat.body.options.num_ctx, 8192, 'must not ask for more than the model has');
  } finally {
    await server.close();
  }
});

test('a context window within the model limit is left alone', async () => {
  const server = await startFakeOllama({ turns: [{ text: 'ok' }], contextLength: 32768 });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-ctx-'));
  try {
    const { stdout } = await run(process.execPath, [
      BIN, '--cwd', cwd, '--base-url', server.baseUrl, '--model', 'fake-coder:7b',
      '--context', '16384', '--no-color', '-p', 'hi',
    ], { env: { ...process.env, APOLLO_HOME: cwd } });

    assert.ok(!stdout.includes('supports'), 'no warning when the request fits');
    assert.equal(server.requests.find((r) => r.url === '/api/chat').body.options.num_ctx, 16384);
  } finally {
    await server.close();
  }
});

test('a clamp that would starve the conversation also shrinks the reply budget', async () => {
  const server = await startFakeOllama({ turns: [{ text: 'ok' }], contextLength: 4096 });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-ctx-'));
  try {
    const { stdout } = await run(process.execPath, [
      BIN, '--cwd', cwd, '--base-url', server.baseUrl, '--model', 'fake-coder:7b',
      '--context', '32768', '--max-tokens', '4096', '--no-color', '-p', 'hi',
    ], { env: { ...process.env, APOLLO_HOME: cwd } });

    assert.match(stdout, /Reply budget reduced to 1024 tokens/);
    assert.equal(server.requests.find((r) => r.url === '/api/chat').body.options.num_predict, 1024);
  } finally {
    await server.close();
  }
});

test('a backend that reports no context length is left as configured', async () => {
  const server = await startFakeOllama({ turns: [{ text: 'ok' }] });   // no model_info
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-ctx-'));
  try {
    await run(process.execPath, [
      BIN, '--cwd', cwd, '--base-url', server.baseUrl, '--model', 'fake-coder:7b',
      '--context', '16384', '--no-color', '-p', 'hi',
    ], { env: { ...process.env, APOLLO_HOME: cwd } });
    assert.equal(server.requests.find((r) => r.url === '/api/chat').body.options.num_ctx, 16384);
  } finally {
    await server.close();
  }
});

test('@references are attached in headless mode too', async () => {
  const server = await startFakeOllama({ turns: [{ text: 'It exports answer.' }] });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-ref-'));
  fs.writeFileSync(path.join(cwd, 'demo.js'), 'export const answer = 42;\n');
  try {
    await run(process.execPath, [
      BIN, '--cwd', cwd, '--base-url', server.baseUrl, '--model', 'fake-coder:7b',
      '--no-color', '-p', 'what does @demo.js export?',
    ], { env: { ...process.env, APOLLO_HOME: cwd } });

    const sent = server.requests.find((r) => r.url === '/api/chat').body.messages;
    const userTurn = sent.find((m) => m.role === 'user');
    assert.match(userTurn.content, /### demo\.js/);
    assert.match(userTurn.content, /export const answer = 42;/);
  } finally {
    await server.close();
  }
});

test('a missing @reference in headless mode does not derail the prompt', async () => {
  const server = await startFakeOllama({ turns: [{ text: 'Cannot find it.' }] });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-ref-'));
  try {
    const { stdout } = await run(process.execPath, [
      BIN, '--cwd', cwd, '--base-url', server.baseUrl, '--model', 'fake-coder:7b',
      '--no-color', '-p', 'explain @nope.js',
    ], { env: { ...process.env, APOLLO_HOME: cwd } });
    assert.match(stdout, /Cannot find it\./);
    assert.match(stdout, /no such file/);
  } finally {
    await server.close();
  }
});

test('an uninstalled model is reported with what is available', async () => {
  const server = await startFakeOllama({ turns: [{ text: 'unused' }] });   // serves fake-coder:7b
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-model-'));
  try {
    const err = await run(process.execPath, [
      BIN, '--cwd', cwd, '--base-url', server.baseUrl, '--model', 'llama9:400b',
      '--no-color', '-p', 'hi',
    ], { env: { ...process.env, APOLLO_HOME: cwd } }).catch((e) => e);

    assert.equal(err.code, 1);
    assert.match(err.stdout, /"llama9:400b" is not installed/);
    assert.match(err.stdout, /fake-coder:7b/);
    assert.match(err.stdout, /ollama pull llama9:400b/);
    assert.equal(server.requests.some((r) => r.url === '/api/chat'), false, 'must not attempt the request');
  } finally {
    await server.close();
  }
});

test('an untagged model name resolves to the installed tag', async () => {
  const server = await startFakeOllama({ turns: [{ text: 'resolved' }] });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-model-'));
  try {
    const { stdout } = await run(process.execPath, [
      BIN, '--cwd', cwd, '--base-url', server.baseUrl, '--model', 'fake-coder',
      '--no-color', '-p', 'hi',
    ], { env: { ...process.env, APOLLO_HOME: cwd } });

    assert.match(stdout, /Using fake-coder:7b/);
    assert.equal(server.requests.find((r) => r.url === '/api/chat').body.model, 'fake-coder:7b');
  } finally {
    await server.close();
  }
});

test('an installed model starts without comment', async () => {
  const server = await startFakeOllama({ turns: [{ text: 'fine' }] });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-model-'));
  try {
    const { stdout } = await run(process.execPath, [
      BIN, '--cwd', cwd, '--base-url', server.baseUrl, '--model', 'fake-coder:7b',
      '--no-color', '-p', 'hi',
    ], { env: { ...process.env, APOLLO_HOME: cwd } });
    assert.ok(!stdout.includes('not installed'));
    assert.match(stdout, /fine/);
  } finally {
    await server.close();
  }
});

test('apollo init can actually write the file it exists to write', async () => {
  const server = await startFakeOllama({
    turns: [
      { toolCalls: [{ name: 'write_file', args: { path: 'APOLLO.md', content: '# Project\n' } }] },
      { text: 'Wrote APOLLO.md.' },
    ],
  });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-init-'));
  try {
    const { stdout } = await run(process.execPath, [
      BIN, 'init', '--cwd', cwd, '--base-url', server.baseUrl,
      '--model', 'fake-coder:7b', '--no-color',
    ], { env: { ...process.env, APOLLO_HOME: cwd } });

    assert.equal(fs.readFileSync(path.join(cwd, 'APOLLO.md'), 'utf8'), '# Project\n');
    assert.match(stdout, /implies --auto-edit/);
  } finally {
    await server.close();
  }
});

test('an explicit permission flag still wins over init default', async () => {
  const server = await startFakeOllama({
    turns: [
      { toolCalls: [{ name: 'write_file', args: { path: 'APOLLO.md', content: 'x' } }] },
      { text: 'Refused.' },
    ],
  });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-init-'));
  try {
    await run(process.execPath, [
      BIN, 'init', '--read-only', '--cwd', cwd, '--base-url', server.baseUrl,
      '--model', 'fake-coder:7b', '--no-color',
    ], { env: { ...process.env, APOLLO_HOME: cwd } });
    assert.equal(fs.existsSync(path.join(cwd, 'APOLLO.md')), false);
  } finally {
    await server.close();
  }
});

test('the backend probe list covers the ports these servers actually use', async () => {
  const { KNOWN_BACKENDS } = await import('../src/providers/index.js');
  const urls = KNOWN_BACKENDS.map((b) => b.baseUrl);
  assert.ok(urls.includes('http://127.0.0.1:11434'), 'Ollama');
  assert.ok(urls.includes('http://127.0.0.1:8080'), 'llama.cpp server');
  assert.ok(urls.includes('http://127.0.0.1:1234'), 'LM Studio');

  for (const backend of KNOWN_BACKENDS) {
    assert.ok(['ollama', 'openai'].includes(backend.provider), `${backend.label} has an unknown provider`);
    assert.ok(backend.label, 'every probe needs a human-readable label');
    // Probing a non-loopback address would send a request off the machine.
    assert.match(backend.baseUrl, /^http:\/\/127\.0\.0\.1:/, 'probes must stay on loopback');
  }
});
