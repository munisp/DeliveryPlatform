#!/usr/bin/env bash
set -euo pipefail

if [[ "${NODE_ENV:-test}" == "production" || "${ALLOW_TEST_INFRASTRUCTURE_SIMULATIONS:-}" != "true" ]]; then
  echo "Refusing infrastructure simulations outside an explicitly enabled test context." >&2
  exit 64
fi

if [[ -n "${DATABASE_URL:-}" && "${DATABASE_URL}" != *"localhost"* && "${DATABASE_URL}" != *"127.0.0.1"* && "${DATABASE_URL}" != *".test"* ]]; then
  echo "Refusing infrastructure simulations against a non-isolated database URL." >&2
  exit 64
fi

cd "$(dirname "$0")/../.."

echo "Running test-only infrastructure simulations; this is not real-service production evidence."
NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=512}" pnpm exec vitest run \
  tests/partition-simulation.test.ts \
  tests/kafka-broker-failure.test.ts \
  tests/temporal-compensation.test.ts \
  tests/chaos-simultaneous-partition.test.ts \
  tests/funds-integrity.test.ts \
  tests/concurrency-double-spend.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true
