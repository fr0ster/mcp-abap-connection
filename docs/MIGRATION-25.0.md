# Migration to 25.0

25.0.0 is a security release. No error the connection hands you, and no line
it logs, carries a thrown value's text or a request's config. A thrown value's
text names hosts and ports: axios's `connect ECONNREFUSED <host>:<port>`, and
the RFC SDK's partner. axios's error also holds the request's config, with its
`Authorization`, `Cookie` and CSRF headers. On every wire, a failure now
reaches you by its typed facts and in fixed words.

## What changed

- **An HTTP failure is not the axios error.** The HTTP wire hands up an
  `Error` that carries:
  - SAP's answer as `response` (`status`, `statusText`, `headers`, `data`, as
    SAP gave them);
  - `status`;
  - `code` (`ECONNREFUSED`, `ECONNABORTED`, `ERR_BAD_REQUEST`, …): its own,
    else the first one down its `cause` chain.

  Its message is `Request failed with status code <n>`, or, when there was no
  answer, `The request failed: <code>`. It has no `config`, no `request`, no
  `isAxiosError` and no `cause`.
- **`AuthRefusedError.cause` is a copy.** It is an `Error` named
  `WireFailure`, its message `The failure: <facts>`. Its fields are `code`,
  `status`, `rfc` (the RFC SDK's `key`, `group`, `code`, `codeString`) and
  SAP's answer as `response`. Its type is `FailureCopy | undefined` (was
  `unknown`). It is never the original object. The provider still receives
  the original as `IAuthRejection.error`.
- **A `WireLogonError` that leaves `connect()` or `makeAdtRequest()`** carries
  such a copy as its `cause`.
- **An RFC failure is worded from `rfc`:**
  `RFC call to SADT_REST_RFC_ENDPOINT failed: <codeString>`, or
  `… failed: the SDK did not name the failure`. `rfc` is unchanged.
- **The WebSocket transport** hands its error handlers `<words>: <facts>`, with
  the facts as fields.
- **Log lines** say a failure's facts, or `no code was given`.

A transport you write yourself (`IAdtTransport`) hands up what it throws. A
failure that is not the credential's passes through the connection as your
wire raised it.

## Who is affected

You are affected if your code does any of the following with an error the
connection threw:

- reads `error.config` or `error.request`;
- tests `error.isAxiosError`, `axios.isAxiosError(error)` or
  `error instanceof AxiosError`;
- compares `AuthRefusedError.cause` with an error it holds
  (`cause === original`), or reads fields of the cause other than `code`,
  `status`, `rfc` and `response`;
- reads a failure from its message: the SDK's or axios's words are gone.

Code that reads `error.response` (its status, headers or body), `error.status`,
`error.code` or `error.rfc` is not affected.

## What to do

Read the facts, never the axios error:

```typescript
import { AuthRefusedError } from "@mcp-abap-adt/connection";

function describe(error: unknown): string {
  if (error instanceof AuthRefusedError) {
    // The provider's words; the cause is the wire's failure, by its facts.
    const status = error.cause?.status;
    return status === undefined
      ? error.message
      : `${error.message} (status ${status})`;
  }
  if (typeof error === "object" && error !== null && "response" in error) {
    // SAP's answer, as SAP gave it.
    const response = error.response;
    if (typeof response === "object" && response !== null && "status" in response) {
      return `SAP answered ${String(response.status)}`;
    }
  }
  if (typeof error === "object" && error !== null && "code" in error) {
    return `the request failed: ${String(error.code)}`;
  }
  return "the request failed";
}
```

For an RFC failure read `rfc.codeString`, on the error or on an
`AuthRefusedError`'s `cause`.
