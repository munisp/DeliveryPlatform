#!/usr/bin/env bash
set -euo pipefail

# Controlled mock execution only. This proves the verifier's pass/fail wiring,
# not PostgreSQL/Redis/Temporal/Kafka/Fluvio production semantics.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERT_DIR="${ROOT_DIR}/.mock-production-gate-certs"
MOCK_BIN="${ROOT_DIR}/.mock-production-gate-bin"
COMPOSE_FILE="${ROOT_DIR}/deploy/testing/docker-compose.production-gate-mock.yml"

cleanup() {
  docker compose -f "${COMPOSE_FILE}" down --remove-orphans >/dev/null 2>&1 || true
  rm -rf "${MOCK_BIN}" "${CERT_DIR}"
}
trap cleanup EXIT

command -v docker >/dev/null 2>&1 || { echo "Docker is required" >&2; exit 2; }
command -v openssl >/dev/null 2>&1 || { echo "openssl is required" >&2; exit 2; }

mkdir -p "${CERT_DIR}" "${MOCK_BIN}"
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 1 \
  -keyout "${CERT_DIR}/key.pem" -out "${CERT_DIR}/cert.pem" \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost" >/dev/null 2>&1

cat > "${MOCK_BIN}/psql" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == *"sslmode=require"* ]] || { echo "missing TLS requirement" >&2; exit 1; }
echo " postgres_ready"
EOF
cat > "${MOCK_BIN}/redis-cli" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo PONG
EOF
chmod +x "${MOCK_BIN}/psql" "${MOCK_BIN}/redis-cli"

docker compose -f "${COMPOSE_FILE}" up -d --wait
sleep 2

COMMON_ENV=(
  "PATH=${MOCK_BIN}:${PATH}"
  "CURL_CA_BUNDLE=${CERT_DIR}/cert.pem"
  "SWITCHOS_PUBLIC_HOST=localhost"
  "SWITCHOS_AUTH_HOST=localhost"
  "POSTGRES_HOST=mock-postgres"
  "POSTGRES_PORT=5432"
  "POSTGRES_DB=switchos"
  "POSTGRES_USER=switchos"
  "POSTGRES_PASSWORD=mock-password"
  "REDIS_URL=redis://:mock-password@mock-redis:6379"
  "TEMPORAL_ADDRESS=127.0.0.1:7233"
  "KAFKA_BROKERS=127.0.0.1:9092"
  "FLUVIO_KAFKA_BROKERS=127.0.0.1:9093"
)

echo "Running controlled passing mode..."
env "${COMMON_ENV[@]}" "${ROOT_DIR}/scripts/verify-production-dependencies.sh"

echo "Running controlled failing mode (Kafka unavailable)..."
set +e
env "${COMMON_ENV[@]}" "KAFKA_BROKERS=127.0.0.1:65530" "${ROOT_DIR}/scripts/verify-production-dependencies.sh" >/tmp/mock-gate-failure.log 2>&1
failure_status=$?
set -e
if [[ ${failure_status} -eq 0 ]]; then
  echo "FAILED: production gate accepted an unavailable Kafka broker" >&2
  exit 1
fi
grep -q "Kafka broker 127.0.0.1:65530 is unreachable" /tmp/mock-gate-failure.log || {
  cat /tmp/mock-gate-failure.log >&2
  echo "FAILED: expected Kafka fail-closed evidence was not recorded" >&2
  exit 1
}

echo "PASS: controlled mock production gate passed healthy mode and rejected unavailable Kafka"
