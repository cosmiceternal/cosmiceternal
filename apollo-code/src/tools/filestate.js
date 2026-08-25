import fs from 'node:fs';

/**
 * Read-before-write tracking.
 *
 * Two failure modes this prevents, both common with smaller models:
 *   1. Overwriting a file the model never looked at, on a guess about its
 *      contents.
 *   2. Editing from a stale copy — the user (or a formatter, or a git checkout)
 *      changed the file after the model read it, and the edit silently reverts
 *      their work.
 *
 * The check is deliberately an error the model can act on rather than a prompt
 * for the user: "read it again" is something it can just do.
 */

export function recordRead(state, abs) {
  state.reads ??= new Map();
  try {
    const stat = fs.statSync(abs);
    state.reads.set(abs, { mtimeMs: stat.mtimeMs, size: stat.size });
  } catch { /* file vanished between read and record; next check will catch it */ }
}

/** Call after a successful write so the model may keep editing the same file. */
export function recordWrite(state, abs) {
  recordRead(state, abs);
}

export function assertFresh(state, abs, relPath) {
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return; // creating a new file needs no prior read
  }

  const seen = state.reads?.get(abs);
  if (!seen) {
    throw new Error(
      `${relPath} exists but you have not read it in this session. ` +
      'Use read_file first so you are working from its actual contents.'
    );
  }
  if (seen.mtimeMs !== stat.mtimeMs || seen.size !== stat.size) {
    throw new Error(
      `${relPath} has changed on disk since you read it. ` +
      'Read it again and redo the change against the current contents.'
    );
  }
}
