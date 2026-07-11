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
  UNIQUE (user_id, device_token)
);

CREATE INDEX IF NOT EXISTS idx_push_notification_tokens_user_id
  ON push_notification_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_push_notification_tokens_active
  ON push_notification_tokens(is_active);

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

CREATE INDEX IF NOT EXISTS idx_driver_performance_scores_tier
  ON driver_performance_scores(tier);
CREATE INDEX IF NOT EXISTS idx_driver_performance_scores_score
  ON driver_performance_scores(score DESC);

CREATE TABLE IF NOT EXISTS membership_plans (
  id SERIAL PRIMARY KEY,
  plan_code VARCHAR(64) NOT NULL UNIQUE,
  plan_name VARCHAR(128) NOT NULL,
  monthly_price NUMERIC(10,2) NOT NULL DEFAULT 0,
  delivery_fee_discount NUMERIC(10,2) NOT NULL DEFAULT 0,
  priority_support BOOLEAN NOT NULL DEFAULT false,
  cashback_rate NUMERIC(10,2) NOT NULL DEFAULT 0,
  perks JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS consumer_memberships (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  plan_id INTEGER REFERENCES membership_plans(id) ON DELETE SET NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  renewal_at TIMESTAMPTZ,
  savings_ytd NUMERIC(10,2) NOT NULL DEFAULT 0,
  active_orders INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_consumer_memberships_status
  ON consumer_memberships(status);

CREATE TABLE IF NOT EXISTS consumer_reviews (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  provider_id INTEGER REFERENCES service_providers(id) ON DELETE SET NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  rating INTEGER NOT NULL DEFAULT 5,
  title VARCHAR(160),
  review_text TEXT,
  sentiment VARCHAR(32) NOT NULL DEFAULT 'positive',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_consumer_reviews_provider_id
  ON consumer_reviews(provider_id);

CREATE TABLE IF NOT EXISTS order_tracking_events (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  event_type VARCHAR(64) NOT NULL,
  status_label VARCHAR(128) NOT NULL,
  eta_minutes INTEGER,
  event_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_order_tracking_events_order_id
  ON order_tracking_events(order_id, event_time DESC);

CREATE TABLE IF NOT EXISTS experiment_rollouts (
  id SERIAL PRIMARY KEY,
  experiment_key VARCHAR(128) NOT NULL UNIQUE,
  experiment_name VARCHAR(160) NOT NULL,
  target_surface VARCHAR(160) NOT NULL,
  primary_metric VARCHAR(128) NOT NULL,
  rollout_percentage INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(32) NOT NULL DEFAULT 'draft',
  guardrails JSONB NOT NULL DEFAULT '[]'::jsonb,
  owner VARCHAR(128) NOT NULL DEFAULT 'switchos-ops',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_experiment_rollouts_status
  ON experiment_rollouts(status);

CREATE TABLE IF NOT EXISTS platform_idempotency_keys (
  id SERIAL PRIMARY KEY,
  scope VARCHAR(160) NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'in_progress',
  response_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (scope, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_platform_idempotency_keys_status
  ON platform_idempotency_keys(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS merchant_reserves (
  id SERIAL PRIMARY KEY,
  merchant_id INTEGER REFERENCES service_providers(id) ON DELETE SET NULL,
  reserve_type VARCHAR(64) NOT NULL DEFAULT 'dispute_hold',
  amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  currency VARCHAR(8) NOT NULL DEFAULT 'NGN',
  status VARCHAR(32) NOT NULL DEFAULT 'held',
  reason TEXT,
  reference_id VARCHAR(128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_merchant_reserves_status
  ON merchant_reserves(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_merchant_reserves_merchant_id
  ON merchant_reserves(merchant_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS treasury_reserves (
  id SERIAL PRIMARY KEY,
  reserve_type VARCHAR(64) NOT NULL,
  amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  currency VARCHAR(8) NOT NULL DEFAULT 'NGN',
  status VARCHAR(32) NOT NULL DEFAULT 'held',
  reason TEXT,
  reference_id VARCHAR(128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_treasury_reserves_status
  ON treasury_reserves(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS provider_catalog_items (
  id SERIAL PRIMARY KEY,
  provider_id INTEGER REFERENCES service_providers(id) ON DELETE CASCADE,
  sku VARCHAR(128) NOT NULL,
  item_name VARCHAR(255) NOT NULL,
  description TEXT,
  price NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency VARCHAR(8) NOT NULL DEFAULT 'NGN',
  is_available BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider_id, sku)
);

CREATE INDEX IF NOT EXISTS idx_provider_catalog_items_provider_id
  ON provider_catalog_items(provider_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS provider_onboarding_requests (
  id SERIAL PRIMARY KEY,
  provider_name VARCHAR(255) NOT NULL,
  vertical VARCHAR(128) NOT NULL,
  contact_name VARCHAR(255),
  contact_email VARCHAR(255),
  contact_phone VARCHAR(64),
  city VARCHAR(128),
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_provider_onboarding_requests_status
  ON provider_onboarding_requests(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS vertical_service_templates (
  id SERIAL PRIMARY KEY,
  vertical_key VARCHAR(128) NOT NULL UNIQUE,
  display_name VARCHAR(255) NOT NULL,
  service_levels JSONB NOT NULL DEFAULT '[]'::jsonb,
  dispatch_modes JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customer_service_intake_templates (
  id SERIAL PRIMARY KEY,
  channel VARCHAR(64) NOT NULL,
  intent_key VARCHAR(128) NOT NULL,
  prompt_template TEXT NOT NULL,
  escalation_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (channel, intent_key)
);

CREATE TABLE IF NOT EXISTS ledger_accounts (
  account_id TEXT PRIMARY KEY,
  balance_cents BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  transfer_id TEXT PRIMARY KEY,
  payer_id TEXT NOT NULL,
  payee_id TEXT NOT NULL,
  amount_cents BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  entry_type TEXT NOT NULL DEFAULT 'transfer',
  related_transfer_id TEXT
);

ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS entry_type TEXT NOT NULL DEFAULT 'transfer';
ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS related_transfer_id TEXT;
CREATE INDEX IF NOT EXISTS idx_ledger_entries_related_transfer ON ledger_entries (related_transfer_id);

CREATE TABLE IF NOT EXISTS mojaloop_transfers (
  transfer_id TEXT PRIMARY KEY,
  payer_fsp TEXT NOT NULL,
  payee_fsp TEXT NOT NULL,
  amount NUMERIC(18,2) NOT NULL,
  currency TEXT NOT NULL,
  ilp_packet TEXT NOT NULL,
  condition TEXT NOT NULL,
  expiration TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL,
  completed_time TIMESTAMPTZ,
  fulfilment_value TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mojaloop_quotes (
  quote_id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  payer_fsp TEXT NOT NULL,
  payee_fsp TEXT NOT NULL,
  amount NUMERIC(18,2) NOT NULL,
  currency TEXT NOT NULL,
  fees NUMERIC(18,2) NOT NULL,
  expiration TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mojaloop_refunds (
  refund_id TEXT PRIMARY KEY,
  original_transfer_id TEXT NOT NULL,
  payer_fsp TEXT NOT NULL,
  payee_fsp TEXT NOT NULL,
  amount NUMERIC(18,2) NOT NULL,
  currency TEXT NOT NULL,
  reason TEXT,
  state TEXT NOT NULL,
  completed_time TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mojaloop_idempotency_keys (
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  resource_id TEXT,
  status TEXT NOT NULL,
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (operation, idempotency_key)
);

CREATE TABLE IF NOT EXISTS mojaloop_reconciliation_audits (
  id BIGSERIAL PRIMARY KEY,
  transfer_id TEXT NOT NULL,
  transfer_state TEXT NOT NULL,
  ledger_consistent BOOLEAN NOT NULL,
  platform_refunded_amount NUMERIC(18,2) NOT NULL,
  platform_net_settled_amount NUMERIC(18,2) NOT NULL,
  details JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mojaloop_workflows (
  workflow_id TEXT PRIMARY KEY,
  workflow_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  current_step TEXT NOT NULL,
  status TEXT NOT NULL,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mojaloop_workflow_events (
  id BIGSERIAL PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  workflow_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  step TEXT NOT NULL,
  status TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mojaloop_workflow_events_workflow_id
  ON mojaloop_workflow_events (workflow_id, created_at DESC);

CREATE TABLE IF NOT EXISTS mojaloop_workflow_orchestration (
  id BIGSERIAL PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  workflow_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  orchestrator TEXT NOT NULL,
  target TEXT NOT NULL,
  status TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mojaloop_workflow_orchestration_workflow
  ON mojaloop_workflow_orchestration (workflow_id, created_at DESC);
