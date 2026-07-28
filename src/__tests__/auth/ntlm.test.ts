import { isNegotiateChallenge, isNtlmChallenge } from '../../auth/ntlm.js';

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

describe('isNegotiateChallenge', () => {
  it('accepts a plain Kerberos challenge', () => {
    expect(isNegotiateChallenge('Negotiate')).toBe(true);
    expect(isNegotiateChallenge('Negotiate YIIBexyz==')).toBe(true);
  });

  // The distinction the Kerberos connect depends on: an NTLM token wearing a
  // Negotiate label must not be waved through as a handshake.
  it('rejects NTLM, whether offered directly or tunneled', () => {
    expect(isNegotiateChallenge('NTLM')).toBe(false);
    expect(isNegotiateChallenge('Negotiate TlRMTVNTUAABBBB')).toBe(false);
    expect(isNegotiateChallenge('Negotiate, NTLM')).toBe(false);
  });

  it('rejects nothing at all', () => {
    expect(isNegotiateChallenge(undefined)).toBe(false);
    expect(isNegotiateChallenge('')).toBe(false);
    expect(isNegotiateChallenge('Basic realm="x"')).toBe(false);
  });
});
