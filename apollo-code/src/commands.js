import fs from 'node:fs';
import path from 'node:path';
import { Session } from './session.js';
import { compact } from './context.js';
import { saveUserConfig } from './config.js';
import { interpolate } from './custom-commands.js';

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
    run({ ui, custom }) {
      const names = [...Object.keys(COMMANDS), ...(custom?.keys() || [])];
      const width = Math.max(...names.map((k) => k.length)) + 2;

      ui.line();
      ui.line(ui.bold('  Commands'));
      for (const [name, cmd] of Object.entries(COMMANDS)) {
        ui.line(`    ${ui.cyan('/' + name.padEnd(width))} ${ui.dim(cmd.summary)}`);
      }

      if (custom?.size) {
        ui.line();
        ui.line(ui.bold('  Project commands'));
        for (const cmd of custom.values()) {
          ui.line(`    ${ui.cyan('/' + cmd.name.padEnd(width))} ${ui.dim(cmd.description)} ${ui.dim(`(${cmd.scope})`)}`);
        }
      }

      ui.line();
      ui.line(ui.dim('  @path attaches a file · !cmd runs a shell command · \\ continues a line'));
      ui.line(ui.dim('  Anything else is sent to the model. Ctrl+C cancels a turn, twice exits.'));
      ui.line();
    },
  },

  model: {
    summary: 'Show or switch the active model: /model qwen2.5-coder:14b',
    async run({ ui, config, args, provider, refresh }) {
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
      // A different model can have a different context window, and the system
      // prompt names the model.
      await refresh?.({ remodel: true });
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
    async run({ ui, config, args, permissions, refresh }) {
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
      // The prompt states the permission rules, so the model has to be told.
      await refresh?.();
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
        const tag = tool.readOnly ? ui.dim('read ') : ui.yellow('write');
        ui.line(`  ${tool.name.padEnd(12)} ${tag}  ${ui.dim(firstSentence(tool.description))}`);
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
      const calibrated = agent.calibration?.ratio;
      const note = calibrated && Math.abs(calibrated - 1) > 0.02
        ? ui.dim(` (calibrated ×${calibrated.toFixed(2)} against this model)`)
        : '';
      ui.line(`  context  ${bar} ${pct}%  ${ui.dim(`~${u.used} / ${u.budget} tokens`)}${note}`);
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

  retry: {
    summary: 'Send your last message again (drops the reply you did not like)',
    run({ ui, session }) {
      // Walk back to the most recent user turn, dropping it and everything the
      // model produced after it.
      let index = -1;
      for (let i = session.messages.length - 1; i >= 0; i--) {
        const message = session.messages[i];
        // A tool-result turn in text mode is also role "user"; skip those.
        if (message.role === 'user' && !String(message.content).startsWith('<apollo:result')) {
          index = i;
          break;
        }
      }
      if (index === -1) {
        ui.info('Nothing to retry yet.');
        return;
      }

      const prompt = session.messages[index].content;
      session.messages = session.messages.slice(0, index);
      ui.info(`Retrying: ${prompt.split('\n')[0].slice(0, 70)}`);
      return { prompt };
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

  resume: {
    summary: 'Switch to a saved session: /resume <id>, or /resume for the latest',
    run({ ui, session, workspace, agent, args }) {
      const loaded = Session.load(workspace.root, args || 'last');
      if (loaded.id === session.id) {
        ui.info('That is already the current session.');
        return;
      }

      // Adopt the saved session in place; the system prompt is rebuilt from the
      // current environment rather than restored, so it stays accurate.
      const system = session.messages.find((m) => m.role === 'system');
      session.id = loaded.id;
      session.createdAt = loaded.createdAt;
      session.usage = loaded.usage;
      session.todos = loaded.todos;
      session.messages = system ? [system, ...loaded.messages] : loaded.messages;
      agent.state.todos = loaded.todos;

      ui.success(`Resumed ${loaded.id} — ${loaded.messages.length} messages.`);
      ui.info(`  ${session.title()}`);
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
    summary: 'Revert file changes: /undo, /undo turn, /undo all, or /undo <id>',
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
        const turn = entry.turn ? ui.dim(`turn ${entry.turn}`) : ui.dim('—');
        ui.line(`  ${ui.cyan(entry.id)}  ${ui.dim(when)}  ${turn}  ${entry.label}  ${ui.dim(entry.files.join(', '))}`);
      }
      ui.line();
      ui.info('  /undo reverts the most recent change · /undo turn the whole last turn · /undo all everything.');
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
    const custom = ctx.custom?.get(key);
    if (custom) return { prompt: interpolate(custom.template, args) };

    const known = [...Object.keys(COMMANDS), ...(ctx.custom?.keys() || [])];
    const near = known.filter((n) => n.startsWith(key.slice(0, 2)));
    ctx.ui.error(`Unknown command /${name}.${near.length ? ` Did you mean ${near.map((n) => '/' + n).join(', ')}?` : ' Try /help.'}`);
    return {};
  }
  try {
    return (await cmd.run({ ...ctx, args })) || {};
  } catch (err) {
    ctx.ui.error(err.message);
    return {};
  }
}

/** First sentence of a description, without splitting on "e.g." or "i.e.". */
function firstSentence(text, max = 78) {
  const match = text.match(/^.*?[.!?](?=\s+[A-Z]|$)/s);
  const sentence = (match ? match[0] : text).replace(/\s+/g, ' ').trim();
  return sentence.length > max ? sentence.slice(0, max - 1) + '…' : sentence;
}

function renderBar(fraction, width = 20) {
  const filled = Math.min(width, Math.round(fraction * width));
  return '[' + '█'.repeat(filled) + '·'.repeat(width - filled) + ']';
}

function formatBytes(bytes) {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)}GB` : `${(bytes / 1024 ** 2).toFixed(0)}MB`;
}
