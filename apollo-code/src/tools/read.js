import fs from 'node:fs';
import { readTextFile, clampOutput } from '../fsutil.js';

const MAX_LINE = 2000;

export default {
  name: 'read_file',
  readOnly: true,
  description:
    'Read a file from the workspace. Returns the contents with line numbers, ' +
    'which you can quote back in edit_file. Use offset/limit for large files.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the workspace root.' },
      offset: { type: 'integer', description: 'First line to read (1-based). Default 1.' },
      limit: { type: 'integer', description: 'How many lines to read. Default 2000.' },
    },
    required: ['path'],
  },
  async run(args, ctx) {
    const abs = ctx.workspace.resolve(args.path);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) throw new Error(`${args.path} is a directory — use list_dir`);

    const text = readTextFile(abs);
    const all = text.split('\n');
    const offset = Math.max(1, Number(args.offset) || 1);
    const limit = Math.min(Number(args.limit) || 2000, 5000);
    const slice = all.slice(offset - 1, offset - 1 + limit);

    if (slice.length === 0) {
      return `(file has ${all.length} lines; offset ${offset} is past the end)`;
    }

    const width = String(offset + slice.length - 1).length;
    const body = slice
      .map((l, i) => `${String(offset + i).padStart(width)}\t${l.length > MAX_LINE ? l.slice(0, MAX_LINE) + '… [line truncated]' : l}`)
      .join('\n');

    const shownEnd = offset + slice.length - 1;
    const footer = shownEnd < all.length
      ? `\n\n(showing lines ${offset}-${shownEnd} of ${all.length})`
      : '';
    return clampOutput(body + footer, ctx.config.maxOutputChars);
  },
};
