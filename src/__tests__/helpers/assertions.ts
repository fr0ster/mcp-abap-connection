/**
 * The one comparison node:assert has no counterpart for: `actual` matches
 * `expected` as a subset, with the rules Jest's `toMatchObject` had.
 *
 * - an object `expected` (not an array, an Error or a Date): every own
 *   enumerable key of it is present on `actual` (own or inherited) and its
 *   value matches, recursively; keys `expected` does not name are not read;
 * - an array `expected`: `actual` is an array of the same length whose
 *   elements match, index for index;
 * - anything else: `assert.deepStrictEqual`.
 */
import assert from 'node:assert/strict';

function isSubsetObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Error) &&
    !(value instanceof Date)
  );
}

export function assertMatchObject(
  actual: unknown,
  expected: unknown,
  path = 'value',
): void {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${path} is not an array`);
    assert.strictEqual(actual.length, expected.length, `${path}.length`);
    expected.forEach((item, i) => {
      assertMatchObject(actual[i], item, `${path}[${i}]`);
    });
    return;
  }
  if (isSubsetObject(expected)) {
    assert.ok(
      (typeof actual === 'object' && actual !== null) ||
        typeof actual === 'function',
      `${path} is not an object`,
    );
    const target = actual as Record<string, unknown>;
    for (const key of Object.keys(expected)) {
      assert.ok(key in target, `${path}.${key} is missing`);
      assertMatchObject(target[key], expected[key], `${path}.${key}`);
    }
    return;
  }
  assert.deepStrictEqual(actual, expected, path);
}
