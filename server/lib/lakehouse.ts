import pg from "pg";

import { ENV } from "../_core/env";

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
    });
  }
  return pool;
}

async function fetchLakehouse<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${ENV.lakehouseServiceUrl}${path}`, {
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Service-Token": ENV.internalServiceToken,
      ...(init?.headers ?? {}),
    },
    ...init,
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
  } finally {
    client.release();
  }
}

export async function getLakehouseAnalyticsSummary(): Promise<LakehouseAnalyticsSummary> {
  return fetchLakehouse<LakehouseAnalyticsSummary>("/analytics/summary");
}

export async function getLakehouseOrderStats(): Promise<LakehouseAnalyticsSummary["order_stats"]> {
  return fetchLakehouse<LakehouseAnalyticsSummary["order_stats"]>("/analytics/order-stats");
}

export async function getLakehouseDriverStats(): Promise<LakehouseAnalyticsSummary["driver_stats"]> {
  return fetchLakehouse<LakehouseAnalyticsSummary["driver_stats"]>("/analytics/driver-stats");
}

export async function getLakehouseMarketplaceOverview(): Promise<LakehouseAnalyticsSummary["marketplace_overview"]> {
  return fetchLakehouse<LakehouseAnalyticsSummary["marketplace_overview"]>("/analytics/marketplace-overview");
}
