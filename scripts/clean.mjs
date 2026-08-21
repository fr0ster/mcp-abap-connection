#!/usr/bin/env node
/**
 * Removes the build output.
 *
 * This was `rm -rf`, which is not a command on Windows. It appeared to work
 * there only for developers who had Git's bundled `rm.exe` on PATH — and
 * `clean` is the first thing `build` runs, so on a box without it `npm run
 * build` failed before it had compiled anything, with an error about `rm`
 * rather than about the code.
 *
 * Node rather than rimraf: `fs.rmSync` has done this since Node 14, and the
 * package already requires Node. A dependency to delete two paths is a
 * dependency to audit, pin and upgrade for the rest of the project's life.
 */
import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Anchored to this file, not to the cwd. `npm run clean` sets the cwd to the
// package root, but a recursive delete is the wrong place to rely on that.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

for (const target of ['dist', 'tsconfig.tsbuildinfo']) {
  // `force` so a clean tree is not an error: `clean` is a precondition, not an
  // assertion that there was something to remove.
  rmSync(join(root, target), { recursive: true, force: true });
}
