/**
 * What the live RFC suite needs to drive the external debugger in terminal
 * mode through a connection: the debuggee passport, and raw ADT requests read
 * by plain search (no regex). Nothing here prints an id, a passport or a body
 * that may carry them.
 */
import { randomBytes } from 'node:crypto';
import type { AbapConnection } from '../../connection/AbapConnection.js';
import { refusalOf } from '../../connection/IAdtTransport.js';

/** A terminal id and an IDE id: 32 upper-case hex characters each. */
export interface Terminal {
  terminalId: string;
  ideId: string;
}

/** Fresh random ids, as an IDE would mint them. */
export function randomIds(): Terminal {
  return {
    terminalId: randomBytes(16).toString('hex').toUpperCase(),
    ideId: randomBytes(16).toString('hex').toUpperCase(),
  };
}

/**
 * The ADT client's debuggee passport (adt-clients `runtime/debugger/passport.ts`):
 * 288 bytes, version 3, `*TH*` at both ends, its own length at bytes 5–6, the
 * terminal and IDE ids as the two system variable items a terminal-mode
 * listener matches. 288 bytes with every per-request field zero:
 */
const TEMPLATE = [
  '2A54482A03012000000000000000000000000000000000000000000000000000',
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0000000000000000000000000000000000000000000000000000000000000000',
  '000000000000000000000000000000000000000000000000000A000000000000',
  '0000000000000000000000000000000000000000000000000000000000000001',
  '00E22A54482A01003A0100010002000200010300170000000000000000000000',
  '000000000000020002030017000000000000000000000000000000002A54482A',
].join('');

const TRANS_ID = 149; // 32 ASCII hex characters
const ROOT_CONTEXT_ID = 186; // 16 bytes
const TERMINAL_ID = 245; // 16 bytes, system variable item (2, 1)
const IDE_ID = 268; // 16 bytes, system variable item (2, 2)

/** The `SAP-PASSPORT` header value (upper-case hex) carrying `ids`. */
export function debuggeePassportHex(ids: Terminal): string {
  const passport = Buffer.from(TEMPLATE, 'hex');
  const hex = () => randomBytes(16).toString('hex').toUpperCase();
  Buffer.from(hex(), 'ascii').copy(passport, TRANS_ID);
  Buffer.from(hex(), 'hex').copy(passport, ROOT_CONTEXT_ID);
  Buffer.from(ids.terminalId, 'hex').copy(passport, TERMINAL_ID);
  Buffer.from(ids.ideId, 'hex').copy(passport, IDE_ID);
  return passport.toString('hex').toUpperCase();
}

/** The text between `<NAME>` and `</NAME>` (plain search), or undefined. */
export function tag(document: string, name: string): string | undefined {
  const open = `<${name}>`;
  const start = document.indexOf(open);
  if (start < 0) return undefined;
  const end = document.indexOf(`</${name}>`, start + open.length);
  if (end < 0) return undefined;
  return document.slice(start + open.length, end);
}

/** An answer, or a refusal's status and body: what a request came back with. */
export interface Answer {
  status: number;
  body: string;
}

function text(data: unknown): string {
  return typeof data === 'string' ? data : '';
}

/**
 * One request; a refusal with a status is an answer too (its status and body),
 * anything else is thrown as it is.
 */
export async function request(
  conn: AbapConnection,
  method: string,
  url: string,
  options: { headers?: Record<string, string>; data?: string } = {},
): Promise<Answer> {
  try {
    const response = await conn.makeAdtRequest({
      method,
      url,
      timeout: 0,
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      ...(options.data === undefined ? {} : { data: options.data }),
    });
    return { status: response.status, body: text(response.data) };
  } catch (error) {
    const refusal = refusalOf(error);
    if (refusal === null) throw error;
    return { status: refusal.status, body: text(refusal.data) };
  }
}

const DEBUGGER = '/sap/bc/adt/debugger';

function terminalQuery(ids: Terminal, extra: Record<string, string> = {}) {
  return new URLSearchParams({
    debuggingMode: 'terminal',
    terminalId: ids.terminalId,
    ideId: ids.ideId,
    ...extra,
  }).toString();
}

function breakpointsBody(ids: Terminal, rows: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><dbg:breakpoints xmlns:dbg="http://www.sap.com/adt/debugger" xmlns:adtcore="http://www.sap.com/adt/core" debuggingMode="terminal" scope="external" terminalId="${ids.terminalId}" ideId="${ids.ideId}">${rows}</dbg:breakpoints>`;
}

export function classUri(name: string): string {
  return `/sap/bc/adt/oo/classes/${name.toLowerCase()}`;
}

/** The 1-based number of the first source line holding `marker`, or undefined. */
export function lineOf(source: string, marker: string): number | undefined {
  const lines = source.split('\n');
  const index = lines.findIndex((line) => line.includes(marker));
  return index < 0 ? undefined : index + 1;
}

/** Arm one external line breakpoint; the status of the answer. */
export async function armBreakpoint(
  conn: AbapConnection,
  ids: Terminal,
  className: string,
  line: number,
): Promise<number> {
  const row = `<breakpoint kind="line" adtcore:uri="${classUri(className)}/source/main#start=${line}"/>`;
  const answer = await request(conn, 'POST', `${DEBUGGER}/breakpoints`, {
    headers: { 'Content-Type': 'application/xml', Accept: 'application/xml' },
    data: breakpointsBody(ids, row),
  });
  return answer.status;
}

/** Remove every external breakpoint under the terminal's key; the status. */
export async function clearBreakpoints(
  conn: AbapConnection,
  ids: Terminal,
): Promise<number> {
  const answer = await request(conn, 'POST', `${DEBUGGER}/breakpoints`, {
    headers: { 'Content-Type': 'application/xml', Accept: 'application/xml' },
    data: breakpointsBody(ids, '<syncScope mode="full"/>'),
  });
  return answer.status;
}

/** What a listener's long poll answered. */
export type ListenerAnswer =
  | { caught: false }
  | { caught: true; debuggeeId: string };

/**
 * Two forms are known (measured on premise): a hold that ended with nothing
 * caught answers 200 with an empty body, a caught run 200 with a
 * `DebuggeesList` naming its `DEBUGGEE_ID`. Anything else throws, naming the
 * status and the body's length (the body may carry the ids).
 */
export function readListenerAnswer(answer: Answer): ListenerAnswer {
  if (answer.status === 200 && answer.body === '') return { caught: false };
  const debuggeeId =
    answer.status === 200 ? tag(answer.body, 'DEBUGGEE_ID') : undefined;
  if (debuggeeId !== undefined && debuggeeId !== '') {
    return { caught: true, debuggeeId };
  }
  throw new Error(
    `the listener answered neither "nothing caught" (200, empty body) nor a caught debuggee: status ${answer.status}, a body of ${answer.body.length} characters`,
  );
}

/** The listener's long poll, held `holdSeconds` by the server. */
export async function listen(
  conn: AbapConnection,
  ids: Terminal,
  holdSeconds: number,
): Promise<ListenerAnswer> {
  const answer = await request(
    conn,
    'POST',
    `${DEBUGGER}/listeners?${terminalQuery(ids, { timeout: String(holdSeconds) })}`,
    { headers: { Accept: 'application/vnd.sap.as+xml' } },
  );
  return readListenerAnswer(answer);
}

/**
 * Ask, as the IDE `ids.ideId`, whether a listener of the same user stands
 * under another IDE id: 200 with an empty body when none does, 409 when one
 * does (measured on premise). Anything else throws.
 */
export async function checkListener(
  conn: AbapConnection,
  ids: Terminal,
): Promise<'free' | 'standing'> {
  const answer = await request(
    conn,
    'GET',
    `${DEBUGGER}/listeners?${terminalQuery(ids, { checkConflict: 'true' })}`,
    { headers: { Accept: 'application/xml' } },
  );
  if (answer.status === 200 && answer.body === '') return 'free';
  if (answer.status === 409) return 'standing';
  throw new Error(
    `the listener check answered neither 200 with an empty body nor 409: status ${answer.status}, a body of ${answer.body.length} characters`,
  );
}

/** Release the listener; the status. */
export async function stopListener(
  conn: AbapConnection,
  ids: Terminal,
): Promise<number> {
  const answer = await request(
    conn,
    'DELETE',
    `${DEBUGGER}/listeners?${terminalQuery(ids)}`,
  );
  return answer.status;
}

/** Attach to a caught debuggee in terminal mode; the status. */
export async function attach(
  conn: AbapConnection,
  debuggeeId: string,
): Promise<number> {
  const answer = await request(
    conn,
    'POST',
    `${DEBUGGER}?${new URLSearchParams({ method: 'attach', debuggeeId, debuggingMode: 'terminal', dynproDebugging: 'true' }).toString()}`,
    { headers: { Accept: 'application/xml' } },
  );
  return answer.status;
}

/** Free the debugger: the server ends the session the request runs in. */
export function terminateDebugger(conn: AbapConnection): Promise<unknown> {
  return conn.makeAdtRequest({
    method: 'POST',
    url: `${DEBUGGER}?method=terminateDebugger`,
    timeout: 0,
    headers: { Accept: 'application/xml' },
  });
}

/** Run a class (`if_oo_adt_classrun`), with the given headers. */
export function runClass(
  conn: AbapConnection,
  className: string,
  headers: Record<string, string> = {},
): Promise<Answer> {
  return request(conn, 'POST', `/sap/bc/adt/oo/classrun/${className}`, {
    headers: { Accept: 'text/plain', ...headers },
  });
}
