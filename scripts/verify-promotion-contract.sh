#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: verify-promotion-contract.sh [--contract-only]

Validates a component-rich, non-production promotion environment. It fails closed
on missing variables, placeholder values, insecure database configuration, wrong
OIDC issuer metadata, or unreachable required endpoints. --contract-only verifies
configuration shape without opening network connections.
EOF
}

contract_only=false
case "${1:-}" in
  "") ;;
  --contract-only) contract_only=true ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 64 ;;
esac

required_vars=(
  PROMOTION_ENVIRONMENT SWITCHOS_PUBLIC_HOST SWITCHOS_AUTH_HOST KEYCLOAK_ISSUER
  POSTGRES_HOST POSTGRES_PORT POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD REDIS_URL
  TEMPORAL_ADDRESS KAFKA_BROKERS FLUVIO_KAFKA_BROKERS TIGERBEETLE_ADDRESSES
  TIGERBEETLE_CLUSTER_ID TIGERBEETLE_ACCOUNT_MAP_JSON PERMIFY_ENDPOINT
  PERMIFY_AUTH_TOKEN INTERNAL_SERVICE_TOKEN NOTIFICATION_DISPATCHER_URL
)

for variable in "${required_vars[@]}"; do
  value="${!variable:-}"
  if [[ -z "${value}" || "${value}" =~ (CHANGEME|REPLACE|PLACEHOLDER|example\.com|localhost) ]]; then
    echo "FAILED: ${variable} is missing or contains an unsafe placeholder" >&2
    exit 2
  fi
done

if [[ "${PROMOTION_ENVIRONMENT}" != "staging" && "${PROMOTION_ENVIRONMENT}" != "production" ]]; then
  echo "FAILED: PROMOTION_ENVIRONMENT must be staging or production" >&2
  exit 2
fi

if [[ "${REDIS_URL}" != rediss://* ]]; then
  echo "FAILED: REDIS_URL must use rediss:// for a promotion environment" >&2
  exit 2
fi

if [[ "${POSTGRES_PORT}" != +([0-9]) ]] 2>/dev/null; then
  echo "FAILED: POSTGRES_PORT must be numeric" >&2
  exit 2
fi

if [[ "${PROMOTION_ENVIRONMENT}" == "staging" && -z "${STAGING_MAILPIT_API_URL:-}" ]]; then
  echo "FAILED: STAGING_MAILPIT_API_URL is required for staging mailbox verification" >&2
  exit 2
fi

echo "PASS: promotion configuration contract is complete and non-placeholder"
[[ "${contract_only}" == true ]] && exit 0

for command in curl nc psql redis-cli; do
  command -v "${command}" >/dev/null 2>&1 || { echo "FAILED: ${command} is required" >&2; exit 2; }
done

PGPASSWORD="${POSTGRES_PASSWORD}" psql "host=${POSTGRES_HOST} port=${POSTGRES_PORT} dbname=${POSTGRES_DB} user=${POSTGRES_USER} sslmode=require connect_timeout=10" -v ON_ERROR_STOP=1 -c 'SELECT 1' >/dev/null
echo "PASS: PostgreSQL TLS connection"

[[ "$(redis-cli -u "${REDIS_URL}" --no-auth-warning PING)" == "PONG" ]] || { echo "FAILED: Redis TLS health check" >&2; exit 1; }
echo "PASS: Redis TLS connection"

probe_addresses() {
  local label="$1" addresses="$2" entry host port
  IFS=',' read -r -a entries <<< "${addresses}"
  for entry in "${entries[@]}"; do
    host="${entry%:*}"; port="${entry##*:}"
    nc -z -w 10 "${host}" "${port}" || { echo "FAILED: ${label} endpoint ${entry} is unreachable" >&2; exit 1; }
  done
  echo "PASS: ${label} endpoints"
}

probe_addresses "Temporal" "${TEMPORAL_ADDRESS}"
probe_addresses "Kafka" "${KAFKA_BROKERS}"
probe_addresses "Fluvio" "${FLUVIO_KAFKA_BROKERS}"
probe_addresses "TigerBeetle" "${TIGERBEETLE_ADDRESSES}"

issuer_document="$(curl --fail --silent --show-error --max-time 15 "${KEYCLOAK_ISSUER%/}/.well-known/openid-configuration")"
issuer_value="$(printf '%s' "${issuer_document}" | sed -n 's/.*"issuer"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
[[ "${issuer_value}" == "${KEYCLOAK_ISSUER}" ]] || { echo "FAILED: OIDC discovery issuer mismatch" >&2; exit 1; }
echo "PASS: OIDC discovery issuer"

curl --fail --silent --show-error --max-time 15 "https://${SWITCHOS_PUBLIC_HOST}/health" >/dev/null
curl --fail --silent --show-error --max-time 15 "${PERMIFY_ENDPOINT%/}/healthz" >/dev/null
echo "PASS: public edge and Permify health checks"

if [[ "${PROMOTION_ENVIRONMENT}" == "staging" ]]; then
  curl --fail --silent --show-error --max-time 15 "${STAGING_MAILPIT_API_URL%/}/api/v1/messages?limit=1" >/dev/null
  echo "PASS: staging Mailpit API reachability"
fi

echo "PASS: promotion environment dependency verification completed"
