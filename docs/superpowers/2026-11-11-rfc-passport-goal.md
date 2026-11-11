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
own. A new session begins only where the caller asks for one.

## Invariants

- **RFC errors are named by fields.** When an RFC call fails with an error the SDK names, the
  error the caller receives carries its key, group and code as typed fields. The SDK's error
  comes from outside the type system: it is checked once at run time where the wire receives it,
  and is typed from there on. No field is read out of a message, and no message is parsed.
- **The passport header becomes the call's passport.** A request's `SAP-PASSPORT` header (its
  name read without case) is hex-decoded, checked, and handed to the RFC call as the SDK's
  passport for that call only. It is not sent as a REST header field. A value that is not a
  passport's hex is refused before anything is sent, naming the header and not quoting its value.
- **No passport header, no passport.** A request without the header is sent with no passport,
  exactly as before; the wire invents, derives or keeps none.
- **HTTP is unchanged.** Over HTTP the header goes as it goes today.
- **A connection-ending error is reported as such.** When the RFC error ended the conversation
  that carries the connection's session, the caller learns that the session is gone — from a
  field, not from words — and the call's own RFC error reaches it as well, as the SDK gave it.
- **No silent reconnect.** The connection never reopens its session on its own after such an
  error. Every later request is refused, with nothing sent, until the caller begins a new
  session the way the connection's lifecycle provides; a lock or anything else held in the old
  session is never presented as still held.
- **Static types first.** What the compiler can prove is not checked again at run time; only
  what comes from outside the type system — the SDK's errors, the header's value — is checked,
  once, where it enters.
- **No regular expression** in the production code this change adds.
- **No timeouts, retries or polling** beyond the named exceptions the connection already states.
  Nothing waits on a clock and nothing is sent twice.
- **From the registry.** The connection depends on `@mcp-abap-adt/sap-rfc-lite` `^0.4.0` as
  published on the npm registry, and on every contract package it uses as published; no local
  link reaches the release.
- **Proved live over RFC.** Against a real on-premise system over RFC: a run carrying a
  debuggee passport is caught by a terminal-mode listener with those ids and is not caught
  without it; the RFC error that ends the debugger's session at its termination reaches the
  caller with its key as a field, and no request after it runs on a new session.
- **Tests are load-bearing.** Every unit test that protects one of these invariants goes red when
  the rule it protects is broken on purpose.
- **The docs describe the new contract.** The README, the usage guide and a migration note say
  what the RFC wire now does with the passport header, what an RFC failure carries, and what a
  consumer must do after a connection-ending error.

## Out of scope

- Building the passport: its layout and ids are the caller's (the ADT client builds them).
- Reading the passport the system returns at the end of a call.
- Validating a passport's structure beyond its hex: that check is the RFC library's.
- How a consumer reads a terminated debugger from the RFC error (the ADT strategies and
  clients), and how the server reacts: the next links of the chain.
- The HTTP wires, the authentication providers, and the RFC address and logon.
