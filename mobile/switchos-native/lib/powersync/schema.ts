/**
 * Client-side PowerSync schema for SwitchOS Native (Expo RN).
 *
 * Mirrors the DEPLOYED sync rules (deploy/powersync/sync-rules.yaml on main)
 * and the v1 publication (drizzle/0103_powersync_sync_support.sql, 19
 * tables). Mobile v1 covers the role groups this app can receive:
 *
 *   bucket `user_own` (every authenticated user; parameters user_id = JWT sub)
 *     orders, order_tracking_events, notifications, support_tickets,
 *     loyalty_points, loyalty_transactions, loyalty_redemptions,
 *     consumer_memberships, consumer_reviews
 *   bucket `courier_assignments` (role='courier' tokens; adds)
 *     drivers, driver_reviews, driver_performance_scores,
 *     delivery_tracking_events (plus orders/order_tracking_events re-scoped
 *     by driver — same client tables, merged buckets)
 *   bucket `global_reference` (no parameters — every client)
 *     service_verticals, vertical_service_templates, membership_plans,
 *     loyalty_rewards
 *
 * merchant_store (service_providers, provider_catalog_items) and
 * operator_admin tables are declared as well: the tables are cheap to
 * declare, and a session whose token resolves to those roles syncs into the
 * same client schema without a migration.
 *
 * Type mapping (same conventions as the PWA twin client/src/lib/powersyncSchema.ts):
 *   - Postgres timestamps arrive as text, NUMERIC/DECIMAL as text, booleans
 *     as integer, json/jsonb as JSON-encoded text.
 *   - The client `id` column is TEXT and added by the SDK automatically —
 *     sync rules project integer/bigint primary keys as text (id::text).
 *   - BIGINT columns (delivery_tracking_events.id/tenant_id/...) fit SQLite
 *     INTEGER for user-id-sized values; declared integer here.
 *
 * Backwards compatibility: only add columns/tables, never remove or rename —
 * old app versions keep running against newer sync rules.
 */
import { column, Schema, Table } from "@powersync/common";

// --- user_own bucket ------------------------------------------------------

const orders = new Table(
  {
    order_number: column.text,
    customer_id: column.integer,
    vertical_id: column.integer,
    provider_id: column.integer,
    driver_id: column.integer,
    status: column.text,
    total_amount: column.text,
    platform_fee: column.text,
    driver_fee: column.text,
    pickup_address: column.text,
    pickup_latitude: column.text,
    pickup_longitude: column.text,
    delivery_address: column.text,
    delivery_latitude: column.text,
    delivery_longitude: column.text,
    scheduled_pickup_time: column.text,
    actual_pickup_time: column.text,
    actual_delivery_time: column.text,
    estimated_delivery_time: column.text,
    notes: column.text,
    created_at: column.text,
    updated_at: column.text,
  },
  {
    indexes: {
      customer: ["customer_id"],
      driver: ["driver_id"],
      status: ["status"],
    },
  },
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

const notifications = new Table(
  {
    user_id: column.integer,
    type: column.text,
    title: column.text,
    message: column.text,
    priority: column.text,
    is_read: column.integer,
    metadata: column.text,
    created_at: column.text,
  },
  { indexes: { user: ["user_id"] } },
);

/**
 * Also the v1 upload-whitelist table: local PUT rows are uploaded through
 * POST /api/powersync/upload (see lib/powersync/localWrites.ts). Locally
 * queued rows use `pslocal-` prefixed ids and status 'pending_upload' — both
 * are client-only placeholders the server ignores/replaces on replication.
 */
const supportTickets = new Table(
  {
    ticket_number: column.text,
    customer_id: column.integer,
    order_id: column.integer,
    type: column.text,
    priority: column.text,
    status: column.text,
    subject: column.text,
    description: column.text,
    resolution: column.text,
    created_at: column.text,
    updated_at: column.text,
    resolved_at: column.text,
  },
  { indexes: { customer: ["customer_id"], status: ["status"] } },
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

const loyaltyRedemptions = new Table(
  {
    user_id: column.integer,
    reward_id: column.integer,
    points_spent: column.integer,
    status: column.text,
    voucher_code: column.text,
    expires_at: column.text,
    created_at: column.text,
  },
  { indexes: { user: ["user_id"] } },
);

const consumerMemberships = new Table(
  {
    user_id: column.integer,
    plan_id: column.integer,
    status: column.text,
    renewal_at: column.text,
    savings_ytd: column.text,
    active_orders: column.integer,
    created_at: column.text,
    updated_at: column.text,
  },
  { indexes: { user: ["user_id"] } },
);

const consumerReviews = new Table(
  {
    order_id: column.integer,
    provider_id: column.integer,
    user_id: column.integer,
    rating: column.integer,
    title: column.text,
    review_text: column.text,
    sentiment: column.text,
    created_at: column.text,
  },
  { indexes: { user: ["user_id"], order: ["order_id"] } },
);

// --- courier_assignments bucket --------------------------------------------

const drivers = new Table({
  open_id: column.text,
  name: column.text,
  email: column.text,
  phone: column.text,
  profile_image: column.text,
  status: column.text,
  vehicle_type: column.text,
  vehicle_number: column.text,
  license_number: column.text,
  license_verified: column.integer,
  current_latitude: column.text,
  current_longitude: column.text,
  last_location_update: column.text,
  rating: column.text,
  total_orders: column.integer,
  created_at: column.text,
  updated_at: column.text,
});

const driverReviews = new Table(
  {
    order_id: column.integer,
    driver_id: column.integer,
    customer_id: column.integer,
    overall_rating: column.integer,
    punctuality_rating: column.integer,
    professionalism_rating: column.integer,
    vehicle_condition_rating: column.integer,
    communication_rating: column.integer,
    feedback: column.text,
    moderation_status: column.text,
    created_at: column.text,
  },
  { indexes: { driver: ["driver_id"] } },
);

const driverPerformanceScores = new Table(
  {
    driver_id: column.integer,
    score: column.text,
    tier: column.text,
    delivery_time_score: column.text,
    review_score: column.text,
    acceptance_rate: column.text,
    completion_rate: column.text,
    total_deliveries: column.integer,
    on_time_deliveries: column.integer,
    late_deliveries: column.integer,
    cancelled_deliveries: column.integer,
    last_calculated_at: column.text,
    updated_at: column.text,
  },
  { indexes: { driver: ["driver_id"] } },
);

/**
 * Courier position events (drizzle/0023). BIGSERIAL id arrives as text.
 * tenant_id here is the vehicle-tracker tenant, NOT the platform tenant
 * (per sync-rules.yaml header — never join on it client-side either).
 */
const deliveryTrackingEvents = new Table(
  {
    delivery_id: column.text,
    tenant_id: column.integer,
    driver_operator_id: column.integer,
    latitude: column.text,
    longitude: column.text,
    accuracy_meters: column.text,
    occurred_at: column.text,
    received_at: column.text,
  },
  { indexes: { driver: ["driver_operator_id"], delivery: ["delivery_id"] } },
);

// --- global_reference bucket ------------------------------------------------

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

const membershipPlans = new Table({
  plan_code: column.text,
  plan_name: column.text,
  monthly_price: column.text,
  delivery_fee_discount: column.text,
  priority_support: column.integer,
  cashback_rate: column.text,
  perks: column.text,
  is_active: column.integer,
});

const loyaltyRewards = new Table({
  reward_name: column.text,
  description: column.text,
  points_cost: column.integer,
  points_required: column.integer,
  reward_type: column.text,
  reward_value: column.text,
  min_tier: column.text,
  is_active: column.integer,
  status: column.text,
  expires_at: column.text,
});

// --- merchant_store bucket (declared for schema stability) ------------------

const serviceProviders = new Table({
  vertical_id: column.integer,
  name: column.text,
  business_name: column.text,
  email: column.text,
  phone: column.text,
  address: column.text,
  latitude: column.text,
  longitude: column.text,
  status: column.text,
  verification_status: column.text,
  rating: column.text,
  commission_rate: column.text,
  created_at: column.text,
  updated_at: column.text,
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
  notifications,
  support_tickets: supportTickets,
  loyalty_points: loyaltyPoints,
  loyalty_transactions: loyaltyTransactions,
  loyalty_redemptions: loyaltyRedemptions,
  consumer_memberships: consumerMemberships,
  consumer_reviews: consumerReviews,
  drivers,
  driver_reviews: driverReviews,
  driver_performance_scores: driverPerformanceScores,
  delivery_tracking_events: deliveryTrackingEvents,
  service_verticals: serviceVerticals,
  vertical_service_templates: verticalServiceTemplates,
  membership_plans: membershipPlans,
  loyalty_rewards: loyaltyRewards,
  service_providers: serviceProviders,
  provider_catalog_items: providerCatalogItems,
});

export type PowerSyncDatabaseTypes = (typeof PowerSyncAppSchema)["types"];
