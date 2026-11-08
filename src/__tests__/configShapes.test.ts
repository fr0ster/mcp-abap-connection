/**
 * The shapes the compiler holds the wires to — checked by compiling: each
 * `@ts-expect-error` below is a line that must not compile, and the build
 * fails the moment it does. The calls sit in functions that are never run.
 *
 * - each `createConnection` spec takes its own config shape: an HTTP wire an
 *   `ISapHttpConfig`, RFC an `ISapRfcConfig`; no other system and wire pair
 *   compiles;
 * - an HTTP transport is built with its base URL: there is no default;
 * - the session context a connection hands a wire carries no base URL.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BasicAuthProvider } from '@mcp-abap-adt/auth-providers';
import type {
  ISapHttpConfig,
  ISapRfcConfig,
} from '@mcp-abap-adt/interfaces-auth-sap';
import { CloudHttpTransport } from '../connection/CloudHttpTransport.js';
import { createConnection } from '../connection/createConnection.js';
import { HttpTransport } from '../connection/HttpTransport.js';
import type { IAdtSessionContext } from '../connection/IAdtTransport.js';
import { LegacyOnPremHttpTransport } from '../connection/LegacyOnPremHttpTransport.js';
import { OnPremHttpTransport } from '../connection/OnPremHttpTransport.js';

const http: ISapHttpConfig = {
  url: 'https://sap.example.com',
  authType: 'basic',
  client: '100',
};
const rfc: ISapRfcConfig = {
  connectionType: 'rfc',
  authType: 'basic',
  ashost: 'saphost',
  sysnr: '00',
  client: '100',
  language: 'EN',
};
const credential = new BasicAuthProvider('u', 'p');

function specsRefuseTheOtherShape(): void {
  // @ts-expect-error the cloud HTTP wire takes an HTTP config, not an RFC one
  createConnection({
    system: 'cloud',
    transport: 'http',
    config: rfc,
    credential,
  });
  // @ts-expect-error the on-prem HTTP wire takes an HTTP config
  createConnection({
    system: 'onprem',
    transport: 'http',
    config: rfc,
    credential,
  });
  // @ts-expect-error the BASIS 7.40 HTTP wire takes an HTTP config
  createConnection({
    system: 'onprem',
    transport: 'legacy-http',
    config: rfc,
    credential,
  });
  // @ts-expect-error the RFC wire takes an RFC config, not an HTTP one
  createConnection({
    system: 'onprem',
    transport: 'rfc',
    config: http,
    credential,
  });
}

function noOtherCombinationCompiles(): void {
  // @ts-expect-error ABAP Cloud has one wire, 'http'
  createConnection({
    system: 'cloud',
    transport: 'rfc',
    config: rfc,
    credential,
  });
  // @ts-expect-error ABAP Cloud has no BASIS 7.40 wire
  createConnection({
    system: 'cloud',
    transport: 'legacy-http',
    config: http,
    credential,
  });
}

function httpTransportsNeedTheirBaseUrl(): void {
  // @ts-expect-error no base URL: an HTTP wire has nothing to address
  new HttpTransport();
  // @ts-expect-error no base URL
  new CloudHttpTransport(undefined, null, { client: '100' });
  // @ts-expect-error no base URL
  new OnPremHttpTransport(() => ({}), null);
  // @ts-expect-error no base URL
  new LegacyOnPremHttpTransport();
}

function theSessionContextHasNoBaseUrl(context: IAdtSessionContext): void {
  // @ts-expect-error the wire holds its own base URL; the context has none
  context.baseUrl;
}

describe('the shapes the wires take', () => {
  it('are checked by compiling this file', () => {
    // Referenced so the compiler and the linter see them used; never called.
    assert.strictEqual(typeof specsRefuseTheOtherShape, 'function');
    assert.strictEqual(typeof noOtherCombinationCompiles, 'function');
    assert.strictEqual(typeof httpTransportsNeedTheirBaseUrl, 'function');
    assert.strictEqual(typeof theSessionContextHasNoBaseUrl, 'function');
  });
});
