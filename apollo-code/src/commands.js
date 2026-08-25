import fs from 'node:fs';
import path from 'node:path';
import { Session } from './session.js';
import { compact } from './context.js';
import { saveUserConfig } from './config.js';

const INIT_PROMPT = `Analyse this codebase and write an APOLLO.md file at the workspace root.

APOLLO.md is standing instructions for a coding agent working here. Include only what someone would otherwise have to rediscover:
- What the project is, in two lines.
- The commands that matter: build, test, run a single test, lint, typecheck.
- Architecture worth knowing before editing — the main modules and how they fit.
- Conventions this codebase actually follows (style, error handling, testing patterns), inferred from the code, not from general best practice.
- Anything surprising or easy to get wrong.

Explore first with glob, grep and read_file. Read the existing README, package manifests, CI config and test setup. Keep it under 100 lines and concrete — no filler, no generic advice. If an APOLLO.md already exists, improve it instead of replacing it wholesale. Write the file with write_file when you are done.`;

export const COMMANDS = {
  help: {
    summary: 'Show this help',
    run({ ui }) {
      ui.line();
      ui.line(ui.bold('  Commands'));
      const width = Math.max(...Object.keys(COMMANDS).map((k) => k.length)) + 2;
      for (const [name, cmd] of Object.entries(COMMANDS)) {
        ui.line(`    ${ui.cyan('/' + name.padEnd(width))} ${ui.dim(cmd.summary)}`);
      }
      ui.line();
      ui.line(ui.dim('  Anything else is sent to the model. Ctrl+C cancels a turn, twice exits.'));
      ui.line();
    },
  },

  model: {
    summary: 'Show or switch the active model: /model qwen2.5-coder:14b',
    async run({ ui, config, args, provider }) {
      if (!args) {
        ui.info(`Current model: ${config.model}`);
        return;
      }
      const models = await provider.listModels().catch(() => []);
      const known = models.map((m) => m.id);
      if (known.length && !known.includes(args)) {
        const near = known.filter((m) => m.startsWith(args.split(':')[0]));
        ui.warn(`${args} is not installed.${near.length ? ` Did you mean: ${near.join(', ')}?` : ''}`);
        ui.info(known.length ? `Installed: ${known.join(', ')}` : '');
        return;
      }
      config.model = args;
      ui.success(`Model set to ${args} for this session. (/config save to persist)`);
    },
  },

  models: {
    summary: 'List the models your backend has installed',
    async run({ ui, provider, config }) {
      const models = await provider.listModels();
      if (!models.length) {
        ui.warn('No models found. With Ollama: ollama pull qwen2.5-coder:7b');
        return;
      }
      ui.line();
      for (const m of models) {
        const active = m.id === config.model ? ui.green(' ← active') : '';
        const meta = [m.parameters, m.quantization, m.size ? formatBytes(m.size) : null].filter(Boolean).join(' · ');
        ui.line(`  ${m.id.padEnd(34)} ${ui.dim(meta)}${active}`);
      }
      ui.line();
    },
  },

  mode: {
    summary: 'Show or set the permission mode: ask | auto-edit | yolo | read-only',
    run({ ui, config, args, permissions }) {
      const modes = ['ask', 'auto-edit', 'yolo', 'read-only'];
      if (!args) {
        ui.info(`Permission mode: ${config.permissionMode}  (${modes.join(' | ')})`);
        return;
      }
      if (!modes.includes(args)) {
        ui.error(`Unknown mode "${args}". Choose one of: ${modes.join(', ')}`);
        return;
      }
      config.permissionMode = args;
      permissions.setMode(args);
      ui.success(`Permission mode: ${args}`);
      if (args === 'yolo') ui.warn('Apollo will now run edits and shell commands without asking.');
    },
  },

  tools: {
    summary: 'List the tools available to the model',
    run({ ui, registry, toolMode }) {
      ui.line();
      ui.info(`  tool calling: ${toolMode()}`);
      for (const tool of registry.values()) {
        const tag = tool.readOnly ? ui.dim('read') : ui.yellow('write');
        ui.line(`  ${tool.name.padEnd(12)} ${tag}  ${ui.dim(tool.description.split('.')[0])}`);
      }
      ui.line();
    },
  },

  context: {
    summary: 'Show context window usage for this session',
    run({ ui, agent, session, config }) {
      const u = agent.usage();
      const pct = Math.round(u.fraction * 100);
      const bar = renderBar(u.fraction);
      ui.line();
      ui.line(`  context  ${bar} ${pct}%  ${ui.dim(`~${u.used} / ${u.budget} tokens`)}`);
      ui.line(`  window   ${ui.dim(`${config.contextTokens} tokens, reserving ${config.maxTokens} for the reply`)}`);
      ui.line(`  turns    ${ui.dim(String(session.usage.turns))}`);
      ui.line(`  reported ${ui.dim(`${session.usage.promptTokens} prompt + ${session.usage.completionTokens} completion tokens`)}`);
      ui.line();
      if (u.fraction > 0.6) ui.info('  /compact will summarize the older half of the conversation.');
    },
  },

  compact: {
    summary: 'Summarize the conversation so far to free up context',
    async run({ ui, session, provider }) {
      ui.startSpinner('compacting');
      const result = await compact(session.messages, provider);
      ui.stopSpinner();
      if (!result.compacted) {
        ui.info('Nothing to compact yet.');
        return;
      }
      session.messages = result.messages;
      ui.success(`Compacted — freed ~${result.freed} tokens.`);
    },
  },

  clear: {
    summary: 'Start a fresh conversation (keeps your settings)',
    run({ ui, session, agent }) {
      const system = session.messages.find((m) => m.role === 'system');
      session.messages = system ? [system] : [];
      session.usage = { promptTokens: 0, completionTokens: 0, turns: 0 };
      session.todos = [];
      agent.state.todos = [];
      ui.success('Conversation cleared.');
    },
  },

  init: {
    summary: 'Have Apollo write an APOLLO.md for this project',
    run() {
      return { prompt: INIT_PROMPT };
    },
  },

  sessions: {
    summary: 'List saved sessions in this project',
    run({ ui, workspace }) {
      const list = Session.list(workspace.root);
      if (!list.length) {
        ui.info('No saved sessions yet.');
        return;
      }
      ui.line();
      for (const s of list) {
        ui.line(`  ${ui.cyan(s.id)}  ${ui.dim(`${s.turns} turns`)}  ${s.title}`);
      }
      ui.line();
      ui.info('  Resume with: apollo --resume <id>   (or --continue for the latest)');
    },
  },

  save: {
    summary: 'Save this session to .apollo/sessions',
    run({ ui, session, workspace }) {
      const file = session.save();
      ui.success(`Saved to ${path.relative(workspace.root, file)}`);
    },
  },

  undo: {
    summary: 'Revert the last file change Apollo made (/undo <id> for an earlier one)',
    run({ ui, agent, args }) {
      const result = agent.checkpoints.undo(args || undefined);
      ui.success(`Reverted: ${result.label}`);
      for (const file of result.restored) ui.line(`  ${ui.dim('restored')} ${file}`);
      for (const file of result.deleted) ui.line(`  ${ui.dim('deleted')}  ${file}`);
      ui.info('The model still has the old contents in its context — tell it what you reverted.');
    },
  },

  checkpoints: {
    summary: 'List file changes that can be reverted with /undo',
    run({ ui, agent }) {
      const entries = agent.checkpoints.list();
      if (!entries.length) { ui.info('No file changes recorded yet.'); return; }
      ui.line();
      for (const entry of entries) {
        const when = new Date(entry.at).toLocaleTimeString();
        ui.line(`  ${ui.cyan(entry.id)}  ${ui.dim(when)}  ${entry.label}  ${ui.dim(entry.files.join(', '))}`);
      }
      ui.line();
      ui.info('  /undo reverts the most recent; /undo <id> reverts a specific one.');
    },
  },

  diff: {
    summary: 'Show the working-tree diff (git)',
    async run({ ui, registry, agent }) {
      const bash = registry.get('run_bash');
      if (!bash) { ui.error('run_bash is not available in this mode.'); return; }
      const out = await bash.run({ command: 'git --no-pager diff --stat && git --no-pager diff' }, agent.toolContext);
      ui.line(out);
    },
  },

  todos: {
    summary: 'Show the model\'s current task list',
    run({ ui, agent }) {
      const todos = agent.state.todos || [];
      if (!todos.length) { ui.info('No task list yet.'); return; }
      ui.line();
      for (const t of todos) {
        const mark = { pending: ui.dim('[ ]'), in_progress: ui.yellow('[~]'), completed: ui.green('[x]') }[t.status];
        ui.line(`  ${mark} ${t.status === 'completed' ? ui.dim(t.content) : t.content}`);
      }
      ui.line();
    },
  },

  config: {
    summary: 'Show config, or /config save to persist model+provider globally',
    run({ ui, config, args }) {
      if (args === 'save') {
        const file = saveUserConfig({
          provider: config.provider,
          baseUrl: config.baseUrl,
          model: config.model,
          toolMode: config.toolMode,
          contextTokens: config.contextTokens,
        });
        ui.success(`Saved to ${file}`);
        return;
      }
      ui.line();
      for (const [key, value] of Object.entries(config)) {
        if (key === 'apiKey') continue;
        ui.line(`  ${key.padEnd(16)} ${ui.dim(JSON.stringify(value))}`);
      }
      ui.line();
    },
  },

  memory: {
    summary: 'Open (or create) APOLLO.md, the project instructions file',
    run({ ui, workspace }) {
      const file = path.join(workspace.root, 'APOLLO.md');
      if (!fs.existsSync(file)) {
        fs.writeFileSync(file, '# Project instructions for Apollo\n\n- \n');
        ui.success('Created APOLLO.md — add standing instructions there.');
      } else {
        ui.info(`APOLLO.md exists (${fs.readFileSync(file, 'utf8').split('\n').length} lines).`);
      }
      ui.info('It is loaded into the system prompt at the start of every session. /init writes one for you.');
    },
  },

  exit: {
    summary: 'Save and quit',
    run() {
      return { exit: true };
    },
  },
};

/** @returns {null | {exit?: boolean, prompt?: string}} — null when it wasn't a command. */
export async function runCommand(input, ctx) {
  if (!input.startsWith('/')) return null;
  const [name, ...rest] = input.slice(1).trim().split(/\s+/);
  const args = rest.join(' ').trim();

  const key = name.toLowerCase();
  const alias = { quit: 'exit', q: 'exit', cost: 'context', usage: 'context', h: 'help', '?': 'help' }[key] || key;
  const cmd = COMMANDS[alias];

  if (!cmd) {
    ctx.ui.error(`Unknown command /${name}. Try /help.`);
    return {};
  }
  try {
    return (await cmd.run({ ...ctx, args })) || {};
  } catch (err) {
    ctx.ui.error(err.message);
    return {};
  }
}

function renderBar(fraction, width = 20) {
  const filled = Math.min(width, Math.round(fraction * width));
  return '[' + '█'.repeat(filled) + '·'.repeat(width - filled) + ']';
}

function formatBytes(bytes) {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)}GB` : `${(bytes / 1024 ** 2).toFixed(0)}MB`;
}
