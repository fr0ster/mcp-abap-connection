/**
 * Plain JavaScript, so nothing checks the call: `createConnection` handed a
 * combination of system and transport the types do not admit, as a caller
 * outside TypeScript can hand it. Loaded by createConnection.test from the
 * compiled tree, where `../../../connection/createConnection.js` is the
 * compiled factory.
 */
const { createConnection } = require('../../../connection/createConnection.js');

exports.createPastTheTypes = (system, transport, config, credential) =>
  createConnection({ system, transport, config, credential });
