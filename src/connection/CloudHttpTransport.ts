/**
 * ABAP Cloud over HTTP: the wire where a session is a resource with an address.
 *
 * Asked for at `/sap/bc/adt/core/http/sessions` with `x-sap-security-session:
 * create` and `sap-adt-purpose: preflight_logon`, and given back by `DELETE` on
 * the address the server publishes in the answer. Reproduced from Eclipse ADT
 * 3.60 and measured against a BTP trial: without that request the same
 * connection gets `sap-usercontext` and `sap-XSRF_*` and no session for a lock
 * to be bound to, which is how "cloud issues no SAP_SESSIONID" came to be
 * believed.
 *
 * **Taking this transport is the consumer saying which system it is dialling.**
 * Nothing here asks the server what it is. The strategy this replaces treated a
 * 404 on the session resource as "then this must be on-prem" and quietly fell
 * back to the platform logoff — an inference, and the only one left in this
 * layer. A consumer that reaches an on-prem system with this transport has
 * taken the wrong one, and finds out rather than being silently downgraded.
 */

import type { ILogger } from '../logger.js';
import { mergeCookieHeaders } from '../utils/cookies.js';
import { getTimeout } from '../utils/timeouts.js';
import { HttpTransport } from './HttpTransport.js';
import type { IAdtSessionContext, ICloudTransport } from './IAdtTransport.js';

const SESSIONS_PATH = '/sap/bc/adt/core/http/sessions';

/** The versioned media types Eclipse asks this resource for, newest first. */
const SESSION_ACCEPT =
  'application/vnd.sap.adt.core.http.session.v3+xml, ' +
  'application/vnd.sap.adt.core.http.session.v2+xml, ' +
  'application/vnd.sap.adt.core.http.session.v1+xml';

const SECURITY_SESSION_REL =
  'http://www.sap.com/adt/categories/core/http/sessions/securitysession';

export class CloudHttpTransport
  extends HttpTransport
  implements ICloudTransport
{
  override readonly kind = 'cloud-http';

  /** Which system this wire is for. Read by the compiler, never at runtime. */
  readonly system = 'cloud' as const;

  /** The address this server published for our session — the only close target. */
  private resource: string | null = null;

  async open(context: IAdtSessionContext): Promise<void> {
    try {
      // Read ONCE. The contract lets a provider answer differently each time —
      // a token provider renews behind the call — so two reads can build one
      // request out of two different credentials.
      const auth = await context.authHeaders();
      const response = await this.send({
        method: 'GET',
        // The cache-buster is Eclipse's; kept because this must not be served
        // from anything's cache — a cached session document would hand back an
        // address that belongs to a session somebody else already ended.
        url: `${context.baseUrl}${SESSIONS_PATH}?_=${Date.now()}`,
        // Bounded: connect() waits for this one.
        timeout: getTimeout('csrf'),
        headers: {
          ...auth,
          ...context.extraHeaders,
          Accept: SESSION_ACCEPT,
          Cookie: mergeCookieHeaders(auth.Cookie, this.cookies() ?? undefined),
          'sap-adt-purpose': 'preflight_logon',
          'x-sap-security-session': 'create',
        },
      });

      // Its SAP_SESSIONID is the session, so the answer is folded in before
      // anything is read out of it.
      context.observe(response.headers);
      this.ingest(response.headers as Record<string, unknown>);

      const resource = this.securitySessionHref(response.data);
      if (!resource) {
        // Answered, but published no session of its own — so there is no
        // address to give one back by. Said out loud rather than worked
        // around: the establishment that follows reports what a connection
        // without a session means, and this is the fact it will be reporting.
        this.logger?.debug(
          `Session resource answered ${response.status} but published no securitysession link`,
        );
        return;
      }

      this.resource = resource;
      this.logger?.debug(`Security session opened: ${resource}`);
    } catch (error) {
      // Not fatal here. If no session was opened, the establishment that
      // follows says so with the whole picture; an error raised from a
      // preflight would replace that with something less useful.
      this.logger?.debug(
        `Could not open a security session: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async close(context: IAdtSessionContext): Promise<void> {
    const resource = this.resource;
    this.resource = null;
    // Read SYNCHRONOUSLY, before the first await. A close is dispatched
    // without being awaited, so the teardown's `forgetSession()` runs while
    // this is suspended — and a goodbye assembled afterwards would carry no
    // cookie, which is the one thing that proves the session is ours to end.
    const cookies = this.cookies();
    const csrf = this.csrfToken();
    // Snapshotted for the same reason: the DELETE must reach the server holding
    // this session, not whichever one the wire is pinned to when it goes out.
    const affinity = this.affinityHeaders();
    if (!resource || !cookies) {
      // No address to send it to, or no cookie to prove the session is ours —
      // holding the cookie is the whole permission to end one.
      return;
    }

    try {
      const auth = await context.authHeaders();
      await this.sendDetached({
        method: 'DELETE',
        url: new URL(resource, context.baseUrl).toString(),
        headers: {
          ...affinity,
          ...auth,
          ...context.extraHeaders,
          Cookie: mergeCookieHeaders(auth.Cookie, cookies),
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
