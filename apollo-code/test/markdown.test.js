import test from 'node:test';
import assert from 'node:assert/strict';
import { MarkdownStream, inline } from '../src/markdown.js';
import { UI } from '../src/ui.js';
import { captureStream } from './helpers/fake-server.js';

/** Renders with colour enabled so styling is observable, then strips ANSI. */
function render(chunks, { color = false } = {}) {
  const stream = captureStream();
  if (color) stream.isTTY = true;
  const ui = new UI({ color, stream });
  const md = new MarkdownStream(ui);
  for (const chunk of chunks) md.write(chunk);
  md.flush();
  return { raw: stream.text, plain: stream.text.replace(/\x1b\[[0-9;]*m/g, '') };
}

test('plain prose passes through unchanged', () => {
  const { plain } = render(['Hello there, this is an answer.\n']);
  assert.equal(plain, 'Hello there, this is an answer.\n');
});

test('prose streams progressively rather than waiting for the newline', () => {
  const stream = captureStream();
  const md = new MarkdownStream(new UI({ color: false, stream }));
  md.write('The answer is ');
  assert.equal(stream.text, 'The answer is ', 'plain text must not be held back');
  md.write('forty two.\n');
  assert.equal(stream.text, 'The answer is forty two.\n');
});

test('a line that could still need styling is held until it is complete', () => {
  const stream = captureStream();
  const md = new MarkdownStream(new UI({ color: false, stream }));
  md.write('this is **bo');
  assert.equal(stream.text, '', 'an unterminated span must not be emitted raw');
  md.write('ld** text\n');
  assert.equal(stream.text.replace(/\x1b\[[0-9;]*m/g, ''), 'this is bold text\n');
});

test('markup characters are consumed, not printed', () => {
  const { plain } = render(['**bold** and `code` and *em*\n']);
  assert.equal(plain, 'bold and code and em\n');
});

test('bold and code are actually styled', () => {
  const { raw } = render(['**bold** and `code`\n'], { color: true });
  assert.match(raw, /\x1b\[1mbold\x1b\[0m/);
  assert.match(raw, /\x1b\[36mcode\x1b\[0m/);
});

test('headings render as bold without the hashes', () => {
  const { plain } = render(['## Section title\n']);
  assert.equal(plain, 'Section title\n');
});

test('bullets and numbered lists are rendered as list markers', () => {
  const { plain } = render(['- first\n- second\n']);
  assert.equal(plain, '• first\n• second\n');
  assert.equal(render(['1. one\n2. two\n']).plain, '1. one\n2. two\n');
});

test('a fenced code block is framed and its contents left literal', () => {
  const { plain } = render(['```js\nconst a = **not bold**;\n```\n']);
  assert.match(plain, /┌─ js/);
  assert.match(plain, /│ const a = \*\*not bold\*\*;/, 'code must not be markdown-processed');
  assert.match(plain, /└/);
});

test('a code fence split across chunks is still detected', () => {
  const { plain } = render(['```', 'python\n', 'x = 1\n', '```\n']);
  assert.match(plain, /┌─ python/);
  assert.match(plain, /│ x = 1/);
});

test('an unterminated code block is closed at flush', () => {
  const { plain } = render(['```\nstill going']);
  assert.match(plain, /┌─/);
  assert.match(plain, /still going/);
});

test('links show the label and the target', () => {
  const { plain } = render(['see [the docs](https://example.com) for more\n']);
  assert.equal(plain, 'see the docs (https://example.com) for more\n');
});

test('blockquotes and horizontal rules render', () => {
  assert.match(render(['> quoted line\n']).plain, /│ quoted line/);
  assert.match(render(['---\n']).plain, /─{10,}/);
});

test('inline() leaves an unmatched marker alone', () => {
  const ui = new UI({ color: false, stream: captureStream() });
  assert.equal(inline(ui, 'a * b'), 'a * b');
  assert.equal(inline(ui, '2 ** 3 is 8'), '2 ** 3 is 8');
});

test('a multiplication expression is not mistaken for emphasis', () => {
  const { plain } = render(['area = w * h and vol = w * h * d\n']);
  assert.equal(plain, 'area = w * h and vol = w * h * d\n');
});
