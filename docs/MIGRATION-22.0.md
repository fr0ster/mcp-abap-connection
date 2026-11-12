# Migration to 22.0

22.0.0 changes three things on the RFC wire. HTTP is unchanged.

## What changed

- **An RFC error that ends the stateful conversation ends the instance's
  session.** The stateful conversation carries the instance's session and every
  lock taken in it. When an RFC error ends it — sap-rfc-lite 0.4.0 releases it
  (`alive` is `false`) — the request rejects with `code`
  `ADT_SESSION_REPLACED` and the RFC call's fields as `rfc`; the instance is
  spent: every later request and `connect()` reject `ADT_NOT_CONNECTED`, and
  nothing is sent. The connection opens no new session on its own. With 21.x
  and sap-rfc-lite 0.3.x the next request went on, silently, on a new session,
  and a lock taken in the old one was gone without a word.
- **A failed RFC call carries `rfc`.** When the SDK names the failure, the
  error carries `rfc: { key, group, code, codeString }` (`IRfcErrorInfo` from
  `@mcp-abap-adt/interfaces-adt-connection` 4.1; `codeString` is one of
  `RFC_RCS`), on every conversation, stateful or not. The top-level `code`
  keeps its meaning: unset on a call's failure, whose message is the call's
  (`RFC call to SADT_REST_RFC_ENDPOINT failed: …`); when the error ended the
  stateful conversation, the message is the session-lost one and `code` is
  `ADT_SESSION_REPLACED` (above).
- **The `SAP-PASSPORT` header becomes the RFC call's passport.** Over RFC the
  header is hex-decoded and handed to sap-rfc-lite for that call only; it is no
  longer sent to `SADT_REST_RFC_ENDPOINT` as a header field (which never read
  it). A value that is not hex, or the header named twice, is refused before
  anything is sent.
- **`@mcp-abap-adt/sap-rfc-lite` ^0.4.0**, an optional dependency as before.

## What to do

**Read an RFC failure from `rfc`, not from the message.** The caught value
is checked, as anything caught is; what it may carry is
`IAbapConnectionError` (`code`, `rfc`):

```typescript
import type { RfcReturnCodeName } from "@mcp-abap-adt/interfaces-adt-connection";

function rfcCodeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("rfc" in error)) {
    return undefined;
  }
  const { rfc } = error;
  return typeof rfc === "object" && rfc !== null && "codeString" in rfc &&
    typeof rfc.codeString === "string"
    ? rfc.codeString
    : undefined;
}

const closed: RfcReturnCodeName = "RFC_CLOSED";
function conversationClosed(error: unknown): boolean {
  return rfcCodeOf(error) === closed;
}
```

**After `ADT_SESSION_REPLACED` over RFC, create a new connection.** The
instance is spent, as after any lost session. Every lock taken on the old
session is gone: take it again on the new one, never carry its lock handle
over. `disconnect()` is still owed once on the old instance; it sends nothing
for the ended conversation.

**A stateful session caught by a debugger stays caught.** Once an external
debugger caught a call on the stateful RFC session, later calls on it are
caught too, with or without a passport, until the session ends; the connection
does not reset it, because that would drop its locks. Send a run meant to be
caught as a non-stateful request, or on a connection of its own.

**Install sap-rfc-lite 0.4.0 or newer** where you take the RFC wire:
`npm install @mcp-abap-adt/sap-rfc-lite@^0.4.0`.

**A wire of your own** that loses the session it carries throws
`WireSessionLostError` (exported beside `WireLogonError`); the connection then
reports `ADT_SESSION_REPLACED` and spends the instance, as it does for RFC.

**A conversation factory of your own** (`RfcConversationFactory`) keeps
working: `IRfcConversation.call` gains an optional third parameter
(`{ passport? }`), passed only when a request carries a passport.
