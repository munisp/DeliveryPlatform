#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVICE_DIR="${ROOT_DIR}/services/go/inventory-control"
DB_NAME="journey_inventory_compensation_${$}_$(date +%s)"
PORT="$((18000 + ($$ % 1000)))"
TOKEN="journey-inventory-validation-token-20260908"
WORKFLOW_ID="journey:tenant-001:delivery.warehouse_replenishment:compensation-001"
BIN_PATH="$(mktemp /tmp/switchos-inventory-control.XXXXXX)"
LOG_FILE="${ROOT_DIR}/validation/journey_inventory_compensation_validation_$(date -u +%Y%m%d).txt"
SERVICE_PID=""

cleanup() {
  set +e
  if [[ -n "${SERVICE_PID}" ]]; then
    kill "${SERVICE_PID}" >/dev/null 2>&1 || true
    wait "${SERVICE_PID}" >/dev/null 2>&1 || true
  fi
  rm -f "${BIN_PATH}"
  sudo -u postgres dropdb --if-exists "${DB_NAME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_for_service() {
  for _ in $(seq 1 40); do
    if curl --silent --fail "http://127.0.0.1:${PORT}/health" >/dev/null; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

{
  printf '%s\n' 'journey_inventory_compensation_validation=START'
  sudo -u postgres createdb "${DB_NAME}"
  (
    cd "${SERVICE_DIR}"
    go build -o "${BIN_PATH}" .
  )
  sudo -u postgres env \
    DATABASE_URL="postgresql:///${DB_NAME}?host=/var/run/postgresql&sslmode=disable" \
    INTERNAL_SERVICE_TOKEN="${TOKEN}" \
    BIND_HOST=127.0.0.1 \
    PORT="${PORT}" \
    "${BIN_PATH}" >"${LOG_FILE}.service" 2>&1 &
  SERVICE_PID=$!
  wait_for_service || {
    cat "${LOG_FILE}.service" >&2
    exit 1
  }

  request_response="$(curl --silent --show-error --fail-with-body \
    -X POST "http://127.0.0.1:${PORT}/inventory/replenishment-request" \
    -H "Content-Type: application/json" \
    -H "X-Internal-Service-Token: ${TOKEN}" \
    -H "X-Journey-Workflow-Id: ${WORKFLOW_ID}" \
    --data '{"city":"Lagos","planning_horizon_hours":24,"trigger":"journey_compensation_validation","requested_by":"workflow","workflow_reason":"validate reversible replenishment","approval_mode":"operator_review","skus":[{"sku":"milk-1l","warehouse_id":701,"recommended_units":12,"safety_stock_units":4,"current_available_units":0,"current_inbound_units":0,"lead_time_hours":8,"service_level":0.95,"risk_band":"normal"}]}' )"
  printf 'replenishment_request=%s\n' "${request_response}"
  grep -q '"workflow_id":"'"${WORKFLOW_ID}"'"' <<<"${request_response}"
  grep -q '"status":"queued"' <<<"${request_response}"

  cancellation_response="$(curl --silent --show-error --fail-with-body \
    -X POST "http://127.0.0.1:${PORT}/inventory/replenishment-cancel" \
    -H "Content-Type: application/json" \
    -H "X-Internal-Service-Token: ${TOKEN}" \
    -H "X-Journey-Workflow-Id: ${WORKFLOW_ID}" \
    --data '{"workflow_id":"'"${WORKFLOW_ID}"'","compensation_id":"cmp-journey-validation-001","reason":"journey compensation after a later action failed","original_failure":"route plan failed"}' )"
  printf 'replenishment_cancellation=%s\n' "${cancellation_response}"
  grep -q '"status":"cancelled"' <<<"${cancellation_response}"
  grep -q '"idempotent":false' <<<"${cancellation_response}"

  repeat_response="$(curl --silent --show-error --fail-with-body \
    -X POST "http://127.0.0.1:${PORT}/inventory/replenishment-cancel" \
    -H "Content-Type: application/json" \
    -H "X-Internal-Service-Token: ${TOKEN}" \
    -H "X-Journey-Workflow-Id: ${WORKFLOW_ID}" \
    --data '{"workflow_id":"'"${WORKFLOW_ID}"'","compensation_id":"cmp-journey-validation-001","reason":"journey compensation after a later action failed","original_failure":"route plan failed"}' )"
  printf 'replenishment_cancellation_repeat=%s\n' "${repeat_response}"
  grep -q '\"status\":\"cancelled\"' <<<"${repeat_response}"
  grep -q '\"idempotent\":true' <<<"${repeat_response}"

  conflicting_compensation_status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
    -X POST "http://127.0.0.1:${PORT}/inventory/replenishment-cancel" \
    -H "Content-Type: application/json" \
    -H "X-Internal-Service-Token: ${TOKEN}" \
    -H "X-Journey-Workflow-Id: ${WORKFLOW_ID}" \
    --data '{"workflow_id":"'"${WORKFLOW_ID}"'","compensation_id":"cmp-conflicting-validation-002","reason":"conflicting compensation","original_failure":"route plan failed"}')"
  [[ "${conflicting_compensation_status}" == '409' ]]

  sudo -u postgres psql -XAt -d "${DB_NAME}" -v ON_ERROR_STOP=1 -c "
    SELECT status || '|' || current_step || '|' || count(*) OVER ()
    FROM inventory_workflows
    WHERE workflow_id = '${WORKFLOW_ID}';
  " | grep -qx 'cancelled|replenishment_cancelled|1'
  sudo -u postgres psql -XAt -d "${DB_NAME}" -v ON_ERROR_STOP=1 -c "
    SELECT count(*)
    FROM inventory_workflow_events
    WHERE workflow_id = '${WORKFLOW_ID}';
  " | grep -qx '2'
  sudo -u postgres psql -XAt -d "${DB_NAME}" -v ON_ERROR_STOP=1 -c "
    SELECT count(*) FROM inventory_positions;
  " | grep -qx '0'

  unauthorized_status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
    -X POST "http://127.0.0.1:${PORT}/inventory/replenishment-cancel" \
    -H "Content-Type: application/json" \
    -H "X-Journey-Workflow-Id: ${WORKFLOW_ID}" \
    --data '{"workflow_id":"'"${WORKFLOW_ID}"'","compensation_id":"cmp-journey-validation-001","reason":"invalid request","original_failure":"route plan failed"}')"
  [[ "${unauthorized_status}" == '401' ]]

  printf '%s\n' 'replenishment_bound_to_journey=PASS'
  printf '%s\n' 'replenishment_compensation_idempotent=PASS'
  printf '%s\n' 'replenishment_conflicting_compensation_rejected=PASS'
  printf '%s\n' 'inventory_stock_not_mutated=PASS'
  printf '%s\n' 'inventory_compensation_internal_auth=PASS'
  printf '%s\n' 'journey_inventory_compensation_validation=PASS'
} 2>&1 | tee "${LOG_FILE}"

printf 'validation_log=%s\n' "${LOG_FILE}"
