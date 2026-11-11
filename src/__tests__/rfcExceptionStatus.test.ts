/**
 * The status the RFC wire reads out of an ADT exception document when the
 * endpoint leaves STATUS_LINE empty (BASIS < 7.50), read with a linear scan —
 * no regular expression in the RFC wire.
 *
 * Every row is checked against the wire's former expression, kept here in the
 * test only as the oracle. The one departure — a type that is not an own key of
 * the table — has rows of its own, without the oracle.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import ts from 'typescript';
import { refusalOf } from '../connection/IAdtTransport.js';
import {
  type IRfcConversation,
  RfcTransport,
} from '../connection/RfcTransport.js';
import { REPO_ROOT } from './helpers/repoRoot.js';

/** The table as the wire holds it, copied for the oracle. */
const ORACLE_STATUS: Readonly<Record<string, number>> = {
  ExceptionResourceNotFound: 404,
  ExceptionResourceNoAuthorization: 403,
  ExceptionResourceAlreadyExists: 409,
  ExceptionResourceLocked: 423,
  ExceptionBadRequest: 400,
  ExceptionNotSupported: 501,
  ExceptionConflict: 409,
};

/** The wire's former reading: the oracle, never production code. */
function formerStatus(body: string): number {
  const type = /<exc:type[^>]*>([^<]+)<\/exc:type>/.exec(body)?.[1]?.trim();
  return (type ? ORACLE_STATUS[type] : undefined) ?? 500;
}

/** What precedes each row: the marker the wire looks for at all. */
const MARKER = '<exc:exception/>';

const ROWS: ReadonlyArray<readonly [string, string, number]> = [
  ['a plain type', '<exc:type>ExceptionResourceNotFound</exc:type>', 404],
  [
    'a type with attributes',
    '<exc:type id="x">ExceptionResourceLocked</exc:type>',
    423,
  ],
  ['a type with spaces', '<exc:type> ExceptionConflict </exc:type>', 409],
  [
    'an empty first type, then a real one',
    '<exc:type></exc:type><exc:type>ExceptionBadRequest</exc:type>',
    400,
  ],
  ['a blank type', '<exc:type>   </exc:type>', 500],
  ['no closing exc:type', '<exc:typeX>ExceptionNotSupported</exc:typeX>', 500],
  [
    'an opening tag longer than exc:type',
    '<exc:typeX>ExceptionNotSupported</exc:type>',
    501,
  ],
  ['a < inside the type', '<exc:type>Exception<b>Bad</exc:type>', 500],
  ['an unknown type', '<exc:type>Unknown</exc:type>', 500],
  ['another case', '<EXC:TYPE>ExceptionResourceNotFound</EXC:TYPE>', 500],
  ['no exc:type at all', 'nothing typed here', 500],
  ['exc:type without a >', '<exc:type', 500],
  // Beyond the spec's table: only an opening tag starts a type, never the
  // `exc:type` inside a closing one.
  [
    'a closing tag with no opening one',
    '</exc:type>ExceptionBadRequest</exc:type>',
    500,
  ],
];

function conversationAnswering(body: string): IRfcConversation {
  return {
    alive: true,
    open: async () => {},
    close: async () => {},
    call: async () => ({
      RESPONSE: {
        STATUS_LINE: {},
        HEADER_FIELDS: [],
        MESSAGE_BODY: Buffer.from(body, 'utf-8'),
      },
    }),
  };
}

/** The status the wire reports for an exception document with an empty STATUS_LINE. */
async function statusFor(body: string): Promise<number> {
  const transport = new RfcTransport(() => conversationAnswering(body));
  await transport.open();
  try {
    const response = await transport.send({
      method: 'GET',
      url: '/sap/bc/adt/oo/classes/ZCL_X',
    });
    return response.status;
  } catch (error) {
    const refusal = refusalOf(error);
    assert.notStrictEqual(refusal, null);
    return refusal?.status ?? 0;
  }
}

describe('the status of an ADT exception document over RFC, read without a regex', () => {
  for (const [title, row, expected] of ROWS) {
    it(`${title} → ${expected}, as the former expression read it`, async () => {
      const body = `${MARKER}${row}`;
      assert.strictEqual(formerStatus(body), expected);
      assert.strictEqual(await statusFor(body), expected);
    });
  }

  // The departure from the former reading: it looked the type up in a plain
  // object, so an Object.prototype member gave a status of `undefined` and the
  // exception document fell through to 200 OK.
  for (const type of ['toString', 'constructor', '__proto__']) {
    it(`a type that is not an own key of the table (${type}) → 500, not the former 200`, async () => {
      assert.strictEqual(
        await statusFor(`${MARKER}<exc:type>${type}</exc:type>`),
        500,
      );
    });
  }
});

describe('the RFC wire holds no regular expression', () => {
  it('has no regex literal and does not name RegExp', () => {
    const file = join(REPO_ROOT, 'src', 'connection', 'RfcTransport.ts');
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf-8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
      if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
        found.push(node.getText(source));
      }
      if (ts.isIdentifier(node) && node.text === 'RegExp') {
        found.push('RegExp');
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    assert.deepStrictEqual(found, []);
  });
});
