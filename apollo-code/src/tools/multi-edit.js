import fs from 'node:fs';
import { readTextFile } from '../fsutil.js';
import { applyEdit, diffLines } from './edit.js';
import { assertFresh, recordWrite } from './filestate.js';

/**
 * Several edits to one file in a single call. All of them apply or none do,
 * which matters because a half-applied sequence leaves a file that compiles
 * neither before nor after.
 *
 * It also saves round-trips: a local model at 20 tokens/second pays real time
 * for every extra turn.
 */
export function applyEdits(source, edits) {
  let current = source;
  edits.forEach((edit, i) => {
    if (!edit || typeof edit.old_string !== 'string' || typeof edit.new_string !== 'string') {
      throw new Error(`edits[${i}] needs both old_string and new_string`);
    }
    try {
      current = applyEdit(current, edit.old_string, edit.new_string, edit.replace_all).result;
    } catch (err) {
      throw new Error(`edits[${i}] failed: ${err.message} (no changes were written)`);
    }
  });
  return current;
}

export default {
  name: 'multi_edit',
  readOnly: false,
  description:
    'Apply several exact-string replacements to one file in a single call. Edits ' +
    'apply in order, each to the result of the last. If any one fails, none are ' +
    'written. Prefer this over repeated edit_file calls on the same file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the workspace root.' },
      edits: {
        type: 'array',
        description: 'The replacements, in the order they should apply.',
        items: {
          type: 'object',
          properties: {
            old_string: { type: 'string', description: 'Exact text to find.' },
            new_string: { type: 'string', description: 'Text to replace it with.' },
            replace_all: { type: 'boolean', description: 'Replace every occurrence. Default false.' },
          },
          required: ['old_string', 'new_string'],
        },
      },
    },
    required: ['path', 'edits'],
  },
  affects(args, ctx) {
    return [ctx.workspace.resolve(args.path)];
  },
  preview(args, ctx) {
    const abs = ctx.workspace.resolve(args.path);
    assertFresh(ctx.state, abs, args.path);
    const source = readTextFile(abs);
    const result = applyEdits(source, args.edits || []);
    return {
      summary: `Edit ${args.path} (${(args.edits || []).length} changes)`,
      diff: diffLines(source, result, 1),
    };
  },
  async run(args, ctx) {
    if (!Array.isArray(args.edits) || args.edits.length === 0) {
      throw new Error('edits must be a non-empty array');
    }
    const abs = ctx.workspace.resolve(args.path);
    if (!fs.existsSync(abs)) throw new Error(`${args.path} does not exist`);
    assertFresh(ctx.state, abs, args.path);

    const source = readTextFile(abs);
    const result = applyEdits(source, args.edits);
    fs.writeFileSync(abs, result, 'utf8');
    recordWrite(ctx.state, abs);
    return `Edited ${args.path} (${args.edits.length} changes applied)`;
  },
};
