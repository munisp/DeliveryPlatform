#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
out="$root/validation/telematics_device_integrity_integration_20260903"
rm -rf "$out"; mkdir -p "$out"
db="telematics_integrity_test"; role="telematics_integrity_test"; port=8131; redis_port=6382; token="telematics-integrity-token-0123456789"
cleanup() { [[ -n "${worker_pid:-}" ]] && kill -- -"$worker_pid" 2>/dev/null || true; [[ -n "${redis_pid:-}" ]] && kill "$redis_pid" 2>/dev/null || true; }
trap cleanup EXIT
sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS ${db} WITH (FORCE)" >/dev/null
sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "DROP ROLE IF EXISTS ${role}" >/dev/null
sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE ${role} LOGIN PASSWORD '${role}_password'" >/dev/null
sudo -u postgres createdb -O "$role" "$db"
sudo -u postgres psql -d "$db" -v ON_ERROR_STOP=1 -c "CREATE EXTENSION postgis; CREATE EXTENSION pgcrypto; CREATE TABLE users(id integer PRIMARY KEY); INSERT INTO users VALUES(701);" >/dev/null
migration_dir="/tmp/telematics-migrations-${db}"; rm -rf "$migration_dir"; mkdir -p "$migration_dir"
for migration in 0026_ride_hailing_dispatch.sql 0027_h3_dispatch_spatial_index.sql 0029_driver_location_event_stream.sql 0036_telematics_device_integrity.sql; do cp "$root/drizzle/$migration" "$migration_dir/$migration"; chmod 644 "$migration_dir/$migration"; sudo -u postgres psql -d "$db" -v ON_ERROR_STOP=1 -f "$migration_dir/$migration" >/dev/null; done
sudo -u postgres psql -d "$db" -v ON_ERROR_STOP=1 -c "GRANT USAGE ON SCHEMA mobility, telematics TO ${role}; GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA mobility, telematics TO ${role};" >/dev/null
redis-server --port "$redis_port" --save '' --appendonly no >"$out/redis.log" 2>&1 & redis_pid=$!
for _ in {1..50}; do redis-cli -p "$redis_port" ping >/dev/null 2>&1 && break; sleep 0.1; done
(
  cd "$root/services/go/ride-matching-worker"
  export DATABASE_URL="postgres://${role}:${role}_password@127.0.0.1:5432/${db}?sslmode=disable" REDIS_URL="redis://127.0.0.1:${redis_port}/0" INTERNAL_SERVICE_TOKEN="$token" PORT="$port" BIND_HOST=127.0.0.1 MATCH_REQUIRE_DEVICE_INTEGRITY=true
  exec setsid go run .
) >"$out/worker.log" 2>&1 & worker_pid=$!
for _ in {1..100}; do curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1 && break; sleep 0.2; done
curl -fsS -X POST "http://127.0.0.1:$port/telematics/devices" -H "content-type: application/json" -H "x-internal-service-token: $token" --data '{"driver_user_id":701,"device_public_id":"aaaa1111-1111-4111-8111-111111111111","device_fingerprint":"test-device-fingerprint-value-701","attestation_id":"attestation-proof-701-valid","attestation_state":"verified","attestation_provider":"isolated-verifier","attestation_expires_at":"2030-01-01T00:00:00Z"}' >"$out/device.json"
curl -fsS -X POST "http://127.0.0.1:$port/telematics/location-consents" -H "content-type: application/json" -H "x-internal-service-token: $token" --data '{"driver_user_id":701,"device_public_id":"aaaa1111-1111-4111-8111-111111111111","consent_version":"lagos-location-v1","state":"granted","evidence_ref":"s3://isolated-evidence/driver-701/location-consent-v1"}' >"$out/granted.json"
sudo -u postgres psql -d "$db" -v ON_ERROR_STOP=1 -c "INSERT INTO mobility.driver_profile(user_id,legal_name,display_name,account_state,safety_state,payout_state) VALUES (701,'Integration Driver','Integration Driver','active','clear','verified'); INSERT INTO mobility.driver_presence(driver_user_id,state,last_point,last_location_at,location_valid_until,accuracy_m,integrity_score,version,updated_at) VALUES (701,'available',ST_SetSRID(ST_MakePoint(3.395,6.455),4326)::geography,NOW(),NOW()+INTERVAL '5 minutes',5,98,1,NOW())" >/dev/null
now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
status=$(curl -sS -o "$out/accepted.json" -w '%{http_code}' -X POST "http://127.0.0.1:$port/events/driver-location" -H "content-type: application/json" -H "x-internal-service-token: $token" --data "{\"driver_user_id\":701,\"device_session_id\":\"bbbb1111-1111-4111-8111-111111111111\",\"device_public_id\":\"aaaa1111-1111-4111-8111-111111111111\",\"attestation_id\":\"attestation-proof-701-valid\",\"source_sequence\":1,\"occurred_at\":\"$now\",\"latitude\":6.455,\"longitude\":3.395,\"accuracy_m\":5,\"integrity_score\":98}")
[[ "$status" == 202 ]]
status=$(curl -sS -o "$out/low_integrity.json" -w '%{http_code}' -X POST "http://127.0.0.1:$port/events/driver-location" -H "content-type: application/json" -H "x-internal-service-token: $token" --data "{\"driver_user_id\":701,\"device_session_id\":\"bbbb1111-1111-4111-8111-111111111111\",\"device_public_id\":\"aaaa1111-1111-4111-8111-111111111111\",\"attestation_id\":\"attestation-proof-701-valid\",\"source_sequence\":2,\"occurred_at\":\"$now\",\"latitude\":6.456,\"longitude\":3.396,\"accuracy_m\":5,\"integrity_score\":10}")
[[ "$status" == 422 ]]
status=$(curl -sS -o "$out/attestation_mismatch.json" -w '%{http_code}' -X POST "http://127.0.0.1:$port/events/driver-location" -H "content-type: application/json" -H "x-internal-service-token: $token" --data "{\"driver_user_id\":701,\"device_session_id\":\"bbbb1111-1111-4111-8111-111111111111\",\"device_public_id\":\"aaaa1111-1111-4111-8111-111111111111\",\"attestation_id\":\"attestation-proof-701-mismatch\",\"source_sequence\":3,\"occurred_at\":\"$now\",\"latitude\":6.456,\"longitude\":3.396,\"accuracy_m\":5,\"integrity_score\":98}")
[[ "$status" == 403 ]]
curl -fsS -X POST "http://127.0.0.1:$port/telematics/location-consents" -H "content-type: application/json" -H "x-internal-service-token: $token" --data '{"driver_user_id":701,"device_public_id":"aaaa1111-1111-4111-8111-111111111111","consent_version":"lagos-location-v1","state":"withdrawn","evidence_ref":"s3://isolated-evidence/driver-701/location-consent-withdrawn"}' >"$out/withdrawn.json"
status=$(curl -sS -o "$out/rejected.json" -w '%{http_code}' -X POST "http://127.0.0.1:$port/events/driver-location" -H "content-type: application/json" -H "x-internal-service-token: $token" --data "{\"driver_user_id\":701,\"device_session_id\":\"bbbb1111-1111-4111-8111-111111111111\",\"device_public_id\":\"aaaa1111-1111-4111-8111-111111111111\",\"attestation_id\":\"attestation-proof-701-valid\",\"source_sequence\":4,\"occurred_at\":\"$now\",\"latitude\":6.456,\"longitude\":3.396,\"accuracy_m\":5,\"integrity_score\":98}")
[[ "$status" == 403 ]]
future="$(date -u -d '+5 minutes' +%Y-%m-%dT%H:%M:%SZ)"
status=$(curl -sS -o "$out/future_timestamp.json" -w '%{http_code}' -X POST "http://127.0.0.1:$port/events/driver-location" -H "content-type: application/json" -H "x-internal-service-token: $token" --data "{\"driver_user_id\":701,\"device_session_id\":\"bbbb1111-1111-4111-8111-111111111111\",\"device_public_id\":\"aaaa1111-1111-4111-8111-111111111111\",\"attestation_id\":\"attestation-proof-701-valid\",\"source_sequence\":5,\"occurred_at\":\"$future\",\"latitude\":6.456,\"longitude\":3.396,\"accuracy_m\":5,\"integrity_score\":98}")
[[ "$status" == 400 ]]
events=$(sudo -u postgres psql -d "$db" -Atc "SELECT count(*) FROM mobility.driver_location_event WHERE driver_user_id=701")
[[ "$events" == 1 ]]
printf 'device_registration=201\nconsented_location=202\nlow_integrity_location=422\nattestation_mismatch_location=403\nwithdrawn_location=403\nfuture_timestamp_location=400\ndurable_events=%s\n' "$events" >"$out/summary.txt"
