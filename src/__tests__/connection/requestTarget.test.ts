import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { requestTargetOn } from '../../connection/requestTarget.js';

describe('requestTargetOn', () => {
  it('writes a header, and a second write replaces it', () => {
    const headers: Record<string, string> = {};
    const target = requestTargetOn(headers);
    target.header('Authorization', 'Basic a');
    assert.strictEqual(headers.Authorization, 'Basic a');
    target.header('Authorization', 'Bearer b');
    assert.strictEqual(headers.Authorization, 'Bearer b');
  });

  it('sets Cookie when there was none', () => {
    const headers: Record<string, string> = {};
    requestTargetOn(headers).cookies('MYSAPSSO2=x');
    assert.strictEqual(headers.Cookie, 'MYSAPSSO2=x');
  });

  it('merges cookies into an existing Cookie, the credential winning a repeated name', () => {
    const headers: Record<string, string> = { Cookie: 'a=1; b=2' };
    requestTargetOn(headers).cookies('b=9; c=3');
    assert.strictEqual(headers.Cookie, 'a=1; b=9; c=3');
  });
});
