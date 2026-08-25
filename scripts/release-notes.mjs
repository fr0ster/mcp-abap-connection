#!/usr/bin/env node
/**
 * The release notes are the changelog section for the tag being released.
 *
 * They were a static "Installation" block plus `generate_release_notes`, which
 * lists merged pull requests and nothing else. Most work here lands as commits
 * on master, so v6.0.1 published notes naming ONE pull request while express
 * leaving the dependency tree, a configurable auth window and an end-to-end
 * verification against a live system were all invisible — in the one place a
 * consumer looks before upgrading.
 *
 * The changelog already says all of it. This puts it where it is read.
 *
 * Usage: node scripts/release-notes.mjs <version> > NOTES.md
 */
import { readFileSync } from 'node:fs';

const version = process.argv[2];
if (!version) {
  console.error('usage: release-notes.mjs <version>');
  process.exit(1);
}

const changelog = readFileSync('CHANGELOG.md', 'utf8');
const start = changelog.indexOf(`## [${version}]`);
if (start === -1) {
  // Loud, not empty: a release whose notes silently came out blank is the
  // defect this script exists to fix.
  console.error(
    `CHANGELOG.md has no section for ${version}. Add one before tagging.`,
  );
  process.exit(1);
}

const rest = changelog.slice(start);
const nextHeading = rest.indexOf('\n## [', 1);
const section = (nextHeading === -1 ? rest : rest.slice(0, nextHeading)).trim();

// The heading is dropped: GitHub already shows the version above the body.
const body = section.replace(/^## \[[^\]]+\][^\n]*\n/, '').trim();

process.stdout.write(`## Installation

Download the \`.tgz\` package and install:

\`\`\`bash
npm install -g ./mcp-abap-adt-connection-${version}.tgz
\`\`\`

Or from the registry:

\`\`\`bash
npm install @mcp-abap-adt/connection@${version}
\`\`\`

${body}
`);
