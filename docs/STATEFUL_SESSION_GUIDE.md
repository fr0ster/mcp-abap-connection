# Stateful Session Guide (Connection Layer)

> **The header is not what tracks your lock.** `setSessionType('stateful')` sets
> the mode for subsequent requests; HTTP uses it to select the session header
> and context cookie. Another handler can flip it back while your lock is open. Nothing in this
> layer tracks locks: that belongs to `@mcp-abap-adt/adt-clients`, which holds the
> handles and pairs each LOCK with its UNLOCK per object. What the connection
> offers is `beginCriticalSection()` / `endCriticalSection()`, so a short timeout
> cannot abort a request mid-span. See
> [USAGE.md — Session Lifecycle](./USAGE.md#session-lifecycle).


This document explains how `@mcp-abap-adt/connection` manages HTTP-level session state for SAP ADT requests.

---

## Session Responsibilities

- Fetch and cache CSRF token (per connection instance)
- Store/reuse SAP cookies (`SAP_SESSIONID`, `sap-usercontext`, etc.)
- Track WHICH SAP session a connection is in, and refuse to work once it is lost

The connection layer **does not** decide when to lock/unlock objects—that logic lives in the ADT clients. Instead it ensures every request shares the same HTTP session when desired.

---

## HTTP context isolation (9.3.1)

The authentication session (`SAP_SESSIONID`) and the stateful ABAP context
(`sap-contextid`) have different roles. HTTP requests keep authentication
cookies and the CSRF token in either mode. Only stateful requests carry
`sap-contextid`; the jar retains it while stateless requests run so that a
later UNLOCK can still reach the context holding the lock.

Use stateful mode for LOCK and UNLOCK, and stateless mode for the intervening
GET and PUT. Passing a lock handle to PUT does not require the context cookie.
The ADT clients choose these modes; callers using connectors directly must
choose the mode for each operation themselves.

Before 9.3.1, the whole jar went out even in stateless mode. After LOCK, a PUT
therefore ran in the lock's context. Package updates on E19 (BASIS 816) failed
on the second write with **400 PAK/058, “Package … is already locked”**, and a
subsequent delete failed too. On E98 (BASIS 756), PUT failed with **423,
“Resource … is not locked (invalid lock handle)”**. Filtering the context
cookie allowed two updates and a delete on one connection on both systems.
The filter also applies to cookies supplied in request headers and retries.

| Transport | Stateful request |
| --- | --- |
| HTTP (on-prem / cloud) | Sends `x-sap-adt-sessiontype: stateful` and the context cookie, when held |
| Legacy on-prem HTTP | Keeps the context cookie but omits the session-type header |
| RFC | Uses the persistent conversation for stateful requests; since 9.3.4 resets a kept stateless conversation between calls when supported |

A caller-supplied stateful header is also recognized, including by the legacy
HTTP transport before it removes that header. Custom `IAdtTransport`
implementations must read `request.stateful`; the connection no longer adds
`x-sap-adt-sessiontype` itself. The cookie fix was verified on E19 and E98;
BASIS 7.40 and ABAP Cloud were not integration-tested for this change.

## RFC conversation isolation (9.3.2–9.3.4)

Stateful requests, including LOCK and UNLOCK, share the conversation opened
by `connect()`. Since 9.3.4, `sap-rfc-lite` 0.2.0 and newer let stateless calls
reuse a second conversation: the transport resets its ABAP server context after
each call, keeping the RFC logon open. With older clients (0.1.x), or when a
resettable conversation is busy, each stateless call gets a separate temporary
conversation. Both `setSessionType('stateful')` and a caller-supplied stateful
session header select the persistent conversation.

Previously all RFC requests shared one ABAP session. On E19, saving a package
left state in `CL_PACKAGE`'s instance buffer: later writes or deletes failed
with **400 PAK/058, “Package … is already locked”**. Reading immediately after
creation could fail with **400 SADT_RESOURCE/007**. With separate conversations,
create, read, two lock/PUT/unlock rounds and delete passed on one connection.

When using `sap-rfc-lite` 0.1.x, each stateless call pays for an RFC logon:
about 0.5 s on E19, in addition to about 0.1 s for the call. With 0.2.0+, a
resettable call took about 0.24 s total on E19. Direct connector users must mark
LOCK and UNLOCK stateful to retain their conversation. If disconnect occurs
while a temporary conversation is logging on, it is closed without sending
the request; reconnect does not revive that pending request.

## Enabling Stateful Sessions

Every example below builds on this much, so it is stated once:

```ts
import type { SapConfig } from '@mcp-abap-adt/connection';

const config: SapConfig = {
  url: 'https://your-sap-server.com',
  authType: 'basic',
  username: 'your-username',
  password: 'your-password',
  client: '100',
};
const user = config.username!;
const pass = config.password!;
const logger = console;
```

```ts
import {
  AdtOnPremConnector,
  BasicAuthProvider,
  OnPremHttpTransport,
  getTimeout,
} from '@mcp-abap-adt/connection';

const connection = new AdtOnPremConnector(
  config,
  new BasicAuthProvider(config.username!, config.password!),
  new OnPremHttpTransport(() => ({}), logger, {
    client: config.client,
    baseUrl: config.url,
  }),
  logger,
);
await connection.connect();   // required before any request

// Enable the stateful HTTP context (session header and context cookie)
connection.setSessionType('stateful');

// Following requests use the stateful context until the mode is changed
await connection.makeAdtRequest({ method: 'GET', url: '/sap/bc/adt/discovery' , timeout: getTimeout('default') });

// Switch back to stateless
connection.setSessionType('stateless');
```

---

## Knowing Which Session You Are In

```ts
import { AdtOnPremConnector, BasicAuthProvider, OnPremHttpTransport } from '@mcp-abap-adt/connection';

// getSessionIdentity() is on the HTTP connection classes, NOT on the
// bare IAbapConnection type a caller may hand you.
const connection = new AdtOnPremConnector(config, new BasicAuthProvider(user, pass), new OnPremHttpTransport(() => ({}), logger, { client: config.client, baseUrl: config.url }), logger);
await connection.connect();

// Which SAP session this connection is talking to. Changes only when the
// session itself is replaced — the CSRF cookie is deliberately excluded, since
// it rotates on a token refresh within one and the same session.
const identity = connection.getSessionIdentity();   // e.g. 'SAP_SESSIONID_A4H_001=...'
```

Exporting and importing session state is **not** part of this package: the
methods that once did it were removed in 0.2.0, and persistence belongs to
[`@mcp-abap-adt/auth-broker`](https://www.npmjs.com/package/@mcp-abap-adt/auth-broker).

Handing a session to another worker, or resuming one in a CLI tool, therefore
goes through that package — and whatever it restores, the locks do not come
back with it: a lock handle from a session this connection did not open is
dead, and the connection says so rather than letting you use it.

---

## Request Hooks

Every ADT request issued through `makeAdtRequest` automatically:

1. Ensures a CSRF token is available (`HEAD ...` with `x-csrf-token: fetch` if missing).
2. Adds the cached token + cookies to headers.
3. Updates stored cookies if SAP returns `set-cookie`.
4. Retries once when CSRF token is invalid/expired.

This logic is transparent to callers (Builders, handlers, CLI scripts).

On a JWT connection a 401 is **not** handled here at all, and that is the point: since 6.0.0 the
refusal surfaces and the session is left alone. Nothing replaces the credential behind you, so
nothing replaces the SAP session behind you either — a lock window is not torn down by an
authentication answer. A 403 never did this: it is an authorization answer, not a credential one.

If you decide the refusal meant a stale token, `renew()` and reconnect are yours to call — and a
reconnect is a NEW session, so do it outside a lock window rather than inside one.

**Wait for the goodbye before opening the next one.** `disconnect()` dispatches the logoff and does
not await it, so a reconnect otherwise opens the next session while the previous one's goodbye is
still being assembled, and the server keeps both:

```typescript
await conn.disconnect();
await conn.flushGoodbye();   // give the goodbye its budget to finish first
await conn.connect();
```

Measured on E19 through a harness that recycled the session after each test: a new ABAP session
every one to two seconds for a whole run, none released, each living to its own thirty-minute idle
timeout. The budget bounds the waiting, not the overlap — if the goodbye finishes in time there is
none, and if it does not you proceed while it stays outstanding. Calling `disconnect()` again is not
a substitute: a repeat call does not wait either.

---

## Interaction With ADT Clients

- Builders receive the `AbapConnection` instance and optionally a `sessionId`.
- `@mcp-abap-adt/connection` keeps the HTTP session alive; Builders keep the ADT session consistent.
- A workflow cannot be resumed by restoring HTTP state into this package: the
  methods that once did that were removed in 0.2.0. Establish a session with
  `connect()` and take the locks again — a lock handle from a previous session
  is dead, and the connection will say so with `ADT_SESSION_REPLACED` rather
  than let you use it.

---

## What This Layer Actually Solves

The link to the ABAP session is not guaranteed, and that is the whole problem:

- the ABAP session can be terminated by the system while this client still
  believes it has one — the next lock-bound request answers
  `400 "Session not found"`;
- or it is never created at all, because the system will not open another one
  for this user right now.

Both are reported, neither is worked around. `connect()` fails with the reason
when no session was opened; a session lost afterwards surfaces as
`ADT_SESSION_REPLACED` rather than a request quietly continuing somewhere it
does not belong. What to do about either — wait, retry, reconnect, release
sessions the user still holds, carry on read-only — is the caller's decision,
made with the cookies and the answers in hand.

## A Lock Lives In The ABAP Session

### Three lifetimes, and a dropped connection ends none of them

Before anything else, because conflating these is the mistake that produces
wrong fixes:

| | what it is | what ends it |
|---|---|---|
| **the connection** | one TCP socket | you, the network, a timeout firing. **Ends nothing on the server** |
| **the HTTP session** | the ICF conversation, held by the cookie jar on this side | dropping the cookies, or a logoff. Nothing about it is in doubt |
| **the ABAP session** | the authentication session named by `SAP_SESSIONID_<SID>_<CLIENT>`; `sap-contextid` separately addresses the stateful ABAP context | **only the server.** Its own idle timeout, which this side can neither read nor influence, or an explicit logoff |
| **the lock** | an enqueue entry, **owned by the ABAP session** | that ABAP session ending. **When it goes, its locks go with it** |

The two middle rows are the ones worth keeping apart, because everything that
goes wrong here goes wrong between them. The lock does not belong to the socket
and does not belong to the cookies — it belongs to the **ABAP session**, and
that session is the server's. This side never ends one: it can ask (a logoff),
and otherwise waits for a timeout it cannot see.

A closed socket is just a client that stopped listening. The ABAP session
neither knows nor cares — which is why `SM04` shows sessions left behind by
connections that never said they were finished, and why this package sends an
explicit goodbye at all.

And **a lock is never stranded by something dying** — the opposite. If the ABAP
session ended, the enqueue entry went with it and there is nothing left to
strand. A lock is stranded when that session **survives** while the caller no
longer holds the handle needed to unlock it: both sit there, held, until the
server's own timeout releases them together.

This is what makes an aborted request expensive, and it is not what it looks
like. Aborting costs you **knowledge**, not a session: whether the modification
was applied becomes unknowable, and the handle `unlock` needs is gone, while the
lock is still very much held. That — not any teardown — is why
`beginCriticalSection()` raises the effective timeout to a large ceiling for the
duration of a `lock → modify → unlock` chain.

Since 8.0.0 you reach it through the contract rather than the class: it is
`ICriticalSection` in `@mcp-abap-adt/interfaces-adt-connection`, which this connection declares.
What it promises is narrow and worth stating exactly — inside a section the
*ordinary* per-request deadline does not apply. Not that no request can be cut
short: the ceiling is `SAP_TIMEOUT_CRITICAL`, ten minutes by default, and a
socket ends a request whatever a contract says.

### Two sessions, and they are not the same thing

There are two sessions here, and they are not the same thing:

- the **HTTP session** — the conversation this client is having. It exists as
  long as the cookies do, and nothing about it is in doubt;
- the **ABAP session** — named by `SAP_SESSIONID_<SID>_<CLIENT>`, and the thing
  locks are bound to.

The doubt is only ever about the second. It may not have been created, or it may
have been terminated while this client still holds the cookies and believes it
has one — and a lock is dead in either case, whether or not the client noticed.

Two ways to lose one, and they are different problems:

- **The server never opened one.** No `SAP_SESSIONID` came back, so there is no
  ABAP session known to this connection and nothing a lock could be bound to —
  while the HTTP side is perfectly fine, which is why it does not look like a
  failure at all. `connect()` refuses rather than handing back a connection
  whose first lock would be dead on arrival. Sessions are limited per user and shared with every other tool
  logged on as them, so this says nothing about your code — it says the system
  would not open another one right now.
- **It timed out while you were quiet.** The timeout is an idle one, and it is
  the *silence* that spends it, not the elapsed time. Measured on an on-prem
  system with a 30-minute window: a small request once a minute kept one session
  alive for 45 minutes with its identity unchanged, straight past the mark.

So a long chain under a lock is safe while it is doing something, and at risk
while it waits. **Any request in the session resets the window** — a poll, a
read, a status check. There is deliberately no keepalive timer in this package:
holding a session alive means holding a scarce, shared slot, and deciding to do
that belongs to the caller who knows why the session is worth keeping.

**The cookies are the session.** Nothing else ties a caller to one, so a second
connection given the same cookie jar works in the same ABAP session and can use
the locks taken in it — that is what makes handing them over a way to continue
someone else's work. It cuts both ways: `disconnect()` ends the session for
everyone holding those cookies, not just for the object it was called on, and no
connection can see the copies. Deciding who may hold them, and who is allowed to
close, belongs to whoever passes them around.

The server never tells the client how long it has: the session cookie carries no
expiry and no response header mentions one. The only honest signals are the ones
you get by asking — `getSessionIdentity()` for which session you are in, and
`ADT_SESSION_REPLACED` when the one you were in is gone.

## Troubleshooting

- **CSRF token errors**: discard the session and establish a new one. That is
  `disconnect()` followed by `connect()` — there is no local-only discard, because
  dropping the cookie leaves the ABAP session open on the server. Both live on
  the HTTP connection classes and are **not** on the `IAbapConnection` type
  a bare `IAbapConnection` carries — reach them through a connector type, or
  through the `ISessionLifecycleAware` atom:

  ```ts
import { AdtOnPremConnector, BasicAuthProvider, OnPremHttpTransport } from '@mcp-abap-adt/connection';

  const connection = new AdtOnPremConnector(config, new BasicAuthProvider(user, pass), new OnPremHttpTransport(() => ({}), logger, { client: config.client, baseUrl: config.url }), logger);
  await connection.disconnect(); // ends the session on the server, then clears
  await connection.connect(); // a new session, explicitly
  ```
- **Session expired**: reauthenticate to obtain a new session.
- **Multiple connections**: each connector holds its own wire, and the wire holds the cookie jar; share the instance if you need continuity.

---

## Related Docs

- [USAGE.md — Session Lifecycle](./USAGE.md#session-lifecycle) – connect/disconnect, lock windows, a lost session
- [MIGRATION-2.0.md](./MIGRATION-2.0.md) – what the explicit lifecycle changed for callers

