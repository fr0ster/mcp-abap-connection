# Migration to 24.0

24.0.0 moves the shared contract to `@mcp-abap-adt/interfaces-adt-connection`
^5.0.0. Nothing changes at run time.

## What changed

- **`IAbapConnection.makeAdtRequest` takes no type argument.** Version 5
  declares `makeAdtRequest(options): Promise<IAdtWireResponse>`; the answer's
  `data` is `unknown`. This package's `AbapConnection` is an alias for
  `IAbapConnection`, so it changed with it.
- **The connectors are unchanged.** `AdtOnPremConnector` and
  `AdtCloudConnector` keep their own `makeAdtRequest` signature, and each is
  assignable to version 5's `IAbapConnection`.

## Who is affected

Code that holds a value typed `IAbapConnection` or `AbapConnection` and calls
`makeAdtRequest<T>(…)` with a type argument. It no longer compiles. Code that
calls it without a type argument, or holds a connector type, is not affected.

## What to do

Drop the type argument and narrow `data` from `unknown` before using it:

```typescript
import type {
  IAbapConnection,
  IAbapRequestOptions,
} from "@mcp-abap-adt/interfaces-adt-connection";

async function readXml(
  connection: IAbapConnection,
  options: IAbapRequestOptions,
): Promise<string> {
  const response = await connection.makeAdtRequest(options);
  if (typeof response.data !== "string") {
    throw new Error("expected a text body");
  }
  return response.data;
}
```
