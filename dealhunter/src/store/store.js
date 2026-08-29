'use strict';

// A tiny append-only document store: one NDJSON log per collection, replayed
// into a Map on open and compacted once the log grows past twice the live set.
//
// Why not SQLite: this service holds thousands of rows, not millions, and it
// has to run on any Node 18+ host with `npm install` doing nothing at all. An
// append-only log gives us crash-safe writes and a file you can grep, without
// a native build step.
const fs = require('node:fs');
const path = require('node:path');

const PUT = 'p';
const DEL = 'x';

class Collection {
  constructor(name, file, options = {}) {
    this.name = name;
    this.file = file;
    this.docs = new Map();
    this.appends = 0;
    this.compactThreshold = options.compactThreshold || 500;
    this.autoCompact = options.autoCompact !== false;
    this._replay();
  }

  _replay() {
    if (!fs.existsSync(this.file)) return;
    const raw = fs.readFileSync(this.file, 'utf8');
    let lines = 0;
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        // A torn final line is the expected outcome of a crash mid-append;
        // everything before it is still valid, so stop rather than throw.
        break;
      }
      lines += 1;
      if (entry.o === DEL) this.docs.delete(entry.i);
      else if (entry.d) this.docs.set(entry.i, entry.d);
    }
    this.appends = lines;
  }

  _append(entries) {
    if (!entries.length) return;
    fs.appendFileSync(this.file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    this.appends += entries.length;
    if (this.autoCompact && this.appends > this.compactThreshold && this.appends > this.docs.size * 2) {
      this.compact();
    }
  }

  get(id) {
    const doc = this.docs.get(String(id));
    return doc ? structuredClone(doc) : undefined;
  }

  has(id) {
    return this.docs.has(String(id));
  }

  put(doc) {
    if (!doc || doc.id === undefined || doc.id === null || doc.id === '') {
      throw new Error(`${this.name}: document needs an id`);
    }
    const id = String(doc.id);
    const stored = structuredClone({ ...doc, id });
    this.docs.set(id, stored);
    this._append([{ o: PUT, i: id, d: stored }]);
    return structuredClone(stored);
  }

  putMany(docs) {
    const entries = [];
    for (const doc of docs) {
      if (!doc || doc.id === undefined || doc.id === null || doc.id === '') {
        throw new Error(`${this.name}: document needs an id`);
      }
      const id = String(doc.id);
      const stored = structuredClone({ ...doc, id });
      this.docs.set(id, stored);
      entries.push({ o: PUT, i: id, d: stored });
    }
    this._append(entries);
    return docs.length;
  }

  // Read-modify-write in one call. `updater` receives the current document (or
  // undefined) and returns the document to store; returning undefined is a
  // no-op, which lets callers skip writes cheaply.
  upsert(id, updater) {
    const key = String(id);
    const current = this.docs.get(key);
    const next = updater(current ? structuredClone(current) : undefined);
    if (next === undefined) return current ? structuredClone(current) : undefined;
    return this.put({ ...next, id: key });
  }

  delete(id) {
    const key = String(id);
    if (!this.docs.has(key)) return false;
    this.docs.delete(key);
    this._append([{ o: DEL, i: key }]);
    return true;
  }

  all() {
    return Array.from(this.docs.values(), (doc) => structuredClone(doc));
  }

  find(predicate) {
    const out = [];
    for (const doc of this.docs.values()) {
      if (predicate(doc)) out.push(structuredClone(doc));
    }
    return out;
  }

  count(predicate) {
    if (!predicate) return this.docs.size;
    let n = 0;
    for (const doc of this.docs.values()) if (predicate(doc)) n += 1;
    return n;
  }

  clear() {
    this.docs.clear();
    fs.writeFileSync(this.file, '');
    this.appends = 0;
  }

  // Rewrite the log as one entry per live document. Written to a temp file and
  // renamed, so a crash mid-compaction leaves the old log intact.
  compact() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    const body = Array.from(this.docs.entries(), ([id, doc]) => JSON.stringify({ o: PUT, i: id, d: doc })).join('\n');
    fs.writeFileSync(tmp, body ? body + '\n' : '');
    fs.renameSync(tmp, this.file);
    this.appends = this.docs.size;
    return this.appends;
  }
}

function openStore(dir, options = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const collections = new Map();

  return {
    dir,
    collection(name) {
      if (!/^[a-z0-9_-]+$/i.test(name)) throw new Error(`invalid collection name: ${name}`);
      let col = collections.get(name);
      if (!col) {
        col = new Collection(name, path.join(dir, `${name}.ndjson`), options);
        collections.set(name, col);
      }
      return col;
    },
    stats() {
      const out = {};
      for (const [name, col] of collections) out[name] = { docs: col.docs.size, logEntries: col.appends };
      return out;
    },
    compactAll() {
      for (const col of collections.values()) col.compact();
    },
  };
}

module.exports = { openStore, Collection };
