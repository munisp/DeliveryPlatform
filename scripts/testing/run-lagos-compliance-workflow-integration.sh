#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DATABASE="lagos_compliance_workflow_integration"
ROLE="lagos_compliance_integration"
PASSWORD="lagos-compliance-integration-password"
SERVICE_PORT=8125
PROVIDER_PORT=8135
TOKEN="0123456789abcdef0123456789abcdef0123456789abcdef"
PROVIDER_SECRET="compliance-provider-integration-secret-0123456789abcdef"
OUT_DIR="$ROOT/validation/lagos_compliance_workflow_integration_20260903"
SERVICE_DIR="$ROOT/services/python/compliance-review"
CERT_DIR="/tmp/lagos-compliance-provider-cert"

cleanup() {
  for pid in "${SERVICE_PID:-}" "${PROVIDER_PID:-}"; do
    if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
  done
  sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DATABASE}' AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true
  sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS ${DATABASE};" >/dev/null 2>&1 || true
  sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "DROP ROLE IF EXISTS ${ROLE};" >/dev/null 2>&1 || true
  rm -rf "$CERT_DIR" /tmp/lagos_compliance_0026.sql /tmp/lagos_compliance_0031.sql /tmp/lagos_compliance_0032.sql
}
trap cleanup EXIT

cleanup
rm -rf "$OUT_DIR" "$CERT_DIR"
mkdir -p "$OUT_DIR" "$CERT_DIR"
sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE ${ROLE} LOGIN PASSWORD '${PASSWORD}';"
sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${DATABASE} OWNER ${ROLE};"
cp "$ROOT/drizzle/0026_ride_hailing_dispatch.sql" /tmp/lagos_compliance_0026.sql
cp "$ROOT/drizzle/0031_lagos_compliance_verification.sql" /tmp/lagos_compliance_0031.sql
cp "$ROOT/drizzle/0032_compliance_presence_state.sql" /tmp/lagos_compliance_0032.sql
chmod 0644 /tmp/lagos_compliance_00*.sql
sudo -u postgres psql -d "$DATABASE" -v ON_ERROR_STOP=1 <<SQL
CREATE TABLE public.users (id serial PRIMARY KEY, open_id varchar(64) NOT NULL UNIQUE);
INSERT INTO public.users (id, open_id) VALUES (1,'compliance-reviewer'), (101,'lagos-driver-101');
\i /tmp/lagos_compliance_0026.sql
\i /tmp/lagos_compliance_0031.sql
\i /tmp/lagos_compliance_0032.sql
GRANT USAGE ON SCHEMA mobility TO ${ROLE};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA mobility TO ${ROLE};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mobility TO ${ROLE};
INSERT INTO mobility.driver_profile (user_id, legal_name, display_name, account_state, safety_state, payout_state) VALUES (101,'Integration Driver','Integration Driver','pending','clear','verified');
INSERT INTO mobility.vehicle (id, driver_user_id, registration_number, make, model, manufacture_year, colour, passenger_capacity, vehicle_class, active) VALUES ('f1000000-0000-4000-8000-000000000101',101,'LAG-INTEGRATION-101','Test','Vehicle',2024,'Blue',4,'beta_standard',true);
INSERT INTO mobility.driver_presence (driver_user_id, state, integrity_score) VALUES (101,'pending_compliance',100);
SQL
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$CERT_DIR/key.pem" -out "$CERT_DIR/cert.pem" -days 1 -subj '/CN=127.0.0.1' -addext 'subjectAltName=IP:127.0.0.1' >"$OUT_DIR/openssl.log" 2>&1
PYTHONUNBUFFERED=1 FIXTURE_PROVIDER_HMAC_SECRET="$PROVIDER_SECRET" TLS_CERT="$CERT_DIR/cert.pem" TLS_KEY="$CERT_DIR/key.pem" PORT="$PROVIDER_PORT" python3 "$SERVICE_DIR/verification_provider_fixture.py" >"$OUT_DIR/provider.log" 2>&1 &
PROVIDER_PID=$!
PYTHONUNBUFFERED=1 DATABASE_URL="postgresql://${ROLE}:${PASSWORD}@127.0.0.1:5432/${DATABASE}?sslmode=disable" INTERNAL_SERVICE_TOKEN="$TOKEN" COMPLIANCE_PROVIDER_NAME="integration-approved-verifier" COMPLIANCE_PROVIDER_VERIFY_URL="https://127.0.0.1:${PROVIDER_PORT}/evidence/verify" COMPLIANCE_PROVIDER_HMAC_SECRET="$PROVIDER_SECRET" COMPLIANCE_PROVIDER_CA_FILE="$CERT_DIR/cert.pem" BIND_HOST=127.0.0.1 PORT="$SERVICE_PORT" PYTHONPATH="$ROOT/services/python" python3 "$SERVICE_DIR/main.py" >"$OUT_DIR/compliance-review.log" 2>&1 &
SERVICE_PID=$!
for _ in $(seq 1 40); do
  curl --silent --fail "http://127.0.0.1:${SERVICE_PORT}/health" >/dev/null && break
  sleep 1
done
curl --silent --fail "http://127.0.0.1:${SERVICE_PORT}/health" >/dev/null
COMPLIANCE_URL="http://127.0.0.1:${SERVICE_PORT}" INTERNAL_SERVICE_TOKEN="$TOKEN" OUTPUT_PATH="$OUT_DIR/workflow_result.json" node "$SERVICE_DIR/run_integration_workflow.mjs" >"$OUT_DIR/workflow_stdout.json"
sudo -u postgres psql -d "$DATABASE" -v ON_ERROR_STOP=1 -c "UPDATE mobility.compliance_evidence SET expires_at=NOW()-INTERVAL '1 second' WHERE subject_kind='vehicle' AND evidence_type='roadworthiness';" >/dev/null
curl --silent --show-error --fail -X POST -H "x-internal-service-token: $TOKEN" "http://127.0.0.1:${SERVICE_PORT}/reconcile-expiry" >"$OUT_DIR/expiry_result.json"
curl --silent --show-error --fail -H "x-internal-service-token: $TOKEN" "http://127.0.0.1:${SERVICE_PORT}/drivers/101/eligibility" >"$OUT_DIR/eligibility_after_expiry.json"
node -e "const fs=require('fs'); const r=JSON.parse(fs.readFileSync('$OUT_DIR/workflow_result.json')); const e=JSON.parse(fs.readFileSync('$OUT_DIR/eligibility_after_expiry.json')); if(!r.passed || !r.eligibility_before_expiry.eligible || e.eligible || e.presence_state!=='compliance_suspended') process.exit(1); const out={passed:true,evidence_count:r.evidence_count,eligible_before_expiry:r.eligibility_before_expiry.eligible,eligible_after_expiry:e.eligible,presence_after_expiry:e.presence_state}; fs.writeFileSync('$OUT_DIR/summary.json',JSON.stringify(out,null,2)+'\\n');"
