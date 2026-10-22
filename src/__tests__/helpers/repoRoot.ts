/**
 * The repository's root: the nearest directory above this file that holds a
 * package.json. A test reads the repository (its tsconfig, its tools) from
 * here, wherever the compiled test runs from.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

function findRoot(from: string): string {
  let dir = from;
  while (!existsSync(join(dir, 'package.json'))) {
    const up = dirname(dir);
    if (up === dir) throw new Error('no package.json above the tests');
    dir = up;
  }
  return dir;
}

export const REPO_ROOT = findRoot(__dirname);
