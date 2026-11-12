/**
 * Consumer commerce bridge for the consumer-parity program (P2-C).
 *
 * Typing bridge: the platform tRPC API is reached through the typed
 * template client (lib/trpc.ts). The mobile template's own AppRouter stub
 * does not declare the consumer router (it is hosted on the platform
 * server), so the client is cast once and the consumer surface is restored
 * with explicit local types mirroring the server contracts
 * (server/_core/consumerRouter.ts + consumerCommerce.ts + consumerQueries.ts
 * on main). Same approach as lib/rentalCondition.ts.
 *
 * Money discipline (contractual):
 *   - Carts / checkout sessions: integer MINOR units (kobo, NGN). Display
 *     via lib/money.ts formatMinor — integer math only, never floats.
 *   - Catalog prices (provider_catalog_items.price): TEXT MAJOR units.
 *     parseMajorToMinor converts with string math (no float rounding).
 *   - Orders / ledger (consumerQueries): number MAJOR units (legacy varchar
 *     columns), currency field carried per row ("EUR" default server-side).
 *     formatMajorAmount rounds major->minor once, then formats.
 *
 * OFFLINE BOUNDARY: every hook here is ONLINE-ONLY. Screens must gate writes
 * (cart mutations, checkout, subscribe, rate) behind connectivity and show
 * "requires connection" when offline; reads fall back to the PowerSync
 * replica (lib/consumerOffline.ts). See docs in each screen header.
 */
import { useMemo } from "react";

import { formatMinor, toNumber } from "@/lib/money";
import { trpc } from "@/lib/trpc";

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

const bridge = trpc as any;

function asQuery<T>(query: unknown): T {
  return query as T;
}

function asMutation<T>(mutation: unknown): T {
  return mutation as T;
}

// ---------------------------------------------------------------------------
// Contract-mirrored types (server/_core/consumerCommerce.ts, consumerQueries.ts)
// ---------------------------------------------------------------------------

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

export type ConsumerCartItem = {
  id: string;
  cartId: string;
  catalogItemId: number | null;
  name: string;
  /** bigint minor units over the wire (string). */
  unitPriceMinor: string;
  quantity: number;
  modifiers: unknown[];
};

export type ConsumerCartView = { cart: ConsumerCart; items: ConsumerCartItem[] };

export type CheckoutSessionStatus =
  | "open"
  | "payment_pending"
  | "paid"
  | "failed"
  | "expired";

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

export type ConsumerOrderSummary = {
  id: number;
  orderNumber: string;
  status: string;
  /** MAJOR units (legacy varchar column), digits=2. */
  totalAmount: number;
  currency: string;
  verticalName: string | null;
  providerName: string | null;
  driverName: string | null;
  deliveryAddress: string | null;
  estimatedDeliveryTime: string | null;
  actualDeliveryTime: string | null;
  createdAt: string;
  updatedAt: string;
  openSupportCases: number;
};

export type ConsumerOrderTimelineEvent = {
  kind:
    | "placed"
    | "pickup_scheduled"
    | "picked_up"
    | "delivered"
    | "delivery_estimate"
    | "status"
    | "transaction";
  label: string;
  occurredAt: string;
  detail: string | null;
};

export type ConsumerOrderDetail = {
  order: ConsumerOrderSummary & {
    platformFee: number;
    driverFee: number;
    pickupAddress: string | null;
    scheduledPickupTime: string | null;
    actualPickupTime: string | null;
    notes: string | null;
  };
  timeline: ConsumerOrderTimelineEvent[];
  ledger: Array<{
    id: number;
    transactionId: string;
    type: string;
    amount: number;
    currency: string;
    status: string;
    createdAt: string;
  }>;
  supportCases: Array<{
    id: number;
    ticketNumber: string;
    status: string;
    subject: string;
    createdAt: string;
  }>;
};

// ---------------------------------------------------------------------------
// Idempotency keys (Hermes-safe; satisfies ^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$)
// ---------------------------------------------------------------------------

export const CONSUMER_IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

const UUID_HEX = "0123456789abcdef";

function randomHex(length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += UUID_HEX[Math.floor(Math.random() * 16)];
  }
  return out;
}

/**
 * Crypto-UUID-shaped idempotency key ("<prefix>-<uuid-v4>"). Hermes does not
 * guarantee crypto.randomUUID, so the v4 shape is assembled from Math.random
 * (collision-safe at these lengths for per-device operation keys).
 */
export function newConsumerIdempotencyKey(prefix: string): string {
  const uuid =
    `${randomHex(8)}-${randomHex(4)}-4${randomHex(3)}` +
    `-${UUID_HEX[8 + Math.floor(Math.random() * 4)]}${randomHex(3)}` +
    `-${randomHex(12)}`;
  return `${prefix}-${uuid}`;
}

// ---------------------------------------------------------------------------
// Money helpers (integer-exact)
// ---------------------------------------------------------------------------

/**
 * TEXT major units ("1234.50", "1200", "0.5") -> integer minor units using
 * string math only. Returns null on malformed input. Handles up to 2
 * fractional digits (pads/truncates beyond that without float rounding).
 */
export function parseMajorToMinor(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const [whole, fraction = ""] = unsigned.split(".");
  const wholeMinor = Number(whole) * 100;
  if (!Number.isSafeInteger(wholeMinor)) return null;
  const fracPadded = (fraction + "00").slice(0, 2);
  const minor = wholeMinor + Number(fracPadded);
  return negative ? -minor : minor;
}

/** Format a TEXT/number MAJOR-unit amount ("120.00") via minor-unit math. */
export function formatMajorAmount(
  value: string | number | null | undefined,
  currency = "NGN",
): string {
  const minor = parseMajorToMinor(value);
  if (minor === null) return "—";
  return formatMinor(minor, currency);
}

/** Integer subtotal of cart items: sum(unitPriceMinor * quantity). */
export function cartSubtotalMinor(items: ConsumerCartItem[]): number {
  let subtotal = 0;
  for (const item of items) {
    subtotal += toNumber(item.unitPriceMinor) * item.quantity;
  }
  return subtotal;
}

// ---------------------------------------------------------------------------
// Checkout form validation (mirrors checkoutInputSchema)
// ---------------------------------------------------------------------------

export type CheckoutFormInput = {
  deliveryAddress: string;
  deliveryLat: number;
  deliveryLng: number;
  notes?: string;
};

export function validateCheckoutForm(input: CheckoutFormInput): string | null {
  const address = input.deliveryAddress.trim();
  if (address.length < 3 || address.length > 500) {
    return "Delivery address must be 3–500 characters";
  }
  if (!Number.isFinite(input.deliveryLat) || input.deliveryLat < -90 || input.deliveryLat > 90) {
    return "Latitude must be between -90 and 90";
  }
  if (!Number.isFinite(input.deliveryLng) || input.deliveryLng < -180 || input.deliveryLng > 180) {
    return "Longitude must be between -180 and 180";
  }
  if (input.notes !== undefined && input.notes.trim().length > 2000) {
    return "Notes must be at most 2000 characters";
  }
  return null;
}

/** Human label for a checkout session status (contractual enum). */
export function checkoutSessionStatusLabel(status: string): string {
  switch (status) {
    case "open":
      return "Awaiting payment initiation";
    case "payment_pending":
      return "Payment pending";
    case "paid":
      return "Paid";
    case "failed":
      return "Payment failed";
    case "expired":
      return "Session expired";
    default:
      return status;
  }
}

/** Ratings must be integers 1..5 (rateOrderInputSchema). */
export function isValidRating(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 5;
}

// ---------------------------------------------------------------------------
// Hooks — carts + checkout (ONLINE-ONLY writes)
// ---------------------------------------------------------------------------

export function useMyCart(cartId?: string) {
  return asQuery<{
    data: ConsumerCartView | null | undefined;
    isLoading: boolean;
    isError: boolean;
    refetch: () => Promise<unknown>;
  }>(
    bridge.consumer.myCart.useQuery(
      cartId ? { cartId } : undefined,
      { retry: 1 },
    ),
  );
}

export function useCreateCart() {
  return asMutation<{
    mutateAsync: (input: {
      serviceProviderId?: number | null;
      verticalId?: number | null;
      idempotencyKey: string;
    }) => Promise<ConsumerCart>;
    isPending: boolean;
  }>(bridge.consumer.createCart.useMutation());
}

export function useAddCartItem() {
  return asMutation<{
    mutateAsync: (input: {
      cartId: string;
      catalogItemId?: number | null;
      name: string;
      unitPriceMinor: number;
      quantity: number;
      modifiers: Record<string, unknown>[];
    }) => Promise<ConsumerCartItem>;
    isPending: boolean;
  }>(bridge.consumer.addCartItem.useMutation());
}

export function useUpdateCartItem() {
  return asMutation<{
    mutateAsync: (input: {
      cartId: string;
      itemId: string;
      quantity: number;
    }) => Promise<ConsumerCartItem>;
    isPending: boolean;
  }>(bridge.consumer.updateCartItem.useMutation());
}

export function useRemoveCartItem() {
  return asMutation<{
    mutateAsync: (input: { cartId: string; itemId: string }) => Promise<{ removed: true }>;
    isPending: boolean;
  }>(bridge.consumer.removeCartItem.useMutation());
}

export function useCheckout() {
  return asMutation<{
    mutateAsync: (input: {
      cartId: string;
      idempotencyKey: string;
      deliveryAddress: string;
      deliveryLat: number;
      deliveryLng: number;
      notes?: string | null;
    }) => Promise<ConsumerCheckoutResult>;
    isPending: boolean;
  }>(bridge.consumer.checkout.useMutation());
}

export function useMyCheckoutSession(checkoutSessionId: string | null, pollMs?: number) {
  return asQuery<{
    data: ConsumerCheckoutResult | null | undefined;
    isLoading: boolean;
    refetch: () => Promise<unknown>;
  }>(
    bridge.consumer.myCheckoutSession.useQuery(
      { checkoutSessionId: checkoutSessionId ?? "" },
      {
        enabled: checkoutSessionId !== null,
        refetchInterval: pollMs ?? false,
      },
    ),
  );
}

// ---------------------------------------------------------------------------
// Hooks — orders (reads; offline fallback lives in lib/consumerOffline.ts)
// ---------------------------------------------------------------------------

export function useMyOrders(limit = 25) {
  return asQuery<{
    data: ConsumerOrderSummary[] | undefined;
    isLoading: boolean;
    isError: boolean;
    refetch: () => Promise<unknown>;
  }>(bridge.consumer.myOrders.useQuery({ limit }, { retry: 1 }));
}

export function useMyOrderDetail(orderId: number | null) {
  return asQuery<{
    data: ConsumerOrderDetail | null | undefined;
    isLoading: boolean;
    isError: boolean;
  }>(
    bridge.consumer.myOrderDetail.useQuery(
      { orderId: orderId ?? -1 },
      { enabled: orderId !== null, retry: 1 },
    ),
  );
}

export function useRateOrder() {
  return asMutation<{
    mutateAsync: (input: {
      orderId: number;
      overallRating: number;
      punctualityRating: number;
      professionalismRating: number;
      vehicleConditionRating: number;
      communicationRating: number;
      feedback?: string | null;
    }) => Promise<{ reviewId: number; orderId: number; driverId: number }>;
    isPending: boolean;
  }>(bridge.consumer.rateOrder.useMutation());
}

// ---------------------------------------------------------------------------
// Hooks — subscriptions (ONLINE-ONLY writes)
// ---------------------------------------------------------------------------

export function useSubscribePlan() {
  return asMutation<{
    mutateAsync: (input: {
      planId: number;
      idempotencyKey: string;
    }) => Promise<ConsumerSubscription & { replayed: boolean }>;
    isPending: boolean;
  }>(bridge.consumer.subscribePlan.useMutation());
}

export function useCancelSubscription() {
  return asMutation<{
    mutateAsync: (input: { subscriptionId: string }) => Promise<ConsumerSubscription>;
    isPending: boolean;
  }>(bridge.consumer.cancelSubscription.useMutation());
}

/** Memoized checkout idempotency key, stable for the lifetime of a cart view. */
export function useCheckoutIdempotencyKey(cartId: string | null): string | null {
  return useMemo(
    () => (cartId ? newConsumerIdempotencyKey("co") : null),
    [cartId],
  );
}
