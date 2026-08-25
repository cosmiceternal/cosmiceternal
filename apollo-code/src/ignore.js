import fs from 'node:fs';
import path from 'node:path';

/**
 * .gitignore support for the search tools.
 *
 * Without it, grep and glob surface generated code, vendored bundles and build
 * output — which wastes the one resource a local model has least of. This
 * implements the parts of the gitignore format that actually appear in
 * real files: comments, blank lines, negation, anchoring, directory-only
 * patterns, `**`, `*`, `?` and character classes.
 *
 * Not implemented: per-directory .gitignore files below the root (only the root
 * file and .git/info/exclude are read) and the global core.excludesFile.
 */
export class IgnoreMatcher {
  constructor(patterns = []) {
    this.rules = patterns
      .map(compile)
      .filter(Boolean);
  }

  /**
   * @param {string} relPath  path relative to the root, with / separators
   * @param {boolean} isDir
   */
  ignores(relPath, isDir = false) {
    let ignored = false;
    // Last matching rule wins, which is how a later `!pattern` un-ignores.
    for (const rule of this.rules) {
      // `under` covers the contents of a matched directory, and applies even to
      // a directory-only rule: "cache/" excludes cache/data.bin too.
      const hit = rule.under.test(relPath)
        || ((isDir || !rule.dirOnly) && rule.self.test(relPath));
      if (hit) ignored = !rule.negated;
    }
    return ignored;
  }

  get size() {
    return this.rules.length;
  }
}

export function loadIgnoreMatcher(root) {
  const patterns = [];
  for (const file of [path.join(root, '.gitignore'), path.join(root, '.git', 'info', 'exclude')]) {
    try {
      patterns.push(...fs.readFileSync(file, 'utf8').split('\n'));
    } catch { /* absent is the normal case */ }
  }
  return new IgnoreMatcher(patterns);
}

function compile(rawLine) {
  let line = rawLine.replace(/\r$/, '');
  if (!line.trim() || line.trimStart().startsWith('#')) return null;

  // Trailing whitespace is insignificant unless escaped.
  line = line.replace(/(?<!\\)\s+$/, '');
  if (!line) return null;

  const negated = line.startsWith('!');
  if (negated) line = line.slice(1);
  line = line.replace(/^\\([#!])/, '$1');

  const dirOnly = line.endsWith('/');
  if (dirOnly) line = line.slice(0, -1);

  // A pattern containing a non-trailing slash is anchored to the root;
  // otherwise it matches at any depth.
  const anchored = line.includes('/') && !line.startsWith('**/');
  if (line.startsWith('/')) line = line.slice(1);
  if (!line) return null;

  const body = translate(line);
  const prefix = anchored ? '^' : '^(?:.*/)?';

  try {
    return {
      self: new RegExp(`${prefix}${body}$`),      // the path itself
      under: new RegExp(`${prefix}${body}/.*$`),  // anything beneath it
      negated,
      dirOnly,
    };
  } catch {
    return null;
  }
}

function translate(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') { out += '(?:.*/)?'; i += 2; }
        else { out += '.*'; i += 1; }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end === -1) { out += '\\['; }
      else {
        let body = pattern.slice(i + 1, end);
        if (body.startsWith('!')) body = '^' + body.slice(1);
        out += '[' + body + ']';
        i = end;
      }
    } else if (c === '\\' && i + 1 < pattern.length) {
      out += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return out;
}
