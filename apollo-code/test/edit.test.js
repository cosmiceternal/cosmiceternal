import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEdit, diffLines } from '../src/tools/edit.js';

test('replaces a unique occurrence', () => {
  const { result, occurrences } = applyEdit('const a = 1;\nconst b = 2;\n', 'const a = 1;', 'const a = 42;');
  assert.equal(result, 'const a = 42;\nconst b = 2;\n');
  assert.equal(occurrences, 1);
});

test('refuses an ambiguous match unless replace_all is set', () => {
  const source = 'x = 1;\nx = 1;\n';
  assert.throws(() => applyEdit(source, 'x = 1;', 'x = 2;'), /appears 2 times/);
  const { result, occurrences } = applyEdit(source, 'x = 1;', 'x = 2;', true);
  assert.equal(result, 'x = 2;\nx = 2;\n');
  assert.equal(occurrences, 2);
});

test('reports a miss with actionable guidance', () => {
  assert.throws(() => applyEdit('hello\n', 'goodbye', 'hi'), /was not found/);
});

test('rejects no-op and empty edits', () => {
  assert.throws(() => applyEdit('a', 'a', 'a'), /identical/);
  assert.throws(() => applyEdit('a', '', 'b'), /must not be empty/);
});

test('replacement text containing $& is inserted literally', () => {
  // String.replace treats $& as a backreference — the tool must not.
  const { result } = applyEdit('cost: PLACEHOLDER\n', 'PLACEHOLDER', '$& and $1');
  assert.equal(result, 'cost: $& and $1\n');
});

test('is whitespace-exact', () => {
  // Tabs are not spaces: a model that reindents its quote gets a clear miss.
  assert.throws(() => applyEdit('  indented();\n', '\tindented();', 'x();'), /not found/);
  assert.throws(() => applyEdit('a = 1;\n', 'a  = 1;', 'a = 2;'), /not found/);
});

test('diffLines shows only the changed region with context', () => {
  const before = 'a\nb\nc\nd\ne\n';
  const after = 'a\nb\nCHANGED\nd\ne\n';
  const diff = diffLines(before, after);
  assert.deepEqual(diff, ['  a', '  b', '- c', '+ CHANGED', '  d', '  e']);
});

test('diffLines handles pure insertion', () => {
  const diff = diffLines('a\nc\n', 'a\nb\nc\n');
  assert.ok(diff.includes('+ b'));
  assert.ok(!diff.some((l) => l.startsWith('- ')));
});
