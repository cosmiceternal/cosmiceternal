import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/workspace.js';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-ws-'));
}

test('resolves paths inside the root', () => {
  const root = tmpRoot();
  const ws = new Workspace(root);
  assert.equal(ws.resolve('a/b.js'), path.join(ws.root, 'a/b.js'));
  assert.equal(ws.resolve('./a/../b.js'), path.join(ws.root, 'b.js'));
});

test('rejects traversal out of the root', () => {
  const ws = new Workspace(tmpRoot());
  for (const bad of ['../secrets', '../../etc/passwd', 'a/../../b', '/etc/passwd']) {
    assert.throws(() => ws.resolve(bad), /escapes the workspace root/, `should reject ${bad}`);
  }
});

test('rejects empty, non-string and null-byte paths', () => {
  const ws = new Workspace(tmpRoot());
  assert.throws(() => ws.resolve(''), /non-empty string/);
  assert.throws(() => ws.resolve(null), /non-empty string/);
  assert.throws(() => ws.resolve('a\0b'), /null byte/);
});

test('rejects a symlink pointing outside the root', () => {
  const root = tmpRoot();
  const outside = tmpRoot();
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));

  const ws = new Workspace(root);
  assert.throws(() => ws.resolve('link.txt'), /escapes the workspace root/);
});

test('allows a path that does not exist yet', () => {
  const ws = new Workspace(tmpRoot());
  assert.equal(ws.resolve('new/deep/file.js'), path.join(ws.root, 'new/deep/file.js'));
});

test('rejects a new path under a symlinked-out directory', () => {
  const root = tmpRoot();
  const outside = tmpRoot();
  fs.symlinkSync(outside, path.join(root, 'escape'));
  const ws = new Workspace(root);
  assert.throws(() => ws.resolve('escape/new-file.js'), /escapes the workspace root/);
});

test('relative() renders paths for display', () => {
  const ws = new Workspace(tmpRoot());
  assert.equal(ws.relative(path.join(ws.root, 'src/a.js')), 'src/a.js');
  assert.equal(ws.relative(ws.root), '.');
});
