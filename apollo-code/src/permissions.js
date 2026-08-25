/**
 * Decides whether a tool call is allowed to run.
 *
 * Modes:
 *   read-only  inspect only — every mutating tool is refused
 *   ask        prompt the user for each edit and command (default)
 *   auto-edit  file edits run unattended; shell commands still prompt
 *   yolo       everything runs unattended
 */
export class Permissions {
  constructor({ mode = 'ask', config, ui, prompt } = {}) {
    this.mode = mode;
    this.config = config;
    this.ui = ui;
    this.prompt = prompt;                 // async (question, choices) => string
    this.remembered = new Set();          // tool names approved for the session
    this.allowRules = (config?.allowedCommands || []).map((src) => new RegExp(src));
  }

  setMode(mode) {
    this.mode = mode;
  }

  #autoApproved(tool, args) {
    if (this.remembered.has(tool.name)) return true;
    if (tool.name === 'run_bash' && typeof args?.command === 'string') {
      return this.allowRules.some((re) => re.test(args.command));
    }
    return false;
  }

  /** @returns {Promise<{allow: boolean, reason?: string, remember?: boolean}>} */
  async check(tool, args, preview) {
    if (tool.readOnly) return { allow: true };

    if (this.mode === 'read-only') {
      return {
        allow: false,
        reason: `${tool.name} is not available in read-only mode. Describe the change instead of making it.`,
      };
    }
    if (this.mode === 'yolo') return { allow: true };
    if (this.mode === 'auto-edit' && tool.name !== 'run_bash') return { allow: true };
    if (this.#autoApproved(tool, args)) return { allow: true };

    if (!this.prompt) {
      return {
        allow: false,
        reason:
          `${tool.name} needs approval, but there is no interactive terminal. ` +
          'Rerun with --auto-edit (file changes) or --yolo (everything) to allow it.',
      };
    }

    const answer = await this.prompt(preview, tool);
    if (answer === 'yes') return { allow: true };
    if (answer === 'always') {
      this.remembered.add(tool.name);
      return { allow: true, remember: true };
    }
    return {
      allow: false,
      reason: typeof answer === 'string' && answer.startsWith('no:')
        ? `The user declined and said: ${answer.slice(3).trim()}`
        : 'The user declined this action. Do not retry it; ask what they would prefer.',
    };
  }
}

/** Build the interactive approval prompt bound to a readline interface. */
export function createInteractivePrompt(rl, ui) {
  return async (preview, tool) => {
    ui.flushLine();
    if (preview?.summary) ui.line('  ' + ui.bold(preview.summary));
    if (preview?.diff?.length) ui.diff(preview.diff.slice(0, 30));
    if (typeof preview === 'string') ui.line('  ' + ui.bold(preview));

    ui.line();
    ui.line(`  ${ui.bold('Allow?')} ${ui.dim(`[y] yes  [a] yes, don't ask again for ${tool.name}  [n] no`)}`);

    const raw = (await rl.question('  > ')).trim().toLowerCase();
    if (raw === '' || raw === 'y' || raw === 'yes') return 'yes';
    if (raw === 'a' || raw === 'always') return 'always';
    if (raw === 'n' || raw === 'no') return 'no';
    // Anything else is treated as a refusal with feedback for the model.
    return 'no:' + raw;
  };
}
