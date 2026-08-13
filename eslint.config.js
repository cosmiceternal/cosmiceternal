'use strict';

// Lint config is a guardrail, not a style cop: it enforces the rules that catch
// real defects — dead code, undeclared names, unreachable branches, duplicate
// keys, likely-bug patterns — and stays silent on pure formatting. Two
// environments: Node (server + tests, CommonJS) and the browser (public/, IIFE
// modules that share a fixed set of globals via window at runtime).
const globals = require('globals');

// Cross-file singletons the client IIFEs attach to window and read elsewhere.
// Declaring them lets no-undef catch typos (Bankrol.get()) without false
// positives on the intended runtime sharing.
const appGlobals = {};
for (const g of ['API', 'Admin', 'Bankroll', 'ChatPanel', 'Confetti', 'CryptNav', 'Fair', 'Feed',
  'GameCatalog', 'GameKit', 'Games', 'Help', 'Jackpot', 'Limits', 'PlayerStats',
  'Progression', 'Sound', 'Toast', 'Tour', 'Vault', 'WinFx']) appGlobals[g] = 'writable';

// Rules that flag genuine defects (never formatting). Shared by both scopes.
const bugRules = {
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
  'no-unreachable': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-dupe-else-if': 'error',
  'no-const-assign': 'error',
  'no-redeclare': 'error',
  'no-func-assign': 'error',
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'no-unsafe-negation': 'error',
  'no-constant-binary-expression': 'error',
  'no-template-curly-in-string': 'error',
  'no-unmodified-loop-condition': 'error',
  'no-promise-executor-return': 'error',
  'no-unreachable-loop': 'error',
  'array-callback-return': 'error',
  'no-throw-literal': 'error',
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'eqeqeq': ['error', 'smart'],
  'no-var': 'error',
};

module.exports = [
  { ignores: ['node_modules/**'] },
  {
    files: ['server/**/*.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: { ...bugRules, 'no-undef': 'error' },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.browser, ...appGlobals },
    },
    rules: { ...bugRules, 'no-undef': 'error' },
  },
];
