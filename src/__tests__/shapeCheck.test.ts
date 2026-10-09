/**
 * The shape check of the auth error contract (rules 4, 5, 6), run in-process
 * through the module of @mcp-abap-adt/auth-errors: each fixture is refused by
 * exactly its own rule, a clean file and connection's own source pass.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  checkProviderShape,
  reportLines,
  type ShapeCheckOptions,
  type ShapeCheckReport,
  type ShapeFinding,
} from '@mcp-abap-adt/auth-errors/shape-check';
import ts from 'typescript';

const ROOT = resolve(__dirname, '../..');

/** The whole configuration of the check in this repository. */
const SHAPE_CHECK = {
  typescript: ts,
  rules: [4, 5, 6],
  root: ROOT,
  project: join(ROOT, 'tsconfig.json'),
  sites: join(ROOT, 'tools'),
} as const satisfies ShapeCheckOptions;

function findingsOf(report: ShapeCheckReport): readonly ShapeFinding[] {
  if (report.status !== 'checked') {
    throw new Error(`not checked: ${reportLines(report).join('\n')}`);
  }
  return report.findings;
}

function check(...files: string[]): readonly ShapeFinding[] {
  return findingsOf(
    checkProviderShape({
      ...SHAPE_CHECK,
      files: files.map((file) => join(ROOT, file)),
    }),
  );
}

describe('the shape check', () => {
  it('the site lists are empty: connection asserts no contract type and passes no diagnostics', () => {
    for (const list of ['assertion-sites.json', 'diagnostic-sites.json']) {
      expect(
        JSON.parse(readFileSync(join(ROOT, 'tools', list), 'utf8')),
      ).toStrictEqual([]);
    }
  });

  it.each([
    [4, 'tools/__fixtures__/rule4.ts'],
    [5, 'tools/__fixtures__/rule5.ts'],
    [6, 'tools/__fixtures__/rule6.ts'],
  ] as const)(
    'refuses the rule %s fixture (%s) with that rule alone',
    (rule, fixture) => {
      const findings = check(fixture);

      expect(findings.length).toBeGreaterThan(0);
      for (const finding of findings) {
        expect(finding.rule).toBe(rule);
        expect(finding.file).toBe(fixture);
      }
    },
  );

  it('passes a file that relays a minted error as it is', () => {
    expect(check('tools/__fixtures__/clean.ts')).toStrictEqual([]);
  });

  it("passes connection's own source", () => {
    expect(
      reportLines(
        checkProviderShape({
          ...SHAPE_CHECK,
        }),
      ),
    ).toEqual([]);
  }, 120_000);

  describe('the publishing gate', () => {
    const scripts: Record<string, string> = JSON.parse(
      readFileSync(join(ROOT, 'package.json'), 'utf8'),
    ).scripts;

    it('test:shape runs this test file alone', () => {
      expect(scripts['test:shape']).toBe(
        'jest src/__tests__/shapeCheck.test.ts',
      );
    });

    it('prepublishOnly runs the shape check through test:shape', () => {
      expect(scripts.prepublishOnly?.split(' && ')).toContain(
        'npm run test:shape',
      );
    });

    it('lint:check is Biome alone: it names no checking script', () => {
      for (const checking of ['node ', 'jest', 'test:shape', 'shape']) {
        expect(scripts['lint:check']).not.toContain(checking);
      }
    });
  });
});
