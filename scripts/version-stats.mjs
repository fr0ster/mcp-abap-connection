#!/usr/bin/env node
/**
 * A markdown table of what each release contained: commits, files, lines.
 *
 * Usage: `npm run chrono [-- <count>]` — how many tags to show, newest first,
 * default 20.
 *
 * This was `tools/version-stats.sh`, which `npm run chrono` invoked as
 * `./tools/version-stats.sh` — a spelling that needs both a POSIX shell and a
 * `#!` the OS honours, so on Windows it was not a script that failed, it was a
 * script that could not be started. It reads git and prints text; nothing in it
 * wanted bash except `$(...)`, and Node is already a requirement of this
 * package while bash is not.
 */
import { execFileSync } from 'node:child_process';

/** git, or '' if the command failed — a missing parent is an answer, not a crash. */
function git(...args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/** The first number in `text` before `label`, or 0 — an absent stat is zero. */
const stat = (text, label) =>
  Number(new RegExp(`(\\d+) ${label}`).exec(text)?.[1] ?? 0);

const count = Number(process.argv[2] ?? 20);
if (!Number.isInteger(count) || count < 1) {
  console.error(`Usage: npm run chrono [-- <count>]; got ${process.argv[2]}`);
  process.exit(2);
}

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const generated = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

console.log('# Version Statistics Report');
console.log('');
console.log(`Generated: ${generated}`);
console.log('');

const tags = git('tag', '-l', 'v*', '--sort=-version:refname')
  .split('\n')
  .filter(Boolean)
  .slice(0, count);

if (tags.length === 0) {
  console.log('No version tags found.');
  process.exit(0);
}

console.log('| Version | Date | Commits | Files | Insertions | Deletions |');
console.log('|---------|------|---------|-------|------------|-----------|');

let totalCommits = 0;
let totalInsertions = 0;
let totalDeletions = 0;

for (const tag of tags) {
  // The first tag in the repository has no predecessor to diff against, so it
  // gets no row — as in the shell version this replaces.
  const prev = git('describe', '--tags', '--abbrev=0', `${tag}^`);
  if (!prev) continue;

  const range = `${prev}..${tag}`;
  const commits = git('log', '--oneline', range)
    .split('\n')
    .filter(Boolean).length;
  const date = git('log', '-1', '--format=%cs', tag);
  const shortstat = git('diff', '--shortstat', range);

  const files = stat(shortstat, 'files? changed');
  const insertions = stat(shortstat, 'insertions?');
  const deletions = stat(shortstat, 'deletions?');

  totalCommits += commits;
  totalInsertions += insertions;
  totalDeletions += deletions;

  // Bold a large release, and mark a very large one: the point of the table is
  // to find the releases worth looking at.
  const name =
    insertions > 10000
      ? `**${tag}** 🔥`
      : insertions > 1000
        ? `**${tag}**`
        : tag;
  console.log(
    `| ${name} | ${date} | ${commits} | ${files} | +${insertions} | -${deletions} |`,
  );
}

console.log('');
console.log('## Summary');
console.log('');
console.log(
  `- 📅 Period: **${git('log', '-1', '--format=%cs', tags[tags.length - 1])} → ${git('log', '-1', '--format=%cs', tags[0])}**`,
);
console.log(`- 📝 Total commits: **${totalCommits}**`);
console.log(`- 📈 Lines added: **+${totalInsertions}**`);
console.log(`- 📉 Lines removed: **-${totalDeletions}**`);
console.log(`- 📊 Net change: **${totalInsertions - totalDeletions}** lines`);
