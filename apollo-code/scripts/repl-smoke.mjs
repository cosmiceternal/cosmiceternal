/**
 * Interactive smoke test: drives the real REPL through a pty against a scripted
 * fake model server, then asserts on what a user would have seen.
 *
 *   node scripts/repl-smoke.mjs
 *
 * Needs util-linux `script` for the pty, so it is not part of `npm test`
 * (which must run anywhere, with no TTY). Everything else is covered there.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeOllama } from '../test/helpers/fake-server.js';

const BIN = fileURLToPath(new URL('../bin/apollo.js', import.meta.url));

try {
  execFileSync('script', ['--version'], { stdio: 'ignore' });
} catch {
  console.error('skipped: util-linux `script` is not available to allocate a pty');
  process.exit(0);
}

const server = await startFakeOllama({
  turns: [
    { text: 'Hello — this is a fake local model.' },
    { text: 'Reading now. ', toolCalls: [{ name: 'read_file', args: { path: 'demo.js' } }] },
    { text: 'It exports **answer**, which is `42`.\n\n```js\nexport const answer = 42;\n```\n' },
    { text: 'I can see the file you attached.' },
    { text: 'Hello, world!' },
  ],
});

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-repl-'));
fs.writeFileSync(path.join(cwd, 'demo.js'), 'export const answer = 42;\n');
fs.mkdirSync(path.join(cwd, '.apollo/commands'), { recursive: true });
fs.writeFileSync(path.join(cwd, '.apollo/commands/greet.md'),
  '---\ndescription: Say hello to someone\n---\nSay hello to $ARGUMENTS.\n');

const child = spawn('script', [
  '-qec',
  `node ${BIN} --cwd ${cwd} --base-url ${server.baseUrl} --model fake-coder:7b`,
  '/dev/null',
], { env: { ...process.env, APOLLO_HOME: cwd, TERM: 'xterm' }, stdio: ['pipe', 'pipe', 'inherit'] });

let raw = '';
child.stdout.on('data', (d) => { raw += d.toString(); });

const script = [
  [700, 'hello there'],
  [1400, '/tools'],
  [2100, 'what does demo.js export?'],
  [3400, '!echo shell-escape-works'],
  [4100, 'explain @demo.js'],
  [5000, '/greet world'],
  [5900, '/checkpoints'],
  [6500, '/context'],
  [7100, '/exit'],
];
for (const [delay, line] of script) setTimeout(() => child.stdin.write(line + '\n'), delay);

await new Promise((resolve) => child.on('close', resolve));
await server.close();

process.stdout.write(raw.replace(/\r/g, ''));

const plain = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '');
const checks = {
  'banner rendered': /APOLLO/.test(plain),
  'reply streamed to the terminal': /fake local model/.test(plain),
  '/tools listed the tool registry': /read_file/.test(plain) && /run_bash/.test(plain),
  'tool call rendered': /● read_file\(demo\.js\)/.test(plain),
  'tool result rendered': /⎿ 2 lines/.test(plain),
  'answered using the tool result': /42/.test(plain),
  'markdown markers consumed, not printed': /answer, which is 42/.test(plain) && !/\*\*answer\*\*/.test(plain),
  'code fence rendered as a block': /┌─ js/.test(plain) && /│ export const answer/.test(plain),
  'shell escape ran the command': /shell-escape-works/.test(plain),
  '@reference attached the file': /attached demo\.js \(2 lines\)/.test(plain),
  'protocol never leaked to the terminal': !/apollo:tool/.test(plain),
  // The fake server answers instantly, so a sub-second turn must stay quiet
  // rather than reporting an absurd tokens/second figure.
  'no bogus rate on an instant turn': !/\d{3,}\.\d tok\/s/.test(plain),
  '/context reported usage': /context {2}\[/.test(plain) && /tokens/.test(plain),
  'project commands announced at startup': /1 project command: \/greet/.test(plain),
  'project command ran as a prompt': /Hello, world!/.test(plain),
  'session saved on exit': /Session saved/.test(plain),
};

console.log('\n===== assertions =====');
for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
