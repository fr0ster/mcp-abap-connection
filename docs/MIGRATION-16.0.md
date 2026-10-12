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
- A session closed with a logoff releases its locks. Suppose a long request is
  still running in the same stateful session. SAP queues the logoff behind it
  and answers only afterwards: about 96 s through the connector, and no answer
  in six minutes when sent raw from a second thread. Yet once the logoff has
  arrived, the lock is gone, even when the client was killed with the answer
  still pending.
- A connection dropped without a logoff keeps its locks.

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
  - **A failed `connect()` rejects only after its own goodbye is written.** It
    says goodbye to what the server opened before refusing, for example a
    cloud preflight's session, or a session that authenticated but opened no
    ABAP session. A caller that exits on that error does not lose the
    goodbye.
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
- **Await `flushGoodbye()` as well if SAP's answer matters**, for example
  before `connect()` again, so that the server never holds two sessions:
  ```typescript
  await connection.disconnect();
  await connection.flushGoodbye();
  await connection.connect();
  ```
- **A custom transport** (`IAdtTransport`) changes only in one case: when its
  `close()` stays pending long after its goodbye has left. Such a wire should
  call the new `written` argument at that point. Otherwise `disconnect()` now
  waits for the close to settle, where before it did not wait at all. A wire
  whose close is over at once needs no change.
