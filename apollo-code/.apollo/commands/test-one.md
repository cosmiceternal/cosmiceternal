---
description: Run one test file or a single test by name
---
Run the tests matching $ARGUMENTS and report the result.

Use `node --test test/<file>.test.js` for a file, or
`node --test --test-name-pattern="<name>" test/*.test.js` for a single test.

If anything fails, read the failing assertion and the code under test, say
exactly which behaviour is wrong, and propose the smallest fix. Do not change
a test to make it pass unless the test itself is wrong — say so explicitly if
you believe it is.
