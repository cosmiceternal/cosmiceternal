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
    this.#load();
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
      at: e.at,
      files: e.files.map((f) => path.relative(this.root, f.path)),
    }));
  }

  /**
   * Restore the most recent checkpoint (or a specific one by id).
   * @returns {{label: string, restored: string[], deleted: string[]}}
   */
  undo(id) {
    const index = id
      ? this.entries.findIndex((e) => e.id === id || e.id.startsWith(id))
      : this.entries.length - 1;
    if (index === -1 || this.entries.length === 0) {
      throw new Error(id ? `no checkpoint ${id}` : 'nothing to undo');
    }

    const entry = this.entries[index];
    const restored = [];
    const deleted = [];

    for (const file of entry.files) {
      if (file.before === null) {
        try {
          fs.unlinkSync(file.path);
          deleted.push(path.relative(this.root, file.path));
        } catch { /* already gone */ }
      } else {
        fs.mkdirSync(path.dirname(file.path), { recursive: true });
        fs.writeFileSync(file.path, file.before, 'utf8');
        restored.push(path.relative(this.root, file.path));
      }
    }

    this.entries.splice(index, 1);
    this.#persist();
    return { label: entry.label, restored, deleted };
  }
}
