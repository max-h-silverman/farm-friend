#!/usr/bin/env bash
# Boot the standalone Next server and prove it actually serves.
#
# WHY THIS EXISTS AS A SCRIPT rather than a vitest case: everything about the standalone
# bundle is a property of the BUILD OUTPUT, not of the source. `container-build.test.ts`
# can only assert that the right text appears in the right config files, and that is not
# the same claim. The first run of this check found what the source tests could not see —
# `.next/standalone/packages/*` contains nothing but a package.json, and `node_modules`
# has no `postgres`, `drizzle-orm`, or `zod`. That looks like a broken bundle and is not:
# `transpilePackages` inlines those into Next's server chunks. Only running it shows that.
#
# The load-bearing assertion is the ERROR CLASS on a database route. Pointed at an
# unreachable but syntactically valid Postgres URL, a correct bundle fails with
# ECONNREFUSED — the driver loaded and tried to connect. A bundle missing its
# dependencies fails with MODULE_NOT_FOUND instead. Those two failures are both "HTTP
# 500" and mean opposite things, so asserting on the status code alone would prove
# nothing.
#
# Usage: scripts/smoke-standalone.sh [port]
set -euo pipefail

PORT="${1:-8099}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STANDALONE="$ROOT/apps/web/.next/standalone"
LOG="$(mktemp)"

if [ ! -f "$STANDALONE/apps/web/server.js" ]; then
  echo "FAIL: no standalone server at $STANDALONE/apps/web/server.js"
  echo "      run: npm run build --workspace @farm-friend/web"
  exit 1
fi

cleanup() {
  [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null || true
}
trap cleanup EXIT

cd "$STANDALONE"
# Deliberately unreachable database: nothing here may touch a real one.
PORT="$PORT" NODE_ENV=production \
  DATABASE_URL="postgresql://u:p@127.0.0.1:59999/db?sslmode=require" \
  PHONE_HASH_SALT=smoke-salt \
  LLM_PROVIDER=stub \
  SMS_PROVIDER=simulator \
  PUBLIC_BASE_URL="http://localhost:$PORT" \
  node apps/web/server.js > "$LOG" 2>&1 &
SRV=$!

for _ in $(seq 1 30); do
  sleep 1
  curl -sf -m 2 -o /dev/null "http://localhost:$PORT/api/health" && break
done

fail=0

health=$(curl -s -m 5 -o /dev/null -w "%{http_code}" "http://localhost:$PORT/api/health" || echo 000)
if [ "$health" = "200" ]; then
  echo "PASS  health 200 — the server boots and serves"
else
  echo "FAIL  health $health — expected 200"
  fail=1
fi

# Reaching the driver is the point; a 500 here is EXPECTED and correct.
curl -s -m 12 -o /dev/null "http://localhost:$PORT/api/public/stands" || true
sleep 1

if grep -qE "MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|Cannot find module" "$LOG"; then
  echo "FAIL  a module is missing from the standalone bundle:"
  grep -oE "Cannot find module '[^']*'" "$LOG" | sort -u | sed 's/^/        /'
  fail=1
elif grep -q "ECONNREFUSED" "$LOG"; then
  echo "PASS  database route reached the postgres driver (ECONNREFUSED, not MODULE_NOT_FOUND)"
else
  echo "FAIL  no ECONNREFUSED and no MODULE_NOT_FOUND — the route did not reach the driver"
  echo "      inspect: $LOG"
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "standalone smoke test PASSED"
else
  echo "standalone smoke test FAILED"
fi
exit "$fail"
