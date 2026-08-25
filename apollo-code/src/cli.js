import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { loadConfig, userConfigDir, DEFAULTS } from './config.js';
import { Workspace } from './workspace.js';
import { UI } from './ui.js';
import { buildRegistry } from './tools/index.js';
import { createProvider, detectBackends, ProviderError } from './providers/index.js';
import { buildSystemPrompt } from './prompt.js';
import { Permissions, createInteractivePrompt } from './permissions.js';
import { Agent } from './agent.js';
import { Session } from './session.js';
import { runCommand } from './commands.js';
import { CheckpointStore } from './checkpoints.js';

const VERSION = '0.1.0';

const HELP = `apollo — an offline coding agent for your terminal

Usage
  apollo                        start an interactive session in the current directory
  apollo -p "<prompt>"          run one prompt and print the result (non-interactive)
  apollo doctor                 find local model servers and check they work
  apollo models                 list the models your backend has installed
  apollo init                   write an APOLLO.md for this project

Model
  --provider <ollama|openai>    backend dialect (default: ollama)
  --base-url <url>              server address (default: http://127.0.0.1:11434)
  --model <name>                model to use (default: ${DEFAULTS.model})
  --tool-mode <auto|native|text>  how tool calls are made (default: auto)
  --context <n>                 context window in tokens (default: ${DEFAULTS.contextTokens})
  --temperature <n>             sampling temperature (default: ${DEFAULTS.temperature})

Permissions
  --ask                         approve every edit and command (default)
  --auto-edit                   apply file edits without asking; still ask for shell commands
  --yolo                        never ask (use only in a sandbox or a throwaway checkout)
  --read-only                   inspect only; no edits, no commands

Session
  -c, --continue                resume the most recent session in this project
  --resume <id>                 resume a specific session
  --cwd <path>                  workspace root (default: the current directory)
  --no-stream                   wait for the full reply instead of streaming
  --version, --help

Everything is also settable in ~/.apollo/config.json, .apollo/config.json in a
project, or via APOLLO_* environment variables.`;

const FLAG_ALIASES = {
  '--provider': 'provider', '--base-url': 'baseUrl', '--model': 'model',
  '--tool-mode': 'toolMode', '--context': 'contextTokens', '--temperature': 'temperature',
  '--max-tokens': 'maxTokens', '--max-steps': 'maxSteps', '--api-key': 'apiKey',
};

export function parseArgs(argv) {
  const out = { flags: {}, prompt: null, command: null, cwd: process.cwd(), resume: null };
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (FLAG_ALIASES[arg]) {
      out.flags[FLAG_ALIASES[arg]] = argv[++i];
    } else if (arg === '-p' || arg === '--print' || arg === '--prompt') {
      out.prompt = argv[++i];
    } else if (arg === '--cwd') {
      out.cwd = argv[++i];
    } else if (arg === '--resume') {
      out.resume = argv[++i];
    } else if (arg === '-c' || arg === '--continue') {
      out.resume = 'last';
    } else if (arg === '--yolo') {
      out.flags.permissionMode = 'yolo';
    } else if (arg === '--auto-edit') {
      out.flags.permissionMode = 'auto-edit';
    } else if (arg === '--read-only') {
      out.flags.permissionMode = 'read-only';
    } else if (arg === '--ask') {
      out.flags.permissionMode = 'ask';
    } else if (arg === '--no-stream') {
      out.flags.stream = false;
    } else if (arg === '--no-color') {
      out.flags.color = false;
    } else if (arg === '--show-thinking') {
      out.flags.showThinking = true;
    } else if (arg === '--version' || arg === '-v') {
      out.command = 'version';
    } else if (arg === '--help' || arg === '-h') {
      out.command = 'help';
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option ${arg} (try apollo --help)`);
    } else {
      positional.push(arg);
    }
  }

  if (!out.command && positional.length) {
    const first = positional[0].toLowerCase();
    if (['doctor', 'models', 'init'].includes(first)) {
      out.command = first;
    } else if (!out.prompt) {
      // Bare text is a one-shot prompt: apollo "fix the failing test"
      out.prompt = positional.join(' ');
    }
  }
  return out;
}

/** Decide native vs text tool calling, probing the model when set to auto. */
async function resolveToolMode(config, provider, ui) {
  if (config.toolMode !== 'auto') return config.toolMode;
  try {
    const supported = await provider.supportsTools(config.model);
    if (!supported) {
      ui.info(`${config.model} has no native tool calling — using Apollo's text protocol.`);
      return 'text';
    }
    return 'native';
  } catch {
    return 'text';
  }
}

async function setup({ flags, cwd, ui: providedUi }) {
  const config = loadConfig({ cwd, flags });
  const ui = providedUi || new UI({ color: config.color });
  const workspace = new Workspace(cwd);
  const provider = createProvider(config);
  const registry = buildRegistry({ readOnly: config.permissionMode === 'read-only' });
  return { config, ui, workspace, provider, registry };
}

async function assertBackend(config, provider, ui) {
  try {
    await provider.health();
  } catch (err) {
    ui.error(`Cannot reach a model server at ${config.baseUrl}.`);
    ui.line();
    const found = (await detectBackends()).filter((b) => b.available);
    if (found.length) {
      ui.info('  But these are running:');
      for (const b of found) {
        ui.line(`    ${b.label}: apollo --provider ${b.provider} --base-url ${b.baseUrl}`);
      }
    } else {
      ui.info('  Start one first, for example:');
      ui.line('    ollama serve            (then: ollama pull qwen2.5-coder:7b)');
      ui.line('    llama-server -m model.gguf -c 16384 --port 8080');
      ui.line();
      ui.info('  Then run `apollo doctor` to check the connection.');
    }
    ui.line();
    throw new QuietExit(1, err.message);
  }
}

class QuietExit extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

async function commandDoctor(ui) {
  ui.line();
  ui.line(ui.bold('  Looking for local model servers…'));
  ui.line();

  const backends = await detectBackends();
  let any = false;

  for (const backend of backends) {
    const status = backend.available ? ui.green('running') : ui.dim('not found');
    ui.line(`  ${backend.label.padEnd(24)} ${backend.baseUrl.padEnd(24)} ${status}`);
    if (!backend.available) continue;
    any = true;

    if (backend.models.length === 0) {
      ui.line(`    ${ui.yellow('no models installed')}`);
      continue;
    }
    for (const m of backend.models.slice(0, 12)) {
      ui.line(`    ${ui.dim('·')} ${m.id}`);
    }
    if (backend.models.length > 12) ui.line(`    ${ui.dim(`… ${backend.models.length - 12} more`)}`);

    if (backend.provider === 'ollama') {
      const provider = createProvider({ ...backend, apiKey: '' });
      for (const m of backend.models.slice(0, 8)) {
        const native = await provider.supportsTools(m.id);
        ui.line(`    ${ui.dim(m.id.padEnd(30))} tool calling: ${native ? ui.green('native') : ui.yellow('text protocol')}`);
      }
    }
  }

  ui.line();
  if (!any) {
    ui.warn('No local model server found.');
    ui.line();
    ui.line('  Ollama (easiest):');
    ui.line('    curl -fsSL https://ollama.com/install.sh | sh');
    ui.line('    ollama pull qwen2.5-coder:7b');
    ui.line('    ollama serve');
    ui.line();
    ui.line('  llama.cpp:');
    ui.line('    llama-server -m ./model.gguf -c 16384 --port 8080');
    ui.line('    apollo --provider openai --base-url http://127.0.0.1:8080');
    ui.line();
    return 1;
  }

  const best = backends.find((b) => b.available && b.models.length);
  if (best) {
    ui.success(`Ready. Try: apollo --provider ${best.provider} --base-url ${best.baseUrl} --model ${best.models[0].id}`);
    ui.info(`  Persist it with /config save inside a session, or edit ${path.join(userConfigDir(), 'config.json')}`);
  }
  ui.line();
  return 0;
}

/** Build the pieces a turn needs; shared by interactive and headless runs. */
async function createAgent({ config, ui, workspace, provider, registry, session, prompt }) {
  const toolMode = await resolveToolMode(config, provider, ui);
  const permissions = new Permissions({ mode: config.permissionMode, config, ui, prompt });

  const rebuildSystem = (mode) =>
    buildSystemPrompt({ config, workspace, registry, toolMode: mode, userDir: userConfigDir() });

  const agent = new Agent({
    config, provider, workspace, registry, permissions, ui, session, toolMode, rebuildSystem,
    checkpoints: new CheckpointStore({ root: workspace.root }),
  });
  agent.setSystemPrompt(rebuildSystem(toolMode));
  return { agent, permissions, toolMode };
}

async function runHeadless({ config, ui, workspace, provider, registry, promptText, resume }) {
  await assertBackend(config, provider, ui);
  const session = resume ? Session.load(workspace.root, resume) : new Session({ root: workspace.root });
  const { agent } = await createAgent({ config, ui, workspace, provider, registry, session, prompt: null });

  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());

  await agent.run(promptText, { signal: controller.signal });
  ui.flushLine();
  session.save();
  return 0;
}

async function runInteractive({ config, ui, workspace, provider, registry, resume }) {
  await assertBackend(config, provider, ui);

  const session = resume
    ? Session.load(workspace.root, resume)
    : new Session({ root: workspace.root });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    historySize: 200,
  });

  const { agent, permissions, toolMode } = await createAgent({
    config, ui, workspace, provider, registry, session,
    prompt: createInteractivePrompt(rl, ui),
  });

  ui.banner(config);
  if (toolMode === 'text') ui.info(`  Using the text tool protocol (${config.model} has no native tool calling).`);
  if (resume) ui.info(`  Resumed session ${session.id} — ${session.messages.length} messages.`);

  let turnController = null;
  let interruptedOnce = false;

  rl.on('SIGINT', () => {
    if (turnController) {
      turnController.abort();
      ui.flushLine();
      ui.warn('Interrupted.');
      return;
    }
    if (interruptedOnce) {
      ui.line();
      session.save();
      ui.info(`Bye. Session saved: ${path.relative(workspace.root, session.file)}`);
      rl.close();
      process.exit(0);
    }
    interruptedOnce = true;
    ui.flushLine();
    ui.info('Press Ctrl+C again to exit, or type /exit.');
    rl.prompt();
  });

  const commandContext = {
    ui, config, session, workspace, provider, registry, agent, permissions,
    toolMode: () => agent.toolMode,
  };

  for (;;) {
    let input;
    try {
      input = (await rl.question(ui.cyan('\n› '))).trim();
    } catch {
      break; // stdin closed
    }
    if (!input) continue;
    interruptedOnce = false;

    const result = await runCommand(input, commandContext);
    if (result) {
      if (result.exit) break;
      if (!result.prompt) continue;
      input = result.prompt;
    }

    turnController = new AbortController();
    try {
      await agent.run(input, { signal: turnController.signal });
    } catch (err) {
      ui.flushLine();
      ui.error(err.message);
      if (err instanceof ProviderError && err.hint) ui.info('  ' + err.hint);
    } finally {
      turnController = null;
      ui.flushLine();
      session.save();
    }
  }

  rl.close();
  const file = session.save();
  ui.info(`Session saved: ${path.relative(workspace.root, file)}`);
  return 0;
}

export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(err.message + '\n');
    return 2;
  }

  if (args.command === 'help') { process.stdout.write(HELP + '\n'); return 0; }
  if (args.command === 'version') { process.stdout.write(`apollo ${VERSION}\n`); return 0; }

  let ctx;
  try {
    ctx = await setup(args);
  } catch (err) {
    process.stderr.write(`configuration error: ${err.message}\n`);
    return 2;
  }
  const { config, ui, workspace, provider, registry } = ctx;

  if (!fs.existsSync(workspace.root)) {
    ui.error(`no such directory: ${workspace.root}`);
    return 2;
  }

  try {
    if (args.command === 'doctor') return await commandDoctor(ui);

    if (args.command === 'models') {
      await assertBackend(config, provider, ui);
      const models = await provider.listModels();
      for (const m of models) process.stdout.write(m.id + '\n');
      return 0;
    }

    if (args.command === 'init') {
      const { COMMANDS } = await import('./commands.js');
      const { prompt } = COMMANDS.init.run();
      return await runHeadless({ ...ctx, promptText: prompt, resume: args.resume });
    }

    if (args.prompt) {
      return await runHeadless({ ...ctx, promptText: args.prompt, resume: args.resume });
    }

    if (!process.stdin.isTTY) {
      const piped = fs.readFileSync(0, 'utf8').trim();
      if (piped) return await runHeadless({ ...ctx, promptText: piped, resume: args.resume });
    }

    return await runInteractive({ ...ctx, resume: args.resume });
  } catch (err) {
    if (err instanceof QuietExit) return err.code;
    ui.flushLine();
    ui.error(err.message);
    if (err instanceof ProviderError && err.hint) ui.info('  ' + err.hint);
    if (process.env.APOLLO_DEBUG) ui.line(err.stack);
    return 1;
  }
}
