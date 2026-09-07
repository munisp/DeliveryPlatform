#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB_NAME="developer_webhook_retry_${$}_$(date +%s)"
ROLE_FIELD="field_service_api"
ROLE_API="developer_api_service"
ROLE_MANAGEMENT="developer_api_management"
ROLE_UNTRUSTED="developer_api_untrusted"
CREATED_ROLES=()

cleanup() {
  set +e
  sudo -u postgres dropdb --if-exists "$DB_NAME" >/dev/null 2>&1
  for role in "${CREATED_ROLES[@]:-}"; do
    sudo -u postgres psql -X -d postgres -v ON_ERROR_STOP=1 \
      -c "DROP ROLE IF EXISTS ${role}" >/dev/null 2>&1
  done
}
trap cleanup EXIT

role_exists() {
  sudo -u postgres psql -X -At -d postgres \
    -c "SELECT 1 FROM pg_roles WHERE rolname = '$1'" | grep -qx 1
}

role_safe() {
  sudo -u postgres psql -X -At -d postgres -c "
    SELECT NOT rolcanlogin
      AND NOT rolsuper
      AND NOT rolcreaterole
      AND NOT rolcreatedb
      AND NOT rolreplication
      AND NOT rolbypassrls
      AND NOT EXISTS (
        SELECT 1
        FROM pg_auth_members
        WHERE member = pg_roles.oid OR roleid = pg_roles.oid
      )
    FROM pg_roles
    WHERE rolname = '$1'
  " | grep -qx t
}

for role in "$ROLE_FIELD" "$ROLE_API" "$ROLE_MANAGEMENT" "$ROLE_UNTRUSTED"; do
  if role_exists "$role"; then
    role_safe "$role" || {
      echo "developer_webhook_retry_backoff=FAIL reason=unsafe_existing_role role=$role" >&2
      exit 1
    }
  else
    sudo -u postgres psql -X -d postgres -v ON_ERROR_STOP=1 \
      -c "CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS" \
      >/dev/null
    CREATED_ROLES+=("$role")
  fi
done

printf '%s\n' 'Running isolated loopback network-failure dispatcher test...'
(
  cd "$ROOT_DIR"
  pnpm vitest run tests/developer-webhook-delivery.test.ts
)

sudo -u postgres createdb "$DB_NAME"
sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL'
CREATE EXTENSION postgis;
CREATE EXTENSION pgcrypto;
CREATE TYPE public.user_role AS ENUM ('user', 'admin');
CREATE TYPE public.provider_status AS ENUM ('pending', 'active', 'suspended', 'rejected');
CREATE TABLE public.users (
  id serial PRIMARY KEY,
  open_id varchar(64) NOT NULL UNIQUE,
  name text,
  email varchar(320),
  role public.user_role NOT NULL DEFAULT 'user',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_signed_in timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.customers (
  id serial PRIMARY KEY,
  open_id varchar(64) NOT NULL UNIQUE,
  name varchar(255) NOT NULL,
  email varchar(320)
);
CREATE TABLE public.service_providers (
  id serial PRIMARY KEY,
  vertical_id integer NOT NULL DEFAULT 1,
  name varchar(255) NOT NULL,
  business_name varchar(255) NOT NULL,
  email varchar(320) NOT NULL,
  phone varchar(20) NOT NULL,
  status public.provider_status NOT NULL DEFAULT 'active'
);
CREATE TABLE public.orders (id serial PRIMARY KEY);
INSERT INTO public.users (id, open_id, name, role)
VALUES (1, 'webhook-admin', 'Webhook Admin', 'admin');
INSERT INTO public.service_providers (id, name, business_name, email, phone, status)
VALUES (1, 'Webhook Provider', 'Webhook Provider Ltd', 'webhook@example.test', '+2348000000000', 'active');
SQL

sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 \
  < "$ROOT_DIR/drizzle/0044_field_service_operations.sql" >/dev/null
sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 \
  < "$ROOT_DIR/drizzle/0045_developer_api_platform.sql" >/dev/null
sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 \
  < "$ROOT_DIR/drizzle/0048_developer_webhook_delivery_leases.sql" >/dev/null
sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 \
  < "$ROOT_DIR/drizzle/0049_developer_webhook_retry_jitter.sql" >/dev/null

sudo -u postgres psql -X -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE developer_api_management;
SELECT developer.create_api_client(1, 1, 'Retry Simulation Client') AS api_client_id \gset
SELECT developer.create_webhook_endpoint(
  1,
  :'api_client_id'::uuid,
  'https://webhook-simulator.invalid/delivery',
  ARRAY['field_service.work_order.created']::text[],
  'simulated/network-secret'
) AS endpoint_id \gset
RESET ROLE;

DO $$
DECLARE
  v_first_event uuid := '11111111-1111-4111-8111-111111111111';
  v_terminal_event uuid := '22222222-2222-4222-8222-222222222222';
  v_now timestamptz := timestamptz '2026-09-06 12:00:00+00';
  v_delivery_id uuid;
  v_claim record;
  v_state developer.webhook_delivery_state;
  v_attempt_count integer;
  v_actual_attempt_count integer;
  v_next_attempt_at timestamptz;
  v_delivered_at timestamptz;
  v_claim_token uuid;
  v_claim_expires_at timestamptz;
  v_base_backoff_seconds integer;
  v_jitter_window_seconds integer;
  v_jitter_seconds integer;
  v_jitter_seed bytea;
  v_delay_seconds integer;
  v_count integer;
  v_stale_rejected boolean := false;
  v_previous_token uuid;
BEGIN
  PERFORM developer.enqueue_webhook_deliveries(
    1,
    v_first_event,
    'field_service.work_order.created',
    jsonb_build_object('simulation', 'connection_reset', 'sequence', 1),
    v_now
  );

  FOR v_attempt_count IN 1..6 LOOP
    SELECT * INTO v_claim
    FROM developer.claim_webhook_deliveries(1, v_now);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'retry simulation did not claim attempt % at %', v_attempt_count, v_now;
    END IF;
    IF v_claim.attempt_count <> v_attempt_count THEN
      RAISE EXCEPTION 'expected attempt %, got %', v_attempt_count, v_claim.attempt_count;
    END IF;
    IF v_previous_token IS NOT NULL AND v_claim.claim_token = v_previous_token THEN
      RAISE EXCEPTION 'claim token was reused between attempts';
    END IF;
    v_previous_token := v_claim.claim_token;

    SELECT count(*) INTO v_count
    FROM developer.claim_webhook_deliveries(1, v_now);
    IF v_count <> 0 THEN
      RAISE EXCEPTION 'active claim was claimed by a second worker';
    END IF;

    PERFORM developer.complete_webhook_delivery(
      v_claim.delivery_id,
      v_claim.claim_token,
      false,
      599,
      'simulated_network_reset',
      v_now
    );

    v_base_backoff_seconds := LEAST(3600, (2::numeric ^ v_claim.attempt_count)::integer);
    v_jitter_window_seconds := GREATEST(1, ceil(v_base_backoff_seconds / 4.0)::integer);
    v_jitter_seed := public.digest(
      v_claim.delivery_id::text || ':' || v_claim.attempt_count::text,
      'sha256'
    );
    v_jitter_seconds := mod(
      get_byte(v_jitter_seed, 0) * 256 + get_byte(v_jitter_seed, 1),
      v_jitter_window_seconds + 1
    );
    v_delay_seconds := v_base_backoff_seconds + v_jitter_seconds;
    SELECT state, attempt_count, next_attempt_at
    INTO v_state, v_actual_attempt_count, v_next_attempt_at
    FROM developer.webhook_delivery
    WHERE id = v_claim.delivery_id;
    IF v_state <> 'retrying'::developer.webhook_delivery_state
      OR v_actual_attempt_count <> v_claim.attempt_count
      OR v_next_attempt_at <> v_now + make_interval(secs => v_delay_seconds)
      OR v_delay_seconds NOT BETWEEN v_base_backoff_seconds AND v_base_backoff_seconds + v_jitter_window_seconds THEN
      RAISE EXCEPTION 'jittered retry schedule mismatch after attempt %', v_claim.attempt_count;
    END IF;

    SELECT count(*) INTO v_count
    FROM developer.claim_webhook_deliveries(1, v_now + make_interval(secs => v_delay_seconds - 1));
    IF v_count <> 0 THEN
      RAISE EXCEPTION 'delivery was claimed before its backoff delay elapsed';
    END IF;
    v_now := v_next_attempt_at;
  END LOOP;

  SELECT * INTO v_claim
  FROM developer.claim_webhook_deliveries(1, v_now);
  IF NOT FOUND OR v_claim.attempt_count <> 7 THEN
    RAISE EXCEPTION 'retry simulation did not claim attempt 7';
  END IF;
  BEGIN
    PERFORM developer.complete_webhook_delivery(
      v_claim.delivery_id,
      gen_random_uuid(),
      false,
      599,
      'simulated_stale_worker',
      v_now
    );
  EXCEPTION WHEN SQLSTATE '55000' THEN
    v_stale_rejected := true;
  END;
  IF NOT v_stale_rejected THEN
    RAISE EXCEPTION 'stale worker completion was accepted';
  END IF;
  SELECT count(*) INTO v_count
  FROM developer.claim_webhook_deliveries(1, v_now);
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'delivery was double-claimed after a stale completion attempt';
  END IF;
  PERFORM developer.complete_webhook_delivery(
    v_claim.delivery_id,
    v_claim.claim_token,
    true,
    204,
    NULL,
    v_now
  );
  SELECT state, delivered_at, claim_token, claim_expires_at
  INTO v_state, v_delivered_at, v_claim_token, v_claim_expires_at
  FROM developer.webhook_delivery
  WHERE id = v_claim.delivery_id;
  IF v_state <> 'delivered'::developer.webhook_delivery_state
    OR v_delivered_at <> v_now
    OR v_claim_token IS NOT NULL
    OR v_claim_expires_at IS NOT NULL THEN
    RAISE EXCEPTION 'successful delivery did not clear the lease';
  END IF;

  v_now := timestamptz '2026-09-07 12:00:00+00';
  PERFORM developer.enqueue_webhook_deliveries(
    1,
    v_terminal_event,
    'field_service.work_order.created',
    jsonb_build_object('simulation', 'terminal_network_reset', 'sequence', 2),
    v_now
  );

  FOR v_attempt_count IN 1..16 LOOP
    SELECT * INTO v_claim
    FROM developer.claim_webhook_deliveries(1, v_now);
    IF NOT FOUND OR v_claim.attempt_count <> v_attempt_count THEN
      RAISE EXCEPTION 'terminal simulation claim mismatch at attempt %', v_attempt_count;
    END IF;
    PERFORM developer.complete_webhook_delivery(
      v_claim.delivery_id,
      v_claim.claim_token,
      false,
      599,
      'simulated_network_reset',
      v_now
    );
    SELECT state, attempt_count, next_attempt_at
    INTO v_state, v_actual_attempt_count, v_next_attempt_at
    FROM developer.webhook_delivery
    WHERE id = v_claim.delivery_id;

    IF v_attempt_count < 16 THEN
      v_base_backoff_seconds := LEAST(3600, (2::numeric ^ v_claim.attempt_count)::integer);
      v_jitter_window_seconds := GREATEST(1, ceil(v_base_backoff_seconds / 4.0)::integer);
      v_jitter_seed := public.digest(
        v_claim.delivery_id::text || ':' || v_claim.attempt_count::text,
        'sha256'
      );
      v_jitter_seconds := mod(
        get_byte(v_jitter_seed, 0) * 256 + get_byte(v_jitter_seed, 1),
        v_jitter_window_seconds + 1
      );
      v_delay_seconds := v_base_backoff_seconds + v_jitter_seconds;
      IF v_state <> 'retrying'::developer.webhook_delivery_state
        OR v_actual_attempt_count <> v_attempt_count
        OR v_next_attempt_at <> v_now + make_interval(secs => v_delay_seconds)
        OR v_delay_seconds NOT BETWEEN v_base_backoff_seconds AND v_base_backoff_seconds + v_jitter_window_seconds THEN
        RAISE EXCEPTION 'terminal simulation jittered retry schedule mismatch after attempt %', v_attempt_count;
      END IF;
      v_now := v_next_attempt_at;
    ELSIF v_state <> 'dead_letter'::developer.webhook_delivery_state
      OR v_actual_attempt_count <> 16
      OR v_next_attempt_at <> v_now THEN
      RAISE EXCEPTION 'attempt 16 did not enter dead_letter';
    END IF;
  END LOOP;

  SELECT count(*) INTO v_count
  FROM developer.claim_webhook_deliveries(1, v_now + interval '1 day');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'dead-letter delivery was claimed again';
  END IF;

  SELECT count(*) INTO v_count
  FROM developer.webhook_delivery;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'expected exactly two immutable delivery records, got %', v_count;
  END IF;
END;
$$;

SELECT 'developer_webhook_retry_backoff=PASS' AS result;
SELECT
  event_id,
  state,
  attempt_count,
  last_status,
  last_error,
  next_attempt_at
FROM developer.webhook_delivery
ORDER BY event_id;
SQL

echo "developer_webhook_retry_backoff=PASS database=${DB_NAME} network=loopback_connection_reset durable_failures=599"
