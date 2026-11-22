/**
 * `rawText: true` changes one thing: the body the caller receives as the
 * final answer — a success's `data`, or the `response.data` of the error the
 * caller gets — is the exact text SAP sent. Nothing internal changes: every
 * consumer inside the connection (CSRF recovery, session verdicts, replays,
 * logging, error shapes) reads what the unflagged path has, and a `noLog`
 * line counts the bytes that arrived.
 *
 * The exact text is decoded in the declared charset when `TextDecoder` knows
 * it, else UTF-8, the BOM kept, non-fatally: an invalid byte reads as U+FFFD.
 *
 * Over HTTP through the shipped wire on a real local socket; the check replay
 * through `createConnection` on the SAP stub; RFC with a conversation stub.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { BasicAuthProvider } from '@mcp-abap-adt/auth-providers';
import {
  ADT_SESSION_ERROR,
  type IAbapRequestOptions,
} from '@mcp-abap-adt/interfaces-adt-connection';
import type { ISapRfcConfig } from '@mcp-abap-adt/interfaces-auth-sap';
import axios from 'axios';
import { AdtOnPremConnector } from '../connection/AdtOnPremConnector.js';
import { createConnection } from '../connection/createConnection.js';
import { nodeHttpClient } from '../connection/HttpTransport.js';
import { refusalOf } from '../connection/IAdtTransport.js';
import { OnPremHttpTransport } from '../connection/OnPremHttpTransport.js';
import {
  type IRfcConversation,
  type RfcConversationFactory,
  RfcTransport,
} from '../connection/RfcTransport.js';
import type { ILogger } from '../logger.js';
import { type SapStub, startSapStub } from './helpers/sapStub.js';
import { stubProvider } from './helpers/stubProvider.js';

const DISCOVERY = '/sap/bc/adt/core/discovery';
const FILE = '/sap/bc/adt/abapgit/repos/R1/files/package.json';
const REPLACED = { 'set-cookie': 'SAP_SESSIONID_STUB_100=S2; Path=/' };

interface File {
  name: string;
  bytes: Buffer;
  type: string;
  /** What the caller must receive. */
  text: string;
}

/** The files: each must arrive as exactly `text`. */
const FILES: File[] = [
  {
    name: 'a JSON-object file',
    bytes: Buffer.from('{\n  "name": "x",\n  "version": 1\n}\n'),
    type: 'application/json',
    text: '{\n  "name": "x",\n  "version": 1\n}\n',
  },
  {
    name: 'a JSON-string file with its quotes',
    bytes: Buffer.from('"a string"\n'),
    type: 'text/plain',
    text: '"a string"\n',
  },
  {
    name: 'a file with a trailing newline',
    bytes: Buffer.from('REPORT zx.\n\n'),
    type: 'text/plain',
    text: 'REPORT zx.\n\n',
  },
  {
    name: 'a file with a leading BOM',
    bytes: Buffer.from('﻿{"a":1}\n'),
    type: 'application/json; charset=utf-8',
    text: '﻿{"a":1}\n',
  },
  {
    name: 'an ISO-8859-1 file with its charset',
    bytes: Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]),
    type: 'text/plain; charset=ISO-8859-1',
    text: 'café\n',
  },
  {
    name: 'invalid UTF-8, the byte read as U+FFFD',
    bytes: Buffer.from([0x61, 0xff, 0x62]),
    type: 'text/plain; charset=utf-8',
    text: 'a�b',
  },
  {
    name: 'invalid UTF-8 with no charset declared, read as UTF-8',
    bytes: Buffer.from([0x61, 0xc3, 0x28]),
    type: 'text/plain',
    text: 'a�(',
  },
];

interface Answer {
  status: number;
  body: string | Buffer;
  type: string;
  headers?: Record<string, string>;
}

interface Sap {
  baseUrl: string;
  /** Answers for the next file requests; past the end, `200 ok`. */
  file: Answer[];
  /** Answers for the next discovery requests; past the end, a token. */
  discovery: Answer[];
  /** `true`: the first request on a reused socket is dropped unanswered. */
  dropOnReuse: boolean;
  arrivals: string[];
  close(): Promise<void>;
}

async function startSap(): Promise<Sap> {
  const sap: Sap = {
    baseUrl: '',
    file: [],
    discovery: [],
    dropOnReuse: false,
    arrivals: [],
    close: async () => {},
  };
  const onSocket = new WeakMap<Socket, number>();
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const count = (onSocket.get(req.socket) ?? 0) + 1;
      onSocket.set(req.socket, count);
      const path = (req.url ?? '').split('?')[0] ?? '';
      sap.arrivals.push(`${req.method} ${path}`);
      if (sap.dropOnReuse && count > 1) {
        sap.dropOnReuse = false;
        req.socket.destroy();
        return;
      }
      const queued =
        path === DISCOVERY ? sap.discovery.shift() : sap.file.shift();
      const answer: Answer =
        queued ??
        (path === DISCOVERY
          ? {
              status: 200,
              body: '<service/>',
              type: 'application/xml',
              headers: {
                'x-csrf-token': 'T1',
                'set-cookie': 'SAP_SESSIONID_STUB_100=S1; Path=/',
              },
            }
          : { status: 200, body: 'ok', type: 'text/plain' });
      res.writeHead(answer.status, {
        'content-type': answer.type,
        ...answer.headers,
      });
      res.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  sap.baseUrl = `http://127.0.0.1:${address.port}`;
  sap.close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  return sap;
}

let sap: Sap;

beforeEach(async () => {
  sap = await startSap();
});

afterEach(async () => {
  await sap.close();
});

interface Line {
  level: string;
  message: string;
}

function recorder(): { logger: ILogger; lines: Line[] } {
  const lines: Line[] = [];
  const at =
    (level: string) =>
    (message: string): void => {
      lines.push({ level, message });
    };
  return {
    lines,
    logger: {
      info: at('info'),
      warn: at('warn'),
      error: at('error'),
      debug: at('debug'),
    },
  };
}

async function connected(
  options: { logger?: ILogger; fetchAdapter?: boolean } = {},
) {
  const logger = options.logger ?? null;
  const transport = new OnPremHttpTransport(() => ({}), logger, {
    client: '100',
    baseUrl: sap.baseUrl,
    ...(options.fetchAdapter
      ? {
          httpClient: {
            create: (agents) => axios.create({ ...agents, adapter: 'fetch' }),
            logoffRequest: nodeHttpClient.logoffRequest,
          },
        }
      : {}),
  });
  const connection = new AdtOnPremConnector(
    { url: sap.baseUrl, authType: 'basic', client: '100' },
    new BasicAuthProvider('u', 'p'),
    transport,
    logger,
  );
  await connection.connect();
  sap.arrivals.length = 0;
  return { connection, transport };
}

function read(
  flags: Pick<IAbapRequestOptions, 'rawText' | 'noResend' | 'noLog'> = {},
  method = 'GET',
): IAbapRequestOptions {
  return { url: FILE, method, timeout: 5000, ...flags };
}

function answerOf(file: File, status = 200): Answer {
  return { status, body: file.bytes, type: file.type };
}

const CSRF_REFUSAL: Answer = {
  status: 403,
  body: 'CSRF token validation failed',
  type: 'text/plain',
  headers: { 'x-csrf-token': 'Required' },
};

function sent(method: string): number {
  return sap.arrivals.filter((a) => a === `${method} ${FILE}`).length;
}

describe('rawText: the caller gets the exact text', () => {
  for (const file of FILES) {
    describe(file.name, () => {
      it('a success, on the ordinary send', async () => {
        const { connection } = await connected();
        try {
          sap.file.push(answerOf(file));
          const response = await connection.makeAdtRequest(
            read({ rawText: true }),
          );
          assert.strictEqual(response.data, file.text);
        } finally {
          await connection.disconnect();
        }
      });

      it("an error's body", async () => {
        const { connection } = await connected();
        try {
          sap.file.push(answerOf(file, 404));
          await assert.rejects(
            connection.makeAdtRequest(read({ rawText: true })),
            (error) => {
              assert.strictEqual(refusalOf(error)?.status, 404);
              assert.strictEqual(refusalOf(error)?.data, file.text);
              return true;
            },
          );
        } finally {
          await connection.disconnect();
        }
      });

      it('under noResend', async () => {
        const { connection } = await connected();
        try {
          sap.file.push(answerOf(file));
          const response = await connection.makeAdtRequest(
            read({ rawText: true, noResend: true }),
          );
          assert.strictEqual(response.data, file.text);
        } finally {
          await connection.disconnect();
        }
      });

      it("the CSRF recovery's resend", async () => {
        const { connection } = await connected();
        try {
          sap.file.push(CSRF_REFUSAL, answerOf(file));
          const response = await connection.makeAdtRequest(
            read({ rawText: true }, 'PUT'),
          );
          assert.strictEqual(response.data, file.text);
          assert.strictEqual(sent('PUT'), 2);
        } finally {
          await connection.disconnect();
        }
      });

      it('the resend on a dead pooled socket', async () => {
        const { connection } = await connected();
        try {
          sap.dropOnReuse = true;
          sap.file.push(answerOf(file));
          const response = await connection.makeAdtRequest(
            read({ rawText: true }),
          );
          assert.strictEqual(response.data, file.text);
          assert.strictEqual(sent('GET'), 2);
        } finally {
          await connection.disconnect();
        }
      });

      it("the upfront CSRF fetch's refusal under noResend", async () => {
        const { connection, transport } = await connected();
        transport.adoptCsrfToken(null);
        try {
          sap.discovery.push(answerOf(file, 503));
          await assert.rejects(
            connection.makeAdtRequest(
              read({ rawText: true, noResend: true }, 'PUT'),
            ),
            (error) => {
              assert.strictEqual(refusalOf(error)?.status, 503);
              assert.strictEqual(refusalOf(error)?.data, file.text);
              return true;
            },
          );
          assert.deepStrictEqual(sap.arrivals, [`GET ${DISCOVERY}`]);
        } finally {
          await connection.disconnect();
        }
      });
    });
  }

  it("the upfront CSRF fetch's refused logon under noResend", async () => {
    const [object] = FILES;
    assert.ok(object !== undefined);
    const { connection, transport } = await connected();
    transport.adoptCsrfToken(null);
    try {
      sap.discovery.push(answerOf(object, 401));
      await assert.rejects(
        connection.makeAdtRequest(
          read({ rawText: true, noResend: true }, 'PUT'),
        ),
        (error) => {
          assert.strictEqual(refusalOf(error)?.status, 401);
          assert.strictEqual(refusalOf(error)?.data, object.text);
          return true;
        },
      );
    } finally {
      await connection.disconnect();
    }
  });

  it('a plain ArrayBuffer from the fetch adapter', async () => {
    const [object] = FILES;
    assert.ok(object !== undefined);
    const { connection } = await connected({ fetchAdapter: true });
    try {
      sap.file.push(answerOf(object));
      const response = await connection.makeAdtRequest(read({ rawText: true }));
      assert.strictEqual(response.data, object.text);
    } finally {
      await connection.disconnect();
    }
  });

  it('a stateless answer that replaced the session: marked, and the exact text', async () => {
    const [object] = FILES;
    assert.ok(object !== undefined);
    const { connection } = await connected();
    try {
      sap.file.push({ ...answerOf(object), headers: REPLACED });
      const response = await connection.makeAdtRequest(read({ rawText: true }));
      assert.strictEqual(
        response.sessionLost,
        ADT_SESSION_ERROR.SESSION_REPLACED,
      );
      assert.strictEqual(response.data, object.text);
    } finally {
      await connection.disconnect();
    }
  });
});

describe("noLog's byte count is the raw length", () => {
  for (const file of FILES) {
    it(file.name, async () => {
      const { logger, lines } = recorder();
      const { connection } = await connected({ logger });
      try {
        lines.length = 0;
        sap.file.push(answerOf(file));
        await connection.makeAdtRequest(read({ rawText: true, noLog: true }));
        const quiet = lines.filter((l) => l.message.startsWith('GET '));
        assert.deepStrictEqual(
          quiet.map((l) => l.message),
          [`GET ${FILE} → 200 (${file.bytes.byteLength} bytes)`],
        );
      } finally {
        await connection.disconnect();
      }
    });
  }
});

describe('rawText changes nothing inside the connection', () => {
  /** Everything the connection did with an answer, but the caller's body. */
  async function behaviour(
    answers: Answer[],
    rawText: boolean,
    options: { method?: string; stateful?: boolean; noLog?: boolean } = {},
  ) {
    const { logger, lines } = recorder();
    const { connection } = await connected({ logger });
    if (options.stateful) connection.setSessionType('stateful');
    lines.length = 0;
    sap.file.push(...answers.map((a) => ({ ...a })));
    try {
      const outcome = await connection
        .makeAdtRequest(
          read(
            {
              ...(rawText ? { rawText: true } : {}),
              ...(options.noLog ? { noLog: true } : {}),
            },
            options.method ?? 'GET',
          ),
        )
        .then(
          (response) => ({
            settled: 'resolved',
            status: response.status,
            sessionLost: response.sessionLost,
          }),
          (error: unknown) => ({
            settled: 'rejected',
            message: error instanceof Error ? error.message : undefined,
            code:
              error instanceof Error && 'code' in error
                ? String(error.code)
                : undefined,
            sessionLost:
              error instanceof Error && 'sessionLost' in error
                ? String(error.sessionLost)
                : undefined,
            status: refusalOf(error)?.status,
          }),
        );
      return {
        outcome,
        arrivals: [...sap.arrivals],
        lines: [...lines],
        connected: connection.isConnected(),
      };
    } finally {
      await connection.disconnect();
    }
  }

  const nested = JSON.stringify({
    a: {
      b: { c: { d: [1, { e: 'CSRF token' }, { f: 'Session not found' }] } },
    },
  });

  const cases: {
    name: string;
    answers: Answer[];
    options?: { method?: string; stateful?: boolean; noLog?: boolean };
  }[] = [
    {
      name: 'a 400 JSON body naming "Session not found"',
      answers: [
        {
          status: 400,
          body: '{"detail":"Session not found"}',
          type: 'application/json',
        },
      ],
    },
    {
      name: 'a 400 plain "Session not found"',
      answers: [{ status: 400, body: 'Session not found', type: 'text/plain' }],
    },
    {
      name: 'a 403 JSON body naming CSRF only once parsed',
      answers: [
        {
          status: 403,
          body: '{"m":"\\u0043SRF token required"}',
          type: 'application/json',
        },
      ],
    },
    {
      name: 'a 403 JSON body behind a BOM naming CSRF only once parsed',
      answers: [
        {
          status: 403,
          body: '﻿{"m":"\\u0043SRF token required"}',
          type: 'application/json',
        },
      ],
    },
    {
      name: 'deeply nested JSON with a replacement cookie, stateless',
      answers: [
        {
          status: 200,
          body: nested,
          type: 'application/json',
          headers: REPLACED,
        },
      ],
    },
    {
      name: 'deeply nested JSON with a replacement cookie, stateful',
      answers: [
        {
          status: 200,
          body: nested,
          type: 'application/json',
          headers: REPLACED,
        },
      ],
      options: { stateful: true },
    },
    {
      name: 'deeply nested JSON refused 500, with a replacement cookie',
      answers: [
        {
          status: 500,
          body: nested,
          type: 'application/json',
          headers: REPLACED,
        },
      ],
    },
    {
      name: 'a PUT refused for its CSRF token, then answered',
      answers: [
        CSRF_REFUSAL,
        { status: 200, body: nested, type: 'application/json' },
      ],
      options: { method: 'PUT' },
    },
    {
      name: 'noLog: a plain answer, its line and byte count',
      answers: [{ status: 200, body: 'plain text\n', type: 'text/plain' }],
      options: { noLog: true },
    },
    {
      name: 'noLog: a refused answer, its line and byte count',
      answers: [{ status: 404, body: 'not here', type: 'text/plain' }],
      options: { noLog: true },
    },
  ];

  for (const { name, answers, options } of cases) {
    it(`${name}: the same with the flag`, async () => {
      const unflagged = await behaviour(answers, false, options);
      const flagged = await behaviour(answers, true, options);
      assert.deepStrictEqual(flagged, unflagged);
    });
  }
});

describe('rawText on the check replay', () => {
  const CHECK = '/sap/bc/adt/checkruns';
  let stub: SapStub;

  beforeEach(async () => {
    stub = await startSapStub();
  });

  afterEach(async () => {
    await stub.close();
  });

  const expired = {
    status: 403,
    body: 'CSRF token validation failed',
    headers: { 'set-cookie': ['SAP_SESSIONID_STUB_100=REPLACED; Path=/'] },
  };

  function check(rawText: boolean): IAbapRequestOptions {
    return {
      url: CHECK,
      method: 'POST',
      timeout: 1000,
      data: '<check/>',
      params: { reporters: 'abapCheckRun' },
      ...(rawText ? { rawText: true } : {}),
    };
  }

  function connector() {
    return createConnection({
      system: 'onprem',
      transport: 'http',
      config: { url: stub.baseUrl, authType: 'basic', client: '100' },
      credential: stubProvider(),
    });
  }

  it("the replayed check's answer is the exact text", async () => {
    const connection = connector();
    await connection.connect();
    const body = '{"ok":true}\n';
    stub.work(CHECK, [
      expired,
      { status: 200, body, headers: { 'content-type': 'application/json' } },
    ]);
    try {
      const result = await connection.makeAdtRequest(check(true));
      assert.strictEqual(result.data, body);
      assert.strictEqual(stub.sentTo(CHECK).length, 2);
    } finally {
      await connection.disconnect();
    }
  });

  it('a JSON refusal not replayed without the flag is not replayed with it', async () => {
    const refusal = {
      ...expired,
      body: '{"message":"CSRF token validation failed"}',
      headers: { ...expired.headers, 'content-type': 'application/json' },
    };
    const counts: number[] = [];
    for (const rawText of [false, true]) {
      const connection = connector();
      await connection.connect();
      const before = stub.sentTo(CHECK).length;
      stub.work(CHECK, [refusal]);
      try {
        await connection.makeAdtRequest(check(rawText)).catch(() => undefined);
        counts.push(stub.sentTo(CHECK).length - before);
      } finally {
        await connection.disconnect();
      }
    }
    assert.deepStrictEqual(counts, [1, 1]);
  });
});

describe('rawText over RFC', () => {
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

  function answering(bodies: { status: number; body: string }[]) {
    const factory: RfcConversationFactory = () => {
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
        call: async () => {
          const next = bodies.shift() ?? { status: 200, body: '' };
          return {
            RESPONSE: {
              STATUS_LINE: { STATUS_CODE: next.status, REASON_PHRASE: 'X' },
              HEADER_FIELDS: [
                { NAME: 'content-type', VALUE: 'application/json' },
              ],
              MESSAGE_BODY: Buffer.from(next.body, 'utf-8'),
            },
          };
        },
      };
      return conversation;
    };
    return factory;
  }

  const texts = ['{"a":1}\n', '"a string"\n', 'REPORT zx.\n\n', '﻿{"a":1}\n'];

  for (const rawText of [true, false]) {
    it(`the body is the text of MESSAGE_BODY ${rawText ? 'with' : 'without'} the flag`, async () => {
      const connection = new AdtOnPremConnector(
        config,
        new BasicAuthProvider('USER', 'PASS'),
        new RfcTransport(
          answering(texts.map((body) => ({ status: 200, body }))),
        ),
        null,
      );
      await connection.connect();
      try {
        for (const text of texts) {
          const response = await connection.makeAdtRequest(
            read(rawText ? { rawText: true } : {}),
          );
          assert.strictEqual(response.data, text);
        }
      } finally {
        await connection.disconnect();
      }
    });
  }
});
