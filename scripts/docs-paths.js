/**
 * The two path rules the docs checker needs, in a module because they have to
 * hold on every platform and a test has to be able to say so.
 *
 * `path.relative()` answers in the host's separator; package.json "files"
 * entries are POSIX, always. The checker compared the two directly and was
 * therefore wrong on Windows in both directions at once: it reported shipped
 * targets as unshipped, and skipped every doc under docs/ outright, because
 * "docs\USAGE.md" does not start with "docs/".
 *
 * `win32.sep` rather than `sep`: the host's separator normalises nothing on a
 * POSIX box, and a rule that only holds where it was written is the defect.
 *
 * CommonJS with a hand-written .d.ts: check-docs.mjs runs before any build, so
 * this cannot be TypeScript, and jest has to load it too.
 */
'use strict';

const { posix, win32 } = require('node:path');

/** The same path, written the way package.json writes it. */
const toPosix = (p) => p.split(win32.sep).join(posix.sep);

/**
 * Does `target` ship, given package.json's `files`? An entry covers a file by
 * naming it exactly or by being a directory above it — `docs` covers
 * `docs/USAGE.md`, and `docs-internal/USAGE.md` is a different directory.
 */
const ships = (published, target) => {
  const path = toPosix(target);
  return published.some((raw) => {
    const entry = toPosix(raw);
    return path === entry || path.startsWith(`${entry}${posix.sep}`);
  });
};

module.exports = { ships, toPosix };
