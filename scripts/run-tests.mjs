#!/usr/bin/env node
/**
 * The test run: compile src/ (tests included) with tsc (tsconfig.test.json)
 * into .test-build/, then run every compiled `*.test.js` under
 * src/__tests__ with Node's own test runner (node:test). No test framework is
 * installed, so none brings its dependency tree and its install scripts.
 *
 *   node scripts/run-tests.mjs                      every suite
 *   node scripts/run-tests.mjs shapeCheck rfcLogon  the suites whose path holds one of these
 *                                                   (a `.ts` name stands for its compiled `.js`)
 *   node scripts/run-tests.mjs -- --test-name-pattern=CSRF   anything after -- goes to node
 *
 * Compiled afresh on every run: nothing is cached between runs, so a run can
 * never report on code from before the last change.
 *
 * The files are listed here, not passed as a directory or glob: `node --test`
 * reads its arguments differently across the supported Node.js lines.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, '.test-build');
const require = createRequire(import.meta.url);

const dashdash = process.argv.indexOf('--');
// A filter may name the source (`….test.ts`); what runs is its compiled `.js`.
const filters = (
  dashdash === -1 ? process.argv.slice(2) : process.argv.slice(2, dashdash)
).map((f) => f.replace(/\.ts$/, '.js'));
const nodeArgs = dashdash === -1 ? [] : process.argv.slice(dashdash + 1);

function run(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

rmSync(out, { recursive: true, force: true });
// typescript's `exports` do not expose its bin, so it is found through its
// package.json (the same file `npm run` would link as `tsc`).
const tsDir = dirname(require.resolve('typescript/package.json'));
const tsBin = require('typescript/package.json').bin.tsc;
run([join(tsDir, tsBin), '-p', 'tsconfig.test.json']);

// What the compiled tests read beside them, and tsc does not emit: the TLS
// fixtures, and the CommonJS module the docs checker shares with its test.
cpSync(join(root, 'src', '__tests__'), join(out, 'src', '__tests__'), {
  recursive: true,
  filter: (from) => !from.endsWith('.ts'),
});
cpSync(
  join(root, 'scripts', 'docs-paths.js'),
  join(out, 'scripts', 'docs-paths.js'),
);

function testsUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testsUnder(path);
    return entry.name.endsWith('.test.js') ? [path] : [];
  });
}

const files = testsUnder(join(out, 'src', '__tests__'))
  .filter((file) => {
    if (filters.length === 0) return true;
    const name = relative(out, file).split(sep).join('/');
    return filters.some((f) => name.includes(f));
  })
  .sort();
if (files.length === 0) {
  process.stderr.write(
    `connection: no compiled test matches ${filters.join(', ') || 'anything'}\n`,
  );
  process.exit(1);
}
run(['--test', ...nodeArgs, ...files]);
