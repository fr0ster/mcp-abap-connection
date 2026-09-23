# Migration to 9.0

**No code of yours that only uses this package's own exports has to change.**
Nothing was renamed here, no signature moved, no behaviour is different. What
changed is where the *contracts* come from.

`@mcp-abap-adt/interfaces` split. The contracts now live in four packages:

| Package | What is in it |
|---|---|
| `@mcp-abap-adt/interfaces-adt` | The ADT vocabulary: `IAbapConnection`, `IAbapRequestOptions`, `IAdtWireResponse`, `IAdtResponse`, `ISapConfig`, `SapAuthType`, `SapConnectionType`, `ITokenRefresher`, `ITokenRefreshResult`, `ITokenProvider`, `ICertificateMaterialLoader`, and the capability atoms — `ISessionLifecycleAware`, `ICriticalSection`, `IRequestProfiling` — with `ADT_SESSION_ERROR` and `AdtSessionErrorCode` |
| `@mcp-abap-adt/interfaces-auth` | The credential axis: `IAuthProvider`, `IRenewableCredential`, `ICertificateMaterial` |
| `@mcp-abap-adt/interfaces-network` | The wire: `ITimeoutConfig`, `NETWORK_ERROR_CODES`, and the WebSocket contracts — `IWebSocketTransport`, `IWebSocketConnectOptions`, `IWebSocketCloseInfo`, `IWebSocketMessageEnvelope`, `IWebSocketMessageHandler` |
| `@mcp-abap-adt/interfaces-utils` | `ILogger` |

This package now depends on those four and **no longer depends on
`@mcp-abap-adt/interfaces` at all**. That is the breaking part, and it is the
only breaking part: a consumer who was getting the umbrella transitively through
this package stops getting it.

## What you do

If you never import contract types yourself — you take what
`@mcp-abap-adt/connection` exports and nothing else — install and carry on.

If you do import them, move each import to the package it now lives in. Install
the ones you name:

```bash
npm install @mcp-abap-adt/interfaces-adt @mcp-abap-adt/interfaces-auth
```

Before:

```ts
import type { IAuthProvider, ITokenRefresher } from '@mcp-abap-adt/interfaces';
```

After:

```ts
import type { IAuthProvider } from '@mcp-abap-adt/interfaces-auth';
import type { ITokenRefresher } from '@mcp-abap-adt/interfaces-adt';
```

The table above says which package each name went to. Nothing was renamed, so
the names themselves are the same ones you already use.

## You can also do nothing yet

The umbrella still exists and still re-exports every one of these names, so code
importing from `@mcp-abap-adt/interfaces` keeps compiling — as long as you
install it yourself, which you now must, since this package no longer brings it
along.

Every one of those re-exports is marked `@deprecated`. They are a bridge, not a
destination: a build that is green on them is green on something advertised as
going away, and the compiler will keep saying so. Moving the imports is a
mechanical change and it is better done while it is only an import line.

## Why this package stopped using the umbrella

A shim re-exports a name; it does not re-export the **identity** of the type
behind it. Once a consumer holds one contract package and this one holds
another, the two can be the same shape and still be two types — and structural
typing hides that right up until it does not. Depending on the packages the
contracts actually live in is the only way the consumer and the connection are
demonstrably holding the same one.

## Checking what you ended up with

```bash
npm ls @mcp-abap-adt/interfaces-adt    # should print one version, deduped
npm ls @mcp-abap-adt/interfaces-auth
```

Two versions of a contract package in one tree is the failure this release is
avoiding. If `npm ls` shows a nested copy, something in your dependency graph is
still pinning an older range.
