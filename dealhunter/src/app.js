'use strict';

// Composition root: builds the config, store, comps table, HTTP client, source
// registry and pipeline once, so the CLI and the server share exactly the same
// wiring and there is a single place to look for what depends on what.
const path = require('node:path');

const { loadConfig } = require('./config');
const { createLogger } = require('./log');
const { openStore } = require('./store/store');
const { loadComps } = require('./valuation/comps');
const { createHttpClient } = require('./sources/http');
const { loadSources } = require('./sources');
const { createPipeline } = require('./pipeline');
const { ensureDefaultRule } = require('./alerts/rules');

function createApp(options = {}) {
  const config = options.config || loadConfig(options);
  const log = options.log || createLogger({ level: config.logLevel, format: config.logFormat, scope: 'dealhunter' });
  const store = openStore(config.dataDir);

  // User overrides live beside the data, not in the repo, so an update never
  // clobbers your own comps or your repaired source recipes.
  const userCompsFile = path.join(config.dataDir, 'comps.json');
  const userSourceDir = path.join(config.dataDir, 'sources');

  let comps = loadComps({ userFile: userCompsFile });
  const { registry, problems } = loadSources({ userDir: userSourceDir });
  for (const problem of problems) log.warn('ignoring bad source recipe', { problem });

  const http = createHttpClient({
    userAgent: config.userAgent,
    timeoutMs: config.requestTimeoutMs,
    retries: config.requestRetries,
    requestsPerSecond: config.requestsPerSecond,
    respectRobots: config.respectRobots,
    log: log.child('http'),
  });

  const app = {
    config,
    log,
    store,
    registry,
    http,
    userCompsFile,
    userSourceDir,
    get comps() { return comps; },
    reloadComps() {
      comps = loadComps({ userFile: userCompsFile });
      app.pipeline = createPipeline({ config, store, log, http, registry, comps });
      return comps;
    },
  };

  app.pipeline = createPipeline({ config, store, log, http, registry, comps });
  const created = ensureDefaultRule(store, config);
  if (created) log.info('created the starter alert rule', { rule: created.id });

  return app;
}

module.exports = { createApp };
