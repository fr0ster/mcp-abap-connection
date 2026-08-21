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
import { ships, toPosix } from '../../scripts/docs-paths.js';

describe('toPosix', () => {
  it('rewrites Windows separators', () => {
    expect(toPosix('docs\\USAGE.md')).toBe('docs/USAGE.md');
  });

  it('leaves a POSIX path alone', () => {
    expect(toPosix('docs/USAGE.md')).toBe('docs/USAGE.md');
  });
});

describe('ships', () => {
  const published = ['dist', 'docs', 'examples', 'README.md'];

  it('accepts a file under a shipped directory, whatever the separator', () => {
    expect(ships(published, 'docs/USAGE.md')).toBe(true);
    expect(ships(published, 'docs\\USAGE.md')).toBe(true);
    expect(ships(published, 'examples\\jwt\\basic.md')).toBe(true);
  });

  it('accepts a file listed by name', () => {
    expect(ships(published, 'README.md')).toBe(true);
  });

  it('rejects a file no entry covers', () => {
    expect(ships(published, 'CHANGELOG.md')).toBe(false);
    expect(ships(published, 'src\\index.ts')).toBe(false);
  });

  it('matches on a directory boundary, not a name prefix', () => {
    expect(ships(published, 'docs-internal/USAGE.md')).toBe(false);
    expect(ships(published, 'docs-internal\\USAGE.md')).toBe(false);
  });
});
