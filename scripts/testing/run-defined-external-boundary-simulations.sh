#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_FILE="$ROOT_DIR/validation/defined_external_boundary_simulations_20260907.txt"

run() {
  local label="$1"
  shift
  printf '\n=== %s ===\n' "$label" | tee -a "$LOG_FILE"
  "$@" 2>&1 | tee -a "$LOG_FILE"
}

: > "$LOG_FILE"
printf '%s\n' \
  "defined_external_boundary_simulations=START" \
  "scope=local_disposable_only" \
  "external_network_calls=forbidden" | tee -a "$LOG_FILE"

cd "$ROOT_DIR"
run "HTTP discovery and health-probe contracts" pnpm vitest run tests/external-integration-probes.contract.test.ts
run "Developer outbound webhook signing and network-failure classification" pnpm vitest run tests/developer-webhook-delivery.test.ts
run "Medusa raw-body signature verification" pnpm vitest run tests/medusa-commerce-signature.test.ts
run "Durable developer webhook retry, jitter, lease, and dead-letter simulation" bash scripts/testing/test-developer-webhook-retry-backoff.sh
run "Developer API and outbound-delivery database contract" bash scripts/testing/validate-developer-api-db.sh
run "Medusa delivery-execution database contract" bash scripts/testing/validate-medusa-commerce-db.sh
run "Real matching-worker simulated-destination economics path" bash scripts/testing/simulate-driver-offer-economics-matching-worker.sh
run "Go financial-message and settlement contract tests" bash -c 'cd services/go/mojaloop && go test -race ./...'

printf '%s\n' \
  "defined_external_boundary_simulations=PASS" \
  "evidence=${LOG_FILE}" \
  "limits=no_live_provider_no_carrier_no_regulatory_certification_no_external_destination" | tee -a "$LOG_FILE"
