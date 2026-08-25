import path from 'node:path';
import fs from 'node:fs';
import { loadIgnoreMatcher } from './ignore.js';

/**
 * Every filesystem tool resolves paths through here. The workspace root is a
 * hard boundary: a tool call can never read or write outside it, no matter what
 * the model asks for. This is the single chokepoint for that guarantee, so keep
 * all path handling in this module.
 */
export class Workspace {
  constructor(root) {
    this.root = fs.realpathSync(path.resolve(root));
    // Parsed once per session: every search tool shares this matcher.
    this.ignore = loadIgnoreMatcher(this.root);
  }

  /**
   * Resolve a model-supplied path against the workspace root.
   * Throws if the result escapes the root (via .., an absolute path, or a
   * symlink pointing outside).
   */
  resolve(p) {
    if (typeof p !== 'string' || p.length === 0) {
      throw new Error('path must be a non-empty string');
    }
    if (p.includes('\0')) throw new Error('path contains a null byte');

    const abs = path.resolve(this.root, p);
    const real = this.#realpathOfNearestExisting(abs);

    if (!this.#contains(real)) {
      throw new Error(
        `path escapes the workspace root: ${p} (root: ${this.root})`
      );
    }
    // Return the non-realpath'd absolute form so writes land where asked.
    return abs;
  }

  /** Path relative to the root, for display. */
  relative(abs) {
    const rel = path.relative(this.root, abs);
    return rel === '' ? '.' : rel;
  }

  #contains(target) {
    if (target === this.root) return true;
    return target.startsWith(this.root + path.sep);
  }

  /**
   * realpath() fails on paths that do not exist yet (a file about to be
   * written). Walk up to the nearest existing ancestor, realpath that, then
   * re-append the remaining segments — so a symlinked parent directory is still
   * resolved and checked.
   */
  #realpathOfNearestExisting(abs) {
    let current = abs;
    const trailing = [];
    for (;;) {
      try {
        const real = fs.realpathSync(current);
        return trailing.length ? path.join(real, ...trailing.reverse()) : real;
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        const parent = path.dirname(current);
        if (parent === current) return abs; // hit the filesystem root
        trailing.push(path.basename(current));
        current = parent;
      }
    }
  }
}
