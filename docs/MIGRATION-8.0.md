# Migration to 7.0 and 8.0

Two majors, and **no code of yours has to change for either**. One alters what
goes on the wire; the other moves the contracts floor and makes methods you
already had reachable through the types you already hold.

If you build against `@mcp-abap-adt/interfaces` and never cast to a connector
class, there is nothing to do but install.

## 7.0 — headers that belong to the request stop belonging to the session

Three headers used to be written together, inside the stateful branch:

```ts
if (this.sessionMode === 'stateful') {
  requestHeaders['x-sap-adt-sessiontype'] = 'stateful';
  requestHeaders['sap-adt-request-id'] = randomUUID().replace(/-/g, '');
  requestHeaders['X-sap-adt-profiling'] = 'server-time';
}
```

Only the first belongs there. A request id identifies the **request**, and
asking the server to report its own processing time is not a property of the
session either. Eclipse sends both on everything — measured on ADT 3.60.0, a
stateless source `PUT` carries them and no session type at all.

It stayed invisible while every write ran inside a lock window. Once
`@mcp-abap-adt/adt-clients` narrowed stateful to the `LOCK` and the `UNLOCK`,
the writes silently lost two headers: of 792 requests in a full run, 99 carried
a request id and **693 carried neither**.

### What changed for you

| | |
|---|---|
| `sap-adt-request-id` | now on every request, fresh each time |
| `X-sap-adt-profiling` | now on every request, from a settable default |
| `x-sap-security-session: use` | **cloud only**, on every request once a session exists |
| `x-sap-adt-sessiontype` | unchanged — still the only one that varies with the mode |

Nothing in the type surface moved. The major is for the wire: every request
looks different in an SAP trace, and a system that reacts badly to either should
be findable by version rather than by reading a dump.

### Your own headers win

Both new headers are **defaults**. A caller who names either in
`options.headers` keeps their value, matched without case:

```ts
await conn.makeAdtRequest({
  url, method: 'GET', timeout: 30_000,
  headers: { 'sap-adt-request-id': myCorrelationId },   // kept, not replaced
});
```

That is not hypothetical: `adt-clients` passes its own id to
`getDiscovery({ requestId })` so the id it logs is the id on the wire.

### Turning the profiling off

```ts
conn.setProfilingRequest(null);          // ask for nothing
conn.setProfilingRequest('server-time'); // the default, and what Eclipse asks for
```

Nothing in this package reads the `server-time=…` that comes back. An
investigation does, though — the unit is **microseconds**, which a trial's
unpublish job settled by answering `server-time=132512547` on a request that
takes about 133 seconds.

## 8.0 — onto interfaces 39.0.0, and the atoms are declared

### The floor

`@mcp-abap-adt/interfaces` moves from `^21.0.0` to `^39.0.0`. Install it
alongside; a consumer pinned below 39 cannot have both.

Seventeen majors, and the whole migration inside this package was eight compiler
errors in one file — `makeAdtRequest` returning `IAdtWireResponse<T, D>` rather
than `IAdtResponse<T, D>`, and `isNetworkError` coming home because interfaces
stopped emitting code in 29.0.0.

**If you deduplicate nothing else, deduplicate this.** Two copies of the
contracts in one graph are structurally identical and do not compare equal, so
they produce errors that read as impossible.

```
npm ls @mcp-abap-adt/interfaces     # should print one version, deduped
```

### `flushGoodbye()` — the half of `disconnect()` that was missing

`disconnect()` dispatches the logoff and does not await it, on purpose: a
goodbye carries no request timeout, and a server that never answers must not
hold a teardown open.

That is right for a teardown and wrong for a **reconnect**:

```ts
await conn.disconnect();
await conn.flushGoodbye();   // give the goodbye its budget to finish first
await conn.connect();
```

Without the middle line, the next session opens while the previous one's goodbye
is still being assembled and the server keeps both. Measured on E19 through a
test harness that recycled the session after each test: **a new ABAP session
every one to two seconds for a whole run, none released**, each living to its
own thirty-minute idle timeout.

**The budget bounds the waiting, not the overlap.** If the goodbye finishes in
time there is no overlap; if it does not, you proceed and it stays outstanding
for as long as it takes. A return is not a confirmation and not even of
dispatch.

Calling `disconnect()` twice is **not** a substitute — a repeat call does not
wait either.

### Reaching the controls through the contract

`beginCriticalSection()`, `setProfilingRequest()` and `flushGoodbye()` all
existed before. What changed is that a consumer can reach them without a cast:
`AbapConnection` is `IAbapConnection`, and these now live on capability atoms
that this connection declares.

```ts
import type {
  IAbapConnection,
  ICriticalSection,
  IRequestProfiling,
  ISessionLifecycleAware,
} from '@mcp-abap-adt/interfaces';

function protectTheWindow(conn: IAbapConnection & ICriticalSection) {
  conn.beginCriticalSection();
  try {
    // the ordinary per-request deadline does not apply in here
  } finally {
    conn.endCriticalSection();
  }
}
```

`flushGoodbye` is a member of `ISessionLifecycleAware`, not an atom of its own:
waiting for the goodbye is not a separate capability from sending it.

### One thing to know about `implements`

TypeScript is structural. Removing an atom from a class's `implements` list
changes nothing for a consumer — the class still has the methods and narrowing
still succeeds. What the clause buys is the compiler checking the class *against*
the contract in the other direction: remove `beginCriticalSection` itself and it
is `TS2420`.

Worth knowing before writing a guard that tests the clause rather than the
method.

### `IRenewableCredential` is an atom now

Not this package's change, but it lands with the floor. Renewing is something a
credential can also do, not a kind of credential, so a guard that narrowed to
`IRenewableCredential` alone now hands the caller something that renews and
cannot authenticate:

```ts
// before
function isRenewable(c: IAuthProvider): c is IRenewableCredential
// after
function isRenewable(c: IAuthProvider): c is IAuthProvider & IRenewableCredential
```
