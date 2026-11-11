/**
 * Which header values the RFC wire log redacts, decided by the header's name
 * with plain string code — no regular expression in the RFC wire.
 *
 * The verdicts are the ones the wire's former patterns gave; those patterns
 * are kept here, in the test only, as the oracle every row is checked against.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type IRfcConversation,
  RfcTransport,
} from '../connection/RfcTransport.js';
import type { ILogger } from '../logger.js';

/** The wire's former patterns: the oracle, never production code. */
const FORMER_PATTERNS = [
  /authorization/i,
  /cookie/i,
  /token/i,
  /secret/i,
  /password/i,
  /credential/i,
  /api[-_]?key/i,
];

function formerVerdict(name: string): boolean {
  return FORMER_PATTERNS.some((pattern) => pattern.test(name));
}

const KELVIN_SIGN = 'K';

const REDACTED = [
  'Authorization',
  'x-CSRF-Token',
  'Cookie',
  'Set-Cookie',
  'X-Api-Key',
  'x-apikey',
  'API_KEY',
  'My-Secret',
  'Proxy-Credential',
  'PASSWORD',
];

const KEPT = [
  'Accept',
  'Content-Type',
  'X-Api--Key',
  'api.key',
  `X-Api-${KELVIN_SIGN}ey`,
  'sap-language',
];

const answer = {
  RESPONSE: {
    STATUS_LINE: { STATUS_CODE: 200, REASON_PHRASE: 'OK' },
    HEADER_FIELDS: [],
    MESSAGE_BODY: Buffer.from('', 'utf-8'),
  },
};

function conversation(): IRfcConversation {
  return {
    alive: true,
    open: async () => {},
    close: async () => {},
    call: async () => answer,
  };
}

/** The `RFC HEADERS:` line a request with `name: value` produces. */
async function headersLine(name: string, value: string): Promise<string> {
  const lines: string[] = [];
  const logger: ILogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: (line: string) => {
      lines.push(line);
    },
  };
  const transport = new RfcTransport(() => conversation(), logger, {
    logWire: true,
  });
  await transport.open();
  await transport.send({
    method: 'GET',
    url: '/sap/bc/adt/discovery',
    headers: { [name]: value },
  });
  const line = lines.find((each) => each.startsWith('RFC HEADERS:'));
  assert.notStrictEqual(line, undefined);
  return line ?? '';
}

const VALUE = 'VALUE-THAT-MUST-NOT-LEAK';

describe('the RFC wire log redacts a header by its name, without a regex', () => {
  for (const name of REDACTED) {
    it(`redacts ${JSON.stringify(name)}, as the former patterns did`, async () => {
      assert.strictEqual(formerVerdict(name), true);
      const line = await headersLine(name, VALUE);
      assert.ok(!line.includes(VALUE), line);
      assert.ok(line.includes('[redacted]'));
    });
  }

  for (const name of KEPT) {
    it(`keeps ${JSON.stringify(name)}, as the former patterns did`, async () => {
      assert.strictEqual(formerVerdict(name), false);
      const line = await headersLine(name, VALUE);
      assert.ok(line.includes(VALUE), line);
    });
  }

  it('folds only ASCII letters: the Kelvin sign is not a k', async () => {
    const line = await headersLine(`x-api-${KELVIN_SIGN}ey`, VALUE);
    assert.ok(line.includes(VALUE), line);
  });
});
