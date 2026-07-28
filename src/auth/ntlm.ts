/**
 * Detect whether a WWW-Authenticate header (or a Negotiate challenge token) indicates NTLM.
 * NTLM is rejected: only Kerberos/SPNEGO Negotiate is acceptable.
 *
 * Two cases:
 *  - the header offers the NTLM scheme directly: `WWW-Authenticate: NTLM`
 *  - an NTLM token tunneled via Negotiate: `Negotiate <base64>` where the base64 decodes to
 *    bytes starting with the NTLM signature "NTLMSSP\0" (base64 prefix "TlRMTVNTUAA").
 */
export function isNtlmChallenge(wwwAuthenticate: string | undefined): boolean {
  if (!wwwAuthenticate) return false;
  const value = wwwAuthenticate.trim();
  if (!value) return false;
  // Split on commas to handle multiple offered schemes, e.g. "Negotiate, NTLM"
  const parts = value.split(',').map((p) => p.trim());
  for (const part of parts) {
    const lower = part.toLowerCase();
    // direct NTLM scheme offer (word-boundary, not e.g. "Negotiate")
    if (/^ntlm\b/i.test(part)) return true;
    // NTLM tunneled inside a Negotiate token
    if (lower.startsWith('negotiate ')) {
      const token = part.slice('negotiate '.length).trim();
      if (token.startsWith('TlRMTVNTUAA')) return true; // base64("NTLMSSP\0")
    }
  }
  return false;
}

/**
 * A `Negotiate` challenge that is not NTLM in disguise. Says nothing about
 * whether it carries a token — callers that care must ask which kind it is.
 */
function isNegotiate(wwwAuthenticate: string | undefined): boolean {
  if (!wwwAuthenticate) return false;
  if (isNtlmChallenge(wwwAuthenticate)) return false;
  return wwwAuthenticate
    .split(',')
    .some((part) => /^negotiate\b/i.test(part.trim()));
}

/**
 * `Negotiate <gssapi-data>` — the server has handed back a token for the client
 * to feed into its GSS context and retry (RFC 4559 continuation).
 */
export function isNegotiateContinuation(
  wwwAuthenticate: string | undefined,
): boolean {
  if (!isNegotiate(wwwAuthenticate)) return false;
  return (wwwAuthenticate as string)
    .split(',')
    .some((part) => /^negotiate\s+\S/i.test(part.trim()));
}

/**
 * A bare `Negotiate`, with no token.
 *
 * Told apart from a continuation deliberately: once the client has ALREADY sent
 * its initial Authorization, a bare challenge is the server declining it — the
 * credentials were not accepted. There is no server token here, so nothing
 * could be stepped even by a client that supports multi-leg. Diagnosing the two
 * alike sends the reader after the wrong problem.
 */
export function isBareNegotiateChallenge(
  wwwAuthenticate: string | undefined,
): boolean {
  return (
    isNegotiate(wwwAuthenticate) && !isNegotiateContinuation(wwwAuthenticate)
  );
}
