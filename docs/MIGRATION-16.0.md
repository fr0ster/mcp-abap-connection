# Migration to 16.0

16.0.0 makes two breaking changes. It removes the per-request `signal` that
15.1.0 added, and it moves the point at which `disconnect()` resolves: it now
resolves once the logoff is **written**, where before it returned without
waiting for anything.

Both follow from what was measured on an on-premise system (BASIS 816, E19,
2026-10-12):

- ABAP neither cancels a request that has reached it nor rolls back across
  requests, and a connection is never shared between threads. A signal could
  therefore only stop what had not been sent yet, which protects nothing.
- A logoff releases the ENQUEUE locks. Suppose a long request is still
  running in the same stateful ABAP session. SAP queues the logoff behind it
  and answers only afterwards: about 96 s through the connector, and no answer
  in six minutes when sent raw from a second thread. Yet once the logoff has
  arrived, the lock is gone, even when the client was killed with the answer
  still pending.
- A connection dropped without a logoff keeps its locks.
- Checked against the 16.0.0 build on E19 on 2026-10-13:
  - The sequence was a LOCK, then a long where-used in the same stateful
    session, then `await disconnect()`, then the process exiting at once.
    `disconnect()` had resolved with the logoff written, and the logoff
    carried `sap-cancel-on-close: true`.
  - The lock was still held 1 s later, and free about 70 s after the exit,
    long before the 30-minute idle timeout.
  - So ICM ran the queued logoff after the client's connection had closed.

So what a consumer needs at its end is the logoff, sent. It does not need a
signal, and it does not need SAP's answer.

## What changed

- **`signal` is gone from request options.** This matches
  `@mcp-abap-adt/interfaces-adt-connection` 3.0.0, which drops
  `IAbapRequestOptions.signal`, `ADT_REQUEST_ERROR` and `AdtRequestErrorCode`.
  No request rejects with `ADT_REQUEST_ABORTED` any more. A request behaves as
  it did in 15.0.1: once admitted, it runs to its answer or its `timeout`.
- **`IAdtTransportRequest.signal` and `IAdtEstablishContext.signal` are gone**
  from the transport seam.
- **`disconnect()` resolves once the logoff is written**: its bytes are handed
  to the socket over HTTP, or the close call has returned over RFC. It still
  does not wait for SAP's answer, and it still never throws. Waiting for the
  answer remains the job of `flushGoodbye()`.
  - **Call it once per `connect()`.** A second call rejects with
    `ADT_SESSION_ERROR.NOT_CONNECTED` ("disconnect() was already called for
    this connection; call it once per connect()"), whether it comes while the
    first is still writing or after it has settled. Before 16.0 a repeat call
    resolved, and one made while an earlier logoff was still unwritten
    resolved before that logoff left. The first call is unaffected.
  - **A failed `connect()` rejects only after its own goodbye is written, when
    it dispatched one.** A caller that exits on that error does not lose the
    goodbye.
    - Two sessions are involved, and what each claim rests on differs.
    - **The HTTP security session.** This is the ICF session, held in
      `SECURITY_CONTEXT` and named by the cookie
      `SAP_SESSIONID_<SID>_<CLIENT>`. A `connect()` that fails after
      authentication leaves one alive, on cloud and on-prem alike, which is
      why the connector says goodbye to it.
      - Cloud: the preflight opens one (measured on a BTP trial, 2026-10-12).
      - On-prem, measured on E19 (BASIS 816, 2026-10-13): authenticated
        requests that SAP answered with an error each set
        `SAP_SESSIONID_E19_100`. These were a 404 for an unknown ADT
        resource, a 404 for an unknown class and a 403 for `DELETE` on
        discovery. That cookie alone then got 200 on discovery.
      - In E19's ABAP code, `CL_HTTP_SERVER_NET` method `authentication`
        creates it on a successful logon, before any handler runs.
        `send_response` sets the cookie whenever a session was created,
        whatever the status.
      - The ICF logoff (`CL_HTTP_EXT_LOGOFF` →
        `CL_HTTP_SERVER_NET->if_http_server~logoff`) ends it only when that
        cookie is present: `terminate_security_session` deletes
        `SECURITY_CONTEXT`.
      - **The rule:** the logoff is sent if and only if the wire holds a
        non-empty `SAP_SESSIONID_*` cookie it received, whatever the status
        of the answer that brought it. This applies on-prem and on cloud.
        - A 404 or 403 at logon carries the cookie, so it gets a logoff.
        - A 401's debris cookie, or a 200 with only `sap-XSRF_*` (the session
          limit), carries none, so nothing is sent. A logoff then would end
          nothing (ABAP code).
        - Until 16.0.0 the on-prem rule was "established and holding any
          cookie". It was inverted in both cases above.
      - **Deletions count.** A `Set-Cookie` with an expiry in the past, or
        `Max-Age=0`, removes the cookie.
        - SAP's logoff deletes every cookie with a one-character value and
          `expires=Tue, 01-Jan-1980 00:00:01 GMT` (E19 wire trace,
          2026-10-13).
        - So a deleted `SAP_SESSIONID` is no session.
      - **A 404 on `/sap/bc/adt/core/discovery` is not a failed `connect()`.**
        The fallback to `/sap/bc/adt/discovery` runs in the same session, with
        the same `SAP_SESSIONID`. No logoff is sent until `connect()` as a
        whole fails.
    - **The ABAP (application) session.** This is where the stateful context
      and the ENQUEUE locks live; it is addressed by `sap-contextid`.
      - That the logoff ends it rests on two things. One is the comment on the
        kernel module `LocalSessionTermination`, which
        `terminate_security_session` calls: "terminates all taskhandler
        (application) sessions associated with the security context" (in
        `CL_HTTP_SECURITY_SESSION`; the inactivity timeout uses the same
        path). The other is the measurement that the lock is released.
      - That a failed stateful request leaves an ABAP session rests only on the
        `sap-contextid` cookie seen in the 404/403 answers. No ABAP code was
        read for it.
      - A failed `connect()` takes no lock.
    - When no goodbye is dispatched, `connect()` rejects at once, as before.
  - **"Written" means handed to the operating system, not delivered.** Over
    HTTP the logoff goes out on a connection of its own, never on a pooled
    keep-alive socket the server may already have closed. Over HTTPS this holds
    only while your `agentOptions` leave `keepAlive` off. Once the bytes are
    with the operating system, a process that exits leaves the delivery to the
    kernel.
  - **Over RFC, the close waits for a call still running on its
    conversation.** In `@mcp-abap-adt/sap-rfc-lite` (0.2.2), a call holds the
    client's invocation mutex until it returns, and `close()` takes the same
    mutex. So `disconnect()` over RFC resolves only after the running call has
    finished. Over HTTP, the logoff leaves at once.
  - **A redirect answering the logoff counts as an answer.** It is not
    followed, because that would carry the session's cookie on to wherever the
    server points, and it is not logged as a failure.
- No timer bounds the write. A server that never accepts the bytes holds
  `disconnect()` open until the socket fails. That failure is logged, not
  thrown, and `disconnect()` then resolves.
- **`IAdtTransport.close(context, written?)`**: a wire reports the write by
  calling `written`. `disconnect()` resolves at the first of `written()` and
  the close settling.

## When the logoff is sent

1. **`disconnect()`** sends the logoff if and only if the connection holds a
   live `SAP_SESSIONID_*`: one it received, and that no `Set-Cookie` with a
   past `expires` or `Max-Age=0` has deleted since. After a successful
   `connect()` it always does. With only `sap-XSRF_*` it sends nothing.
2. **A failed `connect()`** sends the logoff itself only when both of these
   hold:
   - the whole `connect()` failed, meaning both
     `/sap/bc/adt/core/discovery` and the fallback `/sap/bc/adt/discovery`
     failed;
   - a live `SAP_SESSIONID_*` was received during it. A 403 or 404 after a
     successful logon carries one.

   `connect()` then rejects after the logoff is written. A 401 means there is
   no session, so nothing is sent.
3. **A successful `connect()` (200)** sends no logoff. The session lives
   until `disconnect()`.

### What the rule rests on
Measured on E19 with bare HTTP on 2026-10-13, unless marked otherwise.

- **`SAP_SESSIONID` is the HTTP security session**, created at logon. Each
  logon, even a stateless `/sap/bc/ping`, adds a `SECURITY_CONTEXT` row, and
  the logoff removes it: 6 rows went to 3.
- **`sap-contextid` (`path=/sap/bc/adt`) addresses the ABAP session.** That is
  where the stateful context and the ENQUEUE locks live.
- **From the ABAP code**, `CL_HTTP_SERVER_NET->send_response` sets
  `SAP_SESSIONID` only when the request created a security session, whatever
  the status. An authenticated 404 or 403 carried it, and the session was
  alive.
- **From the ABAP code**, the ICF logoff ends a session only when that cookie
  is present.
- **The logoff deletes every cookie**, each with a one-character value and
  `expires=Tue, 01-Jan-1980 00:00:01 GMT`. The expiry is what deletes it; the
  value is not empty.
- **A request carrying a stale (deleted) `sap-contextid` gets a 400**, and so
  does a logoff that carries one; that logoff then closes nothing.
- **A logoff without `sap-contextid` ends the context and releases its
  lock.** The steps were:
  - LOCK in a stateful context. An independent probe got 403 "currently
    editing".
  - Logoff carrying `SAP_SESSIONID_E19_100` and `sap-usercontext`, but no
    `sap-contextid`. It got 200, and SAP deleted `SAP_SESSIONID`.
  - An independent session then got the LOCK (200).

  So **the logoff never carries `sap-contextid`**, on-prem or cloud. It
  carries only `SAP_SESSIONID_*`, `sap-usercontext` and the affinity it
  needs.
- **After an UNLOCK, the stateful ABAP context lives on**, without locks,
  until the logoff or until a stateless request is sent in that context. The
  connection sends no explicit `X-sap-adt-sessiontype: stateless` after an
  unlock. This is a fact of the documented policy, not a defect.
- **A replaced ABAP session inside a lock window** is `SESSION_REPLACED`, and
  the connection then **logs the security session off at once**, before
  forgetting its cookies. That ends every context of the session, including
  the old one with its locks. The caller's `disconnect()` that follows is the
  first of that life: it resolves once that logoff is written and sends
  nothing more, and `flushGoodbye()` waits for the logoff's answer.
- **One connection instance is one SAP session.** Once a session has
  ended, the instance is spent. That happens after `disconnect()`, after
  `SESSION_REPLACED` (which sends its own logoff), and after a failed
  `connect()` that logged off a session it had received.
  - On a spent instance, `connect()` rejects with
    `ADT_SESSION_ERROR.NOT_CONNECTED`: "This connection's SAP session has
    ended (it was disconnected or logged off); one connection instance is one
    session. Create a new connection for a new session."
  - A failed `connect()` that sent no logoff (a 401, a network error, no
    session cookie) leaves the instance usable, and `connect()` may be
    retried on it.
  - Each instance therefore sends at most one logoff, and nothing can
    overtake it on the same instance.

## What a consumer must do

- **Call `disconnect()` once.** If more than one path in your code can end a
  connection, such as a `finally` and a signal handler, let one of them own
  the call, or catch the second call's rejection. A rejection means
  `disconnect()` was already called; it is not a failure of the teardown.

- **Drop `signal`** from the options passed to `makeAdtRequest`, and drop any
  check for `ADT_REQUEST_ERROR` or `'ADT_REQUEST_ABORTED'`. A request you no
  longer need simply runs to its end. Ending the session ends its server-side
  state: unlock what you locked first, and the logoff is the backstop.
- **A process about to exit awaits `disconnect()`.** Once it resolves, the
  logoff has left, and the session's locks go with it even if the process ends
  before SAP answers.
  ```typescript
  await connection.disconnect();
  process.exit(0);
  ```
- **`flushGoodbye()` no longer has a default bound.** Called without an
  argument, it waits for the logoff's answer for as long as SAP takes; it no
  longer gives up after 5 s. If you need a bound, pass one yourself, for
  example `flushGoodbye(5000)`. With a budget it returns at that point
  without throwing, as before.
- **A new session is a new instance, and creating it is yours.** Use your
  own factory, or `createConnection`; mcp-abap-adt's server already calls its
  `createAbapConnection` once per connection. Anywhere you called `connect()`
  again on an instance after `disconnect()` or a `SESSION_REPLACED`, create a
  new connection instead.
- **Await `flushGoodbye()` as well if SAP's answer matters**, for example
  before a new connection connects, so that the server never holds two
  sessions:
  ```typescript
  await connection.disconnect();
  await connection.flushGoodbye();
  const next = createYourConnection();
  await next.connect();
  ```
- **A custom transport** (`IAdtTransport`) changes in two places.
  - It must implement `abapContext(): string | null`. This returns the ABAP
    session it addresses (over HTTP, the `sap-contextid` cookie), or `null`
    when it has none, as RFC does.
  - If its `close()` stays pending long after its goodbye has left, it should
    call the new `written` argument at that point. Otherwise `disconnect()`
    now waits for the close to settle, where before it did not wait at all. A
    wire whose close is over at once needs no change there.
- **Handle `SESSION_REPLACED` from the ABAP session.** Inside a critical
  section, a request that comes back with a different `sap-contextid` now
  rejects with `ADT_SESSION_ERROR.SESSION_REPLACED`, and the connection
  counts as lost. This is the same handling as a changed `SAP_SESSIONID`:
  the locks are out of reach. Re-establish the connection and redo the work.
