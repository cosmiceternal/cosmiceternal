'use strict';

// Polls the sources on an interval. Runs never overlap — a slow scrape delays
// the next tick rather than stacking on top of it — and a failed run is logged
// and retried on the next tick rather than killing the loop.

function createScheduler(deps) {
  const { pipeline, config, log } = deps;
  const intervalMs = Math.max(config.scrapeIntervalMs || 900000, 30000);
  const jitterMs = Math.max(config.scrapeJitterMs || 0, 0);

  let timer = null;
  let running = false;
  let stopped = true;
  let lastRun = null;
  let lastError = null;
  let nextRunAt = null;
  let runCount = 0;

  function delay() {
    // A little jitter keeps repeated deploys from all hitting a site on the
    // same second.
    return intervalMs + Math.floor(Math.random() * jitterMs);
  }

  async function tick(options = {}) {
    if (running) {
      log.debug('skipping tick, previous run still going');
      return null;
    }
    running = true;
    try {
      const summary = await pipeline.runOnce(options);
      lastRun = summary;
      lastError = null;
      runCount += 1;
      return summary;
    } catch (err) {
      lastError = { message: err.message, at: new Date().toISOString() };
      log.error('scrape run failed', { error: err.message });
      return null;
    } finally {
      running = false;
    }
  }

  function schedule() {
    if (stopped) return;
    const wait = delay();
    nextRunAt = new Date(Date.now() + wait).toISOString();
    timer = setTimeout(() => {
      tick().finally(schedule);
    }, wait);
    // Do not hold the process open on the timer alone; the HTTP server is what
    // keeps `serve` alive, and tests must be able to exit.
    if (timer.unref) timer.unref();
  }

  async function start(options = {}) {
    if (!stopped) return;
    stopped = false;
    if (config.scrapeOnStart && options.runNow !== false) await tick(options);
    schedule();
  }

  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    nextRunAt = null;
  }

  function status() {
    return {
      running,
      stopped,
      intervalMs,
      runCount,
      nextRunAt,
      lastError,
      lastRun: lastRun && {
        startedAt: lastRun.startedAt,
        durationMs: lastRun.durationMs,
        scraped: lastRun.scraped,
        kept: lastRun.kept,
        deals: lastRun.deals,
        alertsSent: lastRun.alertsSent,
        warnings: lastRun.warnings.length,
      },
    };
  }

  return { start, stop, tick, status };
}

module.exports = { createScheduler };
