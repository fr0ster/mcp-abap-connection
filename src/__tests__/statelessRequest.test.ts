/**
 * `stateless: true` sends the request stateless whatever the session mode,
 * and wins over a caller's own `x-sap-adt-sessiontype: stateful` header in any
 * letter case. The session mode is not changed: the next ordinary request is
 * stateful again, and a refusal of a stateless request leaves the next
 * stateless one stateless too.
 *
 * On the wire: no session header and no `sap-contextid` cookie — over HTTP on
 * a real local socket, over RFC in the `HEADER_FIELDS` of a call that goes on
 * a conversation other than the stateful one.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { BasicAuthProvider } from '@mcp-abap-adt/auth-providers';
import type { IAbapRequestOptions } from '@mcp-abap-adt/interfaces-adt-connection';
import type { ISapRfcConfig } from '@mcp-abap-adt/interfaces-auth-sap';
import { AdtOnPremConnector } from '../connection/AdtOnPremConnector.js';
import type {
  IAdtTransportRequest,
  IAdtTransportResponse,
  IOnPremTransport,
} from '../connection/IAdtTransport.js';
import { OnPremHttpTransport } from '../connection/OnPremHttpTransport.js';
import {
  type IRfcConversation,
  type RfcConversationFactory,
  RfcTransport,
} from '../connection/RfcTransport.js';
import { isStatefulRequest } from '../connection/statefulRequest.js';
import { holdsNoSession } from './helpers/transportStub.js';

const PATH = '/sap/bc/adt/abapgit/repos';

function call(
  stateless: boolean,
  headers: Record<string, string> = {},
): IAbapRequestOptions {
  return {
    url: PATH,
    method: 'GET',
    timeout: 5000,
    headers,
    ...(stateless ? { stateless: true } : {}),
  };
}

/** The caller's own session header, in a letter case of its own. */
const ASKS_STATEFUL = { 'X-Sap-Adt-SessionType': 'Stateful' };

describe('the shared verdict', () => {
  it('stateless wins over the flag and over the header', () => {
    assert.strictEqual(
      isStatefulRequest({
        method: 'GET',
        url: PATH,
        stateful: true,
        stateless: true,
        headers: ASKS_STATEFUL,
      }),
      false,
    );
    assert.strictEqual(
      isStatefulRequest({ method: 'GET', url: PATH, headers: ASKS_STATEFUL }),
      true,
    );
  });
});

describe('stateless over a transport of the caller’s own', () => {
  it('the request is marked not stateful, and the mode stays stateful', async () => {
    const sent: IAdtTransportRequest[] = [];
    const transport: IOnPremTransport = {
      kind: 'own',
      system: 'onprem',
      ...holdsNoSession,
      sessionEstablished: () => true,
      sessionFingerprint: () => new Map([['own', 'S1']]),
      send: async (request): Promise<IAdtTransportResponse> => {
        sent.push(request);
        return { status: 200, headers: {}, data: 'ok' };
      },
    };
    const connection = new AdtOnPremConnector(
      { url: 'http://sap.invalid', authType: 'basic', client: '100' },
      new BasicAuthProvider('u', 'p'),
      transport,
      null,
    );
    await connection.connect();
    connection.setSessionType('stateful');
    await connection.makeAdtRequest(call(true));
    await connection.makeAdtRequest(call(false));
    assert.deepStrictEqual(
      sent.map((r) => [r.stateful, r.stateless]),
      [
        [false, true],
        [true, undefined],
      ],
    );
    assert.strictEqual(connection.getSessionMode(), 'stateful');
  });
});

describe('stateless over HTTP', () => {
  interface Arrival {
    sessionType: string | undefined;
    cookie: string;
  }
  let server: Server;
  let baseUrl: string;
  const arrivals: Arrival[] = [];
  let refuse = false;

  beforeEach(async () => {
    arrivals.length = 0;
    refuse = false;
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const path = (req.url ?? '').split('?')[0] ?? '';
        if (path.endsWith('/discovery')) {
          res.writeHead(200, {
            'x-csrf-token': 'T1',
            'set-cookie': 'SAP_SESSIONID_STUB_100=S1; Path=/',
          });
          res.end('<service/>');
          return;
        }
        const sessionType = req.headers['x-sap-adt-sessiontype'];
        arrivals.push({
          sessionType:
            typeof sessionType === 'string' ? sessionType : undefined,
          cookie: req.headers.cookie ?? '',
        });
        res.writeHead(refuse ? 500 : 200, {
          'content-type': 'text/plain',
          // The stateful context, as SAP names it on a stateful answer.
          ...(sessionType === 'stateful'
            ? { 'set-cookie': 'sap-contextid=CTX1; Path=/' }
            : {}),
        });
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  });

  it('goes without the session header and the context cookie; the next ordinary request is stateful', async () => {
    const connection = new AdtOnPremConnector(
      { url: baseUrl, authType: 'basic', client: '100' },
      new BasicAuthProvider('u', 'p'),
      new OnPremHttpTransport(() => ({}), null, { client: '100', baseUrl }),
      null,
    );
    await connection.connect();
    try {
      connection.setSessionType('stateful');
      // Opens the stateful context: the jar now holds `sap-contextid`.
      await connection.makeAdtRequest(call(false));
      await connection.makeAdtRequest(call(true, ASKS_STATEFUL));
      await connection.makeAdtRequest(call(false));
      refuse = true;
      await assert.rejects(
        connection.makeAdtRequest(call(true, ASKS_STATEFUL)),
      );
      refuse = false;
      await connection.makeAdtRequest(call(true, ASKS_STATEFUL));

      const seen = arrivals.map((a) => [
        a.sessionType,
        a.cookie.includes('sap-contextid=CTX1'),
        a.cookie.includes('SAP_SESSIONID_STUB_100=S1'),
      ]);
      assert.deepStrictEqual(seen, [
        ['stateful', false, true],
        [undefined, false, true],
        ['stateful', true, true],
        [undefined, false, true],
        [undefined, false, true],
      ]);
      assert.strictEqual(connection.getSessionMode(), 'stateful');
    } finally {
      await connection.disconnect();
    }
  });
});

describe('stateless over RFC', () => {
  const config: ISapRfcConfig = {
    connectionType: 'rfc',
    authType: 'basic',
    username: 'USER',
    password: 'PASS',
    ashost: 'saphost',
    sysnr: '00',
    client: '100',
    language: 'EN',
  };

  interface Call {
    /** Which conversation carried it: 0 is the stateful one. */
    conversation: number;
    fields: { NAME: string; VALUE: string }[];
  }

  function recording(calls: Call[], refuse: { on: boolean }) {
    let made = 0;
    const factory: RfcConversationFactory = () => {
      const index = made++;
      let alive = false;
      const conversation: IRfcConversation = {
        get alive() {
          return alive;
        },
        open: async () => {
          alive = true;
        },
        close: async () => {
          alive = false;
        },
        resetServerContext: async () => {},
        call: async (_fm, params) => {
          const requestPart = params.REQUEST;
          const fields: { NAME: string; VALUE: string }[] = [];
          if (
            typeof requestPart === 'object' &&
            requestPart !== null &&
            'HEADER_FIELDS' in requestPart &&
            Array.isArray(requestPart.HEADER_FIELDS)
          ) {
            for (const field of requestPart.HEADER_FIELDS) {
              fields.push({
                NAME: String(field.NAME),
                VALUE: String(field.VALUE),
              });
            }
          }
          calls.push({ conversation: index, fields });
          return {
            RESPONSE: {
              STATUS_LINE: {
                STATUS_CODE: refuse.on ? 500 : 200,
                REASON_PHRASE: 'OK',
              },
              HEADER_FIELDS: [],
              MESSAGE_BODY: Buffer.from('ok', 'utf-8'),
            },
          };
        },
      };
      return conversation;
    };
    return factory;
  }

  function field(call: Call | undefined, name: string): string | undefined {
    return call?.fields.find((f) => f.NAME.toLowerCase() === name)?.VALUE;
  }

  it('goes on a stateless conversation without the session header and the context cookie; the next ordinary request is stateful', async () => {
    const calls: Call[] = [];
    const refuse = { on: false };
    const connection = new AdtOnPremConnector(
      config,
      new BasicAuthProvider('USER', 'PASS'),
      new RfcTransport(recording(calls, refuse)),
      null,
    );
    await connection.connect();
    const seeded = {
      ...ASKS_STATEFUL,
      Cookie: 'sap-contextid=CTX1; other=kept',
    };
    try {
      connection.setSessionType('stateful');
      await connection.makeAdtRequest(call(true, seeded));
      await connection.makeAdtRequest(call(false));
      refuse.on = true;
      await assert.rejects(connection.makeAdtRequest(call(true, seeded)));
      refuse.on = false;
      await connection.makeAdtRequest(call(true, seeded));

      assert.deepStrictEqual(
        calls.map((c) => [
          c.conversation === 0,
          field(c, 'x-sap-adt-sessiontype'),
          field(c, 'cookie'),
        ]),
        [
          [false, undefined, 'other=kept'],
          [true, undefined, undefined],
          [false, undefined, 'other=kept'],
          [false, undefined, 'other=kept'],
        ],
      );
      assert.strictEqual(connection.getSessionMode(), 'stateful');
    } finally {
      await connection.disconnect();
    }
  });
});
