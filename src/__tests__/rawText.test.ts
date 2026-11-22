/**
 * `rawText: true` hands the answer body to the caller as the exact text SAP
 * sent — no JSON parsing, no transformation — so an abapGit file reads back
 * as the file it is.
 *
 * Over HTTP through the shipped wire on a real local socket: the ordinary
 * send, the `noResend` send, the CSRF recovery's resend and the resend on a
 * dead pooled socket, an error's body, and a client whose axios defaults
 * differ. Without the flag, today's parsing
 * stays: a JSON body arrives parsed. Over RFC through `RfcTransport` with a
 * conversation stub: the body is the text in `MESSAGE_BODY`, flag or not.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { BasicAuthProvider } from '@mcp-abap-adt/auth-providers';
import type { IAbapRequestOptions } from '@mcp-abap-adt/interfaces-adt-connection';
import type { ISapRfcConfig } from '@mcp-abap-adt/interfaces-auth-sap';
import axios from 'axios';
import { AdtOnPremConnector } from '../connection/AdtOnPremConnector.js';
import { HttpTransport, nodeHttpClient } from '../connection/HttpTransport.js';
import { refusalOf } from '../connection/IAdtTransport.js';
import { OnPremHttpTransport } from '../connection/OnPremHttpTransport.js';
import {
  type IRfcConversation,
  type RfcConversationFactory,
  RfcTransport,
} from '../connection/RfcTransport.js';
import type { ILogger } from '../logger.js';

const DISCOVERY = '/sap/bc/adt/core/discovery';
const FILE = '/sap/bc/adt/abapgit/repos/R1/files/package.json';

/** The files: each must arrive as these exact characters. */
const FILES = [
  {
    name: 'a JSON-object file',
    body: '{\n  "name": "x",\n  "version": 1\n}\n',
    type: 'application/json',
  },
  {
    name: 'a JSON-string file with its quotes',
    body: '"a string"\n',
    type: 'text/plain',
  },
  {
    name: 'a file with a trailing newline',
    body: 'REPORT zx.\n\n',
    type: 'text/plain',
  },
  {
    name: 'a non-JSON text',
    body: '<?xml version="1.0"?><abapGit/> ü ✓',
    type: 'text/plain; charset=utf-8',
  },
  {
    name: 'a file with a leading UTF-8 BOM',
    body: '\uFEFF"bom"\n',
    type: 'text/plain; charset=utf-8',
  },
] as const;

interface Answer {
  /** `0`: the socket is destroyed, no byte written. */
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
      const refused = path === DISCOVERY ? sap.discovery.shift() : undefined;
      if (refused !== undefined) {
        res.writeHead(refused.status, { 'content-type': refused.type });
        res.end(refused.body);
        return;
      }
      if (path === DISCOVERY) {
        res.writeHead(200, {
          'content-type': 'application/xml',
          'x-csrf-token': 'T1',
          'set-cookie': 'SAP_SESSIONID_STUB_100=S1; Path=/',
        });
        res.end('<service/>');
        return;
      }
      const answer = sap.file.shift() ?? {
        status: 200,
        body: 'ok',
        type: 'text/plain',
      };
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

async function connected(logger: ILogger | null = null) {
  const transport = new OnPremHttpTransport(() => ({}), logger, {
    client: '100',
    baseUrl: sap.baseUrl,
  });
  const connection = new AdtOnPremConnector(
    { url: sap.baseUrl, authType: 'basic', client: '100' },
    new BasicAuthProvider('u', 'p'),
    transport,
    logger,
  );
  await connection.connect();
  sap.arrivals.length = 0;
  return connection;
}

function read(
  flags: Pick<IAbapRequestOptions, 'rawText' | 'noResend' | 'noLog'> = {},
  method = 'GET',
): IAbapRequestOptions {
  return { url: FILE, method, timeout: 5000, ...flags };
}

describe('rawText over HTTP', () => {
  for (const file of FILES) {
    it(`${file.name} arrives byte-exact`, async () => {
      const connection = await connected();
      try {
        sap.file.push({ status: 200, body: file.body, type: file.type });
        const response = await connection.makeAdtRequest(
          read({ rawText: true }),
        );
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.data, file.body);
      } finally {
        await connection.disconnect();
      }
    });

    it(`${file.name} arrives byte-exact under noResend`, async () => {
      const connection = await connected();
      try {
        sap.file.push({ status: 200, body: file.body, type: file.type });
        const response = await connection.makeAdtRequest(
          read({ rawText: true, noResend: true }),
        );
        assert.strictEqual(response.data, file.body);
      } finally {
        await connection.disconnect();
      }
    });
  }

  it('without the flag, a JSON body is parsed as before', async () => {
    const connection = await connected();
    try {
      const [object, string, newline, text] = FILES;
      sap.file.push(
        { status: 200, body: object.body, type: object.type },
        { status: 200, body: string.body, type: string.type },
        { status: 200, body: newline.body, type: newline.type },
        { status: 200, body: text.body, type: text.type },
      );
      const parsedObject = await connection.makeAdtRequest(read());
      const parsedString = await connection.makeAdtRequest(read());
      const plain = await connection.makeAdtRequest(read());
      const other = await connection.makeAdtRequest(read());
      assert.deepStrictEqual(parsedObject.data, { name: 'x', version: 1 });
      assert.strictEqual(parsedString.data, 'a string');
      assert.strictEqual(plain.data, newline.body);
      assert.strictEqual(other.data, text.body);
    } finally {
      await connection.disconnect();
    }
  });

  it("an error's body is the exact text; status and shape as without the flag", async () => {
    const connection = await connected();
    const body = '\uFEFF{"error":"no such file"}\n';
    try {
      sap.file.push({ status: 404, body, type: 'application/json' });
      const raw = await connection.makeAdtRequest(read({ rawText: true })).then(
        () => assert.fail('resolved'),
        (error: unknown) => error,
      );
      sap.file.push({ status: 404, body, type: 'application/json' });
      const parsed = await connection.makeAdtRequest(read()).then(
        () => assert.fail('resolved'),
        (error: unknown) => error,
      );
      assert.strictEqual(refusalOf(raw)?.status, 404);
      assert.strictEqual(refusalOf(raw)?.data, body);
      assert.deepStrictEqual(refusalOf(parsed)?.data, {
        error: 'no such file',
      });
      assert.ok(raw instanceof Error && parsed instanceof Error);
      assert.strictEqual(raw.message, parsed.message);
      assert.deepStrictEqual(
        Object.keys(raw).sort(),
        Object.keys(parsed).sort(),
      );
    } finally {
      await connection.disconnect();
    }
  });

  it('the CSRF recovery resend arrives byte-exact', async () => {
    const connection = await connected();
    const [object] = FILES;
    try {
      sap.file.push(
        {
          status: 403,
          body: 'CSRF token validation failed',
          type: 'text/plain',
          headers: { 'x-csrf-token': 'Required' },
        },
        { status: 200, body: object.body, type: object.type },
      );
      const response = await connection.makeAdtRequest(
        read({ rawText: true }, 'POST'),
      );
      assert.strictEqual(response.data, object.body);
      assert.strictEqual(
        sap.arrivals.filter((a) => a === `POST ${FILE}`).length,
        2,
      );
    } finally {
      await connection.disconnect();
    }
  });

  it('the resend on a dead pooled socket arrives byte-exact', async () => {
    const transport = new HttpTransport(() => ({}), null, {
      baseUrl: sap.baseUrl,
    });
    const [object] = FILES;
    await transport.send({ method: 'GET', url: FILE });
    sap.dropOnReuse = true;
    sap.file.push({ status: 200, body: object.body, type: object.type });
    const response = await transport.send({
      method: 'GET',
      url: FILE,
      rawText: true,
    });
    assert.strictEqual(response.data, object.body);
    assert.deepStrictEqual(sap.arrivals, [
      `GET ${FILE}`,
      `GET ${FILE}`,
      `GET ${FILE}`,
    ]);
  });
});

describe('rawText over a client with defaults of its own', () => {
  // Each half of the fix holds against a client whose axios defaults differ:
  // a text default (axios drops the BOM) needs `responseType: 'arraybuffer'`,
  // a parsing transform by default needs the wire's own `transformResponse`.
  it('a JSON-string file with a BOM arrives byte-exact', async () => {
    const transport = new HttpTransport(() => ({}), null, {
      baseUrl: sap.baseUrl,
      httpClient: {
        create: (agents) =>
          axios.create({
            ...agents,
            responseType: 'text',
            transformResponse: [
              (body: unknown) =>
                typeof body === 'string' ? JSON.parse(body) : body,
            ],
          }),
        logoffRequest: nodeHttpClient.logoffRequest,
      },
    });
    const body = '\uFEFF"a string"\n';
    sap.file.push({ status: 200, body, type: 'text/plain' });
    const response = await transport.send({
      method: 'GET',
      url: FILE,
      rawText: true,
    });
    assert.strictEqual(response.data, body);
  });
});

describe('rawText changes no verdict', () => {
  // The same answers, flagged and not: the connection decides the same.
  const answers: { name: string; answer: Answer }[] = [
    {
      name: 'a 400 JSON body naming "Session not found"',
      answer: {
        status: 400,
        body: '{"detail":"Session not found"}',
        type: 'application/json',
      },
    },
    {
      name: 'a 400 plain "Session not found"',
      answer: { status: 400, body: 'Session not found', type: 'text/plain' },
    },
    {
      name: 'a 403 JSON body naming CSRF only once parsed',
      answer: {
        status: 403,
        body: '{"message":"\\u0043SRF token required"}',
        type: 'application/json',
      },
    },
  ];

  async function outcome(answer: Answer, rawText: boolean) {
    const connection = await connected();
    try {
      sap.file.push({ ...answer });
      return await connection
        .makeAdtRequest(read(rawText ? { rawText: true } : {}))
        .then(
          (response) => ({
            settled: 'resolved',
            status: response.status,
            arrivals: [...sap.arrivals],
          }),
          (error: unknown) => ({
            settled: 'rejected',
            code:
              error instanceof Error && 'code' in error
                ? String(error.code)
                : undefined,
            status: refusalOf(error)?.status,
            arrivals: [...sap.arrivals],
          }),
        );
    } finally {
      await connection.disconnect();
    }
  }

  for (const { name, answer } of answers) {
    it(`${name}: the same verdict with the flag`, async () => {
      const unflagged = await outcome(answer, false);
      const flagged = await outcome(answer, true);
      assert.deepStrictEqual(flagged, unflagged);
    });
  }

  it('the JSON refusal keeps its exact text under the flag', async () => {
    const connection = await connected();
    const body = '{"detail":"Session not found"}';
    try {
      sap.file.push({ status: 400, body, type: 'application/json' });
      await assert.rejects(
        connection.makeAdtRequest(read({ rawText: true })),
        (error) => {
          assert.strictEqual(refusalOf(error)?.status, 400);
          assert.strictEqual(refusalOf(error)?.data, body);
          return true;
        },
      );
    } finally {
      await connection.disconnect();
    }
  });
});

describe('rawText over the fetch adapter', () => {
  it('an ArrayBuffer body arrives as its exact text', async () => {
    const transport = new HttpTransport(() => ({}), null, {
      baseUrl: sap.baseUrl,
      httpClient: {
        create: (agents) => axios.create({ ...agents, adapter: 'fetch' }),
        logoffRequest: nodeHttpClient.logoffRequest,
      },
    });
    const body = '﻿"a string"\n';
    sap.file.push({ status: 200, body, type: 'application/json' });
    const response = await transport.send({
      method: 'GET',
      url: FILE,
      rawText: true,
    });
    assert.strictEqual(response.data, body);
  });
});

describe('rawText on the CSRF fetch made for the request', () => {
  it("under noResend, the fetch's refusal is the exact text and nothing is sent", async () => {
    const transport = new OnPremHttpTransport(() => ({}), null, {
      client: '100',
      baseUrl: sap.baseUrl,
    });
    const connection = new AdtOnPremConnector(
      { url: sap.baseUrl, authType: 'basic', client: '100' },
      new BasicAuthProvider('u', 'p'),
      transport,
      null,
    );
    await connection.connect();
    sap.arrivals.length = 0;
    transport.adoptCsrfToken(null);
    const body = '{"error":"down"}\n';
    try {
      sap.discovery.push({ status: 503, body, type: 'application/json' });
      await assert.rejects(
        connection.makeAdtRequest(
          read({ rawText: true, noResend: true }, 'PUT'),
        ),
        (error) => {
          assert.strictEqual(refusalOf(error)?.status, 503);
          assert.strictEqual(refusalOf(error)?.data, body);
          return true;
        },
      );
      assert.deepStrictEqual(sap.arrivals, [`GET ${DISCOVERY}`]);
    } finally {
      await connection.disconnect();
    }
  });
});

describe("rawText decodes in the answer's charset", () => {
  function recorder(): { logger: ILogger; lines: string[] } {
    const lines: string[] = [];
    const at = (message: string): void => {
      lines.push(message);
    };
    return {
      lines,
      logger: { info: at, warn: at, error: at, debug: at },
    };
  }

  it('ISO-8859-1 "é\\n" decodes as such, and noLog counts its 2 bytes', async () => {
    const { logger, lines } = recorder();
    const connection = await connected(logger);
    try {
      lines.length = 0;
      sap.file.push({
        status: 200,
        body: Buffer.from([0xe9, 0x0a]),
        type: 'text/plain; charset=ISO-8859-1',
      });
      const response = await connection.makeAdtRequest(
        read({ rawText: true, noLog: true }),
      );
      assert.strictEqual(response.data, 'é\n');
      assert.ok(
        lines.some((line) => line.endsWith('→ 200 (2 bytes)')),
        lines.join('\n'),
      );
    } finally {
      await connection.disconnect();
    }
  });

  it('a body that is not valid UTF-8 under utf-8 is refused in fixed words', async () => {
    const connection = await connected();
    try {
      sap.file.push({
        status: 200,
        body: Buffer.from([0x7b, 0xc3, 0x28, 0x7d]),
        type: 'application/json; charset=utf-8',
      });
      await assert.rejects(
        connection.makeAdtRequest(read({ rawText: true })),
        (error) => {
          assert.ok(error instanceof Error);
          assert.strictEqual(
            error.message,
            "The answer's body is not valid text in its charset (status 200)",
          );
          assert.strictEqual(refusalOf(error)?.status, 200);
          assert.strictEqual(refusalOf(error)?.data, undefined);
          return true;
        },
      );
    } finally {
      await connection.disconnect();
    }
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

  /** Every call answers the next body, in `MESSAGE_BODY` as the SDK hands it. */
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

  for (const rawText of [true, false]) {
    it(`every file arrives byte-exact ${rawText ? 'with' : 'without'} the flag`, async () => {
      const connection = new AdtOnPremConnector(
        config,
        new BasicAuthProvider('USER', 'PASS'),
        new RfcTransport(
          answering(FILES.map((f) => ({ status: 200, body: f.body }))),
        ),
        null,
      );
      await connection.connect();
      try {
        for (const file of FILES) {
          const response = await connection.makeAdtRequest(
            read(rawText ? { rawText: true } : {}),
          );
          assert.strictEqual(response.data, file.body);
        }
      } finally {
        await connection.disconnect();
      }
    });
  }

  it("an error's body is the exact text", async () => {
    const body = '\uFEFF{"error":"no such file"}\n';
    const connection = new AdtOnPremConnector(
      config,
      new BasicAuthProvider('USER', 'PASS'),
      new RfcTransport(answering([{ status: 404, body }])),
      null,
    );
    await connection.connect();
    try {
      await assert.rejects(
        connection.makeAdtRequest(read({ rawText: true })),
        (error) => {
          assert.strictEqual(refusalOf(error)?.status, 404);
          assert.strictEqual(refusalOf(error)?.data, body);
          return true;
        },
      );
    } finally {
      await connection.disconnect();
    }
  });
});
