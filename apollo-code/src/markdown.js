/**
 * Streaming markdown renderer for the terminal.
 *
 * Models write markdown whether you ask them to or not, and raw `**like this**`
 * in a terminal is worse than no formatting at all. The wrinkle is that output
 * arrives a few characters at a time, so styling has to be decided without
 * having seen the end of the line.
 *
 * The rule: a line is buffered only while it could still need formatting. Plain
 * prose — no markup characters, no block prefix — streams straight through, so
 * the reply still appears as it is generated.
 */

const BLOCK_PREFIX = /^\s*(#{1,6}\s|[-*+]\s|\d+\.\s|>\s)/;
const MARKUP_CHARS = /[*_`~[]/;

export class MarkdownStream {
  constructor(ui) {
    this.ui = ui;
    this.buffer = '';
    this.emittedOnLine = false;
    this.inFence = false;
    this.fenceLang = '';
  }

  write(delta) {
    if (!delta) return;
    this.buffer += delta;

    let newlineAt;
    while ((newlineAt = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineAt);
      this.buffer = this.buffer.slice(newlineAt + 1);
      this.#emitLine(line);
      this.emittedOnLine = false;
    }

    if (this.#canStreamEagerly()) {
      this.ui.write(this.buffer);
      this.buffer = '';
      this.emittedOnLine = true;
    }
  }

  /** Emit whatever is left; call at the end of a turn. */
  flush() {
    if (this.buffer) {
      this.#emitLine(this.buffer);
      this.buffer = '';
    }
    this.emittedOnLine = false;
    if (this.inFence) {
      // The model stopped mid-fence; close the visual block so the next
      // thing printed isn't swallowed into it.
      this.inFence = false;
    }
  }

  #canStreamEagerly() {
    if (this.inFence || !this.buffer) return false;
    if (MARKUP_CHARS.test(this.buffer)) return false;
    if (!this.emittedOnLine && BLOCK_PREFIX.test(this.buffer)) return false;
    return true;
  }

  #emitLine(line) {
    const fence = line.match(/^\s*```(\w*)/);
    if (fence) {
      if (this.inFence) {
        this.inFence = false;
        this.ui.line(this.ui.dim('  └' + '─'.repeat(Math.max(0, 40))));
      } else {
        this.inFence = true;
        this.fenceLang = fence[1] || '';
        this.ui.line(this.ui.dim(`  ┌─ ${this.fenceLang || 'code'} ` + '─'.repeat(Math.max(0, 36 - this.fenceLang.length))));
      }
      return;
    }

    if (this.inFence) {
      this.ui.line(this.ui.dim('  │ ') + this.ui.cyan(line));
      return;
    }

    // A line that was partly streamed already can only take inline styling on
    // what is left of it — and must continue the current line rather than
    // starting a new one.
    if (this.emittedOnLine) {
      this.ui.write(inline(this.ui, line) + '\n');
      return;
    }

    this.ui.line(renderBlock(this.ui, line));
  }
}

function renderBlock(ui, line) {
  const heading = line.match(/^(\s*)(#{1,6})\s+(.*)$/);
  if (heading) {
    return heading[1] + ui.bold(inline(ui, heading[3]));
  }

  const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
  if (bullet) {
    return `${bullet[1]}${ui.dim('•')} ${inline(ui, bullet[2])}`;
  }

  const numbered = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
  if (numbered) {
    return `${numbered[1]}${ui.dim(numbered[2] + '.')} ${inline(ui, numbered[3])}`;
  }

  const quote = line.match(/^(\s*)>\s?(.*)$/);
  if (quote) {
    return `${quote[1]}${ui.dim('│ ' + quote[2])}`;
  }

  if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line) && line.trim().length >= 3) {
    return ui.dim('─'.repeat(48));
  }

  return inline(ui, line);
}

/** Inline spans: `code`, **bold**, *italic*, ~~strike~~, [text](target). */
export function inline(ui, text) {
  return text
    .replace(/`([^`]+)`/g, (_, code) => ui.cyan(code))
    .replace(/\*\*([^*]+)\*\*/g, (_, bold) => ui.bold(bold))
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, (_, pre, em) => pre + ui.dim(em))
    .replace(/~~([^~]+)~~/g, (_, strike) => ui.dim(strike))
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, target) => `${ui.bold(label)} ${ui.dim('(' + target + ')')}`);
}
