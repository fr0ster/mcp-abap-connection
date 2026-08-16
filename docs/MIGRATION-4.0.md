# Migrating to 4.0.0: the server's error reaches you

A JWT connection used to answer some failures with an error of its own making:

```
Error: JWT token has expired. Please re-authenticate.
```

It said that for a **401** and for a **403** alike, and it threw the original `AxiosError` away
along with the status and the body. Now the server's error reaches the caller unchanged, and only
a 401 is treated as a credential problem.

## What breaks, and what to do

### 1. That message is gone

If anything matches on it, it will stop matching.

```typescript
// before
catch (error) {
  if (error.message.includes('JWT token has expired')) {
    await reauthenticate();
  }
}

// after
catch (error) {
  if (error.response?.status === 401) {
    await reauthenticate();
  }
}
```

`error.response.status` and `error.response.data` are available now — they were not before,
because the replacement error carried neither.

**Why it changed.** The message was wrong about half the cases it was used for. A 403 is not an
expired token, and telling a caller to re-authenticate for one sends them to fix the single thing
that is not broken.

### 2. A 403 no longer triggers a token refresh

It propagates as it arrived. If your code relied on a refresh happening after a 403 — for
instance to recover from an authorization gap that a *different* principal would not have — that
no longer happens, and it never worked for the reason you may have assumed: a refreshed token
belongs to the same caller and cannot change a permissions answer.

What a 403 usually carries is worth reading:

```xml
<exc:exception>
  <type id="ExceptionResourceNoAuthorization"/>
  <message lang="EN">You are not authorized to make changes (authorization object S_DEVELOP)</message>
</exc:exception>
```

The authorization object is named. That is actionable; "please re-authenticate" was not.

### 3. A 401 still refreshes, and now says so when it does not help

The happy path is unchanged: a 401 with an injected `ITokenRefresher` fetches a new token,
re-establishes the session and retries. What changed is the unhappy one — when the retry comes
back 401 as well, the original error is rethrown and an `ERROR`-level log line explains that the
credential may genuinely need re-authentication.

## What did not change

- `ITokenRefresher` and how it is injected;
- that a credential renewal replaces the SAP session — with a lock window open, a request still
  fails with `ADT_SESSION_REPLACED` rather than continuing on a session your lock is not in (see
  [STATEFUL_SESSION_GUIDE.md](./STATEFUL_SESSION_GUIDE.md));
- every other authentication type. `BaseAbapConnection`, `SamlAbapConnection`,
  `CertificateAbapConnection` and `KerberosAbapConnection` never refreshed tokens and never
  synthesised an error in place of the server's.

## Under the hood, if you are debugging

Concurrent requests that hit the same expired token now share **one** renewal — one token fetch
and one session re-establishment between them — rather than each running its own teardown and
recovery in sequence. If you have log-line counts or timing expectations built around the old
behaviour, they will change; the observable contract does not.

## Where this came from

Issue [#30](https://github.com/fr0ster/mcp-abap-connection/issues/30), found while probing ATC on
a cloud trial: creating a classic program was reported as an expired token on three consecutive
runs, while the same session was answering other requests with 200. It took bypassing the
connector on the same credential to see the 403 and the `S_DEVELOP` message underneath.

One question is deliberately left open and tracked in
[#32](https://github.com/fr0ster/mcp-abap-connection/issues/32): whether some BTP setup answers an
*invalid* token with 403 rather than 401. Nothing captured shows that it does, and preserving the
original error is what makes the assumption safe to be wrong about — a caller would then see the
server's own 403 instead of a misleading message.
