import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../src/agent.js';
import { Workspace } from '../src/workspace.js';
import { UI } from '../src/ui.js';
import { Session } from '../src/session.js';
import { Permissions } from '../src/permissions.js';
import { buildRegistry } from '../src/tools/index.js';
import { createProvider } from '../src/providers/index.js';
import { DEFAULTS } from '../src/config.js';
import { startFakeOllama, captureStream } from './helpers/fake-server.js';

/**
 * The behaviours below are not hypothetical — each one is a documented failure
 * mode of small local models, and each has its own targeted test elsewhere.
 * This exercises them together, because a real 7B session does not fail one way
 * at a time, and the recoveries have to compose.
 */
function harness(baseUrl, { toolMode = 'text' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-scrappy-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/config.js'), 'export const TIMEOUT = 1000;\nexport const RETRIES = 3;\n');

  const config = { ...DEFAULTS, baseUrl, model: 'scrappy:7b', permissionMode: 'yolo', maxSteps: 25 };
  const workspace = new Workspace(root);
  const stream = captureStream();
  const agent = new Agent({
    config, provider: createProvider(config), workspace,
    registry: buildRegistry(),
    permissions: new Permissions({ mode: 'yolo', config }),
    ui: new UI({ color: false, stream }),
    session: new Session({ root: workspace.root }),
    toolMode, rebuildSystem: () => 'system',
  });
  agent.setSystemPrompt('system');
  return { agent, stream, root: workspace.root };
}

test('a model that gets everything wrong on the way still completes the task', async () => {
  const server = await startFakeOllama({
    capabilities: [],
    turns: [
      // 1. Reasoning leaks into the content stream, and the tool block is
      //    wrapped in a markdown fence with a trailing comma in its JSON.
      {
        text: '<think>I should look at the config first. Where is it?</think>'
          + 'Let me look.\n```xml\n<apollo:tool name="glob">\n{"pattern": "**/*.js",}\n</apollo:tool>\n```',
      },
      // 2. Malformed JSON — no recoverable object at all.
      { text: '<apollo:tool name="read_file">{path: src/config.js}</apollo:tool>' },
      // 3. After the correction: the tagged format is abandoned for bare JSON,
      //    with the wrong parameter name.
      { text: '{"name": "read_file", "arguments": {"file_path": "src/config.js"}}' },
      // 4. The same call again, twice, going nowhere.
      { text: '<apollo:tool name="read_file">\n{"path": "src/config.js"}\n</apollo:tool>' },
      { text: '<apollo:tool name="read_file">\n{"path": "src/config.js"}\n</apollo:tool>' },
      // 5. Finally the edit — misnamed parameters again, and an unterminated tag.
      {
        text: '<think>Now I can change it.</think>'
          + '<apollo:tool name="edit_file">\n{"filePath": "src/config.js", "old": "TIMEOUT = 1000", "new": "TIMEOUT = 5000"}',
      },
      // 6. An answer, in markdown.
      { text: '<think>Done.</think>Changed **TIMEOUT** to `5000` in `src/config.js`.' },
    ],
  });

  try {
    const { agent, stream, root } = harness(server.baseUrl);
    const answer = await agent.run('raise the timeout to 5000');

    // The task actually got done.
    const source = fs.readFileSync(path.join(root, 'src/config.js'), 'utf8');
    assert.match(source, /TIMEOUT = 5000/, 'the edit must have landed');
    assert.match(source, /RETRIES = 3/, 'the rest of the file must be intact');

    // The answer is clean prose.
    assert.equal(answer, 'Changed **TIMEOUT** to `5000` in `src/config.js`.');

    // None of the model's mess reached the terminal.
    assert.ok(!stream.text.includes('<think>'), 'reasoning must not be shown');
    assert.ok(!stream.text.includes('should look at the config'), 'nor its contents');
    assert.ok(!stream.text.includes('apollo:tool'), 'the protocol must not be shown');
    assert.ok(!stream.text.includes('**TIMEOUT**'), 'markdown markers are rendered, not printed');

    // Each recovery is visible in the transcript.
    assert.match(stream.text, /read file_path as path/, 'the alias rename');
    assert.ok(agent.session.messages.some((m) => /could not be parsed/.test(m.content || '')), 'the JSON correction');
    assert.ok(agent.session.messages.some((m) => /same tool call/.test(m.content || '')), 'the loop nudge');

    // And the work is undoable despite all of it.
    assert.equal(agent.checkpoints.list().length, 1);
    agent.checkpoints.undo('turn');
    assert.match(fs.readFileSync(path.join(root, 'src/config.js'), 'utf8'), /TIMEOUT = 1000/);
  } finally {
    await server.close();
  }
});

test('a model that never produces a valid call gives up cleanly rather than spinning', async () => {
  const server = await startFakeOllama({
    capabilities: [],
    turns: Array.from({ length: 30 }, () => ({ text: '<apollo:tool name="read_file">{nope</apollo:tool>' })),
  });
  try {
    const { agent, stream } = harness(server.baseUrl);
    await agent.run('read the config');

    const requests = server.requests.filter((r) => r.url === '/api/chat').length;
    assert.ok(requests <= 5, `should give up quickly, made ${requests} requests`);
    assert.match(stream.text, /kept emitting malformed tool calls/);
  } finally {
    await server.close();
  }
});
