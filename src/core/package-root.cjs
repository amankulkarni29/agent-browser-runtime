'use strict';
// Resolves to the package root from both src/core and dist/core, in ESM builds and CommonJS tests.
module.exports = require('node:path').resolve(__dirname, '..', '..');
