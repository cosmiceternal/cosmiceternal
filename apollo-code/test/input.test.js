import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandReferences, createCompleter, History, classify } from '../src/input.js';
import { Workspace } from '../src/workspace.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-input-'));
  fs.mkdirSync(path.join(root, 'src/deep'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/auth.js'), 'export function login() {}\n');
  fs.writeFileSync(path.join(root, 'src/session.js'), 'export const TTL = 3600;\n');
  fs.writeFileSync(path.join(root, 'src/deep/nested.js'), 'export const deep = true;\n');
  fs.writeFileSync(path.join(root, 'README.md'), '# Fixture\n');
  return new Workspace(root);
}

test('an @reference attaches the file contents to the prompt', () => {
  const ws = fixture();
  const { text, attached, errors } = expandReferences('why does @src/auth.js fail?', ws);
  assert.deepEqual(errors, []);
  assert.equal(attached.length, 1);
  assert.equal(attached[0].path, 'src/auth.js');
  assert.match(text, /why does @src\/auth\.js fail\?/, 'the original question is preserved');
  assert.match(text, /### src\/auth\.js/);
  assert.match(text, /export function login\(\)/);
});

test('several references are all attached, once each', () => {
  const ws = fixture();
  const { attached } = expandReferences('compare @src/auth.js with @src/session.js and @src/auth.js', ws);
  assert.deepEqual(attached.map((a) => a.path), ['src/auth.js', 'src/session.js']);
});

test('a directory reference attaches a listing', () => {
  const ws = fixture();
  const { attached, text } = expandReferences('what is in @src?', ws);
  assert.equal(attached[0].kind, 'dir');
  assert.match(text, /auth\.js/);
  assert.match(text, /deep\//);
});

test('trailing punctuation is not treated as part of the path', () => {
  const ws = fixture();
  for (const line of [
    'look at @src/auth.js, then stop.',
    'is @src/auth.js broken?',
    'check @src/auth.js!',
    'see (@src/auth.js)',
  ]) {
    const { attached, errors } = expandReferences(line, ws);
    assert.deepEqual(errors, [], line);
    assert.equal(attached[0]?.path, 'src/auth.js', line);
  }
});

test('a missing reference is reported without derailing the prompt', () => {
  const ws = fixture();
  const { text, attached, errors } = expandReferences('check @src/nope.js please', ws);
  assert.equal(attached.length, 0);
  assert.match(errors[0], /no such file/);
  assert.equal(text, 'check @src/nope.js please');
});

test('a reference cannot escape the workspace', () => {
  const ws = fixture();
  const { attached, errors } = expandReferences('read @../../etc/passwd', ws);
  assert.equal(attached.length, 0);
  assert.match(errors[0], /escapes the workspace/);
});

test('an email address is not mistaken for a reference', () => {
  const ws = fixture();
  const { text, attached } = expandReferences('mail me at someone@example.com', ws);
  assert.equal(attached.length, 0);
  assert.equal(text, 'mail me at someone@example.com');
});

test('input with no references is returned untouched', () => {
  const ws = fixture();
  const input = 'just a normal question';
  assert.equal(expandReferences(input, ws).text, input);
});

test('slash commands complete by prefix', () => {
  const complete = createCompleter(fixture(), ['help', 'model', 'models', 'mode', 'exit']);
  const [hits] = complete('/mod');
  assert.deepEqual(hits.sort(), ['/mode', '/model', '/models']);
  assert.deepEqual(complete('/exi')[0], ['/exit']);
});

test('an unknown command prefix offers the full list', () => {
  const complete = createCompleter(fixture(), ['help', 'exit']);
  assert.deepEqual(complete('/zzz')[0], ['/help', '/exit']);
});

test('@ references complete against the filesystem', () => {
  const ws = fixture();
  const complete = createCompleter(ws, []);
  assert.deepEqual(complete('look at @src/')[0].sort(), [
    'look at @src/auth.js', 'look at @src/deep/', 'look at @src/session.js',
  ]);
  assert.deepEqual(complete('@src/au')[0], ['@src/auth.js']);
  assert.deepEqual(complete('@RE')[0], ['@README.md']);
});

test('completion hides ignored directories', () => {
  const complete = createCompleter(fixture(), []);
  assert.ok(!complete('@')[0].some((h) => h.includes('node_modules')));
});

test('ordinary words are not completed against the filesystem', () => {
  const complete = createCompleter(fixture(), ['help']);
  assert.deepEqual(complete('fix the login bug')[0], []);
});

test('classify separates commands, shell escapes and continuations', () => {
  assert.deepEqual(classify('/help'), { kind: 'command', body: '/help' });
  assert.deepEqual(classify('!npm test'), { kind: 'shell', body: 'npm test' });
  assert.deepEqual(classify('a line \\'), { kind: 'continued', body: 'a line ' });
  assert.deepEqual(classify('fix the bug'), { kind: 'prompt', body: 'fix the bug' });
});

test('history round-trips newest first and survives truncation', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-hist-')), 'history');
  const history = new History({ file, limit: 3 });
  assert.deepEqual(history.load(), []);
  for (const line of ['one', 'two', 'three', 'four']) history.append(line);
  assert.deepEqual(history.load(), ['four', 'three', 'two']);
});

test('history ignores blank input and flattens newlines', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-hist-')), 'history');
  const history = new History({ file });
  history.append('   ');
  history.append('multi\nline');
  assert.deepEqual(history.load(), ['multi line']);
});

test('an unwritable history location disables itself instead of throwing', () => {
  // Parent is a regular file, so mkdir fails with ENOTDIR — fast and portable.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-hist-'));
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'not a directory');
  const history = new History({ file: path.join(blocker, 'history') });

  assert.doesNotThrow(() => history.append('x'));
  assert.equal(history.enabled, false, 'further appends should be skipped');
  assert.deepEqual(history.load(), []);
});
