import fs from 'node:fs';
import path from 'node:path';

/**
 * Undo for tool-driven file changes.
 *
 * A local model will occasionally mangle a file, and the user's instinct is to
 * reach for git — which does not help when the change is unstaged and mixed in
 * with their own work. Apollo snapshots every file a tool is about to touch and
 * keeps the snapshots so `/undo` can put things back exactly as they were.
 *
 * Snapshots live in .apollo/checkpoints so they survive a resume, and are
 * pruned to `limit` entries.
 */
export class CheckpointStore {
  constructor({ root, limit = 40 } = {}) {
    this.root = root;
    this.dir = path.join(root, '.apollo', 'checkpoints');
    this.limit = limit;
    this.entries = [];
    // Groups checkpoints by the user turn that caused them, so a turn that
    // touched five files can be undone as one thing.
    this.turn = 0;
    this.#load();
  }

  /** Called at the start of each user turn. */
  beginTurn(id) {
    this.turn = id;
  }

  #load() {
    try {
      const file = path.join(this.dir, 'index.json');
      this.entries = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      this.entries = [];
    }
  }

  #persist() {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, 'index.json'), JSON.stringify(this.entries, null, 2));
  }

  /**
   * Read the current state of the paths a tool declares it will change.
   * Returns null for a file that does not exist yet, so undo can delete it.
   */
  capture(absPaths) {
    return absPaths.map((abs) => {
      let before = null;
      try {
        before = fs.readFileSync(abs, 'utf8');
      } catch { /* new file */ }
      return { path: abs, before };
    });
  }

  /** Keep a captured snapshot under a human-readable label. */
  commit(label, snapshot) {
    if (!snapshot?.length) return null;
    const entry = {
      id: String(this.entries.length + 1).padStart(4, '0') + '-' + Date.now().toString(36),
      label,
      turn: this.turn,
      at: new Date().toISOString(),
      files: snapshot.map((f) => ({ path: f.path, before: f.before })),
    };
    this.entries.push(entry);
    while (this.entries.length > this.limit) this.entries.shift();
    this.#persist();
    return entry;
  }

  list(limit = 10) {
    return this.entries.slice(-limit).reverse().map((e) => ({
      id: e.id,
      label: e.label,
      turn: e.turn ?? 0,
      at: e.at,
      files: e.files.map((f) => path.relative(this.root, f.path)),
    }));
  }

  /**
   * Restore checkpoints.
   *   undo()            the most recent single change
   *   undo('turn')      every change made by the most recent turn
   *   undo('all')       every change still recorded
   *   undo('<id>')      one specific checkpoint
   *
   * Reverting oldest-last matters: a file touched twice must end up holding the
   * state it had before the *first* of those changes.
   *
   * @returns {{label: string, restored: string[], deleted: string[], count: number}}
   */
  undo(selector) {
    if (this.entries.length === 0) throw new Error('nothing to undo');

    const chosen = this.#select(selector);
    if (chosen.length === 0) {
      throw new Error(selector ? `no checkpoint matching "${selector}"` : 'nothing to undo');
    }

    const restored = new Set();
    const deleted = new Set();

    // Newest first, so an earlier snapshot of the same file wins.
    for (const entry of [...chosen].reverse()) {
      for (const file of entry.files) {
        const rel = path.relative(this.root, file.path);
        if (file.before === null) {
          try {
            fs.unlinkSync(file.path);
            deleted.add(rel);
          } catch { /* already gone */ }
          restored.delete(rel);
        } else {
          fs.mkdirSync(path.dirname(file.path), { recursive: true });
          fs.writeFileSync(file.path, file.before, 'utf8');
          restored.add(rel);
          deleted.delete(rel);
        }
      }
      this.entries.splice(this.entries.indexOf(entry), 1);
    }

    this.#persist();
    return {
      label: chosen.length === 1 ? chosen[0].label : `${chosen.length} changes`,
      restored: [...restored],
      deleted: [...deleted],
      count: chosen.length,
    };
  }

  #select(selector) {
    if (!selector) return this.entries.slice(-1);
    if (selector === 'all') return [...this.entries];
    if (selector === 'turn') {
      const lastTurn = this.entries.at(-1).turn ?? 0;
      return this.entries.filter((e) => (e.turn ?? 0) === lastTurn);
    }
    const match = this.entries.find((e) => e.id === selector || e.id.startsWith(selector));
    return match ? [match] : [];
  }
}
