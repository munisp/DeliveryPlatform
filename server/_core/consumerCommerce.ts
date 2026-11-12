import { randomInt } from "node:crypto";

import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { getPool } from "../db";
import { ENV } from "./env";
import { resilientFetch } from "./resilientFetch";

/**
 * Consumer commerce write/read layer (P1 consumer-parity wave): carts,
 * checkout, group orders, subscriptions and order ratings.
 *
 * Every function takes the caller's resolved `public.users.id`
 * (consumerUserId — see resolvePublicUser) and scopes every statement with
 * it; no procedure ever addresses another consumer's rows.
 *
 * Checkout is anchored on the public.consumer_checkout SECURITY DEFINER
 * function (drizzle/0104_consumer_commerce_core.sql): it validates
 * ownership/state, computes totals from the cart item snapshots, inserts the
 * legacy public.orders row (varchar major-unit amounts) and the checkout
 * session atomically, and is replay-safe on the idempotency key (same key +
 * same params returns the stored result; same key + different params raises
 * 22023, the 0102 pattern).
 *
 * Payment initiation then goes through the Go mojaloop service
 * (POST /quotes/request + POST /transfers/initiate) via resilientFetch.
 * If initiation fails the checkout session stays 'open' and the caller gets
 * a typed payment_initiation_failed error — the cart/order are never lost
 * and a retry with the same idempotency key resumes the same session.
 * Successful initiations are recorded in public.consumer_processed_events
 * (0072) so payment-side event consumers can dedupe on the session id.
 *
 * Marking orders paid on provider callback is a P2/P3 seam (payment-webhook
 * service); P1 checkout returns the 'payment_pending' flow shape only.
 */

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested directly; no DB, no env side effects)
// ---------------------------------------------------------------------------

/** bigint minor units -> legacy varchar major-unit string ("6600.00"). */
export function minorToMajorString(minor: number | bigint): string {
  const value = BigInt(minor);
  if (value < 0n) {
    throw new Error("negative_minor_units_not_supported");
  }
  return `${value / 100n}.${String(value % 100n).padStart(2, "0")}`;
}

/** Platform fee in minor units: floor(subtotal * bps / 10000), integer-exact. */
export function computePlatformFeeMinor(
  subtotalMinor: number | bigint,
  bps: number,
): number {
  return Number((BigInt(subtotalMinor) * BigInt(bps)) / 10000n);
}

export type ConsumerFeeConfig = {
  platformFeeBps: number;
  deliveryFeeMinor: number;
};

export const CONSUMER_PLATFORM_FEE_BPS_DEFAULT = 500;
export const CONSUMER_PLATFORM_FEE_BPS_MAX = 3000;
export const CONSUMER_DELIVERY_FEE_MINOR_DEFAULT = 50000;

function parseClampedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

// ENV carries the two consumer-fee knobs as raw optional strings
// (CONSUMER_PLATFORM_FEE_BPS / CONSUMER_DELIVERY_FEE_MINOR, surfaced by
// server/_core/env.ts as consumerPlatformFeeBps / consumerDeliveryFeeMinor).
// Parse-and-clamp lives here so the fee math is pure and unit-testable.
const consumerFeeEnv = ENV as unknown as {
  consumerPlatformFeeBps?: string;
  consumerDeliveryFeeMinor?: string;
};

export function resolveConsumerFeeConfig(raw?: {
  consumerPlatformFeeBps?: string;
  consumerDeliveryFeeMinor?: string;
}): ConsumerFeeConfig {
  const source = raw ?? consumerFeeEnv;
  return {
    platformFeeBps: parseClampedInteger(
      source.consumerPlatformFeeBps,
      CONSUMER_PLATFORM_FEE_BPS_DEFAULT,
      0,
      CONSUMER_PLATFORM_FEE_BPS_MAX,
    ),
    deliveryFeeMinor: parseClampedInteger(
      source.consumerDeliveryFeeMinor,
      CONSUMER_DELIVERY_FEE_MINOR_DEFAULT,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

// Crockford-ish alphabet (no I, L, O, U) for human-typed share codes.
const SHARE_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function generateShareCode(length = 8): string {
  let code = "";
  for (let i = 0; i < length; i += 1) {
    code += SHARE_CODE_ALPHABET[randomInt(SHARE_CODE_ALPHABET.length)];
  }
  return code;
}

// ---------------------------------------------------------------------------
// Shared zod input schemas (used by the router, unit-tested here)
// ---------------------------------------------------------------------------

export const consumerIdempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);

export const createCartInputSchema = z.object({
  serviceProviderId: z.number().int().positive().nullish(),
  verticalId: z.number().int().positive().nullish(),
  idempotencyKey: consumerIdempotencyKeySchema,
});

export const addCartItemInputSchema = z.object({
  cartId: z.string().uuid(),
  catalogItemId: z.number().int().positive().nullish(),
  name: z.string().trim().min(1).max(255),
  unitPriceMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  quantity: z.number().int().min(1).max(999),
  modifiers: z.array(z.record(z.string(), z.unknown())).max(50).default([]),
});

export const updateCartItemInputSchema = z.object({
  cartId: z.string().uuid(),
  itemId: z.string().uuid(),
  quantity: z.number().int().min(1).max(999),
});

export const removeCartItemInputSchema = z.object({
  cartId: z.string().uuid(),
  itemId: z.string().uuid(),
});

export const myCartInputSchema = z
  .object({ cartId: z.string().uuid().optional() })
  .optional();

export const checkoutInputSchema = z.object({
  cartId: z.string().uuid(),
  idempotencyKey: consumerIdempotencyKeySchema,
  deliveryAddress: z.string().trim().min(3).max(500),
  deliveryLat: z.number().min(-90).max(90),
  deliveryLng: z.number().min(-180).max(180),
  notes: z.string().trim().min(1).max(2000).nullish(),
});

export const myCheckoutSessionInputSchema = z.object({
  checkoutSessionId: z.string().uuid(),
});

export const createGroupOrderInputSchema = z.object({
  maxParticipants: z.number().int().min(2).max(32).default(8),
});

export const joinGroupOrderInputSchema = z.object({
  shareCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[0-9A-HJKMNP-TV-Z]{8}$/),
});

export const subscribePlanInputSchema = z.object({
  planId: z.number().int().positive(),
  idempotencyKey: consumerIdempotencyKeySchema,
});

export const cancelSubscriptionInputSchema = z.object({
  subscriptionId: z.string().uuid(),
});

const ratingSchema = z.number().int().min(1).max(5);

export const rateOrderInputSchema = z.object({
  orderId: z.number().int().positive(),
  overallRating: ratingSchema,
  punctualityRating: ratingSchema,
  professionalismRating: ratingSchema,
  vehicleConditionRating: ratingSchema,
  communicationRating: ratingSchema,
  feedback: z.string().trim().min(1).max(2000).nullish(),
});

// ---------------------------------------------------------------------------
// Row types + mappers
// ---------------------------------------------------------------------------

export type ConsumerCartItem = {
  id: string;
  cartId: string;
  catalogItemId: number | null;
  name: string;
  unitPriceMinor: string;
  quantity: number;
  modifiers: unknown[];
};

export type ConsumerCart = {
  id: string;
  consumerId: number;
  serviceProviderId: number | null;
  verticalId: number | null;
  status: string;
  idempotencyKey: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ConsumerCheckoutResult = {
  orderId: number;
  orderNumber: string;
  checkoutSessionId: string;
  status: string;
  subtotalMinor: number;
  platformFeeMinor: number;
  deliveryFeeMinor: number;
  totalMinor: number;
  currency: string;
  expiresAt: string;
  replayed: boolean;
  paymentReference: string | null;
  mojaloopTransferId: string | null;
};

function toIso(value: unknown): string | null {
  if (!value) return null;
  const d = new Date(value as string | Date);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function mapCartRow(row: any): ConsumerCart {
  return {
    id: String(row.id),
    consumerId: Number(row.consumer_id),
    serviceProviderId:
      row.service_provider_id === null || row.service_provider_id === undefined
        ? null
        : Number(row.service_provider_id),
    verticalId:
      row.vertical_id === null || row.vertical_id === undefined
        ? null
        : Number(row.vertical_id),
    status: String(row.status),
    idempotencyKey: row.idempotency_key ?? null,
    createdAt: toIso(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: toIso(row.updated_at) ?? new Date(0).toISOString(),
  };
}

function mapCartItemRow(row: any): ConsumerCartItem {
  return {
    id: String(row.id),
    cartId: String(row.cart_id),
    catalogItemId:
      row.catalog_item_id === null || row.catalog_item_id === undefined
        ? null
        : Number(row.catalog_item_id),
    name: String(row.name),
    unitPriceMinor: String(row.unit_price_minor),
    quantity: Number(row.quantity),
    modifiers: Array.isArray(row.modifiers) ? row.modifiers : [],
  };
}

/** Map the PostgreSQL error codes used by public.consumer_checkout (0102 conventions). */
function mapConsumerCheckoutError(error: unknown): never {
  const pgCode = (error as { code?: string })?.code;
  const message = (error as Error)?.message ?? "consumer_checkout_failed";
  if (error instanceof TRPCError) throw error;
  switch (pgCode) {
    case "22023":
      throw new TRPCError({ code: "BAD_REQUEST", message, cause: error });
    case "P0002":
      throw new TRPCError({ code: "NOT_FOUND", message, cause: error });
    case "42501":
      throw new TRPCError({ code: "FORBIDDEN", message, cause: error });
    case "23505":
    case "23514":
    case "55000":
      throw new TRPCError({ code: "CONFLICT", message, cause: error });
    default:
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "consumer_checkout_failed",
        cause: error,
      });
  }
}

// ---------------------------------------------------------------------------
// Carts
// ---------------------------------------------------------------------------

export async function createConsumerCart(input: {
  consumerUserId: number;
  serviceProviderId?: number | null;
  verticalId?: number | null;
  idempotencyKey: string;
}): Promise<ConsumerCart> {
  const pool = await getPool();
  const inserted = await pool.query(
    `INSERT INTO public.consumer_carts (consumer_id, service_provider_id, vertical_id, idempotency_key)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (consumer_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING *`,
    [
      input.consumerUserId,
      input.serviceProviderId ?? null,
      input.verticalId ?? null,
      input.idempotencyKey,
    ],
  );
  const row =
    inserted.rows[0] ??
    (
      await pool.query(
        `SELECT * FROM public.consumer_carts
         WHERE consumer_id = $1 AND idempotency_key = $2
         ORDER BY created_at DESC
         LIMIT 1`,
        [input.consumerUserId, input.idempotencyKey],
      )
    ).rows[0];
  if (!row) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "cart_write_failed",
    });
  }
  return mapCartRow(row);
}

type PoolLike = Awaited<ReturnType<typeof getPool>>;

async function requireOwnedActiveCart(
  pool: PoolLike,
  consumerUserId: number,
  cartId: string,
): Promise<void> {
  const result = await pool.query(
    `SELECT status FROM public.consumer_carts WHERE id = $1 AND consumer_id = $2 LIMIT 1`,
    [cartId, consumerUserId],
  );
  const cart = result.rows[0];
  if (!cart) {
    throw new TRPCError({ code: "NOT_FOUND", message: "cart_not_found_for_consumer" });
  }
  if (cart.status !== "active") {
    throw new TRPCError({ code: "CONFLICT", message: "cart_not_active" });
  }
}

export async function addConsumerCartItem(input: {
  consumerUserId: number;
  cartId: string;
  catalogItemId?: number | null;
  name: string;
  unitPriceMinor: number;
  quantity: number;
  modifiers: unknown[];
}): Promise<ConsumerCartItem> {
  const pool = await getPool();
  await requireOwnedActiveCart(pool, input.consumerUserId, input.cartId);
  const result = await pool.query(
    `INSERT INTO public.consumer_cart_items
       (cart_id, catalog_item_id, name, unit_price_minor, quantity, modifiers)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING *`,
    [
      input.cartId,
      input.catalogItemId ?? null,
      input.name,
      input.unitPriceMinor,
      input.quantity,
      JSON.stringify(input.modifiers),
    ],
  );
  return mapCartItemRow(result.rows[0]);
}

export async function updateConsumerCartItem(input: {
  consumerUserId: number;
  cartId: string;
  itemId: string;
  quantity: number;
}): Promise<ConsumerCartItem> {
  const pool = await getPool();
  await requireOwnedActiveCart(pool, input.consumerUserId, input.cartId);
  const result = await pool.query(
    `UPDATE public.consumer_cart_items
     SET quantity = $3, updated_at = now()
     WHERE id = $1 AND cart_id = $2
     RETURNING *`,
    [input.itemId, input.cartId, input.quantity],
  );
  const row = result.rows[0];
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "cart_item_not_found" });
  }
  return mapCartItemRow(row);
}

export async function removeConsumerCartItem(input: {
  consumerUserId: number;
  cartId: string;
  itemId: string;
}): Promise<{ removed: true }> {
  const pool = await getPool();
  await requireOwnedActiveCart(pool, input.consumerUserId, input.cartId);
  const result = await pool.query(
    `DELETE FROM public.consumer_cart_items WHERE id = $1 AND cart_id = $2 RETURNING id`,
    [input.itemId, input.cartId],
  );
  if (!result.rows[0]) {
    throw new TRPCError({ code: "NOT_FOUND", message: "cart_item_not_found" });
  }
  return { removed: true };
}

export async function getConsumerCart(input: {
  consumerUserId: number;
  cartId?: string;
}): Promise<{ cart: ConsumerCart; items: ConsumerCartItem[] } | null> {
  const pool = await getPool();
  const cartResult = input.cartId
    ? await pool.query(
        `SELECT * FROM public.consumer_carts WHERE id = $1 AND consumer_id = $2 LIMIT 1`,
        [input.cartId, input.consumerUserId],
      )
    : await pool.query(
        `SELECT * FROM public.consumer_carts
         WHERE consumer_id = $1 AND status = 'active'
         ORDER BY updated_at DESC
         LIMIT 1`,
        [input.consumerUserId],
      );
  const cartRow = cartResult.rows[0];
  if (!cartRow) return null;
  const itemsResult = await pool.query(
    `SELECT * FROM public.consumer_cart_items WHERE cart_id = $1 ORDER BY created_at`,
    [cartRow.id],
  );
  return {
    cart: mapCartRow(cartRow),
    items: itemsResult.rows.map(mapCartItemRow),
  };
}

// ---------------------------------------------------------------------------
// Checkout (public.consumer_checkout + Go mojaloop payment initiation)
// ---------------------------------------------------------------------------

const CHECKOUT_PAYMENT_CONSUMER = "consumer-commerce";
const CHECKOUT_PAYMENT_TOPIC = "consumer.checkout.payment";

function toSafeInteger(value: unknown, field: string): number {
  const n = Number(value ?? 0);
  if (!Number.isSafeInteger(n)) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `consumer_checkout_unsafe_integer:${field}`,
    });
  }
  return n;
}

/**
 * Run public.consumer_checkout, then initiate payment through the Go
 * mojaloop service (/quotes/request + /transfers/initiate).
 *
 * Failure semantics: if the payment service is unreachable or rejects, the
 * checkout session stays 'open', the cart stays checked_out and the orders
 * row stays 'pending' — the caller gets a typed payment_initiation_failed
 * error and retries with the SAME idempotency key, which replays the stored
 * checkout instead of double-charging. A session already in
 * payment_pending/paid returns without re-initiating.
 */
export async function checkoutConsumerCart(input: {
  consumerUserId: number;
  cartId: string;
  idempotencyKey: string;
  deliveryAddress: string;
  deliveryLat: number;
  deliveryLng: number;
  notes?: string | null;
}): Promise<ConsumerCheckoutResult> {
  const pool = await getPool();
  const feeConfig = resolveConsumerFeeConfig();

  const subtotalResult = await pool.query(
    `SELECT COALESCE(SUM(unit_price_minor * quantity), 0)::text AS subtotal
     FROM public.consumer_cart_items
     WHERE cart_id = $1`,
    [input.cartId],
  );
  const subtotalMinor = toSafeInteger(subtotalResult.rows[0]?.subtotal, "subtotal");
  const platformFeeMinor = computePlatformFeeMinor(subtotalMinor, feeConfig.platformFeeBps);
  const deliveryFeeMinor = feeConfig.deliveryFeeMinor;

  let raw: any;
  try {
    const result = await pool.query(
      `SELECT public.consumer_checkout($1, $2, $3, $4, $5, $6, $7, $8, $9) AS result`,
      [
        input.consumerUserId,
        input.cartId,
        input.idempotencyKey,
        input.deliveryAddress,
        input.deliveryLat,
        input.deliveryLng,
        input.notes ?? null,
        platformFeeMinor,
        deliveryFeeMinor,
      ],
    );
    raw = result.rows[0]?.result;
  } catch (error) {
    mapConsumerCheckoutError(error);
  }
  if (!raw) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "consumer_checkout_empty_result",
    });
  }

  const base: Omit<ConsumerCheckoutResult, "paymentReference" | "mojaloopTransferId"> = {
    orderId: toSafeInteger(raw.order_id, "order_id"),
    orderNumber: String(raw.order_number),
    checkoutSessionId: String(raw.checkout_session_id),
    status: String(raw.status),
    subtotalMinor: toSafeInteger(raw.subtotal_minor, "subtotal_minor"),
    platformFeeMinor: toSafeInteger(raw.platform_fee_minor, "platform_fee_minor"),
    deliveryFeeMinor: toSafeInteger(raw.delivery_fee_minor, "delivery_fee_minor"),
    totalMinor: toSafeInteger(raw.total_minor, "total_minor"),
    currency: String(raw.currency ?? "NGN"),
    expiresAt: toIso(raw.expires_at) ?? new Date(0).toISOString(),
    replayed: Boolean(raw.replayed),
  };

  const sessionResult = await pool.query(
    `SELECT status, payment_reference, mojaloop_transfer_id
     FROM public.consumer_checkout_sessions
     WHERE id = $1 AND consumer_id = $2
     LIMIT 1`,
    [base.checkoutSessionId, input.consumerUserId],
  );
  const session = sessionResult.rows[0];
  if (!session) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "checkout_session_missing_after_checkout",
    });
  }
  base.status = String(session.status);

  if (session.status === "payment_pending" || session.status === "paid") {
    return {
      ...base,
      paymentReference: session.payment_reference ?? null,
      mojaloopTransferId: session.mojaloop_transfer_id ?? null,
    };
  }

  const alreadyRecorded = await pool.query(
    `SELECT 1 FROM public.consumer_processed_events
     WHERE consumer_name = $1 AND topic = $2 AND event_id = $3
     LIMIT 1`,
    [CHECKOUT_PAYMENT_CONSUMER, CHECKOUT_PAYMENT_TOPIC, base.checkoutSessionId],
  );
  if (alreadyRecorded.rows[0]) {
    // Initiation was already recorded for this session (crash window between
    // initiation and session update); return the current state untouched.
    return {
      ...base,
      paymentReference: session.payment_reference ?? null,
      mojaloopTransferId: session.mojaloop_transfer_id ?? null,
    };
  }

  const initiation = await initiateMojaloopPayment({
    checkoutSessionId: base.checkoutSessionId,
    consumerUserId: input.consumerUserId,
    amountMinor: base.totalMinor,
    currency: base.currency,
  });

  await pool.query(
    `UPDATE public.consumer_checkout_sessions
     SET status = 'payment_pending',
         payment_reference = $2,
         mojaloop_transfer_id = $3,
         updated_at = now()
     WHERE id = $1`,
    [base.checkoutSessionId, initiation.paymentReference, initiation.transferId],
  );
  await pool.query(
    `INSERT INTO public.consumer_processed_events (consumer_name, topic, event_id, result_json)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (consumer_name, topic, event_id) DO NOTHING`,
    [
      CHECKOUT_PAYMENT_CONSUMER,
      CHECKOUT_PAYMENT_TOPIC,
      base.checkoutSessionId,
      JSON.stringify({
        payment_reference: initiation.paymentReference,
        mojaloop_transfer_id: initiation.transferId,
        order_id: base.orderId,
        total_minor: base.totalMinor,
        currency: base.currency,
      }),
    ],
  );

  return {
    ...base,
    status: "payment_pending",
    paymentReference: initiation.paymentReference,
    mojaloopTransferId: initiation.transferId,
  };
}

/**
 * Initiate a mojaloop quote + transfer pair for a checkout session. The ids
 * are derived deterministically from the session id so transport retries of
 * this call collapse onto the same quote/transfer inside the Go service
 * (which is itself idempotent on the Idempotency-Key header).
 *
 * Throws TRPCError(INTERNAL_SERVER_ERROR, 'payment_initiation_failed') on
 * any failure — the caller leaves the checkout session 'open'.
 */
async function initiateMojaloopPayment(input: {
  checkoutSessionId: string;
  consumerUserId: number;
  amountMinor: number;
  currency: string;
}): Promise<{ paymentReference: string; transferId: string }> {
  const baseUrl = ENV.mojaloopServiceUrl.replace(/\/$/, "");
  const paymentReference = `cp-${input.checkoutSessionId}`;
  const quoteId = `cq-${input.checkoutSessionId}`;
  const transferId = `ct-${input.checkoutSessionId}`;
  const payerFsp = `consumer-${input.consumerUserId}`;
  const payeeFsp = "switchos-platform";

  const headers = {
    "Content-Type": "application/json",
    "X-Internal-Service-Token": ENV.internalServiceToken,
  };

  try {
    const quoteResponse = await resilientFetch(`${baseUrl}/quotes/request`, {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": quoteId },
      body: JSON.stringify({
        quoteId,
        transactionId: paymentReference,
        payerFsp,
        payeeFsp,
        amountMinor: input.amountMinor,
        currency: input.currency,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!quoteResponse.ok) {
      throw new Error(`quote_http_${quoteResponse.status}`);
    }

    const transferResponse = await resilientFetch(`${baseUrl}/transfers/initiate`, {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": transferId },
      body: JSON.stringify({
        transferId,
        payerFsp,
        payeeFsp,
        amountMinor: input.amountMinor,
        currency: input.currency,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!transferResponse.ok) {
      throw new Error(`transfer_http_${transferResponse.status}`);
    }
  } catch (error) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "payment_initiation_failed",
      cause: error,
    });
  }

  return { paymentReference, transferId };
}

export async function getConsumerCheckoutSession(input: {
  consumerUserId: number;
  checkoutSessionId: string;
}): Promise<ConsumerCheckoutResult | null> {
  const pool = await getPool();
  const result = await pool.query(
    `SELECT cs.*, o.id AS linked_order_id, o.order_number
     FROM public.consumer_checkout_sessions cs
     LEFT JOIN public.orders o ON o.id = cs.order_id
     WHERE cs.id = $1 AND cs.consumer_id = $2
     LIMIT 1`,
    [input.checkoutSessionId, input.consumerUserId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    orderId: toSafeInteger(row.linked_order_id, "order_id"),
    orderNumber: row.order_number ? String(row.order_number) : "",
    checkoutSessionId: String(row.id),
    status: String(row.status),
    subtotalMinor: toSafeInteger(row.subtotal_minor, "subtotal_minor"),
    platformFeeMinor: toSafeInteger(row.platform_fee_minor, "platform_fee_minor"),
    deliveryFeeMinor: toSafeInteger(row.delivery_fee_minor, "delivery_fee_minor"),
    totalMinor: toSafeInteger(row.total_minor, "total_minor"),
    currency: String(row.currency ?? "NGN"),
    expiresAt: toIso(row.expires_at) ?? new Date(0).toISOString(),
    replayed: false,
    paymentReference: row.payment_reference ?? null,
    mojaloopTransferId: row.mojaloop_transfer_id ?? null,
  };
}

// ---------------------------------------------------------------------------
// Group orders
// ---------------------------------------------------------------------------

export type ConsumerGroupOrder = {
  id: string;
  hostConsumerId: number;
  status: string;
  shareCode: string;
  maxParticipants: number;
  participantCount: number;
  closedAt: string | null;
  createdAt: string;
};

function mapGroupOrderRow(row: any): ConsumerGroupOrder {
  return {
    id: String(row.id),
    hostConsumerId: Number(row.host_consumer_id),
    status: String(row.status),
    shareCode: String(row.share_code),
    maxParticipants: Number(row.max_participants),
    participantCount: Number(row.participant_count ?? 0),
    closedAt: toIso(row.closed_at),
    createdAt: toIso(row.created_at) ?? new Date(0).toISOString(),
  };
}

const GROUP_ORDER_SELECT = `
  SELECT g.*,
         (SELECT COUNT(*)::int FROM public.consumer_group_order_participants p
          WHERE p.group_id = g.id) AS participant_count
  FROM public.consumer_group_orders g
`;

export async function createConsumerGroupOrder(input: {
  consumerUserId: number;
  maxParticipants: number;
}): Promise<ConsumerGroupOrder> {
  const pool = await getPool();
  let lastError: unknown;
  // Retry share-code collisions (UNIQUE share_code) with a fresh code.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const shareCode = generateShareCode();
    try {
      const inserted = await pool.query(
        `INSERT INTO public.consumer_group_orders (host_consumer_id, share_code, max_participants)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [input.consumerUserId, shareCode, input.maxParticipants],
      );
      const group = inserted.rows[0];
      await pool.query(
        `INSERT INTO public.consumer_group_order_participants (group_id, consumer_id)
         VALUES ($1, $2)
         ON CONFLICT (group_id, consumer_id) DO NOTHING`,
        [group.id, input.consumerUserId],
      );
      return mapGroupOrderRow({ ...group, participant_count: 1 });
    } catch (error) {
      lastError = error;
      if ((error as { code?: string })?.code !== "23505") throw error;
    }
  }
  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "group_order_share_code_collision",
    cause: lastError,
  });
}

export async function joinConsumerGroupOrder(input: {
  consumerUserId: number;
  shareCode: string;
}): Promise<ConsumerGroupOrder & { alreadyJoined: boolean }> {
  const pool = await getPool();
  const groupResult = await pool.query(
    `${GROUP_ORDER_SELECT} WHERE g.share_code = $1 LIMIT 1`,
    [input.shareCode],
  );
  const group = groupResult.rows[0];
  if (!group) {
    throw new TRPCError({ code: "NOT_FOUND", message: "group_order_not_found" });
  }
  if (group.status !== "open") {
    throw new TRPCError({ code: "CONFLICT", message: "group_order_not_open" });
  }

  const joined = await pool.query(
    `INSERT INTO public.consumer_group_order_participants (group_id, consumer_id)
     VALUES ($1, $2)
     ON CONFLICT (group_id, consumer_id) DO NOTHING
     RETURNING consumer_id`,
    [group.id, input.consumerUserId],
  );
  const alreadyJoined = !joined.rows[0];
  if (alreadyJoined) {
    return { ...mapGroupOrderRow(group), alreadyJoined: true };
  }
  if (Number(group.participant_count) >= Number(group.max_participants)) {
    // Roll back the join so a full group never grows past its cap.
    await pool.query(
      `DELETE FROM public.consumer_group_order_participants
       WHERE group_id = $1 AND consumer_id = $2`,
      [group.id, input.consumerUserId],
    );
    throw new TRPCError({ code: "CONFLICT", message: "group_order_full" });
  }
  return {
    ...mapGroupOrderRow({
      ...group,
      participant_count: Number(group.participant_count) + 1,
    }),
    alreadyJoined: false,
  };
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

export type ConsumerSubscription = {
  id: string;
  consumerId: number;
  planId: number;
  status: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  idempotencyKey: string;
  createdAt: string;
};

function mapSubscriptionRow(row: any): ConsumerSubscription {
  return {
    id: String(row.id),
    consumerId: Number(row.consumer_id),
    planId: Number(row.plan_id),
    status: String(row.status),
    currentPeriodStart: toIso(row.current_period_start) ?? new Date(0).toISOString(),
    currentPeriodEnd: toIso(row.current_period_end) ?? new Date(0).toISOString(),
    idempotencyKey: String(row.idempotency_key),
    createdAt: toIso(row.created_at) ?? new Date(0).toISOString(),
  };
}

export async function subscribeConsumerPlan(input: {
  consumerUserId: number;
  planId: number;
  idempotencyKey: string;
}): Promise<ConsumerSubscription & { replayed: boolean }> {
  const pool = await getPool();

  const planResult = await pool.query(
    `SELECT id, is_active FROM public.membership_plans WHERE id = $1 LIMIT 1`,
    [input.planId],
  );
  const plan = planResult.rows[0];
  if (!plan) {
    throw new TRPCError({ code: "NOT_FOUND", message: "membership_plan_not_found" });
  }
  if (!plan.is_active) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "membership_plan_not_active" });
  }

  const existingResult = await pool.query(
    `SELECT * FROM public.consumer_subscriptions WHERE idempotency_key = $1 LIMIT 1`,
    [input.idempotencyKey],
  );
  const existing = existingResult.rows[0];
  if (existing) {
    if (
      Number(existing.consumer_id) !== input.consumerUserId ||
      Number(existing.plan_id) !== input.planId
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "idempotency key replay with different parameters",
      });
    }
    return { ...mapSubscriptionRow(existing), replayed: true };
  }

  try {
    const inserted = await pool.query(
      `INSERT INTO public.consumer_subscriptions
         (consumer_id, plan_id, current_period_start, current_period_end, idempotency_key)
       VALUES ($1, $2, now(), now() + interval '30 days', $3)
       RETURNING *`,
      [input.consumerUserId, input.planId, input.idempotencyKey],
    );
    return { ...mapSubscriptionRow(inserted.rows[0]), replayed: false };
  } catch (error) {
    if ((error as { code?: string })?.code === "23505") {
      const raced = await pool.query(
        `SELECT * FROM public.consumer_subscriptions WHERE idempotency_key = $1 LIMIT 1`,
        [input.idempotencyKey],
      );
      const racedRow = raced.rows[0];
      if (
        racedRow &&
        Number(racedRow.consumer_id) === input.consumerUserId &&
        Number(racedRow.plan_id) === input.planId
      ) {
        return { ...mapSubscriptionRow(racedRow), replayed: true };
      }
      throw new TRPCError({
        code: "CONFLICT",
        message: "idempotency key replay with different parameters",
        cause: error,
      });
    }
    throw error;
  }
}

export async function cancelConsumerSubscription(input: {
  consumerUserId: number;
  subscriptionId: string;
}): Promise<ConsumerSubscription> {
  const pool = await getPool();
  const updated = await pool.query(
    `UPDATE public.consumer_subscriptions
     SET status = 'cancelled', updated_at = now()
     WHERE id = $1 AND consumer_id = $2 AND status = 'active'
     RETURNING *`,
    [input.subscriptionId, input.consumerUserId],
  );
  const row = updated.rows[0];
  if (row) return mapSubscriptionRow(row);

  const existing = await pool.query(
    `SELECT status FROM public.consumer_subscriptions WHERE id = $1 AND consumer_id = $2 LIMIT 1`,
    [input.subscriptionId, input.consumerUserId],
  );
  if (!existing.rows[0]) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "subscription_not_found_for_consumer",
    });
  }
  throw new TRPCError({ code: "CONFLICT", message: "subscription_not_active" });
}

// ---------------------------------------------------------------------------
// Order ratings (driver_reviews, one per order via UNIQUE(order_id))
// ---------------------------------------------------------------------------

export async function rateConsumerOrder(input: {
  consumerUserId: number;
  orderId: number;
  overallRating: number;
  punctualityRating: number;
  professionalismRating: number;
  vehicleConditionRating: number;
  communicationRating: number;
  feedback?: string | null;
}): Promise<{ reviewId: number; orderId: number; driverId: number }> {
  const pool = await getPool();
  const orderResult = await pool.query(
    `SELECT id, driver_id, status::text AS status
     FROM public.orders
     WHERE id = $1 AND customer_id = $2
     LIMIT 1`,
    [input.orderId, input.consumerUserId],
  );
  const order = orderResult.rows[0];
  if (!order) {
    throw new TRPCError({ code: "NOT_FOUND", message: "order_not_found_for_consumer" });
  }
  if (order.driver_id === null || order.driver_id === undefined) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "order_has_no_driver" });
  }
  if (order.status !== "delivered") {
    throw new TRPCError({ code: "CONFLICT", message: "order_not_delivered" });
  }

  const inserted = await pool.query(
    `INSERT INTO public.driver_reviews (
       order_id, driver_id, customer_id,
       overall_rating, punctuality_rating, professionalism_rating,
       vehicle_condition_rating, communication_rating, feedback
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (order_id) DO NOTHING
     RETURNING id`,
    [
      input.orderId,
      order.driver_id,
      input.consumerUserId,
      input.overallRating,
      input.punctualityRating,
      input.professionalismRating,
      input.vehicleConditionRating,
      input.communicationRating,
      input.feedback ?? null,
    ],
  );
  const row = inserted.rows[0];
  if (!row) {
    throw new TRPCError({ code: "CONFLICT", message: "order_already_rated" });
  }
  return {
    reviewId: Number(row.id),
    orderId: input.orderId,
    driverId: Number(order.driver_id),
  };
}
