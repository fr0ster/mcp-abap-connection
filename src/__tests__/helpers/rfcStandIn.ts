/**
 * Stand-ins for `@mcp-abap-adt/sap-rfc-lite` conversations, which need the SAP
 * NW RFC SDK to exist: each records what was done to it, and its calls answer
 * as a script says — including the way the library ends a conversation (the
 * call rejects and `alive` is left false; every later call, reset and close of
 * it rejects with the closed-connection error).
 */
import type {
  IRfcConversation,
  RfcConversationFactory,
} from '../../connection/RfcTransport.js';

/** An answer `SADT_REST_RFC_ENDPOINT` gives: 200 and a small body. */
export const RFC_OK_ANSWER: Record<string, unknown> = {
  RESPONSE: {
    STATUS_LINE: { STATUS_CODE: 200, REASON_PHRASE: 'OK' },
    HEADER_FIELDS: [],
    MESSAGE_BODY: Buffer.from('<ok/>', 'utf-8'),
  },
};

/** What sap-rfc-lite rejects with when the other side closed the conversation. */
export function rfcClosedError(): Record<string, unknown> {
  return {
    name: 'RfcLibError',
    group: 4,
    code: 6,
    codeString: 'RFC_CLOSED',
    key: 'RFC_CLOSED',
    message: 'Connection closed by the partner',
  };
}

/** The fields `rfcClosedError()` is read as. */
export const RFC_CLOSED_FIELDS = {
  key: 'RFC_CLOSED',
  group: 4,
  code: 6,
  codeString: 'RFC_CLOSED',
};

/** An ABAP exception: the call failed, the conversation lives on. */
export function abapExceptionError(): Record<string, unknown> {
  return {
    name: 'ABAPError',
    group: 5,
    code: 5,
    codeString: 'RFC_ABAP_EXCEPTION',
    key: 'NOT_FOUND',
    message: 'NOT_FOUND',
  };
}

/** What sap-rfc-lite rejects with on a conversation it already released. */
export function closedConnectionError(): Record<string, unknown> {
  return {
    name: 'nodeRfcError',
    message: 'RFM client request over closed connection',
  };
}

/** How one call on a stand-in answers. */
export type CallScript = (
  conversation: RfcStandIn,
) => Promise<Record<string, unknown>>;

export const answersOk: CallScript = async () => RFC_OK_ANSWER;

/** The call rejects with `error` and leaves the conversation released. */
export function dies(
  error: Record<string, unknown> = rfcClosedError(),
): CallScript {
  return async (conversation) => {
    conversation.alive = false;
    throw error;
  };
}

/** The call rejects with `error`; the conversation stays alive. */
export function fails(error: Record<string, unknown>): CallScript {
  return async () => {
    throw error;
  };
}

/** One conversation: what was done to it, and how its calls answer. */
export class RfcStandIn implements IRfcConversation {
  alive = false;
  opens = 0;
  calls = 0;
  resets = 0;
  closes = 0;
  /** Absent on a client that cannot reset: then every non-stateful call opens its own. */
  resetServerContext?: () => Promise<void>;

  constructor(
    /** The calls' answers, in order; past the end, each call answers 200. */
    private readonly script: CallScript[],
    canReset: boolean,
  ) {
    if (canReset) {
      this.resetServerContext = async () => {
        this.resets += 1;
        if (!this.alive) throw closedConnectionError();
      };
    }
  }

  async open(): Promise<void> {
    this.opens += 1;
    this.alive = true;
  }

  async close(): Promise<void> {
    this.closes += 1;
    if (!this.alive) throw closedConnectionError();
    this.alive = false;
  }

  async call(): Promise<Record<string, unknown>> {
    this.calls += 1;
    if (!this.alive) throw closedConnectionError();
    const answer = this.script[this.calls - 1] ?? answersOk;
    return answer(this);
  }
}

/**
 * A factory whose n-th conversation (from 0: the first `open()` of the wire is
 * the stateful one) answers by `scripts[n]`; it keeps every conversation it
 * made, in order.
 */
export function standInFactory(
  scripts: CallScript[][],
  canReset: boolean,
): { factory: RfcConversationFactory; made: RfcStandIn[] } {
  const made: RfcStandIn[] = [];
  const factory: RfcConversationFactory = () => {
    const conversation = new RfcStandIn(scripts[made.length] ?? [], canReset);
    made.push(conversation);
    return conversation;
  };
  return { factory, made };
}
