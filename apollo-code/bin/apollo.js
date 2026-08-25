#!/usr/bin/env node
import { main } from '../src/cli.js';

main()
  .then((code) => { process.exitCode = code ?? 0; })
  .catch((err) => {
    process.stderr.write(`apollo: ${err?.stack || err}\n`);
    process.exitCode = 1;
  });
