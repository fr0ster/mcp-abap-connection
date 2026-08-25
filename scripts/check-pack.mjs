#!/usr/bin/env node
/**
 * Checks what would actually be published, because `files` is only half of it.
 *
 * Two defects shipped past every other gate here, one after the other, and both
 * looked innocent from `package.json`: `files` lists `dist`, and it was the
 * COMPILER that decided what `dist` held. First `dist/__tests__/` — the shared
 * connector contract, its fixtures and three helpers — because `tsconfig`
 * excluded only files named `.test.ts`, which is not the same as excluding the
 * test directory. Then `dist/tsconfig.scripts.tsbuildinfo`, 120KB of incremental
 * bookkeeping from a config whose only job was `--noEmit`, because it inherited
 * `composite` and `outDir` from the base.
 *
 * Neither is a documentation problem, a type error or a failing test, so
 * nothing here was looking. This asks npm the one question that matters — what
 * goes in the tarball — and reads the answer.
 */
import { spawnSync } from 'node:child_process';

/** What has no business reaching a consumer, and why it got in before. */
const FORBIDDEN = [
  {
    test: (p) => /(^|\/)__tests__(\/|$)/.test(p),
    why: 'a test file: exclude the test directory in tsconfig, not just *.test.ts',
  },
  {
    test: (p) => p.endsWith('.tsbuildinfo'),
    why: "a compiler's incremental state: set composite/incremental false, or move tsBuildInfoFile out of the published directory",
  },
  {
    test: (p) => p.endsWith('.ts') && !p.endsWith('.d.ts'),
    why: 'a TypeScript source: only the build output ships',
  },
  {
    test: (p) => /(^|\/)\.env|\.env$|(^|\/)\.npmrc$/.test(p),
    why: 'credentials',
  },
  {
    test: (p) => /\.(log|tgz)$/.test(p),
    why: 'a build artifact',
  },
];

/** Report and stop. A check that could not run must never look like one that passed. */
function unanswered(headline, lines) {
  console.log(`✗ pack — ${headline}`);
  for (const line of lines.filter(Boolean).slice(0, 12)) {
    console.log(`    ${line}`);
  }
  process.exit(1);
}

/**
 * `npm pack` failing is a finding, not a crash — and there are three ways to
 * fail, which is why this is `spawnSync` and not `execFileSync`.
 *
 * The first version discarded stderr, so a read-only npm cache came back as
 * `Command failed: npm pack --dry-run --json`. Piping stderr fixed that one and
 * missed the other: when the process never STARTS — EPERM under a sandbox,
 * ENOENT with no npm on PATH — there is no stderr to pipe, the useful part is
 * in `error.code` and `error.syscall`, and `execFileSync` collapses all of it
 * into the same opaque message.
 *
 * `spawnSync` throws nothing and hands back all four channels, so each failure
 * is asked about separately rather than inferred from an exception.
 */
const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
  encoding: 'utf8',
});

if (result.error) {
  // The process never ran. `error.message` alone would say "spawnSync npm
  // EPERM" and stop there.
  const { code, errno, syscall, path } = result.error;
  unanswered('npm could not be started, so nothing was checked', [
    result.error.message,
    code && `code: ${code}`,
    errno !== undefined && `errno: ${errno}`,
    syscall && `syscall: ${syscall}`,
    path && `path: ${path}`,
  ]);
}

if (result.status !== 0) {
  // It ran and refused. npm's own words are the reason; the exit status alone
  // is not.
  unanswered(
    `npm exited ${result.signal ? `on ${result.signal}` : `with ${result.status}`}, so nothing was checked`,
    `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim().split('\n'),
  );
}

let pack;
try {
  [pack] = JSON.parse(result.stdout);
} catch {
  // npm exited 0 with something that is not the JSON this asked for. Print what
  // it actually said: whatever that is, it is the reason, and guessing would
  // hide it.
  unanswered(
    'npm answered, but not with the JSON this asked for',
    String(result.stdout ?? '')
      .trim()
      .split('\n'),
  );
}
const files = pack.files.map((f) => f.path);

const problems = [];
for (const file of files) {
  for (const rule of FORBIDDEN) {
    if (rule.test(file)) problems.push(`${file} — ${rule.why}`);
  }
}

// Stated on every run, pass or fail: the number is the thing a reader can
// sanity-check against the last release, and it only helps if it is always there.
console.log(
  `${problems.length ? '✗' : '✓'} pack — ${pack.entryCount} files, ${Math.round(pack.size / 1024)}KB packed, ${Math.round(pack.unpackedSize / 1024)}KB unpacked`,
);
for (const problem of problems) console.log(`    ${problem}`);
process.exit(problems.length ? 1 : 0);
