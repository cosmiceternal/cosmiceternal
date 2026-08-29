'use strict';

// Structured logger. Human-readable lines by default; set LOG_FORMAT=json to
// emit one JSON object per line for shipping into a log aggregator.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function createLogger(options = {}) {
  const level = LEVELS[options.level] ?? LEVELS.info;
  const json = options.format === 'json';
  const scope = options.scope || '';
  const sink = options.sink || process.stdout;

  function emit(name, msg, fields) {
    if (LEVELS[name] < level) return;
    const time = new Date().toISOString();
    if (json) {
      sink.write(JSON.stringify({ time, level: name, scope, msg, ...fields }) + '\n');
      return;
    }
    const tag = scope ? ` [${scope}]` : '';
    let line = `${time} ${name.toUpperCase().padEnd(5)}${tag} ${msg}`;
    if (fields && Object.keys(fields).length) {
      line += ' ' + Object.entries(fields)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' ');
    }
    sink.write(line + '\n');
  }

  const logger = {
    level: options.level || 'info',
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: (childScope) => createLogger({ ...options, scope: scope ? `${scope}:${childScope}` : childScope }),
  };
  return logger;
}

module.exports = { createLogger, LEVELS };
