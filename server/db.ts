import { createHash } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { ENV } from './_core/env';
import { optimizeDispatch } from './_core/dispatchOptimizer';

let _pool: Pool | null = null;
let _db: ReturnType<typeof drizzle> | null = null;
let _platformTablesEnsured = false;

export class DatabaseUnavailableError extends Error {
  constructor(operation: string) {
    super(`DATABASE_UNAVAILABLE:${operation}`);
    this.name = "DatabaseUnavailableError";
  }
}

// Kept: pinned by tests/financial-admin.config.test.ts (bounded financial read model).
export type FinancialAdminSnapshot = {
  immutableTransfers: Array<{
    transferId: string;
    payerFsp: string;
    payeeFsp: string;
    amountMinor: string;
    currency: string;
    state: string;
    createdAt: string;
    updatedAt: string;
  }>;
  inconsistentReconciliations: Array<{
    id: string;
    transferId: string;
    transferState: string;
    platformRefundedMinor: string;
    platformNetSettledMinor: string;
    createdAt: string;
  }>;
};

export async function getFinancialAdminSnapshot(): Promise<FinancialAdminSnapshot> {
  await getDb();
  if (!_pool) throw new DatabaseUnavailableError("financial_admin_snapshot");

  const [transferResult, reconciliationResult] = await Promise.all([
    _pool.query(`SELECT transfer_id, payer_fsp, payee_fsp, amount_minor, currency, state, created_at, updated_at
      FROM mojaloop_transfers ORDER BY updated_at DESC LIMIT 100`),
    _pool.query(`SELECT id, transfer_id, transfer_state, platform_refunded_minor, platform_net_settled_minor, created_at
      FROM mojaloop_reconciliation_audits WHERE ledger_consistent = FALSE ORDER BY created_at DESC LIMIT 100`),
  ]);

  return {
    immutableTransfers: transferResult.rows.map((row) => ({
      transferId: String(row.transfer_id), payerFsp: String(row.payer_fsp), payeeFsp: String(row.payee_fsp),
      amountMinor: String(row.amount_minor), currency: String(row.currency), state: String(row.state),
      createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
    })),
    inconsistentReconciliations: reconciliationResult.rows.map((row) => ({
      id: String(row.id), transferId: String(row.transfer_id), transferState: String(row.transfer_state),
      platformRefundedMinor: String(row.platform_refunded_minor), platformNetSettledMinor: String(row.platform_net_settled_minor),
      createdAt: new Date(row.created_at).toISOString(),
    })),
  };
}

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getPool(): Promise<Pool> {
  await getDb();
  if (!_pool) throw new DatabaseUnavailableError("postgres_pool");
  return _pool;
}

export async function getDb() {
  if (!_db && ENV.databaseUrl) {
    try {
      const useSsl = ENV.isProduction && !ENV.databaseUrl.includes("sslmode=disable");
      _pool = new Pool({
        connectionString: ENV.databaseUrl,
        ssl: useSsl ? { rejectUnauthorized: true, ...(ENV.databaseSslCa ? { ca: ENV.databaseSslCa } : {}) } : false,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
        // Server-side statement timeout: a runaway query (e.g. an unbounded
        // analytics scan) can no longer pin one of the 20 pooled connections
        // indefinitely (perf audit finding 10). 15s covers the slowest
        // legitimate aggregate while staying well under client timeouts.
        options: "-c statement_timeout=15000",
      });
      _db = drizzle(_pool);
      // Production schema and reference data must be applied only through reviewed migrations.
      // Runtime bootstrap remains development-only until its legacy data is fully migrated.
      if (!ENV.isProduction) {
        await ensurePlatformTables();
      }
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
      _pool = null;
    }
  }
  return _db;
}

async function ensurePlatformTables() {
  if (!_pool || _platformTablesEnsured) {
    return;
  }

  await _pool.query(`
    ALTER TABLE loyalty_points
    ALTER COLUMN tier_progress TYPE numeric(10,2);

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
  `);

  await _pool.query(`
    INSERT INTO loyalty_rewards (reward_name, description, points_cost, reward_type, reward_value, min_tier, is_active)
    SELECT seed.reward_name, seed.description, seed.points_cost, seed.reward_type, seed.reward_value, seed.min_tier, true
    FROM (VALUES
      ('Free Delivery', 'Free delivery voucher for the next eligible order', 300, 'voucher', 'Free delivery', 'bronze'),
      ('10 Percent Off', 'Ten percent discount on a qualifying order', 500, 'discount', '10% off', 'bronze'),
      ('Priority Dispatch Pass', 'Priority dispatch boost on a future order', 900, 'priority', 'Priority dispatch', 'silver'),
      ('Airport Pickup Upgrade', 'Premium airport pickup handling', 1200, 'service', 'Airport upgrade', 'silver'),
      ('Partner Voucher', 'Partner-store voucher credit', 1800, 'voucher', '₦5,000 voucher', 'gold'),
      ('Premium Support Window', 'Dedicated operator support window', 2600, 'service', 'Priority support', 'gold'),
      ('Executive Ride Upgrade', 'Executive ride class upgrade', 4200, 'upgrade', 'Executive upgrade', 'platinum'),
      ('VIP Membership', 'VIP membership bundle with premium benefits', 8000, 'membership', 'VIP membership', 'platinum')
    ) AS seed(reward_name, description, points_cost, reward_type, reward_value, min_tier)
    WHERE NOT EXISTS (
      SELECT 1 FROM loyalty_rewards existing WHERE existing.reward_name = seed.reward_name
    );

    INSERT INTO driver_performance_scores (
      driver_id,
      score,
      tier,
      delivery_time_score,
      review_score,
      acceptance_rate,
      completion_rate,
      total_deliveries,
      on_time_deliveries,
      late_deliveries,
      cancelled_deliveries,
      last_calculated_at
    )
    SELECT
      d.id,
      LEAST(100, GREATEST(55, 55 + COALESCE(d.total_orders, 0) * 0.6 + COALESCE(CAST(d.rating AS NUMERIC), 0) * 6)) AS score,
      CASE
        WHEN COALESCE(CAST(d.rating AS NUMERIC), 0) >= 4.8 THEN 'platinum'
        WHEN COALESCE(CAST(d.rating AS NUMERIC), 0) >= 4.5 THEN 'gold'
        WHEN COALESCE(CAST(d.rating AS NUMERIC), 0) >= 4.2 THEN 'silver'
        ELSE 'bronze'
      END AS tier,
      LEAST(100, GREATEST(60, 70 + COALESCE(d.total_orders, 0) * 0.3)) AS delivery_time_score,
      LEAST(100, GREATEST(50, COALESCE(CAST(d.rating AS NUMERIC), 0) * 20)) AS review_score,
      LEAST(100, GREATEST(55, 70 + COALESCE(d.total_orders, 0) * 0.2)) AS acceptance_rate,
      LEAST(100, GREATEST(60, 75 + COALESCE(d.total_orders, 0) * 0.15)) AS completion_rate,
      COALESCE(d.total_orders, 0) AS total_deliveries,
      GREATEST(COALESCE(d.total_orders, 0) - 2, 0) AS on_time_deliveries,
      LEAST(COALESCE(d.total_orders, 0), 2) AS late_deliveries,
      0 AS cancelled_deliveries,
      NOW()
    FROM drivers d
    ON CONFLICT (driver_id) DO NOTHING;

    INSERT INTO membership_plans (plan_code, plan_name, monthly_price, delivery_fee_discount, priority_support, cashback_rate, perks)
    SELECT seed.plan_code, seed.plan_name, seed.monthly_price, seed.delivery_fee_discount, seed.priority_support, seed.cashback_rate, seed.perks::jsonb
    FROM (VALUES
      ('starter_plus', 'Starter Plus', 4.99, 1.50, false, 1.5, '["Free delivery on eligible baskets", "Loyalty booster weekends"]'),
      ('switchos_one', 'SwitchOS One', 9.99, 3.50, true, 3.0, '["Priority dispatch", "Exclusive campaigns", "Premium support"]'),
      ('switchos_black', 'SwitchOS Black', 19.99, 5.50, true, 5.0, '["VIP concierge", "Airport and premium service unlocks", "Highest cashback tier"]')
    ) AS seed(plan_code, plan_name, monthly_price, delivery_fee_discount, priority_support, cashback_rate, perks)
    WHERE NOT EXISTS (
      SELECT 1 FROM membership_plans existing WHERE existing.plan_code = seed.plan_code
    );

    INSERT INTO consumer_memberships (user_id, plan_id, status, renewal_at, savings_ytd, active_orders)
    SELECT
      u.id,
      p.id,
      CASE WHEN u.id % 5 = 0 THEN 'paused' ELSE 'active' END,
      NOW() + ((u.id % 28) + 1) * INTERVAL '1 day',
      ROUND((u.id * 3.75)::numeric, 2),
      GREATEST((u.id % 4), 0)
    FROM users u
    JOIN membership_plans p ON p.plan_code = CASE
      WHEN u.id % 3 = 0 THEN 'switchos_black'
      WHEN u.id % 2 = 0 THEN 'switchos_one'
      ELSE 'starter_plus'
    END
    WHERE NOT EXISTS (
      SELECT 1 FROM consumer_memberships cm WHERE cm.user_id = u.id
    )
    LIMIT 24;

    INSERT INTO consumer_reviews (order_id, provider_id, user_id, rating, title, review_text, sentiment)
    SELECT
      o.id,
      provider_ref.provider_id,
      user_ref.user_id,
      CASE WHEN o.id % 7 = 0 THEN 3 WHEN o.id % 5 = 0 THEN 4 ELSE 5 END,
      CASE WHEN o.id % 7 = 0 THEN 'Delivery needed attention' ELSE 'Reliable marketplace experience' END,
      CASE
        WHEN o.id % 7 = 0 THEN 'ETA slipped, but support handled the follow-up quickly and the order still arrived in acceptable condition.'
        WHEN o.id % 5 = 0 THEN 'Solid overall order with good tracking transparency and a straightforward handoff.'
        ELSE 'Fast arrival, clear tracking updates, and strong quality from the merchant and courier.'
      END,
      CASE WHEN o.id % 7 = 0 THEN 'mixed' ELSE 'positive' END
    FROM orders o
    LEFT JOIN LATERAL (
      SELECT sp.id AS provider_id
      FROM service_providers sp
      ORDER BY sp.id ASC
      OFFSET ((o.id - 1) % GREATEST((SELECT COUNT(*) FROM service_providers), 1))
      LIMIT 1
    ) provider_ref ON true
    LEFT JOIN LATERAL (
      SELECT u.id AS user_id
      FROM users u
      ORDER BY u.id ASC
      OFFSET ((o.id - 1) % GREATEST((SELECT COUNT(*) FROM users), 1))
      LIMIT 1
    ) user_ref ON true
    WHERE NOT EXISTS (
      SELECT 1 FROM consumer_reviews cr WHERE cr.order_id = o.id
    )
    LIMIT 40;

    INSERT INTO order_tracking_events (order_id, event_type, status_label, eta_minutes, event_time, metadata)
    SELECT
      o.id,
      CASE
        WHEN o.status = 'delivered' THEN 'delivered'
        WHEN o.status IN ('assigned', 'in_transit') THEN 'courier_en_route'
        WHEN o.status = 'confirmed' THEN 'merchant_preparing'
        ELSE 'order_received'
      END,
      CASE
        WHEN o.status = 'delivered' THEN 'Delivered'
        WHEN o.status IN ('assigned', 'in_transit') THEN 'Courier en route'
        WHEN o.status = 'confirmed' THEN 'Merchant preparing order'
        ELSE 'Order received'
      END,
      CASE
        WHEN o.status = 'delivered' THEN 0
        WHEN o.status IN ('assigned', 'in_transit') THEN 8 + (o.id % 19)
        WHEN o.status = 'confirmed' THEN 12 + (o.id % 15)
        ELSE 18 + (o.id % 12)
      END,
      COALESCE(o.updated_at, o.created_at, NOW()),
      jsonb_build_object('confidence', CASE WHEN o.status = 'delivered' THEN 'complete' ELSE 'high' END)
    FROM orders o
    WHERE NOT EXISTS (
      SELECT 1 FROM order_tracking_events ote WHERE ote.order_id = o.id
    )
    LIMIT 60;

    INSERT INTO experiment_rollouts (experiment_key, experiment_name, target_surface, primary_metric, rollout_percentage, status, guardrails, owner)
    SELECT seed.experiment_key, seed.experiment_name, seed.target_surface, seed.primary_metric, seed.rollout_percentage, seed.status, seed.guardrails::jsonb, seed.owner
    FROM (VALUES
      ('dispatch_risk_override', 'Dispatch risk override messaging', 'orders.dispatchControlCenter', 'assignment conversion rate', 10, 'active', '["assignment latency < 90s", "cancel rate delta < 1.5%"]', 'marketplace-ops'),
      ('merchant_reactivation_nudge', 'Merchant reactivation nudge', 'merchant.hub', 'provider activation rate', 20, 'draft', '["merchant churn delta < 2%", "promo spend within budget"]', 'growth-ops'),
      ('courier_repositioning_prompt', 'Courier repositioning prompt', 'courier.hub', 'utilization uplift', 15, 'active', '["pickup ETA delta < 2 min", "driver acceptance delta positive"]', 'dispatch-science'),
      ('membership_upgrade_offer', 'Membership upgrade offer timing', 'consumer.marketplace', 'subscription conversion rate', 5, 'paused', '["refund rate stable", "basket conversion delta non-negative"]', 'consumer-growth')
    ) AS seed(experiment_key, experiment_name, target_surface, primary_metric, rollout_percentage, status, guardrails, owner)
    WHERE NOT EXISTS (
      SELECT 1 FROM experiment_rollouts existing WHERE existing.experiment_key = seed.experiment_key
    );
  `);

  const activePeriod = await _pool.query(`SELECT id FROM referral_leaderboard_periods WHERE is_active = true LIMIT 1`);
  if (activePeriod.rows.length === 0) {
    const now = new Date();
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59));
    const periodName = `${periodStart.getUTCFullYear()}-${String(periodStart.getUTCMonth() + 1).padStart(2, '0')}`;

    await _pool.query(
      `INSERT INTO referral_leaderboard_periods (period_name, period_start, period_end, is_active)
       VALUES ($1, $2, $3, true)
       ON CONFLICT DO NOTHING`,
      [periodName, periodStart.toISOString(), periodEnd.toISOString()]
    );
  }

  _platformTablesEnsured = true;
}

// Calculate route with multiple waypoints
// Find nearest road to a given location
// Calculate estimated delivery time based on route

/**
 * Geospatial Analytics Queries
 */

// Get delivery heatmap data (clustering deliveries by location)
// Get driver density by area
// Get average delivery time by geographic area
// Get service coverage analysis
// Get delivery hotspots (areas with high order density)
// Get geospatial performance metrics

/**
 * Driver Zone Assignment & Geofencing Functions
 */

// Get all driver zones with statistics
// Find which zone a location belongs to
// Assign driver to optimal zone based on their current location
// Get driver's current zone assignment
// Rebalance zones - reassign drivers based on demand
// Check if driver is within their assigned zone (geofencing)
// Update zone statistics based on completed orders

/**
 * Traffic-Aware Routing Functions
 */

// Get current traffic conditions for a road
// Get all current traffic conditions
// Update traffic conditions for a road
// Calculate traffic-aware route with adjusted costs
// Get traffic incidents
// Calculate ETA with traffic

// Historical Traffic Analysis Functions

// ==================== DRIVER PERFORMANCE SCORING ====================

export async function getDriverPerformanceScore(driverId: number) {
  if (!_pool) return null;

  const result = await _pool.query(
    'SELECT * FROM driver_performance_scores WHERE driver_id = $1',
    [driverId]
  );
  return result.rows[0] || null;
}

export async function getDriverMarketplaceProfile(driverId: number) {
  await getDb();
  if (!_pool) return null;

  const result = await _pool.query<any>(`
    WITH recent_orders AS (
      SELECT
        o.*,
        COALESCE(EXTRACT(EPOCH FROM (o.actual_delivery_time - COALESCE(o.actual_pickup_time, o.scheduled_pickup_time))) / 3600.0, 0) AS active_hours,
        CASE WHEN COALESCE(o.actual_delivery_time, o.estimated_delivery_time) >= COALESCE(o.scheduled_pickup_time, o.created_at) + INTERVAL '60 minutes' THEN 1 ELSE 0 END AS long_trip,
        CASE WHEN COALESCE(o.notes, '') ILIKE '%stop%' THEN 1 ELSE 0 END AS multi_stop
      FROM orders o
      WHERE o.driver_id = $1
        AND o.created_at >= NOW() - INTERVAL '30 days'
    ),
    financials AS (
      SELECT
        COALESCE(SUM(CAST(total_amount AS NUMERIC)), 0) AS gross_revenue,
        COALESCE(SUM(CAST(platform_fee AS NUMERIC)), 0) AS platform_margin,
        COALESCE(SUM(CAST(driver_fee AS NUMERIC)), 0) AS driver_payout
      FROM recent_orders
      WHERE status IN ('delivered', 'refunded')
    ),
    order_stats AS (
      SELECT
        COUNT(*) AS total_jobs,
        COUNT(*) FILTER (WHERE status = 'delivered') AS delivered_jobs,
        COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_jobs,
        COALESCE(SUM(active_hours) FILTER (WHERE status = 'delivered'), 0) AS active_hours,
        COALESCE(SUM(long_trip), 0) AS long_trip_jobs,
        COALESCE(SUM(multi_stop), 0) AS multi_stop_jobs
      FROM recent_orders
    )
    SELECT
      d.id AS driver_id,
      d.name AS driver_name,
      d.status AS driver_status,
      COALESCE(dps.tier, 'bronze') AS tier,
      COALESCE(dps.acceptance_rate, 0) AS acceptance_rate,
      COALESCE(dps.completion_rate, 0) AS completion_rate,
      os.total_jobs,
      os.delivered_jobs,
      os.cancelled_jobs,
      os.active_hours,
      GREATEST(os.active_hours + (os.total_jobs * 0.35) + 4, 1) AS online_hours,
      f.gross_revenue,
      f.platform_margin,
      f.driver_payout,
      os.long_trip_jobs,
      os.multi_stop_jobs
    FROM drivers d
    LEFT JOIN driver_performance_scores dps ON dps.driver_id = d.id
    CROSS JOIN order_stats os
    CROSS JOIN financials f
    WHERE d.id = $1
    LIMIT 1
  `, [driverId]);

  const row = result.rows[0];
  if (!row) return null;

  const activeHours = Number(row.active_hours || 0);
  const onlineHours = Number(row.online_hours || 1);
  const platformMargin = Number(row.platform_margin || 0);
  const grossRevenue = Number(row.gross_revenue || 0);
  const totalJobs = Number(row.total_jobs || 0);
  const utilizationRate = onlineHours > 0 ? (activeHours / onlineHours) * 100 : 0;
  const marginPerActiveHour = activeHours > 0 ? platformMargin / activeHours : platformMargin;
  const marginPerOnlineHour = onlineHours > 0 ? platformMargin / onlineHours : platformMargin;
  const longTripShare = totalJobs > 0 ? (Number(row.long_trip_jobs || 0) / totalJobs) * 100 : 0;
  const multiStopShare = totalJobs > 0 ? (Number(row.multi_stop_jobs || 0) / totalJobs) * 100 : 0;
  const cherryPickRisk = Number(row.acceptance_rate || 0) < 45 || utilizationRate < 35
    ? 'high'
    : Number(row.acceptance_rate || 0) < 70 || utilizationRate < 55
      ? 'medium'
      : 'low';

  return {
    driver_id: row.driver_id,
    driver_name: row.driver_name,
    driver_status: row.driver_status,
    tier: row.tier,
    acceptance_rate: Number(row.acceptance_rate || 0),
    completion_rate: Number(row.completion_rate || 0),
    total_jobs: totalJobs,
    delivered_jobs: Number(row.delivered_jobs || 0),
    cancelled_jobs: Number(row.cancelled_jobs || 0),
    active_hours: Number(activeHours.toFixed(2)),
    online_hours: Number(onlineHours.toFixed(2)),
    utilization_rate: Number(utilizationRate.toFixed(2)),
    gross_revenue: Number(grossRevenue.toFixed(2)),
    platform_margin: Number(platformMargin.toFixed(2)),
    driver_payout: Number(Number(row.driver_payout || 0).toFixed(2)),
    margin_per_active_hour: Number(marginPerActiveHour.toFixed(2)),
    margin_per_online_hour: Number(marginPerOnlineHour.toFixed(2)),
    long_trip_share: Number(longTripShare.toFixed(2)),
    multi_stop_share: Number(multiStopShare.toFixed(2)),
    cherry_pick_risk: cherryPickRisk,
    dispatch_priority_band: row.tier === 'platinum' ? 'priority' : row.tier === 'gold' ? 'accelerated' : 'standard',
  };
}

export async function getDriverDispatchRecommendation(driverId: number) {
  await getDb();
  if (!_pool) return null;

  const profile = await getDriverMarketplaceProfile(driverId);
  if (!profile) return null;

  const result = await _pool.query<any>(`
    SELECT
      d.id AS driver_id,
      d.name,
      COALESCE(dps.tier, 'bronze') AS tier,
      COALESCE(dps.acceptance_rate, 65) AS acceptance_rate,
      COALESCE(dps.completion_rate, 85) AS completion_rate,
      COALESCE(dps.review_score, 4.5) AS rating,
      LEAST(
        95,
        GREATEST(
          15,
          COALESCE((
            SELECT CASE
              WHEN COUNT(*) = 0 THEN 55
              ELSE SUM(
                COALESCE(EXTRACT(EPOCH FROM (o.actual_delivery_time - COALESCE(o.actual_pickup_time, o.scheduled_pickup_time))) / 3600.0, 0)
              ) / GREATEST(COUNT(*) * 0.4 + 4, 1) * 100
            END
            FROM orders o
            WHERE o.driver_id = d.id
              AND o.created_at >= NOW() - INTERVAL '30 days'
          ), 55)
        )
      ) AS utilization_rate,
      GREATEST(0, COALESCE((
        SELECT EXTRACT(EPOCH FROM (NOW() - MAX(o.updated_at))) / 60.0
        FROM orders o
        WHERE o.driver_id = d.id
      ), 30)) AS idle_minutes,
      GREATEST(0, (
        SELECT COUNT(*)
        FROM orders o
        WHERE o.driver_id = d.id
          AND o.status = 'cancelled'
          AND o.created_at >= NOW() - INTERVAL '14 days'
      )) AS recent_rejections,
      CASE WHEN d.status = 'busy' THEN true ELSE false END AS on_trip,
      ABS(d.id - $1) * 0.8 + CASE WHEN d.id = $1 THEN 1 ELSE 3 END AS distance_km
    FROM drivers d
    LEFT JOIN driver_performance_scores dps ON dps.driver_id = d.id
    WHERE d.status IN ('online', 'busy')
    ORDER BY CASE WHEN d.id = $1 THEN 0 ELSE 1 END, COALESCE(dps.score, 0) DESC
    LIMIT 8
  `, [driverId]);

  const candidateInputs = result.rows.map((row: any) => ({
    id: Number(row.driver_id),
    rating: Number(row.rating || 4.5),
    acceptanceRate: Number(row.acceptance_rate || 0),
    completionRate: Number(row.completion_rate || 0),
    distanceKm: Number(row.distance_km || 0),
    etaMinutes: Math.max(5, Number(row.distance_km || 0) * 4),
    earningsPerHour: Math.max(10, Number(profile.margin_per_active_hour || 0) * 0.65 + Number(row.utilization_rate || 0) * 0.35),
  }));

  const optimized = optimizeDispatch(candidateInputs);
  const rankedCandidates = optimized.rankedCandidates.map((candidate) => {
    const source = result.rows.find((row: any) => Number(row.driver_id) === Number(candidate.id));
    const acceptanceRate = Number(source?.acceptance_rate || candidate.acceptanceRate || 0);
    const idleMinutes = Number(source?.idle_minutes || 0);
    const recentRejections = Number(source?.recent_rejections || 0);
    const compensationMultiplier = Number(
      Math.min(
        1.75,
        Math.max(
          0.9,
          1 + (idleMinutes >= 25 ? 0.15 : 0) + (acceptanceRate < 55 ? 0.2 : 0) + (profile.long_trip_share >= 35 ? 0.1 : 0),
        ),
      ).toFixed(2),
    );

    return {
      driver_id: Number(candidate.id),
      driver_name: source?.name,
      tier: source?.tier,
      score: candidate.score,
      acceptance_rate: acceptanceRate,
      completion_rate: Number(source?.completion_rate || candidate.completionRate || 0),
      distance_km: Number(source?.distance_km || candidate.distanceKm || 0),
      eta_minutes: Number(candidate.etaMinutes || 0),
      idle_minutes: idleMinutes,
      on_trip: Boolean(source?.on_trip),
      recent_rejections: recentRejections,
      compensation_multiplier: compensationMultiplier,
      cherry_pick_risk:
        recentRejections >= 3 || acceptanceRate < 45
          ? 'high'
          : recentRejections >= 1 || acceptanceRate < 65
            ? 'medium'
            : 'low',
    };
  });

  return {
    marketplace_profile: profile,
    optimization: {
      strategy: profile.long_trip_share >= 35 ? 'long-haul retention' : 'balanced marketplace dispatch',
      recommended_driver_id: optimized.recommendedDriverId,
      ranked_candidates: rankedCandidates,
      batching_eligible: optimized.batchingEligible,
      reasoning: optimized.reasoning,
      supply_level: Math.max(result.rows.filter((row: any) => !row.on_trip).length, 1),
      demand_level: Math.max(profile.total_jobs, 1),
    },
  };
}


// ============================================================================
// Driver Incentives & Payouts
// ============================================================================

export async function getDriverIncentives(driverId: number, status?: string) {
  await getDb();
  if (!_pool) return [];

  let query = 'SELECT * FROM driver_incentives WHERE driver_id = $1';
  const params: any[] = [driverId];

  if (status) {
    query += ' AND status = $2';
    params.push(status);
  }

  query += ' ORDER BY earned_at DESC';

  const result = await _pool.query<any>(query, params);
  return result.rows;
}

function hashPlatformIdempotencyRequest(payload: unknown) {
  return createHash("sha256").update(JSON.stringify(payload ?? null)).digest("hex");
}

async function beginPlatformIdempotentOperation(
  client: { query: (text: string, params?: any[]) => Promise<any> },
  scope: string,
  idempotencyKey: string | undefined,
  payload: unknown,
) {
  if (!idempotencyKey?.trim()) {
    return { replay: false as const, response: null, normalizedKey: null as string | null };
  }

  const normalizedKey = idempotencyKey.trim();
  const requestHash = hashPlatformIdempotencyRequest(payload);
  const insertResult = await client.query(
    `INSERT INTO platform_idempotency_keys (scope, idempotency_key, request_hash, status)
     VALUES ($1, $2, $3, 'in_progress')
     ON CONFLICT (scope, idempotency_key) DO NOTHING
     RETURNING id`,
    [scope, normalizedKey, requestHash],
  );

  if (insertResult.rows.length > 0) {
    return { replay: false as const, response: null, normalizedKey };
  }

  const existingResult = await client.query(
    `SELECT request_hash, status, response_payload
     FROM platform_idempotency_keys
     WHERE scope = $1 AND idempotency_key = $2`,
    [scope, normalizedKey],
  );

  const existing = existingResult.rows[0];
  if (!existing) {
    return { replay: false as const, response: null, normalizedKey };
  }

  if (existing.request_hash !== requestHash) {
    throw new Error(`Idempotency key reuse detected for ${scope} with a different request payload.`);
  }

  if (existing.status === 'completed') {
    return { replay: true as const, response: existing.response_payload ?? null, normalizedKey };
  }

  throw new Error(`Operation ${scope} is already in progress for this idempotency key.`);
}

async function finalizePlatformIdempotentOperation(
  client: { query: (text: string, params?: any[]) => Promise<any> },
  scope: string,
  idempotencyKey: string | undefined,
  status: 'completed' | 'failed',
  response: unknown,
) {
  if (!idempotencyKey?.trim()) {
    return;
  }

  await client.query(
    `UPDATE platform_idempotency_keys
     SET status = $3,
         response_payload = $4::jsonb,
         updated_at = NOW()
     WHERE scope = $1 AND idempotency_key = $2`,
    [scope, idempotencyKey.trim(), status, JSON.stringify(response ?? null)],
  );
}

function hashFinanceIdempotencyRequest(payload: unknown) {
  return hashPlatformIdempotencyRequest(payload);
}

async function beginFinanceIdempotentOperation(
  client: { query: (text: string, params?: any[]) => Promise<any> },
  scope: string,
  idempotencyKey: string | undefined,
  payload: unknown,
) {
  return beginPlatformIdempotentOperation(client, scope, idempotencyKey, payload);
}

async function finalizeFinanceIdempotentOperation(
  client: { query: (text: string, params?: any[]) => Promise<any> },
  scope: string,
  idempotencyKey: string | undefined,
  status: 'completed' | 'failed',
  response: unknown,
) {
  return finalizePlatformIdempotentOperation(client, scope, idempotencyKey, status, response);
}

async function ensureLoyaltyAccountForClient(
  client: { query: (text: string, params?: any[]) => Promise<any> },
  userId: number,
) {
  await client.query(
    `INSERT INTO loyalty_points (user_id, points_balance, lifetime_points, tier, tier_progress, next_tier_threshold)
     VALUES ($1, 0, 0, 'bronze', 0, $2)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId, TIER_THRESHOLDS.silver],
  );
}

async function checkAndUpgradeTierForClient(
  client: { query: (text: string, params?: any[]) => Promise<any> },
  userId: number,
  lifetimePoints: number,
) {
  let newTier = 'bronze';
  let nextThreshold = TIER_THRESHOLDS.silver;

  if (lifetimePoints >= TIER_THRESHOLDS.platinum) {
    newTier = 'platinum';
    nextThreshold = 0;
  } else if (lifetimePoints >= TIER_THRESHOLDS.gold) {
    newTier = 'gold';
    nextThreshold = TIER_THRESHOLDS.platinum;
  } else if (lifetimePoints >= TIER_THRESHOLDS.silver) {
    newTier = 'silver';
    nextThreshold = TIER_THRESHOLDS.gold;
  }

  const progress = nextThreshold > 0 ? lifetimePoints - TIER_THRESHOLDS[newTier as keyof typeof TIER_THRESHOLDS] : 0;

  await client.query(
    `UPDATE loyalty_points
     SET tier = $1,
         tier_progress = $2,
         next_tier_threshold = $3,
         updated_at = NOW()
     WHERE user_id = $4`,
    [newTier, progress, nextThreshold, userId],
  );
}

async function awardPointsTransactional(
  client: { query: (text: string, params?: any[]) => Promise<any> },
  userId: number,
  points: number,
  transactionType: string,
  description: string,
  orderId?: number,
) {
  let updateResult = await client.query(
    `UPDATE loyalty_points
     SET points_balance = points_balance + $1,
         lifetime_points = lifetime_points + $1,
         updated_at = NOW()
     WHERE user_id = $2
     RETURNING *`,
    [points, userId],
  );

  if (updateResult.rows.length === 0) {
    await ensureLoyaltyAccountForClient(client, userId);
    updateResult = await client.query(
      `UPDATE loyalty_points
       SET points_balance = points_balance + $1,
           lifetime_points = lifetime_points + $1,
           updated_at = NOW()
       WHERE user_id = $2
       RETURNING *`,
      [points, userId],
    );
  }

  const account = updateResult.rows[0];
  await checkAndUpgradeTierForClient(client, userId, account.lifetime_points);

  await client.query(
    `INSERT INTO loyalty_transactions (user_id, transaction_type, points, order_id, description)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, transactionType, points, orderId, description],
  );

  return account;
}

// Settlement windows are UTC half-open intervals [periodStart, periodEnd):
// periodStart is the first instant of the month (UTC) and periodEnd is the
// first instant of the following month (UTC, exclusive). Computed with
// Date.UTC so results are independent of the server-local timezone.
export function computeSettlementPeriodUtc(month: number, year: number): { periodStart: Date; periodEnd: Date } {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`Invalid settlement month: ${month}`);
  }
  if (!Number.isInteger(year)) {
    throw new Error(`Invalid settlement year: ${year}`);
  }
  return {
    periodStart: new Date(Date.UTC(year, month - 1, 1)),
    periodEnd: new Date(Date.UTC(year, month, 1)),
  };
}

export async function generateMonthlySettlement(driverId: number, month: number, year: number, idempotencyKey?: string) {
  await getDb();
  if (!_pool) return null;

  const { periodStart, periodEnd } = computeSettlementPeriodUtc(month, year);

  const client = await _pool.connect();
  let idempotencyClaimed = false;
  try {
    await client.query('BEGIN');

    const idempotency = await beginFinanceIdempotentOperation(
      client,
      'settlement.generate_monthly',
      idempotencyKey,
      { driverId, month, year },
    );
    idempotencyClaimed = Boolean(idempotency.normalizedKey) && !idempotency.replay;
    if (idempotency.replay) {
      await client.query('COMMIT');
      return idempotency.response;
    }

    // Defense in depth against concurrent settlement workers/retries: a
    // transaction-scoped advisory lock keyed on driver + period serializes
    // settle operations for the same window. The unique index on
    // (driver_id, period_start, period_end) plus ON CONFLICT DO NOTHING below
    // remains the hard guarantee if the lock is ever bypassed.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [`settlement:${driverId}:${periodStart.toISOString()}:${periodEnd.toISOString()}`],
    );

    const existingSettlement = await client.query<any>(
      `SELECT * FROM payout_settlements
       WHERE driver_id = $1
         AND period_start = $2
         AND period_end = $3
       FOR UPDATE`,
      [driverId, periodStart, periodEnd]
    );
    if (existingSettlement.rows.length > 0) {
      await finalizeFinanceIdempotentOperation(client, 'settlement.generate_monthly', idempotencyKey, 'completed', existingSettlement.rows[0]);
      await client.query('COMMIT');
      return existingSettlement.rows[0];
    }

    const earningsResult = await client.query<any>(
      `SELECT COALESCE(SUM(driver_fee), 0) as base_earnings
       FROM orders
       WHERE driver_id = $1
         AND status = 'delivered'
         AND actual_delivery_time >= $2
         AND actual_delivery_time < $3`,
      [driverId, periodStart, periodEnd]
    );

    // Aggregate over GROUPed/filtered rows: FOR UPDATE is invalid (and
    // ignored/rejected by PostgreSQL) here. Concurrency safety comes from the
    // advisory lock above and the unique index below; the incentive rows are
    // claimed by the UPDATE ... settlement_id IS NULL that follows.
    const bonusResult = await client.query<any>(
      `SELECT COALESCE(SUM(amount), 0) as bonus_amount
       FROM driver_incentives
       WHERE driver_id = $1
         AND status = 'approved'
         AND settlement_id IS NULL
         AND earned_at >= $2
         AND earned_at < $3`,
      [driverId, periodStart, periodEnd]
    );

    const baseEarnings = parseFloat(earningsResult.rows[0].base_earnings) || 0;
    const bonusAmount = parseFloat(bonusResult.rows[0].bonus_amount) || 0;
    const totalAmount = baseEarnings + bonusAmount;

    const result = await client.query<any>(
      `INSERT INTO payout_settlements
       (driver_id, period_start, period_end, base_earnings, bonus_amount, total_amount, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (driver_id, period_start, period_end) DO NOTHING
       RETURNING *`,
      [driverId, periodStart, periodEnd, baseEarnings, bonusAmount, totalAmount, 'pending']
    );

    if (result.rows.length === 0) {
      // A concurrent settle operation already inserted this window: treat as
      // already-settled and skip the payout leg entirely (idempotent retry).
      const settled = await client.query<any>(
        `SELECT * FROM payout_settlements
         WHERE driver_id = $1
           AND period_start = $2
           AND period_end = $3`,
        [driverId, periodStart, periodEnd]
      );
      const settledRow = settled.rows[0] ?? null;
      await finalizeFinanceIdempotentOperation(client, 'settlement.generate_monthly', idempotencyKey, 'completed', settledRow);
      await client.query('COMMIT');
      return settledRow;
    }

    await client.query<any>(
      `UPDATE driver_incentives
       SET settlement_id = $1
       WHERE driver_id = $2
         AND status = 'approved'
         AND settlement_id IS NULL
         AND earned_at >= $3
         AND earned_at < $4`,
      [result.rows[0].id, driverId, periodStart, periodEnd]
    );

    await finalizeFinanceIdempotentOperation(client, 'settlement.generate_monthly', idempotencyKey, 'completed', result.rows[0]);
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    if (idempotencyClaimed) {
      await finalizeFinanceIdempotentOperation(
        client,
        'settlement.generate_monthly',
        idempotencyKey,
        'failed',
        { error: error instanceof Error ? error.message : String(error) },
      ).catch(() => undefined);
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function getDriverSettlements(driverId: number) {
  await getDb();
  if (!_pool) return [];

  const result = await _pool.query<any>(
    `SELECT * FROM payout_settlements
     WHERE driver_id = $1
     ORDER BY period_end DESC`,
    [driverId]
  );

  return result.rows;
}

export async function approveSettlement(settlementId: number, approvedBy: number, idempotencyKey?: string) {
  await getDb();
  if (!_pool) return false;

  const client = await _pool.connect();
  let idempotencyClaimed = false;
  try {
    await client.query('BEGIN');

    const idempotency = await beginFinanceIdempotentOperation(
      client,
      'settlement.approve',
      idempotencyKey,
      { settlementId, approvedBy },
    );
    idempotencyClaimed = Boolean(idempotency.normalizedKey) && !idempotency.replay;
    if (idempotency.replay) {
      await client.query('COMMIT');
      return Boolean(idempotency.response);
    }

    const existingResult = await client.query<any>(
      `SELECT id, status, approved_by
       FROM payout_settlements
       WHERE id = $1
       FOR UPDATE`,
      [settlementId],
    );

    const existing = existingResult.rows[0];
    if (!existing) {
      await finalizeFinanceIdempotentOperation(client, 'settlement.approve', idempotencyKey, 'completed', false);
      await client.query('COMMIT');
      return false;
    }

    if (existing.status === 'approved' && Number(existing.approved_by || 0) === approvedBy) {
      await finalizeFinanceIdempotentOperation(client, 'settlement.approve', idempotencyKey, 'completed', true);
      await client.query('COMMIT');
      return true;
    }

    if (existing.status !== 'pending') {
      await finalizeFinanceIdempotentOperation(client, 'settlement.approve', idempotencyKey, 'completed', false);
      await client.query('COMMIT');
      return false;
    }

    const result = await client.query<any>(
      `UPDATE payout_settlements
       SET status = 'approved',
           approved_by = $1,
           approved_at = NOW()
       WHERE id = $2
         AND status = 'pending'
       RETURNING *`,
      [approvedBy, settlementId]
    );

    const approved = result.rows.length > 0;
    await finalizeFinanceIdempotentOperation(client, 'settlement.approve', idempotencyKey, 'completed', approved);
    await client.query('COMMIT');
    return approved;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    if (idempotencyClaimed) {
      await finalizeFinanceIdempotentOperation(
        client,
        'settlement.approve',
        idempotencyKey,
        'failed',
        { error: error instanceof Error ? error.message : String(error) },
      ).catch(() => undefined);
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function processSettlement(
  settlementId: number,
  paymentMethod: string,
  paymentReference: string,
  idempotencyKey?: string,
) {
  await getDb();
  if (!_pool) return false;

  const client = await _pool.connect();
  let idempotencyClaimed = false;
  try {
    await client.query('BEGIN');

    const idempotency = await beginFinanceIdempotentOperation(
      client,
      'settlement.process',
      idempotencyKey,
      { settlementId, paymentMethod, paymentReference },
    );
    idempotencyClaimed = Boolean(idempotency.normalizedKey) && !idempotency.replay;
    if (idempotency.replay) {
      await client.query('COMMIT');
      return Boolean(idempotency.response);
    }

    const existingResult = await client.query<any>(
      `SELECT id, status, payment_method, payment_reference
       FROM payout_settlements
       WHERE id = $1
       FOR UPDATE`,
      [settlementId],
    );

    const existing = existingResult.rows[0];
    if (!existing) {
      await finalizeFinanceIdempotentOperation(client, 'settlement.process', idempotencyKey, 'completed', false);
      await client.query('COMMIT');
      return false;
    }

    if (
      existing.status === 'completed'
      && existing.payment_method === paymentMethod
      && existing.payment_reference === paymentReference
    ) {
      await finalizeFinanceIdempotentOperation(client, 'settlement.process', idempotencyKey, 'completed', true);
      await client.query('COMMIT');
      return true;
    }

    if (existing.status !== 'approved') {
      await finalizeFinanceIdempotentOperation(client, 'settlement.process', idempotencyKey, 'completed', false);
      await client.query('COMMIT');
      return false;
    }

    const settlementResult = await client.query<any>(
      `UPDATE payout_settlements
       SET status = 'completed',
           processed_at = NOW(),
           payment_method = $1,
           payment_reference = $2
       WHERE id = $3
         AND status = 'approved'
       RETURNING *`,
      [paymentMethod, paymentReference, settlementId]
    );

    if (settlementResult.rows.length === 0) {
      await finalizeFinanceIdempotentOperation(client, 'settlement.process', idempotencyKey, 'completed', false);
      await client.query('COMMIT');
      return false;
    }

    await client.query<any>(
      `UPDATE driver_incentives
       SET status = 'paid',
           paid_at = NOW()
       WHERE settlement_id = $1
         AND status = 'approved'`,
      [settlementId]
    );

    await finalizeFinanceIdempotentOperation(client, 'settlement.process', idempotencyKey, 'completed', true);
    await client.query('COMMIT');
    return true;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    if (idempotencyClaimed) {
      await finalizeFinanceIdempotentOperation(
        client,
        'settlement.process',
        idempotencyKey,
        'failed',
        { error: error instanceof Error ? error.message : String(error) },
      ).catch(() => undefined);
    }
    throw error;
  } finally {
    client.release();
  }
}

// Deterministic refund idempotency key derived from order + amount + reason,
// used when the caller does not supply one. transactions.transaction_id is
// UNIQUE, so this key doubles as the insert guard against double-crediting.
export function deriveRefundIdempotencyKey(orderId: number, amount: string, reason: string): string {
  return `refund:${createHash('sha256').update(`order:${orderId}|amount:${amount}|reason:${reason}`).digest('hex')}`;
}

// Refund an order payment exactly once. Retries (client or worker) with the
// same idempotency key — client-supplied or derived from order+amount+reason —
// replay the original refund instead of double-crediting the customer.
// The customer notification is NOT sent inline: a notification event is
// written to the funds outbox in the SAME transaction as the refund ledger
// row and the order state change, so a notification-dispatch failure can
// never leave committed state without its notification (or vice versa).
export async function refundOrderPayment(
  orderId: number,
  amount: number | string,
  reason: string,
  idempotencyKey?: string,
) {
  await getDb();
  if (!_pool) return null;

  const parsedAmount = typeof amount === 'number' ? amount : parseFloat(String(amount));
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    throw new Error('Refund amount must be a positive number');
  }
  const amountText = parsedAmount.toFixed(2);
  const trimmedReason = String(reason ?? '').trim();
  if (!trimmedReason) {
    throw new Error('Refund reason is required');
  }

  const refundKey = idempotencyKey?.trim() || deriveRefundIdempotencyKey(orderId, amountText, trimmedReason);

  const client = await _pool.connect();
  let idempotencyClaimed = false;
  try {
    await client.query('BEGIN');

    const idempotency = await beginFinanceIdempotentOperation(
      client,
      'refund.order',
      refundKey,
      { orderId, amount: amountText, reason: trimmedReason },
    );
    idempotencyClaimed = Boolean(idempotency.normalizedKey) && !idempotency.replay;
    if (idempotency.replay) {
      await client.query('COMMIT');
      return idempotency.response;
    }

    // Serialize refund attempts for this order+key across workers.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [`refund:${orderId}:${refundKey}`],
    );

    const orderResult = await client.query<any>(
      `SELECT id, customer_id, status FROM orders WHERE id = $1 FOR UPDATE`,
      [orderId],
    );
    const order = orderResult.rows[0];
    if (!order) {
      throw new Error(`Order ${orderId} not found`);
    }

    const insertResult = await client.query<any>(
      `INSERT INTO transactions
       (transaction_id, order_id, type, amount, currency, status, recipient_type, recipient_id, metadata)
       VALUES ($1, $2, 'refund', $3, 'EUR', 'completed', 'customer', $4, $5)
       ON CONFLICT (transaction_id) DO NOTHING
       RETURNING *`,
      [refundKey, orderId, amountText, order.customer_id ?? null, JSON.stringify({ reason: trimmedReason })],
    );

    let refundRow = insertResult.rows[0];
    if (!refundRow) {
      // transaction_id conflict: this refund was already applied by an
      // earlier attempt — replay it instead of crediting twice.
      const existingRefund = await client.query<any>(
        `SELECT * FROM transactions WHERE transaction_id = $1`,
        [refundKey],
      );
      refundRow = existingRefund.rows[0] ?? null;
    } else {
      await client.query<any>(
        `UPDATE orders
         SET status = 'refunded', updated_at = NOW()
         WHERE id = $1 AND status <> 'refunded'`,
        [orderId],
      );

      // Transactional outbox: notification dispatched asynchronously by the
      // outbox worker; ON CONFLICT guards against duplicate dispatch on retry.
      await client.query<any>(
        `INSERT INTO mojaloop_funds_outbox
         (event_id, destination, idempotency_key, workflow_id, workflow_type, resource_id, step, workflow_status, payload)
         VALUES ($1, 'notification', $2, $3, 'refund', $4, 'notify_customer', 'completed', $5::jsonb)
         ON CONFLICT (destination, idempotency_key) DO NOTHING`,
        [
          `refund-notify:${refundKey}`,
          `refund-notify:${refundKey}`,
          `refund-order:${orderId}`,
          String(orderId),
          JSON.stringify({
            orderId,
            transactionId: refundRow.id ?? null,
            customerId: order.customer_id ?? null,
            amount: amountText,
            currency: 'EUR',
            reason: trimmedReason,
            notificationType: 'refund_completed',
          }),
        ],
      );
    }

    await finalizeFinanceIdempotentOperation(client, 'refund.order', refundKey, 'completed', refundRow);
    await client.query('COMMIT');
    return refundRow;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    if (idempotencyClaimed) {
      await finalizeFinanceIdempotentOperation(
        client,
        'refund.order',
        refundKey,
        'failed',
        { error: error instanceof Error ? error.message : String(error) },
      ).catch(() => undefined);
    }
    throw error;
  } finally {
    client.release();
  }
}


// ============================================================================
// Customer Loyalty Program
// ============================================================================

const TIER_THRESHOLDS = {
  bronze: 0,
  silver: 1000,
  gold: 5000,
  platinum: 15000,
};

export async function initializeLoyaltyAccount(userId: number) {
  await getDb();
  if (!_pool) return null;

  const result = await _pool.query<any>(
    `INSERT INTO loyalty_points (user_id, points_balance, lifetime_points, tier, tier_progress, next_tier_threshold)
     VALUES ($1, 0, 0, 'bronze', 0, $2)
     ON CONFLICT (user_id) DO NOTHING
     RETURNING *`,
    [userId, TIER_THRESHOLDS.silver]
  );

  if (result.rows[0]) {
    return {
      ...result.rows[0],
      status: 'active',
    };
  }

  const existing = await _pool.query<any>(
    `SELECT * FROM loyalty_points WHERE user_id = $1 LIMIT 1`,
    [userId]
  );

  return existing.rows[0] || null;
}

export async function getLoyaltyAccount(userId: number) {
  await getDb();
  if (!_pool) return null;

  const result = await _pool.query<any>(
    'SELECT * FROM loyalty_points WHERE user_id = $1',
    [userId]
  );

  if (result.rows.length === 0) {
    return await initializeLoyaltyAccount(userId);
  }

  return result.rows[0];
}

export async function awardPoints(
  userId: number,
  points: number,
  transactionType: string,
  description: string,
  orderId?: number
) {
  await getDb();
  if (!_pool) return null;

  const client = await _pool.connect();
  try {
    await client.query('BEGIN');
    await awardPointsTransactional(client, userId, points, transactionType, description, orderId);
    await client.query('COMMIT');
    return await getLoyaltyAccount(userId);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function checkAndUpgradeTier(userId: number, lifetimePoints: number) {
  let newTier = 'bronze';
  let nextThreshold = TIER_THRESHOLDS.silver;

  if (lifetimePoints >= TIER_THRESHOLDS.platinum) {
    newTier = 'platinum';
    nextThreshold = 0; // Max tier
  } else if (lifetimePoints >= TIER_THRESHOLDS.gold) {
    newTier = 'gold';
    nextThreshold = TIER_THRESHOLDS.platinum;
  } else if (lifetimePoints >= TIER_THRESHOLDS.silver) {
    newTier = 'silver';
    nextThreshold = TIER_THRESHOLDS.gold;
  }

  const progress = nextThreshold > 0 ? lifetimePoints - TIER_THRESHOLDS[newTier as keyof typeof TIER_THRESHOLDS] : 0;

  await _pool!.query<any>(
    `UPDATE loyalty_points
     SET tier = $1,
         tier_progress = $2,
         next_tier_threshold = $3
     WHERE user_id = $4`,
    [newTier, progress, nextThreshold, userId]
  );
}

export async function redeemPoints(userId: number, rewardId: number, idempotencyKey?: string) {
  await getDb();
  if (!_pool) return null;

  const client = await _pool.connect();
  let idempotencyClaimed = false;

  try {
    await client.query('BEGIN');
    const idempotency = await beginPlatformIdempotentOperation(
      client,
      'loyalty.redeem',
      idempotencyKey,
      { userId, rewardId },
    );
    idempotencyClaimed = Boolean(idempotency.normalizedKey) && !idempotency.replay;
    if (idempotency.replay) {
      await client.query('COMMIT');
      return idempotency.response;
    }

    const rewardResult = await client.query<any>(
      'SELECT * FROM loyalty_rewards WHERE id = $1 AND is_active = true',
      [rewardId],
    );

    if (rewardResult.rows.length === 0) {
      throw new Error('Reward not found or inactive');
    }

    const reward = rewardResult.rows[0];
    const accountResult = await client.query<any>(
      'SELECT * FROM loyalty_points WHERE user_id = $1 FOR UPDATE',
      [userId],
    );
    const account = accountResult.rows[0];

    if (!account || Number(account.points_balance) < Number(reward.points_cost)) {
      throw new Error('Insufficient points');
    }

    if (reward.min_tier) {
      const tierOrder = ['bronze', 'silver', 'gold', 'platinum'];
      if (tierOrder.indexOf(account.tier) < tierOrder.indexOf(reward.min_tier)) {
        throw new Error('Tier requirement not met');
      }
    }

    const debitResult = await client.query<any>(
      `UPDATE loyalty_points
       SET points_balance = points_balance - $1,
           updated_at = NOW()
       WHERE user_id = $2
         AND points_balance >= $1
       RETURNING *`,
      [reward.points_cost, userId],
    );

    if (debitResult.rows.length === 0) {
      throw new Error('Insufficient points');
    }

    await client.query<any>(
      `INSERT INTO loyalty_transactions (user_id, transaction_type, points, description)
       VALUES ($1, 'redeem', $2, $3)`,
      [userId, -reward.points_cost, `Redeemed: ${reward.reward_name}`],
    );

    const voucherCode = `REWARD-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    const redemptionResult = await client.query<any>(
      `INSERT INTO loyalty_redemptions
       (user_id, reward_id, points_spent, status, voucher_code, expires_at)
       VALUES ($1, $2, $3, 'approved', $4, $5)
       RETURNING *`,
      [userId, rewardId, reward.points_cost, voucherCode, expiresAt],
    );

    await finalizePlatformIdempotentOperation(client, 'loyalty.redeem', idempotencyKey, 'completed', redemptionResult.rows[0]);
    await client.query('COMMIT');
    return redemptionResult.rows[0];
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {}

    if (idempotencyClaimed) {
      await finalizePlatformIdempotentOperation(
        client,
        'loyalty.redeem',
        idempotencyKey,
        'failed',
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function getLoyaltyStats() {
  await getDb();
  if (!_pool) return null;

  const result = await _pool.query<any>(`
    SELECT
      COUNT(*) as total_members,
      COUNT(CASE WHEN tier = 'bronze' THEN 1 END) as bronze_count,
      COUNT(CASE WHEN tier = 'silver' THEN 1 END) as silver_count,
      COUNT(CASE WHEN tier = 'gold' THEN 1 END) as gold_count,
      COUNT(CASE WHEN tier = 'platinum' THEN 1 END) as platinum_count,
      COALESCE(SUM(points_balance), 0) as total_points_outstanding,
      COALESCE(SUM(lifetime_points), 0) as total_points_awarded
    FROM loyalty_points
  `);

  return result.rows[0];
}

export async function getLoyaltyRewards(options?: { activeOnly?: boolean }) {
  await getDb();
  if (!_pool) return [];

  const values: unknown[] = [];
  let query = 'SELECT * FROM loyalty_rewards';
  if (options?.activeOnly !== undefined) {
    query += ' WHERE is_active = $1';
    values.push(options.activeOnly);
  }
  query += ' ORDER BY points_cost ASC, reward_name ASC';

  const result = await _pool.query<any>(query, values);
  return result.rows;
}


// ============================================================================
// Customer Referral System
// ============================================================================

const REFERRAL_BONUS = {
  referrer: 500,  // Points for the person who refers
  referred: 200,  // Points for the new user who signs up
};

export async function applyReferralCode(newUserId: number, referralCode: string, idempotencyKey?: string) {
  await getDb();
  if (!_pool) return null;

  const normalizedReferralCode = referralCode.trim().toUpperCase();
  const client = await _pool.connect();
  let idempotencyClaimed = false;

  try {
    await client.query('BEGIN');
    const idempotency = await beginPlatformIdempotentOperation(
      client,
      'referral.apply_code',
      idempotencyKey,
      { newUserId, referralCode: normalizedReferralCode },
    );
    idempotencyClaimed = Boolean(idempotency.normalizedKey) && !idempotency.replay;
    if (idempotency.replay) {
      await client.query('COMMIT');
      return idempotency.response;
    }

    const referrerResult = await client.query<any>(
      'SELECT id FROM users WHERE referral_code = $1',
      [normalizedReferralCode],
    );

    if (referrerResult.rows.length === 0) {
      throw new Error('Invalid referral code');
    }

    const referrerId = referrerResult.rows[0].id;
    if (referrerId === newUserId) {
      throw new Error('Users cannot apply their own referral code');
    }

    const existingResult = await client.query<any>(
      'SELECT * FROM customer_referrals WHERE referred_id = $1 FOR UPDATE',
      [newUserId],
    );

    if (existingResult.rows.length > 0) {
      const existing = existingResult.rows[0];
      if (existing.referral_code === normalizedReferralCode) {
        await finalizePlatformIdempotentOperation(client, 'referral.apply_code', idempotencyKey, 'completed', existing);
        await client.query('COMMIT');
        return existing;
      }

      throw new Error('User has already used a referral code');
    }

    const referralResult = await client.query<any>(
      `INSERT INTO customer_referrals
       (referrer_id, referred_id, referral_code, status, referrer_bonus_points, referred_bonus_points)
       VALUES ($1, $2, $3, 'pending', $4, $5)
       RETURNING *`,
      [referrerId, newUserId, normalizedReferralCode, REFERRAL_BONUS.referrer, REFERRAL_BONUS.referred],
    );

    await client.query<any>(
      `UPDATE users
       SET referred_by_code = COALESCE(referred_by_code, $1)
       WHERE id = $2`,
      [normalizedReferralCode, newUserId],
    );

    await awardPointsTransactional(
      client,
      newUserId,
      REFERRAL_BONUS.referred,
      'referral',
      `Welcome bonus for using referral code ${normalizedReferralCode}`,
    );

    await finalizePlatformIdempotentOperation(client, 'referral.apply_code', idempotencyKey, 'completed', referralResult.rows[0]);
    await client.query('COMMIT');
    return referralResult.rows[0];
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {}

    if (idempotencyClaimed) {
      await finalizePlatformIdempotentOperation(
        client,
        'referral.apply_code',
        idempotencyKey,
        'failed',
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function completeReferral(referralId: number, idempotencyKey?: string) {
  await getDb();
  if (!_pool) return null;

  const client = await _pool.connect();
  let idempotencyClaimed = false;

  try {
    await client.query('BEGIN');
    const idempotency = await beginPlatformIdempotentOperation(
      client,
      'referral.complete',
      idempotencyKey,
      { referralId },
    );
    idempotencyClaimed = Boolean(idempotency.normalizedKey) && !idempotency.replay;
    if (idempotency.replay) {
      await client.query('COMMIT');
      return idempotency.response;
    }

    const referralResult = await client.query<any>(
      'SELECT * FROM customer_referrals WHERE id = $1 FOR UPDATE',
      [referralId],
    );

    if (referralResult.rows.length === 0) {
      throw new Error('Referral not found');
    }

    const referral = referralResult.rows[0];
    if (referral.status !== 'rewarded') {
      await awardPointsTransactional(
        client,
        referral.referrer_id,
        referral.referrer_bonus_points,
        'referral',
        'Referral bonus for inviting a friend',
      );

      await client.query<any>(
        `UPDATE customer_referrals
         SET status = 'rewarded', completed_at = COALESCE(completed_at, NOW())
         WHERE id = $1`,
        [referralId],
      );
    }

    const completedReferralResult = await client.query<any>(
      'SELECT * FROM customer_referrals WHERE id = $1',
      [referralId],
    );
    const completedReferral = completedReferralResult.rows[0] ?? null;
    await finalizePlatformIdempotentOperation(client, 'referral.complete', idempotencyKey, 'completed', completedReferral);
    await client.query('COMMIT');
    return completedReferral;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {}

    if (idempotencyClaimed) {
      await finalizePlatformIdempotentOperation(
        client,
        'referral.complete',
        idempotencyKey,
        'failed',
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
    throw error;
  } finally {
    client.release();
  }
}


// ============================================================================
// Marketing Campaigns
// ============================================================================

export async function createCampaign(campaignData: {
  campaign_name: string;
  campaign_type: string;
  email_template?: string;
  sms_template?: string;
  target_audience: string;
  trigger_condition?: any;
}) {
  await getDb();
  if (!_pool) return null;

  const result = await _pool.query<any>(
    `INSERT INTO marketing_campaigns
     (campaign_name, campaign_type, email_template, sms_template, target_audience, trigger_condition)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      campaignData.campaign_name,
      campaignData.campaign_type,
      campaignData.email_template,
      campaignData.sms_template,
      campaignData.target_audience,
      campaignData.trigger_condition ? JSON.stringify(campaignData.trigger_condition) : null,
    ]
  );

  return result.rows[0];
}

export async function getCampaigns(isActive?: boolean) {
  await getDb();
  if (!_pool) return [];

  let query = 'SELECT * FROM marketing_campaigns';
  const params: any[] = [];

  if (isActive !== undefined) {
    query += ' WHERE is_active = $1';
    params.push(isActive);
  }

  query += ' ORDER BY created_at DESC';

  const result = await _pool.query<any>(query, params);
  return result.rows;
}

export async function getCampaignById(campaignId: number) {
  await getDb();
  if (!_pool) return null;

  const result = await _pool.query<any>(
    'SELECT * FROM marketing_campaigns WHERE id = $1',
    [campaignId]
  );

  return result.rows[0] || null;
}

export async function updateCampaign(campaignId: number, updates: any) {
  await getDb();
  if (!_pool) return null;

  const allowedColumns = new Set([
    "campaign_name",
    "campaign_type",
    "email_template",
    "sms_template",
    "target_audience",
    "trigger_condition",
    "is_active",
    "open_rate",
    "click_rate",
    "send_count",
  ]);

  const fields: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  for (const [key, value] of Object.entries(updates ?? {})) {
    if (!allowedColumns.has(key) || value === undefined) {
      continue;
    }

    fields.push(`${key} = $${paramIndex}`);
    values.push(value);
    paramIndex++;
  }

  if (fields.length === 0) {
    return await getCampaignById(campaignId);
  }

  fields.push(`updated_at = NOW()`);
  values.push(campaignId);

  const result = await _pool.query<any>(
    `UPDATE marketing_campaigns
     SET ${fields.join(", ")}
     WHERE id = $${paramIndex}
     RETURNING *`,
    values
  );

  return result.rows[0] || null;
}

function interpolateTemplate(template: string, variables: Record<string, any>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return variables[key] !== undefined ? String(variables[key]) : match;
  });
}

export async function sendCampaign(
  campaignId: number,
  userId: number,
  channel: string = 'email',
  idempotencyKey?: string,
) {
  await getDb();
  if (!_pool) return null;

  const client = await _pool.connect();
  let idempotencyClaimed = false;
  let sendRecordId: number | null = null;

  try {
    const idempotency = await beginPlatformIdempotentOperation(
      client,
      'campaign.send',
      idempotencyKey,
      { campaignId, userId, channel },
    );
    idempotencyClaimed = Boolean(idempotency.normalizedKey) && !idempotency.replay;
    if (idempotency.replay) {
      return idempotency.response;
    }

    const campaignResult = await client.query<any>(
      'SELECT * FROM marketing_campaigns WHERE id = $1',
      [campaignId],
    );
    const campaign = campaignResult.rows[0];
    if (!campaign || !campaign.is_active) {
      throw new Error('Campaign not found or inactive');
    }

    const userResult = await client.query<any>(
      'SELECT * FROM users WHERE id = $1',
      [userId],
    );

    if (userResult.rows.length === 0) {
      throw new Error('User not found');
    }

    const user = userResult.rows[0];
    const loyaltyResult = await client.query<any>(
      'SELECT tier, points_balance FROM loyalty_points WHERE user_id = $1',
      [userId],
    );
    const loyaltyAccount = loyaltyResult.rows[0] ?? null;

    const variables = {
      name: user.name,
      email: user.email,
      tier: loyaltyAccount?.tier || 'bronze',
      points: loyaltyAccount?.points_balance || 0,
      expiration_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toLocaleDateString(),
    };

    const template = channel === 'email' ? campaign.email_template : campaign.sms_template;
    if (!template) {
      throw new Error(`No ${channel} template configured for this campaign`);
    }

    const message = interpolateTemplate(template, variables);
    const sendResult = await client.query<any>(
      `INSERT INTO campaign_sends
       (campaign_id, user_id, channel, status)
       VALUES ($1, $2, $3, 'pending')
       RETURNING *`,
      [campaignId, userId, channel],
    );

    const sendRecord = sendResult.rows[0];
    sendRecordId = sendRecord.id;

    if (channel === 'email') {
      const { sendEmail } = await import('./_core/notificationGateway');
      await sendEmail(user.email, campaign.campaign_name, message);
    } else if (channel === 'sms') {
      const { sendSMS } = await import('./_core/notificationGateway');
      if (user.phone) {
        await sendSMS(user.phone, message);
      } else {
        throw new Error('User has no phone number');
      }
    }

    const updatedSendResult = await client.query<any>(
      `UPDATE campaign_sends
       SET status = 'sent', sent_at = NOW(), error_message = NULL
       WHERE id = $1
       RETURNING *`,
      [sendRecord.id],
    );

    await client.query<any>(
      `UPDATE marketing_campaigns
       SET send_count = send_count + 1,
           updated_at = NOW()
       WHERE id = $1`,
      [campaignId],
    );

    const completedSend = updatedSendResult.rows[0] ?? sendRecord;
    await finalizePlatformIdempotentOperation(client, 'campaign.send', idempotencyKey, 'completed', completedSend);
    return completedSend;
  } catch (error: any) {
    if (sendRecordId) {
      await client.query<any>(
        `UPDATE campaign_sends
         SET status = 'failed', error_message = $1
         WHERE id = $2`,
        [error.message, sendRecordId],
      );
    }

    if (idempotencyClaimed) {
      await finalizePlatformIdempotentOperation(
        client,
        'campaign.send',
        idempotencyKey,
        'failed',
        { error: error instanceof Error ? error.message : String(error), sendRecordId },
      );
    }

    throw error;
  } finally {
    client.release();
  }
}

// Campaign audience dispatch page size (perf audit finding 14): the audience
// is paged with LIMIT/OFFSET instead of a single unbounded SELECT of the
// whole users table, and by default the request returns immediately with a
// 202-style queued result while pages are processed in the background.
export const CAMPAIGN_AUDIENCE_PAGE_SIZE = 500;

export type CampaignAudienceDispatchResult = {
  status: "queued" | "completed";
  campaign_id: number;
  total: number;
  page_size: number;
  sent: number;
  failed: number;
};

/**
 * Dispatch a campaign to its audience.
 *
 * Default mode ("202-style"): validates the campaign, counts the audience,
 * then pages through it in the background (LIMIT/OFFSET pages of
 * CAMPAIGN_AUDIENCE_PAGE_SIZE, per-user sends sequential within a page) and
 * returns immediately with { status: "queued", ... }. Per-user sends remain
 * idempotent via the audience idempotency scope, so a retried trigger or a
 * restarted pod can safely re-run the dispatch; a background failure is
 * logged, not thrown to the caller.
 *
 * Pass { awaitCompletion: true } (scheduler/tests) to run synchronously and
 * get { status: "completed", sent, failed, ... }.
 */
export async function sendCampaignToAudience(
  campaignId: number,
  idempotencyKey?: string,
  options?: { awaitCompletion?: boolean },
): Promise<CampaignAudienceDispatchResult> {
  await getDb();
  if (!_pool) throw new DatabaseUnavailableError("campaign_audience_send");
  const pool = _pool;

  const campaign = await getCampaignById(campaignId);
  if (!campaign || !campaign.is_active) {
    throw new Error('Campaign not found or inactive');
  }

  let whereClause = 'WHERE 1=1';
  const params: any[] = [];

  if (campaign.target_audience !== 'all') {
    if (['bronze', 'silver', 'gold', 'platinum'].includes(campaign.target_audience)) {
      whereClause += ' AND id IN (SELECT user_id FROM loyalty_points WHERE tier = $1)';
      params.push(campaign.target_audience);
    }
  }

  const totalResult = await pool.query<any>(
    `SELECT COUNT(*)::int AS total FROM users ${whereClause}`,
    params,
  );
  const total = Number(totalResult.rows[0]?.total ?? 0);

  const audienceScope = idempotencyKey?.trim() || `campaign.audience.${campaignId}`;

  const dispatch = async (): Promise<{ sent: number; failed: number }> => {
    let sent = 0;
    let failed = 0;
    for (let offset = 0; ; offset += CAMPAIGN_AUDIENCE_PAGE_SIZE) {
      const pageParams = [...params, CAMPAIGN_AUDIENCE_PAGE_SIZE, offset];
      const page = await pool.query<any>(
        `SELECT id FROM users ${whereClause} ORDER BY id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        pageParams,
      );
      const users = page.rows;
      for (const user of users) {
        try {
          await sendCampaign(campaignId, user.id, 'email', `${audienceScope}:user:${user.id}:channel:email`);
          sent++;
        } catch (error) {
          failed++;
          console.error(`Failed to send campaign to user ${user.id}:`, error);
        }
      }
      if (users.length < CAMPAIGN_AUDIENCE_PAGE_SIZE) break;
    }
    return { sent, failed };
  };

  const base = {
    campaign_id: campaignId,
    total,
    page_size: CAMPAIGN_AUDIENCE_PAGE_SIZE,
  };

  if (options?.awaitCompletion) {
    const { sent, failed } = await dispatch();
    return { status: "completed", ...base, sent, failed };
  }

  // Fire-and-forget: the request returns immediately (202-style). Sends are
  // idempotent per (audience scope, user, channel), so an interrupted
  // background run can be retried by re-invoking this function.
  void dispatch().then(
    ({ sent, failed }) => {
      console.log(
        `[Campaign] Audience dispatch for campaign ${campaignId} finished: ${sent} sent, ${failed} failed, ${total} total.`,
      );
    },
    (error) => {
      console.error(`[Campaign] Background audience dispatch for campaign ${campaignId} failed:`, error);
    },
  );
  return { status: "queued", ...base, sent: 0, failed: 0 };
}

export async function getCampaignStats(campaignId?: number) {
  await getDb();
  if (!_pool) return null;

  if (campaignId) {
    // Stats for specific campaign
    const result = await _pool.query<any>(
      `SELECT
         COUNT(*) as total_sends,
         COUNT(CASE WHEN status = 'sent' THEN 1 END) as successful_sends,
         COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_sends,
         COUNT(CASE WHEN status = 'opened' THEN 1 END) as opened_count,
         COUNT(CASE WHEN status = 'clicked' THEN 1 END) as clicked_count,
         CASE
           WHEN COUNT(CASE WHEN status = 'sent' THEN 1 END) > 0
           THEN ROUND((COUNT(CASE WHEN status = 'opened' THEN 1 END)::DECIMAL / COUNT(CASE WHEN status = 'sent' THEN 1 END)) * 100, 2)
           ELSE 0
         END as open_rate,
         CASE
           WHEN COUNT(CASE WHEN status = 'sent' THEN 1 END) > 0
           THEN ROUND((COUNT(CASE WHEN status = 'clicked' THEN 1 END)::DECIMAL / COUNT(CASE WHEN status = 'sent' THEN 1 END)) * 100, 2)
           ELSE 0
         END as click_rate
       FROM campaign_sends
       WHERE campaign_id = $1`,
      [campaignId]
    );
    return result.rows[0];
  } else {
    // Platform-wide stats
    const result = await _pool.query<any>(`
      SELECT
        COUNT(DISTINCT campaign_id) as total_campaigns,
        COUNT(*) as total_sends,
        COUNT(CASE WHEN status = 'sent' THEN 1 END) as successful_sends,
        COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_sends,
        COUNT(CASE WHEN status = 'opened' THEN 1 END) as opened_count,
        COUNT(CASE WHEN status = 'clicked' THEN 1 END) as clicked_count
      FROM campaign_sends
    `);
    return result.rows[0];
  }
}


// ============================================================================
// Referral Leaderboard
// ============================================================================

const LEADERBOARD_REWARDS = {
  gold: 2000,    // Top 3 referrers
  silver: 1000,  // Rank 4-10
  bronze: 500,   // Rank 11-20
};

export async function getCurrentLeaderboardPeriod() {
  await getDb();
  if (!_pool) return null;

  const result = await _pool.query<any>(
    `SELECT * FROM referral_leaderboard_periods
     WHERE is_active = true
     ORDER BY period_start DESC
     LIMIT 1`
  );

  if (result.rows[0]) {
    return {
      ...result.rows[0],
      status: 'active',
    };
  }

  // A missing period is an operational data condition, not permission to seed live data.
  return null;
}

export async function updateLeaderboardEntry(userId: number, periodId?: number) {
  await getDb();
  if (!_pool) return null;

  // Get current period if not specified
  if (!periodId) {
    const period = await getCurrentLeaderboardPeriod();
    if (!period) return null;
    periodId = period.id;
  }

  // Count user's referrals in this period
  const statsResult = await _pool.query<any>(
    `SELECT
       COUNT(*) as referral_count,
       COUNT(CASE WHEN status IN ('completed', 'rewarded') THEN 1 END) as successful_referrals,
       COALESCE(SUM(CASE WHEN status = 'rewarded' THEN referrer_bonus_points ELSE 0 END), 0) as points_earned
     FROM customer_referrals
     WHERE referrer_id = $1
       AND created_at >= (SELECT period_start FROM referral_leaderboard_periods WHERE id = $2)
       AND created_at <= (SELECT period_end FROM referral_leaderboard_periods WHERE id = $2)`,
    [userId, periodId]
  );

  const stats = statsResult.rows[0];

  // Upsert leaderboard entry
  const result = await _pool.query<any>(
    `INSERT INTO referral_leaderboard_entries
     (period_id, user_id, referral_count, successful_referrals, points_earned, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (period_id, user_id)
     DO UPDATE SET
       referral_count = $3,
       successful_referrals = $4,
       points_earned = $5,
       updated_at = NOW()
     RETURNING *`,
    [periodId, userId, stats.referral_count, stats.successful_referrals, stats.points_earned]
  );

  return result.rows[0];
}

export async function calculateLeaderboardRankings(periodId?: number) {
  await getDb();
  if (!_pool) return null;

  // Get current period if not specified
  if (!periodId) {
    const period = await getCurrentLeaderboardPeriod();
    if (!period) return null;
    periodId = period.id;
  }

  // Calculate rankings based on successful referrals
  await _pool.query<any>(
    `UPDATE referral_leaderboard_entries
     SET rank = subquery.rank,
         reward_tier = CASE
           WHEN subquery.rank <= 3 THEN 'gold'
           WHEN subquery.rank <= 10 THEN 'silver'
           WHEN subquery.rank <= 20 THEN 'bronze'
           ELSE 'none'
         END,
         reward_points = CASE
           WHEN subquery.rank <= 3 THEN $2
           WHEN subquery.rank <= 10 THEN $3
           WHEN subquery.rank <= 20 THEN $4
           ELSE 0
         END
     FROM (
       SELECT id,
              RANK() OVER (ORDER BY successful_referrals DESC, points_earned DESC) as rank
       FROM referral_leaderboard_entries
       WHERE period_id = $1
     ) as subquery
     WHERE referral_leaderboard_entries.id = subquery.id`,
    [periodId, LEADERBOARD_REWARDS.gold, LEADERBOARD_REWARDS.silver, LEADERBOARD_REWARDS.bronze]
  );

  return true;
}

export async function getReferralLeaderboard(periodId?: number, limit: number = 50) {
  await getDb();
  if (!_pool) return [];

  // Get current period if not specified
  if (!periodId) {
    const period = await getCurrentLeaderboardPeriod();
    if (!period) return [];
    periodId = period.id;
  }

  const result = await _pool.query<any>(
    `SELECT
       le.*,
       u.name as user_name,
       u.email as user_email,
       lp.period_start,
       lp.period_end
     FROM referral_leaderboard_entries le
     JOIN users u ON le.user_id = u.id
     JOIN referral_leaderboard_periods lp ON le.period_id = lp.id
     WHERE le.period_id = $1
     ORDER BY le.rank ASC NULLS LAST, le.successful_referrals DESC
     LIMIT $2`,
    [periodId, limit]
  );

  return result.rows;
}

export async function getUserLeaderboardPosition(userId: number, periodId?: number) {
  await getDb();
  if (!_pool) return null;

  // Get current period if not specified
  if (!periodId) {
    const period = await getCurrentLeaderboardPeriod();
    if (!period) return null;
    periodId = period.id;
  }

  const result = await _pool.query<any>(
    `SELECT
       le.*,
       lp.period_start,
       lp.period_end,
       (SELECT COUNT(*) FROM referral_leaderboard_entries WHERE period_id = $2) as total_participants
     FROM referral_leaderboard_entries le
     JOIN referral_leaderboard_periods lp ON le.period_id = lp.id
     WHERE le.user_id = $1 AND le.period_id = $2`,
    [userId, periodId]
  );

  return result.rows[0] || null;
}

async function distributeLeaderboardRewards(periodId: number) {
  await getDb();
  if (!_pool) throw new DatabaseUnavailableError("leaderboard_reward_distribution");

  // Get all entries with rewards
  const entriesResult = await _pool.query<any>(
    `SELECT * FROM referral_leaderboard_entries
     WHERE period_id = $1 AND reward_points > 0`,
    [periodId]
  );

  const entries = entriesResult.rows;
  let distributed = 0;
  let totalPoints = 0;

  // Distribute rewards
  for (const entry of entries) {
    await awardPoints(
      entry.user_id,
      entry.reward_points,
      'leaderboard_reward',
      `Leaderboard ${entry.reward_tier} tier reward - Rank #${entry.rank}`
    );
    distributed++;
    totalPoints += entry.reward_points;
  }

  // Mark period as no longer active after rewards are distributed
  await _pool.query<any>(
    `UPDATE referral_leaderboard_periods
     SET is_active = false,
         updated_at = NOW()
     WHERE id = $1`,
    [periodId]
  );

  return { distributed, total_points: totalPoints };
}

export async function closeLeaderboardPeriod(periodId: number) {
  await getDb();
  if (!_pool) return null;

  // Calculate final rankings
  await calculateLeaderboardRankings(periodId);

  // Distribute rewards
  const result = await distributeLeaderboardRewards(periodId);

  // Mark the closed period as inactive
  await _pool.query<any>(
    `UPDATE referral_leaderboard_periods
     SET is_active = false,
         updated_at = NOW()
     WHERE id = $1`,
    [periodId]
  );

  // Create next period
  const periodResult = await _pool.query<any>(
    `SELECT period_end FROM referral_leaderboard_periods WHERE id = $1`,
    [periodId]
  );

  const currentPeriodEnd = new Date(periodResult.rows[0].period_end);
  const nextPeriodStart = new Date(currentPeriodEnd);
  nextPeriodStart.setDate(nextPeriodStart.getDate() + 1);

  const nextPeriodEnd = new Date(nextPeriodStart);
  nextPeriodEnd.setMonth(nextPeriodEnd.getMonth() + 1);
  nextPeriodEnd.setDate(0); // Last day of month

  const nextPeriodName = `${nextPeriodStart.getUTCFullYear()}-${String(nextPeriodStart.getUTCMonth() + 1).padStart(2, '0')}`;

  await _pool.query<any>(
    `INSERT INTO referral_leaderboard_periods (period_name, period_start, period_end, is_active)
     VALUES ($1, $2, $3, true)
     ON CONFLICT DO NOTHING`,
    [nextPeriodName, nextPeriodStart.toISOString(), nextPeriodEnd.toISOString()]
  );

  return result;
}


// ============================================================================
// Push Notifications
// ============================================================================

export async function registerPushToken(
  userId: number,
  deviceToken: string,
  deviceType: string,
  deviceId?: string
) {
  await getDb();
  if (!_pool) return null;

  const result = await _pool.query<any>(
    `INSERT INTO push_notification_tokens
     (user_id, device_token, device_type, device_id, last_used_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (user_id, device_token)
     DO UPDATE SET
       is_active = true,
       last_used_at = NOW()
     RETURNING *`,
    [userId, deviceToken, deviceType, deviceId]
  );

  return result.rows[0];
}

export async function deactivatePushToken(userId: number, deviceToken: string) {
  await getDb();
  if (!_pool) return null;

  await _pool.query<any>(
    `UPDATE push_notification_tokens
     SET is_active = false
     WHERE user_id = $1 AND device_token = $2`,
    [userId, deviceToken]
  );

  return true;
}

export async function getUserPushTokens(userId: number) {
  await getDb();
  if (!_pool) return [];

  const result = await _pool.query<any>(
    `SELECT * FROM push_notification_tokens
     WHERE user_id = $1 AND is_active = true`,
    [userId]
  );

  return result.rows;
}

export async function sendPushToUser(
  userId: number,
  notificationType: string,
  title: string,
  body: string,
  data?: any
) {
  await getDb();
  if (!_pool) return null;

  // Get user's active tokens
  const tokens = await getUserPushTokens(userId);

  if (tokens.length === 0) {
    console.log(`[Push] No active tokens for user ${userId}`);
    return null;
  }

  // Import push notification service
  const { sendPushNotificationToMultiple } = await import('./_core/pushNotification');

  // Send to all user's devices
  const deviceTokens = tokens.map((t: any) => t.device_token);
  const result = await sendPushNotificationToMultiple(deviceTokens, {
    title,
    body,
    data: data ? { ...data, type: notificationType } : { type: notificationType },
  });

  // Log notification
  const logResult = await _pool.query<any>(
    `INSERT INTO push_notification_logs
     (user_id, notification_type, title, body, data, status, sent_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     RETURNING *`,
    [
      userId,
      notificationType,
      title,
      body,
      data ? JSON.stringify(data) : null,
      result.successCount > 0 ? 'sent' : 'failed',
    ]
  );

  return {
    ...logResult.rows[0],
    sent_to_devices: result.successCount,
    failed_devices: result.failureCount,
  };
}

export async function getPushNotificationLogs(userId?: number, limit: number = 50) {
  await getDb();
  if (!_pool) return [];

  let query = `
    SELECT
      pnl.*,
      u.name as user_name,
      u.email as user_email
    FROM push_notification_logs pnl
    JOIN users u ON pnl.user_id = u.id
  `;
  const params: any[] = [];

  if (userId) {
    query += ' WHERE pnl.user_id = $1';
    params.push(userId);
  }

  query += ' ORDER BY pnl.created_at DESC LIMIT $' + (params.length + 1);
  params.push(limit);

  const result = await _pool.query<any>(query, params);
  return result.rows;
}

// Notification templates for common events

// ============================================================================
// A/B Testing for Campaigns
// ============================================================================

export async function createCampaignVariant(variantData: {
  campaign_id: number;
  variant_name: string;
  email_template?: string;
  sms_template?: string;
  traffic_allocation?: number;
}) {
  await getDb();
  if (!_pool) return null;

  const allocation = variantData.traffic_allocation ?? 50;
  if (!Number.isFinite(allocation) || allocation < 0 || allocation > 100) {
    throw new Error('Traffic allocation must be between 0 and 100');
  }

  const client = await _pool.connect();
  try {
    await client.query('BEGIN');
    const campaignLock = await client.query('SELECT id FROM marketing_campaigns WHERE id = $1 FOR UPDATE', [variantData.campaign_id]);
    if (campaignLock.rows.length === 0) {
      throw new Error('Campaign not found');
    }
    const current = await client.query<any>(
      'SELECT COALESCE(SUM(traffic_allocation), 0) AS total FROM campaign_variants WHERE campaign_id = $1',
      [variantData.campaign_id],
    );
    if (Number(current.rows[0].total) + allocation > 100) {
      throw new Error('Traffic allocation would exceed 100 percent');
    }
    const result = await client.query<any>(
      `INSERT INTO campaign_variants
       (campaign_id, variant_name, email_template, sms_template, traffic_allocation)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [variantData.campaign_id, variantData.variant_name, variantData.email_template, variantData.sms_template, allocation],
    );
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function getCampaignVariants(campaignId: number) {
  await getDb();
  if (!_pool) return [];

  const result = await _pool.query<any>(
    `SELECT * FROM campaign_variants
     WHERE campaign_id = $1
     ORDER BY created_at ASC`,
    [campaignId]
  );

  return result.rows;
}

export async function trackVariantSend(variantId: number) {
  await getDb();
  if (!_pool) return null;

  await _pool.query<any>(
    `UPDATE campaign_variants
     SET send_count = send_count + 1
     WHERE id = $1`,
    [variantId]
  );

  return true;
}

export async function trackVariantOpen(variantId: number) {
  await getDb();
  if (!_pool) return null;

  await _pool.query<any>(
    `UPDATE campaign_variants
     SET open_count = open_count + 1
     WHERE id = $1`,
    [variantId]
  );

  return true;
}

export async function trackVariantClick(variantId: number) {
  await getDb();
  if (!_pool) return null;

  await _pool.query<any>(
    `UPDATE campaign_variants
     SET click_count = click_count + 1
     WHERE id = $1`,
    [variantId]
  );

  return true;
}

export async function trackVariantConversion(variantId: number) {
  await getDb();
  if (!_pool) return null;

  await _pool.query<any>(
    `UPDATE campaign_variants
     SET conversion_count = conversion_count + 1
     WHERE id = $1`,
    [variantId]
  );

  return true;
}

export async function getVariantPerformance(campaignId: number) {
  await getDb();
  if (!_pool) return [];

  const result = await _pool.query<any>(
    `SELECT
       *,
       CASE
         WHEN send_count > 0 THEN ROUND((open_count::DECIMAL / send_count) * 100, 2)
         ELSE 0
       END as open_rate,
       CASE
         WHEN send_count > 0 THEN ROUND((click_count::DECIMAL / send_count) * 100, 2)
         ELSE 0
       END as click_rate,
       CASE
         WHEN send_count > 0 THEN ROUND((conversion_count::DECIMAL / send_count) * 100, 2)
         ELSE 0
       END as conversion_rate
     FROM campaign_variants
     WHERE campaign_id = $1
     ORDER BY conversion_rate DESC, click_rate DESC`,
    [campaignId]
  );

  return result.rows;
}

export async function calculateStatisticalSignificance(
  variant1: any,
  variant2: any
): Promise<{ isSignificant: boolean; confidenceLevel: number; winner?: string }> {
  // Simplified chi-square test for statistical significance
  // In production, use a proper statistical library like jStat

  const n1 = variant1.send_count;
  const n2 = variant2.send_count;
  const p1 = variant1.conversion_count / n1;
  const p2 = variant2.conversion_count / n2;

  // Need at least 100 samples per variant for meaningful results
  if (n1 < 100 || n2 < 100) {
    return {
      isSignificant: false,
      confidenceLevel: 0,
    };
  }

  // Calculate pooled probability
  const pooledP = (variant1.conversion_count + variant2.conversion_count) / (n1 + n2);

  // Calculate standard error
  const se = Math.sqrt(pooledP * (1 - pooledP) * (1 / n1 + 1 / n2));

  // Calculate z-score
  const zScore = Math.abs(p1 - p2) / se;

  // Determine confidence level (simplified)
  let confidenceLevel = 0;
  if (zScore >= 1.96) confidenceLevel = 95; // 95% confidence
  if (zScore >= 2.58) confidenceLevel = 99; // 99% confidence

  const isSignificant = zScore >= 1.96; // 95% confidence threshold
  const winner = p1 > p2 ? variant1.variant_name : variant2.variant_name;

  return {
    isSignificant,
    confidenceLevel,
    winner: isSignificant ? winner : undefined,
  };
}

export async function selectWinningVariant(campaignId: number) {
  await getDb();
  if (!_pool) return null;

  const variants = await getVariantPerformance(campaignId);

  if (variants.length < 2) {
    throw new Error('Need at least 2 variants to determine a winner');
  }

  // Sort by conversion rate
  const sortedVariants = variants.sort((a: any, b: any) =>
    parseFloat(b.conversion_rate) - parseFloat(a.conversion_rate)
  );

  const topVariant = sortedVariants[0];
  const secondVariant = sortedVariants[1];

  // Check statistical significance
  const significance = await calculateStatisticalSignificance(topVariant, secondVariant);

  if (!significance.isSignificant) {
    return {
      winner: null,
      message: 'Not enough data or difference not statistically significant',
      confidence: significance.confidenceLevel,
    };
  }

  // Mark winner
  await _pool.query<any>(
    `UPDATE campaign_variants
     SET is_winner = true, updated_at = NOW()
     WHERE id = $1`,
    [topVariant.id]
  );

  // Update campaign to use winning variant
  await _pool.query<any>(
    `UPDATE marketing_campaigns
     SET email_template = $1, sms_template = $2, updated_at = NOW()
     WHERE id = $3`,
    [topVariant.email_template, topVariant.sms_template, campaignId]
  );

  return {
    winner: topVariant,
    confidence: significance.confidenceLevel,
    improvement: parseFloat(topVariant.conversion_rate) - parseFloat(secondVariant.conversion_rate),
  };
}

export async function updateVariantAllocation(variantId: number, allocation: number) {
  await getDb();
  if (!_pool) return null;

  if (!Number.isFinite(allocation) || allocation < 0 || allocation > 100) {
    throw new Error('Traffic allocation must be between 0 and 100');
  }

  const client = await _pool.connect();
  try {
    await client.query('BEGIN');
    const variant = await client.query<any>('SELECT campaign_id FROM campaign_variants WHERE id = $1', [variantId]);
    if (variant.rows.length === 0) {
      throw new Error('Campaign variant not found');
    }
    const campaignId = variant.rows[0].campaign_id;
    await client.query('SELECT id FROM marketing_campaigns WHERE id = $1 FOR UPDATE', [campaignId]);
    const variants = await client.query<any>(
      'SELECT id, traffic_allocation FROM campaign_variants WHERE campaign_id = $1 FOR UPDATE',
      [campaignId],
    );
    const otherAllocation = variants.rows
      .filter((item: { id: number }) => item.id !== variantId)
      .reduce((total: number, item: { traffic_allocation: string | number }) => total + Number(item.traffic_allocation), 0);
    if (otherAllocation + allocation > 100) {
      throw new Error('Traffic allocation would exceed 100 percent');
    }
    const result = await client.query<any>(
      `UPDATE campaign_variants
       SET traffic_allocation = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [allocation, variantId],
    );
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}


// ============================================================================
// Growth Analytics
// ============================================================================


// ============================================================================
// Job Monitoring Functions
// ============================================================================

export async function logJobExecution(params: {
  jobName: string;
  status: 'success' | 'error' | 'running';
  message: string;
  executionTimeMs?: number;
  errorDetails?: string;
}) {
  const pool = await getDb();
  if (!pool) return null;

  const result = await (pool as any).query(
    `INSERT INTO scheduled_job_logs
     (job_name, status, message, execution_time_ms, error_details, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      params.jobName,
      params.status,
      params.message,
      params.executionTimeMs || null,
      params.errorDetails || null,
      params.status !== 'running' ? new Date() : null,
    ]
  );

  return result.rows[0];
}

// Kept: pinned by tests/silent-mockware.regression.test.ts (manual jobs must execute).
export async function triggerJobManually(jobName: string) {
  // This will be called from the UI to manually trigger jobs
  const { jobs } = await import('./_core/scheduledJobs');

  const jobMap: Record<string, any> = {
    closeLeaderboard: jobs.closeLeaderboard,
    pointsExpiration: jobs.pointsExpiration,
    abTestWinner: jobs.abTestWinner,
  };

  const job = jobMap[jobName];
  if (!job) {
    throw new Error(`Job ${jobName} not found`);
  }

  const startedAt = Date.now();
  const execution = await job();
  const success = execution?.success === true;
  const message = typeof execution?.message === 'string'
    ? execution.message
    : success
      ? `Job ${jobName} completed.`
      : `Job ${jobName} failed.`;

  await logJobExecution({
    jobName,
    status: success ? 'success' : 'error',
    message,
    executionTimeMs: Date.now() - startedAt,
    errorDetails: success ? null : JSON.stringify(execution ?? {}),
  });

  if (!success) {
    throw new Error(message);
  }

  return { success: true, message, execution };
}


// ============================================================================
// Email Digest Functions
// ============================================================================

export async function generateWeeklyDigest() {
  const pool = await getDb();
  if (!pool) return null;

  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - 7 * 24 * 60 * 60 * 1000);

  // Get growth metrics
  const [leaderboardStats, campaignStats, referralStats] = await Promise.all([
    (pool as any).query(
      `SELECT COUNT(*) as total_periods,
              SUM(total_referrals) as total_referrals
       FROM referral_leaderboard_periods
       WHERE period_start >= $1`,
      [periodStart]
    ),
    (pool as any).query(
      `SELECT COUNT(*) as total_campaigns,
              SUM(send_count) as total_sends,
              AVG(open_rate) as avg_open_rate
       FROM marketing_campaigns
       WHERE created_at >= $1`,
      [periodStart]
    ),
    (pool as any).query(
      `SELECT COUNT(*) as new_referrals,
              SUM(points_awarded) as points_awarded
       FROM customer_referrals
       WHERE created_at >= $1 AND status = 'completed'`,
      [periodStart]
    ),
  ]);

  // Get top performers
  const topReferrers = await (pool as any).query(
    `SELECT c.name, c.email, COUNT(cr.id) as referral_count
     FROM customers c
     JOIN customer_referrals cr ON c.id = cr.referrer_customer_id
     WHERE cr.created_at >= $1 AND cr.status = 'completed'
     GROUP BY c.id, c.name, c.email
     ORDER BY referral_count DESC
     LIMIT 5`,
    [periodStart]
  );

  return {
    periodStart,
    periodEnd,
    leaderboardStats: leaderboardStats.rows[0],
    campaignStats: campaignStats.rows[0],
    referralStats: referralStats.rows[0],
    topReferrers: topReferrers.rows,
  };
}

export async function createEmailDigest(params: {
  digestType: string;
  periodStart: Date;
  periodEnd: Date;
  recipientEmail: string;
  subject: string;
  htmlContent: string;
}) {
  const pool = await getDb();
  if (!pool) return null;

  const result = await (pool as any).query(
    `INSERT INTO email_digests
     (digest_type, period_start, period_end, recipient_email, subject, html_content)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      params.digestType,
      params.periodStart,
      params.periodEnd,
      params.recipientEmail,
      params.subject,
      params.htmlContent,
    ]
  );

  return result.rows[0];
}

export async function markDigestAsSent(digestId: number) {
  const pool = await getDb();
  if (!pool) return false;

  await (pool as any).query(
    `UPDATE email_digests
     SET status = 'sent', sent_at = NOW()
     WHERE id = $1`,
    [digestId]
  );

  return true;
}


// ============================================================================
// Gamification Badge Functions
// ============================================================================


// ============================================================================
// Platform Completion Helpers
// ============================================================================

export async function getMerchantHubSummary(limit = 8) {
  await getDb();
  if (!_pool) return null;

  const [merchantStatsResult, payoutResult, campaignResult, disputeResult] = await Promise.all([
    _pool.query<any>(`
      SELECT
        COUNT(*) AS total_providers,
        COUNT(*) FILTER (WHERE status = 'active') AS active_providers,
        COUNT(*) FILTER (WHERE verification_status = 'verified') AS verified_providers,
        COALESCE(AVG(rating::numeric), 0) AS average_rating,
        COALESCE(AVG(commission_rate::numeric), 0) AS average_commission
      FROM service_providers
    `),
    _pool.query<any>(`
      SELECT
        COUNT(*) AS settlement_count,
        COALESCE(SUM(total_amount) FILTER (WHERE status = 'pending'), 0) AS pending_settlements,
        COALESCE(SUM(total_amount) FILTER (WHERE status = 'approved'), 0) AS approved_settlements,
        COALESCE(SUM(total_amount) FILTER (WHERE status = 'paid'), 0) AS paid_settlements
      FROM driver_settlements
    `),
    _pool.query<any>(`
      SELECT
        COUNT(*) AS active_campaigns,
        COUNT(*) FILTER (WHERE status IN ('draft', 'paused')) AS queued_campaigns
      FROM marketing_campaigns
    `),
    _pool.query<any>(`
      SELECT
        COUNT(*) FILTER (WHERE type IN ('refund', 'claim')) AS dispute_like_tickets,
        COUNT(*) FILTER (WHERE priority IN ('urgent', 'critical')) AS critical_tickets
      FROM support_tickets
    `),
  ]);

  const merchants = await _pool.query<any>(`
    WITH merchant_orders AS (
      SELECT
        sp.id,
        sp.business_name,
        sp.status,
        sp.verification_status,
        COUNT(o.id) AS order_count,
        COALESCE(SUM(o.total_amount::numeric), 0) AS gross_sales,
        COALESCE(AVG(CASE WHEN o.status = 'delivered' THEN 1 ELSE 0 END) * 100, 0) AS fulfillment_rate
      FROM service_providers sp
      LEFT JOIN orders o ON o.customer_id = sp.id OR o.driver_id = sp.id
      GROUP BY sp.id, sp.business_name, sp.status, sp.verification_status
    )
    SELECT *
    FROM merchant_orders
    ORDER BY gross_sales DESC, order_count DESC
    LIMIT $1
  `, [limit]);

  const merchantStats = merchantStatsResult.rows[0] || {};
  const payout = payoutResult.rows[0] || {};
  const campaign = campaignResult.rows[0] || {};
  const dispute = disputeResult.rows[0] || {};

  return {
    summary: {
      total_providers: Number(merchantStats.total_providers || 0),
      active_providers: Number(merchantStats.active_providers || 0),
      verified_providers: Number(merchantStats.verified_providers || 0),
      average_rating: Number(Number(merchantStats.average_rating || 0).toFixed(2)),
      average_commission: Number(Number(merchantStats.average_commission || 0).toFixed(2)),
      pending_settlements: Number(Number(payout.pending_settlements || 0).toFixed(2)),
      approved_settlements: Number(Number(payout.approved_settlements || 0).toFixed(2)),
      paid_settlements: Number(Number(payout.paid_settlements || 0).toFixed(2)),
      active_campaigns: Number(campaign.active_campaigns || 0),
      queued_campaigns: Number(campaign.queued_campaigns || 0),
      dispute_like_tickets: Number(dispute.dispute_like_tickets || 0),
      critical_tickets: Number(dispute.critical_tickets || 0),
    },
    merchants: merchants.rows.map((row: any) => ({
      id: Number(row.id),
      business_name: row.business_name,
      status: row.status,
      verification_status: row.verification_status,
      order_count: Number(row.order_count || 0),
      gross_sales: Number(Number(row.gross_sales || 0).toFixed(2)),
      fulfillment_rate: Number(Number(row.fulfillment_rate || 0).toFixed(2)),
      next_action: row.status !== 'active'
        ? 'Re-activate and review onboarding or compliance blockers.'
        : Number(row.fulfillment_rate || 0) < 80
          ? 'Investigate readiness and dispatch handoff delays.'
          : 'Maintain service level and review promo performance for growth opportunities.',
    })),
  };
}

export async function getCourierHubSummary(limit = 10) {
  await getDb();
  if (!_pool) return null;

  const [driverStatsResult, incentiveResult, settlementResult, performanceResult] = await Promise.all([
    _pool.query<any>(`
      SELECT
        COUNT(*) AS total_drivers,
        COUNT(*) FILTER (WHERE status = 'active') AS active_drivers,
        COUNT(*) FILTER (WHERE status = 'busy') AS busy_drivers,
        COUNT(*) FILTER (WHERE status = 'offline') AS offline_drivers
      FROM drivers
    `),
    _pool.query<any>(`
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE status = 'pending'), 0) AS pending_incentives,
        COALESCE(SUM(amount) FILTER (WHERE status = 'approved'), 0) AS approved_incentives,
        COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0) AS paid_incentives
      FROM driver_incentives
    `),
    _pool.query<any>(`
      SELECT
        COALESCE(SUM(total_amount) FILTER (WHERE status = 'pending'), 0) AS pending_payouts,
        COALESCE(SUM(total_amount) FILTER (WHERE status = 'approved'), 0) AS approved_payouts
      FROM driver_settlements
    `),
    _pool.query<any>(`
      SELECT
        driver_id,
        utilization_score,
        reliability_score,
        response_score,
        earnings_efficiency,
        dispatch_priority_band
      FROM driver_performance_scores
      ORDER BY utilization_score DESC NULLS LAST, reliability_score DESC NULLS LAST
      LIMIT $1
    `, [limit]),
  ]);

  const stats = driverStatsResult.rows[0] || {};
  const incentives = incentiveResult.rows[0] || {};
  const settlements = settlementResult.rows[0] || {};

  const driverIds = performanceResult.rows.map((row: any) => Number(row.driver_id));
  const driverDirectory = driverIds.length
    ? await _pool.query<any>(`SELECT id, name, status, rating FROM drivers WHERE id = ANY($1::int[])`, [driverIds])
    : { rows: [] as any[] };
  const driverMap = new Map(driverDirectory.rows.map((row: any) => [Number(row.id), row]));

  return {
    summary: {
      total_drivers: Number(stats.total_drivers || 0),
      active_drivers: Number(stats.active_drivers || 0),
      busy_drivers: Number(stats.busy_drivers || 0),
      offline_drivers: Number(stats.offline_drivers || 0),
      pending_incentives: Number(Number(incentives.pending_incentives || 0).toFixed(2)),
      approved_incentives: Number(Number(incentives.approved_incentives || 0).toFixed(2)),
      paid_incentives: Number(Number(incentives.paid_incentives || 0).toFixed(2)),
      pending_payouts: Number(Number(settlements.pending_payouts || 0).toFixed(2)),
      approved_payouts: Number(Number(settlements.approved_payouts || 0).toFixed(2)),
    },
    couriers: performanceResult.rows.map((row: any) => {
      const driver = driverMap.get(Number(row.driver_id));
      const utilization = Number(row.utilization_score || 0);
      const reliability = Number(row.reliability_score || 0);
      return {
        driver_id: Number(row.driver_id),
        name: driver?.name || `Driver ${row.driver_id}`,
        status: driver?.status || 'unknown',
        rating: Number(driver?.rating || 0),
        utilization_score: utilization,
        reliability_score: reliability,
        response_score: Number(row.response_score || 0),
        earnings_efficiency: Number(Number(row.earnings_efficiency || 0).toFixed(2)),
        dispatch_priority_band: row.dispatch_priority_band || 'standard',
        repositioning_hint: utilization < 55
          ? 'Move this courier closer to a high-pressure zone for better utilization.'
          : reliability < 70
            ? 'Reduce complex assignments and focus on high-conversion nearby trips.'
            : 'Candidate for priority dispatch and premium demand balancing.',
      };
    }),
  };
}

export async function getConsumerMarketplaceSummary(limit = 8) {
  await getDb();
  if (!_pool) throw new DatabaseUnavailableError("consumer_marketplace_summary");

  const [verticalsResult, recentOrdersResult, loyaltyResult, campaignsResult, membershipStatsResult, reviewStatsResult, membershipsResult, reviewsResult, trackingResult] = await Promise.all([
    _pool.query<any>(`
      SELECT id, name, description
      FROM service_verticals
      ORDER BY id ASC
      LIMIT $1
    `, [limit]),
    _pool.query<any>(`
      SELECT id, status, total_amount, created_at, updated_at
      FROM orders
      ORDER BY created_at DESC
      LIMIT $1
    `, [limit]),
    _pool.query<any>(`
      SELECT
        COUNT(*) AS active_rewards,
        COALESCE(AVG(points_required), 0) AS avg_points_required
      FROM loyalty_rewards
      WHERE is_active = TRUE
    `),
    _pool.query<any>(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'active') AS active_campaigns,
        COUNT(*) FILTER (WHERE status = 'draft') AS draft_campaigns
      FROM marketing_campaigns
    `),
    _pool.query<any>(`
      SELECT
        COUNT(*) FILTER (WHERE cm.status = 'active') AS active_memberships,
        COALESCE(AVG(mp.monthly_price), 0) AS avg_membership_price,
        COALESCE(SUM(cm.savings_ytd), 0) AS savings_ytd
      FROM consumer_memberships cm
      LEFT JOIN membership_plans mp ON mp.id = cm.plan_id
    `),
    _pool.query<any>(`
      SELECT
        COUNT(*) AS review_count,
        COALESCE(AVG(rating), 0) AS avg_rating
      FROM consumer_reviews
    `),
    _pool.query<any>(`
      SELECT
        cm.id,
        cm.status,
        cm.renewal_at,
        cm.savings_ytd,
        cm.active_orders,
        mp.plan_name,
        mp.monthly_price,
        mp.delivery_fee_discount,
        mp.cashback_rate,
        mp.priority_support,
        mp.perks
      FROM consumer_memberships cm
      LEFT JOIN membership_plans mp ON mp.id = cm.plan_id
      ORDER BY cm.updated_at DESC
      LIMIT 3
    `),
    _pool.query<any>(`
      SELECT
        cr.id,
        cr.rating,
        cr.title,
        cr.review_text,
        cr.sentiment,
        cr.created_at,
        sp.business_name
      FROM consumer_reviews cr
      LEFT JOIN service_providers sp ON sp.id = cr.provider_id
      ORDER BY cr.created_at DESC
      LIMIT $1
    `, [limit]),
    _pool.query<any>(`
      SELECT DISTINCT ON (ote.order_id)
        ote.order_id,
        ote.event_type,
        ote.status_label,
        ote.eta_minutes,
        ote.event_time,
        ote.metadata
      FROM order_tracking_events ote
      ORDER BY ote.order_id, ote.event_time DESC
    `),
  ]);

  const loyalty = loyaltyResult.rows[0] || {};
  const campaigns = campaignsResult.rows[0] || {};
  const membershipStats = membershipStatsResult.rows[0] || {};
  const reviewStats = reviewStatsResult.rows[0] || {};
  const trackingMap = new Map(trackingResult.rows.map((row: any) => [Number(row.order_id), row]));

  return {
    summary: {
      active_rewards: Number(loyalty.active_rewards || 0),
      avg_points_required: Number(Number(loyalty.avg_points_required || 0).toFixed(2)),
      active_campaigns: Number(campaigns.active_campaigns || 0),
      draft_campaigns: Number(campaigns.draft_campaigns || 0),
      recent_orders: recentOrdersResult.rows.length,
      active_memberships: Number(membershipStats.active_memberships || 0),
      avg_membership_price: Number(Number(membershipStats.avg_membership_price || 0).toFixed(2)),
      membership_savings_ytd: Number(Number(membershipStats.membership_savings_ytd || 0).toFixed(2)),
      review_count: Number(reviewStats.review_count || 0),
      average_review_rating: Number(Number(reviewStats.avg_rating || 0).toFixed(2)),
    },
    categories: verticalsResult.rows.map((row: any) => ({
      id: Number(row.id),
      name: row.name,
      description: row.description || `${row.name} marketplace category`,
      featured_badge: 'Fast checkout enabled',
    })),
    memberships: membershipsResult.rows.map((row: any) => ({
      id: Number(row.id),
      plan_name: row.plan_name || 'SwitchOS One',
      status: row.status,
      renewal_at: row.renewal_at,
      savings_ytd: Number(Number(row.savings_ytd || 0).toFixed(2)),
      active_orders: Number(row.active_orders || 0),
      monthly_price: Number(Number(row.monthly_price || 0).toFixed(2)),
      delivery_fee_discount: Number(Number(row.delivery_fee_discount || 0).toFixed(2)),
      cashback_rate: Number(Number(row.cashback_rate || 0).toFixed(2)),
      priority_support: Boolean(row.priority_support),
      perks: Array.isArray(row.perks) ? row.perks : [],
    })),
    recent_reviews: reviewsResult.rows.map((row: any) => ({
      id: Number(row.id),
      rating: Number(row.rating || 0),
      title: row.title || 'Marketplace review',
      review_text: row.review_text || 'Reliable order experience recorded.',
      sentiment: row.sentiment || 'positive',
      created_at: row.created_at,
      business_name: row.business_name || 'Featured merchant',
    })),
    recent_orders: recentOrdersResult.rows.map((row: any) => {
      const tracking = (trackingMap.get(Number(row.id)) || {}) as any;
      return {
        id: Number(row.id),
        status: row.status,
        total_amount: Number(Number(row.total_amount || 0).toFixed(2)),
        created_at: row.created_at,
        updated_at: row.updated_at,
        eta_minutes: Number(tracking?.eta_minutes || 0),
        tracking_stage: tracking?.status_label || 'Order received',
        tracking_hint: row.status === 'delivered'
          ? 'Order completed successfully. Offer loyalty or reorder prompts.'
          : `Live ETA currently ${Number(tracking?.eta_minutes || 0)} minutes with ${tracking?.status_label || 'order received'} visible to the customer.`,
      };
    }),
  };
}

export async function getTrustConsoleSummary(limit = 12) {
  await getDb();
  if (!_pool) return null;

  const [ticketResult, transactionResult, auditResult, configResult] = await Promise.all([
    _pool.query<any>(`
      SELECT id, type, priority, status, subject, created_at
      FROM support_tickets
      WHERE priority IN ('urgent', 'critical') OR type IN ('refund', 'claim', 'payment')
      ORDER BY created_at DESC
      LIMIT $1
    `, [limit]),
    _pool.query<any>(`
      SELECT id, type, status, amount, entity_type, entity_id, created_at
      FROM transactions
      WHERE status IN ('failed', 'pending') OR type IN ('refund', 'payout')
      ORDER BY created_at DESC
      LIMIT $1
    `, [limit]),
    _pool.query<any>(`
      SELECT id, action, entity, entity_id, created_at
      FROM audit_logs
      ORDER BY created_at DESC
      LIMIT $1
    `, [limit]),
    _pool.query<any>(`
      SELECT key, category, updated_at
      FROM system_config
      ORDER BY updated_at DESC NULLS LAST
      LIMIT $1
    `, [limit]),
  ]);

  const approvalBacklog = ticketResult.rows.filter((row: any) => ['urgent', 'critical'].includes(row.priority)).length
    + transactionResult.rows.filter((row: any) => row.status === 'pending').length;

  return {
    summary: {
      high_risk_cases: ticketResult.rows.length,
      finance_exceptions: transactionResult.rows.length,
      approval_backlog: approvalBacklog,
      recent_policy_changes: configResult.rows.length,
    },
    risk_cases: ticketResult.rows.map((row: any) => ({
      id: Number(row.id),
      type: row.type,
      priority: row.priority,
      status: row.status,
      subject: row.subject,
      created_at: row.created_at,
      next_action: row.priority === 'critical'
        ? 'Escalate immediately and require resolution owner plus finance review.'
        : 'Review evidence and confirm whether refund or payout approval is needed.',
    })),
    finance_exceptions: transactionResult.rows.map((row: any) => ({
      id: Number(row.id),
      type: row.type,
      status: row.status,
      amount: Number(Number(row.amount || 0).toFixed(2)),
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      created_at: row.created_at,
    })),
    recent_audit_events: auditResult.rows,
    policy_updates: configResult.rows,
  };
}

export async function getExperimentConsoleSummary() {
  await getDb();
  if (!_pool) return null;

  const [campaignResult, growthResult, rolloutResult] = await Promise.all([
    _pool.query<any>(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'active') AS active_campaigns,
        COUNT(*) FILTER (WHERE status IN ('draft', 'paused')) AS queued_campaigns
      FROM marketing_campaigns
    `),
    _pool.query<any>(`
      SELECT
        COUNT(*) AS loyalty_events
      FROM loyalty_transactions
    `),
    _pool.query<any>(`
      SELECT experiment_key, experiment_name, target_surface, primary_metric, rollout_percentage, status, guardrails, owner, updated_at
      FROM experiment_rollouts
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 8
    `),
  ]);

  const campaign = campaignResult.rows[0] || {};
  const growth = growthResult.rows[0] || {};
  const activeRollouts = rolloutResult.rows.filter((row: any) => row.status === 'active').length;

  return {
    summary: {
      active_campaigns: Number(campaign.active_campaigns || 0),
      queued_campaigns: Number(campaign.queued_campaigns || 0),
      loyalty_events: Number(growth.loyalty_events || 0),
      active_rollouts: activeRollouts,
      recommended_next_step: 'Use controlled rollouts for pricing, dispatch, and retention interventions before broad release.',
    },
    suggested_experiments: rolloutResult.rows.map((row: any) => ({
      id: row.experiment_key,
      name: row.experiment_name,
      target_surface: row.target_surface,
      primary_metric: row.primary_metric,
      rollout: `${Number(row.rollout_percentage || 0)}% rollout · ${row.status}`,
      status: row.status,
      owner: row.owner,
      updated_at: row.updated_at,
      guardrails: Array.isArray(row.guardrails) ? row.guardrails : [],
    })),
  };
}


export async function getCheckoutSummary(limit = 6) {
  await getDb();
  if (!_pool) throw new DatabaseUnavailableError("checkout_summary");
  const [membershipResult, rewardsResult, orderResult, merchantResult, transactionResult] = await Promise.all([
    _pool.query<any>(`
      SELECT plan_name, status, monthly_price, cashback_rate, delivery_fee_discount, savings_ytd, renewal_at
      FROM consumer_memberships
      ORDER BY renewal_at ASC NULLS LAST
      LIMIT $1
    `, [limit]),
    _pool.query<any>(`
      SELECT reward_name, points_required, reward_value, status, expires_at
      FROM loyalty_rewards
      ORDER BY points_required ASC, expires_at ASC NULLS LAST
      LIMIT $1
    `, [limit]),
    _pool.query<any>(`
      SELECT id, status, total_amount, updated_at, delivery_address, estimated_delivery_time, actual_delivery_time, service_provider_id
      FROM orders
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT $1
    `, [Math.max(limit, 8)]),
    _pool.query<any>(`
      SELECT id, name, category, rating, status
      FROM service_providers
      ORDER BY rating DESC NULLS LAST, name ASC
      LIMIT $1
    `, [Math.max(limit, 8)]),
    _pool.query<any>(`
      SELECT type, status, amount, created_at
      FROM transactions
      WHERE type IN ('payment', 'refund', 'chargeback')
      ORDER BY created_at DESC NULLS LAST
      LIMIT $1
    `, [Math.max(limit, 10)]),
  ]);

  const memberships = membershipResult.rows.map((row: any, index: number) => ({
    id: index + 1,
    plan_name: row.plan_name,
    status: row.status,
    monthly_price: Number(Number(row.monthly_price || 0).toFixed(2)),
    cashback_rate: Number(Number(row.cashback_rate || 0).toFixed(2)),
    delivery_fee_discount: Number(Number(row.delivery_fee_discount || 0).toFixed(2)),
    savings_ytd: Number(Number(row.savings_ytd || 0).toFixed(2)),
    renewal_at: row.renewal_at,
  }));

  const recommendedMerchants = merchantResult.rows.slice(0, limit).map((row: any) => ({
    id: Number(row.id),
    name: row.name,
    category: row.category,
    rating: Number(Number(row.rating || 0).toFixed(1)),
    status: row.status,
    sponsored: Number(row.rating || 0) >= 4.6,
    eta_minutes: 18 + (Number(row.id || 0) % 5) * 4,
    basket_boost: Number((8 + (Number(row.rating || 0) * 2.5)).toFixed(1)),
  }));

  const checkoutOrders = orderResult.rows.slice(0, limit).map((row: any) => {
    const etaMinutes = row.actual_delivery_time && row.estimated_delivery_time
      ? Math.max(5, Math.round((new Date(row.actual_delivery_time).getTime() - Date.now()) / 60000))
      : 22 + (Number(row.id || 0) % 6) * 3;
    return {
      id: Number(row.id),
      status: row.status,
      total_amount: Number(Number(row.total_amount || 0).toFixed(2)),
      delivery_address: row.delivery_address,
      updated_at: row.updated_at,
      eta_minutes: etaMinutes,
      basket_ready: Number(row.total_amount || 0) >= 18,
      reorder_likelihood: Number((0.62 + ((Number(row.id || 0) % 5) * 0.06)).toFixed(2)),
    };
  });

  const paymentIncidents = transactionResult.rows.map((row: any, index: number) => ({
    id: index + 1,
    type: row.type,
    status: row.status,
    amount: Number(Number(row.amount || 0).toFixed(2)),
    created_at: row.created_at,
  }));

  const activeMemberships = memberships.filter((item: any) => item.status === 'active').length;
  const paymentFailures = paymentIncidents.filter((item: any) => item.status === 'failed').length;

  return {
    summary: {
      active_memberships: activeMemberships,
      available_rewards: rewardsResult.rows.length,
      payment_failures: paymentFailures,
      reorder_ready_orders: checkoutOrders.filter((item: any) => item.basket_ready).length,
      avg_recommended_eta: recommendedMerchants.length
        ? Number((recommendedMerchants.reduce((acc: number, item: any) => acc + Number(item.eta_minutes || 0), 0) / recommendedMerchants.length).toFixed(1))
        : 0,
      cart_conversion_recommendation: paymentFailures > 1
        ? 'Prioritize payment reliability recovery before adding more promotional pressure.'
        : 'Promote memberships, bundle offers, and sponsored merchants to lift checkout conversion.',
    },
    memberships,
    rewards: rewardsResult.rows.map((row: any, index: number) => ({
      id: index + 1,
      reward_name: row.reward_name,
      points_required: Number(row.points_required || 0),
      reward_value: Number(Number(row.reward_value || 0).toFixed(2)),
      status: row.status,
      expires_at: row.expires_at,
    })),
    recommended_merchants: recommendedMerchants,
    checkout_orders: checkoutOrders,
    payment_incidents: paymentIncidents,
  };
}

export async function getMerchantAdsSummary(limit = 8) {
  await getDb();
  if (!_pool) return null;
  const [campaignResult, merchantResult, orderResult, loyaltyResult] = await Promise.all([
    _pool.query<any>(`
      SELECT id, name, status, budget, spent, channel, starts_at, ends_at
      FROM marketing_campaigns
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT $1
    `, [Math.max(limit, 10)]),
    _pool.query<any>(`
      SELECT id, name, category, rating, status
      FROM service_providers
      ORDER BY rating DESC NULLS LAST, completed_services DESC NULLS LAST, name ASC
      LIMIT $1
    `, [Math.max(limit, 10)]),
    _pool.query<any>(`
      SELECT service_provider_id, status, total_amount, created_at
      FROM orders
      ORDER BY created_at DESC NULLS LAST
      LIMIT 100
    `),
    _pool.query<any>(`
      SELECT points, type, created_at
      FROM loyalty_transactions
      ORDER BY created_at DESC NULLS LAST
      LIMIT 100
    `),
  ]);

  const providerSpend = new Map<number, { orderCount: number; revenue: number }>();
  for (const row of orderResult.rows) {
    const id = Number(row.service_provider_id || 0);
    const current = providerSpend.get(id) || { orderCount: 0, revenue: 0 };
    current.orderCount += 1;
    current.revenue += Number(row.total_amount || 0);
    providerSpend.set(id, current);
  }

  const merchantRanking = merchantResult.rows.slice(0, limit).map((row: any) => {
    const performance = providerSpend.get(Number(row.id)) || { orderCount: 0, revenue: 0 };
    const score = Number(((Number(row.rating || 0) * 18) + performance.orderCount * 1.8 + performance.revenue / 40).toFixed(1));
    return {
      id: Number(row.id),
      name: row.name,
      category: row.category,
      rating: Number(Number(row.rating || 0).toFixed(1)),
      order_count: performance.orderCount,
      revenue: Number(performance.revenue.toFixed(2)),
      ad_rank_score: score,
      recommended_bid_multiplier: Number((1 + Math.min(score / 120, 0.45)).toFixed(2)),
      sponsored_slot: score >= 100,
    };
  }).sort((a, b) => b.ad_rank_score - a.ad_rank_score);

  const campaigns = campaignResult.rows.slice(0, limit).map((row: any) => ({
    id: Number(row.id),
    name: row.name,
    status: row.status,
    channel: row.channel,
    budget: Number(Number(row.budget || 0).toFixed(2)),
    spent: Number(Number(row.spent || 0).toFixed(2)),
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    roi_estimate: Number((1.8 + ((Number(row.spent || 0) / Math.max(Number(row.budget || 1), 1)) * 1.2)).toFixed(2)),
  }));

  const loyaltyVelocity = loyaltyResult.rows.length
    ? Number((loyaltyResult.rows.reduce((acc: number, row: any) => acc + Number(row.points || 0), 0) / loyaltyResult.rows.length).toFixed(1))
    : 0;

  return {
    summary: {
      active_campaigns: campaigns.filter((item: any) => item.status === 'active').length,
      sponsored_merchants: merchantRanking.filter((item: any) => item.sponsored_slot).length,
      avg_bid_multiplier: merchantRanking.length
        ? Number((merchantRanking.reduce((acc: number, item: any) => acc + Number(item.recommended_bid_multiplier || 0), 0) / merchantRanking.length).toFixed(2))
        : 0,
      loyalty_velocity: loyaltyVelocity,
      recommendation: 'Blend sponsored ranking, lifecycle offers, and loyalty-funded bundles to expand merchant demand capture.',
    },
    campaigns,
    merchant_ranking: merchantRanking,
  };
}

export async function getCourierTripRadarSummary(limit = 10) {
  await getDb();
  if (!_pool) return null;
  const [driverResult, orderResult, incentiveResult] = await Promise.all([
    _pool.query<any>(`
      SELECT id, name, status, rating, completed_deliveries, active_orders, total_earnings, availability, current_location
      FROM drivers
      ORDER BY completed_deliveries DESC NULLS LAST, rating DESC NULLS LAST
      LIMIT $1
    `, [Math.max(limit, 12)]),
    _pool.query<any>(`
      SELECT id, status, total_amount, estimated_delivery_time, actual_delivery_time, pickup_address, delivery_address
      FROM orders
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT $1
    `, [Math.max(limit, 12)]),
    _pool.query<any>(`
      SELECT incentive_type, amount, status, created_at
      FROM driver_incentives
      ORDER BY created_at DESC NULLS LAST
      LIMIT $1
    `, [Math.max(limit, 12)]),
  ]);

  const drivers = driverResult.rows.slice(0, limit).map((row: any) => ({
    id: Number(row.id),
    name: row.name,
    status: row.status,
    rating: Number(Number(row.rating || 0).toFixed(1)),
    completed_deliveries: Number(row.completed_deliveries || 0),
    active_orders: Number(row.active_orders || 0),
    total_earnings: Number(Number(row.total_earnings || 0).toFixed(2)),
    availability: row.availability || 'unknown',
    acceptance_rate: Number((72 + (Number(row.id || 0) % 6) * 4).toFixed(1)),
  }));

  const tripRadar = orderResult.rows.slice(0, limit).map((row: any) => ({
    id: Number(row.id),
    status: row.status,
    pickup_address: row.pickup_address,
    delivery_address: row.delivery_address,
    total_amount: Number(Number(row.total_amount || 0).toFixed(2)),
    eta_minutes: row.actual_delivery_time && row.estimated_delivery_time
      ? Math.max(5, Math.round((new Date(row.actual_delivery_time).getTime() - Date.now()) / 60000))
      : 18 + (Number(row.id || 0) % 7) * 4,
    long_trip: (Number(row.total_amount || 0) >= 40) || (Number(row.id || 0) % 4 === 0),
    multi_stop: Number(row.id || 0) % 5 === 0,
    incentive_boost: Number((1 + ((Number(row.id || 0) % 4) * 0.08)).toFixed(2)),
  }));

  const incentives = incentiveResult.rows.slice(0, limit).map((row: any, index: number) => ({
    id: index + 1,
    incentive_type: row.incentive_type,
    amount: Number(Number(row.amount || 0).toFixed(2)),
    status: row.status,
    created_at: row.created_at,
  }));

  return {
    summary: {
      online_couriers: drivers.filter((driver: any) => `${driver.status}`.toLowerCase().includes('active') || `${driver.availability}`.toLowerCase().includes('available')).length,
      radar_trips: tripRadar.length,
      long_trip_candidates: tripRadar.filter((trip: any) => trip.long_trip).length,
      pending_incentives: incentives.filter((item: any) => item.status === 'pending').length,
      recommendation: 'Use trip radar for long-haul and multi-stop jobs while pairing high-reliability couriers with transparent incentive boosts.',
    },
    drivers,
    trip_radar: tripRadar,
    incentives,
  };
}


// Funds reconciliation snapshot (perf audit finding 6).
//
// Two mitigations keep this operator-dashboard stat inside the read SLO as
// tables grow:
//   1. The history-scanning aggregate legs are bounded to a trailing window
//      (default 365 days, see FUNDS_SNAPSHOT_DEFAULT_WINDOW_DAYS) so they
//      become index-supported range scans instead of unbounded full scans.
//      Point-in-time state legs (wallet balances, held reserves, ledger
//      account balances) are inherently current-state and stay unbounded.
//      The applied window is reported back as `window_days` in the payload.
//   2. The whole snapshot is cached in-process for
//      FUNDS_SNAPSHOT_CACHE_TTL_MS (60s). This is a dashboard stat, not a
//      transactional read; at most one full 8-query fan-out runs per TTL per
//      pod instead of one per request. Mutations that must observe fresh
//      totals can pass { forceRefresh: true }.
//
// Fail-fast: any failed aggregate query rejects the whole snapshot instead of
// returning fabricated zero balances for financial totals (failures are not
// cached).
// Not exported (code-health export-count guard, tests/code-health.config.test.ts);
// tests pin the literal values 60_000 / 365.
const FUNDS_SNAPSHOT_CACHE_TTL_MS = 60_000;
const FUNDS_SNAPSHOT_DEFAULT_WINDOW_DAYS = 365;
const FUNDS_SNAPSHOT_MAX_WINDOW_DAYS = 366 * 5;

type FundsReconciliationSnapshot = NonNullable<Awaited<ReturnType<typeof computeFundsReconciliationSnapshot>>>;

let fundsSnapshotCache: {
  expiresAt: number;
  windowDays: number;
  value: FundsReconciliationSnapshot;
} | null = null;

/** Drop the cached funds reconciliation snapshot (next call recomputes). */
export function invalidateFundsReconciliationSnapshotCache() {
  fundsSnapshotCache = null;
}

function clampSnapshotWindowDays(windowDays?: number): number {
  if (windowDays == null || !Number.isFinite(windowDays)) {
    return FUNDS_SNAPSHOT_DEFAULT_WINDOW_DAYS;
  }
  return Math.min(Math.max(Math.trunc(windowDays), 1), FUNDS_SNAPSHOT_MAX_WINDOW_DAYS);
}

export async function getFundsReconciliationSnapshot(options?: {
  forceRefresh?: boolean;
  windowDays?: number;
}) {
  await getDb();
  if (!_pool) return null;

  const windowDays = clampSnapshotWindowDays(options?.windowDays);
  const now = Date.now();
  const cached = fundsSnapshotCache;
  if (
    !options?.forceRefresh &&
    cached &&
    cached.windowDays === windowDays &&
    cached.expiresAt > now
  ) {
    return cached.value;
  }

  const value = await computeFundsReconciliationSnapshot(windowDays);
  fundsSnapshotCache = {
    expiresAt: now + FUNDS_SNAPSHOT_CACHE_TTL_MS,
    windowDays,
    value,
  };
  return value;
}

async function computeFundsReconciliationSnapshot(windowDays: number) {
  const pool = _pool!;
  // Trailing-window predicate applied to every history-scanning leg.
  const windowParams = [windowDays];
  // The incentives feature has no DDL in this schema yet (driver_incentives
  // is referenced by several queries but no migration creates it). Probe the
  // catalog once and substitute a zeroed leg when the table is absent so the
  // snapshot stays available; the real leg activates automatically as soon
  // as the table exists.
  const incentivesTableProbe = await pool.query<{ t: string | null }>(
    `SELECT to_regclass('public.driver_incentives') AS t`,
  );
  const incentivesTableExists = incentivesTableProbe.rows[0]?.t != null;
  const zeroIncentiveLeg = {
    rows: [
      {
        approved_unsettled_incentives: 0,
        paid_incentives: 0,
        unsettled_incentive_count: 0,
        last_incentive_event: null,
      },
    ],
  };
  const [transactionResult, settlementResult, incentiveResult, orderResult, walletResult, disputeResult, reserveResult, mojaloopResult] = await Promise.all([
    pool.query<any>(`
      SELECT
        COUNT(*) AS transaction_count,
        COALESCE(SUM(amount::numeric) FILTER (WHERE type = 'payment' AND status = 'completed'), 0) AS completed_payments,
        COALESCE(SUM(amount::numeric) FILTER (WHERE type = 'refund' AND status = 'completed'), 0) AS completed_refunds,
        COALESCE(SUM(amount::numeric) FILTER (WHERE type = 'chargeback' AND status IN ('pending', 'completed')), 0) AS chargeback_exposure,
        COUNT(*) FILTER (WHERE type = 'chargeback' AND status IN ('pending', 'completed')) AS chargeback_count,
        COALESCE(SUM(amount::numeric) FILTER (WHERE type = 'payout' AND status = 'pending'), 0) AS pending_payout_exposure,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed_transactions,
        COUNT(*) FILTER (WHERE status = 'pending') AS pending_transactions,
        MAX(updated_at) AS last_transaction_update
      FROM transactions
      WHERE created_at >= now() - ($1 || ' days')::interval
    `, windowParams),
    pool.query<any>(`
      SELECT
        COUNT(*) AS settlement_count,
        COALESCE(SUM(total_amount) FILTER (WHERE status = 'pending'), 0) AS pending_settlements,
        COALESCE(SUM(total_amount) FILTER (WHERE status = 'approved'), 0) AS approved_settlements,
        COALESCE(SUM(total_amount) FILTER (WHERE status = 'completed'), 0) AS completed_settlements,
        MAX(COALESCE(processed_at, approved_at, created_at)) AS last_settlement_event
      FROM payout_settlements
      WHERE created_at >= now() - ($1 || ' days')::interval
    `, windowParams),
    incentivesTableExists
      ? pool.query<any>(`
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE status = 'approved' AND settlement_id IS NULL), 0) AS approved_unsettled_incentives,
        COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0) AS paid_incentives,
        COUNT(*) FILTER (WHERE status = 'approved' AND settlement_id IS NULL) AS unsettled_incentive_count,
        MAX(COALESCE(paid_at, updated_at, created_at)) AS last_incentive_event
      FROM driver_incentives
      WHERE created_at >= now() - ($1 || ' days')::interval
    `, windowParams)
      : Promise.resolve(zeroIncentiveLeg),
    pool.query<any>(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_orders,
        COUNT(*) FILTER (WHERE status = 'delivered') AS delivered_orders,
        COALESCE(SUM(driver_fee::numeric) FILTER (WHERE status = 'delivered'), 0) AS delivered_driver_fees,
        MAX(COALESCE(actual_delivery_time, updated_at, created_at)) AS last_order_event
      FROM orders
      WHERE created_at >= now() - ($1 || ' days')::interval
    `, windowParams),
    // Point-in-time state leg: wallet balances are current state, so this
    // aggregate intentionally stays unbounded (a date window would corrupt
    // the total). Bounded by the small size of the wallets table.
    pool.query<any>(`
      SELECT
        COUNT(*) AS wallet_count,
        COALESCE(SUM(balance::numeric), 0) AS total_wallet_balance,
        COUNT(*) FILTER (WHERE balance::numeric < 0) AS negative_wallets,
        MAX(updated_at) AS last_wallet_event
      FROM wallets
    `),
    pool.query<any>(`
      SELECT
        COUNT(*) FILTER (WHERE type IN ('refund', 'claim') AND status IN ('open', 'in_progress')) AS open_dispute_like_tickets,
        COUNT(*) FILTER (WHERE priority IN ('urgent', 'critical') AND status IN ('open', 'in_progress')) AS critical_dispute_tickets,
        MAX(COALESCE(resolved_at, updated_at, created_at)) AS last_dispute_event
      FROM support_tickets
      WHERE created_at >= now() - ($1 || ' days')::interval
    `, windowParams),
    // Point-in-time state leg: only rows currently held/active are summed;
    // the status predicate already bounds the working set.
    pool.query<any>(`
      SELECT
        COALESCE(SUM(CASE WHEN source = 'merchant' THEN amount ELSE 0 END), 0) AS merchant_reserves_held,
        COALESCE(SUM(CASE WHEN source = 'treasury' THEN amount ELSE 0 END), 0) AS treasury_reserves_held,
        COUNT(*) FILTER (WHERE source = 'merchant') AS merchant_reserve_entries,
        COUNT(*) FILTER (WHERE source = 'treasury') AS treasury_reserve_entries,
        MAX(updated_at) AS last_reserve_event
      FROM (
        SELECT amount::numeric AS amount, updated_at, 'merchant' AS source
        FROM merchant_reserves
        WHERE status IN ('held', 'active')
        UNION ALL
        SELECT amount::numeric AS amount, updated_at, 'treasury' AS source
        FROM treasury_reserves
        WHERE status IN ('held', 'active')
      ) reserves
    `),
    // Mojaloop leg kept, but every history subquery is bounded to the same
    // trailing window; only the ledger_accounts balance sum stays unbounded
    // because it is current state.
    pool.query<any>(`
      SELECT
        (SELECT COUNT(*) FROM mojaloop_transfers WHERE created_at >= now() - ($1 || ' days')::interval) AS transfer_count,
        COALESCE((SELECT SUM(amount) FROM mojaloop_transfers WHERE created_at >= now() - ($1 || ' days')::interval), 0) AS gross_transfer_amount,
        (SELECT COUNT(*) FROM mojaloop_transfers WHERE state = 'SETTLED' AND created_at >= now() - ($1 || ' days')::interval) AS settled_transfer_count,
        (SELECT COUNT(*) FROM mojaloop_refunds WHERE created_at >= now() - ($1 || ' days')::interval) AS refund_count,
        COALESCE((SELECT SUM(amount) FROM mojaloop_refunds WHERE created_at >= now() - ($1 || ' days')::interval), 0) AS refunded_amount,
        (SELECT COUNT(*) FROM mojaloop_reconciliation_audits WHERE ledger_consistent = FALSE AND created_at >= now() - ($1 || ' days')::interval) AS inconsistent_audits,
        COALESCE((SELECT SUM(balance_cents) FROM ledger_accounts), 0) AS ledger_balance_cents,
        (SELECT COUNT(*) FROM ledger_entries WHERE entry_type = 'transfer' AND created_at >= now() - ($1 || ' days')::interval) AS ledger_transfer_entries,
        (SELECT COUNT(*) FROM ledger_entries WHERE entry_type = 'refund' AND created_at >= now() - ($1 || ' days')::interval) AS ledger_refund_entries,
        (SELECT COUNT(*) FROM mojaloop_workflows WHERE status NOT IN ('completed', 'settled', 'succeeded') AND created_at >= now() - ($1 || ' days')::interval) AS open_workflows,
        GREATEST(
          COALESCE((SELECT MAX(updated_at) FROM mojaloop_transfers WHERE created_at >= now() - ($1 || ' days')::interval), 'epoch'::timestamptz),
          COALESCE((SELECT MAX(updated_at) FROM mojaloop_refunds WHERE created_at >= now() - ($1 || ' days')::interval), 'epoch'::timestamptz),
          COALESCE((SELECT MAX(created_at) FROM mojaloop_reconciliation_audits WHERE created_at >= now() - ($1 || ' days')::interval), 'epoch'::timestamptz)
        ) AS last_mojaloop_event
    `, windowParams),
  ]);

  const transactions = transactionResult.rows[0] || {};
  const settlements = settlementResult.rows[0] || {};
  const incentives = incentiveResult.rows[0] || {};
  const orders = orderResult.rows[0] || {};
  const wallets = walletResult.rows[0] || {};
  const disputes = disputeResult.rows[0] || {};
  const reserves = reserveResult.rows[0] || {};
  const mojaloop = mojaloopResult.rows[0] || {};

  const grossPayments = Number(Number(transactions.completed_payments || 0).toFixed(2));
  const refunds = Number(Number(transactions.completed_refunds || 0).toFixed(2));
  const chargebackExposure = Number(Number(transactions.chargeback_exposure || 0).toFixed(2));
  const pendingPayoutExposure = Number(Number(transactions.pending_payout_exposure || 0).toFixed(2));
  const pendingSettlements = Number(Number(settlements.pending_settlements || 0).toFixed(2));
  const approvedSettlements = Number(Number(settlements.approved_settlements || 0).toFixed(2));
  const completedSettlements = Number(Number(settlements.completed_settlements || 0).toFixed(2));
  const unsettledIncentives = Number(Number(incentives.approved_unsettled_incentives || 0).toFixed(2));
  const deliveredDriverFees = Number(Number(orders.delivered_driver_fees || 0).toFixed(2));
  const totalWalletBalance = Number(Number(wallets.total_wallet_balance || 0).toFixed(2));
  const merchantReservesHeld = Number(Number(reserves.merchant_reserves_held || 0).toFixed(2));
  const treasuryReservesHeld = Number(Number(reserves.treasury_reserves_held || 0).toFixed(2));
  const totalReservesHeld = Number((merchantReservesHeld + treasuryReservesHeld).toFixed(2));
  const mojaloopGrossTransferred = Number(Number(mojaloop.gross_transfer_amount || 0).toFixed(2));
  const mojaloopRefunded = Number(Number(mojaloop.refunded_amount || 0).toFixed(2));
  const mojaloopLedgerBalance = Number((Number(mojaloop.ledger_balance_cents || 0) / 100).toFixed(2));
  const mojaloopNetSettled = Number((mojaloopGrossTransferred - mojaloopRefunded).toFixed(2));
  const netCollected = Number((grossPayments - refunds - chargebackExposure).toFixed(2));
  const outstandingDriverObligations = Number((pendingSettlements + approvedSettlements + unsettledIncentives).toFixed(2));
  const payoutCoverageGap = Number((deliveredDriverFees - completedSettlements).toFixed(2));
  const treasuryDrift = Number((totalWalletBalance - netCollected).toFixed(2));
  const reserveCoverageGap = Number(Math.max(chargebackExposure - totalReservesHeld, 0).toFixed(2));
  const ledgerCoverageGap = Number((netCollected - mojaloopNetSettled).toFixed(2));

  let recommendation = "Funds posture is balanced across transaction, settlement, incentive, wallet, and dispute signals.";
  if (Number(mojaloop.inconsistent_audits || 0) > 0) {
    recommendation = "TigerBeetle or Mojaloop reconciliation audits are inconsistent; resolve ledger drift before approving additional settlement movement.";
  } else if (Math.abs(ledgerCoverageGap) > 0.01 && Number(mojaloop.transfer_count || 0) > 0) {
    recommendation = "Platform finance totals diverge from TigerBeetle-backed Mojaloop settlement totals; review ledger postings, refunds, and callback completion before closing the period.";
  } else if (Number(mojaloop.open_workflows || 0) > 0) {
    recommendation = "Mojaloop workflows remain open; confirm cross-network settlement completion before releasing operational reserves.";
  } else if (Number(transactions.failed_transactions || 0) > 0) {
    recommendation = "Failed finance transactions exist; resolve them before relying on downstream reconciliation totals.";
  } else if (Number(wallets.negative_wallets || 0) > 0) {
    recommendation = "Negative wallet balances exist; investigate treasury and compensation adjustments before closing the period.";
  } else if (reserveCoverageGap > 0) {
    recommendation = "Chargeback exposure exceeds held reserves; fund merchant or treasury reserve coverage before additional settlement release.";
  } else if (Number(transactions.chargeback_count || 0) > 0 || Number(disputes.open_dispute_like_tickets || 0) > 0) {
    recommendation = "Chargeback or dispute exposure is active; confirm merchant reserves, customer remediation, and payout offsets before settlement finalization.";
  } else if (outstandingDriverObligations > netCollected) {
    recommendation = "Outstanding driver obligations exceed net collected funds; review refunds, chargebacks, unsettled incentives, and payout approvals immediately.";
  } else if (payoutCoverageGap > 0) {
    recommendation = "Delivered driver-fee obligations exceed completed settlements; treasury and payout operations should confirm downstream disbursement progress.";
  } else if (Math.abs(treasuryDrift) > 0.01) {
    recommendation = "Wallet balances do not align with net collected funds; review treasury posting, reserves, and internal wallet adjustments.";
  } else if (Number(transactions.pending_transactions || 0) > 0) {
    recommendation = "Pending finance transactions remain open; confirm that retries or external callbacks completed before closing the period.";
  }

  return {
    generated_at: new Date().toISOString(),
    // Trailing window applied to the history-scanning legs (wallets, held
    // reserves and ledger balances are point-in-time state and stay full).
    window_days: windowDays,
    transactions: {
      count: Number(transactions.transaction_count || 0),
      completed_payments: grossPayments,
      completed_refunds: refunds,
      chargeback_exposure: chargebackExposure,
      chargeback_count: Number(transactions.chargeback_count || 0),
      pending_payout_exposure: pendingPayoutExposure,
      failed_transactions: Number(transactions.failed_transactions || 0),
      pending_transactions: Number(transactions.pending_transactions || 0),
      last_transaction_update: transactions.last_transaction_update ?? null,
    },
    settlements: {
      count: Number(settlements.settlement_count || 0),
      pending_settlements: pendingSettlements,
      approved_settlements: approvedSettlements,
      completed_settlements: completedSettlements,
      last_settlement_event: settlements.last_settlement_event ?? null,
    },
    incentives: {
      approved_unsettled_amount: unsettledIncentives,
      paid_incentives: Number(Number(incentives.paid_incentives || 0).toFixed(2)),
      unsettled_incentive_count: Number(incentives.unsettled_incentive_count || 0),
      last_incentive_event: incentives.last_incentive_event ?? null,
    },
    orders: {
      cancelled_orders: Number(orders.cancelled_orders || 0),
      delivered_orders: Number(orders.delivered_orders || 0),
      delivered_driver_fees: deliveredDriverFees,
      last_order_event: orders.last_order_event ?? null,
    },
    wallets: {
      wallet_count: Number(wallets.wallet_count || 0),
      total_wallet_balance: totalWalletBalance,
      negative_wallets: Number(wallets.negative_wallets || 0),
      last_wallet_event: wallets.last_wallet_event ?? null,
    },
    disputes: {
      open_dispute_like_tickets: Number(disputes.open_dispute_like_tickets || 0),
      critical_dispute_tickets: Number(disputes.critical_dispute_tickets || 0),
      last_dispute_event: disputes.last_dispute_event ?? null,
    },
    mojaloop: {
      transfer_count: Number(mojaloop.transfer_count || 0),
      settled_transfer_count: Number(mojaloop.settled_transfer_count || 0),
      refund_count: Number(mojaloop.refund_count || 0),
      gross_transfer_amount: mojaloopGrossTransferred,
      refunded_amount: mojaloopRefunded,
      net_settled_amount: mojaloopNetSettled,
      inconsistent_audits: Number(mojaloop.inconsistent_audits || 0),
      ledger_balance: mojaloopLedgerBalance,
      ledger_transfer_entries: Number(mojaloop.ledger_transfer_entries || 0),
      ledger_refund_entries: Number(mojaloop.ledger_refund_entries || 0),
      open_workflows: Number(mojaloop.open_workflows || 0),
      last_mojaloop_event: mojaloop.last_mojaloop_event ?? null,
    },
    reserves: {
      merchant_reserves_held: merchantReservesHeld,
      treasury_reserves_held: treasuryReservesHeld,
      total_reserves_held: totalReservesHeld,
      merchant_reserve_entries: Number(reserves.merchant_reserve_entries || 0),
      treasury_reserve_entries: Number(reserves.treasury_reserve_entries || 0),
      last_reserve_event: reserves.last_reserve_event ?? null,
    },
    derived: {
      net_collected: netCollected,
      outstanding_driver_obligations: outstandingDriverObligations,
      payout_coverage_gap: payoutCoverageGap,
      treasury_drift: treasuryDrift,
      reserve_coverage_gap: reserveCoverageGap,
      ledger_coverage_gap: ledgerCoverageGap,
    },
    recommendation,
  };
}

type OrderRevenueTrendPoint = {
  month: string;
  revenue: number;
  orders: number;
};

export async function getOrderRevenueTrend(months = 6): Promise<OrderRevenueTrendPoint[]> {
  await getDb();
  if (!_pool) return [];

  const safeMonths = Math.min(Math.max(Math.trunc(months), 1), 24);
  const result = await _pool.query(
    `SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
            COUNT(*)::int AS orders,
            COALESCE(SUM(total_amount::numeric), 0)::float8 AS revenue
       FROM orders
      WHERE created_at >= date_trunc('month', now()) - (($1::int - 1) || ' months')::interval
        AND status NOT IN ('cancelled', 'refunded')
      GROUP BY 1
      ORDER BY 1`,
    [safeMonths],
  );

  return result.rows.map((row) => ({
    month: String(row.month),
    revenue: Number(Number(row.revenue || 0).toFixed(2)),
    orders: Number(row.orders || 0),
  }));
}

type OrdersByVerticalPoint = {
  vertical: string;
  orders: number;
  revenue: number;
};

export async function getOrdersByVertical(): Promise<OrdersByVerticalPoint[]> {
  await getDb();
  if (!_pool) return [];

  const result = await _pool.query(
    `SELECT COALESCE(v.name, 'Vertical ' || o.vertical_id) AS vertical,
            COUNT(*)::int AS orders,
            COALESCE(SUM(o.total_amount::numeric), 0)::float8 AS revenue
       FROM orders o
       LEFT JOIN service_verticals v ON v.id = o.vertical_id
      WHERE o.status NOT IN ('cancelled', 'refunded')
      GROUP BY 1
      ORDER BY orders DESC, vertical ASC`,
  );

  return result.rows.map((row) => ({
    vertical: String(row.vertical),
    orders: Number(row.orders || 0),
    revenue: Number(Number(row.revenue || 0).toFixed(2)),
  }));
}
