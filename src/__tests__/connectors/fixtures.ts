/**
 * One substrate per combination the hierarchy offers.
 *
 * Each answers the same three questions the shared contract asks — build a
 * connection, how many sessions have been opened, refuse the next
 * establishment — and answers them in its own terms, because the terms really
 * are different: a cloud session is an ADT resource with an address, an on-prem
 * one arrives as a cookie on the establishing call, and an RFC conversation is
 * the session and issues no cookie at all.
 *
 * The HTTP two swap `transport.send`, keeping the real `HttpTransport` state —
 * jar, fingerprint, affinity — so what is under test is the connection over a
 * real wire implementation, not over a second copy of one.
 */
import { BasicAuthProvider, TokenAuthProvider } from '../../auth/providers.js';
import type { SapConfig } from '../../config/sapConfig.js';
import { AdtCloudConnector } from '../../connection/AdtCloudConnector.js';
import { AdtOnPremConnector } from '../../connection/AdtOnPremConnector.js';
import { RfcTransport } from '../../connection/RfcTransport.js';
import type { Connection, ConnectorFixture } from './contract.js';

const config: SapConfig = {
  url: 'https://sap.example.com',
  authType: 'basic',
  username: 'u',
  password: 'p',
  client: '100',
};

const SESSION_DOC =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<http:session xmlns:http="http://www.sap.com/adt/http" xmlns:atom="http://www.w3.org/2005/Atom">' +
  '<atom:link href="/sap/bc/adt/core/http/sessions/S-1" rel="http://www.sap.com/adt/categories/core/http/sessions/securitysession"/>' +
  '<atom:link href="/sap/public/bc/icf/logoff" rel="http://www.sap.com/adt/categories/core/http/sessions/logoff"/>' +
  '</http:session>';

/** A wire that issues a fresh SAP_SESSIONID per establishment, and can refuse one. */
function httpSubstrate() {
  let issued = 0;
  // Whether the far side currently holds a session for us. An establishing call
  // made while it does not is what opens one — which is how a reconnect counts
  // as a second session and a plain read counts as none.
  let live = false;
  let refusing = false;

  const send = async (request: { url?: string; method?: string }) => {
    const url = String(request.url ?? '');

    // The teardown call. 200 with no cookie, which is what a logoff answers —
    // and it must not read as a new session.
    if (url.includes('/icf/logoff') || request.method === 'DELETE') {
      live = false;
      return { status: 200, statusText: 'OK', headers: {}, data: '' };
    }

    // Stays on until an establishment is expected to succeed again. A one-shot
    // refusal would be spent by the first of `HttpTransport.establish()`'s
    // retries and the next attempt would connect — which says nothing about
    // what a connection does when the server keeps refusing.
    if (refusing) {
      const error = new Error('unauthorized') as Error & { response?: unknown };
      // No cookie at all: the refusal opened no session, which is the thing the
      // connection has to notice.
      error.response = { status: 401, headers: {}, data: '' };
      throw error;
    }

    const establishing =
      url.includes('/core/http/sessions') || url.includes('/discovery');
    if (establishing && !live) {
      issued += 1;
      live = true;
    }

    if (url.includes('/core/http/sessions')) {
      return {
        status: 200,
        statusText: 'OK',
        data: SESSION_DOC,
        headers: {
          'set-cookie': [`SAP_SESSIONID_STUB_100=S${issued}; path=/`],
        },
      };
    }

    return {
      status: 200,
      statusText: 'OK',
      data: '<service/>',
      headers: {
        'x-csrf-token': 'TOKEN',
        'set-cookie': [`SAP_SESSIONID_STUB_100=S${issued}; path=/`],
      },
    };
  };

  return {
    send,
    sessionsOpened: () => issued,
    refuseNext: () => {
      refusing = true;
    },
  };
}

export async function cloudFixture(): Promise<ConnectorFixture> {
  const wire = httpSubstrate();
  return {
    build(): Connection {
      const conn = new AdtCloudConnector(
        config,
        new TokenAuthProvider('a-token'),
        null,
      );
      (conn as unknown as { transport: { send: unknown } }).transport.send =
        wire.send;
      return conn as unknown as Connection;
    },
    sessionsOpened: wire.sessionsOpened,
    refuseNext: wire.refuseNext,
    dispose: async () => {},
  };
}

export async function onPremHttpFixture(): Promise<ConnectorFixture> {
  const wire = httpSubstrate();
  return {
    build(): Connection {
      const conn = new AdtOnPremConnector(
        config,
        new BasicAuthProvider('u', 'p'),
        null,
      );
      (conn as unknown as { transport: { send: unknown } }).transport.send =
        wire.send;
      return conn as unknown as Connection;
    },
    sessionsOpened: wire.sessionsOpened,
    refuseNext: wire.refuseNext,
    dispose: async () => {},
  };
}

export async function onPremRfcFixture(): Promise<ConnectorFixture> {
  let opened = 0;
  let refuse = false;

  const conversation = {
    get alive() {
      return opened > 0 && !closed;
    },
    open: async () => {
      if (refuse) {
        refuse = false;
        throw new Error('RFC_COMMUNICATION_FAILURE');
      }
      closed = false;
      opened += 1;
    },
    close: async () => {
      closed = true;
    },
    // Every ADT call over this wire, answered the way the endpoint does.
    call: async () => ({
      RESPONSE: {
        STATUS_LINE: { STATUS_CODE: 200, REASON_PHRASE: 'OK' },
        // Deliberately no x-csrf-token and no set-cookie: this endpoint answers
        // with `~server_protocol` and `content-type` and nothing else, which is
        // the fact that made a cookie-shaped definition of "session" refuse RFC.
        HEADER_FIELDS: [{ NAME: 'content-type', VALUE: 'application/xml' }],
        MESSAGE_BODY: Buffer.from('<service/>', 'utf-8'),
      },
    }),
  };
  let closed = true;

  return {
    build(): Connection {
      const conn = new AdtOnPremConnector(
        config,
        new BasicAuthProvider('u', 'p'),
        null,
        undefined,
        {
          transport: new RfcTransport(() => conversation as never, null),
        },
      );
      return conn as unknown as Connection;
    },
    sessionsOpened: () => opened,
    refuseNext: () => {
      refuse = true;
    },
    dispose: async () => {},
  };
}
