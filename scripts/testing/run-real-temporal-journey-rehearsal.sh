#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNTIME_DIR="${JOURNEY_TEMPORAL_REHEARSAL_RUNTIME_DIR:-${ROOT_DIR}/.journey-temporal-rehearsal}"
CONTAINER_NAME="switchos-journey-temporal-rehearsal-$$"
NETWORK_NAME="switchos-journey-temporal-rehearsal-$$"
PORT="${JOURNEY_TEMPORAL_REHEARSAL_PORT:-17283}"
LOG_FILE="${ROOT_DIR}/validation/real_temporal_journey_rehearsal_$(date -u +%Y%m%d).txt"

cleanup() {
  set +e
  sudo docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  sudo docker network rm "${NETWORK_NAME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [[ -e "${RUNTIME_DIR}" ]]; then
  echo "Refusing to reuse an existing rehearsal directory: ${RUNTIME_DIR}" >&2
  exit 2
fi
mkdir -p "${RUNTIME_DIR}/temporal-data"

wait_for_temporal() {
  for _ in $(seq 1 80); do
    if (echo >/dev/tcp/127.0.0.1/${PORT}) >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

{
  printf '%s\n' 'real_temporal_journey_rehearsal=START'
  printf 'scope=isolated local Docker Temporal service with volume-backed dev database and HTTP activity fixture\n'
  sudo docker network create "${NETWORK_NAME}" >/dev/null
  sudo docker run -d --rm \
    --name "${CONTAINER_NAME}" \
    --network "${NETWORK_NAME}" \
    -p "127.0.0.1:${PORT}:7233" \
    -v "${RUNTIME_DIR}/temporal-data:/tmp" \
    temporalio/temporal:1.8.2 \
    server start-dev --ip 0.0.0.0 --headless --db-filename /tmp/temporal.db >/dev/null
  wait_for_temporal || {
    sudo docker logs "${CONTAINER_NAME}" >&2 || true
    exit 1
  }
  printf 'temporal_endpoint=127.0.0.1:%s\n' "${PORT}"
  (
    cd "${ROOT_DIR}/services/go/mojaloop"
    REAL_JOURNEY_TEMPORAL_REHEARSAL=1 \
    TEMPORAL_ADDRESS="127.0.0.1:${PORT}" \
    go test -v -count=1 -run '^TestRealTemporalJourneyRehearsal$' ./...
  )
  printf '%s\n' 'real_temporal_journey_rehearsal=PASS'
} 2>&1 | tee "${LOG_FILE}"

printf 'validation_log=%s\n' "${LOG_FILE}"
