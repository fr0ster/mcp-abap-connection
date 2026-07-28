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

### 3. Requests are refused after a teardown

`disconnect()` and `reset()` stop the connection from serving requests until
the next `connect()`. An in-flight request is not cut off: a teardown drains
before it clears anything.

### 4. If you hold locks, tell the connection

Available on the HTTP connection classes; see the availability note in
[USAGE.md — Session Lifecycle](./USAGE.md#session-lifecycle).

```typescript
const token = connection.beginWindow('Class/ZCL_MY_CLASS');

let lockHandle: string | undefined;
try {
  lockHandle = await lock(connection, 'ZCL_MY_CLASS');
} catch (error) {
  connection.endWindow(token);   // confirmed NOT locked: nothing is held
  throw error;
}

try {
  await update(connection, 'ZCL_MY_CLASS', lockHandle);
  await unlock(connection, 'ZCL_MY_CLASS', lockHandle);
  connection.endWindow(token);   // confirmed unlocked: the lock is released
} catch (error) {
  // Left open on purpose: the unlock may have failed, never gone out, or come
  // back with an unknown outcome. Do NOT use a finally here.
  throw error;
}
```

You are not required to use windows at all. Without them a teardown cannot know
a lock is open, so it will not wait for your unlock and will not report the lock
if it gives up — it simply tears down, and the object stays locked on the server.

But do not open a window and forget to close it on success: every later teardown
then waits out `SAP_TIMEOUT_CRITICAL` before reporting it as abandoned.

### 5. A new error you should handle

`ADT_SESSION_REPLACED` means the SAP session is gone. It is raised when a
replacement happens **while you hold a lock window**, and whenever the server
itself says the session no longer exists — that second case regardless of any
window. **Your lock handle is dead**: unlocking with it will not work, and the
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
