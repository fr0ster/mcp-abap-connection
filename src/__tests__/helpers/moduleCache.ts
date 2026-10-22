/**
 * Two things a test needs from Node's CommonJS module cache — no loader hooks,
 * no flags, nothing beyond `require.cache` and its resolution.
 *
 * `isolatedRequire(id)`: a second, separate copy of a package and everything
 * it loads, as another dependency tree would hold it. The cache is set aside,
 * `id` is loaded into an empty one, and the cache is put back as it was.
 *
 * `withModule(id, exports, run)`: while `run` runs, `require(id)` from
 * anywhere answers `exports` — whether `id` is installed or not — and
 * afterwards whatever was there before is back.
 */
import Module from 'node:module';

type Cache = Record<string, NodeJS.Module | undefined>;

export function isolatedRequire<T>(id: string): T {
  const cache = require.cache as Cache;
  const saved = { ...cache };
  for (const key of Object.keys(cache)) delete cache[key];
  try {
    return require(id) as T;
  } finally {
    for (const key of Object.keys(cache)) delete cache[key];
    Object.assign(cache, saved);
  }
}

export function withModule(
  id: string,
  exports: unknown,
  run: () => void,
): void {
  const cache = require.cache as Cache;
  const loader = Module as unknown as {
    _resolveFilename: (request: string, ...rest: unknown[]) => string;
  };
  const resolve = loader._resolveFilename;
  const key = `stubbed:${id}`;
  loader._resolveFilename = function (request: string, ...rest: unknown[]) {
    return request === id ? key : resolve.call(this, request, ...rest);
  };
  const stub = new Module(key);
  stub.filename = key;
  stub.loaded = true;
  stub.exports = exports;
  cache[key] = stub;
  try {
    run();
  } finally {
    loader._resolveFilename = resolve;
    delete cache[key];
  }
}
