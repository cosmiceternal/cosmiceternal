import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from './workspace.js';
import { UI } from './ui.js';
import { Agent } from './agent.js';
import { Session } from './session.js';
import { Permissions } from './permissions.js';
import { buildRegistry } from './tools/index.js';
import { buildSystemPrompt } from './prompt.js';
import { CheckpointStore } from './checkpoints.js';

/**
 * Can this model actually drive an agent?
 *
 * Local models vary enormously at tool use — far more than at writing code —
 * and the only way to know is to try. Each scenario is a small, unambiguous
 * task in a throwaway workspace, checked against the filesystem rather than
 * against what the model claims it did.
 */

const FIXTURE = {
  'package.json': JSON.stringify({ name: 'widget', version: '1.4.2' }, null, 2) + '\n',
  'src/index.js': [
    "import { format } from './format.js';",
    '',
    'export const MAX_RETRIES = 3;',
    '',
    'export function greet(name) {',
    '  return format(`Hello, ${name}`);',
    '}',
    '',
  ].join('\n'),
  'src/format.js': [
    'export function format(text) {',
    '  return text.trim();',
    '}',
    '',
  ].join('\n'),
  'README.md': '# widget\n\nA small library.\n',
};

const SCENARIOS = [
  {
    id: 'read',
    title: 'Read a file and answer from it',
    prompt: 'What is the value of MAX_RETRIES in src/index.js? Reply with just the number.',
    check: ({ answer, tools }) => {
      if (!tools.includes('read_file') && !tools.includes('grep')) {
        return fail('answered without looking at the file');
      }
      return /\b3\b/.test(answer) ? pass() : fail(`expected 3, got: ${short(answer)}`);
    },
  },
  {
    id: 'search',
    title: 'Find which file defines a symbol',
    prompt: 'Which file defines the function `format`? Reply with just the path.',
    check: ({ answer }) => (/format\.js/.test(answer) ? pass() : fail(`expected src/format.js, got: ${short(answer)}`)),
  },
  {
    id: 'edit',
    title: 'Make a precise edit to an existing file',
    prompt: 'Change MAX_RETRIES in src/index.js from 3 to 5. Change nothing else.',
    check: ({ read }) => {
      const source = read('src/index.js');
      if (!/MAX_RETRIES = 5/.test(source)) return fail('MAX_RETRIES was not set to 5');
      if (!/export function greet/.test(source)) return fail('the rest of the file was damaged');
      return pass();
    },
  },
  {
    id: 'create',
    title: 'Create a new file',
    prompt: 'Create src/math.js exporting a function `double(n)` that returns n * 2. Nothing else.',
    check: ({ read, exists }) => {
      if (!exists('src/math.js')) return fail('src/math.js was not created');
      const source = read('src/math.js');
      return /double/.test(source) && /\*\s*2|2\s*\*/.test(source)
        ? pass()
        : fail('the file does not contain a plausible double()');
    },
  },
  {
    id: 'bash',
    title: 'Run a command and use its output',
    prompt: 'Run `node -e "console.log(6*7)"` and tell me what it printed. Reply with just the number.',
    check: ({ answer, tools }) => {
      if (!tools.includes('run_bash')) return fail('did not use run_bash');
      return /\b42\b/.test(answer) ? pass() : fail(`expected 42, got: ${short(answer)}`);
    },
  },
  {
    id: 'multistep',
    title: 'Two related changes in one turn',
    prompt:
      'In package.json, bump the version from 1.4.2 to 1.5.0. Then add a line to README.md '
      + 'that reads exactly: Version 1.5.0. Do both.',
    check: ({ read }) => {
      const manifest = read('package.json');
      const readme = read('README.md');
      const problems = [];
      if (!/1\.5\.0/.test(manifest)) problems.push('package.json was not bumped');
      if (!/Version 1\.5\.0/.test(readme)) problems.push('README.md was not updated');
      try {
        JSON.parse(manifest);
      } catch {
        problems.push('package.json is no longer valid JSON');
      }
      return problems.length ? fail(problems.join('; ')) : pass();
    },
  },
];

const pass = () => ({ ok: true });
const fail = (why) => ({ ok: false, why });
const short = (text) => String(text).replace(/\s+/g, ' ').trim().slice(0, 80) || '(nothing)';

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-selftest-'));
  for (const [rel, body] of Object.entries(FIXTURE)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  return root;
}

async function runScenario(scenario, { config, provider, toolMode, userDir }) {
  const root = makeFixture();
  const workspace = new Workspace(root);
  const registry = buildRegistry();
  const ui = new UI({ color: false, stream: { isTTY: false, write: () => true } });

  const rebuildSystem = (mode) => buildSystemPrompt({ config, workspace, registry, toolMode: mode, userDir });
  const agent = new Agent({
    config: { ...config, maxSteps: 12 },
    provider,
    workspace,
    registry,
    permissions: new Permissions({ mode: 'yolo', config }),
    ui,
    session: new Session({ root }),
    toolMode,
    rebuildSystem,
    checkpoints: new CheckpointStore({ root }),
  });
  agent.setSystemPrompt(rebuildSystem(toolMode));

  const startedAt = Date.now();
  let answer = '';
  let crash = null;
  try {
    answer = await agent.run(scenario.prompt);
  } catch (err) {
    crash = err.message;
  }

  const result = crash
    ? fail(`the request failed: ${crash}`)
    : scenario.check({
      answer,
      tools: agent.toolLog.map((t) => t.name),
      read: (rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return ''; } },
      exists: (rel) => fs.existsSync(path.join(root, rel)),
    });

  return {
    ...result,
    id: scenario.id,
    title: scenario.title,
    seconds: (Date.now() - startedAt) / 1000,
    steps: agent.toolLog.length,
    toolErrors: agent.toolLog.filter((t) => !t.ok).length,
    tokens: agent.session.usage.completionTokens,
  };
}

export async function runSelftest({ config, provider, toolMode, userDir, ui, only }) {
  const scenarios = only ? SCENARIOS.filter((s) => s.id === only) : SCENARIOS;
  if (!scenarios.length) {
    ui.error(`No such scenario "${only}". Available: ${SCENARIOS.map((s) => s.id).join(', ')}`);
    return { code: 2, results: [] };
  }

  ui.line();
  ui.line(`  ${ui.bold('Apollo self-test')} ${ui.dim(`· ${config.model} · ${toolMode} tool calling`)}`);
  ui.line(`  ${ui.dim('Each task runs in a throwaway workspace and is checked against the files, not the reply.')}`);
  ui.line();

  const results = [];
  for (const scenario of scenarios) {
    ui.startSpinner(`${scenario.id}: ${scenario.title}`);
    const result = await runScenario(scenario, { config, provider, toolMode, userDir });
    ui.stopSpinner();
    results.push(result);

    const mark = result.ok ? ui.green('✓') : ui.red('✗');
    const stats = ui.dim(`${result.seconds.toFixed(1)}s · ${result.steps} tool call${result.steps === 1 ? '' : 's'}`);
    ui.line(`  ${mark} ${scenario.title.padEnd(38)} ${stats}`);
    if (!result.ok) ui.line(`      ${ui.red(result.why)}`);
    else if (result.toolErrors) ui.line(`      ${ui.dim(`${result.toolErrors} tool call(s) failed on the way`)}`);
  }

  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  const seconds = results.reduce((sum, r) => sum + r.seconds, 0);

  ui.line();
  ui.line(`  ${ui.bold(`${passed}/${total}`)} passed in ${seconds.toFixed(0)}s`);
  ui.line(`  ${verdict(ui, passed, total, results)}`);
  ui.line();

  return { code: passed === total ? 0 : 1, results };
}

function verdict(ui, passed, total, results) {
  const fraction = total ? passed / total : 0;
  const slow = results.length && results.reduce((s, r) => s + r.seconds, 0) / results.length > 60;

  if (fraction === 1) {
    return ui.green('This model drives Apollo well.') + (slow ? ui.dim(' It is slow, though — a smaller quant may be worth trying.') : '');
  }
  if (fraction >= 0.6) {
    return ui.yellow('Usable, with supervision.') + ui.dim(' Keep permission mode at "ask" and give it narrower instructions.');
  }
  const editFailed = results.some((r) => !r.ok && (r.id === 'edit' || r.id === 'multistep'));
  return ui.red('This model struggles to drive an agent.')
    + ui.dim(editFailed
      ? ' Exact-match editing is where it broke — try a larger coder model, or --tool-mode text if it lacks native tools.'
      : ' Try a dedicated coder model such as qwen2.5-coder.');
}

export const SCENARIO_IDS = SCENARIOS.map((s) => s.id);
