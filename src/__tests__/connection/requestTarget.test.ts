import { requestTargetOn } from '../../connection/requestTarget.js';

describe('requestTargetOn', () => {
  it('writes a header, and a second write replaces it', () => {
    const headers: Record<string, string> = {};
    const target = requestTargetOn(headers);
    target.header('Authorization', 'Basic a');
    expect(headers.Authorization).toBe('Basic a');
    target.header('Authorization', 'Bearer b');
    expect(headers.Authorization).toBe('Bearer b');
  });

  it('sets Cookie when there was none', () => {
    const headers: Record<string, string> = {};
    requestTargetOn(headers).cookies('MYSAPSSO2=x');
    expect(headers.Cookie).toBe('MYSAPSSO2=x');
  });

  it('merges cookies into an existing Cookie, the credential winning a repeated name', () => {
    const headers: Record<string, string> = { Cookie: 'a=1; b=2' };
    requestTargetOn(headers).cookies('b=9; c=3');
    expect(headers.Cookie).toBe('a=1; b=9; c=3');
  });
});
