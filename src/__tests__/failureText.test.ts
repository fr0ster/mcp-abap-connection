/**
 * No thrown value's text, and no request's config, reaches anything a
 * consumer is handed — on every wire.
 *
 * A thrown value comes from outside the type system: axios's error names the
 * host and port it could not reach and holds the request's config with its
 * `Authorization` header; the RFC SDK's names the partner it dialled; a
 * WebSocket library's or a parser's quotes what it got. So an error the
 * connection raises, a cause it keeps and a line it logs carry the failure's
 * typed facts — `code`, `status`, `rfc`, SAP's answer as `response` — and
 * fixed words, never any of that.
 *
 * Every scenario plants sentinels in the thrown value (its message, a field,
 * its config's headers, its stack) and in the credential, and looks for them
 * in every rendering of what comes out and in every argument of every log
 * call. The one value handed on as it arrived is the rejection a provider
 * reads (`IAuthRejection.error`), which is not the consumer's.
 */

import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { inspect } from 'node:util';
import { authError } from '@mcp-abap-adt/auth-errors';
import { BasicAuthProvider } from '@mcp-abap-adt/auth-providers';
import type { ISapRfcConfig } from '@mcp-abap-adt/interfaces-auth-sap';
import { AxiosError, AxiosHeaders } from 'axios';
import type { SapHttpConfig } from '../config/sapConfig.js';
import { AdtCloudConnector } from '../connection/AdtCloudConnector.js';
import { AdtOnPremConnector } from '../connection/AdtOnPremConnector.js';
import {
  AuthRefusedError,
  outwardLogonError,
  WireLogonError,
} from '../connection/authErrors.js';
import { GenericWebSocketTransport } from '../connection/GenericWebSocketTransport.js';
import type {
  IAdtTransportRequest,
  IAdtTransportResponse,
} from '../connection/IAdtTransport.js';
import { OnPremHttpTransport } from '../connection/OnPremHttpTransport.js';
import { RfcTransport } from '../connection/RfcTransport.js';
import type { ILogger } from '../logger.js';
import {
  httpClientStub,
  type SentRequest,
  type StubResponse,
} from './helpers/httpClientStub.js';
import { cloudHttpTransport, onPremHttpTransport } from './helpers/onPrem.js';
import { stubProvider } from './helpers/stubProvider.js';

const HOST = 'HOST-SENTINEL';
const PORT = 'PORT-SENTINEL';
const SECRET = 'TOKEN-SENTINEL';
const USER = 'U';
const BASIC = Buffer.from(`${USER}:${SECRET}`).toString('base64');

/** Every planted piece that must reach nothing. */
const LEAKS = [HOST, PORT, SECRET, BASIC, 'STACK-SENTINEL', 'FIELD-SENTINEL'];

/** A Node / axios network failure, as axios rejects with it. */
function networkFailure(): Error {
  const error = Object.assign(
    new Error(`connect ECONNREFUSED ${HOST}:${PORT}`),
    {
      code: 'ECONNREFUSED',
      address: HOST,
      port: PORT,
      detail: 'FIELD-SENTINEL',
      config: {
        url: `https://${HOST}:${PORT}/sap/bc/adt/discovery`,
        headers: { Authorization: `Basic ${BASIC}`, Cookie: SECRET },
      },
      request: { path: `/${SECRET}` },
      isAxiosError: true,
    },
  );
  error.stack = `Error: connect ECONNREFUSED ${HOST}:${PORT}\n    at STACK-SENTINEL`;
  return error;
}

/**
 * SAP's refusal as axios rejects with it: the answer, and beside it the
 * request's config with its credential headers and the Node request.
 */
function refusal(status: number, data: string): AxiosError {
  const headers = new AxiosHeaders({
    Authorization: `Basic ${BASIC}`,
    Cookie: SECRET,
  });
  const config = { headers, url: `https://${HOST}:${PORT}/x` };
  const error = new AxiosError(
    `Request failed with status code ${status}`,
    status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST',
    config,
    { path: `/${SECRET}` },
    {
      status,
      statusText: 'Refused',
      headers: { 'content-type': 'application/xml' },
      data,
      config,
    },
  );
  error.stack = 'AxiosError\n    at STACK-SENTINEL';
  return error;
}

/** Every rendering of `value` a consumer could put in front of someone. */
function renderings(value: unknown): string[] {
  const forms = [
    String(value),
    inspect(value, { depth: 10, showHidden: true }),
  ];
  try {
    forms.push(String(JSON.stringify(value)));
  } catch {
    // A value that does not serialise has no JSON form to leak through.
  }
  if (value instanceof Error) forms.push(value.message, String(value.stack));
  if (typeof value === 'object' && value !== null) {
    for (const name of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      forms.push(inspect(descriptor?.value, { depth: 10, showHidden: true }));
    }
  }
  return forms;
}

function assertClean(value: unknown, where: string): void {
  for (const form of renderings(value)) {
    for (const leak of LEAKS) {
      assert.ok(
        !form.includes(leak),
        `${where} carries ${JSON.stringify(leak)}: ${form}`,
      );
    }
  }
}

/** A logger that keeps every argument of every call, at every level. */
function recordingLogger(): { logger: ILogger; lines: unknown[][] } {
  const lines: unknown[][] = [];
  const keep = (...args: unknown[]): void => {
    lines.push(args);
  };
  return {
    logger: { info: keep, warn: keep, debug: keep, error: keep },
    lines,
  };
}

function assertLogClean(lines: unknown[][], expected: string): void {
  assert.ok(
    lines.some((line) => String(line[0]).includes(expected)),
    `a line saying ${JSON.stringify(expected)} was logged: ${inspect(lines)}`,
  );
  for (const line of lines) assertClean(line, 'a log line');
}

async function rejection(work: Promise<unknown>): Promise<Error> {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof Error, 'an Error reaches the caller');
    return error;
  }
  assert.fail('expected a rejection');
}

const config: SapHttpConfig = {
  url: 'https://sap.test',
  authType: 'basic',
  username: USER,
  password: SECRET,
  client: '100',
};

/** The discovery's answer that establishes a session. */
const ESTABLISHED: StubResponse = {
  status: 200,
  data: '',
  headers: {
    'x-csrf-token': 'csrf-1',
    'set-cookie': ['SAP_SESSIONID_T_100=S1; Path=/'],
  },
};

/** An on-prem HTTP connector over a stub, answering by `respond`. */
function onPremOver(
  respond: (request: SentRequest) => Promise<StubResponse>,
  logger: ILogger,
) {
  const stub = httpClientStub(respond);
  const conn = new AdtOnPremConnector(
    config,
    new BasicAuthProvider(USER, SECRET),
    onPremHttpTransport(config, logger, stub),
    logger,
  );
  return { conn, stub };
}

const isDiscovery = (request: SentRequest) =>
  request.url.includes('/discovery');

describe('the HTTP wire hands up the facts of a failure, never axios’s error', () => {
  it('a network failure on a request: fixed words and the code', async () => {
    const { logger, lines } = recordingLogger();
    let down = false;
    const { conn } = onPremOver(async (request) => {
      if (down) throw networkFailure();
      if (isDiscovery(request)) return ESTABLISHED;
      return { status: 200 };
    }, logger);
    await conn.connect();
    down = true;

    const error = await rejection(
      conn.makeAdtRequest({ url: '/sap/bc/adt/x', method: 'GET', timeout: 1 }),
    );

    assert.strictEqual(error.message, 'The request failed: ECONNREFUSED');
    assert.strictEqual(
      Object.getOwnPropertyDescriptor(error, 'code')?.value,
      'ECONNREFUSED',
    );
    assert.strictEqual(Object.hasOwn(error, 'config'), false);
    assert.strictEqual(Object.hasOwn(error, 'request'), false);
    assertClean(error, 'the error');
    assertLogClean(lines, 'Network error - cannot connect to SAP system');
  });

  it('SAP’s refusal: its answer as `response`, the status, axios’s fixed words', async () => {
    const { logger, lines } = recordingLogger();
    let refuse = false;
    const { conn } = onPremOver(async (request) => {
      if (refuse) throw refusal(404, '<exc:exception/>');
      if (isDiscovery(request)) return ESTABLISHED;
      return { status: 200 };
    }, logger);
    await conn.connect();
    refuse = true;

    const error = await rejection(
      conn.makeAdtRequest({ url: '/sap/bc/adt/x', method: 'GET', timeout: 1 }),
    );

    assert.strictEqual(error.message, 'Request failed with status code 404');
    const response: unknown = Object.getOwnPropertyDescriptor(
      error,
      'response',
    )?.value;
    assert.ok(typeof response === 'object' && response !== null);
    assert.deepStrictEqual(Object.keys(response).sort(), [
      'data',
      'headers',
      'status',
      'statusText',
    ]);
    assert.strictEqual(
      Object.getOwnPropertyDescriptor(response, 'status')?.value,
      404,
    );
    assert.strictEqual(
      Object.getOwnPropertyDescriptor(response, 'data')?.value,
      '<exc:exception/>',
    );
    assert.strictEqual(
      Object.getOwnPropertyDescriptor(error, 'status')?.value,
      404,
    );
    assert.strictEqual(Object.hasOwn(error, 'config'), false);
    assertClean(error, 'the error');
    for (const line of lines) assertClean(line, 'a log line');
  });

  it('a 401 the provider cannot renew: AuthRefusedError, its cause a copy with the status', async () => {
    const { logger, lines } = recordingLogger();
    let refuse = false;
    const { conn } = onPremOver(async (request) => {
      if (refuse) throw refusal(401, 'login');
      if (isDiscovery(request)) return ESTABLISHED;
      return { status: 200 };
    }, logger);
    await conn.connect();
    refuse = true;

    const error = await rejection(
      conn.makeAdtRequest({ url: '/sap/bc/adt/x', method: 'GET', timeout: 1 }),
    );

    assert.ok(error instanceof AuthRefusedError);
    assert.strictEqual(error.cause?.name, 'WireFailure');
    assert.strictEqual(error.cause?.status, 401);
    assertClean(error, 'the error');
    for (const line of lines) assertClean(line, 'a log line');
  });

  it('a network failure while establishing: connect() rejects in fixed words', async () => {
    const { logger, lines } = recordingLogger();
    const { conn } = onPremOver(async () => {
      throw networkFailure();
    }, logger);

    const error = await rejection(conn.connect());

    assert.strictEqual(error.message, 'The request failed: ECONNREFUSED');
    assertClean(error, 'the error');
    assertLogClean(lines, 'Could not establish');
  });

  it('a 401 while establishing: the provider’s refusal, the cause a copy', async () => {
    const { logger, lines } = recordingLogger();
    const { conn } = onPremOver(async () => {
      throw refusal(401, 'login');
    }, logger);

    const error = await rejection(conn.connect());

    assert.ok(error instanceof AuthRefusedError);
    assert.strictEqual(error.at, 'logon');
    assert.strictEqual(error.cause?.status, 401);
    assertClean(error, 'the error');
    for (const line of lines) assertClean(line, 'a log line');
  });

  it('a CSRF fetch that fails before a mutation: the log line says the code', async () => {
    const { logger, lines } = recordingLogger();
    let down = false;
    const { conn } = onPremOver(async (request) => {
      if (down) throw networkFailure();
      if (isDiscovery(request)) return ESTABLISHED;
      return { status: 200 };
    }, logger);
    await conn.connect();
    conn.transport.adoptCsrfToken(null);
    down = true;

    const error = await rejection(
      conn.makeAdtRequest({
        url: '/sap/bc/adt/x',
        method: 'POST',
        timeout: 1,
        data: '<x/>',
      }),
    );

    assertClean(error, 'the error');
    assertLogClean(lines, 'Could not fetch CSRF token upfront');
  });

  it('a CSRF retry that fails: the log line says the code', async () => {
    const { logger, lines } = recordingLogger();
    let stage: 'up' | 'csrf' = 'up';
    const { conn } = onPremOver(async (request) => {
      if (stage === 'csrf') {
        if (isDiscovery(request)) throw networkFailure();
        throw refusal(403, 'CSRF token validation failed');
      }
      if (isDiscovery(request)) return ESTABLISHED;
      return { status: 200 };
    }, logger);
    await conn.connect();
    stage = 'csrf';

    const error = await rejection(
      conn.makeAdtRequest({
        url: '/sap/bc/adt/x',
        method: 'POST',
        timeout: 1,
        data: '<x/>',
      }),
    );

    assertClean(error, 'the error');
    assertLogClean(lines, 'CSRF retry failed');
  });

  it('a logoff that cannot be written: the log lines say the code', async () => {
    const { logger, lines } = recordingLogger();
    const { conn, stub } = onPremOver(async (request) => {
      if (isDiscovery(request)) return ESTABLISHED;
      return { status: 200 };
    }, logger);
    await conn.connect();
    stub.failLogoffWith(networkFailure());

    await conn.disconnect();
    await conn.flushGoodbye();

    assertLogClean(lines, 'Could not tell the server the session is finished');
  });

  it('a cloud security session that cannot be opened: the log line says the code', async () => {
    const { logger, lines } = recordingLogger();
    const stub = httpClientStub(async () => {
      throw networkFailure();
    });
    const conn = new AdtCloudConnector(
      config,
      new BasicAuthProvider(USER, SECRET),
      cloudHttpTransport(config, logger, stub),
      logger,
    );

    const error = await rejection(conn.connect());

    assertClean(error, 'the error');
    assertLogClean(lines, 'Could not open a security session');
  });

  it('a configuration URL that does not parse is not quoted', () => {
    let thrown: unknown;
    try {
      new AdtOnPremConnector(
        { ...config, url: `https://${USER}:${SECRET}@[${HOST}` },
        new BasicAuthProvider(USER, SECRET),
        onPremHttpTransport(config),
        null,
      );
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof Error);
    assert.ok(thrown.message.startsWith('Invalid URL in configuration'));
    assertClean(thrown, 'the error');
  });
});

/**
 * The connection's own lines, each met with a raw thrown value: a consumer's
 * wire, or a seam of ours under it, may reject with anything, and the line
 * that reports it must say the facts alone.
 */
describe('the connection’s log lines say a raw failure by its facts', () => {
  const rejectRaw = async (): Promise<never> => {
    throw networkFailure();
  };

  async function connected(logger: ILogger) {
    const { conn } = onPremOver(async (request) => {
      if (isDiscovery(request)) return ESTABLISHED;
      return { status: 200 };
    }, logger);
    await conn.connect();
    return conn;
  }

  it('a request whose wire rejected (the request error lines)', async () => {
    const { logger, lines } = recordingLogger();
    const conn = await connected(logger);
    mock.method(conn.transport, 'send', rejectRaw);

    await rejection(
      conn.makeAdtRequest({ url: '/sap/bc/adt/x', method: 'GET', timeout: 1 }),
    );

    assertLogClean(lines, 'Network error - cannot connect to SAP system');
  });

  it('a CSRF fetch before a mutation that rejected', async () => {
    const { logger, lines } = recordingLogger();
    const conn = await connected(logger);
    conn.transport.adoptCsrfToken(null);
    mock.method(conn.transport, 'establish', rejectRaw);
    mock.method(conn.transport, 'send', rejectRaw);

    await rejection(
      conn.makeAdtRequest({
        url: '/sap/bc/adt/x',
        method: 'POST',
        timeout: 1,
        data: '<x/>',
      }),
    );

    assertLogClean(lines, 'Could not fetch CSRF token upfront');
  });

  it('a CSRF retry whose token fetch rejected', async () => {
    const { logger, lines } = recordingLogger();
    const conn = await connected(logger);
    mock.method(conn.transport, 'send', async () => {
      throw refusal(403, 'CSRF token validation failed');
    });
    mock.method(conn.transport, 'establish', rejectRaw);

    await rejection(
      conn.makeAdtRequest({
        url: '/sap/bc/adt/x',
        method: 'POST',
        timeout: 1,
        data: '<x/>',
      }),
    );

    assertLogClean(lines, 'CSRF retry failed');
  });

  it('a wire whose establishment rejected (the establish warning)', async () => {
    const { logger, lines } = recordingLogger();
    const { conn } = onPremOver(async () => ({ status: 200 }), logger);
    mock.method(conn.transport, 'establish', rejectRaw);

    await rejection(conn.connect());

    assertLogClean(lines, 'Could not establish');
  });

  it('a wire whose close rejected (the connection’s goodbye line)', async () => {
    const { logger, lines } = recordingLogger();
    const conn = await connected(logger);
    mock.method(conn.transport, 'close', rejectRaw);

    await conn.disconnect();
    await conn.flushGoodbye();

    assertLogClean(lines, 'Could not tell the server the session is finished');
  });

  it('a logoff whose send rejected (the HTTP wire’s goodbye line)', async () => {
    const { logger, lines } = recordingLogger();
    /** The wire, its detached send rejecting with a raw value. */
    class RawGoodbye extends OnPremHttpTransport {
      protected override async sendDetached(
        _request: IAdtTransportRequest,
      ): Promise<IAdtTransportResponse> {
        throw networkFailure();
      }
    }
    const stub = httpClientStub(async (request) =>
      isDiscovery(request) ? ESTABLISHED : { status: 200 },
    );
    const conn = new AdtOnPremConnector(
      config,
      new BasicAuthProvider(USER, SECRET),
      new RawGoodbye(() => ({}), logger, {
        client: config.client,
        baseUrl: config.url,
        httpClient: stub,
      }),
      logger,
    );
    await conn.connect();

    await conn.disconnect();
    await conn.flushGoodbye();

    assertLogClean(lines, 'Could not tell the server the session is finished');
  });

  it('a cloud preflight whose send rejected (the security-session line)', async () => {
    const { logger, lines } = recordingLogger();
    const transport = cloudHttpTransport(config, logger, httpClientStub());
    mock.method(transport, 'send', rejectRaw);
    const conn = new AdtCloudConnector(
      config,
      new BasicAuthProvider(USER, SECRET),
      transport,
      logger,
    );

    await conn.connect().catch(() => {});

    assertLogClean(lines, 'Could not open a security session');
  });
});

describe('a refused logon leaves the connection without the wire’s raw error', () => {
  it('outwardLogonError: the same mark, its cause a copy', () => {
    const raw = networkFailure();
    const outward = outwardLogonError(new WireLogonError(raw, 401));

    assert.ok(outward instanceof WireLogonError);
    assert.strictEqual(outward.status, 401);
    assert.notStrictEqual(outward.cause, raw);
    assertClean(outward, 'the error');
  });

  it('a refused logon connect() does not answer with the provider: the mark leaves with a copy', async () => {
    let refuse: (error: unknown) => void = () => {};
    const opened = new Promise<void>((_resolve, reject) => {
      refuse = reject;
    });
    const raw = networkFailure();
    const provider = stubProvider();
    const conn = new AdtOnPremConnector(
      {
        connectionType: 'rfc',
        authType: 'basic',
        ashost: 'rfc-ashost',
        sysnr: '00',
        client: '100',
        language: 'EN',
      },
      provider,
      new RfcTransport(
        () => ({
          alive: false,
          open: () => opened,
          close: async () => {},
          call: async () => ({}),
        }),
        null,
      ),
      null,
    );

    const connecting = rejection(conn.connect());
    await new Promise((resolve) => setImmediate(resolve));
    // A teardown asked for while the logon is out: the refused logon is not
    // the provider's to answer, and connect() rejects with the wire's mark.
    const disconnecting = conn.disconnect();
    refuse(raw);
    const error = await connecting;
    await disconnecting.catch(() => {});

    assert.strictEqual(provider.rejections.length, 0);
    assert.ok(error instanceof WireLogonError, inspect(error));
    assert.notStrictEqual(error.cause, raw);
    assertClean(error, 'the error');
  });

  it('over RFC: the provider gets the SDK’s error as it arrived; the consumer a copy with rfc', async () => {
    const raw = Object.assign(
      new Error(`partner '${HOST}:${PORT}' not reached`),
      {
        key: 'RFC_COMMUNICATION_FAILURE',
        group: 1,
        code: 1,
        codeString: 'RFC_COMMUNICATION_FAILURE',
      },
    );
    raw.stack = 'Error\n    at STACK-SENTINEL';
    const refusal = authError['system-refused']({
      verdict: 'rfc-failure',
      rfcKey: 'RFC_COMMUNICATION_FAILURE',
      at: 'logon',
    });
    const provider = stubProvider({ rejected: [{ ok: false, refusal }] });
    const rfcConfig: ISapRfcConfig = {
      connectionType: 'rfc',
      authType: 'basic',
      ashost: 'rfc-ashost',
      sysnr: '00',
      client: '100',
      language: 'EN',
    };
    const conn = new AdtOnPremConnector(
      rfcConfig,
      provider,
      new RfcTransport(
        () => ({
          alive: false,
          open: async () => {
            throw raw;
          },
          close: async () => {},
          call: async () => ({}),
        }),
        null,
      ),
      null,
    );

    const error = await rejection(conn.connect());

    assert.strictEqual(provider.rejections[0]?.error, raw);
    assert.ok(error instanceof AuthRefusedError);
    assert.deepStrictEqual(error.cause?.rfc, {
      key: 'RFC_COMMUNICATION_FAILURE',
      group: 1,
      code: 1,
      codeString: 'RFC_COMMUNICATION_FAILURE',
    });
    assert.strictEqual(
      error.cause?.message,
      'The failure: RFC_COMMUNICATION_FAILURE',
    );
    assertClean(error, 'the error');
  });
});

describe('the WebSocket transport hands its handlers fixed words and the code', () => {
  /** A socket the test drives by its handlers. */
  interface DrivenSocket {
    readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    onopen: ((event: unknown) => void) | null;
    onmessage: ((event: { data: unknown }) => void) | null;
    onerror: ((event: unknown) => void) | null;
    onclose:
      | ((event: {
          code?: number;
          reason?: string;
          wasClean?: boolean;
        }) => void)
      | null;
  }

  function socketFactory() {
    const socket: DrivenSocket = {
      readyState: 0,
      send: () => {},
      close: () => {},
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
    };
    return { socket, factory: { create: () => socket } };
  }

  it('a connection error', async () => {
    const { socket, factory } = socketFactory();
    const transport = new GenericWebSocketTransport(factory);
    const seen: Error[] = [];
    transport.onError((error) => {
      seen.push(error);
    });
    const connecting = rejection(transport.connect('wss://sap.test/ws'));
    socket.onerror?.(networkFailure());
    const error = await connecting;

    assert.strictEqual(
      error.message,
      'WebSocket connection error: ECONNREFUSED',
    );
    assert.strictEqual(
      Object.getOwnPropertyDescriptor(error, 'code')?.value,
      'ECONNREFUSED',
    );
    assertClean(error, 'the error');
    for (const each of seen) assertClean(each, 'a handler’s error');
  });

  it('a message that does not parse', async () => {
    const { socket, factory } = socketFactory();
    const transport = new GenericWebSocketTransport(factory);
    const seen: Error[] = [];
    transport.onError((error) => {
      seen.push(error);
    });
    const connecting = transport.connect('wss://sap.test/ws');
    socket.readyState = 1;
    socket.onopen?.({});
    await connecting;

    socket.onmessage?.({ data: `{ ${SECRET} ${HOST}` });
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(seen.length, 1);
    assert.strictEqual(
      seen[0]?.message,
      'Failed to process WS message: no code was given',
    );
    for (const each of seen) assertClean(each, 'a handler’s error');
  });
});
