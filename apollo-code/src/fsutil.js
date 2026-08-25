import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_IGNORES = new Set([
  '.git', 'node_modules', '.next', 'dist', 'build', 'out', 'target',
  '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache',
  '.cache', 'coverage', '.gradle', '.idea', '.turbo', 'vendor',
]);

/** Translate a glob into an anchored RegExp. Supports **, *, ?, {a,b}, [abc]. */
export function globToRegExp(glob) {
  let re = '';
  let i = 0;
  const groups = [];

  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // '**/' matches zero or more directories; a bare '**' matches anything.
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 3; }
        else { re += '.*'; i += 2; }
      } else {
        re += '[^/]*';
        i += 1;
      }
    } else if (c === '?') {
      re += '[^/]'; i += 1;
    } else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end === -1) { re += '\\['; i += 1; }
      else {
        let body = glob.slice(i + 1, end);
        if (body.startsWith('!')) body = '^' + body.slice(1);
        re += '[' + body + ']';
        i = end + 1;
      }
    } else if (c === '{') {
      groups.push(true); re += '(?:'; i += 1;
    } else if (c === '}' && groups.length) {
      groups.pop(); re += ')'; i += 1;
    } else if (c === ',' && groups.length) {
      re += '|'; i += 1;
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp('^' + re + '$');
}

export function matchesGlob(relPath, glob) {
  const re = globToRegExp(glob);
  if (re.test(relPath)) return true;
  // A bare pattern like "*.js" should also match nested files, the way
  // developers expect from a search tool.
  if (!glob.includes('/')) return re.test(path.basename(relPath));
  return false;
}

/**
 * Walk a directory yielding file paths relative to `root`.
 * Skips DEFAULT_IGNORES, anything the project's .gitignore excludes, dotfiles
 * (unless includeHidden), and stops at `limit`.
 */
export function* walk(root, { dir = root, includeHidden = false, limit = 20000, ignore = null } = {}) {
  const stack = [dir];
  let count = 0;
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue; // unreadable directory — skip rather than abort the whole walk
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (DEFAULT_IGNORES.has(entry.name)) continue;
      if (!includeHidden && entry.name.startsWith('.') && entry.name !== '.') continue;

      const abs = path.join(current, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      const isDir = entry.isDirectory();
      if (ignore?.ignores(rel, isDir)) continue;

      if (isDir) {
        stack.push(abs);
      } else if (entry.isFile()) {
        if (++count > limit) return;
        yield rel;
      }
    }
  }
}

/** Cheap binary sniff: a NUL byte in the first 8 KiB. */
export function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export function readTextFile(abs) {
  const buf = fs.readFileSync(abs);
  if (looksBinary(buf)) throw new Error('file appears to be binary');
  return buf.toString('utf8');
}

/** Clamp tool output so one runaway command can't blow the context window. */
export function clampOutput(text, maxChars) {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, Math.floor(maxChars * 0.7));
  const tail = text.slice(-Math.floor(maxChars * 0.25));
  const dropped = text.length - head.length - tail.length;
  return `${head}\n\n… [${dropped} characters truncated] …\n\n${tail}`;
}
