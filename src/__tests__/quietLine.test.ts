/**
 * The quiet line's path: an absolute URL gives its pathname alone — no user,
 * password, host, query or fragment — and a relative one is cut at its query
 * or fragment.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pathOf, quietLine } from '../connection/quietLine.js';

describe('quietLine', () => {
  it('an absolute URL: the pathname alone, in the line and in the field', () => {
    const url = 'https://user:pass@host.example/sap/bc/adt/x?q=1#f';
    const quiet = quietLine('GET', url, { status: 200, data: 'ok' });
    assert.strictEqual(quiet.line, 'GET /sap/bc/adt/x → 200 (2 bytes)');
    assert.strictEqual(quiet.facts.path, '/sap/bc/adt/x');
    assert.strictEqual(pathOf(url), '/sap/bc/adt/x');
  });

  it('a relative URL: cut at the query or the fragment', () => {
    assert.strictEqual(pathOf('/sap/bc/adt/x?q=1'), '/sap/bc/adt/x');
    assert.strictEqual(pathOf('/sap/bc/adt/x#f?q'), '/sap/bc/adt/x');
    assert.strictEqual(pathOf('/sap/bc/adt/x'), '/sap/bc/adt/x');
  });

  it('a control character in the path is escaped: no line can be forged', () => {
    const quiet = quietLine('GET', '/sap/bc/adt/a\nFORGED\rline\u0000?q=1');
    assert.strictEqual(
      quiet.line,
      'GET /sap/bc/adt/a\\x0aFORGED\\x0dline\\x00 → no answer',
    );
    assert.strictEqual(
      quiet.facts.path,
      '/sap/bc/adt/a\\x0aFORGED\\x0dline\\x00',
    );
    assert.ok(!quiet.line.includes('\n') && !quiet.line.includes('\r'));
  });

  it('a URL that does not parse: a fixed placeholder, nothing of it', () => {
    for (const url of [
      'https://user:PCANARY@host.example:99999/x?q',
      '//user:PCANARY@host.example/x',
      'user PCANARY',
    ]) {
      const quiet = quietLine('GET', url);
      assert.strictEqual(quiet.line, 'GET <unparsable url> → no answer');
      assert.strictEqual(quiet.facts.path, '<unparsable url>');
    }
  });

  it('a scheme with no authority names nothing of what follows it', () => {
    assert.strictEqual(pathOf('user:pass@host/x'), '');
  });
});
