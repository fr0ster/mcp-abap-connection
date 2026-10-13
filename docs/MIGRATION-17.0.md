# Migration to 17.0

17.0.0 does two things that [SCOPE.md](./SCOPE.md) lists: a request carries no
deadline but the caller's own, and an instance can be built on an existing SAP
session. For a consumer on 16.x that means the following.

## No deadline of the package's own

A client deadline closes the socket, and SAP then ends the synchronous request
that was running on it — a write in it is lost. So nothing this package sends
carries a deadline it chose.

### What changed

- **`getTimeout`, `getTimeoutConfig` and the `TimeoutConfig` type are no longer
  exported**, and nothing reads `SAP_TIMEOUT_DEFAULT`, `SAP_TIMEOUT_CSRF`,
  `SAP_TIMEOUT_LONG` or `SAP_TIMEOUT_CRITICAL` any more. Setting them changes
  nothing.
- **A request carries the `timeout` you pass, unchanged, and nothing else.**
  The CSRF fetch (in `connect()`, before a mutation, and the one a refused
  token triggers) and the cloud session preflight carry none; before, each was
  bounded by `SAP_TIMEOUT_CSRF` (15 s).
- **Inside a critical section a request carries no deadline at all — not even
  yours.** Before, `beginCriticalSection()` raised the request's timeout to
  `max(yours, SAP_TIMEOUT_CRITICAL)` (600 s by default). Now the `timeout` you
  pass is not applied while a section is active, and applies again once the
  outermost section ends. The critical section itself is unchanged.
- **`GenericWebSocketTransport.connect()` sets no timer** unless you pass
  `connectTimeoutMs`; the 15 s default is gone. A `connectTimeoutMs` you pass is
  honoured as before.
- **`IAdtEstablishContext.timeoutMs` is gone** from the transport seam.
- `ITimeoutConfig` in `@mcp-abap-adt/interfaces-adt-connection` is unchanged;
  this package no longer uses it.

### What you do

- Replace `timeout: getTimeout('default')` (or `'csrf'`, `'long'`) with a number
  of your own. `IAbapRequestOptions.timeout` is still a required field of the
  contract; `0` means none over HTTP (axios reads it so), and the RFC wire does
  not read it at all.
- Drop `SAP_TIMEOUT_*` from your environment, or read them yourself if you want
  them to keep meaning something.
- If you relied on `connect()` giving up after 15 s against a host that does
  not answer: it now waits for the network to fail. A bound on it is yours to
  set around the call.

Before:

```text
import { getTimeout } from '@mcp-abap-adt/connection';
await connection.makeAdtRequest({ method: 'GET', url, timeout: getTimeout('default') });
```

After:

```typescript
import { createConnection } from '@mcp-abap-adt/connection';
import type { SapConfig } from '@mcp-abap-adt/connection';
import { BasicAuthProvider } from '@mcp-abap-adt/auth-providers';

const system: SapConfig = {
  url: 'https://your-sap-system.com',
  client: '100',
  authType: 'basic',
  username: 'your-username',
  password: 'your-password',
};
const connection = createConnection({
  system: 'onprem',
  transport: 'http',
  config: system,
  credential: new BasicAuthProvider(system.username!, system.password!),
});
await connection.connect();
// Your own deadline, or 0 for none.
await connection.makeAdtRequest({ method: 'GET', url: '/sap/bc/adt/discovery', timeout: 45_000 });
await connection.disconnect();
```

## An instance on an existing session

New, and nothing changes for a consumer that does not use it.

- **`sessionCookies()`** on every connector: the cookies of the instance's SAP
  session as one `Cookie`-header string — `SAP_SESSIONID_*`, `sap-usercontext`,
  `sap-contextid` when a stateful request opened a context, and whatever else
  the server set to keep the session where it lives; everything the wire holds
  but `sap-XSRF_*`. `null` before a session, after it ended, and over RFC. It
  acts as the user while the session lives: keep it as a secret. The package
  never logs it.
- **`createConnection({ …, session })`** (and a sixth constructor argument,
  `session`, on `AdtOnPremConnector` / `AdtCloudConnector`) builds the instance
  on that session. `connect()` does not log on: it makes one request in that
  session without the credential — the CSRF fetch; on cloud with
  `x-sap-security-session: use` and no preflight — and SAP's answer says whether
  the session is alive. Alive: the session is the instance's, a stateful
  request reaches its `sap-contextid`, and `disconnect()` logs it off as for any
  instance. Gone (a `401`, or an answer that is not the session's):
  `connect()` rejects with SAP's answer as it is, nothing is logged off, and the
  instance is spent.
- **HTTP wires only.** Over RFC, `session` is refused by `createConnection` at
  construction, and by the RFC wire at `connect()` when the connector was built
  by hand, before anything is sent. An empty `session` is refused at
  construction.

See [USAGE.md — An instance on an existing session](./USAGE.md#an-instance-on-an-existing-session-session-and-sessioncookies).

## A wire of your own

`IAdtTransport` has two new required members:

- `resume(context, session): Promise<void>` — take over the session `session`
  names, without the credential, or reject with the server's answer. A wire
  whose session no cookie names rejects without sending anything, as
  `RfcTransport` does.
- `sessionCookies(): string | null` — what `resume()` takes, or `null`.

A wire built on `HttpTransport` inherits both.
