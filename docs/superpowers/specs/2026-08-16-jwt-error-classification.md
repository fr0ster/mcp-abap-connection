# JWT error classification: stop reporting a 403 as an expired token

**Status:** specified, 2026-08-16. Not implemented. Issue
[#30](https://github.com/fr0ster/mcp-abap-connection/issues/30).

**Scope:** `src/connection/JwtAbapConnection.ts` only. No public API changes to the connection
interface, no version decision taken here.

## The defect

`JwtAbapConnection` catches 401 **and** 403, and when it cannot fix them by refreshing the token
it throws:

```ts
throw new Error('JWT token has expired. Please re-authenticate.');
```

at three places — `establishSession` (line 130), `makeAdtRequest` (line 201) and
`fetchCsrfToken` (line 250). The original `AxiosError` is discarded: the replacement carries no
`response`, no status, no body.

Each site has an escape hatch meant to let permission failures through untouched:

```ts
if (
  responseText.includes('ExceptionResourceNoAccess') ||
  responseText.includes('No authorization') ||
  responseText.includes('Missing authorization')
) {
  throw error;
}
```

**It does not fire for the error SAP actually sends.** Captured against a cloud trial:

```xml
<exc:exception xmlns:exc="...">
  <type id="ExceptionResourceNoAuthorization"/>
  <message lang="EN">You are not authorized to make changes (authorization object S_DEVELOP)</message>
</exc:exception>
```

| pattern | matches this body? |
|---|---|
| `ExceptionResourceNoAccess` | **no** — the type is `ExceptionResourceNoAuthorization`, a different word |
| `No authorization` | **no** — the message says "not authorized" |
| `Missing authorization` | **no** |

So an authorization failure falls through to the refresh path, then to the synthesised message.

### How it was found, which is the part that matters

Not by reading the code. An ATC probe against a cloud trial reported `PROG/P` and `PROG/I` as
`JWT token has expired` on three consecutive runs — **while the same connection was answering
`GET /sap/bc/adt/atc/customizing` with 200 in the same session.** The token was demonstrably
alive. It took going around the connector with plain axios, on the same credential, to see the
403 and the `S_DEVELOP` message.

That is the real cost. The message is not merely inaccurate; it is confidently wrong about a
different subsystem, and it sends whoever reads it to re-authenticate — the one thing that
cannot help. A caller cannot recover the truth, because the status and body are gone.

### The second defect, in the same three blocks

`establishSession` retries itself after a successful refresh:

```ts
if (await this.tryRefreshToken()) {
  return this.establishSession();   // line 127
}
```

`tryRefreshToken()` returns `true` whenever `refreshToken()` **resolves**, not when the new token
works. If the server keeps answering 401 and the refresher keeps handing out tokens, this
recurses without bound. `makeAdtRequest` and `fetchCsrfToken` each retry exactly once and do not
have this shape.

It is in scope here because any fix touches these three blocks, and leaving one unbounded retry
inside a block being rewritten for correctness would be choosing not to look.

## What the fix must achieve

Three properties, in priority order. The first alone would close the issue; the rest are what
stop it recurring in another form.

1. **The original error survives.** Whatever the classification, a caller must still be able to
   read `error.response.status` and the server's message. A connector may add context; it must
   never subtract the status and body.
2. **A 403 is not treated as an expired credential.** An expired bearer token is a 401 from the
   resource server. 403 is the server saying "authenticated, and still no".
3. **Retries are bounded**, including the recursive one.

### Why not just extend the substring list

Adding `ExceptionResourceNoAuthorization` would fix today's case and leave the mechanism intact:
a list of English prose fragments and SAP-internal type names, matched case-sensitively, deciding
whether an error is transient. The next unlisted message is the same bug. The list is the defect,
not its contents.

If a body check survives at all it should match the *type*, and be indifferent to prose:

```ts
const permanent =
  /Exception\w*No(Access|Authorization)/.test(responseText) ||
  /\b(not authorized|no authorization|missing authorization)\b/i.test(responseText);
```

But under property 2 it is largely redundant — those bodies arrive with 403, which no longer
enters the refresh path.

## The design

### Classification

```ts
/**
 * Is this worth refreshing a token for?
 *
 * 401 only. 403 means the server authenticated the caller and refused the
 * action anyway — a new token is the same caller.
 */
function isTokenExpiryCandidate(error: unknown): error is AxiosError {
  return error instanceof AxiosError && error.response?.status === 401;
}
```

A 403 stops entering the refresh path at all, so it propagates as itself, with status and body
intact, and the escape-hatch list disappears with it.

**One risk, stated rather than assumed away.** Some BTP setups answer an invalid token with 403
rather than 401. Nothing captured here shows that, and the trial's expired-token behaviour has
not been observed end to end. Property 1 is what makes this safe to get wrong: if a 403 really
was a token problem, the caller now receives the server's own 403 and message instead of a
misleading one — strictly better than today, even in the case this design does not anticipate.
The plan carries a task to capture a genuinely expired token's status before release, and if it
turns out to be 403, the classifier widens to "403 **and** a body that does not look like an
authorization refusal" — which is when the type-matching regex above earns its place.

### Never synthesise

Every `throw new Error('JWT token has expired…')` goes. When a refresh does not resolve a 401,
the original error is rethrown:

```ts
if (await this.tryRefreshToken()) {
  /* … retry … */
}
// The refresh did not help. The server's answer is the truth about why.
throw error;
```

The message is not lost — it moves to a log line, which is where an explanation belongs:

```ts
this.logger?.error(
  '[ERROR] JwtAbapConnection - 401 persists after token refresh; the credential may need re-authentication',
);
```

A caller that wants to present "please re-authenticate" can do so from `status === 401`, which it
can now see.

### Bound the recursion

`establishSession` takes an internal attempt counter, refreshes at most once, and rethrows the
original error rather than recursing again:

```ts
protected async establishSession(attempt = 0): Promise<void> { … }
```

One refresh is the semantically correct number: a second refresh answers the same question with
the same refresher. `makeAdtRequest` and `fetchCsrfToken` already do exactly one and need only
their throw replaced.

## What breaks

One existing test asserts the message being removed:

`src/__tests__/AbstractAbapConnection.test.ts:315` —
`'JWT auth: 401 on POST … rejects.toThrow('JWT token has expired. Please re-authenticate.')'`.

It is asserting the defect. Its real subject is the surrounding behaviour — that a 401 on POST
does **not** trigger the stale-CSRF retry, and that `csrfToken`/`cookies` survive untouched —
which the same test already checks on the next three lines and which this change does not alter.
The assertion is rewritten to expect the original error (status 401 preserved), not deleted, and
not turned into `rejects.toThrow()` with no argument.

## What gets tested

New tests in `src/__tests__/jwt-connection.test.ts`, each named for the fact it pins:

1. **A 403 with `ExceptionResourceNoAuthorization` propagates with status and body.** The
   regression this is all for. Asserts `error.response.status === 403` and that the body still
   contains `S_DEVELOP`.
2. **A 403 does not call the refresher.** `tokenRefresher.refreshToken` is a mock; it must not be
   called. Without this, a future change could restore the old behaviour while test 1 still
   passes, because a refreshed-then-failed 403 also ends up rethrown.
3. **A 401 with no refresher rethrows the original 401**, not a synthesised message.
4. **A 401 with a refresher that helps** retries once and succeeds — the existing happy path,
   asserted for call counts so "bounded" is checkable.
5. **A 401 with a refresher that keeps resolving but never helps** fails after **one** retry, not
   endlessly. Written against `establishSession`, which is the site that recursed.

Tests 2 and 5 are the ones that would have caught this class of defect; 1 is the one that catches
this instance of it.

## Out of scope

- `BaseAbapConnection` and `SamlAbapConnection`. Neither has a refresh path, and neither
  synthesises an error in place of the server's. Worth a look afterwards; not this change.
- Anything about `S_DEVELOP` or which object types a cloud system permits. That was the
  investigation this came out of, not the subject.
- The version bump and release. A separate decision, taken when the work is done, not here.
