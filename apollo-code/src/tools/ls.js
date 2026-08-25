import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_IGNORES, clampOutput } from '../fsutil.js';

export default {
  name: 'list_dir',
  readOnly: true,
  description: 'List the entries of a directory in the workspace. Directories are marked with a trailing slash.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path, relative to the workspace root. Default ".".' },
      all: { type: 'boolean', description: 'Include dotfiles and ignored directories. Default false.' },
    },
    required: [],
  },
  async run(args, ctx) {
    const target = args.path || '.';
    const abs = ctx.workspace.resolve(target);
    const stat = fs.statSync(abs);
    if (!stat.isDirectory()) throw new Error(`${target} is not a directory`);

    const entries = fs.readdirSync(abs, { withFileTypes: true })
      .filter((e) => args.all || (!e.name.startsWith('.') && !DEFAULT_IGNORES.has(e.name)))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

    if (entries.length === 0) return `${target} is empty`;

    const lines = entries.map((e) => {
      if (e.isDirectory()) return `${e.name}/`;
      try {
        const size = fs.statSync(path.join(abs, e.name)).size;
        return `${e.name}  ${formatSize(size)}`;
      } catch {
        return e.name;
      }
    });
    return clampOutput(`${target}:\n` + lines.join('\n'), ctx.config.maxOutputChars);
  },
};

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}
