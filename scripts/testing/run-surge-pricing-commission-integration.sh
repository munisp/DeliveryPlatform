#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DATABASE="surge_pricing_commission_test"
ROLE="surge_pricing_commission_test"
PASSWORD="surge-pricing-commission-test-password"
PORT="8141"
TOKEN="surge-pricing-integration-token-must-be-32-characters"
OUT_DIR="$ROOT/validation/surge_pricing_commission_integration_20260903"
PID=""

cleanup() {
  if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
    kill -- -"$PID" 2>/dev/null || kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  fuser -k "${PORT}/tcp" 2>/dev/null || true
}
trap cleanup EXIT

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS ${DATABASE};"
sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "DROP ROLE IF EXISTS ${ROLE};"
sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE ${ROLE} LOGIN PASSWORD '${PASSWORD}';"
sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${DATABASE} OWNER ${ROLE};"

cp "$ROOT/drizzle/0026_ride_hailing_dispatch.sql" /tmp/surge_0026.sql
cp "$ROOT/drizzle/0033_surge_pricing_commission.sql" /tmp/surge_0033.sql
chmod 0644 /tmp/surge_0026.sql /tmp/surge_0033.sql
sudo -u postgres psql -d "$DATABASE" -v ON_ERROR_STOP=1 <<SQL
CREATE TABLE public.users (id serial PRIMARY KEY, open_id varchar(64) NOT NULL UNIQUE);
\i /tmp/surge_0026.sql
\i /tmp/surge_0033.sql
GRANT USAGE ON SCHEMA mobility, pricing TO ${ROLE};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA mobility, pricing TO ${ROLE};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mobility, pricing TO ${ROLE};
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA mobility, pricing TO ${ROLE};
GRANT SELECT, INSERT, UPDATE, DELETE ON public.users TO ${ROLE};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ROLE};

INSERT INTO public.users (id, open_id) VALUES (98001, 'surge-rider'), (98002, 'surge-driver');
INSERT INTO mobility.service_zone (id, city_code, zone_code, version, display_name, boundary, active, dispatch_enabled, policy_version, effective_from)
VALUES ('20000000-0000-0000-0000-000000000001','LAG','surge-zone',1,'Surge Zone',ST_Multi(ST_GeomFromText('POLYGON((3.30 6.45,3.50 6.45,3.50 6.60,3.30 6.60,3.30 6.45))',4326)),true,true,'beta-v1',NOW());
INSERT INTO mobility.driver_profile (user_id, legal_name, display_name, account_state, safety_state, payout_state) VALUES (98002,'Surge Driver','Surge Driver','active','clear','verified');
INSERT INTO mobility.vehicle (id, driver_user_id, registration_number, make, model, manufacture_year, colour, passenger_capacity, vehicle_class, active)
VALUES ('20000000-0000-0000-0000-000000000002',98002,'SRG-98002','Test','Car',2024,'Blue',4,'beta_standard',true);
INSERT INTO mobility.driver_eligibility (driver_user_id, active_vehicle_id, eligible, eligible_until, policy_version)
VALUES (98002,'20000000-0000-0000-0000-000000000002',true,NOW()+INTERVAL '1 day','beta-v1');
INSERT INTO mobility.fare_rule_version (id, zone_id, version, base_kobo, per_km_kobo, per_minute_kobo, minimum_kobo, cancellation_kobo, demand_cap_basis_points, effective_from)
VALUES ('20000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000001','beta-v1',1000,200,50,1000,500,15000,NOW());
INSERT INTO mobility.fare_quote (id, rider_user_id, zone_id, fare_rule_id, route_provider, route_provider_version, quoted_distance_m, quoted_duration_s, base_kobo, distance_kobo, time_kobo, demand_kobo, taxes_and_fees_kobo, total_kobo, disclosure_version, calculation, expires_at)
VALUES ('20000000-0000-0000-0000-000000000004',98001,'20000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000003','test','v1',1000,300,1000,200,50,0,0,1250,'beta-v1','{}',NOW()+INTERVAL '5 minutes');
INSERT INTO mobility.ride_trip (id, rider_user_id, state, zone_id, fare_quote_id, pickup, destination, pickup_address, destination_address, requested_at)
VALUES ('20000000-0000-0000-0000-000000000005',98001,'requested','20000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000004',ST_SetSRID(ST_MakePoint(3.3792,6.5244),4326)::geography,ST_SetSRID(ST_MakePoint(3.4000,6.5400),4326)::geography,'Pickup','Destination',NOW());
INSERT INTO pricing.surge_policy (id, city_code, zone_id, policy_version, effective_from, demand_supply_target_bps, max_surge_bps, max_surge_step_bps, base_commission_bps, surge_commission_relief_bps, minimum_driver_earnings_kobo, tax_bps, provider_fee_bps)
VALUES ('20000000-0000-0000-0000-000000000006','LAG','20000000-0000-0000-0000-000000000001','lag-v1',NOW()-INTERVAL '1 minute',10000,18000,4000,2000,1000,6000,500,200);
SQL

export DATABASE_URL="postgresql://${ROLE}:${PASSWORD}@127.0.0.1:5432/${DATABASE}?sslmode=disable"
export INTERNAL_SERVICE_TOKEN="$TOKEN"
export PORT="$PORT"
export BIND_HOST="127.0.0.1"
(
  cd "$ROOT/services/rust/pricing-engine"
  exec setsid cargo run --quiet
) >"$OUT_DIR/service.log" 2>&1 &
PID="$!"
for _ in $(seq 1 60); do
  if curl --fail --silent "http://127.0.0.1:${PORT}/health" >"$OUT_DIR/health.json"; then break; fi
  sleep 1
done
[[ -s "$OUT_DIR/health.json" ]] || { cat "$OUT_DIR/service.log" >&2; exit 1; }

cat >"$OUT_DIR/request.json" <<'JSON'
{"trip_id":"20000000-0000-0000-0000-000000000005","zone_id":"20000000-0000-0000-0000-000000000001","city_code":"LAG","request_id":"20000000-0000-0000-0000-000000000007","idempotency_key":"surge-quote-integration-0001","base_fare_kobo":10000,"demand_count":30,"supply_count":10,"market_source_version":1,"h3_cell":"8928308280fffff","quote_ttl_seconds":300}
JSON
first_status="$(curl --silent --show-error --output "$OUT_DIR/first_response.json" --write-out '%{http_code}' -H "x-internal-service-token: ${TOKEN}" -H 'content-type: application/json' --data @"$OUT_DIR/request.json" "http://127.0.0.1:${PORT}/ride/surge-quote")"
[[ "$first_status" == "200" ]] || { cat "$OUT_DIR/first_response.json" >&2; exit 1; }
retry_status="$(curl --silent --show-error --output "$OUT_DIR/retry_response.json" --write-out '%{http_code}' -H "x-internal-service-token: ${TOKEN}" -H 'content-type: application/json' --data @"$OUT_DIR/request.json" "http://127.0.0.1:${PORT}/ride/surge-quote")"
[[ "$retry_status" == "200" ]] || { cat "$OUT_DIR/retry_response.json" >&2; exit 1; }

python3 - <<'PY' "$OUT_DIR" "$DATABASE" "$ROLE" "$PASSWORD"
import json
import sys
from pathlib import Path
import psycopg

out = Path(sys.argv[1])
first = json.loads((out / 'first_response.json').read_text())
retry = json.loads((out / 'retry_response.json').read_text())
assert first['idempotent'] is False
assert retry['idempotent'] is True
assert first['quote_id'] == retry['quote_id']
assert first['quoted_total_kobo'] == sum(first[key] for key in ('driver_earnings_kobo', 'platform_commission_kobo', 'tax_and_statutory_kobo', 'provider_fee_kobo'))
assert first['surge_multiplier_bps'] == 14000
url = f"postgresql://{sys.argv[3]}:{sys.argv[4]}@127.0.0.1:5432/{sys.argv[2]}?sslmode=disable"
with psycopg.connect(url) as connection:
    row = connection.execute("SELECT COUNT(*) AS allocations, SUM(amount_kobo) AS allocation_total FROM pricing.quote_commission_allocation WHERE quote_id=%s::uuid", (first['quote_id'],)).fetchone()
    assert row[0] == 4
    assert row[1] == first['quoted_total_kobo']
    outbox = connection.execute("SELECT COUNT(*) FROM pricing.outbox_event WHERE aggregate_id=%s::uuid AND event_type='pricing.quote.created'", (first['quote_id'],)).fetchone()[0]
    snapshot = connection.execute("SELECT COUNT(*) FROM pricing.market_snapshot WHERE zone_id='20000000-0000-0000-0000-000000000001'::uuid AND h3_cell='8928308280fffff' AND source_version=1").fetchone()[0]
    assert outbox == 1
    assert snapshot == 1
summary = {
    'passed': True,
    'quote_id': first['quote_id'],
    'surge_multiplier_bps': first['surge_multiplier_bps'],
    'quoted_total_kobo': first['quoted_total_kobo'],
    'idempotency_verified': True,
    'allocation_count': 4,
    'outbox_event_count': 1,
    'market_snapshot_count': 1,
}
(out / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
PY

printf 'Surge pricing and commission integration passed. Evidence: %s\n' "$OUT_DIR/summary.json"
