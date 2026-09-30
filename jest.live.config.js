/**
 * The live suites — one per provider, under src/__tests__/live/. Same setup as
 * jest.config.js, minus the exclusion that keeps them out of `npm test`.
 */
const base = require('./jest.config.js');

/** @type {import('jest').Config} */
module.exports = {
  ...base,
  testPathIgnorePatterns: ['/node_modules/'],
};
