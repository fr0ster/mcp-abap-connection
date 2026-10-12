/**
 * What the request-signal suites share: a promise the test settles by hand, a
 * provider whose moments wait on gates the test opens — the same gate for
 * every caller, the way a provider shares one renewal among all who ask —
 * and a recorder of unhandled rejections.
 */

import { ADT_REQUEST_ERROR } from '@mcp-abap-adt/interfaces-adt-connection';
import type {
  AuthOutcome,
  IAuthProvider,
  IAuthRejection,
  ILogonTarget,
  IRequestTarget,
} from '@mcp-abap-adt/interfaces-auth';
import type { SapConfig } from '../../config/sapConfig.js';
import type {
  IAdtTransportRequest,
  IAdtTransportResponse,
} from '../../connection/IAdtTransport.js';
import { OnPremHttpTransport } from '../../connection/OnPremHttpTransport.js';
import {
  type IRfcConversation,
  RfcTransport,
} from '../../connection/RfcTransport.js';

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const OK: AuthOutcome = { ok: true };

/**
 * A provider whose `authorize`, `rejected` and `establish` wait on the gate
 * the test set for them, if any — one gate, shared by every call made while
 * it is set.
 */
export function gatedProvider(): IAuthProvider & {
  gates: {
    authorize?: Promise<void> | undefined;
    rejected?: Promise<void> | undefined;
    establish?: Promise<void> | undefined;
  };
  counts: { authorize: number; rejected: number; establish: number };
} {
  const gates: {
    authorize?: Promise<void> | undefined;
    rejected?: Promise<void> | undefined;
    establish?: Promise<void> | undefined;
  } = {};
  const counts = { authorize: 0, rejected: 0, establish: 0 };
  return {
    kind: 'gated',
    gates,
    counts,
    prepare: async () => OK,
    establish: async (_target: ILogonTarget) => {
      counts.establish += 1;
      if (gates.establish) await gates.establish;
      return OK;
    },
    authorize: async (request: IRequestTarget) => {
      counts.authorize += 1;
      // Numbered by call, so a send can be told apart by whose authorize
      // wrote it.
      const call = counts.authorize;
      if (gates.authorize) await gates.authorize;
      request.header('Authorization', `Gated ${call}`);
      return OK;
    },
    rejected: async (_rejection: IAuthRejection) => {
      counts.rejected += 1;
      if (gates.rejected) await gates.rejected;
      return OK;
    },
  };
}

/**
 * Resolves after `hops` turns of the microtask queue — for an abort that must
 * land in a particular turn after a wait answered.
 */
export function afterMicrotasks(hops: number): Promise<void> {
  let chain = Promise.resolve();
  for (let i = 0; i < hops; i += 1) chain = chain.then(() => {});
  return chain;
}

/** Lets every queued turn run, timers of zero delay included. */
export const drained = (): Promise<void> =>
  new Promise<void>((resolve) => setImmediate(resolve));

/**
 * A promise's outcome, readable without awaiting it — so a test can say "it
 * has already rejected" while the work it raced is still pending.
 */
export function watched<T>(promise: Promise<T>): {
  state: () => 'pending' | 'resolved' | 'rejected';
  error: () => unknown;
  value: () => T | undefined;
} {
  let state: 'pending' | 'resolved' | 'rejected' = 'pending';
  let error: unknown;
  let value: T | undefined;
  promise.then(
    (v) => {
      state = 'resolved';
      value = v;
    },
    (e: unknown) => {
      state = 'rejected';
      error = e;
    },
  );
  return { state: () => state, error: () => error, value: () => value };
}

/** What every aborted request rejects with, in fixed words. */
export const ABORTED = {
  code: ADT_REQUEST_ERROR.ABORTED,
  message:
    'The request was aborted by its caller; nothing more of it was sent.',
};

export const httpConfig: SapConfig = {
  url: 'https://sap.example.com',
  authType: 'basic',
  username: 'USER',
  password: 'PASS',
  client: '100',
};

export const DISCOVERY = '/sap/bc/adt/core/discovery';

type Answer = () => Promise<IAdtTransportResponse>;

export const ok = (data = '<ok/>'): IAdtTransportResponse => ({
  status: 200,
  statusText: 'OK',
  headers: {},
  data,
});

/** A refusal as a wire throws it: an error carrying `response`. */
export function refused(
  status: number,
  data = '',
): Error & { response: unknown } {
  const error = new Error(`status ${status}`) as Error & { response: unknown };
  error.response = { status, statusText: '', headers: {}, data };
  return error;
}

/**
 * An HTTP wire whose sends are scripted per path: an answer queued for a path
 * is used once, after which the path answers 200. The discovery endpoint
 * earns a token and a session cookie.
 */
export function scriptedWire() {
  const sent: Array<{ method: string; url: string }> = [];
  const queued = new Map<string, Answer[]>();
  const transport = new OnPremHttpTransport(() => ({}), null, {
    client: '100',
    baseUrl: httpConfig.url,
  });
  const send = async (request: IAdtTransportRequest) => {
    const path = request.url.startsWith(httpConfig.url)
      ? request.url.slice(httpConfig.url.length)
      : request.url;
    sent.push({ method: request.method, url: path });
    const next = queued.get(path)?.shift();
    if (next) return next();
    if (path === DISCOVERY) {
      return {
        status: 200,
        statusText: 'OK',
        data: '<service/>',
        headers: {
          'x-csrf-token': 'TOKEN',
          'set-cookie': ['SAP_SESSIONID_STUB_100=abc; path=/'],
        },
      };
    }
    return ok();
  };
  // The logoff goes out detached, past `send`: it is recorded here too, so
  // no test reaches a real client.
  Object.assign(transport as unknown as Record<string, unknown>, {
    send,
    sendDetached: send,
  });
  const queue = (path: string, answer: Answer) => {
    const list = queued.get(path) ?? [];
    list.push(answer);
    queued.set(path, list);
  };
  return {
    transport,
    sent,
    /** Queue the next answer for a path. */
    answer: queue,
    /** Hold the next send of a path until the test answers it. */
    hold: (path: string): Deferred<IAdtTransportResponse> => {
      const held = deferred<IAdtTransportResponse>();
      queue(path, () => held.promise);
      return held;
    },
    sends: (path: string) => sent.filter((entry) => entry.url === path).length,
  };
}

export const rfcConfig: SapConfig = {
  url: 'http://saphost:8000',
  authType: 'basic',
  username: 'USER',
  password: 'PASS',
  client: '100',
};

export type RfcAnswer = Record<string, unknown>;

export const rfcAnswer = (status: number, body = '<ok/>'): RfcAnswer => ({
  RESPONSE: {
    STATUS_LINE: { STATUS_CODE: status, REASON_PHRASE: '' },
    HEADER_FIELDS: [],
    MESSAGE_BODY: Buffer.from(body, 'utf-8'),
  },
});

export interface StubConversation extends IRfcConversation {
  alive: boolean;
  opens: number;
  closes: number;
  /** The URI of every call this conversation carried. */
  called: string[];
}

/**
 * Conversations through the seam, no SDK, whose opens and calls the test can
 * hold: `holdOpen` / `openAtOnce` are played in order by the conversations
 * opened after the stateful one, `holdCall` / `answerCall` per URI. Each
 * conversation can reset, so the first free non-stateful call takes the kept
 * one.
 */
export function rfcConversations(
  /** Told of every call as it is made, before it answers. */
  onCall?: (uri: string) => void,
) {
  const opened: StubConversation[] = [];
  const opens: Array<() => Promise<void>> = [];
  const calls = new Map<string, Array<() => Promise<RfcAnswer>>>();
  let first = true;
  const connect = (): IRfcConversation => {
    const behaviour = first ? undefined : opens.shift();
    first = false;
    const conversation: StubConversation = {
      alive: true,
      opens: 0,
      closes: 0,
      called: [],
      open: async () => {
        conversation.opens += 1;
        if (behaviour) await behaviour();
      },
      close: async () => {
        conversation.closes += 1;
        conversation.alive = false;
      },
      call: async (_fm: string, params: Record<string, unknown>) => {
        const line = (params.REQUEST as { REQUEST_LINE: { URI: string } })
          .REQUEST_LINE;
        const uri = String(line.URI);
        conversation.called.push(uri);
        onCall?.(uri);
        const next = calls.get(uri)?.shift();
        return next ? next() : rfcAnswer(200);
      },
      resetServerContext: async () => {},
    };
    opened.push(conversation);
    return conversation;
  };
  const queueCall = (uri: string, answer: () => Promise<RfcAnswer>) => {
    const list = calls.get(uri) ?? [];
    list.push(answer);
    calls.set(uri, list);
  };
  return {
    opened,
    called: (uri: string) =>
      opened.flatMap((c) => c.called.filter((u) => u === uri)).length,
    transport: new RfcTransport(connect, null),
    holdOpen: () => {
      const held = deferred();
      opens.push(() => held.promise);
      return held;
    },
    openAtOnce: () => {
      opens.push(async () => {});
    },
    holdCall: (uri: string) => {
      const held = deferred<RfcAnswer>();
      queueCall(uri, () => held.promise);
      return held;
    },
    answerCall: (uri: string, rfc: RfcAnswer) => {
      queueCall(uri, async () => rfc);
    },
  };
}
