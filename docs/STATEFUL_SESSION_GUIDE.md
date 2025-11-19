# Stateful Session Guide (Connection Layer)

This document explains how `@mcp-abap-adt/connection` manages HTTP-level session state for SAP ADT requests.  
Read it together with:

- [`../README.md`](../README.md) – package overview
- [`../../doc/architecture/STATEFUL_SESSION_GUIDE.md`](../../doc/architecture/STATEFUL_SESSION_GUIDE.md) – MCP server/handler usage
- [`../../adt-clients/docs/STATEFUL_SESSION_GUIDE.md`](../../adt-clients/docs/STATEFUL_SESSION_GUIDE.md) – Builder/high-level client perspective

---

## Session Responsibilities

- Fetch and cache CSRF token (per connection instance)
- Store/reuse SAP cookies (`SAP_SESSIONID`, `sap-usercontext`, etc.)
- Optionally persist session state via `ISessionStorage`
- Provide helper APIs for exporting/importing session snapshots

The connection layer **does not** decide when to lock/unlock objects—that logic lives in the ADT clients. Instead it ensures every request shares the same HTTP session when desired.

---

## Enabling Stateful Sessions

```ts
import { createAbapConnection, FileSessionStorage } from '@mcp-abap-adt/connection';

const connection = createAbapConnection(config, logger);
const storage = new FileSessionStorage('/tmp/sap-sessions');

await connection.enableStatefulSession('session-id-123', storage);
```

1. **`enableStatefulSession`**
   - Loads stored cookies + CSRF token (if present).
   - Marks the connection as *stateful*; subsequent requests reuse the same HTTP session.
2. **`disableStatefulSession`**
   - Clears in-memory CSRF/cookie state and stops persisting updates.

### Session Storage Interface

```ts
export interface ISessionStorage {
  save(sessionId: string, state: SessionState): Promise<void>;
  load(sessionId: string): Promise<SessionState | null>;
  delete(sessionId: string): Promise<void>;
}
```

`SessionState` contains:

- `csrfToken`
- `cookies`
- `createdAt` / `updatedAt`

Implementations can target files, databases, Redis, etc.

---

## Exporting & Importing Session State

```ts
const state = connection.getSessionState();   // { cookies, csrfToken }
// Persist state manually or share with another process
connection.setSessionState(state);
```

- Use when handlers need to transfer a session to another worker.
- Useful for CLI tools that need to resume a previous session without refetching CSRF tokens.

---

## Request Hooks

Every ADT request issued through `makeAdtRequest` automatically:

1. Ensures a CSRF token is available (`HEAD ...` with `x-csrf-token: fetch` if missing).
2. Adds the cached token + cookies to headers.
3. Updates stored cookies if SAP returns `set-cookie`.
4. Retries once when CSRF token is invalid/expired.

This logic is transparent to callers (Builders, handlers, CLI scripts).

---

## Interaction With ADT Clients

- Builders receive the `AbapConnection` instance and optionally a `sessionId`.
- `@mcp-abap-adt/connection` keeps the HTTP session alive; Builders keep the ADT session (`sap-adt-connection-id`) consistent.
- When a test or handler needs to resume a workflow, it should restore both:
  1. `connection.setSessionState(savedState)` (HTTP layer)
  2. Pass the previous `sessionId` to the Builder/LockClient (ADT layer)

---

## Troubleshooting

- **CSRF token errors**: call `connection.reset()` to clear cookies/token and start fresh.
- **Session expired**: re-run `enableStatefulSession` or reauthenticate to obtain a new session.
- **Multiple connections**: each `createAbapConnection` instance maintains its own cookie jar; share the instance if you need continuity.

---

## Related Docs

- [`../../doc/architecture/STATEFUL_SESSION_GUIDE.md`](../../doc/architecture/STATEFUL_SESSION_GUIDE.md) – server workflow
- [`../../adt-clients/docs/STATEFUL_SESSION_GUIDE.md`](../../adt-clients/docs/STATEFUL_SESSION_GUIDE.md) – Builder workflow
- [`CUSTOM_SESSION_STORAGE.md`](./CUSTOM_SESSION_STORAGE.md) – Implementing `ISessionStorage`

