const CODES = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', italic: '\x1b[3m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m',
  magenta: '\x1b[35m', cyan: '\x1b[36m', gray: '\x1b[90m', white: '\x1b[37m',
};

export class UI {
  constructor({ color = true, stream = process.stdout } = {}) {
    this.enabled = color && stream.isTTY && !process.env.NO_COLOR;
    this.out = stream;
    this.spinner = null;
    this.atLineStart = true;
  }

  paint(code, text) {
    return this.enabled ? CODES[code] + text + CODES.reset : text;
  }

  bold(t) { return this.paint('bold', t); }
  dim(t) { return this.paint('dim', t); }
  red(t) { return this.paint('red', t); }
  green(t) { return this.paint('green', t); }
  yellow(t) { return this.paint('yellow', t); }
  cyan(t) { return this.paint('cyan', t); }
  gray(t) { return this.paint('gray', t); }
  magenta(t) { return this.paint('magenta', t); }

  write(text) {
    if (!text) return;
    this.stopSpinner();
    this.out.write(text);
    this.atLineStart = text.endsWith('\n');
  }

  line(text = '') {
    this.stopSpinner();
    if (!this.atLineStart) this.out.write('\n');
    this.out.write(text + '\n');
    this.atLineStart = true;
  }

  /** Ensure following output starts on a fresh line. */
  flushLine() {
    if (!this.atLineStart) {
      this.out.write('\n');
      this.atLineStart = true;
    }
  }

  banner(cfg) {
    this.line();
    this.line(`  ${this.bold(this.yellow('APOLLO'))} ${this.dim('· offline coding agent')}`);
    this.line(`  ${this.dim(`${cfg.model} via ${cfg.provider} @ ${cfg.baseUrl}`)}`);
    this.line(`  ${this.dim(`mode: ${cfg.permissionMode} · /help for commands · Ctrl+C to exit`)}`);
    this.line();
  }

  info(text) { this.line(this.dim(text)); }
  warn(text) { this.line(this.yellow('! ') + text); }
  error(text) { this.line(this.red('✗ ') + text); }
  success(text) { this.line(this.green('✓ ') + text); }

  /** A tool invocation header: ● run_bash(npm test) */
  toolCall(name, summary) {
    this.flushLine();
    const args = summary ? this.dim(`(${summary})`) : '';
    this.line(`${this.green('●')} ${this.bold(name)}${args}`);
  }

  /** The result line under a tool call, in the ⎿ gutter style. */
  toolResult(text, { isError = false } = {}) {
    const lines = String(text).split('\n');
    const shown = lines.slice(0, 12);
    const paint = (s) => (isError ? this.red(s) : this.dim(s));
    for (const [i, l] of shown.entries()) {
      const gutter = i === 0 ? '  ⎿ ' : '    ';
      this.line(paint(gutter + l));
    }
    if (lines.length > shown.length) {
      this.line(this.dim(`    … ${lines.length - shown.length} more lines`));
    }
  }

  diff(patchLines) {
    for (const l of patchLines) {
      if (l.startsWith('+')) this.line('    ' + this.green(l));
      else if (l.startsWith('-')) this.line('    ' + this.red(l));
      else this.line('    ' + this.dim(l));
    }
  }

  startSpinner(label = 'thinking') {
    if (!this.enabled || this.spinner) return;
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let i = 0;
    const started = Date.now();
    this.spinner = setInterval(() => {
      const secs = Math.floor((Date.now() - started) / 1000);
      const suffix = secs >= 2 ? ` ${secs}s` : '';
      this.out.write(`\r${CODES.yellow}${frames[i++ % frames.length]}${CODES.reset} ${CODES.dim}${label}${suffix}${CODES.reset}\x1b[K`);
    }, 80);
    this.spinner.unref?.();
  }

  stopSpinner() {
    if (!this.spinner) return;
    clearInterval(this.spinner);
    this.spinner = null;
    this.out.write('\r\x1b[K');
    this.atLineStart = true;
  }
}

/** Collapse a tool's arguments into a short one-line summary for the header. */
export function summarizeArgs(name, args) {
  if (!args || typeof args !== 'object') return '';
  const pick = (...keys) => keys.map((k) => args[k]).find((v) => typeof v === 'string' && v);
  switch (name) {
    case 'run_bash': return truncate(String(args.command ?? ''), 70);
    case 'grep': return `${truncate(String(args.pattern ?? ''), 40)}${args.path ? ' in ' + args.path : ''}`;
    case 'glob': return truncate(String(args.pattern ?? ''), 60);
    case 'todo_write': return `${Array.isArray(args.todos) ? args.todos.length : 0} items`;
    default: return truncate(String(pick('path', 'file', 'pattern', 'command') ?? ''), 60);
  }
}

export function truncate(s, n) {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
