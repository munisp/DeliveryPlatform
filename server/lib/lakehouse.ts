import pg from "pg";

import { ENV } from "../_core/env";
import { createHotCache } from "../_core/hotCache";
import { CircuitBreaker, resilientFetch } from "../_core/resilientFetch";

type JsonRecord = Record<string, unknown>;

type LakehouseAnalyticsSummary = {
  source: string;
  generated_at: string;
  order_stats: {
    total: number;
    completed: number;
    cancelled: number;
    revenue: string;
  };
  driver_stats: {
    total: number;
    online: number;
    busy: number;
    offline: number;
  };
  marketplace_overview: {
    queue: {
      pending_orders: number;
      avg_queue_minutes: number;
    };
    drivers: {
      available_drivers: number;
      busy_drivers: number;
    };
    activity_signals: {
      assignment_events_7d: number;
    };
    hotspots: Array<{
      zone_key: string;
      open_orders: number;
      waiting_orders: number;
      avg_wait_minutes: number;
      available_drivers: number;
      busy_drivers: number;
      pressure_ratio: number;
      pressure_band: string;
      recommended_action: string;
    }>;
  };
};

const DEFAULT_SYNC_LIMIT = 500;
const { Pool } = pg;
let pool: pg.Pool | null = null;

// TLS verification is always on for database connections. The only way to
// disable it is the development-only DATABASE_TLS_SKIP_VERIFY flag, which
// env.ts refuses to honor in production.
function buildDatabaseSsl(useSsl: boolean) {
  if (!useSsl) return false;
  if (ENV.databaseTlsSkipVerify) {
    console.warn(
      "[SECURITY] DATABASE_TLS_SKIP_VERIFY=true: TLS certificate verification is DISABLED for the lakehouse database connection. This is a development-only override and is rejected in production.",
    );
    return { rejectUnauthorized: false as const };
  }
  return {
    rejectUnauthorized: true as const,
    ...(ENV.databaseSslCa ? { ca: ENV.databaseSslCa } : {}),
  };
}

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: ENV.databaseUrl,
      ssl: buildDatabaseSsl(ENV.databaseUrl.includes("sslmode=require")),
      // Bounded satellite pool (perf finding 10): the syncer is the only
      // consumer and holds ONE dedicated client per sync; cap connections,
      // bound connect/idle, and kill runaway statements server-side.
      max: 5,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 30000,
      options: "-c statement_timeout=10000",
    });
  }
  return pool;
}

// Dedicated fail-fast breaker for the lakehouse service (perf finding 2):
// two consecutive failures open it so analytics reads fail open fast instead
// of hanging on a dead lakehouse.
const lakehouseBreaker = new CircuitBreaker({
  failureThreshold: 2,
  resetTimeoutMs: 15_000,
});

async function fetchLakehouse<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await resilientFetch(`${ENV.lakehouseServiceUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Service-Token": ENV.internalServiceToken,
      ...(init?.headers ?? {}),
    },
    timeoutMs: 2_000,
    maxAttempts: 2,
    breaker: lakehouseBreaker,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Lakehouse request failed (${response.status}): ${body || response.statusText}`);
  }

  return response.json() as Promise<T>;
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toIso(value: Date | string | null | undefined): string {
  if (!value) return new Date().toISOString();
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function normalizeOrderRow(row: Record<string, unknown>): JsonRecord {
  return {
    order_id: row.id,
    order_number: row.order_number,
    customer_id: row.customer_id,
    vertical_id: row.vertical_id,
    provider_id: row.provider_id,
    driver_id: row.driver_id,
    status: row.status,
    total_amount: toNumber(row.total_amount),
    platform_fee: toNumber(row.platform_fee),
    driver_fee: toNumber(row.driver_fee),
    pickup_latitude: toNumber(row.pickup_latitude),
    pickup_longitude: toNumber(row.pickup_longitude),
    delivery_latitude: toNumber(row.delivery_latitude),
    delivery_longitude: toNumber(row.delivery_longitude),
    scheduled_pickup_time: row.scheduled_pickup_time ? toIso(row.scheduled_pickup_time as string) : null,
    actual_pickup_time: row.actual_pickup_time ? toIso(row.actual_pickup_time as string) : null,
    actual_delivery_time: row.actual_delivery_time ? toIso(row.actual_delivery_time as string) : null,
    estimated_delivery_time: row.estimated_delivery_time ? toIso(row.estimated_delivery_time as string) : null,
    created_at: toIso(row.created_at as string),
    updated_at: toIso((row.updated_at as string) ?? (row.created_at as string)),
    timestamp: toIso((row.updated_at as string) ?? (row.created_at as string)),
    date: toIso(row.created_at as string).slice(0, 10),
  };
}

function normalizeDriverRow(row: Record<string, unknown>): JsonRecord {
  return {
    driver_id: row.id,
    name: row.name,
    status: row.status,
    vehicle_type: row.vehicle_type,
    current_latitude: toNumber(row.current_latitude),
    current_longitude: toNumber(row.current_longitude),
    rating: toNumber(row.rating),
    total_orders: toNumber(row.total_orders),
    created_at: toIso(row.created_at as string),
    updated_at: toIso((row.updated_at as string) ?? (row.created_at as string)),
    timestamp: toIso((row.last_location_update as string) ?? (row.updated_at as string) ?? (row.created_at as string)),
    last_location_update: row.last_location_update ? toIso(row.last_location_update as string) : null,
    date: toIso((row.updated_at as string) ?? (row.created_at as string)).slice(0, 10),
  };
}

function normalizePaymentRow(row: Record<string, unknown>): JsonRecord {
  return {
    payment_id: row.id,
    order_id: row.order_id,
    customer_id: row.customer_id ?? null,
    amount: toNumber(row.amount),
    currency: row.currency,
    payment_method: row.payment_method,
    status: row.status,
    provider: row.recipient_type,
    transaction_id: row.transaction_id,
    created_at: toIso(row.created_at as string),
    updated_at: toIso((row.updated_at as string) ?? (row.created_at as string)),
    timestamp: toIso((row.updated_at as string) ?? (row.created_at as string)),
    date: toIso(row.created_at as string).slice(0, 10),
  };
}

function buildMarketplaceEvents(orderRows: Array<Record<string, unknown>>): JsonRecord[] {
  const now = Date.now();
  return orderRows
    .filter((row) => row.driver_id !== null && row.driver_id !== undefined)
    .map((row) => ({
      event_type: "orders.driver_assigned",
      order_id: row.id,
      driver_id: row.driver_id,
      vertical_id: row.vertical_id,
      timestamp: toIso((row.updated_at as string) ?? (row.created_at as string)),
      created_at: toIso((row.updated_at as string) ?? (row.created_at as string)),
      date: toIso((row.updated_at as string) ?? (row.created_at as string)).slice(0, 10),
      replayed_at: new Date(now).toISOString(),
    }));
}

let lastSyncCompletedAt: number | null = null;
let syncInFlight: Promise<void> | null = null;

/** ISO timestamp of the last successful Postgres→lakehouse sync. */
export function getLakehouseLastSyncAt(): string | null {
  return lastSyncCompletedAt === null
    ? null
    : new Date(lastSyncCompletedAt).toISOString();
}

/**
 * Whole seconds since the last successful sync, or null when no sync has
 * completed yet in this process. Surfaced to operators as
 * `dataFreshnessSeconds` on every lakehouse-backed analytics payload.
 */
export function getLakehouseDataFreshnessSeconds(): number | null {
  return lastSyncCompletedAt === null
    ? null
    : Math.max(0, Math.floor((Date.now() - lastSyncCompletedAt) / 1000));
}

export async function syncLakehouseFromPostgres(limit = DEFAULT_SYNC_LIMIT): Promise<void> {
  const client = await getPool().connect();
  try {
    const [ordersResult, driversResult, paymentsResult] = await Promise.all([
      client.query(`SELECT * FROM orders ORDER BY COALESCE(updated_at, created_at) DESC LIMIT $1`, [limit]),
      client.query(`SELECT * FROM drivers ORDER BY COALESCE(updated_at, created_at) DESC LIMIT $1`, [limit]),
      client.query(`SELECT * FROM transactions ORDER BY COALESCE(updated_at, created_at) DESC LIMIT $1`, [limit]),
    ]);

    const orderRows = ordersResult.rows as Array<Record<string, unknown>>;
    const driverRows = driversResult.rows as Array<Record<string, unknown>>;
    const paymentRows = paymentsResult.rows as Array<Record<string, unknown>>;

    await Promise.all([
      fetchLakehouse("/ingest/orders", {
        method: "POST",
        body: JSON.stringify({ rows: orderRows.map(normalizeOrderRow) }),
      }),
      fetchLakehouse("/ingest/drivers", {
        method: "POST",
        body: JSON.stringify({ rows: driverRows.map(normalizeDriverRow) }),
      }),
      fetchLakehouse("/ingest/payments", {
        method: "POST",
        body: JSON.stringify({ rows: paymentRows.map(normalizePaymentRow) }),
      }),
      fetchLakehouse("/ingest/marketplace_events", {
        method: "POST",
        body: JSON.stringify({ rows: buildMarketplaceEvents(orderRows) }),
      }),
    ]);
    lastSyncCompletedAt = Date.now();
    // The store is now fresher than anything cached before this point.
    lakehouseReadCache.invalidate("*");
  } finally {
    client.release();
  }
}

/**
 * Overlap-guarded sync used by the background syncer: concurrent ticks share
 * a single in-flight sync instead of stacking full-table reads + ingest POSTs
 * (perf finding 1). Errors are logged and swallowed so the interval keeps
 * running; the read path reports staleness via dataFreshnessSeconds.
 */
function runGuardedSync(): Promise<void> {
  if (!syncInFlight) {
    syncInFlight = syncLakehouseFromPostgres()
      .catch((error) => {
        console.warn("[SwitchOS] Scheduled lakehouse sync failed:", error);
      })
      .finally(() => {
        syncInFlight = null;
      });
  }
  return syncInFlight;
}

/**
 * Self-contained background syncer (perf finding 1): analytics reads no
 * longer sync inline; this interval keeps the lakehouse warm instead.
 * Started once from server boot (server/_core/index.ts); returns a stop
 * function for graceful shutdown. The timer is unref'd so it never keeps a
 * process (or test) alive.
 */
export function startLakehouseSyncer(
  intervalMs: number = ENV.lakehouseSyncIntervalMs,
): () => void {
  const tick = () => {
    if (!ENV.databaseUrl) return;
    void runGuardedSync();
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();
  return () => clearInterval(timer);
}

/**
 * In-process TTL cache in front of lakehouse analytics reads (perf W7).
 * The python-side analytics queries cost ~260ms p50 on seeded volumes; the
 * data they serve is already eventually-consistent via the 45s background
 * syncer, so caching successful reads for `lakehouseReadCacheTtlMs`
 * (default 30s, below the sync interval) does not materially change
 * freshness. Failures are never cached, so the fail-open-fast breaker
 * semantics are unchanged. Entries are dropped after every completed sync
 * and on operator forceRefresh, so cached data never outlives a known-fresh
 * store.
 */
const lakehouseReadCache = createHotCache<JsonRecord>({
  ttlMs: ENV.lakehouseReadCacheTtlMs,
});

async function cachedLakehouseRead<T>(
  key: string,
  loader: () => Promise<T>,
): Promise<T> {
  const cached = lakehouseReadCache.get(key);
  if (cached !== undefined) return cached as T;
  const value = await loader();
  lakehouseReadCache.set(key, value as JsonRecord);
  return value;
}

/** Drop cached lakehouse reads (post-sync, operator forceRefresh, tests). */
export function invalidateLakehouseReadCache(): void {
  lakehouseReadCache.invalidate("*");
}

export async function getLakehouseAnalyticsSummary(): Promise<LakehouseAnalyticsSummary> {
  return cachedLakehouseRead("summary", () =>
    fetchLakehouse<LakehouseAnalyticsSummary>("/analytics/summary"),
  );
}

export async function getLakehouseOrderStats(): Promise<LakehouseAnalyticsSummary["order_stats"]> {
  return cachedLakehouseRead("order-stats", () =>
    fetchLakehouse<LakehouseAnalyticsSummary["order_stats"]>("/analytics/order-stats"),
  );
}

export async function getLakehouseDriverStats(): Promise<LakehouseAnalyticsSummary["driver_stats"]> {
  return cachedLakehouseRead("driver-stats", () =>
    fetchLakehouse<LakehouseAnalyticsSummary["driver_stats"]>("/analytics/driver-stats"),
  );
}

export async function getLakehouseMarketplaceOverview(): Promise<LakehouseAnalyticsSummary["marketplace_overview"]> {
  return cachedLakehouseRead("marketplace-overview", () =>
    fetchLakehouse<LakehouseAnalyticsSummary["marketplace_overview"]>("/analytics/marketplace-overview"),
  );
}
