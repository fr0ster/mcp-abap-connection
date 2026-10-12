# Migration to 15.0

15.0.0 moves the connection onto `@mcp-abap-adt/interfaces-adt-connection`
**2.0.0**, the contract it implements. Nothing changes at run time: the
lifecycle, the requests, the logoff and every answer are as in 14.1.0. What
changes is a type.

## What changed

`makeAdtRequest` mirrors `IAbapConnection.makeAdtRequest`, and the contract's
2.0.0 made its defaults `unknown` instead of `any`:

```typescript
// 14.x
makeAdtRequest<T = any, D = any>(options): Promise<IAdtWireResponse<T, D>>;
// 15.0
makeAdtRequest<T = unknown, D = unknown>(options): Promise<IAdtWireResponse<T, D>>;
```

So an answer whose type the caller does not name is `unknown`. Reading a field
off it — `response.data.items`, a typo included — compiled against `any` and
no longer compiles.

14.x declared `interfaces-adt-connection` `^1.0.0` while the contract was at
2.0.0, so a consumer on the 2.x contract installed two copies of it. 15.0 holds
one.

## What a consumer must do

Where the compiler now reports an error:

- **Name the type** the request answers, when it is known:
  `connection.makeAdtRequest<string>(options)` for an XML or text body.
- **Narrow `unknown`** where the shape is checked at run time anyway:
  `typeof response.data === 'string'`, or a type guard for an object, before
  reading a field.
- **A stub or mock of `makeAdtRequest`** that returns a fixed shape is no
  longer assignable to the generic signature: declare it generic,
  `async <T = unknown, D = unknown>(options) => ({ … data: body as T … })`,
  or annotate its return as `Promise<IAdtWireResponse<any, any>>` in the test.
- **Be on `@mcp-abap-adt/interfaces-adt-connection` 2** wherever you depend on
  it yourself, so that one copy of the contract is installed
  (`npm ls @mcp-abap-adt/interfaces-adt-connection`).

Code that never reads `response.data` as a typed object, or names its type
already, changes nothing.
