# Migration to 6.0

The factory and the six connection classes are gone. What replaces them is not a
new API so much as the one 5.0 introduced, now the only one: **you state which
system, which credential, and which wire, and nothing is worked out for you.**

**The wire is a required argument.** There is no default to fall back to and
nothing is derived from the config, because which wire a deployment uses is a
fact about the deployment. It also carries the two things only you can supply —
the credential's TLS material and the client — so it arrives built.

If you already moved to `AdtOnPremConnector` / `AdtCloudConnector` in 5.0, most
of this does not apply to you — skip to [Taking the RFC wire](#taking-the-rfc-wire).

## What was removed

| removed | take instead |
|---|---|
| `createAbapConnection()` | `new AdtOnPremConnector(...)` or `new AdtCloudConnector(...)` |
| `BaseAbapConnection`, `OnPremAbapConnection` | `AdtOnPremConnector` + `BasicAuthProvider` |
| `JwtAbapConnection`, `CloudAbapConnection` | `AdtCloudConnector` + `TokenAuthProvider` |
| `SamlAbapConnection` | `AdtOnPremConnector` + `SamlAuthProvider` |
| `CertificateAbapConnection` | `AdtOnPremConnector` + `CertificateAuthProvider` |
| `KerberosAbapConnection` | — see [Kerberos](#kerberos) |
| `RfcAbapConnection`, `connectionType: 'rfc'` | `AdtOnPremConnector` + `RfcTransport` |
| `disconnect({ deadlineMs })` | `disconnect()` — see [Teardown](#teardown) |

## Why

The factory switched on things the caller had already said. Given
`options.system` it did no inference at all, and without it, it inferred the
session mechanism from the credential — which is the arrangement that gets one
of them wrong: a bearer token against an on-prem system is ordinary, and it does
not make that system a cloud one.

The classes had the same shape of problem one level down. Six subclasses
distinguished by an argument, and `RfcAbapConnection` was a second translation of
`SADT_REST_RFC_ENDPOINT` beside `RfcTransport` — two of those drift, and these
had: the class was missing a default `Accept` header and carried cookie-handling
code that could never run.

## Basic

```diff
-import { createAbapConnection } from '@mcp-abap-adt/connection';
+import {
+  AdtOnPremConnector,
+  BasicAuthProvider,
+} from '@mcp-abap-adt/connection';

-const connection = createAbapConnection(config, logger, undefined, undefined, {
-  system: 'onprem',
-});
+const connection = new AdtOnPremConnector(
+  config,
+  new BasicAuthProvider(config.username!, config.password!),
+  new OnPremHttpTransport(() => ({}), logger, {
+    client: config.client,
+    baseUrl: config.url,
+  }),
+  logger,
+);
```

`client` is not decoration: SAP answers `sap-usercontext` with the system
default rather than the client you asked for, and later requests then route to a
client you never named — on a read-only one, every write comes back `403`.

## JWT / OAuth2

```diff
-const connection = createAbapConnection(config, logger, undefined, refresher, {
-  system: 'cloud',
-});
+const connection = new AdtCloudConnector(
+  config,
+  new TokenAuthProvider(refresher),
+  new CloudHttpTransport(() => ({}), logger, {
+    client: config.client,
+    baseUrl: config.url,
+  }),
+  logger,
+);
```

The cloud wire is not the on-prem one with a different name. It asks for a
session at `/sap/bc/adt/core/http/sessions` and gives it back by `DELETE` on the
address the server publishes; the on-prem wire has neither, and says goodbye
through the platform logoff. Handing the wrong one to a connector does not
compile.

The `ITokenRefresher` that used to be a constructor slot **is** the credential
now. Hand `TokenAuthProvider` a bare string instead and you get a token with
nothing behind it — fine for a short task, wrong for anything long-lived.

One behaviour to know about: **a credential refused during `connect()` now
surfaces.** The old class renewed and retried inside its own CSRF fetch. It does
not any more, and deliberately: renewal is the provider's, and the provider does
it on an expiry it can see, on every call that asks for a header. A token the
provider still believes in and the server refuses is a credential that needs
attention, and `connect()` is one call you make — so the refusal is yours to
answer.

On the request path nothing changed: a 401 asks the provider again, and retries
once **if it answers something different**.

## SAML

```diff
-const connection = new SamlAbapConnection(config, logger);
+const connection = new AdtOnPremConnector(
+  config,
+  new SamlAuthProvider(config.sessionCookies!),
+  new OnPremHttpTransport(() => ({}), logger, {
+    client: config.client,
+    baseUrl: config.url,
+  }),
+  logger,
+);
```

The cookies are the credential — there is no `Authorization` header at all.

## Certificates

A certificate authenticates through the transport rather than through a header,
so this is the one place the two axes touch — and you wire them, because nobody
else can:

```diff
-const connection = new CertificateAbapConnection(config, logger);
+const credential = new CertificateAuthProvider(config, certLoader);
+
+const connection = new AdtOnPremConnector(
+  config,
+  credential,
+  new OnPremHttpTransport(
+    // A thunk, not a value: the material is loaded during connect(), so a
+    // wire that read it at construction would read nothing.
+    () => credential.transportMaterial?.() ?? {},
+    logger,
+    { client: config.client, baseUrl: config.url },
+  ),
+  logger,
+);
```

Forget the thunk and mTLS silently does not happen — the connection is built,
the requests go out, and the server refuses them for a reason that says nothing
about the certificate.

## Taking the RFC wire

`connectionType: 'rfc'` is gone. The wire is an argument now, which is what it
always was in fact:

```diff
-const connection = createAbapConnection(
-  { ...config, connectionType: 'rfc' },
-  logger,
-);
+import {
+  AdtOnPremConnector,
+  BasicAuthProvider,
+  RfcTransport,
+  rfcConversationFrom,
+} from '@mcp-abap-adt/connection';
+
+const connection = new AdtOnPremConnector(
+  config,
+  new BasicAuthProvider(config.username!, config.password!),
+  new RfcTransport(rfcConversationFrom(config), logger),
+  logger,
+);
```

The wire sits where the HTTP one sits, because it is the same argument. There is
no option to set and no config field to flip.

`rfcConversationFrom(config)` does what the class's constructor did: `ashost`
from the url, `sysnr` from the HTTP port by the SAP convention that `80XX` is
the ICM port for system `XX`, `SAP_SYSNR` overriding it for a port that follows
no convention. The SAP NW RFC SDK is loaded when a conversation opens, not when
this is called, so a machine without it fails at `connect()` with a message
saying what to install.

Everything above the wire is unchanged: `makeAdtRequest`, `setSessionType`,
`disconnect`, and the session lifecycle. Three things are better than they were
on the removed class:

- a default `Accept` is supplied, so a call that names none is answered rather
  than refused with `400 ExceptionResourceBadRequest`
- `disconnect()` and `getSessionIdentity()` exist, which they did not
- the identity is the conversation, and it changes when the conversation does —
  so reconnecting reads as a different session instead of the same one

**Where to look for the session.** An HTTP session is an ICF session and appears
in **SM05**. An RFC conversation appears in **SMGW → Logged on Clients** as
`NWRFC`, and never in SM05, because there is no ICM in that path.

## Teardown

`disconnect()` takes no arguments.

```diff
-await connection.disconnect({ deadlineMs: 5000 });
+await connection.disconnect();
```

It **notifies**: it tells the server the session is finished and does not act on
the answer — whether and when the session is freed is the server's affair. The
`deadlineMs` it used to accept bounded a wait for that answer, which bought you
nothing and was the one thing that could make a teardown unbounded, since the
goodbye carries no request timeout by design. `SAP_RELEASE_DEADLINE_MS` is gone
with it.

Everything else is unchanged: it resolves rather than throws, always settles,
and a repeat call performs whatever is still owed.

## Kerberos

`KerberosAbapConnection` is removed without a direct replacement. It was
single-leg only, and untested against a live KDC — issue #35 says so. If you
depend on it, stay on 5.x and say so on that issue; a `KerberosAuthProvider`
belongs on the credential axis and can be added there, but it should be added
with a system to test it against.

## Types you can now name

The seam is public, so a signature can say what it needs instead of taking any
connection and casting:

```typescript
import type {
  IAdtTransport,
  IAdtTransportRequest,
  IAdtTransportResponse,
  IAdtEstablishContext,
  IAdtSessionContext,
  IOnPremTransport,
  ICloudTransport,
  IRfcConversation,
  RfcConnectionParams,
} from '@mcp-abap-adt/connection';

function overRfc(conn: AdtOnPremConnector<IAuthProvider, RfcTransport>) { /* ... */ }
```

### Bringing your own wire

The connectors are constrained by a marker, not by the shipped classes, so a
transport you write is a first-class one. Say which system it is for and it fits
where the shipped wires fit:

```typescript
import type { IOnPremTransport } from '@mcp-abap-adt/connection';

class RecordingTransport implements IOnPremTransport {
  readonly kind = 'recording';
  readonly system = 'onprem' as const;
  // ... the rest of IAdtTransport
}
```

`system` is read by the compiler and never at runtime. Its only job is to stop
"ABAP Cloud over an on-prem wire" from compiling — which is also why the
constraint is this marker and not `OnPremHttpTransport`: the shipped classes
carry private state and compare nominally, so constraining to them would have
made this impossible while appearing to allow it.
