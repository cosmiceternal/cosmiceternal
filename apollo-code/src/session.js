import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Sessions live in <workspace>/.apollo/sessions so they travel with the project
 * and never leave the machine.
 */
export class Session {
  constructor({ root, id } = {}) {
    this.dir = path.join(root, '.apollo', 'sessions');
    this.id = id || new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex');
    this.messages = [];
    this.todos = [];
    this.usage = { promptTokens: 0, completionTokens: 0, turns: 0 };
    this.createdAt = new Date().toISOString();
  }

  get file() {
    return path.join(this.dir, `${this.id}.json`);
  }

  save({ keep = 50 } = {}) {
    fs.mkdirSync(this.dir, { recursive: true });
    const payload = {
      id: this.id,
      createdAt: this.createdAt,
      updatedAt: new Date().toISOString(),
      title: this.title(),
      usage: this.usage,
      todos: this.todos,
      // The system prompt is rebuilt from the current environment on resume.
      messages: this.messages.filter((m) => m.role !== 'system'),
    };
    fs.writeFileSync(this.file, JSON.stringify(payload, null, 2));
    this.#prune(keep);
    return this.file;
  }

  /** Keep the session directory from growing without bound over months of use. */
  #prune(keep) {
    let files;
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    } catch {
      return;
    }
    if (files.length <= keep) return;

    const byAge = files
      .map((f) => {
        const full = path.join(this.dir, f);
        try {
          return { full, mtime: fs.statSync(full).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);

    for (const stale of byAge.slice(keep)) {
      try { fs.unlinkSync(stale.full); } catch { /* already gone */ }
    }
  }

  title() {
    const firstUser = this.messages.find((m) => m.role === 'user');
    if (!firstUser) return '(empty session)';
    return firstUser.content.split('\n')[0].slice(0, 80);
  }

  static list(root, limit = 20) {
    const dir = path.join(root, '.apollo', 'sessions');
    let files;
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    return files
      .map((f) => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          return {
            id: data.id,
            title: data.title,
            updatedAt: data.updatedAt,
            turns: data.usage?.turns ?? 0,
            messages: data.messages?.length ?? 0,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, limit);
  }

  static load(root, id) {
    const dir = path.join(root, '.apollo', 'sessions');
    const resolved = id === 'last'
      ? Session.list(root, 1)[0]?.id
      : id;
    if (!resolved) throw new Error('no saved sessions found in this project');

    const file = path.join(dir, `${resolved}.json`);
    if (!fs.existsSync(file)) throw new Error(`session ${resolved} not found`);

    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const session = new Session({ root, id: data.id });
    session.messages = data.messages || [];
    session.todos = data.todos || [];
    session.usage = data.usage || { promptTokens: 0, completionTokens: 0, turns: 0 };
    session.createdAt = data.createdAt;
    return session;
  }
}
