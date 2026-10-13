# Scope

`@mcp-abap-adt/connection` answers for this, and only this:

1. **Building a connection.** `createConnection({ system, transport, … })`: cloud + HTTP,
   on-prem + HTTP, on-prem + legacy HTTP (BASIS 7.40), on-prem + RFC. The caller states
   the system and the transport; nothing is inferred.
2. **One instance, one SAP session.** `connect()` logs on; the first authenticated request
   opens the session. A new session is a new instance.
3. **Requests.** Each carries the credential the `IAuthProvider` hands over, the CSRF token
   and the session's cookies. A request is sent stateful (`LOCK`, `UNLOCK`, activation) or
   stateless; nothing else of the session is kept between requests.
4. **SAP's answer** reaches the caller as SAP gave it.
5. **`disconnect()`, once.** It sends the logoff when the instance holds a live
   `SAP_SESSIONID` and resolves when the logoff is written. A `connect()` that failed after
   opening a session logs it off before it rejects. `flushGoodbye(ms?)` waits for SAP's
   answer to the logoff.
