import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IgnoreMatcher, loadIgnoreMatcher } from '../src/ignore.js';
import { Workspace } from '../src/workspace.js';
import { buildRegistry } from '../src/tools/index.js';
import { DEFAULTS } from '../src/config.js';

const match = (patterns) => new IgnoreMatcher(patterns);

test('a bare name is ignored at any depth', () => {
  const m = match(['secrets.txt']);
  assert.equal(m.ignores('secrets.txt'), true);
  assert.equal(m.ignores('deep/nested/secrets.txt'), true);
  assert.equal(m.ignores('secrets.txt.bak'), false);
});

test('a leading slash anchors to the root', () => {
  const m = match(['/build']);
  assert.equal(m.ignores('build', true), true);
  assert.equal(m.ignores('build/out.js'), true);
  assert.equal(m.ignores('src/build/out.js'), false);
});

test('a trailing slash matches directories only', () => {
  const m = match(['cache/']);
  assert.equal(m.ignores('cache', true), true);
  assert.equal(m.ignores('cache', false), false, 'a file named cache is not ignored');
  assert.equal(m.ignores('cache/data.bin'), true, 'contents of an ignored directory are ignored');
});

test('glob patterns work', () => {
  const m = match(['*.min.js', '**/*.log', 'tmp?']);
  assert.equal(m.ignores('vendor/jquery.min.js'), true);
  assert.equal(m.ignores('logs/app.log'), true);
  assert.equal(m.ignores('tmp1', true), true);
  assert.equal(m.ignores('app.js'), false);
});

test('negation re-includes a file, and order decides', () => {
  const m = match(['*.log', '!important.log']);
  assert.equal(m.ignores('debug.log'), true);
  assert.equal(m.ignores('important.log'), false);

  const reversed = match(['!important.log', '*.log']);
  assert.equal(reversed.ignores('important.log'), true, 'a later rule wins');
});

test('comments, blanks and trailing whitespace are handled', () => {
  const m = match(['# a comment', '', '   ', 'dist   ', '\\#literal-hash']);
  assert.equal(m.size, 2);
  assert.equal(m.ignores('dist', true), true);
  assert.equal(m.ignores('#literal-hash'), true);
});

test('a path with an internal slash is anchored', () => {
  const m = match(['src/generated']);
  assert.equal(m.ignores('src/generated', true), true);
  assert.equal(m.ignores('src/generated/api.ts'), true);
  assert.equal(m.ignores('lib/src/generated/api.ts'), false);
});

test('**/ matches at any depth', () => {
  const m = match(['**/node_modules']);
  assert.equal(m.ignores('node_modules', true), true);
  assert.equal(m.ignores('packages/a/node_modules', true), true);
});

test('an empty or malformed file yields a matcher that ignores nothing', () => {
  assert.equal(match([]).ignores('anything'), false);
  assert.equal(match(['[unclosed']).ignores('anything'), false);
});

test('loadIgnoreMatcher reads .gitignore and .git/info/exclude', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-ign-'));
  fs.writeFileSync(path.join(root, '.gitignore'), 'dist/\n*.tmp\n');
  fs.mkdirSync(path.join(root, '.git/info'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git/info/exclude'), 'scratch.md\n');

  const m = loadIgnoreMatcher(root);
  assert.equal(m.ignores('dist', true), true);
  assert.equal(m.ignores('a.tmp'), true);
  assert.equal(m.ignores('scratch.md'), true);
  assert.equal(m.ignores('src/index.js'), false);
});

test('a project with no .gitignore still works', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-ign-'));
  assert.equal(loadIgnoreMatcher(root).ignores('anything'), false);
});

test('glob and grep honour the project .gitignore', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-ign-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'generated'), { recursive: true });
  fs.writeFileSync(path.join(root, '.gitignore'), 'generated/\n*.min.js\n');
  fs.writeFileSync(path.join(root, 'src/app.js'), 'const NEEDLE = 1;\n');
  fs.writeFileSync(path.join(root, 'src/vendor.min.js'), 'const NEEDLE = 2;\n');
  fs.writeFileSync(path.join(root, 'generated/api.js'), 'const NEEDLE = 3;\n');

  const ctx = { workspace: new Workspace(root), config: { ...DEFAULTS }, state: {} };
  const registry = buildRegistry();

  const globbed = await registry.get('glob').run({ pattern: '**/*.js' }, ctx);
  assert.match(globbed, /src\/app\.js/);
  assert.ok(!globbed.includes('generated'), 'ignored directory must not appear');
  assert.ok(!globbed.includes('min.js'), 'ignored file must not appear');

  const grepped = await registry.get('grep').run({ pattern: 'NEEDLE' }, ctx);
  assert.match(grepped, /src\/app\.js:1:/);
  assert.equal((grepped.match(/NEEDLE/g) || []).length, 1, 'only the tracked file should match');
});
