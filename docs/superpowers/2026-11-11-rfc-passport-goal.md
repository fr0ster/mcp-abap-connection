# Goal: the RFC wire carries the passport, names its errors, and never reopens a session

## Goal

A request sent over RFC reaches the system as a request sent over HTTP would in the two places
where the wire changed what it meant. A request that carries a `SAP-PASSPORT` header is sent
with that passport as the RFC call's own passport, so an ABAP program started over RFC is
caught by an external debugger listening in terminal mode for the passport's ids, as it is over
HTTP. A request whose RFC call fails reaches the caller with the RFC error's key, group and code
as fields of the error it receives, so a consumer reads which failure it was from a field, never
from words.

When an RFC error ends the conversation that carries the connection's session, the connection
says so: the session is gone, with its locks, and the connection does not open a new one on its
own. A new session is a new connection instance, which only the caller creates.

## Invariants

- **RFC errors are named by fields.** When an RFC call fails with an error the SDK names, the
  error the caller receives carries it as `rfc: { key, group, code, codeString }`, typed by a
  contract in `@mcp-abap-adt/interfaces-adt-connection`, so a consumer that does not depend on
  the connection reads it by type. The error's top-level `code` keeps its meaning. The SDK's
  error comes from outside the type system: it is checked once at run time where the wire
  receives it, and is typed from there on. No field is read out of a message, and no message is
  parsed. This holds on every conversation, stateful or not.
- **The passport header becomes the call's passport.** A request's `SAP-PASSPORT` header (its
  name read without case) is hex-decoded, checked, and handed to the RFC call as the SDK's
  passport for that call only. It is not sent as a REST header field. A value that is not a
  passport's hex is refused before anything is sent, naming the header and not quoting its value.
- **No passport header, no passport.** A request without the header is sent with no passport,
  exactly as before; the wire invents, derives or keeps none.
- **HTTP is unchanged.** Over HTTP the header goes as it goes today.
- **A connection-ending error is reported as the session lost.** When an RFC error ends the
  stateful conversation — the one that carries the instance's session — it is the existing
  session-lost contract: the call's error carries its `rfc` fields and `code`
  `ADT_SESSION_REPLACED`, the instance is spent, and every later request is refused with
  `ADT_NOT_CONNECTED`, with nothing sent.
- **No silent reconnect.** The connection never reopens the instance's session on its own. A
  new session is a new instance, created by the caller; a lock or anything else held in the old
  session is never presented as still held. A conversation that carries no session of the
  instance — a stateless one, reset after each call — is replaced as a reset replaces it today,
  and the error of the call it failed still carries its `rfc` fields.
- **Static types first.** What the compiler can prove is not checked again at run time; only
  what comes from outside the type system — the SDK's errors, the header's value — is checked,
  once, where it enters.
- **No regular expression** anywhere in the RFC wire: the two it holds today (reading an
  exception type out of an answer, and matching header names whose value a log must not carry)
  are rewritten as linear code, with the same results.
- **No timeouts, retries or polling** beyond the named exceptions the connection already states.
  Nothing waits on a clock and nothing is sent twice.
- **From the registry.** The connection depends on `@mcp-abap-adt/sap-rfc-lite` `^0.4.0` and on
  the `@mcp-abap-adt/interfaces-adt-connection` minor that carries the `rfc` contract, both as
  published on the npm registry and published before the connection; no local link reaches the
  release.
- **Proved live over RFC.** Against a real on-premise system over RFC, with raw ADT requests
  sent through the connection and the passport built by a test helper: a class run carrying a
  debuggee passport is caught by a terminal-mode listener with those ids and is not caught
  without it; the RFC error that ends the debugger's session at its termination reaches the
  caller with its key in `rfc` and `code` `ADT_SESSION_REPLACED`, and no request after it is
  sent on a new session.
- **Tests are load-bearing.** Every unit test that protects one of these invariants goes red when
  the rule it protects is broken on purpose.
- **The docs describe the new contract.** The README, the usage guide and a migration note say
  what the RFC wire now does with the passport header, what an RFC failure carries, and what a
  consumer must do after a connection-ending error. They also say that a stateful session once
  caught by a listener stays caught for later calls until it ends: the connection does not reset
  it.

## Out of scope

- Building the passport: its layout and ids are the caller's (the ADT client builds them).
- Reading the passport the system returns at the end of a call.
- Validating a passport's structure beyond its hex: that check is the RFC library's.
- How a consumer reads a terminated debugger from the RFC error (the ADT strategies and
  clients), and how the server reacts: the next links of the chain.
- Resetting a caught stateful session: that would drop its locks; it is documented instead.
- The HTTP wires, the authentication providers, and the RFC address and logon.
