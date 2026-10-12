/**
 * Runs this repository's TypeScript under plain node, outside Jest.
 *
 * Jest hands a test a copy of `process`, and the real process's
 * `unhandledRejection` never reaches a listener registered on the copy — so
 * "nothing is left unhandled" can only be observed in a process of its own.
 * Each `.ts` file is transpiled as it is required (the repository's own
 * `typescript`, no type check), and an import written `./x.js` finds `./x.ts`.
 *
 *   node -r ./src/__tests__/helpers/plainNode/register.cjs <scenario.ts>
 */
const fs = require('node:fs');
const Module = require('node:module');
const ts = require('typescript');

const resolve = Module._resolveFilename;
Module._resolveFilename = function resolveTs(request, parent, ...rest) {
  try {
    return resolve.call(this, request, parent, ...rest);
  } catch (error) {
    if (!request.endsWith('.js')) throw error;
    return resolve.call(this, `${request.slice(0, -3)}.ts`, parent, ...rest);
  }
};

require.extensions['.ts'] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  });
  module._compile(outputText, filename);
};
