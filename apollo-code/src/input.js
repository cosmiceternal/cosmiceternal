import fs from 'node:fs';
import path from 'node:path';
import { userConfigDir } from './config.js';
import { readTextFile, DEFAULT_IGNORES } from './fsutil.js';

const MAX_REFERENCE_BYTES = 40000;

/**
 * `@path` references.
 *
 * Typing "why does @src/auth.js reject this?" should not require the model to
 * spend a turn discovering and reading the file — on a local model that turn is
 * several seconds and a chunk of context. The reference is resolved up front and
 * attached to the message.
 */
export function expandReferences(input, workspace) {
  // A reference starts a word: at the beginning, after whitespace, or just
  // inside an opening bracket or quote. Requiring that is what keeps
  // "someone@example.com" from being read as a file reference.
  const tokens = [...input.matchAll(/(?:^|[\s([{'"])@([^\s@]+)/g)].map((m) => m[1]);
  if (tokens.length === 0) return { text: input, attached: [], errors: [] };

  const attached = [];
  const errors = [];
  let budget = MAX_REFERENCE_BYTES;

  for (const token of unique(tokens)) {
    // Trailing sentence punctuation is never part of the path: people type
    // "what is in @src?" and "look at @a.js, then stop."
    const clean = token.replace(/[.,;:!?)\]}'"]+$/, '');
    let abs;
    try {
      abs = workspace.resolve(clean);
    } catch (err) {
      errors.push(`@${clean}: ${err.message}`);
      continue;
    }

    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      errors.push(`@${clean}: no such file or directory`);
      continue;
    }

    if (stat.isDirectory()) {
      const entries = fs.readdirSync(abs, { withFileTypes: true })
        .filter((e) => !e.name.startsWith('.') && !DEFAULT_IGNORES.has(e.name))
        .map((e) => e.name + (e.isDirectory() ? '/' : ''));
      attached.push({ path: clean, kind: 'dir', body: entries.join('\n') });
      continue;
    }

    try {
      let body = readTextFile(abs);
      if (body.length > budget) {
        body = body.slice(0, budget) + `\n… [truncated, ${clean} is ${stat.size} bytes]`;
      }
      budget -= body.length;
      attached.push({ path: clean, kind: 'file', body, lines: body.split('\n').length });
      if (budget <= 0) {
        errors.push('reference size limit reached — later @references were skipped');
        break;
      }
    } catch (err) {
      errors.push(`@${clean}: ${err.message}`);
    }
  }

  if (attached.length === 0) return { text: input, attached, errors };

  const sections = attached.map((ref) => ref.kind === 'dir'
    ? `### ${ref.path}/ (directory listing)\n${ref.body}`
    : `### ${ref.path}\n\`\`\`\n${ref.body}\n\`\`\``);

  return {
    text: `${input}\n\n--- Files referenced above ---\n\n${sections.join('\n\n')}`,
    attached,
    errors,
  };
}

/**
 * Tab completion for slash commands and @path references. Deliberately narrow:
 * completing every bare word against the filesystem makes normal typing noisy.
 */
export function createCompleter(workspace, commandNames) {
  return (line) => {
    const slash = line.match(/^\/(\S*)$/);
    if (slash) {
      const prefix = slash[1];
      const hits = commandNames.filter((name) => name.startsWith(prefix)).map((name) => '/' + name);
      return [hits.length ? hits : commandNames.map((n) => '/' + n), line];
    }

    const reference = line.match(/(^|\s)@(\S*)$/);
    if (reference) {
      const partial = reference[2];
      const hits = completePath(workspace.root, partial).map((p) => {
        const head = line.slice(0, line.length - partial.length);
        return head + p;
      });
      return [hits, line];
    }

    return [[], line];
  };
}

function completePath(root, partial) {
  const slash = partial.lastIndexOf('/');
  const dirPart = slash === -1 ? '' : partial.slice(0, slash + 1);
  const filePart = slash === -1 ? partial : partial.slice(slash + 1);

  let entries;
  try {
    entries = fs.readdirSync(path.join(root, dirPart), { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((e) => e.name.startsWith(filePart))
    .filter((e) => filePart.startsWith('.') || (!e.name.startsWith('.') && !DEFAULT_IGNORES.has(e.name)))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .slice(0, 40)
    .map((e) => dirPart + e.name + (e.isDirectory() ? '/' : ''));
}

/**
 * Input history, shared across sessions in a project-agnostic file so the
 * commands you ran yesterday are one up-arrow away.
 */
export class History {
  constructor({ file = path.join(userConfigDir(), 'history'), limit = 500 } = {}) {
    this.file = file;
    this.limit = limit;
    this.enabled = true;
    this.dirReady = false;
  }

  load() {
    try {
      const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
      return lines.slice(-this.limit).reverse(); // readline wants newest first
    } catch {
      return [];
    }
  }

  append(line) {
    if (!this.enabled || !line.trim()) return;
    try {
      if (!this.dirReady) {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        this.dirReady = true;
      }
      fs.appendFileSync(this.file, line.replace(/\n/g, ' ') + '\n');
    } catch {
      // History is a convenience. If the location is unwritable, stop trying
      // rather than paying a failing syscall on every line the user types.
      this.enabled = false;
    }
  }
}

/**
 * Classify a line of input before anything else looks at it.
 * @returns {{kind: 'command'|'shell'|'prompt'|'continued', body: string}}
 */
export function classify(line) {
  if (line.endsWith('\\')) return { kind: 'continued', body: line.slice(0, -1) };
  if (line.startsWith('!')) return { kind: 'shell', body: line.slice(1).trim() };
  if (line.startsWith('/')) return { kind: 'command', body: line };
  return { kind: 'prompt', body: line };
}

function unique(items) {
  return [...new Set(items)];
}
