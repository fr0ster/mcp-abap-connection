/**
 * The shared contract this package implements is interfaces-adt-connection 5
 * — checked by compiling: each `@ts-expect-error` below is a line that must
 * not compile, and the build fails the moment it does. The calls sit in
 * functions that are never run.
 *
 * - both connectors are assignable to the installed `IAbapConnection`: the
 *   connector's own generic `makeAdtRequest` fits the contract's non-generic
 *   one, so a consumer holding a connector can pass it on;
 * - the installed `IAbapConnection.makeAdtRequest` takes no type argument.
 *   That is true of version 5 alone (4 took the caller's `T`), so this file
 *   compiles only against 5.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IAbapConnection } from '@mcp-abap-adt/interfaces-adt-connection';
import type { AdtCloudConnector } from '../connection/AdtCloudConnector.js';
import type { AdtOnPremConnector } from '../connection/AdtOnPremConnector.js';

function bothConnectorsAreTheSharedContract(
  onPrem: AdtOnPremConnector,
  cloud: AdtCloudConnector,
): IAbapConnection[] {
  return [onPrem, cloud];
}

function theContractTakesNoTypeArgument(connection: IAbapConnection): void {
  // @ts-expect-error interfaces-adt-connection 5: the caller names no response type
  connection.makeAdtRequest<string>({
    url: '/sap/bc/adt',
    method: 'GET',
    timeout: 1000,
  });
}

describe('the shared connection contract', () => {
  it('is interfaces-adt-connection 5, checked by compiling this file', () => {
    // Referenced so the compiler and the linter see them used; never called.
    assert.strictEqual(typeof bothConnectorsAreTheSharedContract, 'function');
    assert.strictEqual(typeof theContractTakesNoTypeArgument, 'function');
  });
});
