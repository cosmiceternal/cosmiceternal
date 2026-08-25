import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, coerce, envOverrides, validate, unknownKeys, DEFAULTS } from '../src/config.js';

function project(config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-cfg-'));
  if (config) {
    fs.mkdirSync(path.join(root, '.apollo'), { recursive: true });
    fs.writeFileSync(path.join(root, '.apollo/config.json'), JSON.stringify(config));
  }
  return root;
}

// Keep a stray ~/.apollo/config.json on the test machine out of these results.
const isolatedHome = { APOLLO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-home-')) };

test('defaults apply when nothing is configured', () => {
  const cfg = loadConfig({ cwd: project(), env: isolatedHome });
  assert.equal(cfg.provider, DEFAULTS.provider);
  assert.equal(cfg.permissionMode, 'ask');
});

test('project config overrides defaults', () => {
  const cfg = loadConfig({ cwd: project({ model: 'from-project', maxSteps: 5 }), env: isolatedHome });
  assert.equal(cfg.model, 'from-project');
  assert.equal(cfg.maxSteps, 5);
});

test('env beats project config, and flags beat env', () => {
  const cwd = project({ model: 'from-project' });
  const env = { ...isolatedHome, APOLLO_MODEL: 'from-env' };
  assert.equal(loadConfig({ cwd, env }).model, 'from-env');
  assert.equal(loadConfig({ cwd, env, flags: { model: 'from-flag' } }).model, 'from-flag');
});

test('local config overrides shared project config', () => {
  const cwd = project({ model: 'shared' });
  fs.writeFileSync(path.join(cwd, '.apollo/config.local.json'), JSON.stringify({ model: 'mine' }));
  assert.equal(loadConfig({ cwd, env: isolatedHome }).model, 'mine');
});

test('switching provider without a base url follows that provider default port', () => {
  const cwd = project();
  assert.equal(loadConfig({ cwd, env: isolatedHome }).baseUrl, 'http://127.0.0.1:11434');
  assert.equal(loadConfig({ cwd, env: isolatedHome, flags: { provider: 'openai' } }).baseUrl, 'http://127.0.0.1:8080');
});

test('an explicit base url survives a provider switch', () => {
  const cfg = loadConfig({
    cwd: project(),
    env: isolatedHome,
    flags: { provider: 'openai', baseUrl: 'http://127.0.0.1:9999' },
  });
  assert.equal(cfg.baseUrl, 'http://127.0.0.1:9999');
});

test('trailing slashes are trimmed from the base url', () => {
  const cfg = loadConfig({ cwd: project(), env: isolatedHome, flags: { baseUrl: 'http://127.0.0.1:11434///' } });
  assert.equal(cfg.baseUrl, 'http://127.0.0.1:11434');
});

test('string values from env are coerced to their real types', () => {
  const cfg = coerce({ contextTokens: '32768', temperature: '0.7', stream: 'false', deniedCommands: 'a,b' });
  assert.equal(cfg.contextTokens, 32768);
  assert.equal(cfg.temperature, 0.7);
  assert.equal(cfg.stream, false);
  assert.deepEqual(cfg.deniedCommands, ['a', 'b']);
});

test('envOverrides maps APOLLO_* names to config keys', () => {
  const out = envOverrides({ APOLLO_BASE_URL: 'http://x', APOLLO_TOOL_MODE: 'text', UNRELATED: '1' });
  assert.deepEqual(out, { baseUrl: 'http://x', toolMode: 'text' });
});

test('invalid values are rejected with a readable message', () => {
  assert.throws(() => validate({ ...DEFAULTS, provider: 'anthropic' }), /provider must be/);
  assert.throws(() => validate({ ...DEFAULTS, toolMode: 'psychic' }), /toolMode must be/);
  assert.throws(() => validate({ ...DEFAULTS, permissionMode: 'chaos' }), /permissionMode must be/);
  assert.throws(() => validate({ ...DEFAULTS, model: '' }), /model is required/);
  assert.throws(() => validate({ ...DEFAULTS, temperature: 9 }), /temperature must be/);
});

test('a malformed config file names the file it could not parse', () => {
  const root = project();
  fs.mkdirSync(path.join(root, '.apollo'), { recursive: true });
  fs.writeFileSync(path.join(root, '.apollo/config.json'), '{ not json');
  assert.throws(() => loadConfig({ cwd: root, env: isolatedHome }), /could not parse .*config\.json/);
});

test('an unknown setting is reported with the key it probably meant', () => {
  const cwd = project({ modle: 'typo:7b', temprature: 0.5, contextTokens: 8192 });
  const cfg = loadConfig({ cwd, env: isolatedHome });

  const warnings = cfg.warnings.join('\n');
  assert.match(warnings, /unknown setting "modle" — did you mean "model"\?/);
  assert.match(warnings, /unknown setting "temprature" — did you mean "temperature"\?/);
  assert.ok(!warnings.includes('contextTokens'), 'valid keys are not warned about');
  assert.equal(cfg.contextTokens, 8192, 'the valid settings still apply');
});

test('a key with no plausible match is reported without a suggestion', () => {
  const cwd = project({ zzzzqqq: 1 });
  const warnings = loadConfig({ cwd, env: isolatedHome }).warnings;
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unknown setting "zzzzqqq"$/);
});

test('the warning names which file the bad key came from', () => {
  const cwd = project({ modle: 'x' });
  fs.writeFileSync(path.join(cwd, '.apollo/config.local.json'), JSON.stringify({ bassUrl: 'y' }));
  const warnings = loadConfig({ cwd, env: isolatedHome }).warnings.join('\n');
  assert.match(warnings, /\.apollo\/config\.json: unknown setting "modle"/);
  assert.match(warnings, /\.apollo\/config\.local\.json: unknown setting "bassUrl" — did you mean "baseUrl"\?/);
});

test('a clean config produces no warnings', () => {
  const cfg = loadConfig({ cwd: project({ model: 'x', temperature: 0.3 }), env: isolatedHome });
  assert.deepEqual(cfg.warnings, []);
});

test('warnings are non-enumerable so they never leak into a saved config', () => {
  const cfg = loadConfig({ cwd: project({ nonsense: 1 }), env: isolatedHome });
  assert.ok(!Object.keys(cfg).includes('warnings'));
  assert.ok(!JSON.stringify(cfg).includes('warnings'));
});

test('unknownKeys is exact about what it flags', () => {
  assert.deepEqual(unknownKeys({ model: 'x', provider: 'ollama' }), []);
  assert.deepEqual(unknownKeys({ modl: 'x' }), [{ key: 'modl', suggestion: 'model' }]);
});
