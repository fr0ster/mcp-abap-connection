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

/** Node's resolver, which `@types/node` does not declare. */
type Resolve = (request: string, ...rest: unknown[]) => string;

export function isolatedRequire<T>(id: string): T {
  const cache = require.cache;
  const saved = { ...cache };
  for (const key of Object.keys(cache)) delete cache[key];
  try {
    const loaded: T = require(id);
    return loaded;
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
  const restore = install(id, exports);
  try {
    run();
  } finally {
    restore();
  }
}

/** `withModule` for a `run` that settles later: put back once it has. */
export async function withModuleAsync<T>(
  id: string,
  exports: unknown,
  run: () => Promise<T>,
): Promise<T> {
  const restore = install(id, exports);
  try {
    return await run();
  } finally {
    restore();
  }
}

/** Makes `require(id)` answer `exports`; returns what puts the cache back. */
function install(id: string, exports: unknown): () => void {
  const cache = require.cache;
  const resolve: unknown = Reflect.get(Module, '_resolveFilename');
  if (typeof resolve !== 'function') {
    throw new Error('node:module has no _resolveFilename to stand in for');
  }
  const key = `stubbed:${id}`;
  const standIn: Resolve = function (this: unknown, request, ...rest) {
    return request === id
      ? key
      : Reflect.apply(resolve, this, [request, ...rest]);
  };
  Reflect.set(Module, '_resolveFilename', standIn);
  const stub = new Module(key);
  stub.filename = key;
  stub.loaded = true;
  stub.exports = exports;
  cache[key] = stub;
  return () => {
    Reflect.set(Module, '_resolveFilename', resolve);
    delete cache[key];
  };
}
