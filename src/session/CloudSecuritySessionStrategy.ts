/**
 * ABAP Cloud: a session is a resource, asked for and given back by address.
 *
 * Captured from Eclipse ADT 3.60 against a BTP trial and reproduced here with a
 * bearer token, which is what made the difference visible: **the server issues
 * `SAP_SESSIONID` to whoever asks for a session, and we never asked.** The
 * request that asks carries `x-sap-security-session: create` — `use` does not
 * do it — and `sap-adt-purpose: preflight_logon`. The response sets the cookie
 * and publishes the session's own address in a `securitysession` link, which is
 * the address a close goes to.
 *
 * Without that request the same connection gets `sap-usercontext` and
 * `sap-XSRF_*` and nothing else, no `securitysession` link, and no session for
 * a lock to be bound to — which is how "cloud does not issue SAP_SESSIONID"
 * came to be believed.
 */

import { mergeCookieHeaders } from '../utils/cookies.js';
import { getTimeout } from '../utils/timeouts.js';
import { type ISessionTransport, SessionStrategy } from './SessionStrategy.js';

const SESSIONS_PATH = '/sap/bc/adt/core/http/sessions';

/** The versioned media types Eclipse asks this resource for, newest first. */
const SESSION_ACCEPT =
  'application/vnd.sap.adt.core.http.session.v3+xml, ' +
  'application/vnd.sap.adt.core.http.session.v2+xml, ' +
  'application/vnd.sap.adt.core.http.session.v1+xml';

const SECURITY_SESSION_REL =
  'http://www.sap.com/adt/categories/core/http/sessions/securitysession';

export class CloudSecuritySessionStrategy extends SessionStrategy {
  readonly kind = 'cloud-security-session' as const;

  /** The address this server published for our session — the only close target. */
  private resource: string | null = null;

  async openSession(transport: ISessionTransport): Promise<boolean> {
    try {
      // Read ONCE. The contract lets a provider answer differently each time —
      // a token provider renews behind the call — so two reads can build one
      // request out of two different credentials, and for a token provider they
      // also double the work.
      const auth = await transport.authHeaders();
      const response = await transport.send({
        method: 'GET',
        // The cache-buster is Eclipse's; kept because this must not be served
        // from anything's cache — a cached session document would hand back an
        // address that belongs to a session somebody else already ended.
        url: `${transport.baseUrl}${SESSIONS_PATH}?_=${Date.now()}`,
        // Bounded: connect() waits for this one.
        timeoutMs: getTimeout('csrf'),
        // Its SAP_SESSIONID is the session.
        adoptCookies: true,
        headers: {
          ...auth,
          Accept: SESSION_ACCEPT,
          Cookie: mergeCookieHeaders(
            auth.Cookie,
            transport.cookies() ?? undefined,
          ),
          'sap-adt-purpose': 'preflight_logon',
          'x-sap-security-session': 'create',
        },
      });

      // 404 is the answer "this system has no session resource", which is what
      // on-prem says. Not an error, and not something to retry.
      if (response.status === 404) {
        return false;
      }

      const resource = this.securitySessionHref(response.data);
      if (!resource) {
        // Answered, but published no session of its own — so there is no
        // address to give one back by, and claiming this mechanism would leave
        // the close with nothing to send. Falls back to the platform's logoff,
        // which needs no address.
        this.logger?.debug(
          `Session resource answered ${response.status} but published no securitysession link`,
        );
        return false;
      }

      this.resource = resource;
      this.logger?.debug(`Security session opened: ${resource}`);
      return true;
    } catch (error) {
      // Never fatal here. If no session was opened, the establishment that
      // follows says so with the whole picture; a transport error raised from
      // a preflight would replace that with something less useful.
      this.logger?.debug(
        `Could not open a security session: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  async closeSession(transport: ISessionTransport): Promise<void> {
    const resource = this.resource;
    if (!resource || !transport.cookies()) {
      // No address to send it to, or no cookie to prove the session is ours —
      // holding the cookie is the whole permission.
      return;
    }

    const csrf = transport.csrfToken();
    try {
      const auth = await transport.authHeaders();
      await transport.send({
        method: 'DELETE',
        url: new URL(resource, transport.baseUrl).toString(),
        headers: {
          ...auth,
          Cookie: mergeCookieHeaders(
            auth.Cookie,
            transport.cookies() ?? undefined,
          ),
          'x-sap-security-session': 'use',
          // A state change, so the server wants the token. Without one the
          // request is refused with 403 — which is still just a message the
          // server did not accept, and still not something to raise from a
          // teardown.
          ...(csrf ? { 'x-csrf-token': csrf } : {}),
        },
      });
      this.logger?.debug('Told the server the security session is finished');
    } catch (error) {
      this.logger?.debug(
        `Could not tell the server the session is finished: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * The `securitysession` link's href, by its `rel` rather than by position.
   *
   * The document carries three links — the session, the logoff resource and
   * system information — and their order is not a contract.
   */
  private securitySessionHref(body: unknown): string | undefined {
    if (typeof body !== 'string') return undefined;
    for (const link of body.matchAll(/<[^>]*link\b([^>]*)>/g)) {
      const attrs = link[1];
      const rel = attrs.match(/\brel="([^"]*)"/)?.[1];
      if (rel !== SECURITY_SESSION_REL) continue;
      const href = attrs.match(/\bhref="([^"]*)"/)?.[1];
      if (href) return href;
    }
    return undefined;
  }
}
