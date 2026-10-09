/**
 * Transitional: the 2.1.1 script this repository carried, the module and the
 * installed thin command give the same findings, lines and statuses on the
 * same inputs. Removed with the script.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  checkProviderShape,
  reportLines,
  type ShapeRule,
} from '@mcp-abap-adt/auth-errors/shape-check';
import ts from 'typescript';

const ROOT = resolve(__dirname, '../..');
const OWN = join(ROOT, 'tools', 'check-provider-shape.mjs');
const INSTALLED = require.resolve(
  '@mcp-abap-adt/auth-errors/tools/check-provider-shape.mjs',
);
const SCRIPT_SHA256 =
  '681d8cbdc6177d2436955e172d9aded58ea67e8b9a604d1fbaf1f81c70715603';

jest.setTimeout(300_000);

function run(script: string, args: string[]) {
  const done = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return { status: done.status, stdout: done.stdout, stderr: done.stderr };
}

const emptySites = mkdtempSync(join(tmpdir(), 'conn-empty-sites-'));
afterAll(() => rmSync(emptySites, { recursive: true, force: true }));

const FIXTURES = ['rule4.ts', 'rule5.ts', 'rule6.ts', 'clean.ts'].map(
  (name) => `tools/__fixtures__/${name}`,
);

const MATRIX: ReadonlyArray<{
  name: string;
  rules: ShapeRule[];
  sites?: string;
  files?: string[];
}> = [
  { name: 'own tree 4,5,6', rules: [4, 5, 6] },
  {
    name: 'own tree 4-8 with an empty sites dir',
    rules: [4, 5, 6, 7, 8],
    sites: emptySites,
  },
  ...FIXTURES.map((file) => ({
    name: `${file} with 4,5,6`,
    rules: [4, 5, 6] as ShapeRule[],
    files: [file],
  })),
];

describe('the 2.1.1 script, the module and the installed command agree', () => {
  it('the script is the 2.1.1 file', () => {
    expect(createHash('sha256').update(readFileSync(OWN)).digest('hex')).toBe(
      SCRIPT_SHA256,
    );
  });

  it.each(MATRIX)('$name', ({ rules, sites, files }) => {
    const args = [
      '--rules',
      rules.join(','),
      ...(sites === undefined ? [] : ['--sites', sites]),
      ...(files ?? []),
    ];
    const script = run(OWN, args);
    const command = run(INSTALLED, args);
    const report = checkProviderShape({
      typescript: ts,
      rules,
      root: ROOT,
      project: join(ROOT, 'tsconfig.json'),
      sites: sites ?? join(ROOT, 'tools'),
      files: files?.map((file) => join(ROOT, file)),
    });

    expect(command).toStrictEqual(script);
    expect(report.status).toBe('checked');
    const lines = script.stdout.split('\n').filter((line) => line.length > 0);
    expect(reportLines(report)).toEqual(lines);
    expect(script.status).toBe(lines.length === 0 ? 0 : 1);
  });
});
