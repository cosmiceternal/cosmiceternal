import fs from 'node:fs';
import { readTextFile } from '../fsutil.js';

/**
 * Exact string replacement. Exported so tests can exercise the matching rules
 * without touching the filesystem.
 */
export function applyEdit(source, oldString, newString, replaceAll = false) {
  if (oldString === newString) {
    throw new Error('old_string and new_string are identical — nothing to do');
  }
  if (oldString === '') {
    throw new Error('old_string must not be empty; use write_file to create a file');
  }

  const occurrences = countOccurrences(source, oldString);
  if (occurrences === 0) {
    throw new Error(
      'old_string was not found in the file. It must match the file exactly, ' +
      'including whitespace and indentation. Re-read the file and copy the text verbatim.'
    );
  }
  if (occurrences > 1 && !replaceAll) {
    throw new Error(
      `old_string appears ${occurrences} times. Include more surrounding context to make ` +
      'it unique, or pass replace_all: true.'
    );
  }

  // Splice by index rather than String.replace: replacement text is literal, so
  // a new_string containing $&, $1 or $` is inserted as written, not expanded.
  let result;
  if (replaceAll) {
    result = source.split(oldString).join(newString);
  } else {
    const at = source.indexOf(oldString);
    result = source.slice(0, at) + newString + source.slice(at + oldString.length);
  }
  return { result, occurrences };
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/** A compact unified-ish diff of the changed region, for display only. */
export function diffLines(before, after, contextLines = 2) {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }

  const out = [];
  for (let i = Math.max(0, start - contextLines); i < start; i++) out.push('  ' + a[i]);
  for (let i = start; i <= endA; i++) out.push('- ' + a[i]);
  for (let i = start; i <= endB; i++) out.push('+ ' + b[i]);
  for (let i = endA + 1; i <= Math.min(a.length - 1, endA + contextLines); i++) out.push('  ' + a[i]);
  return out;
}

export default {
  name: 'edit_file',
  readOnly: false,
  description:
    'Replace an exact string in a file. old_string must match the file byte for byte, ' +
    'including indentation, and must be unique unless replace_all is true. Always ' +
    'read_file first so you copy the text exactly.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the workspace root.' },
      old_string: { type: 'string', description: 'Exact text to find.' },
      new_string: { type: 'string', description: 'Text to replace it with.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence. Default false.' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  preview(args, ctx) {
    const abs = ctx.workspace.resolve(args.path);
    const source = readTextFile(abs);
    const { result } = applyEdit(source, args.old_string, args.new_string, args.replace_all);
    return { summary: `Edit ${args.path}`, diff: diffLines(source, result) };
  },
  async run(args, ctx) {
    const abs = ctx.workspace.resolve(args.path);
    if (!fs.existsSync(abs)) throw new Error(`${args.path} does not exist`);
    const source = readTextFile(abs);
    const { result, occurrences } = applyEdit(
      source, args.old_string, args.new_string, args.replace_all
    );
    fs.writeFileSync(abs, result, 'utf8');
    return `Edited ${args.path} (${occurrences} replacement${occurrences === 1 ? '' : 's'})`;
  },
};
