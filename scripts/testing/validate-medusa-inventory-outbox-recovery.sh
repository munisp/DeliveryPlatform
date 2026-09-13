#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB_NAME="medusa_inventory_outbox_recovery_${$}_$(date +%s)"
ROLE_NAME="medusa_recovery_runner_${$}"
ROLE_PASSWORD="$(openssl rand -hex 24)"
DATABASE_URL="postgresql://${ROLE_NAME}:${ROLE_PASSWORD}@127.0.0.1:5432/${DB_NAME}?sslmode=disable"

cleanup() {
  set +e
  sudo -u postgres dropdb --if-exists "$DB_NAME" >/dev/null 2>&1
  sudo -u postgres psql -X -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP ROLE IF EXISTS ${ROLE_NAME}" >/dev/null 2>&1
}
trap cleanup EXIT

if [[ "${ALLOW_MEDUSA_OUTBOX_RECOVERY_TEST:-}" != "I_UNDERSTAND_THIS_CREATES_A_DISPOSABLE_LOCAL_DATABASE" ]]; then
  echo "medusa_inventory_outbox_recovery_result=REFUSED reason=explicit_local_test_acknowledgement_required" >&2
  exit 2
fi

if [[ "${DATABASE_URL:-}" == *"prod"* || "${DATABASE_URL:-}" == *"production"* ]]; then
  echo "medusa_inventory_outbox_recovery_result=REFUSED reason=unexpected_production_database_name" >&2
  exit 2
fi

sudo -n -u postgres true >/dev/null 2>&1 || {
  echo "medusa_inventory_outbox_recovery_result=REFUSED reason=local_postgres_superuser_access_required" >&2
  exit 2
}

sudo -u postgres psql -X -d postgres -v ON_ERROR_STOP=1 <<SQL
CREATE ROLE ${ROLE_NAME} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${ROLE_PASSWORD}';
SQL
sudo -u postgres createdb -O "$ROLE_NAME" "$DB_NAME"

sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL'
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE deliveryplatform_inventory_outbox (
  id uuid PRIMARY KEY,
  source_event_key text NOT NULL UNIQUE CHECK (length(source_event_key) BETWEEN 8 AND 255),
  event_type text NOT NULL CHECK (event_type IN ('commerce.inventory.level.snapshot', 'commerce.inventory.reservation.snapshot')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  source_occurred_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processing', 'delivered', 'dead_letter')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 16),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claim_token uuid,
  lease_expires_at timestamptz,
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (state = 'processing' AND claim_token IS NOT NULL AND lease_expires_at IS NOT NULL AND delivered_at IS NULL)
    OR (state = 'delivered' AND claim_token IS NULL AND lease_expires_at IS NULL AND delivered_at IS NOT NULL)
    OR (state IN ('pending', 'dead_letter') AND claim_token IS NULL AND lease_expires_at IS NULL AND delivered_at IS NULL)
  )
);
CREATE INDEX deliveryplatform_inventory_outbox_ready_idx
  ON deliveryplatform_inventory_outbox (next_attempt_at, created_at) WHERE state = 'pending';
CREATE INDEX deliveryplatform_inventory_outbox_lease_idx
  ON deliveryplatform_inventory_outbox (lease_expires_at) WHERE state = 'processing';
SQL
sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 \
  -c "GRANT SELECT, INSERT, UPDATE, DELETE ON deliveryplatform_inventory_outbox TO ${ROLE_NAME}" >/dev/null

cd "$ROOT_DIR"
TEST_MEDUSA_OUTBOX_DATABASE_URL="$DATABASE_URL" \
pnpm exec vitest run tests/medusa-inventory-outbox-recovery.integration.test.ts

echo "medusa_inventory_outbox_recovery_result=PASS database=${DB_NAME} scenarios=lease_reclaim,backend_disconnect,network_blackhole_stale_fence,sigterm_drain"
