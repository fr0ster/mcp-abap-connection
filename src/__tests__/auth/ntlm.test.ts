import {
  isBareNegotiateChallenge,
  isNegotiateContinuation,
  isNtlmChallenge,
} from '../../auth/ntlm.js';

test('detects direct NTLM scheme', () => {
  expect(isNtlmChallenge('NTLM')).toBe(true);
  expect(isNtlmChallenge('Negotiate, NTLM')).toBe(true);
});

test('detects NTLM tunneled via Negotiate (NTLMSSP base64 prefix)', () => {
  expect(isNtlmChallenge('Negotiate TlRMTVNTUAABBBBB')).toBe(true);
});

test('does NOT flag a real Kerberos Negotiate token', () => {
  expect(isNtlmChallenge('Negotiate YIIBexyz==')).toBe(false);
  expect(isNtlmChallenge('Negotiate')).toBe(false);
});

test('handles missing/empty header', () => {
  expect(isNtlmChallenge(undefined)).toBe(false);
  expect(isNtlmChallenge('')).toBe(false);
});

test('does not false-positive on "Negotiate" containing letters', () => {
  expect(isNtlmChallenge('Bearer realm="x"')).toBe(false);
});

// The two Negotiate 401s mean different things and need different advice: one
// is the server continuing the exchange, the other is the server declining the
// token already sent. Conflating them sends the reader after the wrong problem.
describe('Negotiate challenges', () => {
  it('a token means continuation', () => {
    expect(isNegotiateContinuation('Negotiate YIIBexyz==')).toBe(true);
    expect(isBareNegotiateChallenge('Negotiate YIIBexyz==')).toBe(false);
  });

  it('no token means the token already sent was rejected', () => {
    expect(isBareNegotiateChallenge('Negotiate')).toBe(true);
    expect(isNegotiateContinuation('Negotiate')).toBe(false);
  });

  it('neither applies to NTLM, offered directly or tunneled', () => {
    for (const header of [
      'NTLM',
      'Negotiate TlRMTVNTUAABBBB',
      'Negotiate, NTLM',
    ]) {
      expect(isNegotiateContinuation(header)).toBe(false);
      expect(isBareNegotiateChallenge(header)).toBe(false);
    }
  });

  it('neither applies to nothing, or to another scheme', () => {
    for (const header of [undefined, '', 'Basic realm="x"']) {
      expect(isNegotiateContinuation(header)).toBe(false);
      expect(isBareNegotiateChallenge(header)).toBe(false);
    }
  });
});
