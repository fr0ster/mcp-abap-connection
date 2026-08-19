# Stateful Session Guide (Connection Layer)

> **The header is not what tracks your lock.** `setSessionType('stateful')` sets
> a per-request header and nothing more — another handler can flip it back while
> your lock is genuinely open, and a batch never sets it at all. Nothing in this
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

## Enabling Stateful Sessions

```ts
import { createAbapConnection } from '@mcp-abap-adt/connection';

const connection = createAbapConnection(config, logger);
await connection.connect();   // required before any request

// Enable stateful session mode (adds x-sap-adt-sessiontype: stateful header)
connection.setSessionType('stateful');

// Now all requests share the same session (cookies, CSRF token)
await connection.makeAdtRequest({ method: 'GET', url: '/sap/bc/adt/discovery' });

// Switch back to stateless
connection.setSessionType('stateless');
```

---

## Knowing Which Session You Are In

```ts
import { BaseAbapConnection } from '@mcp-abap-adt/connection';

// getSessionIdentity() is on the HTTP connection classes, NOT on the
// IAbapConnection type that createAbapConnection() returns.
const connection = new BaseAbapConnection(config, logger);
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

On a JWT connection one case is **not** transparent, and cannot be: a 401 that leads to a token
refresh also replaces the SAP session, because the renewed credential cannot keep the old one.
Inside a lock window that surfaces as `ADT_SESSION_REPLACED` rather than a request quietly
continuing on a session your lock is not in. A 403 never does this — it is an authorization
answer, not a credential one, and nothing is torn down for it.

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

## Troubleshooting

- **CSRF token errors**: discard the session and establish a new one. That is
  `disconnect()` followed by `connect()` — there is no local-only discard, because
  dropping the cookie leaves the ABAP session open on the server. Both live on
  the HTTP connection classes and are **not** on the `IAbapConnection` type
  `createAbapConnection()` returns — reach them through a concrete type:

  ```ts
  import { BaseAbapConnection } from '@mcp-abap-adt/connection';

  const connection = new BaseAbapConnection(config, logger);
  await connection.disconnect(); // ends the session on the server, then clears
  await connection.connect(); // a new session, explicitly
  ```
- **Session expired**: reauthenticate to obtain a new session.
- **Multiple connections**: each `createAbapConnection` instance maintains its own cookie jar; share the instance if you need continuity.

---

## Related Docs

- [USAGE.md — Session Lifecycle](./USAGE.md#session-lifecycle) – connect/disconnect, lock windows, a lost session
- [MIGRATION-2.0.md](./MIGRATION-2.0.md) – what the explicit lifecycle changed for callers

