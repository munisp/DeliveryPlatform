/**
 * Client-side PowerSync schema for the DeliveryPlatform PWA.
 *
 * PowerSync replicates schemaless JSON rows and applies this schema as
 * SQLite views on the client, so column types here must match what the sync
 * rules produce: Postgres timestamps/numerics arrive as text, booleans as
 * integer, and JSONB as a JSON-encoded text column. The client `id` column
 * (text) is added by the SDK automatically — sync rules must project the
 * integer primary keys as text (`id::text AS id`).
 *
 * Mapping to the sync-rules role groups (consumer/operator PWA subset):
 *
 *   bucket `consumer_data` (parameters: SELECT request.user_id() AS user_id)
 *     - orders                 -> SELECT ... FROM orders
 *                                 WHERE customer_id = bucket.user_id
 *     - order_tracking_events  -> SELECT ote.* FROM order_tracking_events ote
 *                                 JOIN orders o ON o.id = ote.order_id
 *                                 WHERE o.customer_id = bucket.user_id
 *     - loyalty_points         -> SELECT ... FROM loyalty_points
 *                                 WHERE user_id = bucket.user_id
 *     - loyalty_transactions   -> SELECT ... FROM loyalty_transactions
 *                                 WHERE user_id = bucket.user_id
 *
 *   bucket `global_reference` (no parameters — synced to every client)
 *     - service_verticals      -> SELECT * FROM service_verticals
 *     - vertical_service_templates -> SELECT * FROM vertical_service_templates
 *     - provider_catalog_items -> SELECT * FROM provider_catalog_items
 *
 * Keep this file backwards-compatible: old app versions keep running against
 * new sync rules, so only add columns/tables, never remove or rename.
 */
import { column, Schema, Table } from "@powersync/web";

// --- consumer_data bucket -------------------------------------------------

const orders = new Table(
  {
    order_number: column.text,
    customer_id: column.integer,
    vertical_id: column.integer,
    provider_id: column.integer,
    driver_id: column.integer,
    status: column.text,
    total_amount: column.text,
    pickup_address: column.text,
    delivery_address: column.text,
    estimated_delivery_time: column.text,
    actual_delivery_time: column.text,
    notes: column.text,
    created_at: column.text,
    updated_at: column.text,
  },
  { indexes: { customer: ["customer_id"], status: ["status"] } },
);

const orderTrackingEvents = new Table(
  {
    order_id: column.integer,
    event_type: column.text,
    status_label: column.text,
    eta_minutes: column.integer,
    event_time: column.text,
    metadata: column.text,
  },
  { indexes: { order: ["order_id"] } },
);

const loyaltyPoints = new Table({
  user_id: column.integer,
  points_balance: column.integer,
  lifetime_points: column.integer,
  tier: column.text,
  tier_progress: column.text,
  next_tier_threshold: column.integer,
  updated_at: column.text,
});

const loyaltyTransactions = new Table(
  {
    user_id: column.integer,
    transaction_type: column.text,
    points: column.integer,
    order_id: column.integer,
    description: column.text,
    created_at: column.text,
  },
  { indexes: { user: ["user_id"], order: ["order_id"] } },
);

// --- global_reference bucket ----------------------------------------------

const serviceVerticals = new Table({
  name: column.text,
  slug: column.text,
  description: column.text,
  icon: column.text,
  is_active: column.integer,
});

const verticalServiceTemplates = new Table({
  vertical_key: column.text,
  display_name: column.text,
  service_levels: column.text,
  dispatch_modes: column.text,
  metadata: column.text,
});

const providerCatalogItems = new Table(
  {
    provider_id: column.integer,
    sku: column.text,
    item_name: column.text,
    description: column.text,
    price: column.text,
    currency: column.text,
    is_available: column.integer,
    metadata: column.text,
    updated_at: column.text,
  },
  { indexes: { provider: ["provider_id"], sku: ["sku"] } },
);

export const PowerSyncAppSchema = new Schema({
  orders,
  order_tracking_events: orderTrackingEvents,
  loyalty_points: loyaltyPoints,
  loyalty_transactions: loyaltyTransactions,
  service_verticals: serviceVerticals,
  vertical_service_templates: verticalServiceTemplates,
  provider_catalog_items: providerCatalogItems,
});

export type PowerSyncDatabaseTypes = (typeof PowerSyncAppSchema)["types"];
