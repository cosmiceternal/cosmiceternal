'use strict';

// Lint config is a guardrail, not a style cop: it enforces the handful of rules
// that catch real defects — dead code, undeclared names, unreachable branches,
// duplicate keys — and stays silent on formatting. Two environments: Node
// (server + tests, CommonJS) and the browser (public/, IIFE modules that share
// globals across files at runtime).
const globals = require('globals');

const bugRules = {
  // The headline guardrail: unused vars / imports / functions = dead code.
  // args:'none' + caughtErrors:'none' avoid flagging deliberately-unused
  // callback params and `catch (e) {}` — those aren't dead code.
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
  'no-unreachable': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-const-assign': 'error',
  'no-redeclare': 'error',
  'no-func-assign': 'error',
  'no-self-assign': 'error',
};

module.exports = [
  { ignores: ['node_modules/**'] },
  {
    // Server + tests: Node CommonJS.
    files: ['server/**/*.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: { ...bugRules, 'no-undef': 'error' },
  },
  {
    // Browser client: each file is an IIFE that reads/writes shared globals
    // (API, Bankroll, GameKit, …) via window, so no-undef would false-positive
    // on every cross-file reference. Keep the dead-code rules; drop no-undef.
    files: ['public/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals: { ...globals.browser } },
    rules: { ...bugRules },
  },
];
