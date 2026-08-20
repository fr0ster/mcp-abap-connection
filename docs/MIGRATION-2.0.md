# Migrating to the explicit session lifecycle

The connection now owns its session, and says so. If your code never called
`connect()`, it will fail at startup rather than at the first request — the
better failure, but a new one.

## What breaks, and what to do

### 1. `connect()` is required

```typescript
const connection = createAbapConnection(config, logger);
await connection.connect();          // ← add this
await connection.makeAdtRequest(...);
```

Without it every request is refused with `ADT_NOT_CONNECTED` and nothing
reaches the server.

**Why it changed.** Requests used to establish the session on the fly, which
meant a caller could never tell whether it had a session, whose it was, or
whether the one it locked in was still there. That is what let the connector
replace the session under a caller holding a lock without saying anything.

### 2. `connect()` rejects on failure

It used to log a warning and resolve anyway, deferring the work to the first
request. Now a resolved promise means a usable session exists.

```typescript
try {
  await connection.connect();
} catch (error) {
  // Handle it here, at startup, where it is cheap.
}
```

If you never checked the result of `connect()`, you were relying on that
deferral. The failure has not appeared — it has moved to where you can see it.

**Kerberos**: `connect()` now surfaces a limitation that used to be hidden. If
the server continues the SPNEGO exchange (a 401 carrying a `Negotiate` token),
this client cannot continue it — the GSS context is not retained — and
`connect()` fails saying so. Previously the same situation resolved and failed
later, on the first request, as an unrelated-looking 401.

### 3. Requests are refused after a teardown

`disconnect()` stops the connection from serving requests until the
next `connect()`. An in-flight request is not cut off and not waited for either:
it runs to completion, and its result is fenced so it cannot touch a session
established since.

### 4. If you hold locks, do not let a timeout cut the span

The connection does **not** track your locks. It does not know one exists, what
object it covers, or what would release it — pairing every LOCK with its UNLOCK
belongs to `@mcp-abap-adt/adt-clients`, which holds the handles.

What this layer can do is not let a short timeout abort a request mid-span, which
would leave an operation whose outcome you cannot determine — a `LOCK` that may
have succeeded server-side, with a handle you never received:

```typescript
connection.beginCriticalSection();
try {
  const handle = await lock(connection, 'ZCL_MY_CLASS');
  await update(connection, 'ZCL_MY_CLASS', handle);
  await unlock(connection, 'ZCL_MY_CLASS', handle);
} finally {
  connection.endCriticalSection();
}
```

This is not new in 2.x — it has been available since 1.9.0 and is unchanged.

### 5. A new error you should handle

`ADT_SESSION_REPLACED` means the SAP session is gone. It is raised whenever the
session identity changes under us, and whenever the server itself says the session
no longer exists. **Your lock handle is dead**: unlocking with it will not work, and the
object may still be locked on the server. The connector does not retry such
a request — retrying blindly is what produced further orphaned locks in the
field.

```typescript
// (connection already established)
try {
  await connection.makeAdtRequest(...);
} catch (error) {
  if (error.code === 'ADT_SESSION_REPLACED') {
    // Reconnect, then deal with the lock you can no longer release.
  }
}
```

## What did NOT change

- `makeAdtRequest()` keeps its signature and its behaviour on a healthy session.
- `IAbapConnection` is unchanged: `connect()` was already on it. The rest of the
  lifecycle API lives on the HTTP connection classes for now, so code holding
  the interface type sees no new members and needs no change.
- Automatic recovery still happens: a CSRF token refresh, a 401 retry, a JWT
  refresh. What changed is that a recovery which **replaces the session** while
  you hold a lock now fails loudly instead of continuing on the new one.
- RFC connections already required an open client, so nothing there changes for
  callers.

## What to check on your side

- every place a connection is created — does `connect()` follow it?
- every place `connect()` is called — is its rejection handled?
- error handling around lock/unlock flows — is `ADT_SESSION_REPLACED` handled,
  or does it fall into a generic catch that retries?
