import { desc } from "drizzle-orm";

import { ENV } from "../_core/env";
import { getDb } from "../db";
import { drivers, orders, transactions } from "../../drizzle/schema";

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

async function fetchLakehouse<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${ENV.lakehouseServiceUrl}${path}`, {
    headers: {
      "Content-Type": "application/json",
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

function normalizeOrderRow(row: typeof orders.$inferSelect): JsonRecord {
  return {
    order_id: row.id,
    order_number: row.orderNumber,
    customer_id: row.customerId,
    vertical_id: row.verticalId,
    provider_id: row.providerId,
    driver_id: row.driverId,
    status: row.status,
    total_amount: toNumber(row.totalAmount),
    platform_fee: toNumber(row.platformFee),
    driver_fee: toNumber(row.driverFee),
    pickup_latitude: toNumber(row.pickupLatitude),
    pickup_longitude: toNumber(row.pickupLongitude),
    delivery_latitude: toNumber(row.deliveryLatitude),
    delivery_longitude: toNumber(row.deliveryLongitude),
    scheduled_pickup_time: row.scheduledPickupTime ? toIso(row.scheduledPickupTime) : null,
    actual_pickup_time: row.actualPickupTime ? toIso(row.actualPickupTime) : null,
    actual_delivery_time: row.actualDeliveryTime ? toIso(row.actualDeliveryTime) : null,
    estimated_delivery_time: row.estimatedDeliveryTime ? toIso(row.estimatedDeliveryTime) : null,
    created_at: toIso(row.createdAt),
    updated_at: toIso(row.updatedAt),
    timestamp: toIso(row.updatedAt ?? row.createdAt),
    date: toIso(row.createdAt).slice(0, 10),
  };
}

function normalizeDriverRow(row: typeof drivers.$inferSelect): JsonRecord {
  return {
    driver_id: row.id,
    name: row.name,
    status: row.status,
    vehicle_type: row.vehicleType,
    current_latitude: toNumber(row.currentLatitude),
    current_longitude: toNumber(row.currentLongitude),
    rating: toNumber(row.rating),
    total_orders: row.totalOrders,
    created_at: toIso(row.createdAt),
    updated_at: toIso(row.updatedAt),
    timestamp: toIso(row.lastLocationUpdate ?? row.updatedAt ?? row.createdAt),
    last_location_update: row.lastLocationUpdate ? toIso(row.lastLocationUpdate) : null,
    date: toIso(row.updatedAt).slice(0, 10),
  };
}

function normalizePaymentRow(row: typeof transactions.$inferSelect): JsonRecord {
  return {
    payment_id: row.id,
    order_id: row.orderId,
    customer_id: null,
    amount: toNumber(row.amount),
    currency: row.currency,
    payment_method: row.paymentMethod,
    status: row.status,
    provider: row.recipientType,
    transaction_id: row.transactionId,
    created_at: toIso(row.createdAt),
    updated_at: toIso(row.updatedAt),
    timestamp: toIso(row.updatedAt ?? row.createdAt),
    date: toIso(row.createdAt).slice(0, 10),
  };
}

function buildMarketplaceEvents(orderRows: Array<typeof orders.$inferSelect>): JsonRecord[] {
  const now = Date.now();
  return orderRows
    .filter((row) => row.driverId !== null)
    .map((row) => ({
      event_type: "orders.driver_assigned",
      order_id: row.id,
      driver_id: row.driverId,
      vertical_id: row.verticalId,
      timestamp: toIso(row.updatedAt ?? row.createdAt),
      created_at: toIso(row.updatedAt ?? row.createdAt),
      date: toIso(row.updatedAt ?? row.createdAt).slice(0, 10),
      replayed_at: new Date(now).toISOString(),
    }));
}

export async function syncLakehouseFromPostgres(limit = DEFAULT_SYNC_LIMIT): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const [orderRows, driverRows, paymentRows] = await Promise.all([
    db.select().from(orders).orderBy(desc(orders.updatedAt)).limit(limit),
    db.select().from(drivers).orderBy(desc(drivers.updatedAt)).limit(limit),
    db.select().from(transactions).orderBy(desc(transactions.updatedAt)).limit(limit),
  ]);

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
