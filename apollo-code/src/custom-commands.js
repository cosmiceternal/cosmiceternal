import fs from 'node:fs';
import path from 'node:path';

/**
 * User-defined slash commands.
 *
 * A markdown file in .apollo/commands/ becomes /<filename>. The body is the
 * prompt. This is how a project encodes its own repeated asks — "/review",
 * "/changelog", "/explain" — without anyone having to retype them, and it keeps
 * that knowledge in the repository where the rest of the team gets it too.
 *
 *   .apollo/commands/review.md   ->  /review
 *   ~/.apollo/commands/review.md ->  /review   (project wins on a name clash)
 *
 * $ARGUMENTS interpolates everything typed after the command name; $1, $2 …
 * interpolate individual words.
 */
export function loadCustomCommands({ projectRoot, userDir }) {
  const commands = new Map();
  // Global first so a project file of the same name replaces it.
  for (const [dir, scope] of [
    [path.join(userDir, 'commands'), 'global'],
    [path.join(projectRoot, '.apollo', 'commands'), 'project'],
  ]) {
    for (const command of readDirectory(dir, scope)) {
      commands.set(command.name, command);
    }
  }
  return commands;
}

function readDirectory(dir, scope) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }

  const out = [];
  for (const file of files.sort()) {
    const name = path.basename(file, '.md').toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) continue;
    try {
      const raw = fs.readFileSync(path.join(dir, file), 'utf8');
      const { meta, body } = parseFrontmatter(raw);
      if (!body.trim()) continue;
      out.push({
        name,
        scope,
        file: path.join(dir, file),
        description: meta.description || firstLine(body),
        template: body.trim(),
      });
    } catch { /* an unreadable command file should not break startup */ }
  }
  return out;
}

/** Minimal `---` frontmatter: `key: value` lines only. */
export function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { meta: {}, body: raw };

  const meta = {};
  for (const line of match[1].split('\n')) {
    const pair = line.match(/^\s*([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (pair) meta[pair[1]] = pair[2].trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: raw.slice(match[0].length) };
}

/** Substitute $ARGUMENTS and $1..$9 in a command template. */
export function interpolate(template, args) {
  const words = args.trim().length ? args.trim().split(/\s+/) : [];
  return template
    .replace(/\$ARGUMENTS\b/g, args.trim())
    .replace(/\$(\d)\b/g, (_, index) => words[Number(index) - 1] ?? '');
}

function firstLine(body) {
  const line = body.split('\n').map((l) => l.trim()).find(Boolean) || '';
  return line.replace(/^#+\s*/, '').slice(0, 70);
}
