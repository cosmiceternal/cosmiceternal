import fs from 'node:fs';
import path from 'node:path';

/**
 * Wire-level tracing.
 *
 * When a local model misbehaves — a tool call that never fires, a reply that
 * ends mid-sentence, an edit that targets the wrong text — the question is
 * always "what exactly did the model see, and what exactly did it send back?".
 * Guessing at that from the terminal is hopeless, so Apollo can write every
 * request, every raw stream frame, and every parsed tool call to a JSONL file.
 *
 * Off unless asked for: APOLLO_TRACE=<file>, or --trace <file>.
 */
class Tracer {
  constructor() {
    this.file = null;
    this.stream = null;
    this.seq = 0;
  }

  get enabled() {
    return this.stream !== null;
  }

  enable(file) {
    if (!file) return null;
    try {
      const resolved = path.resolve(file);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      this.stream = fs.createWriteStream(resolved, { flags: 'a' });
      this.file = resolved;
      this.write('session', { startedAt: new Date().toISOString(), pid: process.pid });
      return resolved;
    } catch {
      // Tracing is a diagnostic. Failing to open the file must not stop the run.
      this.stream = null;
      this.file = null;
      return null;
    }
  }

  write(kind, data) {
    if (!this.stream) return;
    try {
      this.stream.write(JSON.stringify({ n: ++this.seq, t: Date.now(), kind, ...data }) + '\n');
    } catch { /* a broken trace must never break the session */ }
  }

  request(url, body) {
    this.write('request', { url, body });
  }

  responseFrame(line) {
    this.write('frame', { line: truncate(line, 8000) });
  }

  event(type, data) {
    this.write('event', { type, ...data });
  }

  close() {
    this.stream?.end();
    this.stream = null;
  }
}

function truncate(text, n) {
  const s = String(text);
  return s.length <= n ? s : s.slice(0, n) + `… [+${s.length - n} chars]`;
}

/** One tracer per process; providers and the agent both write to it. */
export const tracer = new Tracer();
