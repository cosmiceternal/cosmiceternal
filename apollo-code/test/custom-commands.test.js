import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCustomCommands, parseFrontmatter, interpolate } from '../src/custom-commands.js';
import { runCommand } from '../src/commands.js';
import { UI } from '../src/ui.js';
import { captureStream } from './helpers/fake-server.js';

function dirs() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-cc-'));
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-cc-home-'));
  return { projectRoot, userDir };
}

function writeCommand(base, name, body) {
  const dir = path.join(base, 'commands');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), body);
}

test('a markdown file in .apollo/commands becomes a command', () => {
  const { projectRoot, userDir } = dirs();
  writeCommand(path.join(projectRoot, '.apollo'), 'review', 'Review the staged diff for bugs.');
  const commands = loadCustomCommands({ projectRoot, userDir });

  assert.equal(commands.size, 1);
  assert.equal(commands.get('review').template, 'Review the staged diff for bugs.');
  assert.equal(commands.get('review').scope, 'project');
});

test('global commands load too, and a project file of the same name wins', () => {
  const { projectRoot, userDir } = dirs();
  writeCommand(userDir, 'review', 'GLOBAL version');
  writeCommand(userDir, 'changelog', 'Write a changelog entry.');
  writeCommand(path.join(projectRoot, '.apollo'), 'review', 'PROJECT version');

  const commands = loadCustomCommands({ projectRoot, userDir });
  assert.equal(commands.get('review').template, 'PROJECT version');
  assert.equal(commands.get('review').scope, 'project');
  assert.equal(commands.get('changelog').scope, 'global');
});

test('frontmatter supplies the description', () => {
  const { projectRoot, userDir } = dirs();
  writeCommand(path.join(projectRoot, '.apollo'), 'ship',
    '---\ndescription: Run the release checklist\n---\nDo the release steps.');
  const cmd = loadCustomCommands({ projectRoot, userDir }).get('ship');
  assert.equal(cmd.description, 'Run the release checklist');
  assert.equal(cmd.template, 'Do the release steps.');
});

test('without frontmatter the first line becomes the description', () => {
  const { projectRoot, userDir } = dirs();
  writeCommand(path.join(projectRoot, '.apollo'), 'audit', '# Audit dependencies\n\nCheck every dep.');
  assert.equal(loadCustomCommands({ projectRoot, userDir }).get('audit').description, 'Audit dependencies');
});

test('empty and badly named files are skipped', () => {
  const { projectRoot, userDir } = dirs();
  writeCommand(path.join(projectRoot, '.apollo'), 'empty', '   \n');
  writeCommand(path.join(projectRoot, '.apollo'), 'has spaces', 'body');
  writeCommand(path.join(projectRoot, '.apollo'), 'fine', 'body');
  const commands = loadCustomCommands({ projectRoot, userDir });
  assert.deepEqual([...commands.keys()], ['fine']);
});

test('missing directories are not an error', () => {
  const { projectRoot, userDir } = dirs();
  assert.equal(loadCustomCommands({ projectRoot, userDir }).size, 0);
});

test('$ARGUMENTS and positional placeholders interpolate', () => {
  assert.equal(interpolate('Explain $ARGUMENTS in detail.', 'the auth flow'), 'Explain the auth flow in detail.');
  assert.equal(interpolate('Compare $1 with $2.', 'alpha beta'), 'Compare alpha with beta.');
  assert.equal(interpolate('Explain $ARGUMENTS.', ''), 'Explain .');
  assert.equal(interpolate('Missing $3 here.', 'one'), 'Missing  here.');
});

test('a template with no placeholders is passed through', () => {
  assert.equal(interpolate('Just do the thing.', 'ignored'), 'Just do the thing.');
});

test('parseFrontmatter handles a document with none', () => {
  const { meta, body } = parseFrontmatter('no frontmatter here');
  assert.deepEqual(meta, {});
  assert.equal(body, 'no frontmatter here');
});

test('a custom command dispatches as a prompt', async () => {
  const { projectRoot, userDir } = dirs();
  writeCommand(path.join(projectRoot, '.apollo'), 'explain', 'Explain $ARGUMENTS like I am new here.');
  const custom = loadCustomCommands({ projectRoot, userDir });

  const ui = new UI({ color: false, stream: captureStream() });
  const result = await runCommand('/explain the session store', { ui, custom });
  assert.equal(result.prompt, 'Explain the session store like I am new here.');
});

test('a built-in name is not shadowed by a custom command', async () => {
  const { projectRoot, userDir } = dirs();
  writeCommand(path.join(projectRoot, '.apollo'), 'help', 'This should never run.');
  const custom = loadCustomCommands({ projectRoot, userDir });

  const stream = captureStream();
  const ui = new UI({ color: false, stream });
  const result = await runCommand('/help', { ui, custom });
  assert.equal(result.prompt, undefined);
  assert.match(stream.text, /Commands/);
});

test('an unknown command suggests near matches', async () => {
  const stream = captureStream();
  const ui = new UI({ color: false, stream });
  await runCommand('/moddel', { ui, custom: new Map() });
  assert.match(stream.text, /Unknown command \/moddel/);
  assert.match(stream.text, /\/model/);
});

test('/help lists project commands separately', async () => {
  const { projectRoot, userDir } = dirs();
  writeCommand(path.join(projectRoot, '.apollo'), 'review', '---\ndescription: Review the diff\n---\nbody');
  const custom = loadCustomCommands({ projectRoot, userDir });

  const stream = captureStream();
  await runCommand('/help', { ui: new UI({ color: false, stream }), custom });
  assert.match(stream.text, /Project commands/);
  assert.match(stream.text, /\/review\s+Review the diff/);
});
