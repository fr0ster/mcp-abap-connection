#!/usr/bin/env bash
# Checks the docs against the code, because prose does not compile.
#
# Each check exists because something got shipped past it: an example calling a
# method that was removed eight versions ago, a link to a file that never
# existed, a quick start that could not run.
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0

echo "1/4 examples that make a request must connect first"
for f in examples/*.js; do
  if grep -q "makeAdtRequest" "$f" && ! grep -q "\.connect()" "$f"; then
    echo "  $f"; fail=1
  fi
done

echo "2/4 every method called on a connection must exist"
missing=$(grep -rhoE "connection[0-9]*\.[a-zA-Z]+\(" examples/*.js docs/*.md README.md \
  | sed 's/.*\.//;s/(//' | sort -u | while read -r m; do
  grep -rqE "(^|[^a-zA-Z])${m}[[:space:]]*[(<]" src/connection/ || echo "  ${m}() is called but does not exist"
done)
[ -n "$missing" ] && { echo "$missing"; fail=1; }

echo "3/4 every markdown link must resolve"
broken=$(while IFS= read -r f; do
  grep -oE '\]\(\.{0,2}/?[A-Za-z0-9_/.-]+\.md' "$f" | sed 's/](//' | while read -r l; do
    d=$(dirname "$f")
    [ -f "$d/$l" ] || [ -f "$l" ] || echo "  $f -> $l"
  done
done < <(find . -name "*.md" -not -path "./node_modules/*" -not -name CHANGELOG.md))
[ -n "$broken" ] && { echo "$broken"; fail=1; }

echo "4/4 no version number restated outside the changelog"
stale=$(grep -rnE "Latest version:? [0-9]|\*\*Version:\*\* [0-9]" docs/ README.md examples/ 2>/dev/null)
[ -n "$stale" ] && { echo "$stale"; fail=1; }

exit $fail
