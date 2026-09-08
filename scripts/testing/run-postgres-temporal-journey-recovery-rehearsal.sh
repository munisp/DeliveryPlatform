#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNTIME_DIR="${POSTGRES_TEMPORAL_REHEARSAL_RUNTIME_DIR:-${ROOT_DIR}/.postgres-temporal-journey-rehearsal}"
SUFFIX="${$}-$(date +%s)"
POSTGRES_NAME="switchos-journey-postgres-${SUFFIX}"
TEMPORAL_NAME="switchos-journey-temporal-${SUFFIX}"
POSTGRES_PORT="${POSTGRES_TEMPORAL_REHEARSAL_POSTGRES_PORT:-15433}"
TEMPORAL_PORT="${POSTGRES_TEMPORAL_REHEARSAL_PORT:-17293}"
POSTGRES_PASSWORD="journey-temporal-postgres-${SUFFIX}"
TEMPORAL_NAMESPACE="journey-rehearsal-${SUFFIX}"
LOG_FILE="${ROOT_DIR}/validation/postgres_temporal_journey_recovery_rehearsal_$(date -u +%Y%m%d).txt"

cleanup() {
  set +e
  sudo docker rm -f "${TEMPORAL_NAME}" "${POSTGRES_NAME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [[ -e "${RUNTIME_DIR}" ]]; then
  echo "Refusing to reuse an existing PostgreSQL Temporal rehearsal directory: ${RUNTIME_DIR}" >&2
  exit 2
fi
mkdir -p "${RUNTIME_DIR}/postgres-data" "${RUNTIME_DIR}/logs"
chmod 700 "${RUNTIME_DIR}" "${RUNTIME_DIR}/postgres-data"

wait_for_postgres() {
  for _ in $(seq 1 80); do
    if sudo docker exec "${POSTGRES_NAME}" pg_isready -h 127.0.0.1 -p "${POSTGRES_PORT}" -U temporal -d temporal >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

wait_for_namespace() {
  local description
  for _ in $(seq 1 120); do
    description="$(sudo docker exec "${TEMPORAL_NAME}" tctl --address "127.0.0.1:${TEMPORAL_PORT}" --namespace "${TEMPORAL_NAMESPACE}" namespace describe 2>&1 || true)"
    if grep -Eq "(^|[[:space:]])Name:[[:space:]]+${TEMPORAL_NAMESPACE}($|[[:space:]])" <<<"${description}"; then
      return 0
    fi
    sudo docker exec "${TEMPORAL_NAME}" tctl --address "127.0.0.1:${TEMPORAL_PORT}" --namespace "${TEMPORAL_NAMESPACE}" namespace register --rd 1 --desc "isolated journey rehearsal namespace" >/dev/null 2>&1 || true
    sleep 0.5
  done
  printf 'Default namespace registration did not complete. Last response: %s\n' "${description}" >&2
  return 1
}

{
  printf '%s\n' 'postgres_temporal_journey_recovery_rehearsal=START'
  printf '%s\n' 'scope=isolated local PostgreSQL-backed Temporal auto-setup service over loopback plus local HTTP activity fixture'
  sudo docker run -d --rm \
    --name "${POSTGRES_NAME}" \
    --network host \
    -e POSTGRES_USER=temporal \
    -e POSTGRES_PASSWORD="${POSTGRES_PASSWORD}" \
    -e POSTGRES_DB=temporal \
    -v "${RUNTIME_DIR}/postgres-data:/var/lib/postgresql/data" \
    postgres:16 -c "port=${POSTGRES_PORT}" >/dev/null
  wait_for_postgres || {
    sudo docker logs "${POSTGRES_NAME}" >&2 || true
    exit 1
  }
  sudo docker run -d --rm \
    --name "${TEMPORAL_NAME}" \
    --network host \
    -e DB=postgresql \
    -e DB_PORT="${POSTGRES_PORT}" \
    -e POSTGRES_SEEDS=127.0.0.1 \
    -e POSTGRES_USER=temporal \
    -e POSTGRES_PWD="${POSTGRES_PASSWORD}" \
    -e DEFAULT_NAMESPACE=default \
    -e SKIP_DEFAULT_NAMESPACE_CREATION=true \
    -e BIND_ON_IP=127.0.0.1 \
    -e FRONTEND_GRPC_PORT="${TEMPORAL_PORT}" \
    temporalio/auto-setup:1.8.2 >/dev/null
  wait_for_namespace || {
    sudo docker logs "${TEMPORAL_NAME}" >&2 || true
    exit 1
  }
  # Namespace registration is replicated into the server cache asynchronously.
  # Temporal 1.8’s local namespace cache may retain the negative lookup for roughly 10 seconds.
  sleep 12
  printf 'temporal_endpoint=127.0.0.1:%s\n' "${TEMPORAL_PORT}"
  printf 'temporal_namespace=%s\n' "${TEMPORAL_NAMESPACE}"
  (
    cd "${ROOT_DIR}/services/go/mojaloop"
    REAL_JOURNEY_TEMPORAL_REHEARSAL=1 \
    REAL_JOURNEY_TEMPORAL_WORKER_RECOVERY=1 \
    TEMPORAL_ADDRESS="127.0.0.1:${TEMPORAL_PORT}" \
    TEMPORAL_NAMESPACE="${TEMPORAL_NAMESPACE}" \
    go test -v -count=1 -run '^TestRealTemporalJourneyRehearsal$' ./...
  )
  sudo docker logs --timestamps "${TEMPORAL_NAME}" >"${RUNTIME_DIR}/logs/temporal.log" 2>&1
  sudo docker logs --timestamps "${POSTGRES_NAME}" >"${RUNTIME_DIR}/logs/postgres.log" 2>&1
  printf 'temporal_log=%s\n' "${RUNTIME_DIR}/logs/temporal.log"
  printf 'postgres_log=%s\n' "${RUNTIME_DIR}/logs/postgres.log"
  printf '%s\n' 'postgres_temporal_journey_recovery_rehearsal=PASS'
} 2>&1 | tee "${LOG_FILE}"

printf 'validation_log=%s\n' "${LOG_FILE}"
printf 'runtime_dir=%s\n' "${RUNTIME_DIR}"
