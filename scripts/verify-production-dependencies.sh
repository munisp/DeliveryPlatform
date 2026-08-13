#!/usr/bin/env bash
set -euo pipefail

# Fail-closed production preflight for the dependency chain that protects
# financial workflows. Run from a host with the required client CLIs and
# network access to the deployed environment.
#
# Required environment:
# SWITCHOS_PUBLIC_HOST, SWITCHOS_AUTH_HOST, POSTGRES_HOST, POSTGRES_PORT,
# POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD, REDIS_URL, TEMPORAL_ADDRESS,
# KAFKA_BROKERS, FLUVIO_KAFKA_BROKERS.

required_vars=(
  SWITCHOS_PUBLIC_HOST SWITCHOS_AUTH_HOST
  POSTGRES_HOST POSTGRES_PORT POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD
  REDIS_URL TEMPORAL_ADDRESS KAFKA_BROKERS FLUVIO_KAFKA_BROKERS
)

for variable in "${required_vars[@]}"; do
  if [[ -z "${!variable:-}" ]]; then
    echo "FAILED: required production variable ${variable} is unset" >&2
    exit 2
  fi
done

for command in curl psql redis-cli nc; do
  command -v "${command}" >/dev/null 2>&1 || {
    echo "FAILED: required command ${command} is unavailable" >&2
    exit 2
  }
done

echo "PASS: required configuration and verification tooling are present"

PGPASSWORD="${POSTGRES_PASSWORD}" psql \
  "host=${POSTGRES_HOST} port=${POSTGRES_PORT} dbname=${POSTGRES_DB} user=${POSTGRES_USER} sslmode=require connect_timeout=10" \
  -v ON_ERROR_STOP=1 \
  -c "SELECT 1 AS postgres_ready;" >/dev/null
echo "PASS: PostgreSQL is reachable over TLS"

[[ "$(redis-cli -u "${REDIS_URL}" --no-auth-warning PING)" == "PONG" ]] || {
  echo "FAILED: Redis authenticated health check did not return PONG" >&2
  exit 1
}
echo "PASS: Redis authenticated health check"

temporal_host="${TEMPORAL_ADDRESS%:*}"
temporal_port="${TEMPORAL_ADDRESS##*:}"
nc -z -w 10 "${temporal_host}" "${temporal_port}"
echo "PASS: Temporal endpoint is reachable"

probe_broker_list() {
  local label="$1"
  local brokers="$2"
  local broker host port
  IFS=',' read -r -a broker_list <<< "${brokers}"
  for broker in "${broker_list[@]}"; do
    host="${broker%:*}"
    port="${broker##*:}"
    nc -z -w 10 "${host}" "${port}" || {
      echo "FAILED: ${label} broker ${broker} is unreachable" >&2
      exit 1
    }
  done
  echo "PASS: all ${label} broker endpoints are reachable"
}

probe_broker_list "Kafka" "${KAFKA_BROKERS}"
probe_broker_list "Fluvio" "${FLUVIO_KAFKA_BROKERS}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SWITCHOS_PUBLIC_HOST="${SWITCHOS_PUBLIC_HOST}" \
SWITCHOS_AUTH_HOST="${SWITCHOS_AUTH_HOST}" \
bash "${SCRIPT_DIR}/verify-staging-edge.sh"

echo "PASS: production dependency gate completed"
