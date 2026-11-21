/**
 * `noLog: true` keeps the request and its answer out of every log.
 *
 * A line, if any, carries the method, the path without its query, the integer
 * status and the byte count — nothing else. Every path that writes about a
 * request is driven here with canaries on both sides: the request's query,
 * `params`, a header and the body; the answer's body, a header and its status
 * text. No line may hold a canary or a `?`, and every line is exactly one of
 * the two quiet forms. The error the connection throws keeps SAP's answer for
 * the caller.
 *
 * Each case also runs without the flag, where a canary does reach a line —
 * so the check can see one, and the ordinary call logs as before.
 *
 * HTTP: the shipped wire on a real local socket, the wire logger included.
 * RFC: the shipped wire over a recording conversation, with `logWire` on.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { BasicAuthProvider } from '@mcp-abap-adt/auth-providers';
import type { IAbapRequestOptions } from '@mcp-abap-adt/interfaces-adt-connection';
import type { ISapRfcConfig } from '@mcp-abap-adt/interfaces-auth-sap';
import { AdtOnPremConnector } from '../connection/AdtOnPremConnector.js';
import { refusalOf } from '../connection/IAdtTransport.js';
import { OnPremHttpTransport } from '../connection/OnPremHttpTransport.js';
import {
  type IRfcConversation,
  type RfcConversationFactory,
  RfcTransport,
} from '../connection/RfcTransport.js';
import type { ILogger } from '../logger.js';

const PATH = '/sap/bc/adt/abapgit/repos';
const CANARIES = [
  'LBCANARY',
  'UCANARY',
  'QCANARY',
  'PCANARY',
  'HCANARY',
  'BCANARY',
  'ACANARY',
  'XCANARY',
  'SCANARY',
];
const ANSWER_BODY = 'answer ACANARY body';
const ANSWER_BYTES = Buffer.byteLength(ANSWER_BODY, 'utf8');
/** What a 403 says when SAP refuses the CSRF token. */
const CSRF_BODY = 'CSRF token validation failed ACANARY';
const CSRF_BYTES = Buffer.byteLength(CSRF_BODY, 'utf8');

interface Entry {
  level: string;
  message: string;
  meta: unknown;
}

function recorder(): { logger: ILogger; entries: Entry[] } {
  const entries: Entry[] = [];
  const at =
    (level: string) =>
    (message: string, meta?: unknown): void => {
      entries.push({ level, message, meta });
    };
  return {
    entries,
    logger: {
      info: at('info'),
      warn: at('warn'),
      error: at('error'),
      debug: at('debug'),
    },
  };
}

function request(method: string, noLog: boolean): IAbapRequestOptions {
  return {
    url: `${PATH}?secret=QCANARY`,
    method,
    timeout: 5000,
    params: { token: 'PCANARY' },
    headers: { 'X-Canary': 'HCANARY' },
    ...(method === 'GET' ? {} : { data: 'body BCANARY' }),
    ...(noLog ? { noLog: true } : {}),
  };
}

function written(entries: Entry[]): string {
  return entries
    .map((e) => `${e.message} ${JSON.stringify(e.meta) ?? ''}`)
    .join('\n');
}

/**
 * The wire's own token fetch is its own request, not this one, and its line is
 * fixed words: a CSRF recovery writes it whatever the request's flags.
 */
const OWN_EXCHANGE_LINES = new Set(['CSRF token obtained']);

/** Every line is one of the two quiet forms, and holds nothing else. */
function assertQuiet(
  entries: Entry[],
  method: string,
  /** The answer's size, when it is not one of the two bodies above. */
  size?: number,
): void {
  const all = written(entries);
  for (const canary of CANARIES) {
    assert.ok(!all.includes(canary), `a line holds ${canary}:\n${all}`);
  }
  assert.ok(!all.includes('?'), `a line holds a query:\n${all}`);
  const own = entries.filter(
    (e) => OWN_EXCHANGE_LINES.has(e.message) && e.meta === undefined,
  );
  assert.strictEqual(
    entries.length - own.length,
    1,
    `one quiet line per request:\n${all}`,
  );
  for (const entry of entries) {
    if (OWN_EXCHANGE_LINES.has(entry.message) && entry.meta === undefined) {
      continue;
    }
    const answered =
      typeof entry.meta === 'object' &&
      entry.meta !== null &&
      'status' in entry.meta;
    if (answered) {
      const { meta } = entry;
      assert.ok(typeof meta === 'object' && meta !== null && 'status' in meta);
      const status = meta.status;
      assert.ok(Number.isInteger(status));
      const bytes = size ?? (status === 403 ? CSRF_BYTES : ANSWER_BYTES);
      assert.strictEqual(
        entry.message,
        `${method} ${PATH} → ${String(status)} (${bytes} bytes)`,
      );
      assert.deepStrictEqual(entry.meta, {
        method,
        path: PATH,
        status,
        bytes,
      });
    } else {
      assert.strictEqual(entry.message, `${method} ${PATH} → no answer`);
      assert.deepStrictEqual(entry.meta, { method, path: PATH });
    }
  }
}

function assertCanarySeen(entries: Entry[]): void {
  const all = written(entries);
  assert.ok(
    CANARIES.some((canary) => all.includes(canary)),
    `no canary in the ordinary lines:\n${all}`,
  );
}

describe('noLog over HTTP', () => {
  type Plan =
    | { status: number; body?: string; headers?: Record<string, string> }
    | 'destroy';
  let server: Server;
  let baseUrl: string;
  let plan: Plan = { status: 200 };
  /** Statuses answered before `plan`, in order. */
  let first: number[] = [];
  /** How many discovery requests still answer `500`. */
  let discoveryFails = 0;
  /** Whether the next discovery request has its socket destroyed. */
  let discoveryDies = false;
  /** Whether the next discovery request is a 405 that carries a token. */
  let discoveryRefusesWithToken = false;
  /** Each answer names another application server: a new value is logged. */
  let served = 0;

  beforeEach(async () => {
    plan = { status: 200 };
    first = [];
    discoveryFails = 0;
    discoveryDies = false;
    discoveryRefusesWithToken = false;
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const path = (req.url ?? '').split('?')[0] ?? '';
        const saplb = `LBCANARY-${++served}`;
        if (path.endsWith('/discovery')) {
          if (discoveryDies) {
            discoveryDies = false;
            req.socket.destroy();
            return;
          }
          if (discoveryFails > 0) {
            discoveryFails -= 1;
            res.writeHead(500, 'SCANARY', { 'sap-adt-saplb': saplb });
            res.end(ANSWER_BODY);
            return;
          }
          if (discoveryRefusesWithToken) {
            discoveryRefusesWithToken = false;
            res.writeHead(405, 'SCANARY', {
              'x-csrf-token': 'T1',
              'sap-adt-saplb': saplb,
            });
            res.end(ANSWER_BODY);
            return;
          }
          res.writeHead(200, {
            'x-csrf-token': 'T1',
            'set-cookie': 'SAP_SESSIONID_STUB_100=S1; Path=/',
            'sap-adt-saplb': saplb,
          });
          res.end('<service/>');
          return;
        }
        if (plan === 'destroy') {
          req.socket.destroy();
          return;
        }
        const status = first.shift() ?? plan.status;
        res.writeHead(status, 'SCANARY', {
          'content-type': 'text/plain',
          'x-answer': 'XCANARY',
          'sap-adt-saplb': saplb,
          ...(first.length === 0 ? plan.headers : {}),
        });
        res.end(plan.body ?? (status === 403 ? CSRF_BODY : ANSWER_BODY));
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

  async function connected() {
    const { logger, entries } = recorder();
    // The wire logger is the same recorder.
    const transport = new OnPremHttpTransport(() => ({}), logger, {
      client: '100',
      baseUrl,
    });
    const connection = new AdtOnPremConnector(
      { url: baseUrl, authType: 'basic', client: '100' },
      new BasicAuthProvider('u', 'p'),
      transport,
      logger,
    );
    await connection.connect();
    entries.length = 0;
    return { connection, entries, transport };
  }

  it('the application server an answer names: not logged with the flag', async () => {
    const { connection, entries } = await connected();
    try {
      for (const noLog of [true, false]) {
        entries.length = 0;
        await connection.makeAdtRequest(request('GET', noLog));
        const named = entries.some((e) => e.message.includes('LBCANARY'));
        assert.strictEqual(named, !noLog, written(entries));
        if (noLog) assertQuiet(entries, 'GET');
      }
    } finally {
      await connection.disconnect();
    }
  });

  it('the CSRF fetch, on the transport itself: the application server it names is not logged with the flag', async () => {
    for (const noLog of [true, false]) {
      for (const refused of [false, true]) {
        const { logger, entries } = recorder();
        const transport = new OnPremHttpTransport(() => ({}), logger, {
          client: '100',
          baseUrl,
        });
        discoveryFails = refused ? 1 : 0;
        const establishing = transport.establish({
          authorize: async () => {},
          logon: async () => {},
          // Leaves the folding in to the transport.
          observe: () => {},
          ...(noLog ? { noLog: true } : {}),
        });
        if (refused) await assert.rejects(establishing);
        else await establishing;
        const named = entries.some((e) => e.message.includes('LBCANARY'));
        assert.strictEqual(named, !noLog, written(entries));
      }
    }
  });

  it('a malformed absolute URL: a fixed placeholder, nothing of the URL', async () => {
    const { connection, entries } = await connected();
    try {
      await assert.rejects(
        connection.makeAdtRequest({
          ...request('GET', true),
          url: 'http://UCANARY:PCANARY@127.0.0.1:99999/x?secret=QCANARY',
        }),
      );
      assert.deepStrictEqual(
        entries.map((e) => [e.message, e.meta]),
        [
          [
            'GET <unparsable url> → no answer',
            { method: 'GET', path: '<unparsable url>' },
          ],
        ],
      );
    } finally {
      await connection.disconnect();
    }
  });

  it('a CSRF fetch that fails, with noResend too: the request’s one quiet line', async () => {
    const { connection, entries, transport } = await connected();
    try {
      transport.adoptCsrfToken(null);
      discoveryFails = 1;
      await assert.rejects(
        connection.makeAdtRequest({ ...request('PUT', true), noResend: true }),
      );
      assertQuiet(entries, 'PUT');
    } finally {
      await connection.disconnect();
    }
  });

  it('a CSRF fetch refused with a token: no line of the wire’s own with the flag', async () => {
    const { connection, entries, transport } = await connected();
    try {
      for (const noLog of [true, false]) {
        entries.length = 0;
        transport.adoptCsrfToken(null);
        discoveryRefusesWithToken = true;
        await connection.makeAdtRequest(request('PUT', noLog));
        const kept = entries.some((e) =>
          e.message.startsWith('CSRF token arrived on a refusal'),
        );
        assert.strictEqual(kept, !noLog, written(entries));
        if (noLog) assertQuiet(entries, 'PUT');
      }
    } finally {
      await connection.disconnect();
    }
  });

  for (const [name, answer, size] of [
    [
      'an answer that says the session is gone',
      { status: 400, body: 'Session not found' },
      Buffer.byteLength('Session not found'),
    ],
    [
      'an answer that replaced the session',
      {
        status: 200,
        headers: { 'set-cookie': 'SAP_SESSIONID_STUB_100=S2; Path=/' },
      },
      ANSWER_BYTES,
    ],
  ] as const) {
    it(`${name}: the quiet line alone, no session-loss line, with the flag`, async () => {
      for (const noLog of [true, false]) {
        // A connection each: the session is lost either way.
        const { connection, entries } = await connected();
        plan = { ...answer };
        try {
          await connection
            .makeAdtRequest(request('GET', noLog))
            .catch((e: unknown) => e);
          await connection.flushGoodbye();
          const lost = entries.some((e) =>
            e.message.startsWith('Session lost'),
          );
          assert.strictEqual(lost, !noLog, written(entries));
          if (noLog) assertQuiet(entries, 'GET', size);
        } finally {
          plan = { status: 200 };
          await connection.disconnect().catch(() => {});
        }
      }
    });
  }

  it('a CSRF fetch whose pooled socket died: no resend line of the wire with the flag', async () => {
    for (const noLog of [true, false]) {
      // A connection each: the fetch must go out on the socket the connect
      // left idle in the pool.
      const { connection, entries, transport } = await connected();
      try {
        transport.adoptCsrfToken(null);
        discoveryDies = true;
        await connection.makeAdtRequest(request('PUT', noLog));
        const resendLine = entries.some((e) =>
          e.message.startsWith('HTTP: a pooled'),
        );
        assert.strictEqual(resendLine, !noLog, written(entries));
        if (noLog) assertQuiet(entries, 'PUT');
      } finally {
        await connection.disconnect();
      }
    }
  });

  it('a CSRF fetch before the mutation that fails: no line of its own with the flag', async () => {
    const { connection, entries, transport } = await connected();
    try {
      for (const noLog of [true, false]) {
        entries.length = 0;
        transport.adoptCsrfToken(null);
        discoveryFails = 1;
        await connection.makeAdtRequest(request('PUT', noLog));
        const fetchLine = entries.some((e) =>
          e.message.startsWith('Could not fetch CSRF token upfront'),
        );
        assert.strictEqual(fetchLine, !noLog, written(entries));
        if (noLog) assertQuiet(entries, 'PUT');
      }
    } finally {
      await connection.disconnect();
    }
  });

  for (const [name, method, status] of [
    ['the request lines of an answered request', 'GET', 200],
    ['the 404 debug line', 'GET', 404],
    ['the refusal preview at error', 'PUT', 500],
    ['a refusal of a mutation', 'POST', 400],
  ] as const) {
    it(`${name}: four facts with the flag`, async () => {
      const { connection, entries } = await connected();
      try {
        for (const noLog of [true, false]) {
          entries.length = 0;
          plan = { status };
          const sent = connection.makeAdtRequest(request(method, noLog));
          if (status === 200) {
            assert.strictEqual((await sent).status, 200);
          } else {
            await assert.rejects(sent, (e) => {
              // The caller keeps SAP's answer.
              assert.strictEqual(refusalOf(e)?.status, status);
              assert.strictEqual(refusalOf(e)?.data, ANSWER_BODY);
              return true;
            });
          }
          if (noLog) {
            assert.ok(entries.length > 0, 'a line was written');
            assertQuiet(entries, method);
          } else {
            assertCanarySeen(entries);
          }
        }
      } finally {
        await connection.disconnect();
      }
    });
  }

  for (const [name, answers, last] of [
    ['the CSRF recovery lines, the resend answered', [403], 200],
    ['the CSRF recovery lines, the resend refused too', [403], 403],
  ] as const) {
    it(`${name}: four facts with the flag`, async () => {
      const { connection, entries } = await connected();
      try {
        for (const noLog of [true, false]) {
          entries.length = 0;
          first = [...answers];
          plan = { status: last };
          const sent = connection.makeAdtRequest(request('PUT', noLog));
          if (last === 200) {
            assert.strictEqual((await sent).status, 200);
          } else {
            await assert.rejects(sent, (e) => {
              assert.strictEqual(refusalOf(e)?.status, 403);
              assert.strictEqual(refusalOf(e)?.data, CSRF_BODY);
              return true;
            });
          }
          if (noLog) {
            assert.ok(entries.length > 0, 'a line was written');
            assertQuiet(entries, 'PUT');
          } else {
            assert.ok(
              entries.some((e) => e.message.startsWith('CSRF ')),
              written(entries),
            );
            assertCanarySeen(entries);
          }
        }
      } finally {
        await connection.disconnect();
      }
    });
  }

  it('a request that got no answer, the wire’s resend line included: the method and path alone', async () => {
    for (const noLog of [true, false]) {
      // A connection each: the request must go out on the pooled socket the
      // connect left idle, so the wire resends it.
      plan = { status: 200 };
      const { connection, entries } = await connected();
      try {
        plan = 'destroy';
        await assert.rejects(connection.makeAdtRequest(request('GET', noLog)));
        if (noLog) {
          assert.ok(entries.length > 0, 'a line was written');
          assertQuiet(entries, 'GET');
        } else {
          assertCanarySeen(entries);
          assert.ok(
            entries.some((e) => e.message.startsWith('HTTP: a pooled')),
            'the wire wrote its resend line',
          );
        }
      } finally {
        plan = { status: 200 };
        await connection.disconnect();
      }
    }
  });
});

describe('noLog over RFC', () => {
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

  type Script = { status: number; statusLine?: boolean } | 'fail';

  function factory(
    next: () => Script,
    reset: 'resets' | 'cannot' | 'fails' | 'close-fails',
  ): RfcConversationFactory {
    let made = 0;
    return () => {
      // The first is the stateful conversation, closed by disconnect().
      const perCall = made++ > 0;
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
          if (reset === 'close-fails' && perCall) {
            throw { codeString: 'RFC_CLOSE_CANARY', message: 'QCANARY' };
          }
        },
        ...(reset === 'cannot' || reset === 'close-fails'
          ? {}
          : {
              resetServerContext: async () => {
                if (reset === 'fails') throw new Error('reset QCANARY');
              },
            }),
        call: async () => {
          const script = next();
          if (script === 'fail') {
            throw {
              name: 'ABAPError',
              group: 5,
              code: 5,
              codeString: 'RFC_ABAP_EXCEPTION',
              key: 'NOT_FOUND',
              message: 'NOT_FOUND QCANARY',
            };
          }
          return {
            RESPONSE: {
              STATUS_LINE:
                script.statusLine === false
                  ? {}
                  : { STATUS_CODE: script.status, REASON_PHRASE: 'SCANARY' },
              HEADER_FIELDS: [{ NAME: 'x-answer', VALUE: 'XCANARY' }],
              MESSAGE_BODY: Buffer.from(
                script.statusLine === false
                  ? `<exc:exception>${ANSWER_BODY}</exc:exception>`
                  : ANSWER_BODY,
                'utf-8',
              ),
            },
          };
        },
      };
      return conversation;
    };
  }

  async function connected(
    next: () => Script,
    reset: 'resets' | 'cannot' | 'fails' | 'close-fails' = 'resets',
  ) {
    const { logger, entries } = recorder();
    const connection = new AdtOnPremConnector(
      config,
      new BasicAuthProvider('USER', 'PASS'),
      new RfcTransport(factory(next, reset), logger, { logWire: true }),
      logger,
    );
    await connection.connect();
    entries.length = 0;
    return { connection, entries };
  }

  for (const [name, method, status] of [
    [
      'the request lines, the outbound URI, headers, body and the status text',
      'POST',
      200,
    ],
    ['the 404 debug line and the status-text line', 'GET', 404],
    ['the refusal preview and the answer body under logWire', 'PUT', 500],
  ] as const) {
    it(`${name}: four facts with the flag`, async () => {
      const { connection, entries } = await connected(() => ({ status }));
      try {
        for (const noLog of [true, false]) {
          entries.length = 0;
          const sent = connection.makeAdtRequest(request(method, noLog));
          if (status === 200) {
            assert.strictEqual((await sent).status, 200);
          } else {
            await assert.rejects(sent, (e) => {
              assert.strictEqual(refusalOf(e)?.status, status);
              assert.strictEqual(refusalOf(e)?.data, ANSWER_BODY);
              return true;
            });
          }
          if (noLog) {
            assert.ok(entries.length > 0, 'a line was written');
            assertQuiet(entries, method);
          } else {
            assertCanarySeen(entries);
          }
        }
      } finally {
        await connection.disconnect();
      }
    });
  }

  for (const [name, reset] of [
    ['a conversation opened for one call (no reset)', 'cannot'],
    ['a reset that fails', 'fails'],
    ['a per-call conversation whose close fails', 'close-fails'],
  ] as const) {
    it(`${name}: the conversation's lines are not written with the flag`, async () => {
      const { connection, entries } = await connected(
        () => ({ status: 200 }),
        reset,
      );
      try {
        for (const noLog of [true, true, false]) {
          entries.length = 0;
          await connection.makeAdtRequest(request('GET', noLog));
          if (noLog) assertQuiet(entries, 'GET');
          else
            assert.ok(
              entries.some((e) =>
                reset === 'close-fails'
                  ? e.message.startsWith('RFC close error')
                  : e.message.startsWith('RFC conversation opened for one') ||
                    e.message.startsWith('RFC reset failed'),
              ),
              written(entries),
            );
        }
      } finally {
        await connection.disconnect();
      }
    });
  }

  it('an absolute URL with a user and a password: the line names its path alone', async () => {
    const { connection, entries } = await connected(() => ({ status: 200 }));
    try {
      await connection.makeAdtRequest({
        ...request('GET', true),
        url: `https://UCANARY:PCANARY@sap.invalid${PATH}?secret=QCANARY#frag`,
      });
      assertQuiet(entries, 'GET');
    } finally {
      await connection.disconnect();
    }
  });

  it('a status read out of the exception XML: no line of its own with the flag', async () => {
    const { connection, entries } = await connected(() => ({
      status: 0,
      statusLine: false,
    }));
    try {
      await assert.rejects(connection.makeAdtRequest(request('GET', true)));
      assert.ok(
        !entries.some((e) => e.message.includes('exception XML')),
        written(entries),
      );
    } finally {
      await connection.disconnect();
    }
  });

  it('a failed RFC call: the method and path alone', async () => {
    const { connection, entries } = await connected(() => 'fail');
    try {
      for (const noLog of [true, false]) {
        entries.length = 0;
        await assert.rejects(connection.makeAdtRequest(request('GET', noLog)));
        if (noLog) {
          assert.ok(entries.length > 0, 'a line was written');
          assertQuiet(entries, 'GET');
        } else {
          assertCanarySeen(entries);
        }
      }
    } finally {
      await connection.disconnect();
    }
  });
});
