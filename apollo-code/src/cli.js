import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig, userConfigDir, saveUserConfig, DEFAULTS } from './config.js';
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
import { expandReferences, createCompleter, History, classify } from './input.js';
import { COMMANDS } from './commands.js';
import { loadCustomCommands } from './custom-commands.js';
import { runSelftest, SCENARIO_IDS } from './selftest.js';

// Read from the manifest so the version can never drift from package.json.
const VERSION = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')
).version;

const HELP = `apollo — an offline coding agent for your terminal

Usage
  apollo                        start an interactive session in the current directory
  apollo -p "<prompt>"          run one prompt and print the result (non-interactive)
  apollo doctor                 find local model servers and check they work
  apollo models                 list the models your backend has installed
  apollo init                   write an APOLLO.md for this project
  apollo setup                  pick a backend and model, and save them
  apollo selftest               check whether your model can actually drive Apollo

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
  --no-stream                   render the reply when complete, not as it arrives
  --json                        with -p, print one JSON object instead of prose
  --version, --help

In a session
  @path                         attach a file or directory listing to your message
  !command                      run a shell command yourself; output stays in context
  \\ at end of line              continue onto the next line
  Tab                           complete slash commands and @paths
  /help                         list commands, including this project's own

Everything is also settable in ~/.apollo/config.json, .apollo/config.json in a
project, or via APOLLO_* environment variables.`;

const FLAG_ALIASES = {
  '--provider': 'provider', '--base-url': 'baseUrl', '--model': 'model',
  '--tool-mode': 'toolMode', '--context': 'contextTokens', '--temperature': 'temperature',
  '--max-tokens': 'maxTokens', '--max-steps': 'maxSteps', '--api-key': 'apiKey',
};

export function parseArgs(argv) {
  const out = { flags: {}, prompt: null, command: null, cwd: process.cwd(), resume: null, json: false, only: null };
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
    } else if (arg === '--only') {
      out.only = argv[++i];
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
    } else if (arg === '--json') {
      out.json = true;
      out.flags.color = false;
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
    if (['doctor', 'models', 'init', 'setup', 'selftest'].includes(first)) {
      out.command = first;
    } else if (!out.prompt) {
      // Bare text is a one-shot prompt: apollo "fix the failing test"
      out.prompt = positional.join(' ');
    }
  }
  return out;
}

/**
 * Clamp the configured window to what the model can actually do. Only ever
 * downward: the reported maximum is a ceiling, not a recommendation, and
 * raising num_ctx to a 128k ceiling would exhaust VRAM.
 */
async function resolveContextWindow(config, provider, ui) {
  let reported;
  try {
    reported = await provider.contextLength?.(config.model);
  } catch {
    return;
  }
  if (!reported || reported >= config.contextTokens) return;

  ui.warn(`${config.model} supports ${reported} tokens of context, not ${config.contextTokens} — using ${reported}.`);
  config.contextTokens = reported;
  if (config.maxTokens >= reported / 2) {
    config.maxTokens = Math.max(512, Math.floor(reported / 4));
    ui.info(`  Reply budget reduced to ${config.maxTokens} tokens to leave room for the conversation.`);
  }
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
    await assertModelInstalled(config, provider, ui);
  } catch (err) {
    if (err instanceof QuietExit) throw err;
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
  await resolveContextWindow(config, provider, ui);
  const toolMode = await resolveToolMode(config, provider, ui);
  const permissions = new Permissions({ mode: config.permissionMode, config, ui, prompt });

  const rebuildSystem = (mode) =>
    buildSystemPrompt({ config, workspace, registry, toolMode: mode, userDir: userConfigDir() });

  const agent = new Agent({
    config, provider, workspace, registry, permissions, ui, session, toolMode, rebuildSystem,
    checkpoints: new CheckpointStore({ root: workspace.root }),
  });
  agent.setSystemPrompt(rebuildSystem(toolMode));
  return { agent, permissions, toolMode, rebuildSystem };
}

async function runHeadless({ config, ui, workspace, provider, registry, promptText, resume, json }) {
  // In JSON mode stdout carries the result object and nothing else, so both the
  // agent's narration and any setup diagnostics are routed off it.
  const agentUi = json ? new UI({ color: false, stream: nullStream() }) : ui;
  const diagnosticUi = json ? new UI({ color: false, stream: process.stderr }) : ui;

  const emit = (payload) => {
    if (json) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  };

  try {
    await assertBackend(config, provider, diagnosticUi);
  } catch (err) {
    // A script parsing stdout must get a result object even when the backend
    // was never reachable.
    emit({ ok: false, error: err.message || 'model server unreachable', answer: '', model: config.model, provider: config.provider, toolCalls: [], changedFiles: [], usage: null });
    throw err;
  }

  const session = resume ? Session.load(workspace.root, resume) : new Session({ root: workspace.root });
  const { agent, toolMode } = await createAgent({
    config, ui: agentUi, workspace, provider, registry, session, prompt: null,
  });

  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());

  const startedAt = Date.now();
  let answer = '';
  let error = null;
  const prompt = attachReferences(promptText, workspace, agentUi);
  try {
    answer = await agent.run(prompt, { signal: controller.signal });
  } catch (err) {
    if (!json) throw err;
    error = err.message;
  }

  agentUi.flushLine();
  session.save();

  if (json) {
    emit({
      ok: error === null,
      error,
      answer,
      model: config.model,
      provider: config.provider,
      toolMode,
      sessionId: session.id,
      toolCalls: agent.toolLog,
      changedFiles: agent.checkpoints.list(99).flatMap((entry) => entry.files),
      usage: { ...session.usage, durationMs: Date.now() - startedAt },
    });
    return error === null ? 0 : 1;
  }
  return 0;
}

function nullStream() {
  return { isTTY: false, write: () => true };
}

/**
 * A reachable server with the wrong model name is the other common first-run
 * failure, and the error it produces on its own ("model not found") does not
 * say what is available.
 */
async function assertModelInstalled(config, provider, ui) {
  let installed;
  try {
    installed = (await provider.listModels()).map((m) => m.id);
  } catch {
    return; // the server does not enumerate models; let the request speak
  }
  if (installed.length === 0 || installed.includes(config.model)) return;

  // Ollama tags are forgiving: `qwen2.5-coder` should find `qwen2.5-coder:7b`.
  const base = config.model.split(':')[0];
  const near = installed.filter((id) => id.split(':')[0] === base);
  if (near.length === 1) {
    ui.info(`Using ${near[0]} (closest match for "${config.model}").`);
    config.model = near[0];
    return;
  }

  ui.error(`The model "${config.model}" is not installed on ${config.baseUrl}.`);
  ui.line();
  if (near.length) {
    ui.info('  Close matches:');
    for (const id of near) ui.line(`    ${id}`);
  } else {
    ui.info('  Installed:');
    for (const id of installed.slice(0, 12)) ui.line(`    ${id}`);
    if (installed.length > 12) ui.line(`    … ${installed.length - 12} more`);
  }
  ui.line();
  ui.info(`  Pick one with --model, or run \`apollo setup\`.`);
  if (config.provider === 'ollama') ui.info(`  Or install it: ollama pull ${config.model}`);
  ui.line();
  throw new QuietExit(1, `model "${config.model}" is not installed`);
}

/** First-run wizard: find a backend, pick a model, write the global config. */
async function commandSetup(ui) {
  ui.line();
  ui.line(`  ${ui.bold(ui.yellow('APOLLO'))} ${ui.dim('setup')}`);
  ui.line();
  ui.startSpinner('looking for local model servers');
  const backends = (await detectBackends()).filter((b) => b.available && b.models.length);
  ui.stopSpinner();

  if (!backends.length) {
    ui.warn('No local model server with any models installed was found.');
    ui.line();
    ui.line('  Start one, then run `apollo setup` again:');
    ui.line('    ollama serve   +   ollama pull qwen2.5-coder:7b');
    ui.line('    llama-server -m ./model.gguf -c 16384 --port 8080');
    ui.line();
    return 1;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    ui.line(`  ${ui.bold('Backends found')}`);
    backends.forEach((b, i) => {
      ui.line(`    ${ui.cyan(String(i + 1))}  ${b.label.padEnd(22)} ${ui.dim(`${b.models.length} model${b.models.length === 1 ? '' : 's'}`)}`);
    });
    ui.line();
    const backend = backends[await pickIndex(rl, ui, 'Which backend?', backends.length)];

    ui.line();
    ui.line(`  ${ui.bold('Models')}`);
    const models = backend.models.slice(0, 20);
    models.forEach((m, i) => ui.line(`    ${ui.cyan(String(i + 1))}  ${m.id}`));
    ui.line();
    const model = models[await pickIndex(rl, ui, 'Which model?', models.length)];

    const file = saveUserConfig({
      provider: backend.provider,
      baseUrl: backend.baseUrl,
      model: model.id,
    });

    ui.line();
    ui.success(`Saved to ${file}`);
    ui.info(`  provider ${backend.provider} · ${backend.baseUrl} · ${model.id}`);
    ui.line();
    ui.line('  Now: cd into a project and run `apollo`.');
    ui.line();
    return 0;
  } finally {
    rl.close();
  }
}

async function pickIndex(rl, ui, question, count) {
  for (;;) {
    const raw = (await rl.question(`  ${question} ${ui.dim(`[1-${count}, default 1]`)} `)).trim();
    if (raw === '') return 0;
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= count) return n - 1;
    ui.warn(`Enter a number between 1 and ${count}.`);
  }
}

async function runInteractive({ config, ui, workspace, provider, registry, resume }) {
  await assertBackend(config, provider, ui);

  const session = resume
    ? Session.load(workspace.root, resume)
    : new Session({ root: workspace.root });

  const custom = loadCustomCommands({ projectRoot: workspace.root, userDir: userConfigDir() });
  const history = new History();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    historySize: 500,
    history: history.load(),
    completer: createCompleter(workspace, [...Object.keys(COMMANDS), ...custom.keys()]),
  });

  const { agent, permissions, toolMode, rebuildSystem } = await createAgent({
    config, ui, workspace, provider, registry, session,
    prompt: createInteractivePrompt(rl, ui),
  });

  ui.banner(config);
  if (toolMode === 'text') ui.info(`  Using the text tool protocol (${config.model} has no native tool calling).`);
  if (resume) ui.info(`  Resumed session ${session.id} — ${session.messages.length} messages.`);
  if (custom.size) ui.info(`  ${custom.size} project command${custom.size === 1 ? '' : 's'}: ${[...custom.keys()].map((n) => '/' + n).join(' ')}`);

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
    ui, config, session, workspace, provider, registry, agent, permissions, custom,
    toolMode: () => agent.toolMode,
    // Switching model or mode mid-session has to re-derive what depends on it.
    refresh: async ({ remodel = false } = {}) => {
      if (remodel) await resolveContextWindow(config, provider, ui);
      agent.setSystemPrompt(rebuildSystem(agent.toolMode));
    },
  };

  for (;;) {
    let input;
    try {
      input = await readInput(rl, ui);
    } catch {
      break; // stdin closed
    }
    if (input === null) break;
    if (!input) continue;
    interruptedOnce = false;
    history.append(input);

    const { kind, body } = classify(input);

    if (kind === 'shell') {
      await runShellEscape(body, { ui, registry, agent, session });
      continue;
    }

    if (kind === 'command') {
      const result = await runCommand(body, commandContext);
      if (result.exit) break;
      if (!result.prompt) continue;
      input = result.prompt;
    }

    // A project command's arguments can carry @references too — "/review
    // @src/auth.js" should attach the file exactly as typing it would.
    input = attachReferences(input, workspace, ui);

    turnController = new AbortController();
    const startedAt = Date.now();
    const before = { ...session.usage };
    try {
      await agent.run(input, { signal: turnController.signal });
      reportTurnCost(ui, session.usage, before, startedAt);
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

/**
 * Read one logical input. A trailing backslash continues onto the next line, so
 * a multi-line prompt does not need a mouse or a heredoc.
 */
async function readInput(rl, ui) {
  let text = '';
  for (;;) {
    const line = await rl.question(text ? ui.dim('  … ') : ui.cyan('\n› '));
    const { kind, body } = classify(line);
    if (kind === 'continued') {
      text += body + '\n';
      continue;
    }
    return (text + line).trim();
  }
}

/** Resolve @path references and tell the user what was attached. */
function attachReferences(input, workspace, ui) {
  const { text, attached, errors } = expandReferences(input, workspace);
  for (const problem of errors) ui.warn(problem);
  for (const ref of attached) {
    ui.info(`  attached ${ref.path}${ref.lines ? ` (${ref.lines} lines)` : '/'}`);
  }
  return text;
}

/** `!npm test` — run a command directly, and keep the result in context. */
async function runShellEscape(command, { ui, registry, agent, session }) {
  if (!command) {
    ui.info('Usage: !<command>   e.g. !git status');
    return;
  }
  const bash = registry.get('run_bash');
  if (!bash) {
    ui.error('Shell commands are not available in read-only mode.');
    return;
  }
  ui.toolCall('shell', command);
  let output;
  try {
    output = await bash.run({ command }, agent.toolContext);
  } catch (err) {
    output = `Error: ${err.message}`;
  }
  ui.line(output);
  // The model should know what the user just ran; otherwise the next question
  // ("why did that fail?") has no referent.
  session.messages.push({
    role: 'user',
    content: `I ran this command myself:\n\n$ ${command}\n\n${output}`,
  });
  session.messages.push({ role: 'assistant', content: 'Noted.' });
}

/** Local models are slow enough that tokens/second is worth showing. */
function reportTurnCost(ui, usage, before, startedAt) {
  const seconds = (Date.now() - startedAt) / 1000;
  const completion = usage.completionTokens - before.completionTokens;
  if (seconds < 0.5 || completion === 0) return;   // too short to say anything useful
  const parts = [`${seconds.toFixed(1)}s`, `${completion} tokens`];
  if (seconds >= 1) parts.push(`${(completion / seconds).toFixed(1)} tok/s`);
  ui.line(ui.dim('  ' + parts.join(' · ')));
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
    if (args.command === 'setup') return await commandSetup(ui);

    if (args.command === 'selftest') {
      await assertBackend(config, provider, ui);
      const toolMode = await resolveToolMode(config, provider, ui);
      await resolveContextWindow(config, provider, ui);
      const { code, results } = await runSelftest({
        config, provider, toolMode, userDir: userConfigDir(), ui, only: args.only,
      });
      if (args.json) {
        process.stdout.write(JSON.stringify({ model: config.model, toolMode, results }, null, 2) + '\n');
      }
      return code;
    }

    if (args.command === 'models') {
      await assertBackend(config, provider, ui);
      const models = await provider.listModels();
      for (const m of models) process.stdout.write(m.id + '\n');
      return 0;
    }

    if (args.command === 'init') {
      // `apollo init` exists to write one file. Refusing to write it because
      // nobody is at the terminal to approve would make the command useless.
      if (!args.flags.permissionMode) {
        config.permissionMode = 'auto-edit';
        ui.info('Writing APOLLO.md without prompting (apollo init implies --auto-edit).');
      }
      const { prompt } = COMMANDS.init.run();
      return await runHeadless({ ...ctx, promptText: prompt, resume: args.resume, json: args.json });
    }

    if (args.prompt) {
      return await runHeadless({ ...ctx, promptText: args.prompt, resume: args.resume, json: args.json });
    }

    if (!process.stdin.isTTY) {
      const piped = fs.readFileSync(0, 'utf8').trim();
      if (piped) return await runHeadless({ ...ctx, promptText: piped, resume: args.resume, json: args.json });
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
