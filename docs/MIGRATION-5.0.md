# Migrating to 5.0.0

Two things changed, and the second is why the first was possible.

**A connection now closes what it opened.** `disconnect()` tells the server the
session is finished instead of only dropping the cookie, and `connect()` fails
when the server opened no session rather than handing back a connection whose
first lock would be dead.

**The class you take says which system you are dialling, not which credential
you hold.** `AdtOnPremConnector` and `AdtCloudConnector` are handed an auth
provider; the five auth classes still work and are deprecated.

---

## If you use `createAbapConnection()`

It still works, unchanged, and now warns once per call that the connection is
being chosen from `authType`. Say which system instead:

```ts
// before
const conn = createAbapConnection(config, logger, undefined, tokenRefresher);

// after
const conn = createAbapConnection(config, logger, undefined, tokenRefresher, {
  system: 'cloud',   // or 'onprem'
});
```

Nothing is detected. The two systems do not manage sessions the same way, and
asking the server which it is does not work: `/sap/bc/adt/core/http/sessions`
answers on on-prem too, and its `DELETE` there leaves the session open while the
platform logoff removes it. Only you know where you are pointing.

## If you build a connection class directly

```ts
// before                                    // after
new BaseAbapConnection(cfg, log)             new AdtOnPremConnector(cfg, new BasicAuthProvider(user, pass), log)
new JwtAbapConnection(cfg, log, id, refr)    new AdtCloudConnector(cfg, new TokenAuthProvider(refr), log)
new SamlAbapConnection(cfg, log)             new AdtOnPremConnector(cfg, new SamlAuthProvider(cookies), log)
new CertificateAbapConnection(cfg, log)      new AdtOnPremConnector(cfg, new CertificateAuthProvider(loader, cfg), log)
```

`KerberosAbapConnection` has no provider yet — its SPNEGO exchange *is* the CSRF
fetch — so keep using the class. See #35.

The old classes are not removed and not scheduled for removal here.

## `reset()` is gone — BREAKING

There is no local-only discard, because there is no local-only session: it lives
on the server, and dropping the cookie leaves it there.

```ts
conn.reset();                 // before
await conn.disconnect();      // after — and connect() again to carry on
```

A caller that does not want to wait simply does not `await` it, which is what
`reset()` was mostly used for. `RfcAbapConnection` keeps `close()`.

## `connect()` can now fail where it used to warn — BREAKING

When the server authenticates the request but opens no session, `connect()`
rejects with `ADT_NOT_CONNECTED` and a message saying what happened, what still
works, and the usual cause. It used to log a warning and hand the connection
back — and the failure then surfaced a request later, as `400 Session not found`
with the object half-edited.

Verified rather than assumed: a connection that received no `SAP_SESSIONID` is
listed in the server's own session list as **nothing at all**.

Nothing is retried on your behalf. Whether to wait, retry, or release sessions
the user still holds depends on things only you know.

## `disconnect()` now makes a network call

It tells the server the session is finished. Two consequences:

- **It can wait.** By default it does not: `SAP_RELEASE_DEADLINE_MS` is `0`,
  because waiting is for steps whose successor needs the server to have caught
  up, and a teardown has none. Pass `disconnect({ deadlineMs })` if you want a
  bounded wait — the deadline bounds the **wait**, never the request.
- **Requests still in flight will start failing.** The session they are running
  on is the one being released. That is you having asked to disconnect, not a
  race — finish or abandon your chains first.

It still never throws, including on a nonsense `deadlineMs`: its place is a
`finally`, where an exception would replace the error that sent you there.

## Token renewal, if you use a provider

Nothing to do, but worth knowing what changed. The connector no longer caches
the token it was given. It asks the provider per request — cheap, because the
provider caches — and on a `401` it tells the provider its answer was refused
(`refreshToken()`, per that contract), asks again, and only if the answer
changed rebuilds the session and retries once. An unchanged answer means the
server refused those credentials, and the `401` reaches you.

So a password does the right thing with no configuration, and a bearer token is
renewed without a class of its own.

## Sessions are a shared, per-user resource

Not an API change, a fact worth having. The limit is per user and the pool is
shared with everything else logged on as them, a SAP GUI session included. The
timeout is **idle-based**: a connection that keeps working keeps its session,
one that goes quiet past the window loses it. There is no keepalive timer here,
deliberately — how long to hold a session is yours to decide.

And the shape of the problem this release addresses, seen from the other end: a
process that opens a connection per check and never disconnects filled a
system's session list at one session every ten seconds. Releasing what you open
is half of it; opening one connection instead of one per check is the other.
