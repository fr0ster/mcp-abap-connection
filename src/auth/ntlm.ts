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
