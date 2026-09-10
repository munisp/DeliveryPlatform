#!/usr/bin/env bash
set -euo pipefail

# Executes only against the disposable Docker topology created by the companion
# prepare script. This guard prevents an operator from treating a workstation
# or CI runner as a production deployment target.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="${repo_root}/deploy/testing/docker-compose.financial-rehearsal.yml"
runtime_dir="${FINANCIAL_REHEARSAL_RUNTIME_DIR:-${repo_root}/.financial-rehearsal}"
env_file="${runtime_dir}/rehearsal.env"
minimum_available_kib=$((5 * 1024 * 1024))

available_kib="$(awk '/MemAvailable:/ { print $2 }' /proc/meminfo)"
if [[ -z "${available_kib}" || "${available_kib}" -lt "${minimum_available_kib}" ]]; then
  echo "Refusing rehearsal: at least 5 GiB of available memory is required for the isolated TigerBeetle, memory-capped Redpanda, Temporal, PostgreSQL, and service stack; found ${available_kib:-unknown} KiB." >&2
  exit 2
fi
if [[ -f "${env_file}" ]]; then
  echo "Refusing to reuse existing rehearsal state at ${runtime_dir}; destroy it explicitly before a new run." >&2
  exit 2
fi

network_probe="switchos-financial-rehearsal-preflight-$$"
if ! docker network create "${network_probe}" >/dev/null 2>&1; then
  echo "Refusing rehearsal: Docker bridge networking is unavailable. The topology requires bridge networking for PostgreSQL, Redpanda, and Temporal plus host networking for TigerBeetle." >&2
  exit 2
fi
if ! docker run --rm --network "${network_probe}" --entrypoint /bin/true postgres:16 >/dev/null 2>&1; then
  docker network rm "${network_probe}" >/dev/null 2>&1 || true
  echo "Refusing rehearsal: Docker cannot attach a container to a bridge network. The topology requires bridge networking for PostgreSQL, Redpanda, and Temporal plus host networking for TigerBeetle." >&2
  exit 2
fi
docker network rm "${network_probe}" >/dev/null

"${repo_root}/scripts/prepare-financial-rehearsal.sh"
"${repo_root}/scripts/format-financial-rehearsal-tigerbeetle.sh"

compose=(docker compose --env-file "${env_file}" -f "${compose_file}")
"${compose[@]}" config -q
"${compose[@]}" up --build -d

wait_for_http() {
  local url="$1"
  for _ in $(seq 1 60); do
    if curl --fail --silent --show-error "${url}" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for ${url}" >&2
  return 1
}

wait_for_tcp() {
  local host="$1"
  local port="$2"
  for _ in $(seq 1 60); do
    if (echo >"/dev/tcp/${host}/${port}") >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for ${host}:${port}" >&2
  return 1
}

wait_for_tcp 127.0.0.1 3001
wait_for_tcp 127.0.0.1 3002
wait_for_tcp 127.0.0.1 3003
wait_for_tcp 127.0.0.1 19092
wait_for_tcp 127.0.0.1 17233
wait_for_http http://127.0.0.1:8474/version
wait_for_http http://127.0.0.1:18086/health
wait_for_http http://127.0.0.1:18087/health

# shellcheck source=/dev/null
source "${env_file}"
export REAL_FINANCIAL_REHEARSAL=1
export DATABASE_URL="postgresql://financial_rehearsal:${FINANCIAL_TEST_POSTGRES_PASSWORD}@127.0.0.1:55432/financial_rehearsal?sslmode=disable"
export TEST_DATABASE_URL="${DATABASE_URL}"
export INTERNAL_SERVICE_TOKEN="${FINANCIAL_TEST_INTERNAL_SERVICE_TOKEN}"
export TIGERBEETLE_ADDRESSES="127.0.0.1:3001,127.0.0.1:3002,127.0.0.1:3003"
export TIGERBEETLE_CLUSTER_ID="${FINANCIAL_TEST_CLUSTER_ID}"
export TIGERBEETLE_LEDGER=1
export TIGERBEETLE_ACCOUNT_MAP_JSON="${FINANCIAL_TEST_ACCOUNT_MAP_JSON}"
export KAFKA_BROKERS=127.0.0.1:19092
export KAFKA_FUNDS_TOPIC=switchos.financial.rehearsal
export TEMPORAL_ADDRESS=127.0.0.1:17233
export TEMPORAL_NAMESPACE=default
export TEMPORAL_TASK_QUEUE=switchos-funds-workflows
export TEMPORAL_BRIDGE_URL=http://127.0.0.1:18087
export TIGERBEETLE_FAULT_PROXY_API_URL=http://127.0.0.1:8474
export TIGERBEETLE_FAULT_PROXY_ADDRESSES=127.0.0.1:3101,127.0.0.1:3102,127.0.0.1:3103
export TIGERBEETLE_FAULT_PROXY_DIRECT_ADDRESSES=127.0.0.1:3001,127.0.0.1:3002,127.0.0.1:3003

run_phase() {
  local phase="$1"
  export FINANCIAL_REHEARSAL_PHASE="${phase}"
  (cd "${repo_root}/services/go/mojaloop" && go test ./... -run '^TestRealFinancialTopologyRehearsal$' -count=1 -v)
}

# The outbox must survive an actual broker outage after the TigerBeetle leg is
# delivered. The Temporal service and worker are stopped too so their recovery
# is tested independently after broker restoration.
"${compose[@]}" stop redpanda temporal temporal-worker
run_phase broker-partition

"${compose[@]}" start redpanda
wait_for_tcp 127.0.0.1 19092
sleep 6
run_phase broker-recovery

"${compose[@]}" start temporal
wait_for_tcp 127.0.0.1 17233
sleep 12
run_phase temporal-recovery

"${compose[@]}" start temporal-worker
run_phase temporal-worker-recovery

if [[ "${RUN_TIGERBEETLE_FAULT_PROXY_REHEARSAL:-0}" == "1" ]]; then
  export REAL_TIGERBEETLE_FAULT_PROXY_REHEARSAL=1
  (
    cd "${repo_root}/services/go/mojaloop"
    go test -tags=tigerbeetle_fault_proxy -race -count=1 -v \
      -run '^TestTigerBeetleFaultProxy' ./...
  )
fi

curl --fail --silent --show-error \
  -H "X-Internal-Service-Token: ${FINANCIAL_TEST_INTERNAL_SERVICE_TOKEN}" \
  http://127.0.0.1:18086/reconcile/overview \
  >"${runtime_dir}/reconciliation-overview.json"
"${compose[@]}" logs --no-color >"${runtime_dir}/compose.log"

printf 'Financial topology rehearsal passed. Evidence is retained in %s\n' "${runtime_dir}"
printf 'To destroy the isolated stack and all test data: docker compose --env-file %s -f %s down -v\n' "${env_file}" "${compose_file}"
