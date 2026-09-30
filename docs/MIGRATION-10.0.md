# Migration to 10.0

The connection now speaks `IAuthProvider` 3.0 (`@mcp-abap-adt/interfaces-auth`
^3.0.0), and the credential providers left this package for
`@mcp-abap-adt/auth-providers`.

What changed in behaviour is who decides. The connection asks the provider
before every attempt (`authorize`), at every logon (`establish`) and when the
system refuses (`rejected`); it never asks what kind of provider it holds. The
wire offers what it can carry, the provider writes the credential into it, and
the connection decides the lifecycle: exactly one more attempt after the provider
says Ok, never a loop.

**What you do**, in the order it usually bites:

1. [Import the providers from `@mcp-abap-adt/auth-providers`](#1-the-providers-moved).
2. [Build a token provider with `.fixed` or `.from`](#2-tokenauthprovider-has-two-constructors-now).
3. [Drop the hand-wired TLS material](#3-tls-material-is-taken-at-logon).
4. [If you take the RFC wire and wrote your own factory, pass the logon parameters through](#4-rfc-the-factory-takes-the-logon-parameters).
5. [Catch `AuthRefusedError` where you matched a 401](#5-catch-authrefusederror).
6. [If you wrote a wire, use `authorize` and `logon`](#6-a-custom-wire).

If you use none of these — you hold a provider you wrote yourself against
`IAuthProvider` 3.0 and take the HTTP wire — only step 5 can concern you.

## 1. The providers moved

`BasicAuthProvider`, `TokenAuthProvider`, `SamlAuthProvider`,
`CertificateAuthProvider` and `FileCertificateMaterialLoader` are no longer
exported here. They are in `@mcp-abap-adt/auth-providers` ^5.0.1 with the same
names.

```bash
npm install @mcp-abap-adt/auth-providers
```

```diff
-import {
-  AdtOnPremConnector,
-  BasicAuthProvider,
-  OnPremHttpTransport,
-} from '@mcp-abap-adt/connection';
+import { AdtOnPremConnector, OnPremHttpTransport } from '@mcp-abap-adt/connection';
+import { BasicAuthProvider } from '@mcp-abap-adt/auth-providers';
```

This package has no runtime dependency on `auth-providers`; you install it
because you use it. `IAuthProvider` itself is still not re-exported: import the
type from `@mcp-abap-adt/interfaces-auth`, which is where the ^3.0.0 contract
lives — an older `interfaces-auth` makes a provider of yours a type error.

## 2. `TokenAuthProvider` has two constructors now

`new TokenAuthProvider(x)` is gone. A fixed token and a renewing one are different
objects, and the name says which.

```diff
-new TokenAuthProvider('eyJhbGciOiJSUzI1NiIs...')
+TokenAuthProvider.fixed('eyJhbGciOiJSUzI1NiIs...')

-new TokenAuthProvider(refresher)
+TokenAuthProvider.from(refresher)
```

`.from` renews when the system refuses the token — not by checking expiry before
each request, as the old class did. Many requests meeting one expired token each
call `rejected()` and share one renewal in flight; the connection adds no
single-flight of its own.

## 3. TLS material is taken at logon

Before, a certificate credential's `cert` / `key` / `pfx` / `passphrase` reached
the HTTPS agent only because you passed them in `agentOptions`:

```diff
-const material = await loader.load(config);
 new OnPremHttpTransport(
-  () => ({ cert: material.cert, key: material.key, ca: myCa }),
+  () => ({ ca: myCa }),
   logger,
   { client: config.client, baseUrl: config.url },
 )
```

Now the HTTP wire offers a logon target to the provider at every logon; a
provider such as `CertificateAuthProvider` hands over its material there, and the
wire builds the agent from `{ rejectUnauthorized, ...agentOptions(), ...material }`
on the first request. A later logon offering different material replaces the
client; the cookie jar and CSRF token are the session's and stay.

`agentOptions` stays for what is not the credential: `ca` and
`rejectUnauthorized`. Material you leave in it still works for a provider that
offers none, but nothing depends on that.

## 4. RFC: the factory takes the logon parameters

`RfcTransport` opens a conversation for the session and one per non-stateful
call, and each open now takes the logon parameters the provider wrote for it —
a password, or SNC settings.

- `RfcTransport`'s first argument is
  `(logon: Readonly<Record<string, string>>) => IRfcConversation`; it was
  `() => IRfcConversation`.
- `rfcConversationFrom(config)` returns such a factory. If you only ever passed
  its result to `RfcTransport`, nothing changes for you.
- `rfcParamsFrom(config)` returns the address only — `ashost`, `sysnr`,
  `client` (default `'000'`), `lang` (`'EN'`). It no longer reads
  `config.username` / `config.password`, and `RfcConnectionParams` lost `user`
  and `passwd`. The credential comes from the provider, and only from it.

If you wrote your own factory:

```diff
-const factory = () => new Client(rfcParamsFrom(config));
+const factory = (logon: Readonly<Record<string, string>>) =>
+  new Client({ ...rfcParamsFrom(config), ...logon });
```

A provider that writes no logon parameters — a bearer token — cannot log on over
RFC. The open fails, the provider is asked, and you get its refusal; RFC cannot
carry a bearer token.

A failed open is thrown as a `WireLogonError` whose `cause` is the raw
`sap-rfc-lite` error. The old `Failed to open RFC connection: …` wrapping is
gone, so a provider can read the SDK's `key` and message and, say, tell an SNC
failure from a network one.

## 5. Catch `AuthRefusedError`

Before, a refused credential arrived as whatever the wire threw — an axios error
with `response.status === 401`, an RFC logon failure — and a caller matching on
the status had to guess what it meant.

Now a 401 that survives the wire's own session recovery, and any refused logon, is put to
`provider.rejected(...)`. On Ok the request is authorized again and sent once
more; if the provider says no, or the retry is refused too, the caller gets an
`AuthRefusedError`:

```diff
 try {
   await connection.connect();
 } catch (error) {
-  if ((error as any).response?.status === 401) {
-    console.error('bad credentials');
-  }
+  if (error instanceof AuthRefusedError) {
+    // The provider's words, not ours: it knows whether it was a password, a
+    // token, or an SNC library that was missing.
+    console.error(error.refusal.reason, error.refusal.hint);
+  }
 }
```

```text
class AuthRefusedError extends Error {
  readonly refusal: { reason: string; hint?: string }; // the provider's words
  readonly at: 'prepare' | 'logon' | 'request';         // when it refused
  readonly cause?: unknown;                             // the wire's error, as it arrived
}
```

- `at: 'prepare'` — the provider refused before the wire opened; nothing was sent.
- `at: 'logon'` — the system refused a logon, or the provider refused to offer one.
- `at: 'request'` — the provider refused to authorize a request, or the system
  refused it again after a renewal.
- After an Ok, a second refusal is the verdict: the provider is not asked again
  and `refusal` is `{ reason: 'the credential was refused again after the
  provider renewed it' }`, with the second wire error as `cause`.
- A provider that throws is treated as refusing with the reason "the credential
  provider failed" and the throw as `cause`.
- A `403` is never put to the provider and never becomes an `AuthRefusedError`; it
  reaches you unchanged, as before.

`prepare()` now runs once at the start of `connect()`, before the wire opens; it
used to come after `transport.open()`.

## 6. A custom wire

If you implement `IAdtTransport` yourself, `IAdtSessionContext.authHeaders` is
gone. Two methods replace it:

- `authorize(headers)` — fill the credential into a request the wire itself
  originates (the CSRF fetch, a preflight, a logoff), per request, never held.
- `logon(target)` — call it at each of your logons, before any request. Pass a
  `target` (an `ILogonTarget`) that says what your wire can carry: `tlsMaterial`
  and `logonParameters` each answer Ok or `{ ok: false, refusal }`.

```diff
 async close(context: IAdtSessionContext): Promise<void> {
   const headers: Record<string, string> = {};
-  Object.assign(headers, await context.authHeaders());
+  await context.authorize(headers);
   await this.client.post('/logoff', undefined, { headers });
 }
```

```ts
import type {
  AuthOutcome,
  ILogonTarget,
} from '@mcp-abap-adt/interfaces-auth';
import {
  type IAdtSessionContext,
  WireLogonError,
} from '@mcp-abap-adt/connection';

async function logOn(
  context: IAdtSessionContext,
  open: (parameters: Record<string, string>) => Promise<void>,
): Promise<void> {
  let parameters: Record<string, string> = {};
  const target: ILogonTarget = {
    tlsMaterial: (): AuthOutcome => ({
      ok: false,
      refusal: { reason: 'this wire carries no TLS material (example wire)' },
    }),
    logonParameters: (offered): AuthOutcome => {
      parameters = { ...offered };
      return { ok: true };
    },
  };
  // Throws AuthRefusedError(at 'logon') if the provider refuses the logon.
  await context.logon(target);
  try {
    await open(parameters);
  } catch (cause) {
    // Mark the failure as a refused logon; the connection asks the provider
    // what to do about it. The wire decides nothing, and passes the raw error.
    throw new WireLogonError(cause);
  }
}
```

`WireLogonError { cause, status? }` is the mark a wire puts on a failure that is
a refused logon. `cause` is the raw error, never re-wrapped; `status` is the HTTP
status when there is one (the HTTP wire marks a 401 while establishing its
session this way). A `WireLogonError` reaches `rejected()` with `at: 'logon'`; a
401 on a request that survived the wire's own recovery reaches it with
`at: 'request'`.

## Removed with no replacement

Nothing read them:

- `CredentialAbapConnection.getHttpsAgentOptions`, `buildAuthorizationHeader`, `isUnauthorized`
- `AbstractAbapConnection.recoverSession`, `discardSession`
- `src/utils/tokenRefresh.ts` and `src/auth/ntlm.ts` (neither was exported)

## Why

Until 9.x the connection read the credential itself: which header it produced,
whether it could be renewed, whether it carried TLS material, and it wrapped or
dropped what the wire said about a refusal. Each new kind of credential — a
token, a certificate, SNC — was a change in the connection, and a refusal reached
the caller as a bare 401 nobody could word. With `IAuthProvider` 3.0 the provider
writes the credential and words its own refusal, the wire only carries it, and
the connection keeps to the lifecycle: one more attempt, never a loop.
