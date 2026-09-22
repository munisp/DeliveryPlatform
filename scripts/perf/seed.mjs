#!/usr/bin/env node
/**
 * seed.mjs — seed the perf-harness database with benchmark volumes.
 *
 * Applies to a FRESH database that already ran apply-migrations.mjs.
 * Volumes (baseline scale):
 *   users 10k (id=1 operator, open_id 'operator:1', admin@switchos.local)
 *   drivers 1k (+ mobility.driver_profile 1k on users 2001..3000)
 *   rider_verifications 2k (users 3001..5000)
 *   verification.verification_case 5k
 *   mobility.fare_quote 50k + mobility.ride_trip 50k
 *   mobility.match_attempt / mobility.driver_offer / orders / transactions /
 *     rider_trips 20k each
 *   offer_economics_breakdowns 10k
 *   sos_events + passenger_manifests 2.5k each, trip_safety_signals 5k
 *   council: 15 members / 50 consultation objects / 150 responses
 *   deactivation_cases 1k + deactivation_appeals 200
 *   5 markets with fare floors / take rates / protection policies /
 *     contract jurisdictions
 *   driver_applications 501, work_record_exports 500
 *   service_verticals 5
 *
 * Also applies stub DDL for tables whose DDL is not in migrations:
 *   loyalty_*, referral_leaderboard_*, marketing_campaigns, campaign_*,
 *   service_providers.category (from scripts/init-local-postgres.sql) and the
 *   longcat_voice_* tables (from server/_core/longcatVoice.ts ensureSchema).
 *
 * Usage:
 *   DATABASE_URL='postgresql://postgres@/deliveryplatform?host=/tmp/pgdata-perf' \
 *     node scripts/perf/seed.mjs
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Client } = require("pg");

const repoRoot = resolve(new URL("../..", import.meta.url).pathname);
const databaseUrl =
  process.env.PERF_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres@/deliveryplatform?host=/tmp/pgdata-perf";

/** DDL-only prefix of scripts/init-local-postgres.sql (drop its seed INSERTs —
 *  the harness owns seeding so user id=1 stays the operator).
 *  Known drift fix: the server's bootstrap loyalty_rewards seed omits
 *  points_required, so the stub makes it nullable. */
function stubDdlFromInitScript() {
  const raw = readFileSync(resolve(repoRoot, "scripts/init-local-postgres.sql"), "utf8");
  const idx = raw.search(/^\s*INSERT INTO/m);
  let ddl = idx === -1 ? raw : raw.slice(0, idx);
  ddl = ddl.replace("points_required INTEGER NOT NULL", "points_required INTEGER");
  return ddl;
}

/** longcat_voice_* DDL — mirrors server/_core/longcatVoice.ts ensureSchema(). */
const LONGCAT_DDL = `
CREATE TABLE IF NOT EXISTS longcat_customer_memory_profiles (
  profile_id UUID PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  customer_phone VARCHAR(64),
  customer_name VARCHAR(255),
  lifetime_orders INTEGER NOT NULL DEFAULT 0,
  average_order_value NUMERIC(12,2) NOT NULL DEFAULT 0,
  last_ordered_at TIMESTAMPTZ,
  favorite_provider_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  preference_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  accessibility_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  substitution_risk VARCHAR(16) NOT NULL DEFAULT 'low',
  memory_summary TEXT NOT NULL DEFAULT '',
  source VARCHAR(32) NOT NULL DEFAULT 'postgres',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id),
  UNIQUE (customer_phone)
);
CREATE INDEX IF NOT EXISTS idx_longcat_customer_memory_updated_at
  ON longcat_customer_memory_profiles(updated_at DESC);
CREATE TABLE IF NOT EXISTS longcat_voice_sessions (
  session_id UUID PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  customer_phone VARCHAR(64),
  customer_name VARCHAR(255),
  voice_channel VARCHAR(64) NOT NULL DEFAULT 'phone_ordering',
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  idempotency_key VARCHAR(255),
  trigger_reason TEXT,
  conversation_goal TEXT NOT NULL DEFAULT '',
  operator_prompt TEXT NOT NULL DEFAULT '',
  current_context JSONB NOT NULL DEFAULT '{}'::jsonb,
  memory_profile_id UUID REFERENCES longcat_customer_memory_profiles(profile_id) ON DELETE SET NULL,
  priority_band VARCHAR(16) NOT NULL DEFAULT 'standard',
  priority_score NUMERIC(10,2) NOT NULL DEFAULT 0,
  priority_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_turn_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  UNIQUE (idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_longcat_voice_sessions_status
  ON longcat_voice_sessions(status, last_turn_at DESC);
CREATE TABLE IF NOT EXISTS longcat_voice_turns (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES longcat_voice_sessions(session_id) ON DELETE CASCADE,
  speaker VARCHAR(16) NOT NULL,
  utterance TEXT NOT NULL,
  detected_intent VARCHAR(128),
  assistant_message TEXT,
  next_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  callback_requested BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_longcat_voice_turns_session_id
  ON longcat_voice_turns(session_id, created_at DESC);
CREATE TABLE IF NOT EXISTS longcat_voice_ingress_sessions (
  ingress_id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES longcat_voice_sessions(session_id) ON DELETE CASCADE,
  external_call_id VARCHAR(255) NOT NULL,
  telephony_provider VARCHAR(64) NOT NULL DEFAULT 'asterisk',
  transport VARCHAR(64) NOT NULL DEFAULT 'audiosocket',
  sample_rate_hz INTEGER NOT NULL DEFAULT 16000,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  stream_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  stream_last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (external_call_id)
);
CREATE INDEX IF NOT EXISTS idx_longcat_voice_ingress_session_id
  ON longcat_voice_ingress_sessions(session_id, stream_last_activity_at DESC);
CREATE TABLE IF NOT EXISTS longcat_voice_speech_events (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES longcat_voice_sessions(session_id) ON DELETE CASCADE,
  direction VARCHAR(16) NOT NULL,
  engine VARCHAR(64) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  transcript TEXT,
  playback_text TEXT,
  audio_format VARCHAR(32),
  degraded_mode BOOLEAN NOT NULL DEFAULT FALSE,
  latency_ms INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_longcat_voice_speech_events_session_id
  ON longcat_voice_speech_events(session_id, created_at DESC);
`;

const MARKETS = ["NG-LAGOS", "NG-ABUJA", "NG-KANO", "NG-IBADAN", "NG-PH"];

async function run(client, label, sql) {
  const t0 = performance.now();
  const res = await client.query(sql);
  const ms = (performance.now() - t0).toFixed(0);
  console.log(`[seed] ${label} ok (${ms}ms)`);
  return res;
}

async function main() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    // ---- stub DDL ----
    await run(client, "stub ddl: init-local-postgres prefix", stubDdlFromInitScript());
    await run(client, "stub ddl: longcat_voice_*", LONGCAT_DDL);

    // ---- reference data ----
    await run(client, "service_verticals x5", `
      INSERT INTO service_verticals (id, name, slug, description, is_active)
      SELECT g, 'Vertical '||g, 'vertical-'||g, 'perf seed', true
      FROM generate_series(1,5) g ON CONFLICT (id) DO NOTHING;
      SELECT setval(pg_get_serial_sequence('service_verticals','id'), 5, true);
    `);

    // ---- users 10k (id 1 = operator) ----
    await run(client, "users x10000", `
      INSERT INTO users (id, open_id, name, email, login_method, role, created_at, updated_at, last_signed_in)
      VALUES (1, 'operator:1', 'SwitchOS Operator Admin', 'admin@switchos.local', 'password', 'admin',
              now() - interval '400 days', now(), now())
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO users (id, open_id, name, email, login_method, role, created_at, updated_at, last_signed_in, phone)
      SELECT g, 'user:'||g, 'Perf User '||g, 'perf-user-'||g||'@example.com', 'password', 'user',
             now() - ((g % 180)||' days')::interval, now(), now() - (g||' seconds')::interval,
             '+234800'||lpad(g::text, 7, '0')
      FROM generate_series(2,10000) g ON CONFLICT (id) DO NOTHING;
      SELECT setval(pg_get_serial_sequence('users','id'), (SELECT max(id) FROM users), true);
    `);

    // ---- drivers 1k (+ mobility.driver_profile on users 2001..3000) ----
    await run(client, "drivers x1000", `
      INSERT INTO drivers (id, open_id, name, email, phone, status, vehicle_type, vehicle_number, license_number, license_verified, rating, total_orders, created_at, updated_at, acceptance_rate, completion_rate, availability, completed_deliveries)
      SELECT g, 'driver:'||g, 'Perf Driver '||g, 'perf-driver-'||g||'@example.com',
             '+234900'||lpad(g::text, 7, '0'),
             CASE WHEN g % 5 = 0 THEN 'offline'::driver_status ELSE 'online'::driver_status END,
             'sedan', 'LAG-'||g, 'LIC-'||g, true, '4.8', g % 5000,
             now() - ((g % 180)||' days')::interval, now(), 80, 95, 'available', g % 4000
      FROM generate_series(1,1000) g ON CONFLICT (id) DO NOTHING;
      SELECT setval(pg_get_serial_sequence('drivers','id'), (SELECT max(id) FROM drivers), true);
      INSERT INTO mobility.driver_profile (user_id, legal_name, display_name, rider_visible_rating, account_state, safety_state, payout_state)
      SELECT 2000+g, 'Perf Driver '||g, 'Driver '||g, 4.50, 'active', 'clear', 'verified'
      FROM generate_series(1,1000) g ON CONFLICT (user_id) DO NOTHING;
    `);

    // ---- rider_verifications 2k ----
    await run(client, "rider_verifications x2000", `
      INSERT INTO rider_verifications (user_id, status, id_type, id_ref_hash, name_plausibility_score, verified_at, consent_captured_at, consent_version)
      SELECT 3000+g,
             CASE WHEN g % 4 = 0 THEN 'pending' WHEN g % 4 = 1 THEN 'verified' WHEN g % 4 = 2 THEN 'verified' ELSE 'unverified' END,
             'national_id', md5('idref-'||g), 0.95,
             CASE WHEN g % 4 IN (1,2) THEN now() - (g||' seconds')::interval END,
             now() - ((g+3600)||' seconds')::interval, 'v1'
      FROM generate_series(1,2000) g ON CONFLICT (user_id) DO NOTHING;
    `);

    // ---- verification.verification_case 5k ----
    await run(client, "verification_case x5000", `
      INSERT INTO verification.verification_case
        (subject_type, subject_key, subject_user_id, jurisdiction, purpose, state, request_key, created_by_user_id, decided_by_user_id, verified_at, expires_at, created_at, updated_at)
      SELECT 'driver'::verification.subject_type,
             'user:'||(2000 + (g % 1000) + 1),
             2000 + (g % 1000) + 1,
             'NG-LA', 'driver_onboarding',
             CASE WHEN g % 5 IN (0,1) THEN 'manual_review'::verification.case_state
                  WHEN g % 5 = 2 THEN 'initiated'::verification.case_state
                  ELSE 'verified'::verification.case_state END,
             'seed-req-'||g, 1,
             CASE WHEN g % 5 IN (3,4) THEN 1 END,
             CASE WHEN g % 5 IN (3,4) THEN now() - (g||' seconds')::interval END,
             CASE WHEN g % 5 IN (3,4) THEN now() + interval '180 days' END,
             now() - ((g % 30)||' days')::interval, now() - (g||' seconds')::interval
      FROM generate_series(1,5000) g;
    `);

    // ---- mobility parents: 1 zone + 1 fare rule ----
    await run(client, "service_zone + fare_rule", `
      INSERT INTO mobility.service_zone (id, city_code, zone_code, version, display_name, boundary, active, dispatch_enabled, policy_version, effective_from)
      VALUES ('11111111-1111-4111-8111-111111111111', 'LAG', 'CENTRAL', 1, 'Lagos Central',
              'MULTIPOLYGON(((3.30 6.40,3.50 6.40,3.50 6.60,3.30 6.60,3.30 6.40)))',
              true, true, 'v1', now() - interval '365 days')
      ON CONFLICT (city_code, zone_code, version) DO NOTHING;
      INSERT INTO mobility.fare_rule_version (id, zone_id, version, currency, base_kobo, per_km_kobo, per_minute_kobo, minimum_kobo, cancellation_kobo, demand_cap_basis_points, effective_from)
      VALUES ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111',
              'v1', 'NGN', 50000, 12000, 3000, 80000, 20000, 50000, now() - interval '365 days')
      ON CONFLICT (zone_id, version) DO NOTHING;
    `);

    // ---- fare_quote 50k ----
    await run(client, "fare_quote x50000", `
      INSERT INTO mobility.fare_quote
        (id, rider_user_id, zone_id, fare_rule_id, route_provider, route_provider_version,
         quoted_distance_m, quoted_duration_s, base_kobo, distance_kobo, time_kobo, demand_kobo,
         taxes_and_fees_kobo, total_kobo, disclosure_version, calculation, expires_at, created_at)
      SELECT md5('fq-'||g)::uuid,
             2 + (g % 9999),
             '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
             'seed-router', 'v1',
             5000 + (g % 20000), 600 + (g % 2400),
             50000, 1200 * (5 + g % 20), 300 * (10 + g % 40), (g % 5) * 2500,
             3750,
             50000 + 1200 * (5 + g % 20) + 300 * (10 + g % 40) + (g % 5) * 2500 + 3750,
             'disclosure-v1', jsonb_build_object('seed', g),
             now() + interval '15 minutes',
             now() - ((g % 180)||' days')::interval - ((g % 86400)||' seconds')::interval
      FROM generate_series(1,50000) g;
    `);

    // ---- ride_trip 50k ----
    await run(client, "ride_trip x50000", `
      INSERT INTO mobility.ride_trip
        (id, rider_user_id, state, zone_id, fare_quote_id, pickup, destination,
         pickup_address, destination_address, assigned_driver_user_id,
         requested_at, started_at, completed_at, created_at, updated_at)
      SELECT md5('rt-'||g)::uuid,
             2 + (g % 9999),
             CASE WHEN g % 5 = 0 THEN 'cancelled'::mobility.trip_state ELSE 'completed'::mobility.trip_state END,
             '11111111-1111-4111-8111-111111111111', md5('fq-'||g)::uuid,
             'POINT(3.37 6.52)', 'POINT(3.40 6.55)',
             'Pickup '||g, 'Dropoff '||g,
             2000 + (g % 1000) + 1,
             now() - ((g % 180)||' days')::interval,
             now() - ((g % 180)||' days')::interval + interval '5 minutes',
             CASE WHEN g % 5 <> 0 THEN now() - ((g % 180)||' days')::interval + interval '35 minutes' END,
             now() - ((g % 180)||' days')::interval, now() - ((g % 180)||' days')::interval + interval '40 minutes'
      FROM generate_series(1,50000) g;
    `);

    // ---- match_attempt 20k + driver_offer 20k ----
    await run(client, "match_attempt x20000", `
      INSERT INTO mobility.match_attempt
        (id, trip_id, wave_no, algorithm_version, candidate_query_snapshot, candidate_count, state, closed_at)
      SELECT md5('ma-'||g)::uuid, md5('rt-'||g)::uuid, 1::smallint, 'seed-v1',
             jsonb_build_object('seed', g), 3, 'exhausted', now() - ((g % 30)||' days')::interval
      FROM generate_series(1,20000) g;
    `);
    await run(client, "driver_offer x20000", `
      INSERT INTO mobility.driver_offer
        (match_attempt_id, trip_id, driver_user_id, rank, score, score_explanation, offered_at, expires_at, state, responded_at)
      SELECT md5('ma-'||g)::uuid, md5('rt-'||g)::uuid, 2000 + (g % 1000) + 1, 1::smallint,
             0.900000, '{}'::jsonb,
             now() - ((g % 30)||' days')::interval - interval '10 minutes',
             now() - ((g % 30)||' days')::interval - interval '5 minutes',
             'expired'::mobility.offer_state, NULL
      FROM generate_series(1,20000) g;
    `);

    // ---- orders 20k ----
    await run(client, "orders x20000", `
      INSERT INTO orders (order_number, customer_id, vertical_id, provider_id, driver_id, status, total_amount, platform_fee, driver_fee, pickup_address, delivery_address, created_at, updated_at)
      SELECT 'PERF-'||g, 2 + (g % 9999), 1 + (g % 5), NULL, 1 + (g % 1000),
             CASE WHEN g % 10 = 0 THEN 'cancelled'::order_status
                  WHEN g % 10 = 1 THEN 'refunded'::order_status
                  ELSE 'delivered'::order_status END,
             ((5000 + g % 50000)::numeric / 100)::text, '250.00', '1500.00',
             'Pickup '||g, 'Delivery '||g,
             now() - ((g % 180)||' days')::interval - ((g % 86400)||' seconds')::interval,
             now() - ((g % 180)||' days')::interval
      FROM generate_series(1,20000) g;
    `);

    // ---- transactions 20k ----
    await run(client, "transactions x20000", `
      INSERT INTO transactions (transaction_id, order_id, type, amount, currency, status, payment_method, recipient_type, recipient_id, created_at, updated_at)
      SELECT 'txn-'||g, 1 + (g % 20000),
             (ARRAY['payment','payout','commission','refund','settlement'])[1 + (g % 5)]::transaction_type,
             ((1000 + g % 20000)::numeric / 100)::text, 'NGN',
             CASE WHEN g % 10 = 0 THEN 'failed'::transaction_status
                  WHEN g % 10 = 1 THEN 'pending'::transaction_status
                  ELSE 'completed'::transaction_status END,
             'card', 'driver'::recipient_type, 1 + (g % 1000),
             now() - ((g % 180)||' days')::interval - ((g % 86400)||' seconds')::interval,
             now() - ((g % 180)||' days')::interval
      FROM generate_series(1,20000) g;
    `);

    // ---- rider_trips 20k ----
    await run(client, "rider_trips x20000", `
      INSERT INTO rider_trips (rider_user_id, driver_id, status, trip_type, vehicle_class, modality, pickup_latitude, pickup_longitude, dropoff_latitude, dropoff_longitude, fare_minor, currency, requested_at, assigned_at, completed_at, created_at, updated_at)
      SELECT 2 + (g % 9999), 1 + (g % 1000),
             CASE WHEN g % 8 = 0 THEN 'cancelled' ELSE 'completed' END,
             'standard', 'standard', 'car',
             6.52 + (g % 100) * 0.0001, 3.37 + (g % 100) * 0.0001,
             6.55, 3.40, 150000 + (g % 50000), 'NGN',
             now() - ((g % 180)||' days')::interval,
             now() - ((g % 180)||' days')::interval + interval '3 minutes',
             CASE WHEN g % 8 <> 0 THEN now() - ((g % 180)||' days')::interval + interval '30 minutes' END,
             now() - ((g % 180)||' days')::interval, now()
      FROM generate_series(1,20000) g;
    `);

    // ---- offer_economics_breakdowns 10k ----
    await run(client, "offer_economics_breakdowns x10000", `
      INSERT INTO offer_economics_breakdowns
        (offer_id, market_id, base_minor, distance_minor, time_minor, deadhead_minor, pickup_seconds, pickup_meters, surge_bps, take_rate_bps, platform_fee_minor, net_to_driver_minor, currency, created_at)
      SELECT 'offer-'||g, (ARRAY['NG-LAGOS','NG-ABUJA','NG-KANO','NG-IBADAN','NG-PH'])[1 + (g % 5)],
             50000, 24000, 9000, 2000, 300, 1200, 0, 2000, 1700, 83300, 'NGN',
             now() - ((g % 60)||' days')::interval - ((g % 86400)||' seconds')::interval
      FROM generate_series(1,10000) g;
    `);

    // ---- sos_events 2.5k + passenger_manifests 2.5k + signals 5k ----
    await run(client, "sos_events x2500", `
      INSERT INTO sos_events (trip_id, user_id, role, h3_index, lat, lng, status, resolved_by, resolved_at, created_at)
      SELECT md5('rt-'||g)::uuid::text, 2 + (g % 9999), CASE WHEN g % 2 = 0 THEN 'rider' ELSE 'driver' END,
             '8944e2d'||lpad(to_hex(g), 5, '0'), 6.52, 3.37,
             CASE WHEN g % 10 = 0 THEN 'active' ELSE 'resolved' END,
             CASE WHEN g % 10 <> 0 THEN 1 END,
             CASE WHEN g % 10 <> 0 THEN now() - ((g % 30)||' days')::interval + interval '20 minutes' END,
             now() - ((g % 30)||' days')::interval
      FROM generate_series(1,2500) g;
    `);
    await run(client, "passenger_manifests x2500", `
      INSERT INTO passenger_manifests (trip_id, booked_by, passengers, manifest_verified, verified_via, created_at, updated_at)
      SELECT md5('rt-'||g)::uuid::text, 2 + (g % 9999),
             jsonb_build_array(jsonb_build_object('name', 'Passenger '||g, 'seat', 1)),
             true, 'id_check', now() - ((g % 30)||' days')::interval, now()
      FROM generate_series(1,2500) g;
    `);
    await run(client, "trip_safety_signals x5000", `
      INSERT INTO trip_safety_signals (trip_id, signal_type, payload, created_at)
      SELECT md5('rt-'||g)::uuid::text,
             (ARRAY['speed_anomaly','route_deviation','hard_brake','dwell','offline'])[1 + (g % 5)],
             jsonb_build_object('seed', g), now() - ((g % 30)||' days')::interval
      FROM generate_series(1,5000) g;
    `);

    // ---- council 15/50/150 ----
    await run(client, "council 15/50/150", `
      INSERT INTO council_members (user_id, constituency, role, active)
      SELECT 6000+g, CASE WHEN g % 2 = 0 THEN 'drivers' ELSE 'riders' END, 'representative', true
      FROM generate_series(1,15) g ON CONFLICT (user_id) DO NOTHING;
      INSERT INTO consultation_objects (kind, title, payload, status, posted_by, response_sla_at, activated_at, created_at)
      SELECT (ARRAY['pricing','commission','deactivation_policy','safety_policy','transition','other'])[1 + (g % 6)],
             'Perf consultation '||g, jsonb_build_object('seed', g),
             CASE WHEN g % 3 = 0 THEN 'closed' ELSE 'open' END,
             1, now() + interval '7 days', now() - interval '1 day',
             now() - ((g % 30)||' days')::interval
      FROM generate_series(1,50) g;
      INSERT INTO consultation_responses (consultation_id, member_id, stance, body, created_at)
      SELECT c.id, m.id, (ARRAY['support','object','comment'])[1 + ((c.rn + m.mn) % 3)],
             'seed response', now() - (c.rn||' hours')::interval
      FROM (SELECT id, row_number() OVER (ORDER BY created_at) rn FROM consultation_objects) c
      JOIN (SELECT id, row_number() OVER (ORDER BY appointed_at) mn FROM council_members) m ON true
      WHERE m.mn <= 3 AND c.rn <= 50
      ON CONFLICT (consultation_id, member_id) DO NOTHING;
    `);

    // ---- deactivations 1k + appeals 200 ----
    await run(client, "deactivation_cases x1000 + appeals x200", `
      INSERT INTO deactivation_cases (subject_user_id, subject_role, cause_code, egregious, evidence, status, notice_sent_at, effective_at, decided_by, created_at, updated_at)
      SELECT 2 + (g % 9999), 'driver',
             (ARRAY['SAFETY','FRAUD','DOCUMENTS','CONDUCT','POLICY','OTHER'])[1 + (g % 6)],
             false, '[]'::jsonb,
             CASE WHEN g % 4 = 0 THEN 'active' ELSE 'closed' END,
             now() - ((g % 60)||' days')::interval,
             CASE WHEN g % 4 = 0 THEN now() + interval '7 days' END,
             1, now() - ((g % 60)||' days')::interval, now()
      FROM generate_series(1,1000) g;
      INSERT INTO deactivation_appeals (case_id, appellant_user_id, statement, status, sla_due_at, created_at)
      SELECT c.id, c.subject_user_id, 'seed appeal statement', 'filed',
             now() + interval '14 days', now() - interval '1 day'
      FROM (SELECT id, subject_user_id, row_number() OVER (ORDER BY created_at) rn FROM deactivation_cases) c
      WHERE c.rn <= 200;
    `);

    // ---- 5 markets: floors / take rates / protection / contract defaults ----
    await run(client, "markets x5 (floors/take-rates/protection/jurisdictions)", `
      INSERT INTO fare_floor_policies (market_id, cost_index, sustainability_multiplier, active, created_by)
      SELECT m, jsonb_build_object('fuel', 1.2, 'labor', 1.1), 1.000, true, 1
      FROM unnest(ARRAY['NG-LAGOS','NG-ABUJA','NG-KANO','NG-IBADAN','NG-PH']) m;
      INSERT INTO take_rate_registry (market_id, rate_bps, basis, effective_from, version, created_by)
      SELECT m, 2000, 'gross', now() - interval '30 days', 1, 1
      FROM unnest(ARRAY['NG-LAGOS','NG-ABUJA','NG-KANO','NG-IBADAN','NG-PH']) m;
      INSERT INTO protection_policies (market_id, micro_premium_minor, downtime_daily_stipend_minor, protection_levy_minor, opt_out_allowed, active)
      SELECT m, 500, 2500, 100, true, true
      FROM unnest(ARRAY['NG-LAGOS','NG-ABUJA','NG-KANO','NG-IBADAN','NG-PH']) m;
      INSERT INTO contract_jurisdictions (market_id, governing_law, dispute_forum, consumer_protection_overrides, effective_from, published)
      SELECT m, 'Federal Republic of Nigeria', 'Lagos, Nigeria courts', '{}'::jsonb, now() - interval '90 days', true
      FROM unnest(ARRAY['NG-LAGOS','NG-ABUJA','NG-KANO','NG-IBADAN','NG-PH']) m;
    `);

    // ---- 1 active marketing campaign for the send-trigger benchmark ----
    await run(client, "marketing_campaign x1 (bench trigger)", `
      INSERT INTO marketing_campaigns (id, campaign_name, campaign_type, email_template, sms_template, target_audience, status, is_active, channel)
      VALUES (1, 'Perf Bench Campaign', 'promo', 'Hello {{name}}, you have {{points}} points.', 'Hi {{name}}', 'all', 'active', true, 'email')
      ON CONFLICT (id) DO NOTHING;
      SELECT setval(pg_get_serial_sequence('marketing_campaigns','id'), GREATEST((SELECT max(id) FROM marketing_campaigns), 1), true);
    `);

    // ---- driver_applications 501 + work_record_exports 500 ----
    await run(client, "driver_applications x501", `
      INSERT INTO driver_applications (user_id, status, full_name, phone, city, vehicle, created_at, updated_at)
      SELECT 7000+g, CASE WHEN g % 3 = 0 THEN 'rejected' ELSE 'approved' END,
             'Applicant '||g, '+234700'||lpad(g::text, 7, '0'), 'Lagos',
             jsonb_build_object('type', 'sedan'), now() - ((g % 60)||' days')::interval, now()
      FROM generate_series(1,501) g;
    `);
    await run(client, "work_record_exports x500", `
      INSERT INTO work_record_exports (user_id, period_start, period_end, payload, payload_hash, signature, signer_key_id, status, created_at, signed_at)
      SELECT 2000 + (g % 1000) + 1, now() - interval '30 days', now() - interval '1 day',
             jsonb_build_object('seed', g), md5('payload-'||g), md5('sig-'||g), 'seed-key',
             'signed', now() - ((g % 30)||' days')::interval, now() - ((g % 30)||' days')::interval
      FROM generate_series(1,500) g;
    `);

    // ---- summary ----
    const counts = await client.query(`
      SELECT 'users' t, count(*)::bigint c FROM users
      UNION ALL SELECT 'drivers', count(*) FROM drivers
      UNION ALL SELECT 'driver_profile', count(*) FROM mobility.driver_profile
      UNION ALL SELECT 'rider_verifications', count(*) FROM rider_verifications
      UNION ALL SELECT 'verification_case', count(*) FROM verification.verification_case
      UNION ALL SELECT 'fare_quote', count(*) FROM mobility.fare_quote
      UNION ALL SELECT 'ride_trip', count(*) FROM mobility.ride_trip
      UNION ALL SELECT 'match_attempt', count(*) FROM mobility.match_attempt
      UNION ALL SELECT 'driver_offer', count(*) FROM mobility.driver_offer
      UNION ALL SELECT 'orders', count(*) FROM orders
      UNION ALL SELECT 'transactions', count(*) FROM transactions
      UNION ALL SELECT 'rider_trips', count(*) FROM rider_trips
      UNION ALL SELECT 'offer_economics_breakdowns', count(*) FROM offer_economics_breakdowns
      UNION ALL SELECT 'sos_events', count(*) FROM sos_events
      UNION ALL SELECT 'passenger_manifests', count(*) FROM passenger_manifests
      UNION ALL SELECT 'trip_safety_signals', count(*) FROM trip_safety_signals
      UNION ALL SELECT 'council_members', count(*) FROM council_members
      UNION ALL SELECT 'consultation_objects', count(*) FROM consultation_objects
      UNION ALL SELECT 'consultation_responses', count(*) FROM consultation_responses
      UNION ALL SELECT 'deactivation_cases', count(*) FROM deactivation_cases
      UNION ALL SELECT 'deactivation_appeals', count(*) FROM deactivation_appeals
      UNION ALL SELECT 'fare_floor_policies', count(*) FROM fare_floor_policies
      UNION ALL SELECT 'take_rate_registry', count(*) FROM take_rate_registry
      UNION ALL SELECT 'protection_policies', count(*) FROM protection_policies
      UNION ALL SELECT 'contract_jurisdictions', count(*) FROM contract_jurisdictions
      UNION ALL SELECT 'driver_applications', count(*) FROM driver_applications
      UNION ALL SELECT 'work_record_exports', count(*) FROM work_record_exports
      ORDER BY 1;
    `);
    console.log("[seed] row counts:");
    for (const row of counts.rows) console.log(`  ${row.t}: ${row.c}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("[seed] FAILED:", err);
  process.exit(1);
});
