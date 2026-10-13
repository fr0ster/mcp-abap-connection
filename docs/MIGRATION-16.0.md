# Migration to 16.0

16.0.0 makes this package answer for what [SCOPE.md](./SCOPE.md) lists, and for
nothing else. For a consumer on 15.x that means the following.

## What changed

- **`signal` is gone from request options.** This matches
  `@mcp-abap-adt/interfaces-adt-connection` 3.0.0, which drops
  `IAbapRequestOptions.signal`, `ADT_REQUEST_ERROR` and `AdtRequestErrorCode`.
  No request rejects with `ADT_REQUEST_ABORTED` any more. A request behaves as
  it did in 15.0.1: once admitted, it runs to its answer or its `timeout`.
  `IAdtTransportRequest.signal` and `IAdtEstablishContext.signal` are gone
  from the transport seam. Measured on E19 (BASIS 816, 2026-10-12): ABAP
  neither cancels a request that reached it nor rolls back across requests,
  and a logoff releases the locks — so the signal protected nothing.
- **One connection instance is one SAP session.** The instance is spent after
  `disconnect()`, after a failed `connect()` that logged off the session it
  had received, or after a lost session: `ADT_SESSION_REPLACED`, raised
  exactly as in 15.0.1 for a changed `SAP_SESSIONID` or a 400 "session not
  found". On a spent instance, `connect()` and every request reject
  `ADT_SESSION_ERROR.NOT_CONNECTED`. The connector decides nothing beyond
  that; what to do next is yours.
  - On a spent instance, `connect()` rejects with
    `ADT_SESSION_ERROR.NOT_CONNECTED`: "This connection's SAP session has
    ended (it was disconnected, logged off or lost); one connection instance is one
    session. Create a new connection for a new session."
  - A failed `connect()` that sent nothing (a 401, a network error, no session
    cookie) leaves the instance usable, and `connect()` may be retried.
- **`disconnect()` resolves once the logoff is written.** It resolves when the
  bytes are handed to the socket over HTTP, or when the close call has
  returned over RFC. It does not wait for SAP's answer, and it never throws.
  - **Call it once per `connect()`.** A second call rejects with
    `ADT_SESSION_ERROR.NOT_CONNECTED` ("disconnect() was already called for
    this connection; call it once per connect()"), whether it comes while the
    first is still writing or after it. The first call is unaffected.
  - No timer bounds the write. A server that never takes the bytes holds
    `disconnect()` until the socket fails. That failure is logged, not thrown.
  - **"Written" means handed to the operating system.** The logoff goes out
    on a connection of its own over HTTP. Over HTTPS this holds while your
    `agentOptions` leave `keepAlive` off.
  - **Over RFC, the close waits for a call still running on its
    conversation.** In `@mcp-abap-adt/sap-rfc-lite` 0.2.2, a call holds the
    client's invocation mutex until it returns, and `close()` takes the same
    mutex.
- **When the logoff is sent.** It is sent if and only if the instance holds
  a live `SAP_SESSIONID_*` that it received: not one deleted by a past
  `expires` or `Max-Age=0`.
  - A `connect()` that fails as a whole after the server opened a session (a
    cloud preflight's, or a 403/404 after logon on both discovery endpoints)
    logs it off, and rejects only once the logoff is written.
  - A 404 on core discovery alone is not a failure: the fallback runs in the
    same session.
  - A 401, or a 200 with only `sap-XSRF_*`, has no session, so nothing is
    sent.
  - The logoff never carries `sap-contextid`. Measured on E19 (2026-10-13), a
    logoff carrying a stale one got 400 and closed nothing, while one without
    it ended the context and released its lock.
  - A redirect answering the logoff counts as its answer: it is not
    followed.
- **`flushGoodbye(timeoutMs?)` has no default bound.** Without an argument it
  waits for SAP's answer to the logoff for as long as it takes. With
  `timeoutMs` it waits at most that long and returns without throwing.
- **`IAdtTransport.close(context, written?)`**: a wire reports the write by
  calling `written`. `disconnect()` resolves at the first of `written()` and
  the close settling.

## What a consumer must do

- **Build connections with `createConnection(spec)`** (recommended). You state
  `system` and `transport` (`cloud`+`http`, or `onprem` with `http`,
  `legacy-http` or `rfc`). The factory builds the matching connector and wire
  and passes your transport options through. It returns a new instance on
  every call. The constructors still work.
- **Drop `signal`** from the options passed to `makeAdtRequest`, and drop any
  check for `ADT_REQUEST_ERROR` or `'ADT_REQUEST_ABORTED'`.
- **Call `disconnect()` once.** If more than one path in your code can end a
  connection, such as a `finally` and a signal handler, let one of them own
  the call, or catch the second call's rejection.
- **A process about to exit awaits `disconnect()`.** Once it resolves, the
  logoff has left:
  ```typescript
  await connection.disconnect();
  process.exit(0);
  ```
- **A new session is a new instance, and creating it is yours.** Use your
  own factory or `createConnection`. Anywhere you called `connect()` again on
  an instance after `disconnect()`, create a new connection instead.
- **`flushGoodbye()` no longer gives up after 5 s.** If you need a bound,
  pass one: `flushGoodbye(5000)`.
- **Await `flushGoodbye()` as well if SAP's answer matters**, for example
  before a new connection connects, so that the server never holds two
  sessions:
  ```typescript
  await connection.disconnect();
  await connection.flushGoodbye();
  const next = createYourConnection();
  await next.connect();
  ```
- **A custom transport** (`IAdtTransport`) whose `close()` stays pending long
  after its goodbye has left should call the new `written` argument at that
  point. Otherwise `disconnect()` waits for the close to settle.
