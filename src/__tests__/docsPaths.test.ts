/**
 * The docs checker decides what ships by comparing paths against package.json
 * "files". It builds those paths with path.relative(), which answers in the
 * host's separator — so on Windows every shipped doc read as "docs\USAGE.md",
 * matched no entry, and the check went wrong twice over: links out of README
 * were reported as unshipped, and docs/*.md were never examined at all.
 *
 * Both separators are stated here, so the rule is checked on every platform
 * rather than on the one that happens to be running the suite.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ships, toPosix } from '../../scripts/docs-paths.js';

describe('toPosix', () => {
  it('rewrites Windows separators', () => {
    assert.strictEqual(toPosix('docs\\USAGE.md'), 'docs/USAGE.md');
  });

  it('leaves a POSIX path alone', () => {
    assert.strictEqual(toPosix('docs/USAGE.md'), 'docs/USAGE.md');
  });
});

describe('ships', () => {
  const published = ['dist', 'docs', 'examples', 'README.md'];

  it('accepts a file under a shipped directory, whatever the separator', () => {
    assert.strictEqual(ships(published, 'docs/USAGE.md'), true);
    assert.strictEqual(ships(published, 'docs\\USAGE.md'), true);
    assert.strictEqual(ships(published, 'examples\\jwt\\basic.md'), true);
  });

  it('accepts a file listed by name', () => {
    assert.strictEqual(ships(published, 'README.md'), true);
  });

  it('rejects a file no entry covers', () => {
    assert.strictEqual(ships(published, 'CHANGELOG.md'), false);
    assert.strictEqual(ships(published, 'src\\index.ts'), false);
  });

  it('matches on a directory boundary, not a name prefix', () => {
    assert.strictEqual(ships(published, 'docs-internal/USAGE.md'), false);
    assert.strictEqual(ships(published, 'docs-internal\\USAGE.md'), false);
  });
});
