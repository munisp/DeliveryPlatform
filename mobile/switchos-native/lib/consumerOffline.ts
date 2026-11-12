/**
 * Offline replica readers + connectivity-mode selection for the consumer
 * screens (P2-C).
 *
 * When the device is disconnected, consumer READS render from the PowerSync
 * local database (lib/powersync — user_own / global_reference buckets):
 *
 *   orders + order_tracking_events   -> orders list/detail fallback
 *   service_verticals                -> marketplace verticals fallback
 *   service_providers                -> marketplace providers fallback
 *   provider_catalog_items           -> marketplace catalog fallback
 *   membership_plans                 -> subscription plans fallback
 *   consumer_memberships             -> current membership fallback
 *
 * All PowerSync column values arrive typed per schema (timestamps/numerics
 * as TEXT, booleans as INTEGER, ids as TEXT). The row mappers are pure and
 * unit-tested in Node; the hooks poll the local database only while the
 * replica is the active data mode.
 *
 * WRITES ARE NOT HERE: cart/checkout/subscribe/rate stay online-only this
 * wave (see lib/consumer.ts header).
 */
import { useEffect, useState } from "react";

import {
  getPowerSyncDatabase,
  usePowerSyncStatus,
} from "@/lib/powersync/PowerSyncProvider";

// ---------------------------------------------------------------------------
// Connectivity / data-mode selection (pure — unit-tested)
// ---------------------------------------------------------------------------

export type ConsumerDataMode =
  /** tRPC live reads; writes enabled. */
  | "live"
  /** PowerSync replica reads (disconnected or live read failed); writes gated. */
  | "offline-replica"
  /** Replica unavailable/empty and live failed — show empty state. */
  | "unavailable";

/**
 * Picks the data mode for a consumer read surface.
 *   connected          => live
 *   !connected && hasSynced => offline-replica
 *   otherwise          => unavailable
 * A live-read transport/procedure error with a synced replica downgrades to
 * offline-replica instead of an error screen.
 */
export function selectConsumerDataMode(input: {
  syncConnected: boolean;
  syncHasSynced: boolean;
  liveError?: boolean;
}): ConsumerDataMode {
  if (input.syncConnected && !input.liveError) return "live";
  if (input.syncHasSynced) return "offline-replica";
  return "unavailable";
}

// ---------------------------------------------------------------------------
// Row mappers (pure — unit-tested)
// ---------------------------------------------------------------------------

export interface ReplicaOrderRow {
  id: string;
  order_number: string;
  status: string;
  total_amount: string;
  created_at: string;
  updated_at: string | null;
  delivery_address: string | null;
  estimated_delivery_time: string | null;
  actual_delivery_time: string | null;
}

export interface ReplicaOrderSummary {
  id: number;
  orderNumber: string;
  status: string;
  totalAmount: string; // TEXT major, display via formatMajorAmount
  createdAt: string;
  updatedAt: string | null;
  deliveryAddress: string | null;
  estimatedDeliveryTime: string | null;
  actualDeliveryTime: string | null;
}

export function mapReplicaOrderRow(row: ReplicaOrderRow): ReplicaOrderSummary {
  return {
    id: Number(row.id),
    orderNumber: row.order_number,
    status: row.status,
    totalAmount: row.total_amount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveryAddress: row.delivery_address,
    estimatedDeliveryTime: row.estimated_delivery_time,
    actualDeliveryTime: row.actual_delivery_time,
  };
}

export interface ReplicaTrackingRow {
  id: string;
  order_id: string;
  event_type: string;
  status_label: string;
  eta_minutes: number | null;
  event_time: string;
  metadata: string | null;
}

export interface ReplicaTimelineEvent {
  label: string;
  occurredAt: string;
  detail: string | null;
}

export function mapReplicaTrackingRow(row: ReplicaTrackingRow): ReplicaTimelineEvent {
  return {
    label: row.status_label || row.event_type,
    occurredAt: row.event_time,
    detail: row.eta_minutes !== null ? `ETA ${row.eta_minutes} min` : null,
  };
}

/** Timeline ordering: ascending by occurredAt, nulls last. */
export function sortTimeline<T extends { occurredAt: string | null }>(events: T[]): T[] {
  return [...events].sort((a, b) => {
    const at = a.occurredAt ? new Date(a.occurredAt).getTime() : Number.POSITIVE_INFINITY;
    const bt = b.occurredAt ? new Date(b.occurredAt).getTime() : Number.POSITIVE_INFINITY;
    return at - bt;
  });
}

export interface ReplicaVerticalRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  icon: string | null;
}

export interface ReplicaProviderRow {
  id: string;
  vertical_id: string;
  name: string;
  business_name: string | null;
  address: string | null;
  rating: string | null;
  status: string;
}

export interface ReplicaCatalogItemRow {
  id: string;
  provider_id: string;
  sku: string;
  item_name: string;
  description: string | null;
  /** TEXT major units. */
  price: string;
  currency: string;
  is_available: number;
}

export interface ReplicaMembershipPlanRow {
  id: string;
  plan_code: string;
  plan_name: string;
  /** TEXT major units (NUMERIC). */
  monthly_price: string;
  delivery_fee_discount: string | null;
  priority_support: number;
  cashback_rate: string | null;
  perks: string | null;
  is_active: number;
}

export interface ReplicaMembershipRow {
  id: string;
  plan_id: string;
  status: string;
  renewal_at: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Replica query hook (polls only while replica mode is active)
// ---------------------------------------------------------------------------

/**
 * Runs a read query against the PowerSync local database. Returns null rows
 * when the database is unavailable (web / init failure) — callers treat that
 * as "no replica data", never as a crash. Polls on `intervalMs` while
 * `active` so newly replicated rows appear without a manual refresh.
 */
export function useReplicaQuery<Row, Out>(
  active: boolean,
  sql: string,
  params: unknown[],
  map: (row: Row) => Out,
  intervalMs = 5_000,
): { rows: Out[]; loaded: boolean } {
  const [rows, setRows] = useState<Out[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!active) {
      setLoaded(false);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const run = async () => {
      const db = await getPowerSyncDatabase();
      if (!db || cancelled) return;
      try {
        const result = await db.getAll<Row>(sql, params);
        if (cancelled) return;
        setRows(result.map(map));
        setLoaded(true);
      } catch {
        // Replica read failure degrades silently: screens already show the
        // online-only/unavailable state for this mode.
      }
    };

    void run();
    timer = setInterval(() => void run(), intervalMs);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, sql, intervalMs]);

  return { rows, loaded };
}

/**
 * Combined connectivity snapshot for consumer screens: the PowerSync status
 * plus the derived data mode. `liveError` lets a failed live read downgrade
 * to the replica instead of an error screen.
 */
export function useConsumerDataMode(liveError?: boolean): {
  mode: ConsumerDataMode;
  connected: boolean;
  hasSynced: boolean;
  lastSyncAt: string | null;
} {
  const status = usePowerSyncStatus();
  const mode = selectConsumerDataMode({
    syncConnected: status.connected,
    syncHasSynced: status.hasSynced,
    liveError,
  });
  return {
    mode,
    connected: status.connected,
    hasSynced: status.hasSynced,
    lastSyncAt: status.lastSyncAt,
  };
}
