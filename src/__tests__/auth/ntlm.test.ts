import { isNtlmChallenge } from '../../auth/ntlm.js';

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
