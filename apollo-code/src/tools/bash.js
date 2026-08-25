import { spawn } from 'node:child_process';
import { clampOutput } from '../fsutil.js';

/**
 * Commands that are refused outright, in every permission mode including yolo.
 * These are unrecoverable-damage patterns, not a security boundary: a shell is
 * a shell, and anyone running Apollo in yolo mode has handed it their machine.
 * The list exists so a confused model cannot wipe a disk on the first try.
 */
export const HARD_DENY = [
  { re: /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*f?[a-zA-Z]*\s+\/(\s|$)/, why: 'recursive delete of /' },
  { re: /\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*\s+(-[a-zA-Z]+\s+)*(~|\$HOME)(\/\s*)?$/, why: 'recursive delete of the home directory' },
  { re: /\bmkfs(\.\w+)?\b/, why: 'formats a filesystem' },
  { re: /\bdd\b[^|;]*\bof=\/dev\//, why: 'writes directly to a block device' },
  { re: /:\(\)\s*\{.*\}\s*;?\s*:/, why: 'fork bomb' },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/, why: 'powers off the machine' },
  { re: />\s*\/dev\/(sd|nvme|hd)\w+/, why: 'overwrites a raw disk' },
  { re: /\bchmod\s+(-[a-zA-Z]+\s+)*777\s+\/(\s|$)/, why: 'makes the entire filesystem world-writable' },
  { re: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|k)?sh\b/, why: 'pipes a downloaded script straight into a shell' },
];

/** @returns {{allowed: boolean, reason?: string}} */
export function checkCommand(command, extraDeny = []) {
  const patterns = [
    ...HARD_DENY,
    ...extraDeny.map((src) => ({ re: new RegExp(src), why: `matches a configured deny rule (${src})` })),
  ];
  for (const { re, why } of patterns) {
    if (re.test(command)) return { allowed: false, reason: why };
  }
  return { allowed: true };
}

export default {
  name: 'run_bash',
  readOnly: false,
  description:
    'Run a shell command from the workspace root and return its combined output. ' +
    'Use it for builds, tests, linters, git and package managers. Prefer the ' +
    'dedicated read/glob/grep tools for inspecting files.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to run.' },
      timeout_ms: { type: 'integer', description: 'Kill the command after this long. Default 120000.' },
      description: { type: 'string', description: 'A 3-8 word description of what the command does.' },
    },
    required: ['command'],
  },
  preview(args) {
    return `$ ${args.command}`;
  },
  async run(args, ctx) {
    const command = String(args.command || '').trim();
    if (!command) throw new Error('command must not be empty');

    const check = checkCommand(command, ctx.config.deniedCommands);
    if (!check.allowed) {
      throw new Error(`refused: this command ${check.reason}. Apollo will not run it.`);
    }

    const timeout = Math.min(Number(args.timeout_ms) || ctx.config.bashTimeoutMs, 600000);
    const shell = process.platform === 'win32' ? undefined : '/bin/bash';

    return await new Promise((resolve, reject) => {
      const child = spawn(command, {
        cwd: ctx.workspace.root,
        shell: shell || true,
        env: { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat', TERM: 'dumb' },
      });

      let output = '';
      let killed = false;
      const append = (chunk) => {
        output += chunk;
        // Stop buffering long before memory becomes a problem; the model only
        // ever sees a clamped slice anyway.
        if (output.length > ctx.config.maxOutputChars * 4) {
          output = output.slice(0, ctx.config.maxOutputChars * 4);
          killed = true;
          child.kill('SIGKILL');
        }
      };

      child.stdout.on('data', (d) => append(d.toString()));
      child.stderr.on('data', (d) => append(d.toString()));

      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGKILL');
      }, timeout);

      // Ctrl+C should stop the build, not wait politely for it to finish.
      let interrupted = false;
      const onAbort = () => {
        interrupted = true;
        killed = true;
        child.kill('SIGKILL');
      };
      if (ctx.signal) {
        if (ctx.signal.aborted) onAbort();
        else ctx.signal.addEventListener('abort', onAbort, { once: true });
      }

      child.on('error', (err) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', onAbort);
        reject(new Error(`failed to start command: ${err.message}`));
      });

      child.on('close', (code, signal) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', onAbort);
        const body = clampOutput(output.trimEnd(), ctx.config.maxOutputChars);
        if (interrupted) {
          resolve(`${body}\n\n[interrupted by the user]`);
        } else if (killed) {
          resolve(`${body}\n\n[command killed after ${timeout}ms or output limit]`);
        } else if (code === 0) {
          resolve(body || '(no output)');
        } else {
          resolve(`${body || '(no output)'}\n\n[exit code ${signal ? `signal ${signal}` : code}]`);
        }
      });
    });
  },
};
