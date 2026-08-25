import fs from 'node:fs';
import path from 'node:path';
import { walk, matchesGlob, clampOutput } from '../fsutil.js';

export default {
  name: 'glob',
  readOnly: true,
  description:
    'Find files by name pattern (e.g. "**/*.test.js", "src/**/*.{ts,tsx}"). ' +
    'Returns paths sorted by most recently modified first.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern.' },
      path: { type: 'string', description: 'Directory to search under. Default is the workspace root.' },
      limit: { type: 'integer', description: 'Maximum results. Default 200.' },
    },
    required: ['pattern'],
  },
  async run(args, ctx) {
    const base = ctx.workspace.resolve(args.path || '.');
    const limit = Math.min(Number(args.limit) || 200, 1000);
    const includeHidden = args.pattern.includes('/.') || args.pattern.startsWith('.');

    const hits = [];
    for (const rel of walk(ctx.workspace.root, { dir: base, includeHidden, ignore: ctx.workspace.ignore })) {
      if (!matchesGlob(rel, args.pattern)) continue;
      try {
        hits.push({ rel, mtime: fs.statSync(path.join(ctx.workspace.root, rel)).mtimeMs });
      } catch {
        hits.push({ rel, mtime: 0 });
      }
    }

    if (hits.length === 0) return `No files matched ${args.pattern}`;
    hits.sort((a, b) => b.mtime - a.mtime);
    const shown = hits.slice(0, limit).map((h) => h.rel);
    const more = hits.length > limit ? `\n… ${hits.length - limit} more matches` : '';
    return clampOutput(shown.join('\n') + more, ctx.config.maxOutputChars);
  },
};
