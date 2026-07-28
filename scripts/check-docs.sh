#!/usr/bin/env bash
# Checks the docs against the code, because prose does not compile.
#
# Every check here exists because something shipped past its absence: an
# example calling a method removed eight versions earlier, a link to a file
# that never existed, a quick start that could not run. Two of them exist
# because an EARLIER version of this script reported success while the defect
# was on the page — so each check states what it does not cover.
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0

# ---------------------------------------------------------------------------
echo "1/4 every example that makes a request must connect first"
# Covers .js examples AND fenced code blocks in markdown. The first version read
# only examples/*.js, and a JWT example in USAGE.md sat broken behind a green
# run.
if ! python3 - <<'PY'
import re, sys, pathlib

problems = []

for path in sorted(pathlib.Path('examples').glob('*.js')):
    text = path.read_text()
    if 'makeAdtRequest' in text and '.connect()' not in text:
        problems.append(f'  {path}')

fence = re.compile(r'^\s*```')
for path in sorted(pathlib.Path('.').glob('**/*.md')):
    if 'node_modules' in path.parts or path.name == 'CHANGELOG.md':
        continue
    inside, start, buf = False, 0, []
    for lineno, line in enumerate(path.read_text().splitlines(), 1):
        if fence.match(line):
            if inside:
                body = '\n'.join(buf)
                # Only blocks that BUILD a connection are expected to connect;
                # snippets assuming one say so in a comment instead.
                builds = ('createAbapConnection(' in body
                          or re.search(r'new \w+AbapConnection\(', body))
                if 'makeAdtRequest' in body and builds and '.connect()' not in body:
                    problems.append(f'  {path}:{start}')
                inside, buf = False, []
            else:
                inside, start = True, lineno
        elif inside:
            buf.append(line)

for p in problems:
    print(p)
sys.exit(1 if problems else 0)
PY
then fail=1; fi

# ---------------------------------------------------------------------------
echo "2/4 every method called on a connection must exist"
missing=$(grep -rhoE "connection[0-9]*\.[a-zA-Z]+\(" examples/*.js docs/*.md README.md \
  | sed 's/.*\.//;s/(//' | sort -u | while read -r m; do
  grep -rqE "(^|[^a-zA-Z])${m}[[:space:]]*[(<]" src/connection/ || echo "  ${m}() is called but does not exist"
done)
[ -n "$missing" ] && { echo "$missing"; fail=1; }

# ---------------------------------------------------------------------------
echo "3/4 every markdown link must resolve"
broken=$(while IFS= read -r f; do
  grep -oE '\]\(\.{0,2}/?[A-Za-z0-9_/.-]+\.md' "$f" | sed 's/](//' | while read -r l; do
    d=$(dirname "$f")
    [ -f "$d/$l" ] || [ -f "$l" ] || echo "  $f -> $l"
  done
done < <(find . -name "*.md" -not -path "./node_modules/*" -not -name CHANGELOG.md))
[ -n "$broken" ] && { echo "$broken"; fail=1; }

# ---------------------------------------------------------------------------
echo "4/4 no version history restated outside the changelog"
# The first version matched two exact phrasings and walked straight past a whole
# "## Version History" section listing 0.1.x releases. It now looks for the
# SHAPE — a version-like number presented as current or as history — instead of
# for the wordings that had already been fixed.
stale=$(grep -rnE \
  "Latest version|\*\*Version:\*\*[[:space:]]*[0-9]|^#+[[:space:]]*Version History|^-[[:space:]]*\*\*[0-9]+\.[0-9]+\.[0-9]+\*\*|^#+[[:space:]]*[0-9]+\.[0-9]+\.[0-9]+" \
  docs/ README.md examples/ 2>/dev/null | grep -v '\[CHANGELOG')
[ -n "$stale" ] && { echo "$stale"; fail=1; }

exit $fail
