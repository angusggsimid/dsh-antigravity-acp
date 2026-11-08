#!/bin/sh
# Fails its first FLAKY_FAIL_FIRST invocations, then behaves like the mock.
HERE=$(cd "$(dirname "$0")" && pwd)
COUNTER="${FLAKY_COUNTER:-/tmp/flaky.count}"
n=$(cat "$COUNTER" 2>/dev/null || echo 0)
n=$((n+1))
echo "$n" > "$COUNTER"
if [ "$n" -le "${FLAKY_FAIL_FIRST:-1}" ]; then
  echo "boom: simulated ACP spawn failure" >&2
  exit 1
fi
exec node "$HERE/mock-agy-acp.mjs"
