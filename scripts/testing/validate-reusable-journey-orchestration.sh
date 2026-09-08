#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="${ROOT_DIR}/validation"
LOG_FILE="${LOG_DIR}/reusable_journey_orchestration_validation_$(date -u +%Y%m%d).txt"
mkdir -p "${LOG_DIR}"

{
  printf '%s\n' 'reusable_journey_orchestration_validation=START'
  printf '%s\n' 'scope=local Temporal SDK test environment plus disposable PostgreSQL inventory bridge validation'

  cd "${ROOT_DIR}/services/go/mojaloop"
  go test -race ./...

  cd "${ROOT_DIR}"
  pnpm exec vitest run \
    tests/medusa-commerce-signature.test.ts \
    tests/medusa-inventory-ingress.test.ts \
    tests/medusa-inventory-outbox.test.ts
  pnpm run check
  bash "${ROOT_DIR}/scripts/testing/validate-medusa-inventory-reservation-bridge.sh"
  git diff --check

  printf '%s\n' 'journey_catalog=60 scenarios; delivery=20; ride_sharing=20; gig_workers=20'
  printf '%s\n' 'temporal_execution=deterministic SDK test environment; no live Temporal cluster'
  printf '%s\n' 'external_services=not contacted; in-process HTTP servers test fixed action protocols only'
  printf '%s\n' 'reusable_journey_orchestration_validation=PASS'
} 2>&1 | tee "${LOG_FILE}"

printf 'validation_log=%s\n' "${LOG_FILE}"
