import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULTS = {
  // Backend
  provider: 'ollama',                     // 'ollama' | 'openai'
  baseUrl: 'http://127.0.0.1:11434',
  model: 'qwen2.5-coder:7b',
  apiKey: '',                             // only for openai-compatible servers that want one

  // Sampling
  temperature: 0.2,
  topP: 0.95,
  maxTokens: 4096,
  contextTokens: 16384,
  keepAlive: '30m',                       // how long Ollama holds the model in VRAM

  // Agent
  toolMode: 'auto',                       // 'auto' | 'native' | 'text'
  permissionMode: 'ask',                  // 'ask' | 'auto-edit' | 'yolo' | 'read-only'
  maxSteps: 40,
  stream: true,
  compactAt: 0.75,                        // fraction of contextTokens that triggers compaction

  // Tools
  bashTimeoutMs: 120000,
  maxOutputChars: 30000,
  allowedCommands: [],                    // regex strings auto-approved in 'ask' mode
  deniedCommands: [],                     // extra regex strings, merged with the built-in deny list

  // UI
  color: true,
  showThinking: false,
};

const PROVIDER_DEFAULT_URLS = {
  ollama: 'http://127.0.0.1:11434',
  openai: 'http://127.0.0.1:8080',
};

const NUMERIC = new Set([
  'temperature', 'topP', 'maxTokens', 'contextTokens', 'maxSteps',
  'bashTimeoutMs', 'maxOutputChars', 'compactAt',
]);
const BOOLEAN = new Set(['stream', 'color', 'showThinking']);

export function userConfigDir() {
  return process.env.APOLLO_HOME || path.join(os.homedir(), '.apollo');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`could not parse ${file}: ${err.message}`);
  }
}

/** APOLLO_MODEL, APOLLO_BASE_URL, APOLLO_TOOL_MODE ... -> { model, baseUrl, toolMode } */
export function envOverrides(env = process.env) {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    const envKey = 'APOLLO_' + key.replace(/[A-Z]/g, (c) => '_' + c).toUpperCase();
    if (env[envKey] !== undefined) out[key] = env[envKey];
  }
  return out;
}

/** Config files and env give strings; coerce them to the shape DEFAULTS declares. */
export function coerce(raw) {
  const out = { ...raw };
  for (const [key, value] of Object.entries(out)) {
    if (NUMERIC.has(key) && typeof value === 'string') {
      const n = Number(value);
      if (Number.isNaN(n)) throw new Error(`${key} must be a number, got ${JSON.stringify(value)}`);
      out[key] = n;
    } else if (BOOLEAN.has(key) && typeof value === 'string') {
      out[key] = !['0', 'false', 'no', 'off', ''].includes(value.toLowerCase());
    } else if ((key === 'allowedCommands' || key === 'deniedCommands') && typeof value === 'string') {
      out[key] = value.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  return out;
}

export function validate(cfg) {
  const errors = [];
  if (!['ollama', 'openai'].includes(cfg.provider)) {
    errors.push(`provider must be "ollama" or "openai", got ${JSON.stringify(cfg.provider)}`);
  }
  if (!['auto', 'native', 'text'].includes(cfg.toolMode)) {
    errors.push(`toolMode must be auto|native|text, got ${JSON.stringify(cfg.toolMode)}`);
  }
  if (!['ask', 'auto-edit', 'yolo', 'read-only'].includes(cfg.permissionMode)) {
    errors.push(`permissionMode must be ask|auto-edit|yolo|read-only, got ${JSON.stringify(cfg.permissionMode)}`);
  }
  if (!cfg.model) errors.push('model is required (set it in config, APOLLO_MODEL, or --model)');
  if (cfg.temperature < 0 || cfg.temperature > 2) errors.push('temperature must be between 0 and 2');
  if (cfg.compactAt <= 0 || cfg.compactAt > 1) errors.push('compactAt must be between 0 and 1');
  if (errors.length) throw new Error('invalid configuration:\n  - ' + errors.join('\n  - '));
  return cfg;
}

/**
 * Layered config, lowest precedence first:
 *   DEFAULTS < ~/.apollo/config.json < <project>/.apollo/config.json < env < CLI flags
 */
export function loadConfig({ cwd = process.cwd(), flags = {}, env = process.env } = {}) {
  const sources = [];
  const global = readJson(path.join(userConfigDir(), 'config.json'));
  if (global) sources.push(global);
  const project = readJson(path.join(cwd, '.apollo', 'config.json'));
  if (project) sources.push(project);
  const local = readJson(path.join(cwd, '.apollo', 'config.local.json'));
  if (local) sources.push(local);
  sources.push(envOverrides(env));
  sources.push(flags);

  let cfg = { ...DEFAULTS };
  let baseUrlWasSet = false;
  for (const src of sources) {
    const clean = coerce(Object.fromEntries(
      Object.entries(src).filter(([, v]) => v !== undefined)
    ));
    if (clean.baseUrl) baseUrlWasSet = true;
    cfg = { ...cfg, ...clean };
  }

  // A provider switch without an explicit baseUrl should follow that provider's
  // conventional port rather than silently keeping Ollama's.
  if (!baseUrlWasSet && PROVIDER_DEFAULT_URLS[cfg.provider]) {
    cfg.baseUrl = PROVIDER_DEFAULT_URLS[cfg.provider];
  }
  cfg.baseUrl = String(cfg.baseUrl).replace(/\/+$/, '');

  return validate(cfg);
}

export function saveUserConfig(patch) {
  const dir = userConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.json');
  const current = readJson(file) || {};
  const next = { ...current, ...patch };
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  return file;
}
