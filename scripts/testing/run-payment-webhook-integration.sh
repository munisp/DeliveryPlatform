#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DATABASE="ride_payment_webhook_test"
ROLE="ride_payment_webhook_test"
PASSWORD="ride-payment-webhook-test-password"
MIGRATION="$ROOT/drizzle/0026_ride_hailing_dispatch.sql"
QUEUE_MIGRATION="$ROOT/drizzle/0038_payment_webhook_verification_queue.sql"
CORRELATION_MIGRATION="$ROOT/drizzle/0039_payment_webhook_correlation.sql"

sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS ${DATABASE};"
sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "DROP ROLE IF EXISTS ${ROLE};"
sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE ${ROLE} LOGIN PASSWORD '${PASSWORD}';"
sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${DATABASE} OWNER ${ROLE};"

cp "$MIGRATION" /tmp/ride_hailing_dispatch_service_test.sql
cp "$QUEUE_MIGRATION" /tmp/payment_webhook_verification_queue_test.sql
cp "$CORRELATION_MIGRATION" /tmp/payment_webhook_correlation_test.sql
chmod 0644 /tmp/ride_hailing_dispatch_service_test.sql /tmp/payment_webhook_verification_queue_test.sql /tmp/payment_webhook_correlation_test.sql
sudo -u postgres psql -d "$DATABASE" -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE public.users (
  id serial PRIMARY KEY,
  open_id varchar(64) NOT NULL UNIQUE
);
\i /tmp/ride_hailing_dispatch_service_test.sql
\i /tmp/payment_webhook_verification_queue_test.sql
\i /tmp/payment_webhook_correlation_test.sql
GRANT USAGE ON SCHEMA mobility TO ride_payment_webhook_test;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA mobility TO ride_payment_webhook_test;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mobility TO ride_payment_webhook_test;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA mobility TO ride_payment_webhook_test;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.users TO ride_payment_webhook_test;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ride_payment_webhook_test;
SQL

export PAYMENT_TEST_DATABASE_URL="postgresql://${ROLE}:${PASSWORD}@127.0.0.1:5432/${DATABASE}?sslmode=disable"
python3 -m unittest discover -s "$ROOT/services/python/payment-webhook" -p 'test_*.py' -v
