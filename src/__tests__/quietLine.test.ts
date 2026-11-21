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

  it('a scheme with no authority names nothing of what follows it', () => {
    assert.strictEqual(pathOf('user:pass@host/x'), '');
  });
});
