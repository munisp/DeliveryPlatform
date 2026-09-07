#!/usr/bin/env bash
set -euo pipefail

: "${ECONOMICS_TEST_ENVIRONMENT:?Set ECONOMICS_TEST_ENVIRONMENT to local or staging}"
: "${ECONOMICS_TEST_DATABASE_URL:?Set ECONOMICS_TEST_DATABASE_URL to a non-production, read-only test connection URL}"
: "${ECONOMICS_TEST_RUNTIME_DATABASE_URL:?Set ECONOMICS_TEST_RUNTIME_DATABASE_URL to the restricted runtime identity test connection URL}"
: "${ECONOMICS_TEST_INTERNAL_SERVICE_TOKEN:?Set a dedicated non-production matching-worker internal token}"

case "${ECONOMICS_TEST_ENVIRONMENT}" in
  local|staging) ;;
  *)
    echo "driver_offer_economics_preflight=FAIL reason=nonproduction_environment_required environment=${ECONOMICS_TEST_ENVIRONMENT}" >&2
    exit 1
    ;;
esac
if [[ "${ECONOMICS_TEST_DATABASE_URL}" =~ (^|[?&])(production|prod)=true($|[&]) ]] || [[ "${ECONOMICS_TEST_DATABASE_URL}" == *"prod"* ]]; then
  echo "driver_offer_economics_preflight=FAIL reason=production_like_database_url_refused" >&2
  exit 1
fi

admin_query() {
  psql "$ECONOMICS_TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -At -c "$1"
}

runtime_query() {
  psql "$ECONOMICS_TEST_RUNTIME_DATABASE_URL" -X -v ON_ERROR_STOP=1 -At -c "$1"
}

expect_exact() {
  local description="$1"
  local expected="$2"
  local query="$3"
  local actual
  actual="$(admin_query "$query")"
  if [[ "$actual" != "$expected" ]]; then
    echo "driver_offer_economics_preflight=FAIL reason=${description} expected=${expected} actual=${actual}" >&2
    exit 1
  fi
}

expect_exact "postgres_version" "t" "SELECT current_setting('server_version_num')::integer >= 160000"
expect_exact "postgis_extension" "t" "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname='postgis')"
expect_exact "pgcrypto_extension" "t" "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname='pgcrypto')"
expect_exact "economics_policy_table" "t" "SELECT to_regclass('mobility.driver_offer_economics_policy') IS NOT NULL"
expect_exact "economics_snapshot_table" "t" "SELECT to_regclass('mobility.driver_offer_economics') IS NOT NULL"
expect_exact "subsidy_disclosure_column" "t" "SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='mobility.driver_offer_disclosure'::regclass AND attname='pickup_subsidy_kobo' AND NOT attisdropped)"
expect_exact "offer_function_signature" "t" "SELECT to_regprocedure('mobility.create_transparent_driver_offer(uuid,uuid,uuid,integer,smallint,numeric,jsonb,timestamp with time zone,integer,integer,integer,timestamp with time zone)') IS NOT NULL"
expect_exact "economics_policy_function_signature" "t" "SELECT to_regprocedure('mobility.set_driver_offer_economics_policy(integer,uuid,text,bigint,bigint,integer,integer,bigint,bigint,bigint,bigint,timestamp with time zone,timestamp with time zone)') IS NOT NULL"
expect_exact "public_execute_revoked" "f" "SELECT COALESCE(bool_or(acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'), false) FROM pg_proc proc CROSS JOIN LATERAL aclexplode(COALESCE(proc.proacl, acldefault('f', proc.proowner))) acl WHERE proc.oid = 'mobility.create_transparent_driver_offer(uuid,uuid,uuid,integer,smallint,numeric,jsonb,timestamp with time zone,integer,integer,integer,timestamp with time zone)'::regprocedure"
expect_exact "public_economics_table_read_revoked" "f" "SELECT COALESCE(bool_or(acl.grantee = 0 AND acl.privilege_type = 'SELECT'), false) FROM pg_class class CROSS JOIN LATERAL aclexplode(COALESCE(class.relacl, acldefault('r', class.relowner))) acl WHERE class.oid = 'mobility.driver_offer_economics'::regclass"

runtime_table_read="$(runtime_query "SELECT has_table_privilege(current_user,'mobility.driver_offer_economics','SELECT')")"
if [[ "$runtime_table_read" != "f" ]]; then
  echo "driver_offer_economics_preflight=FAIL reason=runtime_economics_table_read_must_be_denied actual=${runtime_table_read}" >&2
  exit 1
fi

runtime_function_execute="$(runtime_query "SELECT has_function_privilege(current_user,'mobility.create_transparent_driver_offer(uuid,uuid,uuid,integer,smallint,numeric,jsonb,timestamp with time zone,integer,integer,integer,timestamp with time zone)','EXECUTE')")"
if [[ "$runtime_function_execute" != "t" ]]; then
  echo "driver_offer_economics_preflight=FAIL reason=runtime_offer_function_execute_missing actual=${runtime_function_execute}" >&2
  exit 1
fi

if [[ "${#ECONOMICS_TEST_INTERNAL_SERVICE_TOKEN}" -lt 32 ]]; then
  echo "driver_offer_economics_preflight=FAIL reason=internal_service_token_too_short" >&2
  exit 1
fi

printf '%s\n' \
  "driver_offer_economics_preflight=PASS" \
  "database_contract=verified" \
  "least_privilege=verified" \
  "runtime_identity=verified" \
  "environment=${ECONOMICS_TEST_ENVIRONMENT}" \
  "worker_configuration=DATABASE_URL,REDIS_URL,INTERNAL_SERVICE_TOKEN,MATCH_MIN_LOCATION_INTEGRITY"
