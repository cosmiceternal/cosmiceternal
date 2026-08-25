import fs from 'node:fs';
import path from 'node:path';
import { assertFresh, recordWrite } from './filestate.js';
import { diffLines } from './edit.js';
import { readTextFile } from '../fsutil.js';

export default {
  name: 'write_file',
  readOnly: false,
  description:
    'Write a complete file, creating parent directories as needed. Overwrites ' +
    'any existing file, so prefer edit_file for changes to a file that already exists.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the workspace root.' },
      content: { type: 'string', description: 'The full contents to write.' },
    },
    required: ['path', 'content'],
  },
  affects(args, ctx) {
    return [ctx.workspace.resolve(args.path)];
  },
  preview(args, ctx) {
    const abs = ctx.workspace.resolve(args.path);
    assertFresh(ctx.state, abs, args.path);
    const content = String(args.content ?? '');
    const lines = content.split('\n').length;

    if (!fs.existsSync(abs)) {
      return { summary: `Create ${args.path} (${lines} lines)`, diff: previewOfNewFile(content) };
    }
    // Overwriting is the dangerous case: show what is actually changing rather
    // than a line count the user has to take on trust.
    return {
      summary: `Overwrite ${args.path} (${lines} lines)`,
      diff: diffLines(readTextFile(abs), content, 2),
    };
  },
  async run(args, ctx) {
    if (typeof args.content !== 'string') throw new Error('content must be a string');
    const abs = ctx.workspace.resolve(args.path);
    assertFresh(ctx.state, abs, args.path);
    const existed = fs.existsSync(abs);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, args.content, 'utf8');
    recordWrite(ctx.state, abs);
    const lines = args.content.split('\n').length;
    return `${existed ? 'Updated' : 'Created'} ${args.path} (${lines} lines, ${Buffer.byteLength(args.content)} bytes)`;
  },
};

/** For a new file, show the first few lines rather than an empty diff. */
function previewOfNewFile(content) {
  const lines = content.split('\n');
  const shown = lines.slice(0, 8).map((l) => '+ ' + l);
  if (lines.length > shown.length) shown.push(`  … ${lines.length - shown.length} more lines`);
  return shown;
}
