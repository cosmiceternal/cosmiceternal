import fs from 'node:fs';
import path from 'node:path';
import { walk, matchesGlob, looksBinary, clampOutput } from '../fsutil.js';

export default {
  name: 'grep',
  readOnly: true,
  description:
    'Search file contents with a regular expression. Returns matching lines as ' +
    'path:line:text. Narrow the search with the glob or path arguments.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'JavaScript regular expression.' },
      path: { type: 'string', description: 'Directory or file to search. Default is the workspace root.' },
      glob: { type: 'string', description: 'Only search files matching this glob, e.g. "**/*.js".' },
      ignore_case: { type: 'boolean', description: 'Case-insensitive search. Default false.' },
      files_only: { type: 'boolean', description: 'Return only the file paths that contain a match.' },
      context: { type: 'integer', description: 'Lines of context around each match. Default 0.' },
      limit: { type: 'integer', description: 'Maximum matching lines. Default 100.' },
    },
    required: ['pattern'],
  },
  async run(args, ctx) {
    let re;
    try {
      re = new RegExp(args.pattern, args.ignore_case ? 'i' : '');
    } catch (err) {
      throw new Error(`invalid regular expression: ${err.message}`);
    }

    const target = ctx.workspace.resolve(args.path || '.');
    const limit = Math.min(Number(args.limit) || 100, 1000);
    const contextLines = Math.min(Math.max(Number(args.context) || 0, 0), 10);

    const files = [];
    if (fs.statSync(target).isFile()) {
      files.push(path.relative(ctx.workspace.root, target));
    } else {
      for (const rel of walk(ctx.workspace.root, { dir: target, ignore: ctx.workspace.ignore })) {
        if (args.glob && !matchesGlob(rel, args.glob)) continue;
        files.push(rel);
      }
    }

    const out = [];
    const matchedFiles = [];
    let total = 0;

    for (const rel of files) {
      let buf;
      try {
        buf = fs.readFileSync(path.join(ctx.workspace.root, rel));
      } catch { continue; }
      if (looksBinary(buf)) continue;

      const lines = buf.toString('utf8').split('\n');
      let fileMatched = false;

      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        fileMatched = true;
        if (args.files_only) break;
        if (total >= limit) break;
        total++;

        for (let c = Math.max(0, i - contextLines); c < i; c++) {
          out.push(`${rel}-${c + 1}- ${lines[c]}`);
        }
        out.push(`${rel}:${i + 1}: ${lines[i]}`);
        for (let c = i + 1; c <= Math.min(lines.length - 1, i + contextLines); c++) {
          out.push(`${rel}-${c + 1}- ${lines[c]}`);
        }
      }
      if (fileMatched) matchedFiles.push(rel);
      if (total >= limit && !args.files_only) break;
    }

    if (args.files_only) {
      return matchedFiles.length
        ? clampOutput(matchedFiles.join('\n'), ctx.config.maxOutputChars)
        : `No files matched /${args.pattern}/`;
    }
    if (out.length === 0) return `No matches for /${args.pattern}/`;
    const footer = total >= limit ? `\n… result limit (${limit}) reached; narrow the search` : '';
    return clampOutput(out.join('\n') + footer, ctx.config.maxOutputChars);
  },
};
