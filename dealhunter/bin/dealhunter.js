#!/usr/bin/env node
'use strict';

// Command line for the aggregator. Everything the dashboard can do is available
// here too, because half the point of a deal hunter is running it from cron on
// a box with no browser.
const path = require('node:path');
const fs = require('node:fs');

const { createApp } = require('../src/app');
const { createScheduler } = require('../src/scheduler');
const { startServer } = require('../src/server');
const { queryLots, summarize } = require('../src/query');
const { listRules, saveRule, deleteRule } = require('../src/alerts/rules');
const { importComps } = require('../src/valuation/comps');
const { dispatch, money, pct, timeLeft } = require('../src/alerts/notify');

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    if (body.includes('=')) {
      const [key, ...rest] = body.split('=');
      flags[camel(key)] = rest.join('=');
    } else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
      flags[camel(body)] = argv[i + 1];
      i += 1;
    } else {
      flags[camel(body.replace(/^no-/, ''))] = !body.startsWith('no-');
    }
  }
  return { positional, flags };
}

function camel(value) {
  return value.replace(/-([a-z])/g, (m, c) => c.toUpperCase());
}

function pad(value, width, right = false) {
  const text = String(value);
  if (text.length >= width) return text.slice(0, width);
  return right ? text.padStart(width) : text.padEnd(width);
}

function printLotTable(lots, { showUrl = false } = {}) {
  if (!lots.length) {
    console.log('No lots match those filters.');
    return;
  }
  console.log([
    pad('SCORE', 6, true), pad('PROFIT', 11, true), pad('MARGIN', 7, true), pad('ROI', 7, true),
    pad('BID', 10, true), pad('MAX BID', 10, true), pad('CONF', 5, true), pad('CLOSES', 9, true), ' TITLE',
  ].join(' '));
  for (const lot of lots) {
    const deal = lot.deal || {};
    const valuation = lot.valuation || {};
    console.log([
      pad(deal.score ?? 0, 6, true),
      pad(money(deal.profit ?? 0, lot.currency), 11, true),
      pad(pct(deal.marginPct ?? 0), 7, true),
      pad(pct(deal.roi ?? 0), 7, true),
      pad(money(lot.currentBid, lot.currency), 10, true),
      pad(money(deal.maxBid ?? 0, lot.currency), 10, true),
      pad(pct(valuation.confidence ?? 0), 5, true),
      pad(timeLeft(deal.hoursToClose), 9, true),
      ` ${lot.title.slice(0, 58)}`,
    ].join(' '));
    if (showUrl && lot.url) console.log(`${' '.repeat(68)} ${lot.url}`);
  }
}

function filtersFromFlags(flags) {
  return {
    q: flags.q || flags.search,
    source: flags.source,
    category: flags.category,
    condition: flags.condition,
    state: flags.state,
    minMargin: flags.minMargin,
    minProfit: flags.minProfit,
    minRoi: flags.minRoi,
    minConfidence: flags.minConfidence,
    minScore: flags.minScore,
    maxBid: flags.maxBid,
    closingWithin: flags.closingWithin,
    dealsOnly: flags.all ? '' : '1',
    includeClosed: flags.includeClosed,
    sort: flags.sort,
    limit: flags.limit || 40,
    offset: flags.offset,
  };
}

const HELP = `dealhunter — surface underpriced GovDeals and ITAD auction lots

Usage: dealhunter <command> [options]

Commands:
  serve                    Run the dashboard and the polling scheduler
  scrape                   Run one scrape/value/alert cycle now
  demo                     Scrape the bundled sample lots and print the board
  lots                     List tracked lots, best deals first
  lot <id>                 Show one lot with its full valuation breakdown
  sources                  List available sources and whether they are enabled
  rules [add|rm|enable|disable]
                           Manage alert rules
  alerts                   Show recently sent alerts
  runs                     Show recent scrape runs
  comps import <file>      Merge your own comps (JSON or CSV) into the table
  comps list               Show the comps table
  revalue                  Re-price every stored lot after a comps/cost change
  test-notify <ruleId>     Send the top deal through a rule's channels

Common options:
  --source a,b             Restrict to these source ids
  --query "dell laptop"    Keyword passed to the source search
  --category laptops       Filter by category
  --min-margin 40          Minimum margin (accepts 40 or 0.4)
  --min-profit 250         Minimum profit in currency units
  --closing-within 24      Only lots closing within N hours
  --sort score|profit|margin|roi|closing|bid|newest
  --limit 40               Rows to show
  --all                    Include lots that are not profitable
  --json                   Machine-readable output
  --dry-run                Scrape and value, but do not deliver alerts

Configuration lives in dealhunter.config.json or the environment; see
.env.example. Data is written to ${'$DEALHUNTER_DATA_DIR'} (default ./var).`;

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0] || 'help';

  if (command === 'help' || flags.help) {
    console.log(HELP);
    return 0;
  }

  const app = createApp({
    overrides: flags.dataDir ? { dataDir: flags.dataDir } : {},
  });
  const { store, config, pipeline } = app;

  switch (command) {
    case 'serve': {
      const scheduler = createScheduler({ pipeline, config, log: app.log });
      app.scheduler = scheduler;
      const server = await startServer(app);
      await scheduler.start();
      const shutdown = () => {
        app.log.info('shutting down');
        scheduler.stop();
        server.close(() => process.exit(0));
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      return null; // keep running
    }

    case 'scrape':
    case 'demo': {
      const summary = await pipeline.runOnce({
        sourceIds: command === 'demo' ? ['sample'] : (flags.source ? String(flags.source).split(',') : undefined),
        query: flags.query,
        dryRun: Boolean(flags.dryRun),
        skipAlerts: flags.alerts === false,
      });
      if (flags.json) {
        console.log(JSON.stringify(summary, null, 2));
      } else {
        console.log(`Scraped ${summary.scraped} listings from ${summary.sources.length} source(s) in ${summary.durationMs}ms`);
        console.log(`  kept ${summary.kept} (${summary.added} new, ${summary.updated} updated), filtered ${summary.filtered}, invalid ${summary.invalid}`);
        console.log(`  ${summary.deals} profitable, ${summary.alertsSent} alert(s) sent, ${summary.alertsSuppressed} suppressed`);
        for (const warning of summary.warnings) console.log(`  ! ${warning}`);
        if (command === 'demo') {
          console.log('');
          printLotTable(queryLots(store.collection('lots').all(), { dealsOnly: '1', limit: 20 }).lots);
        }
      }
      return 0;
    }

    case 'lots': {
      const result = queryLots(store.collection('lots').all(), filtersFromFlags(flags));
      if (flags.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        printLotTable(result.lots, { showUrl: Boolean(flags.urls) });
        console.log(`\n${result.lots.length} of ${result.total} matching lots`);
      }
      return 0;
    }

    case 'lot': {
      const id = positional[1];
      if (!id) {
        console.error('usage: dealhunter lot <id>');
        return 1;
      }
      const lot = store.collection('lots').get(id);
      if (!lot) {
        console.error(`no lot with id ${id}`);
        return 1;
      }
      if (flags.json) {
        console.log(JSON.stringify(lot, null, 2));
        return 0;
      }
      printLotDetail(lot);
      return 0;
    }

    case 'sources': {
      const rows = Array.from(app.registry.values());
      if (flags.json) {
        console.log(JSON.stringify(rows.map((s) => ({
          id: s.id, label: s.label, kind: s.kind, enabled: config.sources.includes(s.id), verified: Boolean(s.verified),
        })), null, 2));
        return 0;
      }
      for (const source of rows) {
        const state = config.sources.includes(source.id) ? 'enabled ' : 'disabled';
        const verified = source.offline ? 'offline ' : (source.verified ? 'verified' : 'UNVERIFIED');
        console.log(`${pad(source.id, 16)} ${state}  ${verified}  ${source.label}`);
        for (const note of source.notes || []) console.log(`${' '.repeat(18)}· ${note}`);
      }
      console.log(`\nEnable with SOURCES=${rows.map((s) => s.id).slice(0, 2).join(',')} or "sources" in dealhunter.config.json`);
      return 0;
    }

    case 'rules': return rulesCommand(app, positional.slice(1), flags);
    case 'alerts': {
      const limit = Number(flags.limit) || 25;
      const alerts = store.collection('alerts').all()
        .sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt)).slice(0, limit);
      if (flags.json) {
        console.log(JSON.stringify(alerts, null, 2));
        return 0;
      }
      if (!alerts.length) console.log('No alerts sent yet.');
      for (const alert of alerts) {
        const failed = (alert.deliveries || []).filter((d) => !d.ok);
        console.log(`${alert.sentAt}  ${pad(alert.ruleName, 28)} ${pad(money(alert.profit), 10, true)} ${pad(pct(alert.marginPct), 6, true)}  ${alert.title.slice(0, 50)}`);
        if (failed.length) console.log(`  ! delivery failed: ${failed.map((d) => `${d.channel} (${d.error || d.status})`).join(', ')}`);
      }
      return 0;
    }

    case 'runs': {
      const runs = store.collection('runs').all()
        .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt)).slice(0, Number(flags.limit) || 15);
      if (flags.json) {
        console.log(JSON.stringify(runs, null, 2));
        return 0;
      }
      for (const run of runs) {
        console.log(`${run.startedAt}  ${pad(`${run.durationMs}ms`, 8, true)}  scraped ${pad(run.scraped, 4, true)}  kept ${pad(run.kept, 4, true)}  deals ${pad(run.deals, 4, true)}  alerts ${pad(run.alertsSent, 3, true)}  warnings ${run.warnings.length}`);
      }
      return 0;
    }

    case 'comps': return compsCommand(app, positional.slice(1), flags);
    case 'revalue': {
      app.reloadComps();
      const count = app.pipeline.revalueAll();
      console.log(`Re-priced ${count} lots against the current comps and cost model.`);
      return 0;
    }

    case 'stats': {
      const stats = summarize(store.collection('lots').all());
      console.log(JSON.stringify(stats, null, 2));
      return 0;
    }

    case 'test-notify': {
      const ruleId = positional[1];
      const rule = store.collection('rules').get(ruleId || 'default');
      if (!rule) {
        console.error(`no rule with id ${ruleId}. Run "dealhunter rules" to list them.`);
        return 1;
      }
      const best = queryLots(store.collection('lots').all(), { dealsOnly: '1', limit: 1 }).lots[0];
      if (!best) {
        console.error('no profitable lot to send — run "dealhunter demo" first.');
        return 1;
      }
      const results = await dispatch(rule, { lot: best, valuation: best.valuation, deal: best.deal }, 'manual test', {
        log: app.log, dataDir: config.dataDir, timeoutMs: config.notifyTimeoutMs,
      });
      for (const result of results) {
        console.log(`${result.ok ? 'ok  ' : 'FAIL'} ${result.channel}${result.error ? ` — ${result.error}` : ''}`);
      }
      return results.every((r) => r.ok) ? 0 : 1;
    }

    default:
      console.error(`unknown command "${command}"\n`);
      console.log(HELP);
      return 1;
  }
}

function printLotDetail(lot) {
  const deal = lot.deal || {};
  const valuation = lot.valuation || {};
  console.log(`${lot.title}\n`);
  console.log(`  source     ${lot.source} ${lot.externalId}`);
  console.log(`  url        ${lot.url || '(none)'}`);
  console.log(`  category   ${lot.categoryLabel} · condition ${lot.condition} · quantity ${lot.quantity}`);
  const where = lot.location || {};
  console.log(`  location   ${[where.city, where.state].filter(Boolean).join(', ') || 'unknown'}`);
  console.log(`  closes     ${lot.closesAt || 'unknown'} (${timeLeft(deal.hoursToClose)})`);
  console.log(`\n  Valuation  ${money(valuation.totalValue)} total · ${money(valuation.unitValue)} per unit · confidence ${pct(valuation.confidence)}`);
  console.log(`  Method     ${valuation.method === 'comp' ? `comp "${valuation.compLabel}"` : 'category default'}`);
  for (const adjustment of valuation.adjustments || []) {
    const detail = adjustment.multiplier !== undefined ? `× ${adjustment.multiplier}` : money(adjustment.value);
    console.log(`    ${pad(adjustment.step, 10)} ${pad(detail, 10, true)}  ${adjustment.label}`);
  }
  if ((valuation.notes || []).length) {
    console.log('\n  Warnings');
    for (const note of valuation.notes) console.log(`    ⚠ ${note}`);
  }
  const landed = deal.landed || {};
  const proceeds = deal.proceeds || {};
  console.log('\n  Cost to own');
  console.log(`    ${pad('bid', 10)} ${pad(money(landed.bid), 10, true)}`);
  console.log(`    ${pad('premium', 10)} ${pad(money(landed.premium), 10, true)}`);
  console.log(`    ${pad('tax', 10)} ${pad(money(landed.tax), 10, true)}`);
  console.log(`    ${pad('freight in', 10)} ${pad(money(landed.inbound), 10, true)}`);
  console.log(`    ${pad('prep', 10)} ${pad(money(landed.prep), 10, true)}`);
  console.log(`    ${pad('landed', 10)} ${pad(money(landed.total), 10, true)}`);
  console.log('\n  Sale');
  console.log(`    ${pad('gross', 10)} ${pad(money(proceeds.gross), 10, true)}  (sell-through ${pct(proceeds.sellThrough)})`);
  console.log(`    ${pad('fees', 10)} ${pad(money(-proceeds.fees), 10, true)}`);
  console.log(`    ${pad('shipping', 10)} ${pad(money(-proceeds.outbound), 10, true)}`);
  console.log(`    ${pad('net', 10)} ${pad(money(proceeds.net), 10, true)}`);
  console.log(`\n  Profit ${money(deal.profit)} · margin ${pct(deal.marginPct)} · ROI ${pct(deal.roi)} · score ${deal.score}`);
  console.log(`  Break-even bid ${money(deal.breakEvenBid)} · max bid at ${pct(deal.targetMarginPct)} margin ${money(deal.maxBid)}`);
}

function rulesCommand(app, args, flags) {
  const { store, config } = app;
  const action = args[0] || 'list';
  const defaults = {
    thresholds: config.thresholds,
    cooldownMinutes: config.alertCooldownMinutes,
    rebidPct: config.alertRebidPct,
  };

  if (action === 'list') {
    const rules = listRules(store);
    if (flags.json) {
      console.log(JSON.stringify(rules, null, 2));
      return 0;
    }
    if (!rules.length) console.log('No rules yet. Add one with: dealhunter rules add --name "Cheap laptops" --category laptops');
    for (const rule of rules) {
      const thresholds = Object.entries(rule.thresholds).map(([k, v]) => `${k}=${v}`).join(' ');
      const filters = Object.entries(rule.filters).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('|') : v}`).join(' ');
      console.log(`${rule.enabled ? '●' : '○'} ${pad(rule.id, 24)} ${rule.name}`);
      if (filters) console.log(`  filters    ${filters}`);
      if (thresholds) console.log(`  thresholds ${thresholds}`);
      console.log(`  channels   ${rule.channels.map((c) => c.type).join(', ')} · cooldown ${rule.cooldownMinutes}m`);
    }
    return 0;
  }

  if (action === 'add') {
    const rule = saveRule(store, {
      name: flags.name || 'Unnamed rule',
      notes: flags.notes,
      filters: {
        sources: flags.source, categories: flags.category, conditions: flags.condition,
        states: flags.state, keywords: flags.keywords, excludeKeywords: flags.excludeKeywords,
        minQuantity: flags.minQuantity, maxQuantity: flags.maxQuantity,
        maxLandedCost: flags.maxLandedCost, maxCurrentBid: flags.maxBid,
        closingWithinHours: flags.closingWithin, maxBidCount: flags.maxBidCount,
      },
      thresholds: {
        minMarginPct: flags.minMargin, minProfit: flags.minProfit, minRoi: flags.minRoi,
        minConfidence: flags.minConfidence, minScore: flags.minScore,
      },
      channels: channelsFromFlags(flags),
      cooldownMinutes: flags.cooldown,
    }, defaults);
    console.log(`Created rule ${rule.id} ("${rule.name}")`);
    return 0;
  }

  if (action === 'rm' || action === 'remove' || action === 'delete') {
    const id = args[1];
    if (!id) {
      console.error('usage: dealhunter rules rm <id>');
      return 1;
    }
    const removed = deleteRule(store, id);
    console.log(removed ? `Deleted rule ${id}` : `No rule with id ${id}`);
    return removed ? 0 : 1;
  }

  if (action === 'enable' || action === 'disable') {
    const id = args[1];
    const rule = store.collection('rules').get(id);
    if (!rule) {
      console.error(`No rule with id ${id}`);
      return 1;
    }
    rule.enabled = action === 'enable';
    saveRule(store, rule, defaults);
    console.log(`${action}d rule ${id}`);
    return 0;
  }

  console.error(`unknown rules action "${action}" (list, add, rm, enable, disable)`);
  return 1;
}

function channelsFromFlags(flags) {
  const channels = [];
  if (flags.webhook) channels.push({ type: 'webhook', url: flags.webhook });
  if (flags.slack) channels.push({ type: 'slack', url: flags.slack });
  if (flags.discord) channels.push({ type: 'discord', url: flags.discord });
  if (flags.file) channels.push({ type: 'file', path: flags.file });
  if (!channels.length || flags.console) channels.unshift({ type: 'console' });
  return channels;
}

function compsCommand(app, args, flags) {
  const action = args[0] || 'list';

  if (action === 'import') {
    const file = args[1];
    if (!file) {
      console.error('usage: dealhunter comps import <file.json|file.csv>');
      return 1;
    }
    const incoming = importComps(path.resolve(file));
    const target = app.userCompsFile;
    const existing = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : { comps: [] };
    const byId = new Map((existing.comps || []).map((c) => [c.id, c]));
    for (const comp of incoming.comps || []) byId.set(comp.id, comp);
    const merged = { ...existing, ...incoming, comps: Array.from(byId.values()) };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(merged, null, 2) + '\n');
    app.reloadComps();
    const count = app.pipeline.revalueAll();
    console.log(`Imported ${(incoming.comps || []).length} comps into ${target}; re-priced ${count} lots.`);
    return 0;
  }

  if (action === 'list') {
    const table = app.comps;
    const rows = table.comps
      .filter((comp) => !flags.category || comp.category === flags.category)
      .sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id));
    if (flags.json) {
      console.log(JSON.stringify(rows, null, 2));
      return 0;
    }
    for (const comp of rows) {
      console.log(`${pad(comp.category, 15)} ${pad(comp.id, 26)} ${pad(money(comp.unitValue), 9, true)}  conf ${pad(comp.confidence, 5, true)}  ${comp.label}`);
    }
    console.log(`\n${rows.length} comps. Values are starting estimates — calibrate them with "dealhunter comps import".`);
    return 0;
  }

  console.error(`unknown comps action "${action}" (list, import)`);
  return 1;
}

main().then((code) => {
  if (code !== null && code !== undefined) process.exit(code);
}).catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
