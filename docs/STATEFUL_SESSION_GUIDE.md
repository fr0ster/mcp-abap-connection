# Stateful Session Guide (Connection Layer)

This document explains how `@mcp-abap-adt/connection` manages HTTP-level session state for SAP ADT requests.

---

## Session Responsibilities

- Fetch and cache CSRF token (per connection instance)
- Store/reuse SAP cookies (`SAP_SESSIONID`, `sap-usercontext`, etc.)
- Provide helper APIs for exporting/importing session snapshots

The connection layer **does not** decide when to lock/unlock objects—that logic lives in the ADT clients. Instead it ensures every request shares the same HTTP session when desired.

---

## Enabling Stateful Sessions

```ts
import { createAbapConnection } from '@mcp-abap-adt/connection';

const connection = createAbapConnection(config, logger);

// Enable stateful session mode (adds x-sap-adt-sessiontype: stateful header)
connection.setSessionType('stateful');

// Now all requests share the same session (cookies, CSRF token)
await connection.makeAdtRequest({ method: 'GET', url: '/sap/bc/adt/discovery' });

// Switch back to stateless
connection.setSessionType('stateless');
```

---

## Exporting & Importing Session State

```ts
const state = connection.getSessionState();   // { cookies, csrfToken, cookieStore }
// Persist state manually or share with another process
connection.setSessionState(state);
```

- Use when handlers need to transfer a session to another worker.
- Useful for CLI tools that need to resume a previous session without refetching CSRF tokens.
- See [SESSION_STATE.md](./SESSION_STATE.md) for detailed examples.

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
- `@mcp-abap-adt/connection` keeps the HTTP session alive; Builders keep the ADT session consistent.
- When a test or handler needs to resume a workflow, it should restore both:
  1. `connection.setSessionState(savedState)` (HTTP layer)
  2. Pass the previous `sessionId` to the Builder/LockClient (ADT layer)

---

## Troubleshooting

- **CSRF token errors**: call `connection.reset()` to clear cookies/token and start fresh.
- **Session expired**: reauthenticate to obtain a new session.
- **Multiple connections**: each `createAbapConnection` instance maintains its own cookie jar; share the instance if you need continuity.

---

## Related Docs

- [SESSION_STATE.md](./SESSION_STATE.md) – Manual session state management

