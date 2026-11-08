/**
 * An HTTP client for an HTTP wire that never reaches the network: handed to
 * the wire's constructor as its `httpClient`, it answers every request with
 * what the test says, and records what the wire sent — UNDER the wire, so
 * everything the wire adds to its own requests (cookies, CSRF, affinity, the
 * client) is in what it records.
 *
 * A real axios instance with an adapter: the wire's interceptors and config
 * handling run as they do in production; only the exchange is the test's.
 */
import { type ClientRequest, request as httpRequest } from 'node:http';
import { Duplex } from 'node:stream';
import axios, { type InternalAxiosRequestConfig } from 'axios';
import type {
  HttpClientAgents,
  HttpClientFactory,
} from '../../connection/HttpTransport.js';

/** One request as the wire sent it. */
export interface SentRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  timeout?: number;
  data?: unknown;
  /** Query parameters left for axios to serialise; absent when none. */
  params?: unknown;
}

/** What the stub answers: a status, and optionally a body and headers. */
export interface StubResponse {
  status: number;
  statusText?: string;
  data?: unknown;
  headers?: Record<string, string | string[]>;
}

export type Responder = (request: SentRequest) => Promise<StubResponse>;

const OK: Responder = async () => ({ status: 200, data: '', headers: {} });

/** The request's headers as plain strings, as the wire set them. */
function plainHeaders(
  config: InternalAxiosRequestConfig,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(config.headers.toJSON())) {
    if (value !== undefined && value !== null) headers[name] = String(value);
  }
  return headers;
}

/**
 * What axios's own http adapter does with the wire's `transport` for a logoff:
 * opens the node request through it. The wire listens for that request's
 * `finish` to report the logoff written.
 */
function openLogoff(config: InternalAxiosRequestConfig): void {
  const transport: unknown = config.transport;
  if (typeof transport !== 'object' || transport === null) return;
  if (!('request' in transport) || typeof transport.request !== 'function')
    return;
  Reflect.apply(transport.request, transport, [{}, () => {}]);
}

/**
 * A node request that goes nowhere: its socket takes no bytes. Reported
 * `finish`ed once opened — a stub that RECEIVED the logoff has, by that, had
 * it written.
 */
function writtenLogoff(): ClientRequest {
  const socket = new Duplex({
    read() {},
    write(_chunk, _encoding, _done) {
      // never done: nothing leaves
    },
  });
  Object.assign(socket, {
    setNoDelay: () => socket,
    setKeepAlive: () => socket,
    setTimeout: () => socket,
    ref: () => socket,
    unref: () => socket,
  });
  const outgoing = httpRequest({
    host: 'stub.invalid',
    createConnection: () => socket,
  });
  outgoing.on('error', () => {});
  queueMicrotask(() => outgoing.emit('finish'));
  return outgoing;
}

export interface HttpClientStub extends HttpClientFactory {
  /** Every request the wire sent, in order. */
  sent: SentRequest[];
  /** The agents of every client the wire built, in order. */
  built: HttpClientAgents[];
  /** Answer the requests from now on with `responder`. */
  answer(responder: Responder): void;
  /**
   * Make the node request of every logoff from now on throw `error` while it
   * is built, as a certificate connection's agent can: the logoff is then
   * never written.
   */
  failLogoffWith(error: Error): void;
}

export function httpClientStub(responder: Responder = OK): HttpClientStub {
  const sent: SentRequest[] = [];
  const built: HttpClientAgents[] = [];
  let respond = responder;
  let logoffFailure: Error | null = null;
  return {
    sent,
    built,
    answer: (next) => {
      respond = next;
    },
    failLogoffWith: (error) => {
      logoffFailure = error;
    },
    create: (agents) => {
      built.push(agents);
      return axios.create({
        ...agents,
        adapter: async (config) => {
          const request: SentRequest = {
            url: config.url ?? '',
            method: (config.method ?? 'get').toUpperCase(),
            headers: plainHeaders(config),
            ...(config.timeout ? { timeout: config.timeout } : {}),
            ...(config.data !== undefined ? { data: config.data } : {}),
            ...(config.params !== undefined ? { params: config.params } : {}),
          };
          sent.push(request);
          openLogoff(config);
          const answer = await respond(request);
          return {
            status: answer.status,
            statusText: answer.statusText ?? '',
            headers: answer.headers ?? {},
            data: answer.data ?? '',
            config,
          };
        },
      });
    },
    logoffRequest: () => {
      if (logoffFailure !== null) throw logoffFailure;
      return writtenLogoff();
    },
  };
}
