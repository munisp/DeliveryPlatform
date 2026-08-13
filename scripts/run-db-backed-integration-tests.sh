#!/usr/bin/env bash
set -euo pipefail

# Runs the 27 environment-gated integration tests against an isolated,
# disposable PostgreSQL database. Never point TEST_DATABASE_URL at production.

: "${TEST_DATABASE_URL:?TEST_DATABASE_URL must target an isolated test database}"

case "${TEST_DATABASE_URL}" in
  *production*|*prod*)
    echo "Refusing to run destructive integration tests against a production-looking database URL" >&2
    exit 2
    ;;
esac

cd "$(dirname "${BASH_SOURCE[0]}")/.."
pnpm exec vitest run \
  server/growth-features.test.ts \
  server/loyalty.test.ts \
  server/performance.marketplace.test.ts \
  tests/non_mojaloop_idempotency.test.ts \
  --reporter=verbose
