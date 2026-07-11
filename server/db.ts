import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { 
  InsertUser, 
  users, 
  orders, 
  drivers, 
  serviceProviders, 
  supportTickets, 
  transactions, 
  serviceVerticals, 
  systemConfig, 
  notifications, 
  auditLogs 
} from "../drizzle/schema";
import { ENV } from './_core/env';
import { optimizeDispatch } from './_core/dispatchOptimizer';

let _pool: Pool | null = null;
let _db: ReturnType<typeof drizzle> | null = null;
let _platformTablesEnsured = false;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && ENV.databaseUrl) {
    try {
      const useSsl = ENV.isProduction && !ENV.databaseUrl.includes("sslmode=disable");
      _pool = new Pool({
        connectionString: ENV.databaseUrl,
        ssl: useSsl ? { rejectUnauthorized: false } : false,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      });
      _db = drizzle(_pool);
      await ensurePlatformTables();
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

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    if (user.name !== undefined) {
      values.name = user.name ?? null;
      updateSet.name = user.name ?? null;
    }
    if (user.email !== undefined) {
      values.email = user.email ?? null;
      updateSet.email = user.email ?? null;
    }
    if (user.loginMethod !== undefined) {
      values.loginMethod = user.loginMethod ?? null;
      updateSet.loginMethod = user.loginMethod ?? null;
    }

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = 'admin';
      updateSet.role = 'admin';
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onConflictDoUpdate({
      target: users.openId,
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

export async function getUsers(filters?: {
  search?: string;
  role?: string;
  limit?: number;
  offset?: number;
}) {
  const db = await getDb();
  if (!db) return [];

  const conditions = [] as any[];
  if (filters?.search?.trim()) {
    const search = `%${filters.search.trim()}%`;
    conditions.push(or(
      ilike(users.name, search),
      ilike(users.email, search),
      ilike(users.openId, search),
    ));
  }
  if (filters?.role) {
    conditions.push(eq(users.role, filters.role as any));
  }

  let query = db.select().from(users).$dynamic();
  if (conditions.length > 0) {
    query = query.where(and(...conditions));
  }

  return await query.orderBy(desc(users.createdAt)).limit(filters?.limit || 50).offset(filters?.offset || 0);
}

export async function getUserById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return result[0];
}

export async function getUserStats() {
  const db = await getDb();
  if (!db) {
    return { total: 0, admins: 0, active: 0 };
  }

  const allUsers = await db.select().from(users);
  const now = Date.now();
  const activeThreshold = 1000 * 60 * 60 * 24 * 30;

  return {
    total: allUsers.length,
    admins: allUsers.filter((user) => user.role === 'admin').length,
    active: allUsers.filter((user) => {
      const lastSignedIn = user.lastSignedIn ? new Date(user.lastSignedIn).getTime() : 0;
      return now - lastSignedIn <= activeThreshold;
    }).length,
  };
}

export async function createManagedUser(input: {
  openId: string;
  name?: string | null;
  email?: string | null;
  loginMethod?: string | null;
  role?: 'user' | 'admin';
}) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const values: InsertUser = {
    openId: input.openId,
    name: input.name ?? null,
    email: input.email ?? null,
    loginMethod: input.loginMethod ?? 'managed',
    role: input.role ?? 'user',
    lastSignedIn: new Date(),
  };

  const created = await db.insert(users).values(values).returning();
  return created[0];
}

export async function updateManagedUser(id: number, input: {
  name?: string | null;
  email?: string | null;
  loginMethod?: string | null;
  role?: 'user' | 'admin';
}) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const updated = await db.update(users).set({
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.email !== undefined ? { email: input.email } : {}),
    ...(input.loginMethod !== undefined ? { loginMethod: input.loginMethod } : {}),
    ...(input.role !== undefined ? { role: input.role } : {}),
    updatedAt: new Date(),
  }).where(eq(users.id, id)).returning();

  return updated[0];
}

export async function deleteManagedUser(id: number) {
  const db = await getDb();
  if (!db) return false;
  const deleted = await db.delete(users).where(eq(users.id, id)).returning({ id: users.id });
  return deleted.length > 0;
}

/**
 * Orders Queries
 */
export async function getOrders(filters?: {
  status?: string;
  verticalId?: number;
  search?: string;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}) {
  const db = await getDb();
  if (!db) return [];

  const conditions = [] as any[];
  if (filters?.status) {
    conditions.push(eq(orders.status, filters.status as any));
  }
  if (filters?.verticalId) {
    conditions.push(eq(orders.verticalId, filters.verticalId));
  }
  if (filters?.search?.trim()) {
    const rawSearch = filters.search.trim();
    const numericSearch = rawSearch.match(/\d+/)?.[0];
    const likeSearch = `%${rawSearch}%`;
    conditions.push(or(
      ilike(sql`CAST(${orders.id} AS TEXT)`, likeSearch),
      ilike(sql`CAST(${orders.customerId} AS TEXT)`, likeSearch),
      ilike(sql`CAST(${orders.verticalId} AS TEXT)`, likeSearch),
      ilike(sql`COALESCE((SELECT ${serviceVerticals.name} FROM ${serviceVerticals} WHERE ${serviceVerticals.id} = ${orders.verticalId}), '')`, likeSearch),
      numericSearch ? eq(orders.customerId, Number(numericSearch)) : undefined,
      numericSearch ? eq(orders.id, Number(numericSearch)) : undefined,
    ));
  }

  let query = db.select().from(orders).$dynamic();
  if (conditions.length > 0) {
    query = query.where(and(...conditions));
  }

  const results = await query.orderBy(desc(orders.createdAt)).limit(filters?.limit || 50).offset(filters?.offset || 0);
  return results;
}

export async function getOrderById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  return result[0];
}

export async function updateOrderStatus(id: number, status: string) {
  const db = await getDb();
  if (!db) return false;
  await db.update(orders).set({ status: status as any }).where(eq(orders.id, id));
  return true;
}

/**
 * Drivers Queries
 */
export async function getDrivers(filters?: {
  status?: string;
  limit?: number;
  offset?: number;
}) {
  const db = await getDb();
  if (!db) return [];
  
  let query = db.select().from(drivers).$dynamic();
  
  if (filters?.status) {
    query = query.where(eq(drivers.status, filters.status as any));
  }
  
  const results = await query.limit(filters?.limit || 50).offset(filters?.offset || 0);
  return results;
}

export async function getDriverById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(drivers).where(eq(drivers.id, id)).limit(1);
  return result[0];
}

export async function updateDriverStatus(id: number, status: string) {
  const db = await getDb();
  if (!db) return false;
  await db.update(drivers).set({ status: status as any }).where(eq(drivers.id, id));
  return true;
}

/**
 * Service Providers Queries
 */
export async function getServiceProviders(filters?: {
  status?: string;
  verticalId?: number;
  search?: string;
  limit?: number;
  offset?: number;
}) {
  const db = await getDb();
  if (!db) return [];

  const conditions = [] as any[];
  if (filters?.status) {
    conditions.push(eq(serviceProviders.status, filters.status as any));
  }
  if (filters?.verticalId) {
    conditions.push(eq(serviceProviders.verticalId, filters.verticalId));
  }
  if (filters?.search?.trim()) {
    const search = `%${filters.search.trim()}%`;
    conditions.push(or(
      ilike(serviceProviders.name, search),
      ilike(serviceProviders.businessName, search),
      ilike(serviceProviders.email, search),
      ilike(serviceProviders.phone, search),
    ));
  }

  let query = db.select().from(serviceProviders).$dynamic();
  if (conditions.length > 0) {
    query = query.where(and(...conditions));
  }

  return await query.orderBy(desc(serviceProviders.createdAt)).limit(filters?.limit || 50).offset(filters?.offset || 0);
}

export async function getServiceProviderStats() {
  const providers = await getServiceProviders({ limit: 500 });
  return {
    total: providers.length,
    active: providers.filter((provider) => provider.status === 'active').length,
    pending: providers.filter((provider) => provider.status === 'pending').length,
    suspended: providers.filter((provider) => provider.status === 'suspended').length,
  };
}

export async function createServiceProvider(input: {
  verticalId: number;
  name: string;
  businessName: string;
  email: string;
  phone: string;
  address?: string | null;
  latitude?: string | null;
  longitude?: string | null;
  status?: 'pending' | 'active' | 'suspended' | 'rejected';
  verificationStatus?: 'pending' | 'verified' | 'rejected';
  rating?: string | null;
  commissionRate?: string | null;
}) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const created = await db.insert(serviceProviders).values({
    verticalId: input.verticalId,
    name: input.name,
    businessName: input.businessName,
    email: input.email,
    phone: input.phone,
    address: input.address ?? null,
    latitude: input.latitude ?? null,
    longitude: input.longitude ?? null,
    status: input.status ?? 'pending',
    verificationStatus: input.verificationStatus ?? 'pending',
    rating: input.rating ?? '0',
    commissionRate: input.commissionRate ?? '15',
  }).returning();

  return created[0];
}

export async function updateServiceProvider(id: number, input: {
  verticalId?: number;
  name?: string;
  businessName?: string;
  email?: string;
  phone?: string;
  address?: string | null;
  latitude?: string | null;
  longitude?: string | null;
  status?: 'pending' | 'active' | 'suspended' | 'rejected';
  verificationStatus?: 'pending' | 'verified' | 'rejected';
  rating?: string | null;
  commissionRate?: string | null;
}) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const updated = await db.update(serviceProviders).set({
    ...(input.verticalId !== undefined ? { verticalId: input.verticalId } : {}),
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.businessName !== undefined ? { businessName: input.businessName } : {}),
    ...(input.email !== undefined ? { email: input.email } : {}),
    ...(input.phone !== undefined ? { phone: input.phone } : {}),
    ...(input.address !== undefined ? { address: input.address } : {}),
    ...(input.latitude !== undefined ? { latitude: input.latitude } : {}),
    ...(input.longitude !== undefined ? { longitude: input.longitude } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.verificationStatus !== undefined ? { verificationStatus: input.verificationStatus } : {}),
    ...(input.rating !== undefined ? { rating: input.rating } : {}),
    ...(input.commissionRate !== undefined ? { commissionRate: input.commissionRate } : {}),
    updatedAt: new Date(),
  }).where(eq(serviceProviders.id, id)).returning();

  return updated[0];
}

export async function deleteServiceProvider(id: number) {
  const db = await getDb();
  if (!db) return false;
  const deleted = await db.delete(serviceProviders).where(eq(serviceProviders.id, id)).returning({ id: serviceProviders.id });
  return deleted.length > 0;
}

export async function getServiceProviderById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(serviceProviders).where(eq(serviceProviders.id, id)).limit(1);
  return result[0];
}

/**
 * Support Tickets Queries
 */
export async function getSupportTickets(filters?: {
  status?: string;
  type?: string;
  priority?: string;
  search?: string;
  limit?: number;
  offset?: number;
}) {
  const db = await getDb();
  if (!db) return [];

  const conditions = [] as any[];
  if (filters?.status) {
    conditions.push(eq(supportTickets.status, filters.status as any));
  }
  if (filters?.type) {
    conditions.push(eq(supportTickets.type, filters.type as any));
  }
  if (filters?.priority) {
    conditions.push(eq(supportTickets.priority, filters.priority as any));
  }
  if (filters?.search?.trim()) {
    const search = `%${filters.search.trim()}%`;
    conditions.push(or(
      ilike(supportTickets.subject, search),
      ilike(supportTickets.description, search),
      ilike(supportTickets.ticketNumber, search),
    ));
  }

  let query = db.select().from(supportTickets).$dynamic();
  if (conditions.length > 0) {
    query = query.where(and(...conditions));
  }

  return await query.orderBy(desc(supportTickets.createdAt)).limit(filters?.limit || 50).offset(filters?.offset || 0);
}

export async function getSupportTicketStats() {
  const tickets = await getSupportTickets({ limit: 500 });
  return {
    total: tickets.length,
    open: tickets.filter((ticket) => ticket.status === 'open').length,
    inProgress: tickets.filter((ticket) => ticket.status === 'in_progress').length,
    resolved: tickets.filter((ticket) => ticket.status === 'resolved').length,
    closed: tickets.filter((ticket) => ticket.status === 'closed').length,
  };
}

export async function createSupportTicket(input: {
  customerId?: number | null;
  orderId?: number | null;
  type: 'order_issue' | 'payment' | 'driver' | 'general' | 'claim' | 'refund';
  priority?: 'low' | 'medium' | 'high' | 'urgent' | 'critical';
  subject: string;
  description: string;
  assignedTo?: number | null;
}) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const ticketNumber = `SUP-${Date.now()}`;
  const created = await db.insert(supportTickets).values({
    ticketNumber,
    customerId: input.customerId ?? null,
    orderId: input.orderId ?? null,
    type: input.type,
    priority: input.priority ?? 'medium',
    subject: input.subject,
    description: input.description,
    assignedTo: input.assignedTo ?? null,
  }).returning();

  return created[0];
}

export async function updateSupportTicket(id: number, input: {
  status?: 'open' | 'in_progress' | 'resolved' | 'closed';
  priority?: 'low' | 'medium' | 'high' | 'urgent' | 'critical';
  assignedTo?: number | null;
  resolution?: string | null;
}) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const status = input.status;
  const updated = await db.update(supportTickets).set({
    ...(status !== undefined ? { status } : {}),
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    ...(input.assignedTo !== undefined ? { assignedTo: input.assignedTo } : {}),
    ...(input.resolution !== undefined ? { resolution: input.resolution } : {}),
    ...(status === 'resolved' || status === 'closed' ? { resolvedAt: new Date() } : {}),
    updatedAt: new Date(),
  }).where(eq(supportTickets.id, id)).returning();

  return updated[0];
}

export async function getSupportTicketById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(supportTickets).where(eq(supportTickets.id, id)).limit(1);
  return result[0];
}

/**
 * Transactions Queries
 */
export async function getTransactions(filters?: {
  type?: string;
  status?: string;
  search?: string;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}) {
  const db = await getDb();
  if (!db) return [];

  const conditions = [] as any[];
  if (filters?.type) {
    conditions.push(eq(transactions.type, filters.type as any));
  }
  if (filters?.status) {
    conditions.push(eq(transactions.status, filters.status as any));
  }
  if (filters?.search?.trim()) {
    const searchTerm = filters.search.trim();
    const search = `%${searchTerm}%`;
    const normalizedReferenceId = Number.parseInt(
      searchTerm.replace(/^tx-/i, ""),
      10,
    );

    const searchConditions = [
      ilike(transactions.transactionId, search),
      ilike(sql`CAST(${transactions.id} AS text)`, search),
      ilike(sql`CONCAT('TX-', CAST(${transactions.id} AS text))`, search),
      ilike(sql`CAST(${transactions.status} AS text)`, search),
      ilike(sql`CAST(${transactions.type} AS text)`, search),
      ilike(sql`CAST(${transactions.paymentMethod} AS text)`, search),
      ilike(transactions.currency, search),
      ilike(transactions.amount, search),
      ilike(sql`CAST(${transactions.recipientType} AS text)`, search),
      ilike(sql`CAST(${transactions.metadata} AS text)`, search),
    ] as any[];

    if (Number.isInteger(normalizedReferenceId)) {
      searchConditions.push(eq(transactions.id, normalizedReferenceId));
    }

    conditions.push(or(...searchConditions));
  }

  let query = db.select().from(transactions).$dynamic();
  if (conditions.length > 0) {
    query = query.where(and(...conditions));
  }

  return await query.orderBy(desc(transactions.createdAt)).limit(filters?.limit || 50).offset(filters?.offset || 0);
}

export async function getFinanceSummary() {
  const items = await getTransactions({ limit: 500 });
  const sumAmount = (predicate: (item: any) => boolean) => items
    .filter(predicate)
    .reduce((total, item) => total + Number(item.amount || 0), 0);

  return {
    totalRevenue: sumAmount((item) => item.type === 'payment' && item.status === 'completed'),
    pendingPayouts: sumAmount((item) => item.type === 'payout' && item.status === 'pending'),
    platformFees: sumAmount((item) => item.type === 'commission' && item.status !== 'failed'),
    transactionCount: items.length,
  };
}

/**
 * Service Verticals Queries
 */
export async function getServiceVerticals() {
  const db = await getDb();
  if (!db) return [];
  return await db.select().from(serviceVerticals).where(eq(serviceVerticals.isActive, true));
}

/**
 * System Config Queries
 */
export async function getSystemConfig(key: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(systemConfig).where(eq(systemConfig.key, key)).limit(1);
  return result[0];
}

export async function getAllSystemConfig(category?: string) {
  const db = await getDb();
  if (!db) return [];
  
  if (category) {
    return await db.select().from(systemConfig).where(eq(systemConfig.category, category));
  }
  return await db.select().from(systemConfig);
}

export async function updateSystemConfig(key: string, value: string, updatedBy: number) {
  const db = await getDb();
  if (!db) return false;
  await db.update(systemConfig).set({ value, updatedBy, updatedAt: new Date() }).where(eq(systemConfig.key, key));
  return true;
}

export async function upsertSystemConfigEntries(entries: Array<{
  key: string;
  value: string;
  category: string;
  description?: string | null;
}>, updatedBy: number) {
  const db = await getDb();
  if (!db) return [];

  const existing = await db.select().from(systemConfig);
  const existingByKey = new Map(existing.map((entry) => [entry.key, entry]));
  const results = [] as any[];

  for (const entry of entries) {
    if (existingByKey.has(entry.key)) {
      const updated = await db.update(systemConfig).set({
        value: entry.value,
        category: entry.category,
        description: entry.description ?? null,
        updatedBy,
        updatedAt: new Date(),
      }).where(eq(systemConfig.key, entry.key)).returning();
      if (updated[0]) results.push(updated[0]);
    } else {
      const created = await db.insert(systemConfig).values({
        key: entry.key,
        value: entry.value,
        category: entry.category,
        description: entry.description ?? null,
        updatedBy,
      }).returning();
      if (created[0]) results.push(created[0]);
    }
  }

  return results;
}

export async function getSystemConfigPolicyHistory(limit = 40) {
  const db = await getDb();
  if (!db) return [];

  const currentEntries = await db.select().from(systemConfig);
  const auditEntries = await getAuditLogs({ entity: 'system_config', limit });
  const currentByKey = new Map(currentEntries.map((entry) => [entry.key, entry]));

  return auditEntries.map((log: any) => {
    let parsedChanges: any = null;
    try {
      parsedChanges = log.changes ? JSON.parse(log.changes) : null;
    } catch {
      parsedChanges = null;
    }

    const touchedKeys = Array.isArray(parsedChanges)
      ? parsedChanges.map((entry) => entry?.key).filter(Boolean)
      : parsedChanges?.key
        ? [parsedChanges.key]
        : [];

    const impactedPolicies = touchedKeys.map((key: string) => {
      const current = currentByKey.get(key);
      return {
        key,
        currentValue: current?.value ?? null,
        category: current?.category ?? null,
        lastUpdatedAt: current?.updatedAt ?? null,
        updatedBy: current?.updatedBy ?? null,
      };
    });

    return {
      id: log.id,
      action: log.action,
      entity: log.entity,
      createdAt: log.createdAt,
      userId: log.userId,
      touchedKeys,
      impactedPolicies,
      changeSummary: Array.isArray(parsedChanges)
        ? `${parsedChanges.length} configuration entries updated`
        : parsedChanges?.key
          ? `Configuration key ${parsedChanges.key} updated`
          : 'System configuration changed',
      requiresApproval: touchedKeys.some((key: string) => /(commission|payout|refund|surge|pricing|incentive|fraud|security)/i.test(key)),
    };
  });
}

export async function getSystemConfigApprovalSummary() {
  const entries = await getAllSystemConfig();
  const sensitiveEntries = entries.filter((entry: any) => /(commission|payout|refund|surge|pricing|incentive|fraud|security)/i.test(entry.key));
  const recentlyUpdated = sensitiveEntries
    .filter((entry: any) => entry.updatedAt)
    .sort((a: any, b: any) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 8)
    .map((entry: any) => ({
      key: entry.key,
      value: entry.value,
      category: entry.category,
      updatedAt: entry.updatedAt,
      updatedBy: entry.updatedBy,
      approvalState: 'operator-review',
    }));

  return {
    sensitivePolicyCount: sensitiveEntries.length,
    policiesPendingReview: recentlyUpdated.length,
    lastSensitiveUpdates: recentlyUpdated,
  };
}

/**
 * Notifications Queries
 */
export async function getNotifications(userId: number, limit = 20) {
  const db = await getDb();
  if (!db) return [];
  return await db.select().from(notifications)
    .where(eq(notifications.userId, userId))
    .limit(limit);
}

export async function markNotificationAsRead(id: number) {
  const db = await getDb();
  if (!db) return false;
  await db.update(notifications).set({ isRead: true }).where(eq(notifications.id, id));
  return true;
}

/**
 * Audit Logs Queries
 */
export async function createAuditLog(log: {
  userId: number;
  action: string;
  entity: string;
  entityId?: number;
  changes?: string;
  ipAddress?: string;
  userAgent?: string;
}) {
  const db = await getDb();
  if (!db) return false;
  await db.insert(auditLogs).values(log);
  return true;
}

export async function getAuditLogs(filters?: {
  userId?: number;
  entity?: string;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}) {
  const db = await getDb();
  if (!db) return [];
  
  let query = db.select().from(auditLogs).$dynamic();
  
  if (filters?.userId) {
    query = query.where(eq(auditLogs.userId, filters.userId));
  }
  if (filters?.entity) {
    query = query.where(eq(auditLogs.entity, filters.entity));
  }
  
  const results = await query.limit(filters?.limit || 50).offset(filters?.offset || 0);
  return results;
}

/**
 * Analytics Queries
 */
export async function getOrderStats(filters?: {
  startDate?: Date;
  endDate?: Date;
  verticalId?: number;
}) {
  const db = await getDb();
  if (!db) return { total: 0, completed: 0, cancelled: 0, revenue: "0" };
  
  // This is a simplified version - in production, you'd use proper aggregation
  const allOrders = await db.select().from(orders);
  
  return {
    total: allOrders.length,
    completed: allOrders.filter(o => o.status === 'delivered').length,
    cancelled: allOrders.filter(o => o.status === 'cancelled').length,
    revenue: allOrders
      .filter(o => o.status === 'delivered')
      .reduce((sum, o) => sum + parseFloat(o.totalAmount), 0)
      .toFixed(2),
  };
}

export async function getDriverStats() {
  const db = await getDb();
  if (!db) return { total: 0, online: 0, busy: 0, offline: 0 };
  
  const allDrivers = await db.select().from(drivers);
  
  return {
    total: allDrivers.length,
    online: allDrivers.filter(d => d.status === 'online').length,
    busy: allDrivers.filter(d => d.status === 'busy').length,
    offline: allDrivers.filter(d => d.status === 'offline').length,
  };
}

export async function assignDriverToOrder(orderId: number, driverId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  
  try {
    await db.update(orders)
      .set({ driverId, status: 'assigned', updatedAt: new Date() })
      .where(eq(orders.id, orderId));
    
    await db.update(drivers)
      .set({ status: 'busy', updatedAt: new Date() })
      .where(eq(drivers.id, driverId));
    
    return true;
  } catch (error) {
    console.error('[Database] Failed to assign driver to order:', error);
    return false;
  }
}


/**
 * Routing & Navigation Queries (pgRouting)
 */

// Calculate optimal route between two points
export async function calculateOptimalRoute(
  startLat: number,
  startLng: number,
  endLat: number,
  endLng: number
) {
  const db = await getDb();
  if (!db) return null;

  const query = `
    WITH 
    start_node AS (
      SELECT id, location <-> ST_SetSRID(ST_MakePoint($1, $2), 4326) as dist
      FROM routing_nodes
      ORDER BY dist
      LIMIT 1
    ),
    end_node AS (
      SELECT id, location <-> ST_SetSRID(ST_MakePoint($3, $4), 4326) as dist
      FROM routing_nodes
      ORDER BY dist
      LIMIT 1
    ),
    route AS (
      SELECT * FROM pgr_dijkstra(
        'SELECT id, source, target, cost, reverse_cost FROM road_network',
        (SELECT id FROM start_node),
        (SELECT id FROM end_node),
        directed := false
      )
    )
    SELECT 
      r.seq,
      r.node,
      r.edge,
      r.cost,
      rn.name as road_name,
      rn.road_type,
      rn.max_speed,
      ST_AsGeoJSON(rn.geom) as geometry,
      ST_Length(rn.geom::geography) as distance_meters
    FROM route r
    LEFT JOIN road_network rn ON r.edge = rn.id
    ORDER BY r.seq;
  `;

  if (!_pool) return null;
  const result = await _pool.query(query, [startLng, startLat, endLng, endLat]);
  return result.rows;
}

// Calculate route with multiple waypoints
export async function calculateMultiWaypointRoute(waypoints: Array<{lat: number, lng: number}>) {
  const db = await getDb();
  if (!db) return null;

  if (waypoints.length < 2) {
    throw new Error("At least 2 waypoints required");
  }

  const routes = [];
  for (let i = 0; i < waypoints.length - 1; i++) {
    const start = waypoints[i];
    const end = waypoints[i + 1];
    const route = await calculateOptimalRoute(start.lat, start.lng, end.lat, end.lng);
    if (route) {
      routes.push({
        segment: i + 1,
        from: start,
        to: end,
        route: route
      });
    }
  }

  return routes;
}

// Find nearest road to a given location
export async function findNearestRoad(lat: number, lng: number) {
  const db = await getDb();
  if (!db) return null;

  const query = `
    SELECT 
      id,
      name,
      road_type,
      max_speed,
      ST_AsGeoJSON(geom) as geometry,
      ST_Distance(geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) as distance_meters
    FROM road_network
    ORDER BY geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)
    LIMIT 1;
  `;

  if (!_pool) return null;
  const result = await _pool.query(query, [lng, lat]);
  return result.rows[0];
}

// Calculate estimated delivery time based on route
export async function estimateDeliveryTime(
  startLat: number,
  startLng: number,
  endLat: number,
  endLng: number,
  averageSpeedKmh: number = 30
) {
  const route = await calculateOptimalRoute(startLat, startLng, endLat, endLng);
  if (!route || route.length === 0) return null;

  const totalDistanceMeters = route.reduce((sum: number, segment: any) => 
    sum + (parseFloat(segment.distance_meters) || 0), 0
  );

  const totalDistanceKm = totalDistanceMeters / 1000;
  const estimatedTimeHours = totalDistanceKm / averageSpeedKmh;
  const estimatedTimeMinutes = Math.ceil(estimatedTimeHours * 60);

  return {
    totalDistanceMeters,
    totalDistanceKm,
    estimatedTimeMinutes,
    averageSpeedKmh,
    route
  };
}


/**
 * Geospatial Analytics Queries
 */

// Get delivery heatmap data (clustering deliveries by location)
export async function getDeliveryHeatmapData() {
  if (!_pool) return null;

  const query = `
    SELECT 
      ST_X(delivery_location::geometry) as longitude,
      ST_Y(delivery_location::geometry) as latitude,
      COUNT(*) as delivery_count,
      AVG(EXTRACT(EPOCH FROM (delivered_at - created_at)) / 60) as avg_delivery_time_minutes
    FROM orders
    WHERE delivery_location IS NOT NULL 
      AND delivered_at IS NOT NULL
      AND status = 'delivered'
    GROUP BY ST_SnapToGrid(delivery_location::geometry, 0.01)
    HAVING COUNT(*) > 0
    ORDER BY delivery_count DESC;
  `;

  const result = await _pool.query(query);
  return result.rows;
}

// Get driver density by area
export async function getDriverDensityByArea() {
  if (!_pool) return null;

  const query = `
    SELECT 
      ST_X(location::geometry) as longitude,
      ST_Y(location::geometry) as latitude,
      COUNT(*) as driver_count,
      array_agg(name) as driver_names
    FROM drivers
    WHERE location IS NOT NULL
      AND status = 'online'
    GROUP BY ST_SnapToGrid(location::geometry, 0.01)
    ORDER BY driver_count DESC;
  `;

  const result = await _pool.query(query);
  return result.rows;
}

// Get average delivery time by geographic area
export async function getAvgDeliveryTimeByArea() {
  if (!_pool) return null;

  const query = `
    WITH grid_cells AS (
      SELECT 
        ST_SnapToGrid(delivery_location::geometry, 0.01) as grid_point,
        EXTRACT(EPOCH FROM (delivered_at - created_at)) / 60 as delivery_time_minutes
      FROM orders
      WHERE delivery_location IS NOT NULL 
        AND delivered_at IS NOT NULL
        AND status = 'delivered'
    )
    SELECT 
      ST_X(grid_point) as longitude,
      ST_Y(grid_point) as latitude,
      AVG(delivery_time_minutes) as avg_delivery_time_minutes,
      MIN(delivery_time_minutes) as min_delivery_time_minutes,
      MAX(delivery_time_minutes) as max_delivery_time_minutes,
      COUNT(*) as delivery_count
    FROM grid_cells
    GROUP BY grid_point
    HAVING COUNT(*) >= 3
    ORDER BY avg_delivery_time_minutes DESC;
  `;

  const result = await _pool.query(query);
  return result.rows;
}

// Get service coverage analysis
export async function getServiceCoverageAnalysis() {
  if (!_pool) return null;

  const query = `
    WITH service_areas AS (
      SELECT 
        sp.id,
        sp.name,
        sp.location,
        ST_Buffer(sp.location::geography, 5000)::geometry as coverage_area
      FROM service_providers sp
      WHERE sp.location IS NOT NULL
    ),
    coverage_stats AS (
      SELECT 
        sa.id,
        sa.name,
        ST_X(sa.location::geometry) as longitude,
        ST_Y(sa.location::geometry) as latitude,
        COUNT(DISTINCT o.id) as total_orders,
        AVG(EXTRACT(EPOCH FROM (o.delivered_at - o.created_at)) / 60) as avg_delivery_time
      FROM service_areas sa
      LEFT JOIN orders o ON ST_Contains(sa.coverage_area, o.pickup_location::geometry)
      WHERE o.status = 'delivered'
      GROUP BY sa.id, sa.name, sa.location
    )
    SELECT * FROM coverage_stats
    ORDER BY total_orders DESC;
  `;

  const result = await _pool.query(query);
  return result.rows;
}

// Get delivery hotspots (areas with high order density)
export async function getDeliveryHotspots(limit: number = 10) {
  if (!_pool) return null;

  const query = `
    WITH clustered_deliveries AS (
      SELECT 
        ST_ClusterKMeans(delivery_location::geometry, $1) OVER() as cluster_id,
        delivery_location,
        id,
        total_amount,
        created_at,
        delivered_at
      FROM orders
      WHERE delivery_location IS NOT NULL
        AND status = 'delivered'
    ),
    cluster_stats AS (
      SELECT 
        cluster_id,
        ST_Centroid(ST_Collect(delivery_location::geometry)) as center,
        COUNT(*) as order_count,
        SUM(CAST(total_amount AS DECIMAL)) as total_revenue,
        AVG(EXTRACT(EPOCH FROM (delivered_at - created_at)) / 60) as avg_delivery_time
      FROM clustered_deliveries
      GROUP BY cluster_id
    )
    SELECT 
      cluster_id,
      ST_X(center) as longitude,
      ST_Y(center) as latitude,
      order_count,
      total_revenue,
      ROUND(avg_delivery_time::numeric, 2) as avg_delivery_time_minutes
    FROM cluster_stats
    ORDER BY order_count DESC
    LIMIT $1;
  `;

  const result = await _pool.query(query, [limit]);
  return result.rows;
}

// Get geospatial performance metrics
export async function getGeospatialPerformanceMetrics() {
  if (!_pool) return null;

  const query = `
    SELECT 
      COUNT(DISTINCT CASE WHEN delivery_location IS NOT NULL THEN id END) as orders_with_location,
      COUNT(*) as total_orders,
      ROUND((COUNT(DISTINCT CASE WHEN delivery_location IS NOT NULL THEN id END)::numeric / COUNT(*)::numeric) * 100, 2) as location_coverage_percent,
      COUNT(DISTINCT CASE WHEN location IS NOT NULL THEN id END) as drivers_with_location,
      (SELECT COUNT(*) FROM drivers) as total_drivers,
      COUNT(DISTINCT CASE WHEN location IS NOT NULL THEN id END) as providers_with_location,
      (SELECT COUNT(*) FROM service_providers) as total_providers
    FROM orders
    CROSS JOIN drivers
    CROSS JOIN service_providers;
  `;

  const result = await _pool.query(query);
  return result.rows[0];
}


/**
 * Driver Zone Assignment & Geofencing Functions
 */

// Get all driver zones with statistics
export async function getAllDriverZones() {
  if (!_pool) return null;

  const query = `
    SELECT 
      id,
      name,
      target_driver_count,
      current_driver_count,
      avg_delivery_time_minutes,
      total_orders,
      priority_level,
      ST_AsGeoJSON(zone_polygon) as zone_geojson,
      ST_Area(zone_polygon::geography) / 1000000 as area_km2,
      created_at,
      updated_at
    FROM driver_zones
    ORDER BY priority_level DESC, name;
  `;

  const result = await _pool.query(query);
  return result.rows;
}

// Find which zone a location belongs to
export async function findZoneForLocation(latitude: number, longitude: number) {
  if (!_pool) return null;

  const query = `
    SELECT 
      id,
      name,
      priority_level,
      target_driver_count,
      current_driver_count
    FROM driver_zones
    WHERE ST_Contains(
      zone_polygon,
      ST_SetSRID(ST_MakePoint($1, $2), 4326)
    )
    LIMIT 1;
  `;

  const result = await _pool.query(query, [longitude, latitude]);
  return result.rows[0] || null;
}

// Assign driver to optimal zone based on their current location
export async function assignDriverToZone(driverId: number, latitude: number, longitude: number) {
  if (!_pool) return null;

  const query = `
    WITH driver_zone AS (
      SELECT id as zone_id
      FROM driver_zones
      WHERE ST_Contains(
        zone_polygon,
        ST_SetSRID(ST_MakePoint($2, $3), 4326)
      )
      AND current_driver_count < target_driver_count
      ORDER BY priority_level DESC
      LIMIT 1
    )
    INSERT INTO driver_zone_assignments (driver_id, zone_id, status)
    SELECT $1, zone_id, 'active'
    FROM driver_zone
    ON CONFLICT (driver_id, zone_id) 
    DO UPDATE SET status = 'active', assigned_at = CURRENT_TIMESTAMP
    RETURNING *;
  `;

  const result = await _pool.query(query, [driverId, longitude, latitude]);
  
  // Update zone driver count
  if (result.rows.length > 0) {
    await _pool.query(`
      UPDATE driver_zones 
      SET current_driver_count = (
        SELECT COUNT(*) 
        FROM driver_zone_assignments 
        WHERE zone_id = $1 AND status = 'active'
      )
      WHERE id = $1
    `, [result.rows[0].zone_id]);
  }
  
  return result.rows[0] || null;
}

// Get driver's current zone assignment
export async function getDriverZoneAssignment(driverId: number) {
  if (!_pool) return null;

  const query = `
    SELECT 
      dza.id,
      dza.driver_id,
      dza.zone_id,
      dza.assigned_at,
      dza.status,
      dz.name as zone_name,
      dz.priority_level,
      ST_AsGeoJSON(dz.zone_polygon) as zone_geojson
    FROM driver_zone_assignments dza
    JOIN driver_zones dz ON dza.zone_id = dz.id
    WHERE dza.driver_id = $1 AND dza.status = 'active'
    ORDER BY dza.assigned_at DESC
    LIMIT 1;
  `;

  const result = await _pool.query(query, [driverId]);
  return result.rows[0] || null;
}

// Rebalance zones - reassign drivers based on demand
export async function rebalanceDriverZones() {
  if (!_pool) return null;

  const query = `
    WITH zone_stats AS (
      SELECT 
        dz.id as zone_id,
        dz.name,
        dz.target_driver_count,
        dz.current_driver_count,
        dz.priority_level,
        dz.target_driver_count - dz.current_driver_count as driver_deficit
      FROM driver_zones dz
      WHERE dz.current_driver_count < dz.target_driver_count
      ORDER BY dz.priority_level DESC, driver_deficit DESC
    ),
    available_drivers AS (
      SELECT d.id as driver_id, d.current_latitude, d.current_longitude
      FROM drivers d
      LEFT JOIN driver_zone_assignments dza ON d.id = dza.driver_id AND dza.status = 'active'
      WHERE d.status = 'online' AND dza.id IS NULL
      LIMIT 50
    )
    SELECT 
      zs.zone_id,
      zs.name as zone_name,
      zs.driver_deficit,
      COUNT(ad.driver_id) as available_nearby_drivers
    FROM zone_stats zs
    CROSS JOIN available_drivers ad
    WHERE ST_Contains(
      (SELECT zone_polygon FROM driver_zones WHERE id = zs.zone_id),
      ST_SetSRID(ST_MakePoint(ad.current_longitude::float, ad.current_latitude::float), 4326)
    )
    GROUP BY zs.zone_id, zs.name, zs.driver_deficit
    HAVING COUNT(ad.driver_id) > 0;
  `;

  const result = await _pool.query(query);
  return result.rows;
}

// Check if driver is within their assigned zone (geofencing)
export async function checkDriverGeofence(driverId: number, latitude: number, longitude: number) {
  if (!_pool) return null;

  const query = `
    SELECT 
      dza.zone_id,
      dz.name as zone_name,
      ST_Contains(
        dz.zone_polygon,
        ST_SetSRID(ST_MakePoint($2, $3), 4326)
      ) as is_within_zone,
      ST_Distance(
        dz.zone_polygon::geography,
        ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography
      ) as distance_to_zone_m
    FROM driver_zone_assignments dza
    JOIN driver_zones dz ON dza.zone_id = dz.id
    WHERE dza.driver_id = $1 AND dza.status = 'active'
    ORDER BY dza.assigned_at DESC
    LIMIT 1;
  `;

  const result = await _pool.query(query, [driverId, longitude, latitude]);
  return result.rows[0] || null;
}

// Update zone statistics based on completed orders
export async function updateZoneStatistics(zoneId: number) {
  if (!_pool) return null;

  const query = `
    UPDATE driver_zones dz
    SET 
      total_orders = (
        SELECT COUNT(*)
        FROM orders o
        WHERE ST_Contains(dz.zone_polygon, o.delivery_location::geometry)
          AND o.status = 'delivered'
      ),
      avg_delivery_time_minutes = (
        SELECT AVG(EXTRACT(EPOCH FROM (o.actual_delivery_time - o.created_at)) / 60)
        FROM orders o
        WHERE ST_Contains(dz.zone_polygon, o.delivery_location::geometry)
          AND o.status = 'delivered'
          AND o.actual_delivery_time IS NOT NULL
      ),
      updated_at = CURRENT_TIMESTAMP
    WHERE dz.id = $1
    RETURNING *;
  `;

  const result = await _pool.query(query, [zoneId]);
  return result.rows[0] || null;
}


/**
 * Traffic-Aware Routing Functions
 */

// Get current traffic conditions for a road
export async function getTrafficConditions(roadId: number) {
  if (!_pool) return null;

  const query = `
    SELECT *
    FROM traffic_conditions
    WHERE road_id = $1
      AND expires_at > CURRENT_TIMESTAMP
    ORDER BY updated_at DESC
    LIMIT 1;
  `;

  const result = await _pool.query(query, [roadId]);
  return result.rows[0] || null;
}

// Get all current traffic conditions
export async function getAllTrafficConditions() {
  if (!_pool) return null;

  const query = `
    SELECT 
      tc.*,
      rn.name as road_name,
      rn.road_type,
      ST_AsGeoJSON(rn.geom) as road_geojson
    FROM traffic_conditions tc
    JOIN road_network rn ON tc.road_id = rn.id
    WHERE tc.expires_at > CURRENT_TIMESTAMP
    ORDER BY tc.traffic_level DESC, tc.updated_at DESC;
  `;

  const result = await _pool.query(query);
  return result.rows;
}

// Update traffic conditions for a road
export async function updateTrafficConditions(
  roadId: number,
  trafficLevel: string,
  speedKmh: number,
  delayMinutes: number,
  incidentReported: boolean = false,
  incidentType: string | null = null
) {
  if (!_pool) return null;

  const query = `
    INSERT INTO traffic_conditions (
      road_id, traffic_level, speed_kmh, delay_minutes, 
      incident_reported, incident_type, updated_at, expires_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '5 minutes')
    RETURNING *;
  `;

  const result = await _pool.query(query, [
    roadId,
    trafficLevel,
    speedKmh,
    delayMinutes,
    incidentReported,
    incidentType
  ]);

  return result.rows[0] || null;
}

// Calculate traffic-aware route with adjusted costs
export async function calculateTrafficAwareRoute(
  startLat: number,
  startLon: number,
  endLat: number,
  endLon: number
) {
  if (!_pool) return null;

  const query = `
    WITH 
    start_node AS (
      SELECT id
      FROM routing_nodes
      ORDER BY location <-> ST_SetSRID(ST_MakePoint($2, $1), 4326)
      LIMIT 1
    ),
    end_node AS (
      SELECT id
      FROM routing_nodes
      ORDER BY location <-> ST_SetSRID(ST_MakePoint($4, $3), 4326)
      LIMIT 1
    ),
    traffic_adjusted_costs AS (
      SELECT 
        rn.id,
        rn.source,
        rn.target,
        CASE 
          WHEN tc.traffic_level = 'free_flow' THEN rn.cost
          WHEN tc.traffic_level = 'light' THEN rn.cost * 1.2
          WHEN tc.traffic_level = 'moderate' THEN rn.cost * 1.5
          WHEN tc.traffic_level = 'heavy' THEN rn.cost * 2.0
          WHEN tc.traffic_level = 'severe' THEN rn.cost * 3.0
          ELSE rn.cost
        END as adjusted_cost,
        tc.traffic_level,
        tc.delay_minutes
      FROM road_network rn
      LEFT JOIN traffic_conditions tc ON rn.id = tc.road_id 
        AND tc.expires_at > CURRENT_TIMESTAMP
    )
    SELECT 
      seq,
      node,
      edge,
      adjusted_cost as cost,
      agg_cost,
      tac.traffic_level,
      tac.delay_minutes,
      rn.name as road_name,
      ST_AsGeoJSON(rn.geom) as road_geojson
    FROM pgr_dijkstra(
      'SELECT id, source, target, 
        COALESCE((SELECT adjusted_cost FROM traffic_adjusted_costs WHERE id = road_network.id), cost) as cost,
        COALESCE((SELECT adjusted_cost FROM traffic_adjusted_costs WHERE id = road_network.id), reverse_cost) as reverse_cost
       FROM road_network',
      (SELECT id FROM start_node),
      (SELECT id FROM end_node),
      directed := false
    ) route
    LEFT JOIN traffic_adjusted_costs tac ON route.edge = tac.id
    LEFT JOIN road_network rn ON route.edge = rn.id
    ORDER BY seq;
  `;

  const result = await _pool.query(query, [startLat, startLon, endLat, endLon]);
  return result.rows;
}

// Get traffic incidents
export async function getTrafficIncidents() {
  if (!_pool) return null;

  const query = `
    SELECT 
      tc.id,
      tc.road_id,
      tc.incident_type,
      tc.traffic_level,
      tc.delay_minutes,
      tc.updated_at,
      rn.name as road_name,
      ST_AsGeoJSON(rn.geom) as road_geojson,
      ST_X(ST_Centroid(rn.geom)) as longitude,
      ST_Y(ST_Centroid(rn.geom)) as latitude
    FROM traffic_conditions tc
    JOIN road_network rn ON tc.road_id = rn.id
    WHERE tc.incident_reported = true
      AND tc.expires_at > CURRENT_TIMESTAMP
    ORDER BY tc.traffic_level DESC, tc.delay_minutes DESC;
  `;

  const result = await _pool.query(query);
  return result.rows;
}

// Calculate ETA with traffic
export async function calculateETAWithTraffic(
  startLat: number,
  startLon: number,
  endLat: number,
  endLon: number
) {
  if (!_pool) return null;

  const route = await calculateTrafficAwareRoute(startLat, startLon, endLat, endLon);
  
  if (!route || route.length === 0) {
    return null;
  }

  const totalDistance = route[route.length - 1]?.agg_cost || 0;
  const totalDelay = route.reduce((sum, segment) => sum + (segment.delay_minutes || 0), 0);
  
  // Calculate base travel time (assuming average speed of 40 km/h)
  const baseTimeMinutes = (totalDistance / 40) * 60;
  const totalTimeMinutes = baseTimeMinutes + totalDelay;

  return {
    distance_km: totalDistance,
    base_time_minutes: baseTimeMinutes,
    traffic_delay_minutes: totalDelay,
    total_time_minutes: totalTimeMinutes,
    eta: new Date(Date.now() + totalTimeMinutes * 60000).toISOString(),
    route_segments: route.length - 1,
    traffic_conditions: route.filter(r => r.traffic_level).map(r => ({
      road: r.road_name,
      level: r.traffic_level,
      delay: r.delay_minutes
    }))
  };
}


// Historical Traffic Analysis Functions
export async function getTrafficPatterns(roadId?: number) {
  const db = await getDb();
  if (!db) throw new Error('Database not initialized');
  const pool = db.$client;

  const query = roadId
    ? `
      SELECT 
        hour_of_day,
        day_of_week,
        AVG(delay_minutes) as avg_delay,
        AVG(speed_kmh) as avg_speed,
        MODE() WITHIN GROUP (ORDER BY traffic_level) as typical_level,
        COUNT(*) as sample_count
      FROM traffic_history
      WHERE road_id = $1
      GROUP BY hour_of_day, day_of_week
      ORDER BY day_of_week, hour_of_day
    `
    : `
      SELECT 
        hour_of_day,
        day_of_week,
        AVG(delay_minutes) as avg_delay,
        AVG(speed_kmh) as avg_speed,
        MODE() WITHIN GROUP (ORDER BY traffic_level) as typical_level,
        COUNT(*) as sample_count
      FROM traffic_history
      GROUP BY hour_of_day, day_of_week
      ORDER BY day_of_week, hour_of_day
    `;

  const result = roadId 
    ? await pool.query(query, [roadId])
    : await pool.query(query);
  
  return result.rows;
}

export async function predictTrafficLevel(hour: number, dayOfWeek: number, roadId?: number) {
  const db = await getDb();
  if (!db) throw new Error('Database not initialized');
  const pool = db.$client;

  const query = roadId
    ? `
      SELECT 
        MODE() WITHIN GROUP (ORDER BY traffic_level) as predicted_level,
        AVG(delay_minutes) as predicted_delay,
        AVG(speed_kmh) as predicted_speed,
        COUNT(*) as confidence_samples
      FROM traffic_history
      WHERE hour_of_day = $1 
        AND day_of_week = $2
        AND road_id = $3
    `
    : `
      SELECT 
        MODE() WITHIN GROUP (ORDER BY traffic_level) as predicted_level,
        AVG(delay_minutes) as predicted_delay,
        AVG(speed_kmh) as predicted_speed,
        COUNT(*) as confidence_samples
      FROM traffic_history
      WHERE hour_of_day = $1 
        AND day_of_week = $2
    `;

  const result = roadId
    ? await pool.query(query, [hour, dayOfWeek, roadId])
    : await pool.query(query, [hour, dayOfWeek]);
  
  return result.rows[0];
}

export async function getOptimalDeliveryWindows(startLat: number, startLon: number, endLat: number, endLon: number) {
  const db = await getDb();
  if (!db) throw new Error('Database not initialized');
  const pool = db.$client;

  // Analyze traffic patterns for the next 24 hours
  const query = `
    WITH route_roads AS (
      SELECT id, name
      FROM road_network
      WHERE ST_DWithin(
        geom::geography,
        ST_MakeLine(
          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
          ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography
        ),
        1000
      )
      LIMIT 20
    ),
    hourly_predictions AS (
      SELECT 
        hour_val as hour,
        AVG(
          CASE th.traffic_level
            WHEN 'free_flow' THEN 0
            WHEN 'light' THEN 2
            WHEN 'moderate' THEN 5
            WHEN 'heavy' THEN 10
            WHEN 'severe' THEN 15
            ELSE 5
          END
        ) as avg_delay_minutes,
        MODE() WITHIN GROUP (ORDER BY th.traffic_level) as typical_level
      FROM generate_series(0, 23) as hour_val
      LEFT JOIN traffic_history th ON 
        th.hour_of_day = hour_val 
        AND th.road_id IN (SELECT id FROM route_roads)
        AND th.day_of_week = EXTRACT(DOW FROM NOW())::INTEGER
      GROUP BY hour_val
    )
    SELECT 
      hour,
      avg_delay_minutes,
      typical_level,
      CASE 
        WHEN avg_delay_minutes < 3 THEN 'excellent'
        WHEN avg_delay_minutes < 6 THEN 'good'
        WHEN avg_delay_minutes < 10 THEN 'fair'
        ELSE 'poor'
      END as window_quality
    FROM hourly_predictions
    ORDER BY avg_delay_minutes ASC, hour ASC;
  `;

  const result = await pool.query(query, [startLon, startLat, endLon, endLat]);
  return result.rows;
}

export async function getTrafficTrends(days: number = 7) {
  const db = await getDb();
  if (!db) throw new Error('Database not initialized');
  const pool = db.$client;

  const query = `
    SELECT 
      DATE(recorded_at) as date,
      hour_of_day,
      AVG(delay_minutes) as avg_delay,
      AVG(speed_kmh) as avg_speed,
      COUNT(CASE WHEN traffic_level IN ('heavy', 'severe') THEN 1 END) as congestion_count,
      COUNT(*) as total_samples
    FROM traffic_history
    WHERE recorded_at >= NOW() - ($1 || ' days')::INTERVAL
    GROUP BY DATE(recorded_at), hour_of_day
    ORDER BY date DESC, hour_of_day;
  `;

  const result = await pool.query(query, [days]);
  return result.rows;
}

export async function getPeakHours() {
  const db = await getDb();
  if (!db) throw new Error('Database not initialized');
  const pool = db.$client;

  const query = `
    SELECT 
      hour_of_day,
      day_of_week,
      AVG(delay_minutes) as avg_delay,
      COUNT(CASE WHEN traffic_level IN ('heavy', 'severe') THEN 1 END) as congestion_incidents,
      COUNT(*) as total_samples,
      CASE 
        WHEN AVG(delay_minutes) > 8 THEN 'peak'
        WHEN AVG(delay_minutes) > 5 THEN 'busy'
        ELSE 'normal'
      END as period_type
    FROM traffic_history
    GROUP BY hour_of_day, day_of_week
    HAVING AVG(delay_minutes) > 5
    ORDER BY avg_delay DESC
    LIMIT 20;
  `;

  const result = await pool.query(query);
  return result.rows;
}


// ==================== DRIVER PERFORMANCE SCORING ====================

export async function getDriverPerformanceScore(driverId: number) {
  if (!_pool) return null;
  
  const result = await _pool.query(
    'SELECT * FROM driver_performance_scores WHERE driver_id = $1',
    [driverId]
  );
  return result.rows[0] || null;
}

export async function getLeaderboard(limit: number = 50) {
  if (!_pool) return [];
  
  const result = await _pool.query(`
    SELECT 
      dps.*,
      d.name as driver_name,
      d.profile_image,
      d.vehicle_type
    FROM driver_performance_scores dps
    JOIN drivers d ON dps.driver_id = d.id
    ORDER BY dps.score DESC
    LIMIT $1
  `, [limit]);
  return result.rows;
}

export async function getLeaderboardByTier(tier: string) {
  if (!_pool) return [];
  
  const result = await _pool.query(`
    SELECT 
      dps.*,
      d.name as driver_name,
      d.profile_image,
      d.vehicle_type
    FROM driver_performance_scores dps
    JOIN drivers d ON dps.driver_id = d.id
    WHERE dps.tier = $1
    ORDER BY dps.score DESC
  `, [tier]);
  return result.rows;
}

export async function calculateDriverPerformance(driverId: number) {
  if (!_pool) return null;
  
  // Calculate performance metrics
  const result = await _pool.query(`
    WITH driver_stats AS (
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'delivered') as completed,
        COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled,
        COUNT(*) FILTER (WHERE actual_delivery_time <= estimated_delivery_time) as on_time,
        AVG(EXTRACT(EPOCH FROM (actual_delivery_time - scheduled_pickup_time))/60) as avg_delivery_minutes
      FROM orders
      WHERE driver_id = $1 AND status IN ('delivered', 'cancelled')
    ),
    review_stats AS (
      SELECT 
        AVG(overall_rating) as avg_rating,
        COUNT(*) as review_count
      FROM driver_reviews
      WHERE driver_id = $1
    )
    SELECT 
      ds.total as total_deliveries,
      ds.completed as completed_deliveries,
      ds.cancelled as cancelled_deliveries,
      ds.on_time as on_time_deliveries,
      ds.avg_delivery_minutes,
      CASE WHEN ds.total > 0 THEN (ds.completed::DECIMAL / ds.total * 100) ELSE 0 END as completion_rate,
      CASE WHEN ds.completed > 0 THEN (ds.on_time::DECIMAL / ds.completed * 100) ELSE 0 END as on_time_rate,
      rs.avg_rating,
      rs.review_count
    FROM driver_stats ds
    CROSS JOIN review_stats rs
  `, [driverId]);
  
  const stats = result.rows[0];
  if (!stats) return null;
  
  // Calculate component scores (0-100 scale)
  const deliveryTimeScore = Math.max(0, 100 - (parseFloat(stats.avg_delivery_minutes || '30') - 20) * 2);
  const reviewScore = (parseFloat(stats.avg_rating || '0') / 5) * 100;
  const acceptanceRate = parseFloat(stats.completion_rate || '0');
  const completionRate = parseFloat(stats.on_time_rate || '0');
  
  // Weighted overall score
  const overallScore = (
    deliveryTimeScore * 0.3 +
    reviewScore * 0.3 +
    acceptanceRate * 0.2 +
    completionRate * 0.2
  );
  
  // Determine tier
  let tier = 'bronze';
  if (overallScore >= 90) tier = 'platinum';
  else if (overallScore >= 80) tier = 'gold';
  else if (overallScore >= 70) tier = 'silver';
  
  // Update performance score
  await _pool.query(`
    INSERT INTO driver_performance_scores (
      driver_id, score, tier, delivery_time_score, review_score,
      acceptance_rate, completion_rate, total_deliveries, on_time_deliveries,
      late_deliveries, cancelled_deliveries, last_calculated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_TIMESTAMP)
    ON CONFLICT (driver_id) DO UPDATE SET
      score = $2,
      tier = $3,
      delivery_time_score = $4,
      review_score = $5,
      acceptance_rate = $6,
      completion_rate = $7,
      total_deliveries = $8,
      on_time_deliveries = $9,
      late_deliveries = $10,
      cancelled_deliveries = $11,
      last_calculated_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `, [
    driverId,
    overallScore.toFixed(2),
    tier,
    deliveryTimeScore.toFixed(2),
    reviewScore.toFixed(2),
    acceptanceRate.toFixed(2),
    completionRate.toFixed(2),
    stats.total_deliveries,
    stats.on_time_deliveries,
    parseInt(stats.total_deliveries) - parseInt(stats.on_time_deliveries),
    stats.cancelled_deliveries
  ]);
  
  return {
    driverId,
    score: overallScore,
    tier,
    deliveryTimeScore,
    reviewScore,
    acceptanceRate,
    completionRate,
    stats
  };
}

export async function getPerformanceTrends(driverId: number, days: number = 30) {
  if (!_pool) return [];
  
  const result = await _pool.query(`
    SELECT 
      DATE(created_at) as date,
      score,
      tier,
      total_deliveries
    FROM driver_performance_scores
    WHERE driver_id = $1 
      AND created_at >= CURRENT_DATE - INTERVAL '${days} days'
    ORDER BY created_at ASC
  `, [driverId]);
  
  return result.rows;
}

export async function getTierDistribution() {
  if (!_pool) return [];
  
  const result = await _pool.query(`
    SELECT 
      tier,
      COUNT(*) as count,
      AVG(score) as avg_score,
      MIN(score) as min_score,
      MAX(score) as max_score
    FROM driver_performance_scores
    GROUP BY tier
    ORDER BY 
      CASE tier
        WHEN 'platinum' THEN 1
        WHEN 'gold' THEN 2
        WHEN 'silver' THEN 3
        WHEN 'bronze' THEN 4
      END
  `);
  
  return result.rows;
}

export async function getPerformanceImprovementSuggestions(driverId: number) {
  const score = await getDriverPerformanceScore(driverId);
  if (!score) return [];
  
  const suggestions = [];
  
  if (parseFloat(score.delivery_time_score) < 70) {
    suggestions.push({
      category: 'Delivery Time',
      priority: 'high',
      suggestion: 'Focus on reducing delivery time. Use traffic-aware routing and plan efficient routes.',
      potentialImpact: '+5-10 points'
    });
  }
  
  if (parseFloat(score.review_score) < 70) {
    suggestions.push({
      category: 'Customer Reviews',
      priority: 'high',
      suggestion: 'Improve customer service. Be polite, professional, and communicate proactively.',
      potentialImpact: '+5-15 points'
    });
  }
  
  if (parseFloat(score.acceptance_rate) < 80) {
    suggestions.push({
      category: 'Acceptance Rate',
      priority: 'medium',
      suggestion: 'Accept more delivery requests to improve your acceptance rate and earnings.',
      potentialImpact: '+3-8 points'
    });
  }
  
  if (parseFloat(score.completion_rate) < 90) {
    suggestions.push({
      category: 'Completion Rate',
      priority: 'high',
      suggestion: 'Complete deliveries on time. Plan ahead and account for traffic conditions.',
      potentialImpact: '+5-10 points'
    });
  }

  const marketplaceProfile = await getDriverMarketplaceProfile(driverId);
  if (marketplaceProfile) {
    if (marketplaceProfile.utilization_rate < 55) {
      suggestions.push({
        category: 'Utilization',
        priority: 'medium',
        suggestion: 'Your active-vs-online utilization is low. Favor denser zones or trip-radar offers to reduce idle time.',
        potentialImpact: '+4-9 points'
      });
    }

    if (marketplaceProfile.cherry_pick_risk === 'high') {
      suggestions.push({
        category: 'Dispatch Eligibility',
        priority: 'high',
        suggestion: 'Frequent declines are reducing dispatch priority. Improve acceptance rate to regain first-look access on premium jobs.',
        potentialImpact: '+6-12 points'
      });
    }
  }
  
  return suggestions;
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


// ==================== NOTIFICATION PREFERENCES ====================

export async function getNotificationPreferences(userId: number) {
  if (!_pool) return null;
  
  const result = await _pool.query(
    'SELECT * FROM notification_preferences WHERE user_id = $1',
    [userId]
  );
  
  // If no preferences exist, create default ones
  if (result.rows.length === 0) {
    await _pool.query(
      'INSERT INTO notification_preferences (user_id) VALUES ($1)',
      [userId]
    );
    const newResult = await _pool.query(
      'SELECT * FROM notification_preferences WHERE user_id = $1',
      [userId]
    );
    return newResult.rows[0];
  }
  
  return result.rows[0];
}

export async function updateNotificationPreferences(
  userId: number,
  preferences: {
    channel_email?: boolean;
    channel_sms?: boolean;
    channel_push?: boolean;
    trigger_order_confirmed?: boolean;
    trigger_driver_assigned?: boolean;
    trigger_pickup_complete?: boolean;
    trigger_delivery_approaching?: boolean;
    trigger_delivery_complete?: boolean;
    trigger_order_cancelled?: boolean;
    trigger_promotion?: boolean;
    trigger_news?: boolean;
    dnd_enabled?: boolean;
    dnd_start_time?: string;
    dnd_end_time?: string;
    frequency_limit?: number;
  }
) {
  if (!_pool) return false;

  const allowedColumns = new Set([
    "channel_email",
    "channel_sms",
    "channel_push",
    "trigger_order_confirmed",
    "trigger_driver_assigned",
    "trigger_pickup_complete",
    "trigger_delivery_approaching",
    "trigger_delivery_complete",
    "trigger_order_cancelled",
    "trigger_promotion",
    "trigger_news",
    "dnd_enabled",
    "dnd_start_time",
    "dnd_end_time",
    "frequency_limit",
  ]);

  const fields: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  for (const [key, value] of Object.entries(preferences)) {
    if (!allowedColumns.has(key) || value === undefined) {
      continue;
    }

    fields.push(`${key} = $${paramIndex}`);
    values.push(value);
    paramIndex++;
  }

  if (fields.length === 0) return false;

  fields.push(`updated_at = CURRENT_TIMESTAMP`);
  values.push(userId);

  const query = `
    UPDATE notification_preferences
    SET ${fields.join(", ")}
    WHERE user_id = $${paramIndex}
  `;

  await _pool.query(query, values);
  return true;
}

export async function shouldSendNotification(
  userId: number,
  channel: 'email' | 'sms' | 'push',
  trigger: string
): Promise<boolean> {
  if (!_pool) return false;
  
  const prefs = await getNotificationPreferences(userId);
  if (!prefs) return false;
  
  // Check if channel is enabled
  const channelKey = `channel_${channel}`;
  if (!prefs[channelKey]) return false;
  
  // Check if trigger is enabled
  const triggerKey = `trigger_${trigger}`;
  if (prefs[triggerKey] === false) return false;
  
  // Check do-not-disturb
  if (prefs.dnd_enabled && prefs.dnd_start_time && prefs.dnd_end_time) {
    const now = new Date();
    const currentTime = now.toTimeString().slice(0, 5); // HH:MM format
    
    if (currentTime >= prefs.dnd_start_time && currentTime <= prefs.dnd_end_time) {
      return false;
    }
  }
  
  // Check frequency limit (notifications sent today)
  const result = await _pool.query(`
    SELECT COUNT(*) as count
    FROM notifications
    WHERE user_id = $1
      AND created_at >= CURRENT_DATE
  `, [userId]);
  
  const todayCount = parseInt(result.rows[0]?.count || '0');
  if (todayCount >= (prefs.frequency_limit || 10)) {
    return false;
  }
  
  return true;
}

export async function getNotificationHistory(userId: number, limit: number = 50) {
  if (!_pool) return [];
  
  const result = await _pool.query(`
    SELECT *
    FROM notifications
    WHERE user_id = $1
    ORDER BY created_at DESC
    LIMIT $2
  `, [userId, limit]);
  
  return result.rows;
}

export async function testNotificationPreview(
  userId: number,
  channel: 'email' | 'sms' | 'push',
  trigger: string
) {
  const canSend = await shouldSendNotification(userId, channel, trigger);
  const prefs = await getNotificationPreferences(userId);
  
  return {
    canSend,
    reason: !canSend ? getBlockReason(prefs, channel, trigger) : null,
    preferences: prefs
  };
}

function getBlockReason(prefs: any, channel: string, trigger: string): string {
  const channelKey = `channel_${channel}`;
  if (!prefs[channelKey]) {
    return `${channel.toUpperCase()} notifications are disabled`;
  }
  
  const triggerKey = `trigger_${trigger}`;
  if (prefs[triggerKey] === false) {
    return `Notifications for "${trigger}" are disabled`;
  }
  
  if (prefs.dnd_enabled) {
    return `Do Not Disturb is enabled (${prefs.dnd_start_time} - ${prefs.dnd_end_time})`;
  }
  
  return 'Daily notification limit reached';
}


// ============================================================================
// Notification Delivery Logs
// ============================================================================

export async function logNotificationDelivery(data: {
  userId: number;
  notificationType: string;
  channel: 'sms' | 'email' | 'push';
  recipient: string;
  messageId?: string;
  status: 'sent' | 'delivered' | 'failed' | 'bounced';
  errorMessage?: string;
  metadata?: any;
}) {
  await getDb(); // Ensure pool is initialized
  if (!_pool) throw new Error('Database not initialized');

  const result = await _pool.query<any>(
    `INSERT INTO notification_delivery_logs 
     (user_id, notification_type, channel, recipient, message_id, status, error_message, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      data.userId,
      data.notificationType,
      data.channel,
      data.recipient,
      data.messageId || null,
      data.status,
      data.errorMessage || null,
      data.metadata ? JSON.stringify(data.metadata) : null,
    ]
  );

  return result.rows[0];
}

export async function getNotificationDeliveryLogs(userId: number, limit: number = 50) {
  await getDb(); // Ensure pool is initialized
  if (!_pool) throw new Error('Database not initialized');

  const result = await _pool.query<any>(
    `SELECT * FROM notification_delivery_logs 
     WHERE user_id = $1 
     ORDER BY sent_at DESC 
     LIMIT $2`,
    [userId, limit]
  );

  return result.rows;
}

export async function getNotificationDeliveryStats(userId: number, days: number = 30) {
  await getDb(); // Ensure pool is initialized
  if (!_pool) throw new Error('Database not initialized');

  const result = await _pool.query<any>(
    `SELECT 
       channel,
       status,
       COUNT(*) as count
     FROM notification_delivery_logs
     WHERE user_id = $1 
       AND sent_at >= NOW() - INTERVAL '${days} days'
     GROUP BY channel, status
     ORDER BY channel, status`,
    [userId]
  );

  return result.rows;
}

export async function updateNotificationDeliveryStatus(
  messageId: string,
  status: 'delivered' | 'failed' | 'bounced',
  errorMessage?: string
) {
  await getDb(); // Ensure pool is initialized
  if (!_pool) throw new Error('Database not initialized');

  const result = await _pool.query<any>(
    `UPDATE notification_delivery_logs 
     SET status = $1, 
         error_message = $2,
         delivered_at = CASE WHEN $1 = 'delivered' THEN NOW() ELSE delivered_at END
     WHERE message_id = $3
     RETURNING *`,
    [status, errorMessage || null, messageId]
  );

  return result.rows[0];
}


// ============================================================================
// Driver Incentives & Payouts
// ============================================================================

export async function calculateDriverIncentive(driverId: number, month: number, year: number) {
  await getDb(); // Ensure pool is initialized
  if (!_pool) return null;

  // Get driver performance score
  const perfResult = await _pool.query<any>(
    'SELECT * FROM driver_performance_scores WHERE driver_id = $1',
    [driverId]
  );

  if (perfResult.rows.length === 0) return null;

  const performance = perfResult.rows[0];
  const tier = performance.tier;

  // Bonus amounts by tier
  const bonusAmounts = {
    platinum: 500,
    gold: 300,
    silver: 150,
    bronze: 50,
  };

  const bonusAmount = bonusAmounts[tier as keyof typeof bonusAmounts] || 0;

  // Insert incentive record
  const result = await _pool.query<any>(
    `INSERT INTO driver_incentives 
     (driver_id, incentive_type, amount, tier, description, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      driverId,
      'performance_bonus',
      bonusAmount,
      tier,
      `${tier.charAt(0).toUpperCase() + tier.slice(1)} tier performance bonus for ${month}/${year}`,
      'pending',
    ]
  );

  return result.rows[0];
}

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

export async function approveIncentive(incentiveId: number) {
  await getDb();
  if (!_pool) return false;

  const result = await _pool.query<any>(
    `UPDATE driver_incentives 
     SET status = 'approved'
     WHERE id = $1
     RETURNING *`,
    [incentiveId]
  );

  return result.rows.length > 0;
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

export async function generateMonthlySettlement(driverId: number, month: number, year: number, idempotencyKey?: string) {
  await getDb();
  if (!_pool) return null;

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

    const periodStart = new Date(year, month - 1, 1);
    const periodEnd = new Date(year, month, 0);

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
         AND actual_delivery_time <= $3`,
      [driverId, periodStart, periodEnd]
    );

    const bonusResult = await client.query<any>(
      `SELECT COALESCE(SUM(amount), 0) as bonus_amount
       FROM driver_incentives
       WHERE driver_id = $1
         AND status = 'approved'
         AND settlement_id IS NULL
         AND earned_at >= $2
         AND earned_at <= $3
       FOR UPDATE`,
      [driverId, periodStart, periodEnd]
    );

    const baseEarnings = parseFloat(earningsResult.rows[0].base_earnings) || 0;
    const bonusAmount = parseFloat(bonusResult.rows[0].bonus_amount) || 0;
    const totalAmount = baseEarnings + bonusAmount;

    const result = await client.query<any>(
      `INSERT INTO payout_settlements
       (driver_id, period_start, period_end, base_earnings, bonus_amount, total_amount, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [driverId, periodStart, periodEnd, baseEarnings, bonusAmount, totalAmount, 'pending']
    );

    await client.query<any>(
      `UPDATE driver_incentives
       SET settlement_id = $1
       WHERE driver_id = $2
         AND status = 'approved'
         AND settlement_id IS NULL
         AND earned_at >= $3
         AND earned_at <= $4`,
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

export async function getSettlementStats(month?: number, year?: number) {
  await getDb();
  if (!_pool) return null;

  let query = `
    SELECT 
      COUNT(*) as total_settlements,
      COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_count,
      COUNT(CASE WHEN status = 'approved' THEN 1 END) as approved_count,
      COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_count,
      COALESCE(SUM(total_amount), 0) as total_amount,
      COALESCE(SUM(CASE WHEN status = 'completed' THEN total_amount ELSE 0 END), 0) as paid_amount
    FROM payout_settlements
  `;

  const params: any[] = [];

  if (month && year) {
    query += ` WHERE EXTRACT(MONTH FROM period_end) = $1 AND EXTRACT(YEAR FROM period_end) = $2`;
    params.push(month, year);
  }

  const result = await _pool.query<any>(query, params);
  return result.rows[0];
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

  // Add points to account
  const updateResult = await _pool.query<any>(
    `UPDATE loyalty_points 
     SET points_balance = points_balance + $1,
         lifetime_points = lifetime_points + $1,
         updated_at = NOW()
     WHERE user_id = $2
     RETURNING *`,
    [points, userId]
  );

  if (updateResult.rows.length === 0) {
    await initializeLoyaltyAccount(userId);
    return await awardPoints(userId, points, transactionType, description, orderId);
  }

  // Check for tier upgrade
  const account = updateResult.rows[0];
  await checkAndUpgradeTier(userId, account.lifetime_points);

  // Log transaction
  await _pool.query<any>(
    `INSERT INTO loyalty_transactions (user_id, transaction_type, points, order_id, description)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, transactionType, points, orderId, description]
  );

  return await getLoyaltyAccount(userId);
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
    const idempotency = await beginPlatformIdempotentOperation(
      client,
      'loyalty.redeem',
      idempotencyKey,
      { userId, rewardId },
    );
    idempotencyClaimed = Boolean(idempotency.normalizedKey) && !idempotency.replay;
    if (idempotency.replay) {
      return idempotency.response;
    }

    await client.query('BEGIN');

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

    await client.query('COMMIT');
    await finalizePlatformIdempotentOperation(client, 'loyalty.redeem', idempotencyKey, 'completed', redemptionResult.rows[0]);
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

export async function getLoyaltyTransactions(userId: number, limit: number = 50) {
  await getDb();
  if (!_pool) return [];

  const result = await _pool.query<any>(
    `SELECT * FROM loyalty_transactions 
     WHERE user_id = $1 
     ORDER BY created_at DESC 
     LIMIT $2`,
    [userId, limit]
  );

  return result.rows;
}

export async function getAvailableRewards(userId: number) {
  await getDb();
  if (!_pool) return [];

  const account = await getLoyaltyAccount(userId);
  if (!account) return [];

  const result = await _pool.query<any>(
    `SELECT * FROM loyalty_rewards 
     WHERE is_active = true
       AND points_cost <= $1
     ORDER BY points_cost ASC`,
    [account.points_balance]
  );

  return result.rows;
}

export async function getUserRedemptions(userId: number) {
  await getDb();
  if (!_pool) return [];

  const result = await _pool.query<any>(
    `SELECT 
       r.*,
       rw.reward_name,
       rw.reward_type,
       rw.reward_value
     FROM loyalty_redemptions r
     JOIN loyalty_rewards rw ON r.reward_id = rw.id
     WHERE r.user_id = $1
     ORDER BY r.created_at DESC`,
    [userId]
  );

  return result.rows;
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

export async function getLoyaltyMembers(options?: {
  search?: string;
  tier?: string;
  limit?: number;
}) {
  await getDb();
  if (!_pool) return [];

  const clauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (options?.search?.trim()) {
    clauses.push(`(COALESCE(u.name, '') ILIKE $${paramIndex} OR COALESCE(u.email, '') ILIKE $${paramIndex})`);
    values.push(`%${options.search.trim()}%`);
    paramIndex++;
  }

  if (options?.tier && options.tier !== 'all') {
    clauses.push(`lp.tier = $${paramIndex}`);
    values.push(options.tier);
    paramIndex++;
  }

  const limit = Math.min(Math.max(options?.limit ?? 100, 1), 500);
  values.push(limit);

  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await _pool.query<any>(
    `SELECT 
       lp.*,
       u.name,
       u.email,
       u.role,
       u.last_signed_in
     FROM loyalty_points lp
     JOIN users u ON u.id = lp.user_id
     ${whereClause}
     ORDER BY lp.lifetime_points DESC, lp.updated_at DESC
     LIMIT $${paramIndex}`,
    values
  );

  return result.rows;
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

export async function createLoyaltyReward(input: {
  reward_name: string;
  description?: string;
  points_cost: number;
  reward_type: string;
  reward_value?: string;
  min_tier?: string | null;
  is_active?: boolean;
}) {
  await getDb();
  if (!_pool) return null;

  const result = await _pool.query<any>(
    `INSERT INTO loyalty_rewards (
      reward_name,
      description,
      points_cost,
      reward_type,
      reward_value,
      min_tier,
      is_active
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *`,
    [
      input.reward_name,
      input.description ?? null,
      input.points_cost,
      input.reward_type,
      input.reward_value ?? null,
      input.min_tier ?? null,
      input.is_active ?? true,
    ]
  );

  return result.rows[0] ?? null;
}

export async function updateLoyaltyReward(
  rewardId: number,
  updates: Partial<{
    reward_name: string;
    description: string | null;
    points_cost: number;
    reward_type: string;
    reward_value: string | null;
    min_tier: string | null;
    is_active: boolean;
  }>
) {
  await getDb();
  if (!_pool) return null;

  const allowedColumns = new Set([
    'reward_name',
    'description',
    'points_cost',
    'reward_type',
    'reward_value',
    'min_tier',
    'is_active',
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
    const current = await _pool.query<any>('SELECT * FROM loyalty_rewards WHERE id = $1', [rewardId]);
    return current.rows[0] ?? null;
  }

  fields.push('updated_at = NOW()');
  values.push(rewardId);

  const result = await _pool.query<any>(
    `UPDATE loyalty_rewards
     SET ${fields.join(', ')}
     WHERE id = $${paramIndex}
     RETURNING *`,
    values
  );

  return result.rows[0] ?? null;
}

export async function getAllLoyaltyRedemptions(options?: {
  status?: string;
  limit?: number;
}) {
  await getDb();
  if (!_pool) return [];

  const clauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (options?.status && options.status !== 'all') {
    clauses.push(`r.status = $${paramIndex}`);
    values.push(options.status);
    paramIndex++;
  }

  const limit = Math.min(Math.max(options?.limit ?? 100, 1), 500);
  values.push(limit);
  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  const result = await _pool.query<any>(
    `SELECT 
       r.*,
       rw.reward_name,
       rw.reward_type,
       rw.reward_value,
       u.name as user_name,
       u.email as user_email
     FROM loyalty_redemptions r
     JOIN loyalty_rewards rw ON r.reward_id = rw.id
     JOIN users u ON r.user_id = u.id
     ${whereClause}
     ORDER BY r.created_at DESC
     LIMIT $${paramIndex}`,
    values
  );

  return result.rows;
}


// ============================================================================
// Customer Referral System
// ============================================================================

const REFERRAL_BONUS = {
  referrer: 500,  // Points for the person who refers
  referred: 200,  // Points for the new user who signs up
};

export async function generateReferralCode(userId: number) {
  await getDb();
  if (!_pool) return null;

  // Generate a unique 8-character code
  const code = Math.random().toString(36).substring(2, 10).toUpperCase();

  const result = await _pool.query<any>(
    'UPDATE users SET referral_code = $1 WHERE id = $2 RETURNING referral_code',
    [code, userId]
  );

  return result.rows[0]?.referral_code || null;
}

export async function getUserReferralCode(userId: number) {
  await getDb();
  if (!_pool) return null;

  const result = await _pool.query<any>(
    'SELECT referral_code FROM users WHERE id = $1',
    [userId]
  );

  if (result.rows.length === 0 || !result.rows[0].referral_code) {
    return await generateReferralCode(userId);
  }

  return result.rows[0].referral_code;
}

export async function applyReferralCode(newUserId: number, referralCode: string, idempotencyKey?: string) {
  await getDb();
  if (!_pool) return null;

  const normalizedReferralCode = referralCode.trim().toUpperCase();
  const client = await _pool.connect();
  let idempotencyClaimed = false;

  try {
    const idempotency = await beginPlatformIdempotentOperation(
      client,
      'referral.apply_code',
      idempotencyKey,
      { newUserId, referralCode: normalizedReferralCode },
    );
    idempotencyClaimed = Boolean(idempotency.normalizedKey) && !idempotency.replay;
    if (idempotency.replay) {
      return idempotency.response;
    }

    await client.query('BEGIN');

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
        await client.query('COMMIT');
        await finalizePlatformIdempotentOperation(client, 'referral.apply_code', idempotencyKey, 'completed', existing);
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

    await client.query('COMMIT');
    await finalizePlatformIdempotentOperation(client, 'referral.apply_code', idempotencyKey, 'completed', referralResult.rows[0]);
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
    const idempotency = await beginPlatformIdempotentOperation(
      client,
      'referral.complete',
      idempotencyKey,
      { referralId },
    );
    idempotencyClaimed = Boolean(idempotency.normalizedKey) && !idempotency.replay;
    if (idempotency.replay) {
      return idempotency.response;
    }

    await client.query('BEGIN');

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

    await client.query('COMMIT');
    const completedReferral = await getReferralById(referralId);
    await finalizePlatformIdempotentOperation(client, 'referral.complete', idempotencyKey, 'completed', completedReferral);
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

export async function getReferralById(referralId: number) {
  await getDb();
  if (!_pool) return null;

  const result = await _pool.query<any>(
    `SELECT 
       r.*,
       u1.name as referrer_name,
       u1.email as referrer_email,
       u2.name as referred_name,
       u2.email as referred_email
     FROM customer_referrals r
     JOIN users u1 ON r.referrer_id = u1.id
     LEFT JOIN users u2 ON r.referred_id = u2.id
     WHERE r.id = $1`,
    [referralId]
  );

  return result.rows[0] || null;
}

export async function getUserReferrals(userId: number) {
  await getDb();
  if (!_pool) return [];

  const result = await _pool.query<any>(
    `SELECT 
       r.*,
       u.name as referred_name,
       u.email as referred_email
     FROM customer_referrals r
     LEFT JOIN users u ON r.referred_id = u.id
     WHERE r.referrer_id = $1
     ORDER BY r.created_at DESC`,
    [userId]
  );

  return result.rows;
}

export async function getReferralStats(userId?: number) {
  await getDb();
  if (!_pool) return null;

  if (userId) {
    // Stats for specific user
    const result = await _pool.query<any>(
      `SELECT 
         COUNT(*) as total_referrals,
         COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_referrals,
         COUNT(CASE WHEN status = 'rewarded' THEN 1 END) as rewarded_referrals,
         COALESCE(SUM(CASE WHEN status = 'rewarded' THEN referrer_bonus_points ELSE 0 END), 0) as total_points_earned
       FROM customer_referrals
       WHERE referrer_id = $1`,
      [userId]
    );
    return result.rows[0];
  } else {
    // Platform-wide stats
    const result = await _pool.query<any>(`
      SELECT 
        COUNT(*) as total_referrals,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_referrals,
        COUNT(CASE WHEN status = 'rewarded' THEN 1 END) as rewarded_referrals,
        COUNT(DISTINCT referrer_id) as active_referrers,
        COALESCE(SUM(referrer_bonus_points + referred_bonus_points), 0) as total_points_distributed
      FROM customer_referrals
    `);
    return result.rows[0];
  }
}

export async function calculateViralCoefficient() {
  await getDb();
  if (!_pool) return 0;

  // Viral coefficient = (Number of invitations sent) / (Number of existing users)
  // Simplified: (Completed referrals) / (Total users who made referrals)
  const result = await _pool.query<any>(`
    SELECT 
      COUNT(CASE WHEN status IN ('completed', 'rewarded') THEN 1 END)::FLOAT as completed,
      COUNT(DISTINCT referrer_id)::FLOAT as referrers
    FROM customer_referrals
  `);

  const { completed, referrers } = result.rows[0];
  return referrers > 0 ? completed / referrers : 0;
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

export async function sendCampaignToAudience(campaignId: number, idempotencyKey?: string) {
  await getDb();
  if (!_pool) return { sent: 0, failed: 0, total: 0 };

  const campaign = await getCampaignById(campaignId);
  if (!campaign || !campaign.is_active) {
    throw new Error('Campaign not found or inactive');
  }

  let userQuery = 'SELECT id FROM users WHERE 1=1';
  const params: any[] = [];

  if (campaign.target_audience !== 'all') {
    if (['bronze', 'silver', 'gold', 'platinum'].includes(campaign.target_audience)) {
      userQuery += ' AND id IN (SELECT user_id FROM loyalty_points WHERE tier = $1)';
      params.push(campaign.target_audience);
    }
  }

  const usersResult = await _pool.query<any>(userQuery, params);
  const users = usersResult.rows;

  let sent = 0;
  let failed = 0;
  const audienceScope = idempotencyKey?.trim() || `campaign.audience.${campaignId}`;

  for (const user of users) {
    try {
      await sendCampaign(campaignId, user.id, 'email', `${audienceScope}:user:${user.id}:channel:email`);
      sent++;
    } catch (error) {
      failed++;
      console.error(`Failed to send campaign to user ${user.id}:`, error);
    }
  }

  return { sent, failed, total: users.length };
}

export async function getCampaignSends(campaignId: number) {
  await getDb();
  if (!_pool) return [];

  const result = await _pool.query<any>(
    `SELECT 
       cs.*,
       u.name as user_name,
       u.email as user_email
     FROM campaign_sends cs
     JOIN users u ON cs.user_id = u.id
     WHERE cs.campaign_id = $1
     ORDER BY cs.created_at DESC`,
    [campaignId]
  );

  return result.rows;
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

export async function trackCampaignOpen(sendId: number) {
  await getDb();
  if (!_pool) return null;

  await _pool.query<any>(
    `UPDATE campaign_sends 
     SET status = 'opened', opened_at = NOW()
     WHERE id = $1 AND status = 'sent'`,
    [sendId]
  );

  return true;
}

export async function trackCampaignClick(sendId: number) {
  await getDb();
  if (!_pool) return null;

  await _pool.query<any>(
    `UPDATE campaign_sends 
     SET status = 'clicked', clicked_at = NOW()
     WHERE id = $1 AND status IN ('sent', 'opened')`,
    [sendId]
  );

  return true;
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

  _platformTablesEnsured = false;
  await ensurePlatformTables();

  const retry = await _pool.query<any>(
    `SELECT * FROM referral_leaderboard_periods 
     WHERE is_active = true 
     ORDER BY period_start DESC 
     LIMIT 1`
  );

  return retry.rows[0]
    ? {
        ...retry.rows[0],
        status: 'active',
      }
    : null;
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

export async function distributeLeaderboardRewards(periodId: number) {
  await getDb();
  if (!_pool) return { distributed: 0, total_points: 0 };

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

export async function trackPushNotificationClick(logId: number) {
  await getDb();
  if (!_pool) return null;

  await _pool.query<any>(
    `UPDATE push_notification_logs 
     SET status = 'clicked', clicked_at = NOW()
     WHERE id = $1`,
    [logId]
  );

  return true;
}

// Notification templates for common events
export async function sendTierUpgradeNotification(userId: number, newTier: string) {
  return await sendPushToUser(
    userId,
    'tier_upgrade',
    '🎉 Tier Upgrade!',
    `Congratulations! You've been upgraded to ${newTier.toUpperCase()} tier!`,
    { tier: newTier }
  );
}

export async function sendPointsEarnedNotification(userId: number, points: number, reason: string) {
  return await sendPushToUser(
    userId,
    'points_earned',
    '✨ Points Earned!',
    `You earned ${points} points! ${reason}`,
    { points, reason }
  );
}

export async function sendReferralBonusNotification(userId: number, points: number) {
  return await sendPushToUser(
    userId,
    'referral_bonus',
    '🎁 Referral Bonus!',
    `Your friend signed up! You earned ${points} bonus points.`,
    { points }
  );
}

export async function sendLeaderboardPositionNotification(userId: number, rank: number, reward: number) {
  return await sendPushToUser(
    userId,
    'leaderboard_position',
    '🏆 Leaderboard Update!',
    `You're ranked #${rank} this month! Earn ${reward} bonus points if you maintain your position.`,
    { rank, reward }
  );
}

export async function sendRewardAvailableNotification(userId: number, rewardName: string) {
  return await sendPushToUser(
    userId,
    'reward_available',
    '🎁 New Reward Available!',
    `Check out the new reward: ${rewardName}`,
    { reward_name: rewardName }
  );
}


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

  const result = await _pool.query<any>(
    `INSERT INTO campaign_variants 
     (campaign_id, variant_name, email_template, sms_template, traffic_allocation)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [
      variantData.campaign_id,
      variantData.variant_name,
      variantData.email_template,
      variantData.sms_template,
      variantData.traffic_allocation || 50,
    ]
  );

  return result.rows[0];
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

export async function assignVariantToUser(campaignId: number, userId: number): Promise<any> {
  await getDb();
  if (!_pool) return null;

  // Check if user already has an assignment
  const existingResult = await _pool.query<any>(
    `SELECT * FROM variant_assignments 
     WHERE campaign_id = $1 AND user_id = $2`,
    [campaignId, userId]
  );

  if (existingResult.rows.length > 0) {
    // Return existing assignment
    const variantResult = await _pool.query<any>(
      `SELECT * FROM campaign_variants WHERE id = $1`,
      [existingResult.rows[0].variant_id]
    );
    return variantResult.rows[0];
  }

  // Get all variants for this campaign
  const variants = await getCampaignVariants(campaignId);
  
  if (variants.length === 0) {
    throw new Error('No variants found for this campaign');
  }

  // Select variant based on traffic allocation
  const random = Math.random() * 100;
  let cumulativeAllocation = 0;
  let selectedVariant = variants[0];

  for (const variant of variants) {
    cumulativeAllocation += parseFloat(variant.traffic_allocation);
    if (random <= cumulativeAllocation) {
      selectedVariant = variant;
      break;
    }
  }

  // Create assignment
  await _pool.query<any>(
    `INSERT INTO variant_assignments (campaign_id, variant_id, user_id)
     VALUES ($1, $2, $3)`,
    [campaignId, selectedVariant.id, userId]
  );

  return selectedVariant;
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

  const result = await _pool.query<any>(
    `UPDATE campaign_variants 
     SET traffic_allocation = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING *`,
    [allocation, variantId]
  );

  return result.rows[0];
}


// ============================================================================
// Growth Analytics
// ============================================================================

export async function getGrowthAnalytics(dateRange?: { start: Date; end: Date }) {
  await getDb();
  if (!_pool) return null;

  const startDate = dateRange?.start || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const endDate = dateRange?.end || new Date();

  // Leaderboard stats
  const leaderboardStats = await _pool.query<any>(
    `SELECT 
       COUNT(DISTINCT user_id) as total_participants,
       SUM(successful_referrals) as total_referrals,
       SUM(points_earned) as total_points_earned,
       AVG(successful_referrals) as avg_referrals_per_user
     FROM referral_leaderboard_entries
     WHERE created_at >= $1 AND created_at <= $2`,
    [startDate, endDate]
  );

  // Campaign performance
  const campaignStats = await _pool.query<any>(
    `SELECT 
       COUNT(*) as total_campaigns,
       COUNT(CASE WHEN status = 'active' THEN 1 END) as active_campaigns,
       SUM(send_count) as total_sends,
       SUM(open_count) as total_opens,
       SUM(click_count) as total_clicks,
       CASE 
         WHEN SUM(send_count) > 0 THEN ROUND((SUM(open_count)::DECIMAL / SUM(send_count)) * 100, 2)
         ELSE 0
       END as avg_open_rate,
       CASE 
         WHEN SUM(send_count) > 0 THEN ROUND((SUM(click_count)::DECIMAL / SUM(send_count)) * 100, 2)
         ELSE 0
       END as avg_click_rate
     FROM marketing_campaigns
     WHERE created_at >= $1 AND created_at <= $2`,
    [startDate, endDate]
  );

  // Push notification stats
  const pushStats = await _pool.query<any>(
    `SELECT 
       COUNT(*) as total_notifications,
       COUNT(CASE WHEN status = 'sent' THEN 1 END) as sent_count,
       COUNT(CASE WHEN status = 'delivered' THEN 1 END) as delivered_count,
       COUNT(CASE WHEN status = 'clicked' THEN 1 END) as clicked_count,
       COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_count,
       CASE 
         WHEN COUNT(*) > 0 THEN ROUND((COUNT(CASE WHEN status = 'clicked' THEN 1 END)::DECIMAL / COUNT(*)) * 100, 2)
         ELSE 0
       END as click_through_rate
     FROM push_notification_logs
     WHERE created_at >= $1 AND created_at <= $2`,
    [startDate, endDate]
  );

  // Referral conversion funnel
  const referralFunnel = await _pool.query<any>(
    `SELECT 
       COUNT(*) as total_referrals,
       COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending,
       COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed,
       COUNT(CASE WHEN status = 'rewarded' THEN 1 END) as rewarded,
       CASE 
         WHEN COUNT(*) > 0 THEN ROUND((COUNT(CASE WHEN status = 'rewarded' THEN 1 END)::DECIMAL / COUNT(*)) * 100, 2)
         ELSE 0
       END as conversion_rate
     FROM customer_referrals
     WHERE created_at >= $1 AND created_at <= $2`,
    [startDate, endDate]
  );

  // A/B testing stats
  const abTestStats = await _pool.query<any>(
    `SELECT 
       COUNT(DISTINCT campaign_id) as campaigns_with_tests,
       COUNT(*) as total_variants,
       COUNT(CASE WHEN is_winner = true THEN 1 END) as winners_selected,
       AVG(CASE WHEN send_count > 0 THEN (conversion_count::DECIMAL / send_count) * 100 ELSE 0 END) as avg_conversion_rate
     FROM campaign_variants cv
     JOIN marketing_campaigns mc ON cv.campaign_id = mc.id
     WHERE mc.created_at >= $1 AND mc.created_at <= $2`,
    [startDate, endDate]
  );

  // Top leaderboard winners
  const topWinners = await _pool.query<any>(
    `SELECT 
       u.name,
       u.email,
       le.successful_referrals,
       le.points_earned,
       le.rank,
       le.reward_tier,
       le.reward_points
     FROM referral_leaderboard_entries le
     JOIN users u ON le.user_id = u.id
     WHERE le.created_at >= $1 AND le.created_at <= $2
       AND le.rank IS NOT NULL
     ORDER BY le.rank ASC
     LIMIT 10`,
    [startDate, endDate]
  );

  // Top performing campaigns
  const topCampaigns = await _pool.query<any>(
    `SELECT 
       campaign_name,
       campaign_type,
       send_count,
       open_count,
       click_count,
       CASE 
         WHEN send_count > 0 THEN ROUND((open_count::DECIMAL / send_count) * 100, 2)
         ELSE 0
       END as open_rate,
       CASE 
         WHEN send_count > 0 THEN ROUND((click_count::DECIMAL / send_count) * 100, 2)
         ELSE 0
       END as click_rate
     FROM marketing_campaigns
     WHERE created_at >= $1 AND created_at <= $2
       AND send_count > 0
     ORDER BY click_rate DESC
     LIMIT 10`,
    [startDate, endDate]
  );

  return {
    leaderboard: leaderboardStats.rows[0],
    campaigns: campaignStats.rows[0],
    pushNotifications: pushStats.rows[0],
    referralFunnel: referralFunnel.rows[0],
    abTesting: abTestStats.rows[0],
    topWinners: topWinners.rows,
    topCampaigns: topCampaigns.rows,
  };
}

export async function getGrowthTrends(days: number = 30) {
  await getDb();
  if (!_pool) return [];

  const result = await _pool.query<any>(
    `SELECT 
       DATE(created_at) as date,
       COUNT(*) as referral_count,
       COUNT(CASE WHEN status = 'rewarded' THEN 1 END) as converted_count
     FROM customer_referrals
     WHERE created_at >= NOW() - INTERVAL '${days} days'
     GROUP BY DATE(created_at)
     ORDER BY date ASC`
  );

  return result.rows;
}


// ============================================================================
// Job Monitoring Functions
// ============================================================================

export async function getJobLogs(limit: number = 100) {
  const pool = await getDb();
  if (!pool) return [];
  
  const result = await (pool as any).query(
    `SELECT * FROM scheduled_job_logs 
     ORDER BY created_at DESC 
     LIMIT $1`,
    [limit]
  );
  
  return result.rows;
}

export async function getJobLogsByName(jobName: string, limit: number = 50) {
  const pool = await getDb();
  if (!pool) return [];
  
  const result = await (pool as any).query(
    `SELECT * FROM scheduled_job_logs 
     WHERE job_name = $1 
     ORDER BY created_at DESC 
     LIMIT $2`,
    [jobName, limit]
  );
  
  return result.rows;
}

export async function getJobStats() {
  const pool = await getDb();
  if (!pool) return null;
  
  const result = await (pool as any).query(
    `SELECT 
       job_name,
       COUNT(*) as total_executions,
       SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successful,
       SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as failed,
       AVG(execution_time_ms) as avg_execution_time_ms,
       MAX(created_at) as last_execution
     FROM scheduled_job_logs
     WHERE created_at > NOW() - INTERVAL '30 days'
     GROUP BY job_name
     ORDER BY job_name`
  );
  
  return result.rows;
}

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
  
  // Log the manual trigger
  await logJobExecution({
    jobName,
    status: 'running',
    message: 'Manually triggered',
  });
  
  // Note: The actual job execution happens via the cron schedule
  // This just logs that a manual trigger was requested
  return { success: true, message: `Job ${jobName} trigger requested` };
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

export async function getDigestHistory(limit: number = 20) {
  const pool = await getDb();
  if (!pool) return [];
  
  const result = await (pool as any).query(
    `SELECT * FROM email_digests 
     ORDER BY created_at DESC 
     LIMIT $1`,
    [limit]
  );
  
  return result.rows;
}


// ============================================================================
// Gamification Badge Functions
// ============================================================================

export async function checkAndAwardBadges(customerId: number) {
  const pool = await getDb();
  if (!pool) return [];
  
  // Get customer stats
  const customerStats = await (pool as any).query(
    `SELECT 
       c.points_balance,
       c.current_tier,
       COUNT(DISTINCT cr.id) as referral_count
     FROM customers c
     LEFT JOIN customer_referrals cr ON c.id = cr.referrer_customer_id AND cr.status = 'completed'
     WHERE c.id = $1
     GROUP BY c.id, c.points_balance, c.current_tier`,
    [customerId]
  );
  
  if (customerStats.rows.length === 0) return [];
  
  const stats = customerStats.rows[0];
  const awardedBadges = [];
  
  // Get all badges
  const badges = await (pool as any).query(
    `SELECT * FROM achievement_badges`
  );
  
  // Check each badge
  for (const badge of badges.rows) {
    // Check if already earned
    const existing = await (pool as any).query(
      `SELECT id FROM customer_badges 
       WHERE customer_id = $1 AND badge_id = $2`,
      [customerId, badge.id]
    );
    
    if (existing.rows.length > 0) continue;
    
    // Check if eligible
    let eligible = false;
    
    if (badge.referrals_required && stats.referral_count >= badge.referrals_required) {
      eligible = true;
    }
    
    if (badge.points_required && stats.points_balance >= badge.points_required) {
      eligible = true;
    }
    
    if (badge.tier_required && stats.current_tier === badge.tier_required) {
      eligible = true;
    }
    
    // Award badge
    if (eligible) {
      await (pool as any).query(
        `INSERT INTO customer_badges (customer_id, badge_id)
         VALUES ($1, $2)`,
        [customerId, badge.id]
      );
      
      awardedBadges.push(badge);
    }
  }
  
  return awardedBadges;
}

export async function getCustomerBadges(customerId: number) {
  const pool = await getDb();
  if (!pool) return [];
  
  const result = await (pool as any).query(
    `SELECT ab.*, cb.earned_at
     FROM customer_badges cb
     JOIN achievement_badges ab ON cb.badge_id = ab.id
     WHERE cb.customer_id = $1
     ORDER BY cb.earned_at DESC`,
    [customerId]
  );
  
  return result.rows;
}

export async function getAllBadges() {
  const pool = await getDb();
  if (!pool) return [];
  
  const result = await (pool as any).query(
    `SELECT * FROM achievement_badges ORDER BY badge_type, referrals_required, points_required`
  );
  
  return result.rows;
}

export async function getBadgeLeaderboard(limit: number = 10) {
  const pool = await getDb();
  if (!pool) return [];
  
  const result = await (pool as any).query(
    `SELECT 
       c.id,
       c.name,
       c.email,
       COUNT(cb.id) as badge_count
     FROM customers c
     JOIN customer_badges cb ON c.id = cb.customer_id
     GROUP BY c.id, c.name, c.email
     ORDER BY badge_count DESC
     LIMIT $1`,
    [limit]
  );
  
  return result.rows;
}


// ============================================================================
// Platform Completion Helpers
// ============================================================================

export async function getMarketplaceOperationsOverview() {
  await getDb();
  if (!_pool) return null;

  const [zoneStatsResult, pendingOrdersResult, driverStatusResult, fallbackSignalResult] = await Promise.all([
    _pool.query<any>(`
      WITH order_pressure AS (
        SELECT
          COALESCE(vertical_id, 0) AS zone_key,
          COUNT(*) FILTER (WHERE status IN ('pending', 'confirmed', 'assigned', 'in_progress')) AS open_orders,
          COUNT(*) FILTER (WHERE status = 'pending') AS waiting_orders,
          AVG(COALESCE(EXTRACT(EPOCH FROM (NOW() - created_at)) / 60.0, 0)) FILTER (WHERE status = 'pending') AS avg_wait_minutes
        FROM orders
        WHERE created_at >= NOW() - INTERVAL '24 hours'
        GROUP BY COALESCE(vertical_id, 0)
      ),
      driver_supply AS (
        SELECT
          COALESCE(primary_vertical_id, 0) AS zone_key,
          COUNT(*) FILTER (WHERE status IN ('online', 'available')) AS available_drivers,
          COUNT(*) FILTER (WHERE status = 'busy') AS busy_drivers
        FROM drivers
        GROUP BY COALESCE(primary_vertical_id, 0)
      )
      SELECT
        COALESCE(op.zone_key, ds.zone_key) AS zone_key,
        COALESCE(op.open_orders, 0) AS open_orders,
        COALESCE(op.waiting_orders, 0) AS waiting_orders,
        ROUND(COALESCE(op.avg_wait_minutes, 0)::numeric, 2) AS avg_wait_minutes,
        COALESCE(ds.available_drivers, 0) AS available_drivers,
        COALESCE(ds.busy_drivers, 0) AS busy_drivers,
        ROUND(
          (COALESCE(op.open_orders, 0)::numeric / GREATEST(COALESCE(ds.available_drivers, 0), 1)),
          2
        ) AS pressure_ratio
      FROM order_pressure op
      FULL OUTER JOIN driver_supply ds ON ds.zone_key = op.zone_key
      ORDER BY pressure_ratio DESC, waiting_orders DESC
      LIMIT 6
    `),
    _pool.query<any>(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending') AS pending_orders,
        COUNT(*) FILTER (WHERE status IN ('confirmed', 'assigned', 'in_progress')) AS active_orders,
        ROUND(COALESCE(AVG(EXTRACT(EPOCH FROM (NOW() - created_at)) / 60.0) FILTER (WHERE status = 'pending'), 0)::numeric, 2) AS avg_queue_minutes
      FROM orders
      WHERE created_at >= NOW() - INTERVAL '24 hours'
    `),
    _pool.query<any>(`
      SELECT
        COUNT(*) AS total_drivers,
        COUNT(*) FILTER (WHERE status IN ('online', 'available')) AS available_drivers,
        COUNT(*) FILTER (WHERE status = 'busy') AS busy_drivers,
        COUNT(*) FILTER (WHERE status = 'offline') AS offline_drivers
      FROM drivers
    `),
    _pool.query<any>(`
      SELECT
        COUNT(*) FILTER (WHERE entity = 'order' AND action = 'assign_driver') AS assignment_events,
        COUNT(*) FILTER (WHERE entity = 'order' AND action = 'update_order_status') AS status_events,
        COUNT(*) FILTER (WHERE entity = 'support_ticket') AS support_events
      FROM audit_logs
      WHERE created_at >= NOW() - INTERVAL '7 days'
    `),
  ]);

  const queue = pendingOrdersResult.rows[0] || {};
  const drivers = driverStatusResult.rows[0] || {};
  const fallbackSignals = fallbackSignalResult.rows[0] || {};
  const hotspots = zoneStatsResult.rows.map((row: any) => {
    const pressure = Number(row.pressure_ratio || 0);
    return {
      zone_key: Number(row.zone_key || 0),
      open_orders: Number(row.open_orders || 0),
      waiting_orders: Number(row.waiting_orders || 0),
      avg_wait_minutes: Number(row.avg_wait_minutes || 0),
      available_drivers: Number(row.available_drivers || 0),
      busy_drivers: Number(row.busy_drivers || 0),
      pressure_ratio: pressure,
      pressure_band: pressure >= 3 ? 'critical' : pressure >= 1.8 ? 'elevated' : pressure >= 1 ? 'balanced' : 'oversupplied',
      recommended_action: pressure >= 3
        ? 'Rebalance supply or switch affected orders to trip-radar mode.'
        : pressure >= 1.8
          ? 'Increase assignment urgency and review long-pickup compensation.'
          : pressure < 1
            ? 'Use the zone to absorb overflow from neighboring demand clusters.'
            : 'Maintain current dispatch policy and monitor wait time drift.',
    };
  });

  return {
    queue: {
      pending_orders: Number(queue.pending_orders || 0),
      active_orders: Number(queue.active_orders || 0),
      avg_queue_minutes: Number(queue.avg_queue_minutes || 0),
    },
    drivers: {
      total_drivers: Number(drivers.total_drivers || 0),
      available_drivers: Number(drivers.available_drivers || 0),
      busy_drivers: Number(drivers.busy_drivers || 0),
      offline_drivers: Number(drivers.offline_drivers || 0),
    },
    activity_signals: {
      assignment_events_7d: Number(fallbackSignals.assignment_events || 0),
      status_events_7d: Number(fallbackSignals.status_events || 0),
      support_events_7d: Number(fallbackSignals.support_events || 0),
    },
    hotspots,
  };
}

export async function getDispatchControlCenter(limit: number = 12) {
  await getDb();
  if (!_pool) return [];

  const result = await _pool.query<any>(`
    WITH candidate_orders AS (
      SELECT
        o.id,
        o.customer_id,
        o.driver_id,
        o.vertical_id,
        o.status,
        o.total_amount,
        o.created_at,
        o.updated_at,
        o.notes,
        COALESCE(v.name, CONCAT('Vertical ', o.vertical_id::text)) AS vertical_name,
        CONCAT('Customer ', COALESCE(o.customer_id::text, 'N/A')) AS customer_name,
        GREATEST(0, EXTRACT(EPOCH FROM (NOW() - o.created_at)) / 60.0) AS queue_minutes,
        CASE WHEN COALESCE(o.notes, '') ILIKE '%stop%' THEN true ELSE false END AS multi_stop,
        CASE WHEN COALESCE(o.notes, '') ILIKE '%priority%' OR COALESCE(o.total_amount, 0)::numeric >= 100 THEN true ELSE false END AS vip_or_high_value,
        CASE WHEN COALESCE(o.estimated_delivery_time, o.created_at + INTERVAL '65 minutes') >= o.created_at + INTERVAL '60 minutes' THEN 75 ELSE 35 END AS long_trip_minutes
      FROM orders o
      LEFT JOIN service_verticals v ON v.id = o.vertical_id
      WHERE o.status IN ('pending', 'confirmed', 'assigned')
      ORDER BY o.created_at ASC
      LIMIT $1
    ),
    driver_supply AS (
      SELECT
        COALESCE(primary_vertical_id, 0) AS vertical_key,
        COUNT(*) FILTER (WHERE status IN ('online', 'available')) AS available_count
      FROM drivers
      GROUP BY COALESCE(primary_vertical_id, 0)
    ),
    order_pressure AS (
      SELECT
        COALESCE(vertical_id, 0) AS vertical_key,
        COUNT(*) FILTER (WHERE status IN ('pending', 'confirmed', 'assigned', 'in_progress')) AS open_orders
      FROM orders
      WHERE created_at >= NOW() - INTERVAL '24 hours'
      GROUP BY COALESCE(vertical_id, 0)
    )
    SELECT
      co.*, 
      COALESCE(ds.available_count, 0) AS available_count,
      COALESCE(op.open_orders, 0) AS open_orders,
      ROUND((COALESCE(op.open_orders, 0)::numeric / GREATEST(COALESCE(ds.available_count, 0), 1)), 2) AS pressure_ratio
    FROM candidate_orders co
    LEFT JOIN driver_supply ds ON ds.vertical_key = COALESCE(co.vertical_id, 0)
    LEFT JOIN order_pressure op ON op.vertical_key = COALESCE(co.vertical_id, 0)
    ORDER BY co.created_at ASC
  `, [limit]);

  const driversResult = await _pool.query<any>(`
    SELECT
      d.id AS driver_id,
      d.name,
      d.status,
      COALESCE(d.primary_vertical_id, 0) AS primary_vertical_id,
      COALESCE(dps.tier, 'bronze') AS tier,
      COALESCE(dps.acceptance_rate, 65) AS acceptance_rate,
      COALESCE(dps.completion_rate, 85) AS completion_rate,
      COALESCE(dps.score, 0) AS score
    FROM drivers d
    LEFT JOIN driver_performance_scores dps ON dps.driver_id = d.id
    WHERE d.status IN ('online', 'available', 'busy')
    ORDER BY COALESCE(dps.score, 0) DESC, d.id ASC
    LIMIT 40
  `);

  const driverRows = driversResult.rows;
  const items = [];

  for (const row of result.rows) {
    const relevantDrivers = driverRows
      .filter((driver: any) => Number(driver.primary_vertical_id || 0) === Number(row.vertical_id || 0) || Number(driver.primary_vertical_id || 0) === 0)
      .slice(0, 8)
      .map((driver: any, index: number) => ({
        id: Number(driver.driver_id),
        name: driver.name,
        tier: driver.tier,
        acceptanceRate: Number(driver.acceptance_rate || 0),
        completionRate: Number(driver.completion_rate || 0),
        utilizationRate: Math.max(20, Math.min(95, Number(driver.score || 0))),
        distanceKm: Number((1.4 + index * 0.9 + Number(row.pressure_ratio || 0) * 0.7).toFixed(2)),
        idleMinutes: Math.max(6, 35 - index * 3),
        recentRejections: index > 3 ? 1 : 0,
        onTrip: driver.status === 'busy',
      }));

    const optimization = optimizeDispatch(relevantDrivers);
    const strategy = Number(row.long_trip_minutes || 0) >= 60 || optimization.batchingEligible
      ? 'broadcast_trip_radar'
      : 'direct_assignment';
    const leadDriver = relevantDrivers.find((driver) => driver.id === optimization.recommendedDriverId);

    const riskScore = Math.min(
      100,
      Math.round(
        Number(row.queue_minutes || 0) * 2 +
        Number(row.pressure_ratio || 0) * 18 +
        (row.vip_or_high_value ? 12 : 0) +
        (strategy === 'broadcast_trip_radar' ? 14 : 0),
      ),
    );

    items.push({
      order_id: Number(row.id),
      customer_name: row.customer_name,
      vertical_name: row.vertical_name,
      status: row.status,
      total_amount: Number(row.total_amount || 0),
      queue_minutes: Number(Number(row.queue_minutes || 0).toFixed(2)),
      pressure_ratio: Number(row.pressure_ratio || 0),
      pressure_band: Number(row.pressure_ratio || 0) >= 3 ? 'critical' : Number(row.pressure_ratio || 0) >= 1.8 ? 'elevated' : 'balanced',
      risk_score: riskScore,
      risk_band: riskScore >= 75 ? 'critical' : riskScore >= 50 ? 'elevated' : riskScore >= 30 ? 'watch' : 'stable',
      multi_stop: Boolean(row.multi_stop),
      vip_or_high_value: Boolean(row.vip_or_high_value),
      long_trip_minutes: Number(row.long_trip_minutes || 0),
      optimization: {
        strategy,
        recommended_driver_id: optimization.recommendedDriverId,
        ranked_candidates: optimization.rankedCandidates,
        batching_eligible: optimization.batchingEligible,
        reasoning: optimization.reasoning,
      },
      recommended_driver_id: optimization.recommendedDriverId,
      recommended_driver_name: leadDriver?.name || null,
      operator_reason: optimization.reasoning[0] || 'No recommendation available',
      operator_next_action: riskScore >= 75
        ? 'Prioritize assignment and consider an incentive or operator override.'
        : strategy === 'broadcast_trip_radar'
          ? 'Broadcast to nearby supply and watch conversion closely.'
          : 'Proceed with direct assignment using the lead candidate.',
    });
  }

  return items;
}

export async function getFinanceOperationalInsights() {
  await getDb();
  if (!_pool) return null;

  const [ledgerResult, incentiveResult, settlementResult] = await Promise.all([
    _pool.query<any>(`
      WITH recent AS (
        SELECT * FROM transactions WHERE created_at >= NOW() - INTERVAL '30 days'
      )
      SELECT
        COALESCE(SUM(CASE WHEN type = 'payment' AND status = 'completed' THEN amount::numeric ELSE 0 END), 0) AS captured_revenue,
        COALESCE(SUM(CASE WHEN type IN ('commission', 'fee') AND status <> 'failed' THEN amount::numeric ELSE 0 END), 0) AS platform_fees,
        COALESCE(SUM(CASE WHEN type = 'refund' THEN amount::numeric ELSE 0 END), 0) AS refunds,
        COALESCE(SUM(CASE WHEN type = 'payout' AND status IN ('pending', 'approved') THEN amount::numeric ELSE 0 END), 0) AS payout_exposure,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed_transactions,
        COUNT(*) FILTER (WHERE type = 'refund') AS refund_count
      FROM recent
    `),
    _pool.query<any>(`
      SELECT
        COALESCE(SUM(amount), 0) FILTER (WHERE status = 'pending') AS pending_incentives,
        COALESCE(SUM(amount), 0) FILTER (WHERE status = 'approved') AS approved_incentives,
        COALESCE(SUM(amount), 0) FILTER (WHERE status = 'paid') AS paid_incentives,
        COUNT(*) FILTER (WHERE status = 'pending') AS pending_incentive_count
      FROM driver_incentives
    `),
    _pool.query<any>(`
      SELECT
        COALESCE(SUM(total_amount), 0) FILTER (WHERE status = 'pending') AS pending_settlements,
        COALESCE(SUM(total_amount), 0) FILTER (WHERE status = 'approved') AS approved_settlements,
        COALESCE(SUM(total_amount), 0) FILTER (WHERE status = 'paid') AS paid_settlements
      FROM driver_settlements
    `),
  ]);

  const ledger = ledgerResult.rows[0] || {};
  const incentives = incentiveResult.rows[0] || {};
  const settlements = settlementResult.rows[0] || {};

  const capturedRevenue = Number(ledger.captured_revenue || 0);
  const platformFees = Number(ledger.platform_fees || 0);
  const refunds = Number(ledger.refunds || 0);
  const pendingIncentives = Number(incentives.pending_incentives || 0);
  const approvedIncentives = Number(incentives.approved_incentives || 0);
  const marginAfterLeakage = platformFees - refunds - pendingIncentives - approvedIncentives;
  const leakageRate = platformFees > 0 ? ((refunds + pendingIncentives + approvedIncentives) / platformFees) * 100 : 0;

  return {
    captured_revenue: Number(capturedRevenue.toFixed(2)),
    platform_fees: Number(platformFees.toFixed(2)),
    refunds: Number(refunds.toFixed(2)),
    payout_exposure: Number(Number(ledger.payout_exposure || 0).toFixed(2)),
    failed_transactions: Number(ledger.failed_transactions || 0),
    refund_count: Number(ledger.refund_count || 0),
    pending_incentives: Number(pendingIncentives.toFixed(2)),
    approved_incentives: Number(approvedIncentives.toFixed(2)),
    paid_incentives: Number(Number(incentives.paid_incentives || 0).toFixed(2)),
    pending_incentive_count: Number(incentives.pending_incentive_count || 0),
    pending_settlements: Number(Number(settlements.pending_settlements || 0).toFixed(2)),
    approved_settlements: Number(Number(settlements.approved_settlements || 0).toFixed(2)),
    paid_settlements: Number(Number(settlements.paid_settlements || 0).toFixed(2)),
    margin_after_leakage: Number(marginAfterLeakage.toFixed(2)),
    leakage_rate: Number(leakageRate.toFixed(2)),
    recommended_action: leakageRate >= 45
      ? 'High leakage detected. Review refunds, approve only qualified incentives, and reconcile payout exposure.'
      : leakageRate >= 20
        ? 'Moderate leakage detected. Tighten exception review and monitor refund-heavy cohorts.'
        : 'Marketplace economics are within a manageable range. Continue routine reconciliation.',
  };
}

export async function getSupportTicketContext(ticketId: number) {
  await getDb();
  if (!_pool) return null;

  const ticketResult = await _pool.query<any>(`
    SELECT *
    FROM support_tickets
    WHERE id = $1
    LIMIT 1
  `, [ticketId]);

  const ticket = ticketResult.rows[0];
  if (!ticket) return null;

  const [orderContextResult, transactionContextResult, notificationContextResult, auditContextResult] = await Promise.all([
    ticket.order_id
      ? _pool.query<any>(`
          SELECT
            o.id,
            o.status,
            o.driver_id,
            o.customer_id,
            o.total_amount,
            o.created_at,
            o.updated_at,
            o.notes,
            COALESCE(v.name, CONCAT('Vertical ', o.vertical_id::text)) AS vertical_name
          FROM orders o
          LEFT JOIN service_verticals v ON v.id = o.vertical_id
          WHERE o.id = $1
          LIMIT 1
        `, [ticket.order_id])
      : Promise.resolve({ rows: [] }),
    ticket.order_id
      ? _pool.query<any>(`
          SELECT *
          FROM transactions
          WHERE entity_type = 'order' AND entity_id = $1
          ORDER BY created_at DESC
          LIMIT 6
        `, [ticket.order_id])
      : ticket.customer_id
        ? _pool.query<any>(`
            SELECT *
            FROM transactions
            WHERE entity_type IN ('customer', 'user') AND entity_id = $1
            ORDER BY created_at DESC
            LIMIT 6
          `, [ticket.customer_id])
        : Promise.resolve({ rows: [] }),
    ticket.customer_id
      ? _pool.query<any>(`
          SELECT id, title, message, type, is_read, created_at
          FROM notifications
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT 6
        `, [ticket.customer_id])
      : Promise.resolve({ rows: [] }),
    _pool.query<any>(`
      SELECT id, action, entity, entity_id, changes, created_at
      FROM audit_logs
      WHERE (entity = 'support_ticket' AND entity_id = $1)
         OR (entity = 'order' AND entity_id = COALESCE($2, -1))
      ORDER BY created_at DESC
      LIMIT 10
    `, [ticketId, ticket.order_id ?? null]),
  ]);

  const orderContext = orderContextResult.rows[0] || null;
  const transactionContext = transactionContextResult.rows;
  const refundRisk = transactionContext.some((item: any) => item.type === 'refund' || item.status === 'failed')
    ? 'elevated'
    : ticket.type === 'refund' || ticket.priority === 'critical'
      ? 'watch'
      : 'low';

  return {
    ticket,
    order_context: orderContext,
    transaction_context: transactionContext,
    notification_context: notificationContextResult.rows,
    audit_context: auditContextResult.rows,
    service_risk: {
      refund_risk: refundRisk,
      queue_priority: ticket.priority,
      operator_recommendation: refundRisk === 'elevated'
        ? 'Escalate for finance review and inspect failed or refund-linked ledger entries.'
        : ticket.order_id
          ? 'Use the linked order and notification timeline to resolve the case quickly.'
          : 'Proceed with standard support triage and capture a resolution note.',
    },
  };
}

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
        COALESCE(SUM(total_amount), 0) FILTER (WHERE status = 'pending') AS pending_settlements,
        COALESCE(SUM(total_amount), 0) FILTER (WHERE status = 'approved') AS approved_settlements,
        COALESCE(SUM(total_amount), 0) FILTER (WHERE status = 'paid') AS paid_settlements
      FROM driver_settlements
    `),
    _pool.query<any>(`
      SELECT
        COUNT(*) AS active_campaigns,
        COUNT(*) FILTER (WHERE status IN ('draft', 'paused')) AS queued_campaigns
      FROM marketing_campaigns
    `).catch(() => ({ rows: [{ active_campaigns: 0, queued_campaigns: 0 }] })),
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
  `, [limit]).catch(async () => {
    return await _pool!.query<any>(`
      SELECT
        sp.id,
        sp.business_name,
        sp.status,
        sp.verification_status,
        0::bigint AS order_count,
        0::numeric AS gross_sales,
        0::numeric AS fulfillment_rate
      FROM service_providers sp
      ORDER BY sp.id ASC
      LIMIT $1
    `, [limit]);
  });

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
        COALESCE(SUM(amount), 0) FILTER (WHERE status = 'pending') AS pending_incentives,
        COALESCE(SUM(amount), 0) FILTER (WHERE status = 'approved') AS approved_incentives,
        COALESCE(SUM(amount), 0) FILTER (WHERE status = 'paid') AS paid_incentives
      FROM driver_incentives
    `),
    _pool.query<any>(`
      SELECT
        COALESCE(SUM(total_amount), 0) FILTER (WHERE status = 'pending') AS pending_payouts,
        COALESCE(SUM(total_amount), 0) FILTER (WHERE status = 'approved') AS approved_payouts
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
    `, [limit]).catch(() => ({ rows: [] })),
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
  if (!_pool) return null;

  const [verticalsResult, recentOrdersResult, loyaltyResult, campaignsResult, membershipStatsResult, reviewStatsResult, membershipsResult, reviewsResult, trackingResult] = await Promise.all([
    _pool.query<any>(`
      SELECT id, name, description
      FROM service_verticals
      ORDER BY id ASC
      LIMIT $1
    `, [limit]).catch(() => ({ rows: [] })),
    _pool.query<any>(`
      SELECT id, status, total_amount, created_at, updated_at
      FROM orders
      ORDER BY created_at DESC
      LIMIT $1
    `, [limit]).catch(() => ({ rows: [] })),
    _pool.query<any>(`
      SELECT
        COUNT(*) AS active_rewards,
        COALESCE(AVG(points_required), 0) AS avg_points_required
      FROM loyalty_rewards
      WHERE is_active = TRUE
    `).catch(() => ({ rows: [{ active_rewards: 0, avg_points_required: 0 }] })),
    _pool.query<any>(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'active') AS active_campaigns,
        COUNT(*) FILTER (WHERE status = 'draft') AS draft_campaigns
      FROM marketing_campaigns
    `).catch(() => ({ rows: [{ active_campaigns: 0, draft_campaigns: 0 }] })),
    _pool.query<any>(`
      SELECT
        COUNT(*) FILTER (WHERE cm.status = 'active') AS active_memberships,
        COALESCE(AVG(mp.monthly_price), 0) AS avg_membership_price,
        COALESCE(SUM(cm.savings_ytd), 0) AS savings_ytd
      FROM consumer_memberships cm
      LEFT JOIN membership_plans mp ON mp.id = cm.plan_id
    `).catch(() => ({ rows: [{ active_memberships: 0, avg_membership_price: 0, savings_ytd: 0 }] })),
    _pool.query<any>(`
      SELECT
        COUNT(*) AS review_count,
        COALESCE(AVG(rating), 0) AS avg_rating
      FROM consumer_reviews
    `).catch(() => ({ rows: [{ review_count: 0, avg_rating: 0 }] })),
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
    `).catch(() => ({ rows: [] })),
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
    `, [limit]).catch(() => ({ rows: [] })),
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
    `).catch(() => ({ rows: [] })),
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
      membership_savings_ytd: Number(Number(membershipStats.savings_ytd || 0).toFixed(2)),
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
    `, [limit]).catch(() => ({ rows: [] })),
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
    `).catch(() => ({ rows: [{ active_campaigns: 0, queued_campaigns: 0 }] })),
    _pool.query<any>(`
      SELECT
        COUNT(*) AS loyalty_events
      FROM loyalty_transactions
    `).catch(() => ({ rows: [{ loyalty_events: 0 }] })),
    _pool.query<any>(`
      SELECT experiment_key, experiment_name, target_surface, primary_metric, rollout_percentage, status, guardrails, owner, updated_at
      FROM experiment_rollouts
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 8
    `).catch(() => ({ rows: [] })),
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
  if (!_pool) return null;
  const [membershipResult, rewardsResult, orderResult, merchantResult, transactionResult] = await Promise.all([
    _pool.query<any>(`
      SELECT plan_name, status, monthly_price, cashback_rate, delivery_fee_discount, savings_ytd, renewal_at
      FROM consumer_memberships
      ORDER BY renewal_at ASC NULLS LAST
      LIMIT $1
    `, [limit]).catch(() => ({ rows: [] })),
    _pool.query<any>(`
      SELECT reward_name, points_required, reward_value, status, expires_at
      FROM loyalty_rewards
      ORDER BY points_required ASC, expires_at ASC NULLS LAST
      LIMIT $1
    `, [limit]).catch(() => ({ rows: [] })),
    _pool.query<any>(`
      SELECT id, status, total_amount, updated_at, delivery_address, estimated_delivery_time, actual_delivery_time, service_provider_id
      FROM orders
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT $1
    `, [Math.max(limit, 8)]).catch(() => ({ rows: [] })),
    _pool.query<any>(`
      SELECT id, name, category, rating, status
      FROM service_providers
      ORDER BY rating DESC NULLS LAST, name ASC
      LIMIT $1
    `, [Math.max(limit, 8)]).catch(() => ({ rows: [] })),
    _pool.query<any>(`
      SELECT type, status, amount, created_at
      FROM transactions
      WHERE type IN ('payment', 'refund', 'chargeback')
      ORDER BY created_at DESC NULLS LAST
      LIMIT $1
    `, [Math.max(limit, 10)]).catch(() => ({ rows: [] })),
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
    `, [Math.max(limit, 10)]).catch(() => ({ rows: [] })),
    _pool.query<any>(`
      SELECT id, name, category, rating, status
      FROM service_providers
      ORDER BY rating DESC NULLS LAST, completed_services DESC NULLS LAST, name ASC
      LIMIT $1
    `, [Math.max(limit, 10)]).catch(() => ({ rows: [] })),
    _pool.query<any>(`
      SELECT service_provider_id, status, total_amount, created_at
      FROM orders
      ORDER BY created_at DESC NULLS LAST
      LIMIT 100
    `).catch(() => ({ rows: [] })),
    _pool.query<any>(`
      SELECT points, type, created_at
      FROM loyalty_transactions
      ORDER BY created_at DESC NULLS LAST
      LIMIT 100
    `).catch(() => ({ rows: [] })),
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
    `, [Math.max(limit, 12)]).catch(() => ({ rows: [] })),
    _pool.query<any>(`
      SELECT id, status, total_amount, estimated_delivery_time, actual_delivery_time, pickup_address, delivery_address
      FROM orders
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT $1
    `, [Math.max(limit, 12)]).catch(() => ({ rows: [] })),
    _pool.query<any>(`
      SELECT incentive_type, amount, status, created_at
      FROM driver_incentives
      ORDER BY created_at DESC NULLS LAST
      LIMIT $1
    `, [Math.max(limit, 12)]).catch(() => ({ rows: [] })),
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

async function ensureMultiVerticalCommerceTables() {
  await getDb();
  if (!_pool) return;

  await _pool.query(`
    CREATE TABLE IF NOT EXISTS vertical_service_templates (
      id SERIAL PRIMARY KEY,
      vertical_id INTEGER REFERENCES service_verticals(id) ON DELETE SET NULL,
      template_key VARCHAR(80) NOT NULL UNIQUE,
      template_name VARCHAR(160) NOT NULL,
      fulfillment_mode VARCHAR(32) NOT NULL DEFAULT 'pickup_dropoff',
      pricing_model VARCHAR(32) NOT NULL DEFAULT 'fixed_plus_distance',
      intake_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
      default_sla_hours INTEGER NOT NULL DEFAULT 24,
      compliance_notes TEXT,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS provider_catalog_items (
      id SERIAL PRIMARY KEY,
      provider_id INTEGER REFERENCES service_providers(id) ON DELETE CASCADE,
      vertical_id INTEGER REFERENCES service_verticals(id) ON DELETE SET NULL,
      item_type VARCHAR(32) NOT NULL DEFAULT 'service',
      item_name VARCHAR(160) NOT NULL,
      sku VARCHAR(80),
      description TEXT,
      base_price NUMERIC(10,2) NOT NULL DEFAULT 0,
      currency VARCHAR(8) NOT NULL DEFAULT 'USD',
      turnaround_hours INTEGER NOT NULL DEFAULT 24,
      is_active BOOLEAN NOT NULL DEFAULT true,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS provider_onboarding_requests (
      id SERIAL PRIMARY KEY,
      vertical_id INTEGER REFERENCES service_verticals(id) ON DELETE SET NULL,
      provider_id INTEGER REFERENCES service_providers(id) ON DELETE SET NULL,
      company_name VARCHAR(160) NOT NULL,
      contact_name VARCHAR(160) NOT NULL,
      email VARCHAR(160) NOT NULL,
      phone VARCHAR(64),
      operating_model VARCHAR(32) NOT NULL DEFAULT 'merchant_fulfilled',
      footprint VARCHAR(32) NOT NULL DEFAULT 'single_city',
      status VARCHAR(32) NOT NULL DEFAULT 'submitted',
      requested_go_live_at TIMESTAMPTZ,
      notes TEXT,
      requirements JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS customer_service_intake_templates (
      id SERIAL PRIMARY KEY,
      vertical_id INTEGER REFERENCES service_verticals(id) ON DELETE SET NULL,
      template_name VARCHAR(160) NOT NULL,
      customer_prompt TEXT NOT NULL,
      fields JSONB NOT NULL DEFAULT '[]'::jsonb,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_vertical_service_templates_vertical_id ON vertical_service_templates(vertical_id);
    CREATE INDEX IF NOT EXISTS idx_provider_catalog_items_provider_id ON provider_catalog_items(provider_id);
    CREATE INDEX IF NOT EXISTS idx_provider_catalog_items_vertical_id ON provider_catalog_items(vertical_id);
    CREATE INDEX IF NOT EXISTS idx_provider_onboarding_requests_status ON provider_onboarding_requests(status);
    CREATE INDEX IF NOT EXISTS idx_customer_service_intake_templates_vertical_id ON customer_service_intake_templates(vertical_id);
  `);

  await _pool.query(`
    INSERT INTO vertical_service_templates (vertical_id, template_key, template_name, fulfillment_mode, pricing_model, intake_fields, default_sla_hours, compliance_notes, is_active)
    SELECT
      v.id,
      CONCAT(LOWER(REPLACE(v.name, ' ', '_')), '_starter'),
      CONCAT(v.name, ' Starter Template'),
      CASE
        WHEN LOWER(v.name) LIKE '%ride%' OR LOWER(v.name) LIKE '%transport%' THEN 'point_to_point'
        WHEN LOWER(v.name) LIKE '%laundry%' OR LOWER(v.name) LIKE '%dry%' OR LOWER(v.name) LIKE '%clean%' THEN 'pickup_process_dropoff'
        ELSE 'pickup_dropoff'
      END,
      CASE
        WHEN LOWER(v.name) LIKE '%laundry%' OR LOWER(v.name) LIKE '%dry%' OR LOWER(v.name) LIKE '%clean%' THEN 'per_bag_plus_extras'
        WHEN LOWER(v.name) LIKE '%grocery%' OR LOWER(v.name) LIKE '%retail%' THEN 'basket_plus_distance'
        ELSE 'fixed_plus_distance'
      END,
      CASE
        WHEN LOWER(v.name) LIKE '%laundry%' OR LOWER(v.name) LIKE '%dry%' OR LOWER(v.name) LIKE '%clean%'
          THEN '["garment type", "pickup window", "stain treatment", "special instructions"]'::jsonb
        WHEN LOWER(v.name) LIKE '%pharmacy%'
          THEN '["prescription id", "pickup window", "delivery notes", "contactless preference"]'::jsonb
        ELSE '["pickup window", "delivery window", "special instructions", "contact preference"]'::jsonb
      END,
      CASE
        WHEN LOWER(v.name) LIKE '%laundry%' OR LOWER(v.name) LIKE '%dry%' OR LOWER(v.name) LIKE '%clean%' THEN 48
        ELSE 24
      END,
      CONCAT('Provisioned for ', v.name, ' operations with editable intake, SLA, and pricing defaults.'),
      true
    FROM service_verticals v
    WHERE NOT EXISTS (
      SELECT 1 FROM vertical_service_templates t WHERE t.vertical_id = v.id
    );

    INSERT INTO customer_service_intake_templates (vertical_id, template_name, customer_prompt, fields, is_active)
    SELECT
      v.id,
      CONCAT(v.name, ' Intake'),
      CONCAT('Collect the essential intake details required to fulfill a ', v.name, ' order end to end.'),
      CASE
        WHEN LOWER(v.name) LIKE '%laundry%' OR LOWER(v.name) LIKE '%dry%' OR LOWER(v.name) LIKE '%clean%'
          THEN '[{"key":"garment_count","label":"Garment count","type":"number"},{"key":"service_level","label":"Service level","type":"select"},{"key":"pickup_window","label":"Pickup window","type":"datetime"},{"key":"dropoff_window","label":"Drop-off window","type":"datetime"}]'::jsonb
        ELSE '[{"key":"pickup_window","label":"Pickup window","type":"datetime"},{"key":"dropoff_window","label":"Drop-off window","type":"datetime"},{"key":"special_instructions","label":"Special instructions","type":"textarea"}]'::jsonb
      END,
      true
    FROM service_verticals v
    WHERE NOT EXISTS (
      SELECT 1 FROM customer_service_intake_templates i WHERE i.vertical_id = v.id
    );

    INSERT INTO provider_catalog_items (provider_id, vertical_id, item_type, item_name, sku, description, base_price, currency, turnaround_hours, is_active, metadata)
    SELECT
      sp.id,
      sp.vertical_id,
      'service',
      CASE
        WHEN LOWER(COALESCE(v.name, '')) LIKE '%laundry%' OR LOWER(COALESCE(v.name, '')) LIKE '%dry%' OR LOWER(COALESCE(v.name, '')) LIKE '%clean%'
          THEN 'Wash & Fold Pickup'
        WHEN LOWER(COALESCE(v.name, '')) LIKE '%retail%'
          THEN 'Same-Day Retail Delivery'
        ELSE CONCAT(COALESCE(v.name, 'General'), ' Standard Service')
      END,
      CONCAT('SKU-', sp.id, '-1'),
      CONCAT('Seed catalog item for ', sp.business_name),
      COALESCE(sp.commission_rate::numeric, 15) + 9.99,
      'USD',
      CASE
        WHEN LOWER(COALESCE(v.name, '')) LIKE '%laundry%' OR LOWER(COALESCE(v.name, '')) LIKE '%dry%' OR LOWER(COALESCE(v.name, '')) LIKE '%clean%' THEN 48
        ELSE 24
      END,
      true,
      jsonb_build_object('provider_status', sp.status, 'verification_status', sp.verification_status)
    FROM service_providers sp
    LEFT JOIN service_verticals v ON v.id = sp.vertical_id
    WHERE NOT EXISTS (
      SELECT 1 FROM provider_catalog_items pci WHERE pci.provider_id = sp.id
    )
    LIMIT 200;

    INSERT INTO provider_onboarding_requests (vertical_id, provider_id, company_name, contact_name, email, phone, operating_model, footprint, status, requested_go_live_at, notes, requirements)
    SELECT
      sp.vertical_id,
      sp.id,
      sp.business_name,
      sp.name,
      sp.email,
      sp.phone,
      CASE WHEN sp.status = 'active' THEN 'switchos_fulfilled' ELSE 'merchant_fulfilled' END,
      CASE WHEN sp.rating::numeric >= 4.5 THEN 'regional' ELSE 'single_city' END,
      CASE
        WHEN sp.verification_status = 'verified' AND sp.status = 'active' THEN 'approved'
        WHEN sp.verification_status = 'pending' THEN 'review'
        ELSE 'submitted'
      END,
      NOW() + ((sp.id % 10) + 1) * INTERVAL '1 day',
      CONCAT('Autogenerated onboarding pipeline record for ', sp.business_name),
      jsonb_build_array('tax profile', 'bank settlement', 'catalog import', 'service-area validation')
    FROM service_providers sp
    WHERE NOT EXISTS (
      SELECT 1 FROM provider_onboarding_requests por WHERE por.provider_id = sp.id
    )
    LIMIT 200;
  `).catch(() => undefined);
}

export async function getVerticalServiceTemplates() {
  await ensureMultiVerticalCommerceTables();
  if (!_pool) return [];
  const result = await _pool.query<any>(`
    SELECT t.*, v.name AS vertical_name
    FROM vertical_service_templates t
    LEFT JOIN service_verticals v ON v.id = t.vertical_id
    ORDER BY t.updated_at DESC, t.id DESC
  `).catch(() => ({ rows: [] }));
  return result.rows.map((row: any) => ({
    id: Number(row.id),
    vertical_id: row.vertical_id ? Number(row.vertical_id) : null,
    vertical_name: row.vertical_name,
    template_key: row.template_key,
    template_name: row.template_name,
    fulfillment_mode: row.fulfillment_mode,
    pricing_model: row.pricing_model,
    intake_fields: Array.isArray(row.intake_fields) ? row.intake_fields : [],
    default_sla_hours: Number(row.default_sla_hours || 0),
    compliance_notes: row.compliance_notes,
    is_active: Boolean(row.is_active),
    updated_at: row.updated_at,
  }));
}

export async function createVerticalServiceTemplate(input: {
  verticalId?: number | null;
  templateKey: string;
  templateName: string;
  fulfillmentMode?: string;
  pricingModel?: string;
  intakeFields?: string[];
  defaultSlaHours?: number;
  complianceNotes?: string | null;
  isActive?: boolean;
}) {
  await ensureMultiVerticalCommerceTables();
  if (!_pool) return null;
  const result = await _pool.query<any>(`
    INSERT INTO vertical_service_templates (
      vertical_id, template_key, template_name, fulfillment_mode, pricing_model, intake_fields, default_sla_hours, compliance_notes, is_active
    ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)
    RETURNING *
  `, [
    input.verticalId ?? null,
    input.templateKey,
    input.templateName,
    input.fulfillmentMode || 'pickup_dropoff',
    input.pricingModel || 'fixed_plus_distance',
    JSON.stringify(input.intakeFields || []),
    input.defaultSlaHours || 24,
    input.complianceNotes || null,
    input.isActive ?? true,
  ]).catch(() => ({ rows: [] }));
  return result.rows[0] || null;
}

export async function getProviderCatalogItems(filters?: { providerId?: number; verticalId?: number; search?: string; }) {
  await ensureMultiVerticalCommerceTables();
  if (!_pool) return [];
  const values: any[] = [];
  const conditions: string[] = [];
  if (filters?.providerId) {
    values.push(filters.providerId);
    conditions.push(`pci.provider_id = $${values.length}`);
  }
  if (filters?.verticalId) {
    values.push(filters.verticalId);
    conditions.push(`pci.vertical_id = $${values.length}`);
  }
  if (filters?.search) {
    values.push(`%${filters.search}%`);
    conditions.push(`(pci.item_name ILIKE $${values.length} OR COALESCE(pci.description, '') ILIKE $${values.length} OR COALESCE(sp.business_name, '') ILIKE $${values.length})`);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await _pool.query<any>(`
    SELECT pci.*, sp.business_name, v.name AS vertical_name
    FROM provider_catalog_items pci
    LEFT JOIN service_providers sp ON sp.id = pci.provider_id
    LEFT JOIN service_verticals v ON v.id = pci.vertical_id
    ${whereClause}
    ORDER BY pci.updated_at DESC, pci.id DESC
    LIMIT 300
  `, values).catch(() => ({ rows: [] }));
  return result.rows.map((row: any) => ({
    id: Number(row.id),
    provider_id: row.provider_id ? Number(row.provider_id) : null,
    provider_name: row.business_name,
    vertical_id: row.vertical_id ? Number(row.vertical_id) : null,
    vertical_name: row.vertical_name,
    item_type: row.item_type,
    item_name: row.item_name,
    sku: row.sku,
    description: row.description,
    base_price: Number(Number(row.base_price || 0).toFixed(2)),
    currency: row.currency,
    turnaround_hours: Number(row.turnaround_hours || 0),
    is_active: Boolean(row.is_active),
    metadata: row.metadata || {},
  }));
}

export async function createProviderCatalogItem(input: {
  providerId?: number | null;
  verticalId?: number | null;
  itemType?: string;
  itemName: string;
  sku?: string | null;
  description?: string | null;
  basePrice?: number;
  currency?: string;
  turnaroundHours?: number;
  isActive?: boolean;
  metadata?: Record<string, any>;
}) {
  await ensureMultiVerticalCommerceTables();
  if (!_pool) return null;
  const result = await _pool.query<any>(`
    INSERT INTO provider_catalog_items (
      provider_id, vertical_id, item_type, item_name, sku, description, base_price, currency, turnaround_hours, is_active, metadata
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
    RETURNING *
  `, [
    input.providerId ?? null,
    input.verticalId ?? null,
    input.itemType || 'service',
    input.itemName,
    input.sku || null,
    input.description || null,
    input.basePrice ?? 0,
    input.currency || 'USD',
    input.turnaroundHours || 24,
    input.isActive ?? true,
    JSON.stringify(input.metadata || {}),
  ]).catch(() => ({ rows: [] }));
  return result.rows[0] || null;
}

export async function getProviderOnboardingPipeline() {
  await ensureMultiVerticalCommerceTables();
  if (!_pool) return { summary: { submitted: 0, review: 0, approved: 0, switchos_fulfilled: 0 }, requests: [] };
  const result = await _pool.query<any>(`
    SELECT por.*, v.name AS vertical_name, sp.business_name AS provider_name
    FROM provider_onboarding_requests por
    LEFT JOIN service_verticals v ON v.id = por.vertical_id
    LEFT JOIN service_providers sp ON sp.id = por.provider_id
    ORDER BY por.updated_at DESC, por.id DESC
    LIMIT 200
  `).catch(() => ({ rows: [] }));
  const requests = result.rows.map((row: any) => ({
    id: Number(row.id),
    vertical_id: row.vertical_id ? Number(row.vertical_id) : null,
    vertical_name: row.vertical_name,
    provider_id: row.provider_id ? Number(row.provider_id) : null,
    provider_name: row.provider_name,
    company_name: row.company_name,
    contact_name: row.contact_name,
    email: row.email,
    phone: row.phone,
    operating_model: row.operating_model,
    footprint: row.footprint,
    status: row.status,
    requested_go_live_at: row.requested_go_live_at,
    notes: row.notes,
    requirements: Array.isArray(row.requirements) ? row.requirements : [],
  }));
  return {
    summary: {
      submitted: requests.filter((row: any) => row.status === 'submitted').length,
      review: requests.filter((row: any) => row.status === 'review').length,
      approved: requests.filter((row: any) => row.status === 'approved').length,
      switchos_fulfilled: requests.filter((row: any) => row.operating_model === 'switchos_fulfilled').length,
    },
    requests,
  };
}

export async function createProviderOnboardingRequest(input: {
  verticalId?: number | null;
  providerId?: number | null;
  companyName: string;
  contactName: string;
  email: string;
  phone?: string | null;
  operatingModel?: string;
  footprint?: string;
  status?: string;
  requestedGoLiveAt?: string | null;
  notes?: string | null;
  requirements?: string[];
}) {
  await ensureMultiVerticalCommerceTables();
  if (!_pool) return null;
  const result = await _pool.query<any>(`
    INSERT INTO provider_onboarding_requests (
      vertical_id, provider_id, company_name, contact_name, email, phone, operating_model, footprint, status, requested_go_live_at, notes, requirements
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
    RETURNING *
  `, [
    input.verticalId ?? null,
    input.providerId ?? null,
    input.companyName,
    input.contactName,
    input.email,
    input.phone || null,
    input.operatingModel || 'merchant_fulfilled',
    input.footprint || 'single_city',
    input.status || 'submitted',
    input.requestedGoLiveAt || null,
    input.notes || null,
    JSON.stringify(input.requirements || []),
  ]).catch(() => ({ rows: [] }));
  return result.rows[0] || null;
}

export async function getMultiVerticalCommerceSummary() {
  await ensureMultiVerticalCommerceTables();
  if (!_pool) {
    return {
      summary: {
        active_verticals: 0,
        active_templates: 0,
        active_catalog_items: 0,
        onboarding_pipeline: 0,
      },
      vertical_templates: [],
      intake_templates: [],
      featured_catalog: [],
      onboarding_pipeline: [],
    };
  }

  const [verticalsResult, templateResult, intakeResult, catalogResult, onboardingResult] = await Promise.all([
    _pool.query<any>(`SELECT id, name, description FROM service_verticals ORDER BY id ASC`).catch(() => ({ rows: [] })),
    _pool.query<any>(`SELECT t.id, t.template_name, t.fulfillment_mode, t.pricing_model, t.default_sla_hours, v.name AS vertical_name FROM vertical_service_templates t LEFT JOIN service_verticals v ON v.id = t.vertical_id WHERE t.is_active = true ORDER BY t.updated_at DESC LIMIT 12`).catch(() => ({ rows: [] })),
    _pool.query<any>(`SELECT i.id, i.template_name, i.customer_prompt, v.name AS vertical_name FROM customer_service_intake_templates i LEFT JOIN service_verticals v ON v.id = i.vertical_id WHERE i.is_active = true ORDER BY i.updated_at DESC LIMIT 12`).catch(() => ({ rows: [] })),
    _pool.query<any>(`SELECT pci.id, pci.item_name, pci.item_type, pci.base_price, pci.turnaround_hours, sp.business_name, v.name AS vertical_name FROM provider_catalog_items pci LEFT JOIN service_providers sp ON sp.id = pci.provider_id LEFT JOIN service_verticals v ON v.id = pci.vertical_id WHERE pci.is_active = true ORDER BY pci.updated_at DESC LIMIT 12`).catch(() => ({ rows: [] })),
    _pool.query<any>(`SELECT por.id, por.company_name, por.status, por.operating_model, por.footprint, v.name AS vertical_name FROM provider_onboarding_requests por LEFT JOIN service_verticals v ON v.id = por.vertical_id ORDER BY por.updated_at DESC LIMIT 12`).catch(() => ({ rows: [] })),
  ]);

  return {
    summary: {
      active_verticals: verticalsResult.rows.length,
      active_templates: templateResult.rows.length,
      active_catalog_items: catalogResult.rows.length,
      onboarding_pipeline: onboardingResult.rows.length,
    },
    vertical_templates: templateResult.rows.map((row: any) => ({
      id: Number(row.id),
      template_name: row.template_name,
      vertical_name: row.vertical_name,
      fulfillment_mode: row.fulfillment_mode,
      pricing_model: row.pricing_model,
      default_sla_hours: Number(row.default_sla_hours || 0),
    })),
    intake_templates: intakeResult.rows.map((row: any) => ({
      id: Number(row.id),
      template_name: row.template_name,
      vertical_name: row.vertical_name,
      customer_prompt: row.customer_prompt,
    })),
    featured_catalog: catalogResult.rows.map((row: any) => ({
      id: Number(row.id),
      item_name: row.item_name,
      item_type: row.item_type,
      base_price: Number(Number(row.base_price || 0).toFixed(2)),
      turnaround_hours: Number(row.turnaround_hours || 0),
      provider_name: row.business_name,
      vertical_name: row.vertical_name,
    })),
    onboarding_pipeline: onboardingResult.rows.map((row: any) => ({
      id: Number(row.id),
      company_name: row.company_name,
      status: row.status,
      operating_model: row.operating_model,
      footprint: row.footprint,
      vertical_name: row.vertical_name,
    })),
  };
}

export async function getMobilityOverviewSummary(limit = 8) {
  await getDb();
  if (!_pool) return null;

  const [orderResult, driverResult, providerResult] = await Promise.all([
    _pool.query<any>(`
      SELECT id, status, total_amount, estimated_delivery_time, created_at, updated_at
      FROM orders
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT $1
    `, [Math.max(limit, 12)]).catch(() => ({ rows: [] })),
    _pool.query<any>(`
      SELECT id, name, status, rating, acceptance_rate, completion_rate
      FROM drivers
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT $1
    `, [Math.max(limit, 12)]).catch(() => ({ rows: [] })),
    _pool.query<any>(`
      SELECT id, business_name, category, status, verification_status, rating
      FROM service_providers
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT $1
    `, [Math.max(limit, 12)]).catch(() => ({ rows: [] })),
  ]);

  const activeTrips = orderResult.rows.filter((row: any) => ['assigned', 'accepted', 'picked_up', 'in_transit', 'en_route'].includes(String(row.status || '').toLowerCase())).length;
  const activeDrivers = driverResult.rows.filter((row: any) => ['active', 'online', 'available'].includes(String(row.status || '').toLowerCase())).length;
  const activeProviders = providerResult.rows.filter((row: any) => String(row.status || '').toLowerCase() === 'active').length;

  return {
    summary: {
      active_trips: activeTrips,
      active_drivers: activeDrivers,
      active_providers: activeProviders,
      airport_ready_zones: Math.max(2, Math.min(6, activeProviders || 2)),
      multimodal_modes: 5,
      business_accounts: Math.max(4, Math.round((activeProviders + activeDrivers) / 2) || 4),
      recommended_action: 'Coordinate ride, courier, airport, and enterprise mobility programs from one dispatch layer with live pricing, support, and service recovery orchestration.',
    },
    live_trips: orderResult.rows.slice(0, limit).map((row: any) => ({
      id: Number(row.id),
      trip_type: Number(row.id || 0) % 4 === 0 ? 'airport' : Number(row.id || 0) % 3 === 0 ? 'business' : Number(row.id || 0) % 2 === 0 ? 'healthcare' : 'standard',
      status: row.status,
      fare: Number(Number(row.total_amount || 0).toFixed(2)),
      eta_minutes: 8 + (Number(row.id || 0) % 6) * 4,
      modality: Number(row.id || 0) % 5 === 0 ? 'scooter' : Number(row.id || 0) % 4 === 0 ? 'transit_connect' : 'car',
      created_at: row.created_at,
    })),
    mobility_supply: driverResult.rows.slice(0, limit).map((row: any) => ({
      id: Number(row.id),
      name: row.name,
      status: row.status,
      vehicle_class: Number(row.id || 0) % 4 === 0 ? 'xl' : Number(row.id || 0) % 3 === 0 ? 'comfort' : 'standard',
      acceptance_rate: Number(Number(row.acceptance_rate || 78).toFixed(1)),
      completion_rate: Number(Number(row.completion_rate || 92).toFixed(1)),
      airport_certified: Number(row.id || 0) % 3 === 0,
    })),
    service_modes: [
      'Rideshare',
      'Courier',
      'Airport transfers',
      'Business transport',
      'Healthcare transportation',
      'Transit connections',
    ],
  };
}

export async function getRiderAppSummary(limit = 6) {
  await getDb();
  if (!_pool) return null;

  const [orderResult, providerResult] = await Promise.all([
    _pool.query<any>(`
      SELECT id, status, total_amount, delivery_address, created_at
      FROM orders
      ORDER BY created_at DESC NULLS LAST
      LIMIT $1
    `, [Math.max(limit, 10)]).catch(() => ({ rows: [] })),
    _pool.query<any>(`
      SELECT id, business_name, category, rating
      FROM service_providers
      ORDER BY rating DESC NULLS LAST, business_name ASC
      LIMIT $1
    `, [Math.max(limit, 10)]).catch(() => ({ rows: [] })),
  ]);

  return {
    summary: {
      saved_places: 5,
      active_promotions: 4,
      membership_benefits: 6,
      support_threads: Math.max(2, Math.floor(orderResult.rows.length / 2)),
      recommended_next_step: 'Unify ride booking, delivery ordering, loyalty, and support recovery in one rider-facing experience.',
    },
    booking_modes: [
      { key: 'rideshare', label: 'Book a ride', eta_minutes: 4 },
      { key: 'delivery', label: 'Order delivery', eta_minutes: 24 },
      { key: 'airport', label: 'Reserve airport pickup', eta_minutes: 12 },
      { key: 'healthcare', label: 'Schedule a care trip', eta_minutes: 35 },
      { key: 'business', label: 'Request business travel', eta_minutes: 9 },
      { key: 'transit', label: 'Plan transit connection', eta_minutes: 6 },
    ],
    recent_activity: orderResult.rows.slice(0, limit).map((row: any) => ({
      id: Number(row.id),
      status: row.status,
      address: row.delivery_address,
      amount: Number(Number(row.total_amount || 0).toFixed(2)),
      experience_type: Number(row.id || 0) % 2 === 0 ? 'delivery' : 'mobility',
      created_at: row.created_at,
    })),
    suggested_destinations: providerResult.rows.slice(0, limit).map((row: any) => ({
      id: Number(row.id),
      label: row.business_name,
      category: row.category,
      rating: Number(Number(row.rating || 0).toFixed(1)),
    })),
  };
}

export async function getDriverMobilitySummary(limit = 8) {
  await getDb();
  if (!_pool) return null;

  const [driverResult, orderResult] = await Promise.all([
    _pool.query<any>(`
      SELECT id, name, status, rating, acceptance_rate, completion_rate, total_earnings
      FROM drivers
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT $1
    `, [Math.max(limit, 12)]).catch(() => ({ rows: [] })),
    _pool.query<any>(`
      SELECT id, status, total_amount, created_at
      FROM orders
      ORDER BY created_at DESC NULLS LAST
      LIMIT 80
    `).catch(() => ({ rows: [] })),
  ]);

  return {
    summary: {
      online_drivers: driverResult.rows.filter((row: any) => ['active', 'online', 'available'].includes(String(row.status || '').toLowerCase())).length,
      trip_radar_candidates: Math.max(3, Math.round(orderResult.rows.length / 8) || 3),
      airport_ready_drivers: driverResult.rows.filter((row: any) => Number(row.id || 0) % 3 === 0).length,
      avg_weekly_earnings: driverResult.rows.length
        ? Number((driverResult.rows.reduce((acc: number, row: any) => acc + Number(row.total_earnings || 0), 0) / driverResult.rows.length).toFixed(2))
        : 0,
      recommended_action: 'Blend passenger trips, courier trips, airport runs, and scheduled healthcare work into one driver earnings stack.',
    },
    supply_queue: driverResult.rows.slice(0, limit).map((row: any) => ({
      id: Number(row.id),
      name: row.name,
      status: row.status,
      mobility_mode: Number(row.id || 0) % 4 === 0 ? 'airport' : Number(row.id || 0) % 3 === 0 ? 'healthcare' : Number(row.id || 0) % 2 === 0 ? 'courier' : 'rideshare',
      rating: Number(Number(row.rating || 4.6).toFixed(2)),
      acceptance_rate: Number(Number(row.acceptance_rate || 80).toFixed(1)),
      completion_rate: Number(Number(row.completion_rate || 93).toFixed(1)),
      earnings_today: Number((40 + (Number(row.id || 0) % 7) * 18.5).toFixed(2)),
    })),
    earning_streams: [
      'Passenger rides',
      'Food and retail delivery',
      'Airport transfers',
      'Healthcare transport',
      'Business travel',
      'Large-item assisted delivery',
    ],
  };
}

export async function getBusinessTravelSummary(limit = 8) {
  await getDb();
  if (!_pool) return null;

  const [userResult, orderResult] = await Promise.all([
    _pool.query<any>(`
      SELECT id, name, email, role, created_at
      FROM users
      ORDER BY created_at DESC NULLS LAST
      LIMIT $1
    `, [Math.max(limit, 12)]).catch(() => ({ rows: [] })),
    _pool.query<any>(`
      SELECT id, status, total_amount, created_at
      FROM orders
      ORDER BY created_at DESC NULLS LAST
      LIMIT 100
    `).catch(() => ({ rows: [] })),
  ]);

  const travelPolicies = [
    'Airport and executive ride class caps',
    'Meals and delivery spend thresholds',
    'Scheduled healthcare and guest travel approvals',
    'Cost-center routing and expensing rules',
  ];

  return {
    summary: {
      enterprise_accounts: Math.max(6, Math.round(userResult.rows.length / 2) || 6),
      active_travelers: Math.max(10, userResult.rows.length),
      open_expense_items: Math.max(3, Math.round(orderResult.rows.length / 10) || 3),
      policy_templates: travelPolicies.length,
      recommended_action: 'Consolidate employee rides, meals, guest trips, airport transfers, and policy controls under one enterprise travel program.',
    },
    travel_programs: [
      { id: 1, name: 'Executive Mobility', approval_mode: 'auto-with-cap', service_mix: 'airport, comfort, business meals' },
      { id: 2, name: 'Field Operations', approval_mode: 'manager-review', service_mix: 'courier, warehouse transfers, shift rides' },
      { id: 3, name: 'Clinical Access', approval_mode: 'care-coordinator', service_mix: 'healthcare transport, pharmacy, caregiver meals' },
    ],
    travelers: userResult.rows.slice(0, limit).map((row: any) => ({
      id: Number(row.id),
      name: row.name,
      email: row.email,
      role: row.role,
      spend_ytd: Number((220 + (Number(row.id || 0) % 8) * 160.25).toFixed(2)),
      compliance_state: Number(row.id || 0) % 4 === 0 ? 'review' : 'in_policy',
    })),
    policy_templates: travelPolicies,
  };
}

export async function getFreightSummary(limit = 8) {
  await getDb();
  if (!_pool) return null;

  const [providerResult, orderResult] = await Promise.all([
    _pool.query<any>(`
      SELECT id, business_name, category, status, verification_status
      FROM service_providers
      ORDER BY created_at DESC NULLS LAST
      LIMIT $1
    `, [Math.max(limit, 12)]).catch(() => ({ rows: [] })),
    _pool.query<any>(`
      SELECT id, status, total_amount, created_at, delivery_address
      FROM orders
      ORDER BY created_at DESC NULLS LAST
      LIMIT 120
    `).catch(() => ({ rows: [] })),
  ]);

  return {
    summary: {
      shipper_accounts: Math.max(5, Math.round(providerResult.rows.length / 2) || 5),
      carrier_lanes: Math.max(7, Math.round(orderResult.rows.length / 9) || 7),
      active_loads: Math.max(4, orderResult.rows.filter((row: any) => ['assigned', 'picked_up', 'in_transit'].includes(String(row.status || '').toLowerCase())).length),
      procurement_events: 6,
      recommended_action: 'Coordinate shippers, carriers, lane pricing, appointment windows, and exception handling from one freight control tower.',
    },
    load_board: orderResult.rows.slice(0, limit).map((row: any) => ({
      id: Number(row.id),
      lane: `Lane ${100 + Number(row.id || 0)}`,
      status: row.status,
      value: Number(Number(row.total_amount || 0).toFixed(2)),
      equipment: Number(row.id || 0) % 3 === 0 ? 'reefer' : Number(row.id || 0) % 2 === 0 ? 'sprinter' : 'box_truck',
      address: row.delivery_address,
    })),
    carrier_network: providerResult.rows.slice(0, limit).map((row: any) => ({
      id: Number(row.id),
      name: row.business_name,
      category: row.category,
      status: row.status,
      verification_status: row.verification_status,
      compliance_score: 78 + (Number(row.id || 0) % 6) * 3,
    })),
  };
}

export async function getHealthcareTransportSummary(limit = 8) {
  await getDb();
  if (!_pool) return null;

  const [providerResult, orderResult] = await Promise.all([
    _pool.query<any>(`
      SELECT id, business_name, category, verification_status, status
      FROM service_providers
      ORDER BY created_at DESC NULLS LAST
      LIMIT $1
    `, [Math.max(limit, 10)]).catch(() => ({ rows: [] })),
    _pool.query<any>(`
      SELECT id, status, created_at, estimated_delivery_time
      FROM orders
      ORDER BY created_at DESC NULLS LAST
      LIMIT 100
    `).catch(() => ({ rows: [] })),
  ]);

  const compliancePacks = ['Patient identity verification', 'HIPAA-sensitive notes', 'Chain of custody', 'Prescription handoff validation'];

  return {
    summary: {
      care_programs: Math.max(4, Math.round(providerResult.rows.length / 2) || 4),
      scheduled_trips: Math.max(5, Math.round(orderResult.rows.length / 7) || 5),
      compliant_providers: providerResult.rows.filter((row: any) => String(row.verification_status || '').toLowerCase() === 'verified').length,
      compliance_packs: compliancePacks.length,
      recommended_action: 'Use scheduled pickups, patient eligibility checks, and chain-of-custody controls for care transportation and regulated delivery.',
    },
    transport_programs: [
      { id: 1, name: 'Non-emergency medical transport', schedule_mode: 'scheduled', compliance: 'patient identity + escort notes' },
      { id: 2, name: 'Pharmacy drop-off', schedule_mode: 'same_day', compliance: 'rx handoff + signature' },
      { id: 3, name: 'Caregiver meal support', schedule_mode: 'recurring', compliance: 'benefit policy validation' },
    ],
    active_cases: orderResult.rows.slice(0, limit).map((row: any) => ({
      id: Number(row.id),
      status: row.status,
      service_line: Number(row.id || 0) % 2 === 0 ? 'patient_trip' : 'regulated_delivery',
      eta_minutes: 15 + (Number(row.id || 0) % 5) * 10,
      created_at: row.created_at,
    })),
    compliance_packs: compliancePacks,
  };
}

export async function getMerchantChannelsSummary(limit = 8) {
  await getDb();
  if (!_pool) return null;

  const [providerResult, campaignResult] = await Promise.all([
    _pool.query<any>(`
      SELECT id, business_name, category, status, rating
      FROM service_providers
      ORDER BY rating DESC NULLS LAST, business_name ASC
      LIMIT $1
    `, [Math.max(limit, 12)]).catch(() => ({ rows: [] })),
    _pool.query<any>(`
      SELECT id, name, channel, status, budget, spent
      FROM marketing_campaigns
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT $1
    `, [Math.max(limit, 12)]).catch(() => ({ rows: [] })),
  ]);

  return {
    summary: {
      branded_storefronts: Math.max(4, providerResult.rows.length),
      direct_ordering_widgets: Math.max(3, Math.round(providerResult.rows.length / 2) || 3),
      crm_playbooks: 6,
      support_automation_flows: 5,
      recommended_action: 'Launch first-party merchant channels with direct ordering, loyalty, CRM journeys, and support automation managed from one console.',
    },
    storefronts: providerResult.rows.slice(0, limit).map((row: any) => ({
      id: Number(row.id),
      name: row.business_name,
      category: row.category,
      status: row.status,
      rating: Number(Number(row.rating || 0).toFixed(1)),
      storefront_state: Number(row.id || 0) % 3 === 0 ? 'needs_branding_refresh' : 'live',
    })),
    owned_channels: [
      'Hosted web storefront',
      'Embedded ordering widget',
      'White-label branded app',
      'Phone ordering agent',
      'Tableside QR ordering',
      'CRM-triggered reorder campaigns',
    ],
    campaigns: campaignResult.rows.slice(0, limit).map((row: any) => ({
      id: Number(row.id),
      name: row.name,
      channel: row.channel,
      status: row.status,
      budget: Number(Number(row.budget || 0).toFixed(2)),
      spent: Number(Number(row.spent || 0).toFixed(2)),
    })),
  };
}

export async function getPhoneOrderingSummary(limit = 8) {
  await getDb();
  if (!_pool) return null;

  const [providerResult, ticketResult] = await Promise.all([
    _pool.query<any>(`
      SELECT id, business_name, category, status
      FROM service_providers
      ORDER BY created_at DESC NULLS LAST
      LIMIT $1
    `, [Math.max(limit, 10)]).catch(() => ({ rows: [] })),
    _pool.query<any>(`
      SELECT id, status, priority, created_at
      FROM support_tickets
      ORDER BY created_at DESC NULLS LAST
      LIMIT 100
    `).catch(() => ({ rows: [] })),
  ]);

  return {
    summary: {
      live_lines: Math.max(3, providerResult.rows.length),
      ai_agents: 4,
      escalations_today: ticketResult.rows.filter((row: any) => ['urgent', 'critical'].includes(String(row.priority || '').toLowerCase())).length,
      recovered_orders: Math.max(2, Math.round(ticketResult.rows.length / 9) || 2),
      recommended_action: 'Use AI-assisted call capture, live-agent escalation, payment recovery, and CRM callbacks for voice commerce.',
    },
    call_flows: [
      { id: 1, name: 'Order capture', automation: 'voice agent + cart confirm' },
      { id: 2, name: 'Store call deflection', automation: 'FAQ + status lookup' },
      { id: 3, name: 'Support recovery', automation: 'refund triage + escalation' },
      { id: 4, name: 'Healthcare scheduling', automation: 'eligibility + pickup intake' },
    ],
    lines: providerResult.rows.slice(0, limit).map((row: any) => ({
      id: Number(row.id),
      brand: row.business_name,
      category: row.category,
      status: row.status,
      queue_sla_seconds: 25 + (Number(row.id || 0) % 5) * 15,
    })),
  };
}

export async function getTablesideOrderingSummary(limit = 8) {
  await getDb();
  if (!_pool) return null;

  const providerResult = await _pool.query<any>(`
    SELECT id, business_name, category, status, rating
    FROM service_providers
    ORDER BY rating DESC NULLS LAST, business_name ASC
    LIMIT $1
  `, [Math.max(limit, 12)]).catch(() => ({ rows: [] }));

  return {
    summary: {
      qr_venues: Math.max(4, providerResult.rows.length),
      active_sessions: Math.max(6, Math.round(providerResult.rows.length * 1.5) || 6),
      pay_at_table_enablement: 83,
      upsell_modules: 5,
      recommended_action: 'Enable QR menus, seat-aware carts, shared tabs, and server assist flows for onsite ordering.',
    },
    venue_rollout: providerResult.rows.slice(0, limit).map((row: any) => ({
      id: Number(row.id),
      venue: row.business_name,
      category: row.category,
      status: row.status,
      mode: Number(row.id || 0) % 2 === 0 ? 'full_qr_checkout' : 'server_assist',
      rating: Number(Number(row.rating || 0).toFixed(1)),
    })),
    order_modes: ['Scan to order', 'Pay at table', 'Split tab', 'Server assist', 'Pickup shelf handoff'],
  };
}

export async function getWhiteLabelAppsSummary(limit = 8) {
  await getDb();
  if (!_pool) return null;

  const providerResult = await _pool.query<any>(`
    SELECT id, business_name, category, status
    FROM service_providers
    ORDER BY created_at DESC NULLS LAST
    LIMIT $1
  `, [Math.max(limit, 12)]).catch(() => ({ rows: [] }));

  return {
    summary: {
      branded_apps_live: Math.max(3, Math.round(providerResult.rows.length / 2) || 3),
      templates_available: 7,
      push_channels_ready: 4,
      release_tracks: 3,
      recommended_action: 'Generate branded rider, courier, and merchant mobile experiences from reusable channel templates and release governance.',
    },
    app_templates: [
      { id: 1, name: 'Merchant Direct Ordering App', audience: 'consumer', release_track: 'stable' },
      { id: 2, name: 'Courier Operations App', audience: 'courier', release_track: 'beta' },
      { id: 3, name: 'Business Travel Companion', audience: 'enterprise', release_track: 'stable' },
      { id: 4, name: 'Healthcare Access App', audience: 'patient', release_track: 'pilot' },
    ],
    brands: providerResult.rows.slice(0, limit).map((row: any) => ({
      id: Number(row.id),
      brand: row.business_name,
      category: row.category,
      status: row.status,
      mobile_state: Number(row.id || 0) % 3 === 0 ? 'ready_for_publish' : 'configured',
    })),
  };
}

export async function getServiceRecoverySummary(limit = 8) {
  await getDb();
  if (!_pool) return null;

  const [ticketResult, transactionResult, orderResult] = await Promise.all([
    _pool.query<any>(`
      SELECT id, subject, status, priority, type, created_at
      FROM support_tickets
      ORDER BY created_at DESC NULLS LAST
      LIMIT $1
    `, [Math.max(limit, 20)]).catch(() => ({ rows: [] })),
    _pool.query<any>(`
      SELECT id, type, status, amount, created_at
      FROM transactions
      WHERE type IN ('refund', 'chargeback', 'payment')
      ORDER BY created_at DESC NULLS LAST
      LIMIT 100
    `).catch(() => ({ rows: [] })),
    _pool.query<any>(`
      SELECT id, status, total_amount, created_at
      FROM orders
      ORDER BY created_at DESC NULLS LAST
      LIMIT 100
    `).catch(() => ({ rows: [] })),
  ]);

  const urgentTickets = ticketResult.rows.filter((row: any) => ['urgent', 'critical'].includes(String(row.priority || '').toLowerCase())).length;
  const refunds = transactionResult.rows.filter((row: any) => String(row.type || '').toLowerCase() === 'refund').length;
  const disruptedOrders = orderResult.rows.filter((row: any) => ['cancelled', 'failed', 'issue'].includes(String(row.status || '').toLowerCase())).length;

  return {
    summary: {
      urgent_cases: urgentTickets,
      refunds_queued: refunds,
      disrupted_orders: disruptedOrders,
      automated_recovery_playbooks: 6,
      recommended_action: 'Connect incident intake, refund eligibility, customer messaging, merchant reimbursements, and audit evidence in one recovery console.',
    },
    playbooks: [
      'Late order recovery',
      'Missing item resolution',
      'Rider no-show remediation',
      'Care trip missed pickup protocol',
      'Freight detention escalation',
      'Airport cancellation recovery',
    ],
    incidents: ticketResult.rows.slice(0, limit).map((row: any) => ({
      id: Number(row.id),
      subject: row.subject,
      status: row.status,
      priority: row.priority,
      type: row.type,
      created_at: row.created_at,
    })),
  };
}

export async function getFundsReconciliationSnapshot() {
  await getDb();
  if (!_pool) return null;

  const [transactionResult, settlementResult, incentiveResult, orderResult, walletResult, disputeResult, reserveResult, mojaloopResult] = await Promise.all([
    _pool.query<any>(`
      SELECT
        COUNT(*) AS transaction_count,
        COALESCE(SUM(amount::numeric), 0) FILTER (WHERE type = 'payment' AND status = 'completed') AS completed_payments,
        COALESCE(SUM(amount::numeric), 0) FILTER (WHERE type = 'refund' AND status = 'completed') AS completed_refunds,
        COALESCE(SUM(amount::numeric), 0) FILTER (WHERE type = 'chargeback' AND status IN ('pending', 'completed')) AS chargeback_exposure,
        COUNT(*) FILTER (WHERE type = 'chargeback' AND status IN ('pending', 'completed')) AS chargeback_count,
        COALESCE(SUM(amount::numeric), 0) FILTER (WHERE type = 'payout' AND status IN ('pending', 'approved')) AS pending_payout_exposure,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed_transactions,
        COUNT(*) FILTER (WHERE status = 'pending') AS pending_transactions,
        MAX(updated_at) AS last_transaction_update
      FROM transactions
    `),
    _pool.query<any>(`
      SELECT
        COUNT(*) AS settlement_count,
        COALESCE(SUM(total_amount), 0) FILTER (WHERE status = 'pending') AS pending_settlements,
        COALESCE(SUM(total_amount), 0) FILTER (WHERE status = 'approved') AS approved_settlements,
        COALESCE(SUM(total_amount), 0) FILTER (WHERE status = 'completed') AS completed_settlements,
        MAX(COALESCE(processed_at, approved_at, created_at)) AS last_settlement_event
      FROM payout_settlements
    `),
    _pool.query<any>(`
      SELECT
        COALESCE(SUM(amount), 0) FILTER (WHERE status = 'approved' AND settlement_id IS NULL) AS approved_unsettled_incentives,
        COALESCE(SUM(amount), 0) FILTER (WHERE status = 'paid') AS paid_incentives,
        COUNT(*) FILTER (WHERE status = 'approved' AND settlement_id IS NULL) AS unsettled_incentive_count,
        MAX(COALESCE(paid_at, updated_at, created_at)) AS last_incentive_event
      FROM driver_incentives
    `),
    _pool.query<any>(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_orders,
        COUNT(*) FILTER (WHERE status = 'delivered') AS delivered_orders,
        COALESCE(SUM(driver_fee), 0) FILTER (WHERE status = 'delivered') AS delivered_driver_fees,
        MAX(COALESCE(actual_delivery_time, updated_at, created_at)) AS last_order_event
      FROM orders
    `),
    _pool.query<any>(`
      SELECT
        COUNT(*) AS wallet_count,
        COALESCE(SUM(balance::numeric), 0) AS total_wallet_balance,
        COUNT(*) FILTER (WHERE balance::numeric < 0) AS negative_wallets,
        MAX(updated_at) AS last_wallet_event
      FROM wallets
    `).catch(() => ({ rows: [{ wallet_count: 0, total_wallet_balance: 0, negative_wallets: 0, last_wallet_event: null }] })),
    _pool.query<any>(`
      SELECT
        COUNT(*) FILTER (WHERE type IN ('refund', 'claim') AND status IN ('open', 'in_progress')) AS open_dispute_like_tickets,
        COUNT(*) FILTER (WHERE priority IN ('urgent', 'critical') AND status IN ('open', 'in_progress')) AS critical_dispute_tickets,
        MAX(COALESCE(resolved_at, updated_at, created_at)) AS last_dispute_event
      FROM support_tickets
    `).catch(() => ({ rows: [{ open_dispute_like_tickets: 0, critical_dispute_tickets: 0, last_dispute_event: null }] })),
    _pool.query<any>(`
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
    `).catch(() => ({ rows: [{ merchant_reserves_held: 0, treasury_reserves_held: 0, merchant_reserve_entries: 0, treasury_reserve_entries: 0, last_reserve_event: null }] })),
    _pool.query<any>(`
      SELECT
        (SELECT COUNT(*) FROM mojaloop_transfers) AS transfer_count,
        COALESCE((SELECT SUM(amount) FROM mojaloop_transfers), 0) AS gross_transfer_amount,
        (SELECT COUNT(*) FROM mojaloop_transfers WHERE state = 'SETTLED') AS settled_transfer_count,
        (SELECT COUNT(*) FROM mojaloop_refunds) AS refund_count,
        COALESCE((SELECT SUM(amount) FROM mojaloop_refunds), 0) AS refunded_amount,
        (SELECT COUNT(*) FROM mojaloop_reconciliation_audits WHERE ledger_consistent = FALSE) AS inconsistent_audits,
        COALESCE((SELECT SUM(balance_cents) FROM ledger_accounts), 0) AS ledger_balance_cents,
        (SELECT COUNT(*) FROM ledger_entries WHERE entry_type = 'transfer') AS ledger_transfer_entries,
        (SELECT COUNT(*) FROM ledger_entries WHERE entry_type = 'refund') AS ledger_refund_entries,
        (SELECT COUNT(*) FROM mojaloop_workflows WHERE status NOT IN ('completed', 'settled', 'succeeded')) AS open_workflows,
        GREATEST(
          COALESCE((SELECT MAX(updated_at) FROM mojaloop_transfers), 'epoch'::timestamptz),
          COALESCE((SELECT MAX(updated_at) FROM mojaloop_refunds), 'epoch'::timestamptz),
          COALESCE((SELECT MAX(created_at) FROM mojaloop_reconciliation_audits), 'epoch'::timestamptz)
        ) AS last_mojaloop_event
    `).catch(() => ({ rows: [{ transfer_count: 0, gross_transfer_amount: 0, settled_transfer_count: 0, refund_count: 0, refunded_amount: 0, inconsistent_audits: 0, ledger_balance_cents: 0, ledger_transfer_entries: 0, ledger_refund_entries: 0, open_workflows: 0, last_mojaloop_event: null }] })),
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
