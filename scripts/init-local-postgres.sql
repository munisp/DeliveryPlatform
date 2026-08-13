ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code VARCHAR(50);
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by_code VARCHAR(50);
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(20);

ALTER TABLE service_providers ADD COLUMN IF NOT EXISTS category VARCHAR(100) DEFAULT 'general';
ALTER TABLE service_providers ADD COLUMN IF NOT EXISTS completed_services INTEGER NOT NULL DEFAULT 0;

ALTER TABLE drivers ADD COLUMN IF NOT EXISTS acceptance_rate NUMERIC(10,2) DEFAULT 80;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS completion_rate NUMERIC(10,2) DEFAULT 95;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS total_earnings NUMERIC(12,2) DEFAULT 0;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS availability VARCHAR(32) DEFAULT 'available';
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS current_location TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS primary_vertical_id INTEGER;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS active_orders INTEGER NOT NULL DEFAULT 0;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS completed_deliveries INTEGER NOT NULL DEFAULT 0;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS service_provider_id INTEGER;
UPDATE orders SET service_provider_id = provider_id WHERE service_provider_id IS NULL AND provider_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS loyalty_points (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  points_balance INTEGER NOT NULL DEFAULT 0,
  lifetime_points INTEGER NOT NULL DEFAULT 0,
  tier VARCHAR(32) NOT NULL DEFAULT 'bronze',
  tier_progress NUMERIC(10,2) NOT NULL DEFAULT 0,
  next_tier_threshold INTEGER NOT NULL DEFAULT 1000,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS loyalty_transactions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  transaction_type VARCHAR(64) NOT NULL,
  points INTEGER NOT NULL,
  order_id INTEGER,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS loyalty_rewards (
  id SERIAL PRIMARY KEY,
  reward_name VARCHAR(160) NOT NULL,
  description TEXT,
  points_cost INTEGER NOT NULL,
  points_required INTEGER NOT NULL,
  reward_type VARCHAR(64) NOT NULL,
  reward_value VARCHAR(160),
  min_tier VARCHAR(32),
  is_active BOOLEAN NOT NULL DEFAULT true,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS loyalty_redemptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reward_id INTEGER NOT NULL REFERENCES loyalty_rewards(id) ON DELETE CASCADE,
  points_spent INTEGER NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'approved',
  voucher_code VARCHAR(255) NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customer_referrals (
  id SERIAL PRIMARY KEY,
  referrer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referred_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  referral_code VARCHAR(50) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  referrer_bonus_points INTEGER NOT NULL DEFAULT 500,
  referred_bonus_points INTEGER NOT NULL DEFAULT 200,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS referral_leaderboard_periods (
  id SERIAL PRIMARY KEY,
  period_name VARCHAR(32) NOT NULL UNIQUE,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS referral_leaderboard_entries (
  id SERIAL PRIMARY KEY,
  period_id INTEGER NOT NULL REFERENCES referral_leaderboard_periods(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referral_count INTEGER NOT NULL DEFAULT 0,
  successful_referrals INTEGER NOT NULL DEFAULT 0,
  points_earned INTEGER NOT NULL DEFAULT 0,
  rank INTEGER,
  reward_tier VARCHAR(32) NOT NULL DEFAULT 'none',
  reward_points INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(period_id, user_id)
);

CREATE TABLE IF NOT EXISTS push_notification_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_token VARCHAR(512) NOT NULL,
  device_type VARCHAR(32) NOT NULL,
  device_id VARCHAR(255),
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, device_token)
);

CREATE TABLE IF NOT EXISTS push_notification_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_type VARCHAR(64) NOT NULL,
  title VARCHAR(255) NOT NULL,
  body TEXT NOT NULL,
  data JSONB,
  status VARCHAR(32) NOT NULL DEFAULT 'sent',
  sent_at TIMESTAMPTZ,
  clicked_at TIMESTAMPTZ,
  sent_to_devices INTEGER NOT NULL DEFAULT 0,
  failed_devices INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notification_preferences (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  channel_email BOOLEAN NOT NULL DEFAULT true,
  channel_sms BOOLEAN NOT NULL DEFAULT true,
  channel_push BOOLEAN NOT NULL DEFAULT true,
  trigger_order_confirmed BOOLEAN NOT NULL DEFAULT true,
  trigger_driver_assigned BOOLEAN NOT NULL DEFAULT true,
  trigger_pickup_complete BOOLEAN NOT NULL DEFAULT true,
  trigger_delivery_approaching BOOLEAN NOT NULL DEFAULT true,
  trigger_delivery_complete BOOLEAN NOT NULL DEFAULT true,
  trigger_order_cancelled BOOLEAN NOT NULL DEFAULT true,
  trigger_promotion BOOLEAN NOT NULL DEFAULT true,
  trigger_news BOOLEAN NOT NULL DEFAULT true,
  dnd_enabled BOOLEAN NOT NULL DEFAULT false,
  dnd_start_time VARCHAR(5),
  dnd_end_time VARCHAR(5),
  frequency_limit INTEGER NOT NULL DEFAULT 20,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS marketing_campaigns (
  id SERIAL PRIMARY KEY,
  campaign_name VARCHAR(255) NOT NULL,
  campaign_type VARCHAR(64) NOT NULL,
  email_template TEXT,
  sms_template TEXT,
  target_audience VARCHAR(64) NOT NULL DEFAULT 'all',
  trigger_condition JSONB,
  status VARCHAR(32) NOT NULL DEFAULT 'draft',
  is_active BOOLEAN NOT NULL DEFAULT true,
  send_count INTEGER NOT NULL DEFAULT 0,
  open_count INTEGER NOT NULL DEFAULT 0,
  click_count INTEGER NOT NULL DEFAULT 0,
  open_rate NUMERIC(10,2) NOT NULL DEFAULT 0,
  click_rate NUMERIC(10,2) NOT NULL DEFAULT 0,
  budget NUMERIC(12,2) NOT NULL DEFAULT 0,
  spent NUMERIC(12,2) NOT NULL DEFAULT 0,
  channel VARCHAR(32) NOT NULL DEFAULT 'email',
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS campaign_sends (
  id SERIAL PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES marketing_campaigns(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  error_message TEXT,
  sent_at TIMESTAMPTZ,
  opened_at TIMESTAMPTZ,
  clicked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS campaign_variants (
  id SERIAL PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES marketing_campaigns(id) ON DELETE CASCADE,
  variant_name VARCHAR(160) NOT NULL,
  email_template TEXT,
  sms_template TEXT,
  traffic_allocation NUMERIC(10,2) NOT NULL DEFAULT 50,
  send_count INTEGER NOT NULL DEFAULT 0,
  open_count INTEGER NOT NULL DEFAULT 0,
  click_count INTEGER NOT NULL DEFAULT 0,
  conversion_count INTEGER NOT NULL DEFAULT 0,
  is_winner BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS variant_assignments (
  id SERIAL PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES marketing_campaigns(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  variant_id INTEGER NOT NULL REFERENCES campaign_variants(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(campaign_id, user_id)
);

CREATE TABLE IF NOT EXISTS driver_performance_scores (
  id SERIAL PRIMARY KEY,
  driver_id INTEGER NOT NULL UNIQUE REFERENCES drivers(id) ON DELETE CASCADE,
  score NUMERIC(10,2) NOT NULL DEFAULT 0,
  tier VARCHAR(20) NOT NULL DEFAULT 'bronze',
  delivery_time_score NUMERIC(10,2) NOT NULL DEFAULT 0,
  review_score NUMERIC(10,2) NOT NULL DEFAULT 0,
  acceptance_rate NUMERIC(10,2) NOT NULL DEFAULT 0,
  completion_rate NUMERIC(10,2) NOT NULL DEFAULT 0,
  total_deliveries INTEGER NOT NULL DEFAULT 0,
  on_time_deliveries INTEGER NOT NULL DEFAULT 0,
  late_deliveries INTEGER NOT NULL DEFAULT 0,
  cancelled_deliveries INTEGER NOT NULL DEFAULT 0,
  last_calculated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO users (id, open_id, name, email, role, referral_code)
VALUES (1, 'seed-user-1', 'Seed User', 'seed-user-1@switchos.local', 'user', 'SEEDREF1')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email, referral_code = EXCLUDED.referral_code;

SELECT setval(pg_get_serial_sequence('users', 'id'), GREATEST((SELECT COALESCE(MAX(id), 1) FROM users), 1), true);

INSERT INTO service_verticals (id, name, slug, description, is_active)
VALUES (1, 'Food Delivery', 'food-delivery', 'Seed vertical for local verification', true)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, slug = EXCLUDED.slug, description = EXCLUDED.description, is_active = EXCLUDED.is_active;

SELECT setval(pg_get_serial_sequence('service_verticals', 'id'), GREATEST((SELECT COALESCE(MAX(id), 1) FROM service_verticals), 1), true);

INSERT INTO service_providers (id, vertical_id, name, business_name, email, phone, status, verification_status, rating, commission_rate, category, completed_services)
VALUES (1, 1, 'Seed Merchant', 'Seed Merchant', 'merchant@switchos.local', '+10000000001', 'active', 'verified', '4.8', '15', 'restaurant', 25)
ON CONFLICT (id) DO UPDATE SET business_name = EXCLUDED.business_name, status = EXCLUDED.status, verification_status = EXCLUDED.verification_status, rating = EXCLUDED.rating, category = EXCLUDED.category, completed_services = EXCLUDED.completed_services;

SELECT setval(pg_get_serial_sequence('service_providers', 'id'), GREATEST((SELECT COALESCE(MAX(id), 1) FROM service_providers), 1), true);

INSERT INTO drivers (id, open_id, name, email, phone, status, vehicle_type, rating, total_orders, acceptance_rate, completion_rate, total_earnings, availability, current_location, primary_vertical_id, active_orders, completed_deliveries)
VALUES (1, 'seed-driver-1', 'Seed Driver', 'driver@switchos.local', '+10000000002', 'online', 'car', '4.9', 18, 92, 98, 1650.50, 'available', 'POINT(0 0)', 1, 1, 18)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status, rating = EXCLUDED.rating, total_orders = EXCLUDED.total_orders, acceptance_rate = EXCLUDED.acceptance_rate, completion_rate = EXCLUDED.completion_rate, total_earnings = EXCLUDED.total_earnings, availability = EXCLUDED.availability, current_location = EXCLUDED.current_location, primary_vertical_id = EXCLUDED.primary_vertical_id, active_orders = EXCLUDED.active_orders, completed_deliveries = EXCLUDED.completed_deliveries;

SELECT setval(pg_get_serial_sequence('drivers', 'id'), GREATEST((SELECT COALESCE(MAX(id), 1) FROM drivers), 1), true);

INSERT INTO orders (id, order_number, customer_id, vertical_id, provider_id, driver_id, service_provider_id, status, total_amount, platform_fee, driver_fee, pickup_address, delivery_address, scheduled_pickup_time, actual_pickup_time, actual_delivery_time, estimated_delivery_time, notes, created_at, updated_at)
VALUES
  (1, 'SO-1001', 1, 1, 1, 1, 1, 'delivered', '45.00', '6.00', '18.00', '1 Pickup Way', '1 Delivery Way', NOW() - INTERVAL '4 days', NOW() - INTERVAL '4 days' + INTERVAL '10 minutes', NOW() - INTERVAL '4 days' + INTERVAL '42 minutes', NOW() - INTERVAL '4 days' + INTERVAL '40 minutes', 'Seed completed trip with stop note', NOW() - INTERVAL '4 days', NOW() - INTERVAL '4 days'),
  (2, 'SO-1002', 1, 1, 1, 1, 1, 'assigned', '32.50', '4.50', '14.00', '2 Pickup Way', '2 Delivery Way', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '110 minutes', NULL, NOW() + INTERVAL '25 minutes', 'Seed active trip', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '15 minutes')
ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, total_amount = EXCLUDED.total_amount, updated_at = EXCLUDED.updated_at, service_provider_id = EXCLUDED.service_provider_id;

SELECT setval(pg_get_serial_sequence('orders', 'id'), GREATEST((SELECT COALESCE(MAX(id), 1) FROM orders), 1), true);

INSERT INTO driver_performance_scores (driver_id, score, tier, delivery_time_score, review_score, acceptance_rate, completion_rate, total_deliveries, on_time_deliveries, late_deliveries, cancelled_deliveries, last_calculated_at)
VALUES (1, 96.50, 'platinum', 94.00, 98.00, 92.00, 98.00, 18, 16, 1, 1, NOW())
ON CONFLICT (driver_id) DO UPDATE SET score = EXCLUDED.score, tier = EXCLUDED.tier, delivery_time_score = EXCLUDED.delivery_time_score, review_score = EXCLUDED.review_score, acceptance_rate = EXCLUDED.acceptance_rate, completion_rate = EXCLUDED.completion_rate, total_deliveries = EXCLUDED.total_deliveries, on_time_deliveries = EXCLUDED.on_time_deliveries, late_deliveries = EXCLUDED.late_deliveries, cancelled_deliveries = EXCLUDED.cancelled_deliveries, last_calculated_at = EXCLUDED.last_calculated_at;

INSERT INTO loyalty_rewards (id, reward_name, description, points_cost, points_required, reward_type, reward_value, min_tier, is_active, status, expires_at)
VALUES
  (1, 'Free Delivery', 'Free delivery voucher for the next eligible order', 300, 300, 'voucher', 'Free delivery', 'bronze', true, 'active', NOW() + INTERVAL '90 days'),
  (2, '10 Percent Off', 'Ten percent discount on a qualifying order', 500, 500, 'discount', '10% off', 'bronze', true, 'active', NOW() + INTERVAL '90 days'),
  (3, 'Priority Dispatch Pass', 'Priority dispatch boost on a future order', 900, 900, 'priority', 'Priority dispatch', 'silver', true, 'active', NOW() + INTERVAL '90 days'),
  (4, 'Airport Pickup Upgrade', 'Premium airport pickup handling', 1200, 1200, 'service', 'Airport upgrade', 'silver', true, 'active', NOW() + INTERVAL '90 days'),
  (5, 'Partner Voucher', 'Partner-store voucher credit', 1800, 1800, 'voucher', '₦5,000 voucher', 'gold', true, 'active', NOW() + INTERVAL '90 days'),
  (6, 'Premium Support Window', 'Dedicated operator support window', 2600, 2600, 'service', 'Priority support', 'gold', true, 'active', NOW() + INTERVAL '90 days'),
  (7, 'Executive Ride Upgrade', 'Executive ride class upgrade', 4200, 4200, 'upgrade', 'Executive upgrade', 'platinum', true, 'active', NOW() + INTERVAL '90 days'),
  (8, 'VIP Membership', 'VIP membership bundle with premium benefits', 8000, 8000, 'membership', 'VIP membership', 'platinum', true, 'active', NOW() + INTERVAL '90 days')
ON CONFLICT (id) DO UPDATE SET reward_name = EXCLUDED.reward_name, description = EXCLUDED.description, points_cost = EXCLUDED.points_cost, points_required = EXCLUDED.points_required, reward_type = EXCLUDED.reward_type, reward_value = EXCLUDED.reward_value, min_tier = EXCLUDED.min_tier, is_active = EXCLUDED.is_active, status = EXCLUDED.status, expires_at = EXCLUDED.expires_at;

SELECT setval(pg_get_serial_sequence('loyalty_rewards', 'id'), GREATEST((SELECT COALESCE(MAX(id), 1) FROM loyalty_rewards), 1), true);

INSERT INTO referral_leaderboard_periods (id, period_name, period_start, period_end, is_active)
VALUES (1, TO_CHAR(DATE_TRUNC('month', NOW()), 'YYYY-MM'), DATE_TRUNC('month', NOW()), DATE_TRUNC('month', NOW()) + INTERVAL '1 month' - INTERVAL '1 second', true)
ON CONFLICT (id) DO UPDATE SET period_name = EXCLUDED.period_name, period_start = EXCLUDED.period_start, period_end = EXCLUDED.period_end, is_active = EXCLUDED.is_active;

UPDATE referral_leaderboard_periods SET is_active = CASE WHEN id = 1 THEN true ELSE false END;
SELECT setval(pg_get_serial_sequence('referral_leaderboard_periods', 'id'), GREATEST((SELECT COALESCE(MAX(id), 1) FROM referral_leaderboard_periods), 1), true);

INSERT INTO notification_preferences (user_id)
VALUES (1)
ON CONFLICT (user_id) DO NOTHING;
