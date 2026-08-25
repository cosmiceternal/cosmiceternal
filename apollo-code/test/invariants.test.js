import test from 'node:test';
import assert from 'node:assert/strict';
import { ALL_TOOLS, buildRegistry, toolSchemas } from '../src/tools/index.js';
import { COMMANDS } from '../src/commands.js';
import { DEFAULTS } from '../src/config.js';
import { renderToolInstructions } from '../src/protocol/text-tools.js';

/**
 * Structural rules that hold across the whole tool and command surface. They
 * are cheap to satisfy and expensive to notice the absence of: a mutating tool
 * without affects() is silently un-undoable, and a command without a summary is
 * invisible in /help.
 */

test('every tool declares a usable schema', () => {
  for (const tool of ALL_TOOLS) {
    assert.match(tool.name, /^[a-z][a-z0-9_]*$/, `${tool.name} is not a snake_case identifier`);
    assert.equal(typeof tool.readOnly, 'boolean', `${tool.name} must declare readOnly`);
    assert.ok(tool.description.length > 40, `${tool.name}: the description is too thin to guide a model`);
    assert.equal(typeof tool.run, 'function', `${tool.name} must have run()`);
    assert.equal(tool.parameters.type, 'object', `${tool.name} parameters must be an object schema`);

    for (const [param, schema] of Object.entries(tool.parameters.properties || {})) {
      assert.ok(schema.type, `${tool.name}.${param} has no type`);
      assert.ok(schema.description, `${tool.name}.${param} has no description — the model has to guess`);
    }
    for (const required of tool.parameters.required || []) {
      assert.ok(tool.parameters.properties[required], `${tool.name}.${required} is required but undocumented`);
    }
  }
});

test('every mutating tool can be previewed and undone', () => {
  for (const tool of ALL_TOOLS.filter((t) => !t.readOnly)) {
    assert.equal(typeof tool.preview, 'function',
      `${tool.name} changes something but cannot be previewed — the user would approve blind`);
    if (tool.name === 'run_bash') continue;   // its effects are not knowable in advance
    assert.equal(typeof tool.affects, 'function',
      `${tool.name} changes files but does not declare affects() — /undo could not restore them`);
  }
});

test('tool names are unique and the registry exposes all of them', () => {
  const names = ALL_TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, 'duplicate tool name');
  assert.equal(buildRegistry().size, ALL_TOOLS.length);
  assert.equal(toolSchemas(buildRegistry()).length, ALL_TOOLS.length);
});

test('the text protocol documents every tool the model can call', () => {
  const registry = buildRegistry();
  const instructions = renderToolInstructions(registry);
  for (const tool of registry.values()) {
    assert.ok(instructions.includes(tool.name), `${tool.name} is missing from the text protocol instructions`);
    for (const required of tool.parameters.required || []) {
      assert.ok(
        instructions.includes(`- ${required} (`),
        `${tool.name}.${required} is not described in the text protocol instructions`
      );
    }
  }
});

test('every slash command is complete enough to appear in /help', () => {
  for (const [name, command] of Object.entries(COMMANDS)) {
    assert.match(name, /^[a-z][a-z0-9-]*$/, `/${name} is not a usable command name`);
    assert.ok(command.summary && command.summary.length > 8, `/${name} has no usable summary`);
    assert.equal(typeof command.run, 'function', `/${name} has no run()`);
  }
});

test('the read-only registry is a strict subset with nothing mutating in it', () => {
  const full = buildRegistry();
  const readOnly = buildRegistry({ readOnly: true });
  assert.ok(readOnly.size < full.size);
  for (const [name, tool] of readOnly) {
    assert.equal(tool.readOnly, true, `${name} is in the read-only registry but is not read-only`);
    assert.ok(full.has(name));
  }
});

test('every default setting is a concrete, sane value', () => {
  for (const [key, value] of Object.entries(DEFAULTS)) {
    assert.notEqual(value, undefined, `${key} has no default`);
    assert.notEqual(value, null, `${key} defaults to null`);
    if (typeof value === 'number') assert.ok(Number.isFinite(value), `${key} defaults to a non-finite number`);
  }
  // The reply budget must leave room for a conversation.
  assert.ok(DEFAULTS.maxTokens < DEFAULTS.contextTokens / 2,
    'the default reply budget leaves too little of the window for the conversation');
  assert.ok(DEFAULTS.compactAt > 0 && DEFAULTS.compactAt < 1);
  assert.equal(DEFAULTS.permissionMode, 'ask', 'the safe mode must be the default');
});
