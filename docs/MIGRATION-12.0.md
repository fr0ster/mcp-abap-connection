# Migration to 12.0

12.0.0 moves the connection onto the **authentication error contract**:
`@mcp-abap-adt/interfaces-auth` 6.0.0, which declares the types, and
`@mcp-abap-adt/auth-errors` 1.0.0, which mints them. Every refusal a provider,
a logon target or the connection itself gives is now an `IAuthProviderError`: a
frozen object with a `kind`, `facts` drawn from closed allowlists, and the
`reason` / `hint` words rendered from them. Free text no longer travels as a
refusal.

The lifecycle didn't change. `prepare`, `establish`, `authorize` and `rejected`
are called when and as often as in 11.x. One `rejected` Ok still buys exactly
one more attempt, and a second refusal is still the verdict. The client guard
of 11.0.1 is unchanged: a request naming another SAP client is still refused
before anything is sent.

## Dependencies

| Package | 11.x | 12.0 |
|---|---|---|
| `@mcp-abap-adt/interfaces-auth` | `^3.0.0` | `^6.0.0` |
| `@mcp-abap-adt/interfaces-auth-sap` | `^2.0.0` | `^3.2.0` |
| `@mcp-abap-adt/auth-errors` | — | `^1.0.0` (new) |

A process should hold **one** interfaces-auth major. Check it with
`npm ls @mcp-abap-adt/interfaces-auth`.

**The providers of `@mcp-abap-adt/auth-providers` 5.x do not fit.** They answer
unbranded `{ reason, hint }` refusals of interfaces-auth 3–5, and those are not
an `AuthOutcome` of 6.0.0, so handing a 5.x `BasicAuthProvider` (or any other
5.x provider) to a connector no longer compiles. Move to
`@mcp-abap-adt/auth-providers` 6.0.0, the release that adopts the same
contract, when it is published. Until then, stay on connection 11.x.

## Reading an `AuthRefusedError`

`AuthRefusedError` keeps its shape: `refusal`, `at` (`'prepare' | 'logon' |
'request'`), `cause`. Its `message` is still `reason — hint`, or the reason
alone. What changed is `refusal`. It is an `IAuthProviderError`, so decide on
its `kind` and `facts`, never on its words:

```typescript
import { AuthRefusedError } from '@mcp-abap-adt/connection';

function explain(error: unknown): string | undefined {
  if (!(error instanceof AuthRefusedError)) return undefined;
  const refusal = error.refusal;
  if (refusal.kind === 'credential-refused') {
    return `the ${refusal.facts.credential} was refused at ${error.at}`;
  }
  if (refusal.kind === 'connection' && refusal.facts.problem === 'provider-threw') {
    return 'the credential provider is broken; see error.cause';
  }
  return error.message; // reason — hint, as in 11.x
}
```

`refusal.reason` and `refusal.hint` read as before. For a switch over every
kind that stops compiling when a kind is added, use `matchKind` from
`@mcp-abap-adt/auth-errors` (see its README).

**A refusal is frozen.** It is deep-frozen, so don't write to it. Relay it as
the object it is. Don't spread it into a new object (`{ ...refusal }`), because
a copy is no longer a minted error. A `structuredClone` of a refusal (sent to
a worker, say) keeps `reason` and `hint`, so an `AuthRefusedError` built over
it still reads `reason — hint`. It is no longer minted, though, and
`isMinted` answers false. Classify it again with `classify` from `auth-errors`
before deciding on it.

## The connection's own refusals

The words are unchanged. Each now has a kind and facts:

| When | `kind` | `facts` | `reason` |
|---|---|---|---|
| the RFC wire is offered TLS material | `logon-target` | `{ wire: 'rfc', refused: 'tls-material' }` | `this wire carries no TLS material (RFC)` |
| the HTTP wire is offered logon parameters | `logon-target` | `{ wire: 'http', refused: 'logon-parameters' }` | `this wire takes no logon parameters (HTTP)` |
| the provider threw, or answered something that is not an outcome | `connection` | `{ problem: 'provider-threw', at }` | `the credential provider failed` |
| refused again after the provider renewed | `connection` | `{ problem: 'refused-after-renewal', at }` | `the credential was refused again after the provider renewed it` |
| a connection without a credential is asked to renew | `connection` | `{ problem: 'no-credential' }` | `this connection has no credential to renew` |

`at` in `facts` is the moment of the `AuthRefusedError` that carries it.

**The connection re-checks what a provider answers.** Every answer passes
through `classifyOutcome`:
- A refusal minted by the same `auth-errors` passes as the same object.
- A refusal minted by another copy is rebuilt from its kind and facts.
- Anything else (a plain `{ reason: '…' }` from a provider written in
  JavaScript, a non-outcome) becomes `provider-threw`, and its text reaches no
  message.

A provider that throws is `provider-threw` too, with the throw as `cause`, as
in 11.x.

## A logon target of your own

A wire of your own hands the provider an `ILogonTarget`. Its refusals must be
minted now, because an object literal is not an `IAuthProviderError` and does
not compile:

```typescript
import { authError } from '@mcp-abap-adt/auth-errors';
import type { AuthOutcome, ILogonTarget } from '@mcp-abap-adt/interfaces-auth';

function logonTarget(parameters: Record<string, string>): ILogonTarget {
  return {
    // A wire of your own is neither of connection's two, so it is `unknown`:
    // "the logon target did not take the TLS material".
    tlsMaterial: (): AuthOutcome => ({
      ok: false,
      refusal: authError['logon-target']({
        wire: 'unknown',
        refused: 'tls-material',
      }),
    }),
    logonParameters: (offered): AuthOutcome => {
      Object.assign(parameters, offered);
      return { ok: true };
    },
  };
}
```

`wire` is one of `http`, `rfc` or `unknown`. `http` and `rfc` carry the words
of connection's own wires (`this wire takes no logon parameters (HTTP)`, …), so
a target of your own uses `unknown` unless it really is one of those.

## A provider of your own

An `IAuthProvider` you wrote answers minted refusals: `authError[kind](facts)`
from `@mcp-abap-adt/auth-errors`. Its `guard(operation, body)` runs one
moment so that a throw becomes a refusal and the answer is classified. A
provider that still answers `{ ok: false, refusal: { reason } }` compiles no
more in TypeScript. In JavaScript, the connection answers `provider-threw` for
it, as described above. `@mcp-abap-adt/auth-providers` 6.0.0 ships
`AuthProviderBase`, which owns the four moments for you.

## Deep imports

11.0.1's index exported none of the refusal constants: only
`AuthRefusedError`, `AuthRefusalMoment` and `WireLogonError`, all unchanged.
There is no `exports` map, though, so a deep import of
`dist/connection/authErrors.js` was possible. If you did that:

- `PROVIDER_FAILED` and `REFUSED_AGAIN` are gone. They are internal functions
  of the moment now, `providerFailed(at)` and `refusedAgain(at)`.
- `NO_CREDENTIAL_TO_RENEW` is a minted error.
- `guarded(call, at)` takes the moment.

None of these is an API. Read the refusal's `kind` and `facts` instead.
