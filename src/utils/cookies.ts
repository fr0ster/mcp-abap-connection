/**
 * Join two `Cookie` header values, later wins on a repeated name.
 *
 * Used wherever a request already carries cookies and more are added: a
 * credential can BE cookies — a SAML session is handed over as `MYSAPSSO2` —
 * so writing the session jar over the header drops the very thing the request
 * authenticates with. Both belong on the wire: one says who we are, the other
 * which session we are in. A name in both is the session's, because that is the
 * one the server just issued.
 */
export function mergeCookieHeaders(
  existing: string | undefined,
  incoming: string | undefined,
): string {
  const parts = [existing, incoming].filter(Boolean).join('; ');
  const byName = new Map<string, string>();
  for (const part of parts.split(';')) {
    const pair = part.trim();
    if (!pair) continue;
    byName.set(pair.slice(0, pair.indexOf('=')), pair);
  }
  return [...byName.values()].join('; ');
}
