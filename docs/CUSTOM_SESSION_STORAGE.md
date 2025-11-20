# Custom Session Storage

If you prefer to store session state in your own storage (database, Redis, etc.) instead of using `FileSessionStorage`, you can use `getSessionState()` and `setSessionState()` methods.

**See working example:** [examples/custom-session-storage.js](./examples/custom-session-storage.js)

## Get Session State

After any request (e.g., lock), get the current session state:

```javascript
import { createAbapConnection } from '@mcp-abap-adt/connection';
import { lockClass } from '@mcp-abap-adt/adt-clients';

const connection = createAbapConnection(config, logger);

// Lock object
const lockHandle = await lockClass(connection, 'ZCL_MY_CLASS', 'my-session-id');

// Get session state (cookies, CSRF token)
const sessionState = connection.getSessionState();

// sessionState is a JSON object:
// {
//   cookies: "sap-usercontext=sap-client=100; sap-XSRF_TRL_100=...",
//   csrfToken: "abc123...",
//   cookieStore: {
//     "sap-usercontext": "sap-client=100",
//     "sap-XSRF_TRL_100": "...",
//     "sap-contextid": "..."
//   }
// }

// Store it wherever you want:
await myDatabase.saveSession('my-session-id', sessionState);
// or
await redis.set(`session:my-session-id`, JSON.stringify(sessionState));
// or
fs.writeFileSync('my-session.json', JSON.stringify(sessionState));
```

## Set Session State

Later, restore the session from your storage:

```javascript
import { createAbapConnection } from '@mcp-abap-adt/connection';
import { unlockClass } from '@mcp-abap-adt/adt-clients';

const connection = createAbapConnection(config, logger);

// Load session from your storage
const sessionState = await myDatabase.loadSession('my-session-id');
// or
const sessionState = JSON.parse(await redis.get(`session:my-session-id`));
// or
const sessionState = JSON.parse(fs.readFileSync('my-session.json', 'utf-8'));

// Restore session state to connection
connection.setSessionState(sessionState);

// Now you can unlock using the restored session
await unlockClass(connection, 'ZCL_MY_CLASS', lockHandle, 'my-session-id');
```

## Session State Structure

```typescript
interface SessionState {
  cookies: string | null;          // Raw cookie string for Cookie header
  csrfToken: string | null;        // CSRF token for x-csrf-token header
  cookieStore: Record<string, string>; // Parsed cookies as key-value map
}
```

## Example: Store in MongoDB

```javascript
// After lock
const sessionState = connection.getSessionState();
await mongodb.collection('sessions').insertOne({
  sessionId: 'my-session-id',
  state: sessionState,
  lockHandle: lockHandle,
  objectName: 'ZCL_MY_CLASS',
  createdAt: new Date()
});

// Before unlock
const doc = await mongodb.collection('sessions').findOne({ sessionId: 'my-session-id' });
connection.setSessionState(doc.state);
await unlockClass(connection, doc.objectName, doc.lockHandle, doc.sessionId);
```

## Example: Store in Redis

```javascript
// After lock
const sessionState = connection.getSessionState();
await redis.setex(
  `session:my-session-id`,
  3600, // TTL 1 hour
  JSON.stringify({
    state: sessionState,
    lockHandle: lockHandle,
    objectName: 'ZCL_MY_CLASS'
  })
);

// Before unlock
const data = JSON.parse(await redis.get(`session:my-session-id`));
connection.setSessionState(data.state);
await unlockClass(connection, data.objectName, data.lockHandle, 'my-session-id');
```

## Notes

- `getSessionState()` returns `null` if no cookies/CSRF token are available
- `setSessionState()` accepts partial state (missing fields default to `null` or `{}`)
- Session state is automatically updated after each request when using `enableStatefulSession()`
- For manual control, use `getSessionState()` / `setSessionState()` without `enableStatefulSession()`
