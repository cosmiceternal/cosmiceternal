'use strict';

// Source registry. Built-in sources are code; everything else is a recipe file,
// loaded from the shipped seed/sources directory and then from the user's own
// recipe directory, which wins on id collision so a local fix overrides a
// shipped recipe without editing the repo.
const fs = require('node:fs');
const path = require('node:path');

const { runRecipe, validateRecipe } = require('./recipe');
const { createSampleSource } = require('./sample');

const SEED_DIR = path.join(__dirname, '..', '..', 'seed', 'sources');

function recipeToSource(recipe, overrides = {}) {
  validateRecipe(recipe);
  const merged = { ...recipe, ...overrides };
  return {
    id: merged.id,
    label: merged.label || merged.id,
    kind: merged.kind,
    site: merged.site || null,
    verified: merged.verified === true,
    notes: merged.notes || [],
    recipe: merged,
    async collect(ctx = {}) {
      return runRecipe(merged, {
        http: ctx.http,
        log: ctx.log,
        maxPages: ctx.maxPages,
        vars: { query: ctx.query || '', ...(ctx.vars || {}) },
      });
    },
  };
}

function readRecipeDir(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir).sort()) {
    if (!entry.endsWith('.json')) continue;
    const file = path.join(dir, entry);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`source recipe ${file} is not valid JSON: ${err.message}`);
    }
    out.push({ file, recipe: parsed });
  }
  return out;
}

// Returns every known source keyed by id, whether or not it is enabled.
function loadSources(options = {}) {
  const registry = new Map();
  const problems = [];

  const sample = createSampleSource(options.sample || {});
  registry.set(sample.id, sample);

  const dirs = [options.seedDir || SEED_DIR, options.userDir].filter(Boolean);
  for (const dir of dirs) {
    for (const { file, recipe } of readRecipeDir(dir)) {
      try {
        const source = recipeToSource(recipe);
        source.file = file;
        registry.set(source.id, source);
      } catch (err) {
        problems.push(`${file}: ${err.message}`);
      }
    }
  }

  return { registry, problems };
}

// Resolves the configured source ids against the registry, reporting names that
// do not exist rather than silently scraping nothing.
function selectSources(registry, ids) {
  const selected = [];
  const unknown = [];
  for (const id of ids) {
    const source = registry.get(id);
    if (source) selected.push(source);
    else unknown.push(id);
  }
  return { selected, unknown };
}

module.exports = { loadSources, selectSources, recipeToSource, SEED_DIR };
