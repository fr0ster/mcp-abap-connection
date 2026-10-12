/**
 * ABAP Cloud over HTTP: the wire where a session is a resource with an address.
 *
 * Asked for at `/sap/bc/adt/core/http/sessions` with `x-sap-security-session:
 * create` and `sap-adt-purpose: preflight_logon`, and given back through the
 * logoff resource the same answer links to. Reproduced from Eclipse ADT 3.60 and
 * measured against a BTP trial: without that request the same connection gets
 * `sap-usercontext` and `sap-XSRF_*` and no session for a lock to be bound to,
 * which is how "cloud issues no SAP_SESSIONID" came to be believed.
 *
 * **Not by `DELETE` on the session's own address.** The resource ends a session
 * only when the address names a DIFFERENT one than the request runs in — a new
 * session ending an old one — and otherwise answers `200` having done nothing.
 * Measured on a BTP trial (2026-10-12): after that `DELETE` the session's cookie
 * alone was still accepted, at once and 30 s later; after the logoff it was
 * refused with `401` at once, and so was a session whose address another
 * session sent the `DELETE` for.
 *
 * **Taking this transport is the consumer saying which system it is dialling.**
 * Nothing here asks the server what it is. The strategy this replaces treated a
 * 404 on the session resource as "then this must be on-prem" and quietly fell
 * back to the platform logoff — an inference, and the only one left in this
 * layer. A consumer that reaches an on-prem system with this transport has
 * taken the wrong one, and finds out rather than being silently downgraded.
 */

import { mergeCookieHeaders } from '../utils/cookies.js';
import { getTimeout } from '../utils/timeouts.js';
import { AuthRefusedError } from './authErrors.js';
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

const LOGOFF_REL =
  'http://www.sap.com/adt/categories/core/http/sessions/logoff';

export class CloudHttpTransport
  extends HttpTransport
  implements ICloudTransport
{
  override readonly kind = 'cloud-http';

  /** Which system this wire is for. Read by the compiler, never at runtime. */
  readonly system = 'cloud' as const;

  /**
   * `x-sap-security-session: use` — on every request, once there is a session.
   *
   * ABAP Cloud issues its session as a resource asked for at
   * `/sap/bc/adt/core/http/sessions`, and Eclipse then names it on everything
   * that follows rather than relying on the cookie alone. Measured from ADT
   * 3.60.3 against a BTP trial: a plain
   * `GET …/businessservices/odatav4/ZAC_SRVB01` carries it, and so does
   * `POST …/unpublishjobs` — a read and a write, both stateless, both saying
   * `use`.
   *
   * Only when a session exists: saying `use` with nothing to use is a claim
   * about state this wire is not in, and `create` is the request that makes one.
   *
   * On-prem is left alone deliberately. Its session arrives with the logon and
   * there is no trace of Eclipse sending this there, so adding it would be a
   * guess wearing a measurement's clothes.
   */
  protected override sessionHeaders(): Record<string, string> {
    return this.sessionEstablished() ? { 'x-sap-security-session': 'use' } : {};
  }

  /** The logoff resource this server linked to beside our session — the close target. */
  private logoff: string | null = null;

  override async open(context: IAdtSessionContext): Promise<void> {
    // The logon, outside the swallowing `try`: a credential that refuses it
    // (`AuthRefusedError`) is the caller's to hear, not a preflight to shrug at.
    await super.open(context);
    try {
      // Authorized ONCE. The contract lets a provider answer differently each
      // time — a token provider renews behind the call — so two calls can
      // build one request out of two different credentials.
      const auth: Record<string, string> = {};
      await context.authorize(auth);
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

      const resource = this.linkHref(response.data, SECURITY_SESSION_REL);
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

      // Published only while its ICF service is active; without it there is
      // nothing that ends this session, and the close says so.
      this.logoff = this.linkHref(response.data, LOGOFF_REL) ?? null;
      this.logger?.debug(`Security session opened: ${resource}`);
    } catch (error) {
      // The provider will not authorize the preflight: its word, not a failed
      // preflight.
      if (error instanceof AuthRefusedError) throw error;
      // Not fatal here. If no session was opened, the establishment that
      // follows says so with the whole picture; an error raised from a
      // preflight would replace that with something less useful.
      this.logger?.debug(
        `Could not open a security session: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  override async close(context: IAdtSessionContext): Promise<void> {
    const logoff = this.logoff;
    this.logoff = null;
    // Read SYNCHRONOUSLY, before the first await. A close is dispatched
    // without being awaited, so the teardown's `forgetSession()` runs while
    // this is suspended — and a goodbye assembled afterwards would carry no
    // cookie, which is the one thing that proves the session is ours to end.
    const cookies = this.cookies();
    // Snapshotted for the same reason: the logoff must reach the server holding
    // this session, not whichever one the wire is pinned to when it goes out.
    const affinity = this.affinityHeaders();
    if (!cookies) {
      // No cookie to prove the session is ours — holding the cookie is the
      // whole permission to end one.
      return;
    }
    if (!logoff) {
      // A session was opened, but the server linked no logoff resource: it
      // stays until the server's own timeout.
      this.logger?.debug(
        'The server published no logoff resource; the security session is left to its timeout',
      );
      return;
    }

    try {
      const auth: Record<string, string> = {};
      await context.authorize(auth);
      // Its answer is not read: it is the same `200` and the same goodbye page
      // for a live session, one already ended and no cookie at all (measured on
      // a BTP trial, 2026-10-12), so it says nothing about THIS session; and
      // when the logoff cannot end one, the reason is an error message whose
      // status the ICF kernel picks, which no ABAP source shows.
      await this.sendDetached({
        method: 'GET',
        url: new URL(logoff, context.baseUrl).toString(),
        headers: {
          ...affinity,
          // Detached, so not dressed: the client is said here in so many
          // words, as on every other request of this wire.
          ...this.clientHeaders(),
          ...auth,
          ...context.extraHeaders,
          Cookie: mergeCookieHeaders(auth.Cookie, cookies),
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
   * A link's href, by its `rel` rather than by position.
   *
   * The document carries three links — the session, the logoff resource and
   * system information — and their order is not a contract.
   */
  private linkHref(body: unknown, wanted: string): string | undefined {
    if (typeof body !== 'string') return undefined;
    for (const link of body.matchAll(/<[^>]*link\b([^>]*)>/g)) {
      const attrs = link[1];
      const rel = attrs.match(/\brel="([^"]*)"/)?.[1];
      if (rel !== wanted) continue;
      const href = attrs.match(/\bhref="([^"]*)"/)?.[1];
      if (href) return href;
    }
    return undefined;
  }
}
