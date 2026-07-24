'use strict';
/* Public game API. The engine is split into server/games/{core,originals,
 * spectacle,data}.js for navigability; this re-exports the combined surface so
 * require('./games') stays identical for every caller and test. */
const core = require('./games/core');
const originals = require('./games/originals');
const spectacle = require('./games/spectacle');
const data = require('./games/data');

module.exports = Object.assign({}, core, originals, spectacle, data);
