# Migration to 23.0

23.0.0 changes what a stateless request gets when the SAP session behind the
connection was replaced (fr0ster/mcp-abap-adt#354). Stateful requests, RFC and
everything else are unchanged.

## What changed

- **A stateless request keeps its answer.** SAP replaces a session that idled
  out: the next request's answer carries a new `SAP_SESSIONID`. A stateless
  request — any request that is not stateful; it holds no lock and no lock
  state — now gets that answer as SAP gave it: a success resolves, a refusal
  rejects as itself. The answer carries `sessionLost: 'ADT_SESSION_REPLACED'`
  (on the resolved `IAdtWireResponse`, or on the rejected error, beside its own
  `code`). With 22.x the same request rejected `ADT_SESSION_REPLACED` and its
  answer was thrown away, so a read-only call failed once and succeeded right
  after on a new connection.
- **The session is still lost.** Before the answer reaches you the instance is
  spent, as after any lost session: `isConnected()` is `false`,
  `sessionCookies()` is `null`, every later request and `connect()` reject
  `ADT_NOT_CONNECTED` with nothing sent, and the session SAP opened with that
  answer is logged off. Nothing is sent again for it: no CSRF retry and no
  credential renewal start from an answer that showed the replacement.
- **Stateful requests keep failing.** A stateful request (`LOCK`, `UNLOCK`, or
  any request the session mode or the `x-sap-adt-sessiontype: stateful` header
  marks stateful) whose answer shows the replacement rejects
  `ADT_SESSION_REPLACED`, as before. So do the connection's own exchanges
  inside a request (a CSRF fetch, a logon), and an answer saying the session no
  longer exists when it shows no replacement — a stateless refusal that both
  changes the `SAP_SESSIONID` and says the session is gone is that refusal,
  marked. `connect()` and a resumed session (`createConnection({ session })`)
  behave as in 22.x.
- **A refused CSRF resend is now observed.** The resend after a refused CSRF
  token used to rethrow the first attempt's `403` without looking at the
  resend's own answer; a replacement on it went unnoticed. Its answer is now
  read like every other.
- **`@mcp-abap-adt/interfaces-adt-connection` ^4.2.0**, which types
  `sessionLost` (`AdtSessionLoss`).

## What to do

**Read `sessionLost` where you caught `ADT_SESSION_REPLACED` for a stateless
request.** The answer is valid and is yours to use; the instance is not. Create
a new connection for the next request:

```typescript
import {
  ADT_SESSION_ERROR,
  type IAbapConnection,
  type IAbapConnectionError,
  type IAbapRequestOptions,
} from "@mcp-abap-adt/interfaces-adt-connection";

async function readOnce(
  connection: IAbapConnection,
  options: IAbapRequestOptions,
): Promise<unknown> {
  const response = await connection.makeAdtRequest(options);
  if (response.sessionLost === ADT_SESSION_ERROR.SESSION_REPLACED) {
    // the answer is valid; the next request needs a new connection
  }
  return response.data;
}

function sessionWasLost(error: Error & IAbapConnectionError): boolean {
  return (
    error.code === ADT_SESSION_ERROR.SESSION_REPLACED || // stateful
    error.sessionLost === ADT_SESSION_ERROR.SESSION_REPLACED // stateless refusal
  );
}
```

**Do not resend on your own** unless you mean to: the connection never does.
A write that carried a lock handle of the old session is refused by SAP (`403`
for the old CSRF token, `423` for the gone lock), and that refusal is what you
get, marked.

`disconnect()` is still owed once on the spent instance; it sends nothing.
