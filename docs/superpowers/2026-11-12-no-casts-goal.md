# Goal: no type assertion and no regular expression in production code

## Goal

The production code of `@mcp-abap-adt/connection` — everything under `src/` that is not a test —
holds no type assertion and no regular expression, and a gate keeps it so. Every value is typed by
its contract, so the compiler checks what the code claims about it; where the compiler cannot see a
value (a network answer, an RFC SDK result, the environment, a file, a value a contract types
`unknown`), the code reads it with a runtime check in plain code. Text is read with linear string
code or the platform's parser, never a regular expression.

The package is released with this: code quality is part of the release, not left for a later one.

## Invariants

- **No type assertion in production code.** None of: `as T` (`as const` excepted), `as unknown as`,
  the type `any`, the non-null assertion `!` (on an expression or as a definite-assignment `!` on a
  declaration), `<T>value`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`. An assertion is a
  claim the compiler does not check; in this package it sits on the values that come from outside,
  which is where an unchecked claim does harm.
- **No cast replaces a cast.** A value the type system can type is typed by its contract (the
  interface's declared types, `ReturnType<…>`, a generic the call site fixes); it is not held as
  `unknown` and narrowed by hand, and no runtime guard is added for something the compiler can
  prove. A runtime check remains only where the compiler cannot see the value, and it is plain code.
- **No regular expression in production code.** No regex literal, no `RegExp` (constructed or
  called), and no regex handed to a string method (`match`, `matchAll`, `replace`, `replaceAll`,
  `search`, `split`, `test`, `exec`). Linear string code, or the platform's parser (`URL`,
  `URLSearchParams`, an XML parser), instead.
- **Behaviour does not change**, except where the types reveal a defect. Such a defect is fixed in
  this change, with a test that fails before the fix and passes after; every other rewrite keeps
  what the code does, and the existing tests stay green unchanged.
- **A gate keeps it so.** After this change, a new assertion, `any`, `!`, suppression comment or
  regular expression in production code fails the gate the package already runs (`lint:check`
  and/or a test of the sources), and the gate is proved load-bearing: each kind it refuses is
  shown red on a deliberate violation.
- **Static types first.** What the compiler can prove is not checked again at run time.
- **The docs describe the result.** If an exported type changes, README, `docs/USAGE.md`, the
  CHANGELOG and a migration note say what a consumer on the old contract must now do.

## What there is today

**Measured** with the TypeScript compiler API over the 24 production files under `src/` (tests and
`__tests__` excluded; comments, imports and `as const` not counted), at the base of this branch:

| File | `as T` | `as unknown as` | `!` | regex literal | regex call |
|---|---|---|---|---|---|
| `connection/AbstractAbapConnection.ts` | 9 | 1 | 1 (definite) | 1 | 1 |
| `connection/HttpTransport.ts` | 9 | 1 | 0 | 3 | 3 |
| `connection/IAdtTransport.ts` | 3 | 0 | 0 | 0 | 0 |
| `connection/GenericWebSocketTransport.ts` | 2 | 0 | 0 | 0 | 0 |
| `connection/RfcTransport.ts` | 2 | 0 | 0 | 0 | 0 |
| `session/SessionLifecycle.ts` | 2 | 0 | 0 | 0 | 0 |
| `connection/CloudHttpTransport.ts` | 1 | 0 | 0 | 3 | 3 |
| `utils/networkErrors.ts` | 1 | 0 | 0 | 0 | 0 |
| **Total** | **29** | **2** | **1** | **7** | **7** |

No `any`, no `<T>value`, no `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck`, no `new RegExp` and
no `biome-ignore` in production code. Each regex call uses one of the regex literals, so there are
7 regular expressions in all. Biome's `noExplicitAny` is a warning, and `lint:check` fails on
warnings; Biome has no rule refusing `as` here. `src/__tests__/rfcExceptionStatus.test.ts` already
refuses a regex literal and the name `RegExp` in `RfcTransport.ts` alone, with the compiler API.

**Code** — the causes, grouped:

- **The wire's answer is typed `unknown`.** `IAdtTransportResponse` (exported) declares `headers:
  unknown` and `data: unknown`, and `IAdtSessionContext.observe` / `ingest` take
  `Record<string, unknown>`. So every place the connection or a wire reads an answer's headers
  asserts `Record<string, unknown>` (`AbstractAbapConnection.ts` 791, 1539, 1646, 1797, 2116;
  `HttpTransport.ts` 623, 630; `CloudHttpTransport.ts` 118), and `HttpTransport.ingest` asserts the
  shape of `set-cookie` (502).
- **The generic answer of `makeAdtRequest`.** `IAdtWireResponse<T, D>` (from
  `@mcp-abap-adt/interfaces-adt-connection`) promises the caller a `data: T` the connection never
  checks; the transport's `IAdtTransportResponse` becomes it through `as unknown as`
  (`AbstractAbapConnection.ts` 1542). The same shape sits in
  `GenericWebSocketTransport.onMessage<T>` (134) and its `JSON.parse(text) as
  IWebSocketMessageEnvelope<unknown>` (162), and in `SessionLifecycle.transition<T>` returning the
  joined tail `as Promise<T>` (248).
- **A thrown value read by shape.** `refusalOf` (`IAdtTransport.ts` 325–330), `isSessionVerdict`
  (1107), `codeOf`, `diedOnPooledSocket`, `absentEndpoint` (`HttpTransport.ts` 155, 176, 293) and
  `isNetworkError` (`networkErrors.ts` 21) assert a shape on an `unknown` error before reading
  `code` / `response` / `status`. These are values from outside the type system; what changes is
  how they are read (`in`, `typeof`, a property read the compiler accepts), not that they are
  checked.
- **Errors with an extra field.** `new Error(…) as Error & { code }` / `& { response }`
  (`SessionLifecycle.ts` 58, `HttpTransport.ts` 318, `RfcTransport.ts` 1176): a class, or an
  object the compiler builds with the field, instead.
- **Node internals not in the typings.** `agent as unknown as { addRequest }` (`HttpTransport.ts`
  127: `Agent.addRequest`, Node's own entry, absent from `@types/node`) and
  `socket as { bytesRead?: unknown }` (100) — the pooled-resend bookkeeping of #314. `resendable`
  (185) reads `pipe` on an `unknown` body.
- **RFC SDK results.** `record()` (`RfcTransport.ts` 81) asserts `Record<string, unknown>` on an
  object the SDK returned; each field is then checked.
- **Narrowing the compiler lost.** `this.resumeFrom as string` (`AbstractAbapConnection.ts` 1009):
  the caller (`connect`, 445) checks `resumeFrom !== null` and calls `resumeAndCommit`, whose body
  reaches the read with no `await` between; the field's narrowing does not cross the call.
  `this.credentialRejection(error) as IAuthRejection` (1973): `credentialRejection` returns
  non-null for every `WireLogonError`, which the line before establishes, but its return type says
  `| null`. **Inference:** neither hides a live defect today; both are claims a later edit could
  make false without the compiler noticing.
- **A definite-assignment `!`.** `let wroteIt!: () => void` (721): the resolver captured from a
  `new Promise` executor.
- **`params as Record<string, unknown> | undefined`** (1468): the caller's `params` is `unknown`
  on `IAbapRequestOptions` and a record on the seam.

**Regular expressions, and which read outside input** (Code):

| Where | Expression | Reads |
|---|---|---|
| `CloudHttpTransport.linkHref` (229, 231, 233) | `<…link…>`, `rel="…"`, `href="…"` | **outside input:** the body of the cloud security-session answer, from the server |
| `HttpTransport.withoutContextCookie` (242) | `split(/;\s*/)` | **outside input:** the merged `Cookie` header — the jar, built from the server's `Set-Cookie`, and the caller's own `Cookie` header |
| `HttpTransport` `sap-client` check (1003) | `/^sap-client(\[\])?$/` | **outside input:** query parameter names of the caller's request URL, after `URLSearchParams` |
| `AbstractAbapConnection` (1401), `HttpTransport` (1214) | `randomUUID().replace(/-/g, '')` | the package's own value, not outside input |

Outside `src/`: `scripts/` (plain `.mjs` / `.js`, not shipped) holds about 23 regex uses, 20 of
them in `check-docs.mjs` (**Measured**, a grep); `tools/__fixtures__/rule4.ts` holds an
`as unknown as` on purpose, as a fixture the shape check must refuse.

## Open for the spec

- **Exported types.** Whether removing the assertions changes an exported type, and so the major:
  `IAdtTransportResponse.headers` / `.data` (exported, `unknown` today), `IAdtSessionContext.observe`
  / `IAdtTransport.ingest` (exported); `refusalOf`, `sessionError` and `isNetworkError` are internal, but the shapes of the errors they read or build reach the consumer. And
  whether a contract package must change first — above all `IAdtWireResponse<T, D>` in
  `@mcp-abap-adt/interfaces-adt-connection`, whose `T` the connection cannot prove: keep the
  generic and say how it is honoured without an assertion, or answer `unknown` and let the caller
  read it.
- **The generic tail and handlers.** How `SessionLifecycle.transition<T>` joins a tail of another
  call's `T`, and how `GenericWebSocketTransport.onMessage<T>` stores handlers of different `T`,
  without an assertion — or whether those signatures change.
- **Node's `Agent.addRequest`.** It is not in the typings and #314's pooled-resend depends on it.
  Reaching it without an assertion (a subclass overriding a declared method, module augmentation of
  `node:http`, or another hook Node offers), and whether the measured behaviour of #314 is kept —
  it must be.
- **Errors with fields.** A small error class per shape, or a builder the compiler types; whether
  the thrown values' observable shape (`code`, `response`, `message`, `instanceof Error`) is kept
  exactly.
- **What replaces each regular expression**: `linkHref` reads an XML (Atom) document — the
  platform has no XML parser, so a linear scanner of the `link` elements or a parser dependency;
  the cookie split, the `sap-client` name check and the UUID's dashes in plain string code.
- **The gate.** A test of the sources with the compiler API (extending the RFC-only regex test to
  all of `src`, beside the existing source tests), Biome rules (`noExplicitAny` as an error,
  `noNonNullAssertion`), or both; which kinds each refuses, and how each is proved load-bearing.
- **Scope beyond `src/`.** Whether `scripts/` (not shipped, but run by `npm test` and the release)
  falls under the rule now or later.
