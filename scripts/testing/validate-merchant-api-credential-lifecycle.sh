#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB_NAME="merchant_credential_lifecycle_${$}_$(date +%s)"
OPERATOR_ROLE="commerce_operator_service"
GATEWAY_ROLE="commerce_gateway_service"
OPERATOR_PASSWORD="$(openssl rand -hex 24)"
GATEWAY_PASSWORD="$(openssl rand -hex 24)"
OPERATOR_URL="postgresql://${OPERATOR_ROLE}:${OPERATOR_PASSWORD}@127.0.0.1:5432/${DB_NAME}?sslmode=disable"
GATEWAY_URL="postgresql://${GATEWAY_ROLE}:${GATEWAY_PASSWORD}@127.0.0.1:5432/${DB_NAME}?sslmode=disable"

cleanup() {
  set +e
  sudo -u postgres dropdb --if-exists "$DB_NAME" >/dev/null 2>&1
  sudo -u postgres psql -X -d postgres -v ON_ERROR_STOP=1 -c "DROP ROLE IF EXISTS ${OPERATOR_ROLE}" >/dev/null 2>&1
  sudo -u postgres psql -X -d postgres -v ON_ERROR_STOP=1 -c "DROP ROLE IF EXISTS ${GATEWAY_ROLE}" >/dev/null 2>&1
}
trap cleanup EXIT
trap 'echo "merchant_credential_lifecycle_result=FAIL shell_line=${LINENO}" >&2' ERR

if [[ "${ALLOW_MERCHANT_CREDENTIAL_LIFECYCLE_TEST:-}" != "I_UNDERSTAND_THIS_CREATES_A_DISPOSABLE_LOCAL_DATABASE" ]]; then
  echo "merchant_credential_lifecycle_result=REFUSED reason=explicit_local_test_acknowledgement_required" >&2
  exit 2
fi
sudo -n -u postgres true >/dev/null 2>&1 || {
  echo "merchant_credential_lifecycle_result=REFUSED reason=local_postgres_superuser_access_required" >&2
  exit 2
}

sudo -u postgres psql -X -d postgres -v ON_ERROR_STOP=1 <<SQL
DROP ROLE IF EXISTS ${OPERATOR_ROLE};
DROP ROLE IF EXISTS ${GATEWAY_ROLE};
CREATE ROLE ${OPERATOR_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${OPERATOR_PASSWORD}';
CREATE ROLE ${GATEWAY_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${GATEWAY_PASSWORD}';
SQL
sudo -u postgres createdb "$DB_NAME"

sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL'
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA verification;
CREATE TYPE verification.case_state AS ENUM ('pending','verified','rejected');
CREATE TABLE verification.verification_case (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), state verification.case_state NOT NULL);
CREATE TABLE public.users (id integer PRIMARY KEY, open_id text UNIQUE, role text NOT NULL);
CREATE TABLE public.service_providers (id integer PRIMARY KEY, name text NOT NULL DEFAULT 'test merchant');
CREATE TABLE public.drivers (id integer PRIMARY KEY, open_id text);
CREATE TABLE public.orders (id integer PRIMARY KEY, customer_id integer REFERENCES public.users(id), provider_id integer REFERENCES public.service_providers(id), driver_id integer REFERENCES public.drivers(id));
CREATE TABLE public.delivery_tracking_events (id bigserial PRIMARY KEY, delivery_id text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(), latitude numeric(9,6) NOT NULL, longitude numeric(9,6) NOT NULL, accuracy_meters numeric(8,2));
INSERT INTO public.users(id,open_id,role) VALUES (1,'merchant-owner','merchant'),(2,'other-user','merchant');
INSERT INTO public.service_providers(id,name) VALUES (101,'Merchant Test Provider');
SQL

sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 < "$ROOT_DIR/drizzle/0064_merchant_commerce_portal.sql" >/dev/null
sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 < "$ROOT_DIR/drizzle/0066_realtime_tracking_offline_sync_tenant_api.sql" >/dev/null
sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 < "$ROOT_DIR/drizzle/0067_merchant_api_credential_lifecycle.sql" >/dev/null
sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO commerce.merchant_portal(provider_id,owner_user_id,state,legal_name,display_name,medusa_store_id,activated_at)
VALUES (101,1,'active','Merchant Test Legal','Merchant Test','merchant-test-store',clock_timestamp());
INSERT INTO commerce.merchant_user_access(provider_id,user_id,role,active,granted_by_user_id)
VALUES (101,1,'owner',true,1);
SQL

operator_sql() { PGPASSWORD="$OPERATOR_PASSWORD" psql -X "$OPERATOR_URL" -v ON_ERROR_STOP=1 -Atqc "$1"; }
gateway_sql() { PGPASSWORD="$GATEWAY_PASSWORD" psql -X "$GATEWAY_URL" -v ON_ERROR_STOP=1 -Atqc "$1"; }
expect_denied() {
  local label="$1" command="$2"
  if bash -c "$command" >/tmp/merchant-credential-denied.out 2>&1; then
    echo "merchant_credential_lifecycle_result=FAIL scenario=${label} reason=unexpected_success" >&2
    cat /tmp/merchant-credential-denied.out >&2
    exit 1
  fi
  grep -q '42501\|permission denied\|merchant credential denied' /tmp/merchant-credential-denied.out || {
    echo "merchant_credential_lifecycle_result=FAIL scenario=${label} reason=wrong_error" >&2
    cat /tmp/merchant-credential-denied.out >&2
    exit 1
  }
}

DIGEST_A="decode(repeat('a',64),'hex')"
DIGEST_B="decode(repeat('b',64),'hex')"
NOW="'2026-09-09T12:00:00Z'::timestamptz"
operator_sql "SELECT commerce.issue_merchant_api_credential(1,101,'merchant-key-alpha',${DIGEST_A},ARRAY['catalog:write','inventory:write'],${NOW}+interval '30 days',${NOW});" >/dev/null
echo "merchant_credential_lifecycle_checkpoint=issued_alpha"
if ! VERIFY_ALPHA="$(gateway_sql "SELECT provider_id FROM commerce.verify_merchant_api_credential('merchant-key-alpha',${DIGEST_A},'catalog:write',${NOW});" 2>&1)"; then echo "merchant_credential_lifecycle_result=FAIL scenario=issue_verify error=${VERIFY_ALPHA}" >&2; exit 1; fi
[[ "$VERIFY_ALPHA" == "101" ]] || { echo "merchant_credential_lifecycle_result=FAIL scenario=issue_verify actual=${VERIFY_ALPHA:-empty}" >&2; exit 1; }
echo "merchant_credential_lifecycle_checkpoint=verified_alpha"
expect_denied scope_denial "PGPASSWORD='${GATEWAY_PASSWORD}' psql -X '${GATEWAY_URL}' -v ON_ERROR_STOP=1 -Atqc \"SELECT * FROM commerce.verify_merchant_api_credential('merchant-key-alpha',${DIGEST_A},'tracking:read',${NOW});\""
expect_denied secret_nondisclosure "PGPASSWORD='${GATEWAY_PASSWORD}' psql -X '${GATEWAY_URL}' -v ON_ERROR_STOP=1 -Atqc \"SELECT secret_sha256 FROM commerce.merchant_api_credential;\""

operator_sql "SELECT commerce.issue_merchant_api_credential(1,101,'merchant-key-beta',${DIGEST_B},ARRAY['catalog:write'],${NOW}+interval '30 days',${NOW});" >/dev/null
echo "merchant_credential_lifecycle_checkpoint=issued_beta"
operator_sql "SELECT commerce.revoke_merchant_api_credential(1,101,'merchant-key-alpha',${NOW}+interval '1 minute');" >/dev/null
echo "merchant_credential_lifecycle_checkpoint=revoked_alpha"
expect_denied revoked_key "PGPASSWORD='${GATEWAY_PASSWORD}' psql -X '${GATEWAY_URL}' -v ON_ERROR_STOP=1 -Atqc \"SELECT * FROM commerce.verify_merchant_api_credential('merchant-key-alpha',${DIGEST_A},'catalog:write',${NOW}+interval '2 minutes');\""
if ! VERIFY_BETA="$(gateway_sql "SELECT provider_id FROM commerce.verify_merchant_api_credential('merchant-key-beta',${DIGEST_B},'catalog:write',${NOW}+interval '2 minutes');" 2>&1)"; then echo "merchant_credential_lifecycle_result=FAIL scenario=rotation_verify error=${VERIFY_BETA}" >&2; exit 1; fi
[[ "$VERIFY_BETA" == "101" ]] || { echo "merchant_credential_lifecycle_result=FAIL scenario=rotation_verify actual=${VERIFY_BETA:-empty}" >&2; exit 1; }

operator_sql "SELECT commerce.issue_merchant_api_credential(1,101,'merchant-key-expired',${DIGEST_A},ARRAY['catalog:write'],${NOW}+interval '2 hours',${NOW});" >/dev/null
EXPIRED_RESULT="$(gateway_sql "SELECT provider_id FROM commerce.verify_merchant_api_credential('merchant-key-expired',${DIGEST_A},'catalog:write',${NOW}+interval '3 hours');")"
[[ -z "$EXPIRED_RESULT" ]] || { echo "merchant_credential_lifecycle_result=FAIL scenario=expired_key_authorized" >&2; exit 1; }
sudo -u postgres psql -X -d "$DB_NAME" -Atqc "SELECT state FROM commerce.merchant_api_credential WHERE key_id='merchant-key-expired';" | grep -qx 'expired'

AUDIT_COUNT=$(sudo -u postgres psql -X -d "$DB_NAME" -Atqc "SELECT count(*) FROM commerce.merchant_portal_audit_event WHERE provider_id=101 AND event_type IN ('merchant.api_credential.issued','merchant.api_credential.revoked');")
[[ "$AUDIT_COUNT" -ge 4 ]] || { echo "merchant_credential_lifecycle_result=FAIL scenario=audit_count" >&2; exit 1; }
echo "merchant_credential_lifecycle_result=PASS database=${DB_NAME} scenarios=issue,verify,scope_denial,secret_nondisclosure,rotation_revocation,expiry,audit"
