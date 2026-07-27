#!/bin/sh
# Runs every suite and reports a combined result.
#
#   ./test/run.sh                 # core, merge, sync (ui skips without jsdom)
#
# The ui suite needs jsdom, which the app itself does not depend on:
#   npm i jsdom && NODE_PATH=./node_modules ./test/run.sh

cd "$(dirname "$0")/.." || exit 1

failed=0
for suite in core merge sync backfill ui; do
  printf '%-7s ' "$suite"
  if ! node "test/$suite.test.js" | tail -1; then
    failed=1
  fi
done

if [ "$failed" -ne 0 ]; then
  echo
  echo "FAILURES — rerun an individual suite for detail, e.g. node test/merge.test.js"
  exit 1
fi
