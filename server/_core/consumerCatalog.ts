import { z } from "zod";

import { getPool } from "../db";
import { resolveConsumerFeeConfig } from "./consumerCommerce";
import { resolvePublicUser } from "./publicUsers";
import { authenticatedProcedure, router } from "./trpc";

/**
 * Consumer marketplace READ layer (P2 consumer-parity wave, P2-A approved
 * exception): public discovery reads for the PWA /shop surface.
 *
 * No public/consumer catalog read procedure existed on main; this file is
 * the single approved addition. Every procedure is an authenticatedProcedure
 * and resolves the caller through resolvePublicUser (the same pattern as
 * consumerRouter.ts) so unauthenticated or unresolvable callers fail closed;
 * the resolved consumer id is additionally used to OWNERSHIP-SCOPE the
 * order-tracking read. All functions here are strictly read-only (SELECT
 * only).
 *
 * Data sources (DDL authority drizzle/0003_tigerbeetle_schema_audit.sql):
 * - public.service_verticals      — vertical discovery (is_active only).
 * - public.service_providers      — provider discovery. Customer-visible
 *   filter: lower(status) = 'active' — mirrors the platform-wide convention
 *   in server/_core/mobilityQueries.ts (provider_status enum: pending |
 *   active | suspended | rejected; only 'active' providers may be surfaced
 *   to consumers).
 * - public.provider_catalog_items — item discovery (is_available only);
 *   price is NUMERIC/TEXT MAJOR units and is returned verbatim as a string
 *   (priceMajor) — clients convert to minor units with exact string math,
 *   never float.
 * - public.membership_plans       — subscription plan discovery (is_active
 *   only); monthly_price is major units, returned verbatim as a string.
 * - public.order_tracking_events  — read-only tracking timeline, scoped via
 *   JOIN public.orders ON orders.id = order_id AND orders.customer_id =
 *   consumerUserId. A non-owned or nonexistent order returns [] — the same
 *   result as an owned order with no events — so the read never leaks the
 *   existence of another consumer's order (documented, deliberate).
 * - public.consumer_subscriptions — latest subscription row for the caller
 *   (any status), so /account/subscription can display the current period
 *   and cancel after a page reload.
 *
 * Fee config exposure (consumerFeeConfig) returns the PUBLIC pricing knobs
 * from resolveConsumerFeeConfig (consumerCommerce.ts) — platform fee bps
 * and the flat delivery fee in minor units — so the cart page can render an
 * exact ₦ fee projection that cannot drift from server-side checkout math.
 * Non-secret; still authenticated to keep the surface uniform.
 */

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable; no DB)
// ---------------------------------------------------------------------------

/** Clamp a page-limit input into [min, max]; non-finite falls back to default. */
export function clampLimit(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

/** Clamp an offset input to a non-negative integer. */
export function clampOffset(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function toIso(value: unknown): string | null {
  if (!value) return null;
  const d = new Date(value as string | Date);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ---------------------------------------------------------------------------
// Row types + mappers
// ---------------------------------------------------------------------------

export type ConsumerVertical = {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  icon: string | null;
};

export type ConsumerProvider = {
  id: number;
  verticalId: number;
  name: string;
  businessName: string;
  address: string | null;
  /** varchar rating, preserved as string ("4.50") — never float-parsed. */
  rating: string;
  status: string;
};

export type ConsumerCatalogItem = {
  id: number;
  providerId: number;
  sku: string;
  itemName: string;
  description: string | null;
  /** MAJOR-unit price string exactly as stored ("1500.00"). */
  priceMajor: string;
  currency: string;
};

export type ConsumerMembershipPlan = {
  id: number;
  planCode: string;
  planName: string;
  /** MAJOR-unit monthly price string exactly as stored. */
  monthlyPriceMajor: string;
  deliveryFeeDiscountMajor: string;
  prioritySupport: boolean;
  cashbackRateMajor: string;
  perks: unknown[];
};

export type ConsumerTrackingEvent = {
  id: number;
  eventType: string;
  statusLabel: string;
  etaMinutes: number | null;
  eventTime: string | null;
};

export type ConsumerSubscriptionRow = {
  id: string;
  planId: number;
  status: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  createdAt: string;
};

function mapVerticalRow(row: any): ConsumerVertical {
  return {
    id: Number(row.id),
    name: String(row.name),
    slug: String(row.slug),
    description: row.description ?? null,
    icon: row.icon ?? null,
  };
}

function mapProviderRow(row: any): ConsumerProvider {
  return {
    id: Number(row.id),
    verticalId: Number(row.vertical_id),
    name: String(row.name),
    businessName: String(row.business_name),
    address: row.address ?? null,
    rating: String(row.rating ?? "0"),
    status: String(row.status),
  };
}

function mapCatalogItemRow(row: any): ConsumerCatalogItem {
  return {
    id: Number(row.id),
    providerId: Number(row.provider_id),
    sku: String(row.sku),
    itemName: String(row.item_name),
    description: row.description ?? null,
    priceMajor: String(row.price),
    currency: String(row.currency ?? "NGN"),
  };
}

function mapMembershipPlanRow(row: any): ConsumerMembershipPlan {
  return {
    id: Number(row.id),
    planCode: String(row.plan_code),
    planName: String(row.plan_name),
    monthlyPriceMajor: String(row.monthly_price),
    deliveryFeeDiscountMajor: String(row.delivery_fee_discount ?? "0"),
    prioritySupport: Boolean(row.priority_support),
    cashbackRateMajor: String(row.cashback_rate ?? "0"),
    perks: Array.isArray(row.perks) ? row.perks : [],
  };
}

function mapTrackingEventRow(row: any): ConsumerTrackingEvent {
  return {
    id: Number(row.id),
    eventType: String(row.event_type),
    statusLabel: String(row.status_label),
    etaMinutes:
      row.eta_minutes === null || row.eta_minutes === undefined
        ? null
        : Number(row.eta_minutes),
    eventTime: toIso(row.event_time),
  };
}

function mapSubscriptionRow(row: any): ConsumerSubscriptionRow {
  return {
    id: String(row.id),
    planId: Number(row.plan_id),
    status: String(row.status),
    currentPeriodStart: toIso(row.current_period_start) ?? new Date(0).toISOString(),
    currentPeriodEnd: toIso(row.current_period_end) ?? new Date(0).toISOString(),
    createdAt: toIso(row.created_at) ?? new Date(0).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Active verticals, ordered by name. */
export async function listConsumerVerticals(): Promise<ConsumerVertical[]> {
  const pool = await getPool();
  const result = await pool.query(
    `SELECT id, name, slug, description, icon
     FROM public.service_verticals
     WHERE is_active
     ORDER BY name ASC`,
  );
  return result.rows.map(mapVerticalRow);
}

/**
 * Customer-visible providers in a vertical. Customer-visible means
 * lower(status) = 'active' (mobilityQueries.ts convention); limit clamped
 * to 1..50 (default 20).
 */
export async function listConsumerProviders(input: {
  verticalId: number;
  limit?: number;
  offset?: number;
}): Promise<ConsumerProvider[]> {
  const pool = await getPool();
  const limit = clampLimit(input.limit, 20, 1, 50);
  const offset = clampOffset(input.offset);
  const result = await pool.query(
    `SELECT id, vertical_id, name, business_name, address, rating, status
     FROM public.service_providers
     WHERE vertical_id = $1 AND lower(status) = 'active'
     ORDER BY business_name ASC
     LIMIT $2 OFFSET $3`,
    [input.verticalId, limit, offset],
  );
  return result.rows.map(mapProviderRow);
}

/**
 * Available catalog items for a customer-visible provider (is_available
 * only); limit clamped to 1..100 (default 50). Price returned verbatim as a
 * major-unit string.
 */
export async function listConsumerCatalog(input: {
  providerId: number;
  limit?: number;
  offset?: number;
}): Promise<ConsumerCatalogItem[]> {
  const pool = await getPool();
  const limit = clampLimit(input.limit, 50, 1, 100);
  const offset = clampOffset(input.offset);
  const result = await pool.query(
    `SELECT id, provider_id, sku, item_name, description, price, currency
     FROM public.provider_catalog_items
     WHERE provider_id = $1 AND is_available
     ORDER BY item_name ASC
     LIMIT $2 OFFSET $3`,
    [input.providerId, limit, offset],
  );
  return result.rows.map(mapCatalogItemRow);
}

/** Active membership plans, ordered by monthly price ascending. */
export async function listConsumerPlans(): Promise<ConsumerMembershipPlan[]> {
  const pool = await getPool();
  const result = await pool.query(
    `SELECT id, plan_code, plan_name, monthly_price, delivery_fee_discount,
            priority_support, cashback_rate, perks
     FROM public.membership_plans
     WHERE is_active
     ORDER BY monthly_price ASC, plan_name ASC`,
  );
  return result.rows.map(mapMembershipPlanRow);
}

/**
 * Read-only tracking timeline for one of the caller's own orders. Returns []
 * when the order is not owned by the caller (or does not exist) so the read
 * never leaks the existence of another consumer's order.
 */
export async function listConsumerOrderTrackingEvents(input: {
  consumerUserId: number;
  orderId: number;
}): Promise<ConsumerTrackingEvent[]> {
  const pool = await getPool();
  const result = await pool.query(
    `SELECT ote.id, ote.event_type, ote.status_label, ote.eta_minutes, ote.event_time
     FROM public.order_tracking_events ote
     JOIN public.orders o ON o.id = ote.order_id AND o.customer_id = $2
     WHERE ote.order_id = $1
     ORDER BY ote.event_time ASC
     LIMIT 100`,
    [input.orderId, input.consumerUserId],
  );
  return result.rows.map(mapTrackingEventRow);
}

/** Latest subscription row for the caller (any status), null when none. */
export async function getConsumerMySubscription(input: {
  consumerUserId: number;
}): Promise<ConsumerSubscriptionRow | null> {
  const pool = await getPool();
  const result = await pool.query(
    `SELECT id, plan_id, status, current_period_start, current_period_end, created_at
     FROM public.consumer_subscriptions
     WHERE consumer_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [input.consumerUserId],
  );
  const row = result.rows[0];
  return row ? mapSubscriptionRow(row) : null;
}

// ---------------------------------------------------------------------------
// Router (authenticated; resolvePublicUser fail-closed, same pattern as
// consumerRouter.ts)
// ---------------------------------------------------------------------------

export const consumerCatalogRouter = router({
  consumerVerticals: authenticatedProcedure.query(async ({ ctx }) => {
    await resolvePublicUser(ctx.user);
    return listConsumerVerticals();
  }),

  consumerProviders: authenticatedProcedure
    .input(
      z.object({
        verticalId: z.number().int().positive(),
        limit: z.number().int().min(1).max(50).default(20),
        offset: z.number().int().min(0).default(0),
      }),
    )
    .query(async ({ ctx, input }) => {
      await resolvePublicUser(ctx.user);
      return listConsumerProviders({
        verticalId: input.verticalId,
        limit: input.limit,
        offset: input.offset,
      });
    }),

  consumerCatalog: authenticatedProcedure
    .input(
      z.object({
        providerId: z.number().int().positive(),
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().min(0).default(0),
      }),
    )
    .query(async ({ ctx, input }) => {
      await resolvePublicUser(ctx.user);
      return listConsumerCatalog({
        providerId: input.providerId,
        limit: input.limit,
        offset: input.offset,
      });
    }),

  consumerPlans: authenticatedProcedure.query(async ({ ctx }) => {
    await resolvePublicUser(ctx.user);
    return listConsumerPlans();
  }),

  consumerFeeConfig: authenticatedProcedure.query(async ({ ctx }) => {
    await resolvePublicUser(ctx.user);
    const config = resolveConsumerFeeConfig();
    return {
      platformFeeBps: config.platformFeeBps,
      deliveryFeeMinor: config.deliveryFeeMinor,
      currency: "NGN",
    };
  }),

  consumerOrderTracking: authenticatedProcedure
    .input(z.object({ orderId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const publicUser = await resolvePublicUser(ctx.user);
      return listConsumerOrderTrackingEvents({
        consumerUserId: publicUser.id,
        orderId: input.orderId,
      });
    }),

  consumerMySubscription: authenticatedProcedure.query(async ({ ctx }) => {
    const publicUser = await resolvePublicUser(ctx.user);
    return getConsumerMySubscription({ consumerUserId: publicUser.id });
  }),
});
