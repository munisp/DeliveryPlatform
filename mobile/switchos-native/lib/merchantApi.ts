/**
 * Merchant native API bridge (P4-N, WS-NATIVE merchant).
 *
 * Typed bridge over the deployed merchantSelfServe router (P3-M mount on
 * main, server/_core/merchantSelfServeRouter.ts):
 *   merchantSelfServe.myFulfillmentRequests   -> fulfillment inbox (merchant-scoped)
 *   merchantSelfServe.transitionMyFulfillment -> accept / reject / ready (idempotent)
 *   merchantSelfServe.myEarnings              -> earnings aggregates
 *   merchantSelfServe.updateStorefrontProfile -> owner-only display fields
 * Own-catalog reads: consumerCatalog.consumerCatalog(providerId) live, with
 * the PowerSync merchant_store replica (provider_catalog_items) as the
 * offline source. Provider identity resolves from the replica
 * service_providers row (merchant_store bucket pins the token's provider_id).
 *
 * MONEY: merchant earnings gross is TEXT MAJOR units (legacy varchar sum) —
 * display via formatMajorAmount; fulfillment writes carry no money. Catalog
 * prices are TEXT major end-to-end (never floats).
 *
 * OFFLINE BOUNDARY:
 *   - READS: fulfillments + earnings are ONLINE-ONLY (commerce schema is not
 *     replicated); catalog + storefront identity read from the replica when
 *     disconnected.
 *   - WRITES (transition / storefront update): ONLINE-ONLY. Offline attempts
 *     queue a SyncAction via lib/mobile/offline-sync-sqlite.ts (lane
 *     "merchant_catalog") for manual replay from the Queue tab.
 */
import {
  CONSUMER_IDEMPOTENCY_KEY_RE,
  newConsumerIdempotencyKey,
} from "@/lib/consumer";
import { trpc } from "@/lib/trpc";

const bridge = trpc as any;

function asQuery<T>(query: unknown): T {
  return query as T;
}

function asMutation<T>(mutation: unknown): T {
  return mutation as T;
}

// ---------------------------------------------------------------------------
// Idempotency keys (Hermes-safe; CONSUMER_IDEMPOTENCY_KEY_RE pattern)
// ---------------------------------------------------------------------------

export const MERCHANT_IDEMPOTENCY_KEY_RE = CONSUMER_IDEMPOTENCY_KEY_RE;

export function newMerchantIdempotencyKey(prefix: string): string {
  return newConsumerIdempotencyKey(prefix);
}

// ---------------------------------------------------------------------------
// Contract-mirrored types (server/_core/merchantSelfServe.ts)
// ---------------------------------------------------------------------------

export type MerchantFulfillmentStatus =
  | "requested"
  | "accepted"
  | "assigned"
  | "out_for_delivery"
  | "delivered"
  | "cancelled"
  | "failed";

export const MERCHANT_FULFILLMENT_STATUSES: readonly MerchantFulfillmentStatus[] = [
  "requested",
  "accepted",
  "assigned",
  "out_for_delivery",
  "delivered",
  "cancelled",
  "failed",
];

export type MerchantFulfillmentRequest = {
  id: string;
  providerId: number;
  medusaOrderId: string;
  state: string;
  deliveryOrderId: number | null;
  deliveryReference: string | null;
  failureReason: string | null;
  requestedAt: string;
  acceptedAt: string | null;
  updatedAt: string;
};

export type MerchantFulfillmentTransition = {
  fulfillmentId: string;
  providerId: number;
  previousState: string;
  state: string;
  replayed: boolean;
};

export type MerchantEarnings = {
  providerId: number;
  orderCount: number;
  deliveredOrderCount: number;
  /** TEXT MAJOR units (legacy varchar sum, exact decimal text). */
  grossDeliveredMajor: string;
  currency: string;
  fulfillmentsByState: Record<string, number>;
  payoutConfigured: boolean;
};

export type StorefrontProfile = {
  providerId: number;
  displayName: string;
  businessName: string;
  address: string | null;
  latitude: string | null;
  longitude: string | null;
  category: string | null;
  replayed: boolean;
};

/** Own-catalog item (consumerCatalog.consumerCatalog contractual shape). */
export type MerchantCatalogItem = {
  id: number;
  providerId: number;
  sku: string;
  itemName: string;
  description: string | null;
  /** TEXT MAJOR units. */
  priceMajor: string;
  currency: string;
};

/**
 * Merchant-legal fulfillment edges (server: accept -> requested→accepted,
 * reject -> requested→cancelled, ready -> accepted evidence event).
 */
export function merchantFulfillmentActions(state: string): Array<"accept" | "reject" | "ready"> {
  switch (state) {
    case "requested":
      return ["accept", "reject"];
    case "accepted":
      return ["ready"];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Hooks (writes ONLINE-ONLY)
// ---------------------------------------------------------------------------

export function useMyFulfillmentRequests(
  providerId: number | null,
  status?: MerchantFulfillmentStatus,
) {
  return asQuery<{
    data: MerchantFulfillmentRequest[] | undefined;
    isLoading: boolean;
    isError: boolean;
    refetch: () => Promise<unknown>;
  }>(
    bridge.merchantSelfServe.myFulfillmentRequests.useQuery(
      { providerId: providerId ?? -1, status, limit: 50 },
      { enabled: providerId !== null, retry: 1 },
    ),
  );
}

export function useTransitionMyFulfillment() {
  return asMutation<{
    mutateAsync: (input: {
      fulfillmentId: string;
      action: "accept" | "reject" | "ready";
      reason?: string;
      idempotencyKey: string;
    }) => Promise<MerchantFulfillmentTransition>;
    isPending: boolean;
  }>(bridge.merchantSelfServe.transitionMyFulfillment.useMutation());
}

export function useMerchantEarnings(providerId: number | null) {
  return asQuery<{
    data: MerchantEarnings | undefined;
    isLoading: boolean;
    isError: boolean;
  }>(
    bridge.merchantSelfServe.myEarnings.useQuery(
      { providerId: providerId ?? -1 },
      { enabled: providerId !== null, retry: 1 },
    ),
  );
}

export function useUpdateStorefrontProfile() {
  return asMutation<{
    mutateAsync: (input: {
      providerId: number;
      displayName?: string;
      address?: string;
      latitude?: number;
      longitude?: number;
      idempotencyKey: string;
    }) => Promise<StorefrontProfile>;
    isPending: boolean;
  }>(bridge.merchantSelfServe.updateStorefrontProfile.useMutation());
}

/** Own catalog, live read via consumerCatalog (now mounted on main). */
export function useMerchantCatalog(providerId: number | null) {
  return asQuery<{
    data: MerchantCatalogItem[] | undefined;
    isLoading: boolean;
    isError: boolean;
  }>(
    bridge.consumerCatalog.consumerCatalog.useQuery(
      { providerId: providerId ?? -1, limit: 100 },
      { enabled: providerId !== null, retry: false },
    ),
  );
}

// ---------------------------------------------------------------------------
// Offline queue fallback (SyncAction shape, lane merchant_catalog)
// ---------------------------------------------------------------------------

export const MERCHANT_QUEUE_LANE = "merchant_catalog" as const;

export type MerchantQueuedActionType =
  | "merchant_transition_fulfillment"
  | "merchant_update_storefront";

export type MerchantQueuedPayload = {
  kind: MerchantQueuedActionType;
  providerId: number;
  fulfillmentId?: string;
  action?: "accept" | "reject" | "ready";
  reason?: string;
  displayName?: string;
  address?: string;
  idempotencyKey: string;
  queuedAt: string;
};

export function buildMerchantQueuedAction(input: {
  accountId: string;
  kind: MerchantQueuedActionType;
  providerId: number;
  fulfillmentId?: string;
  action?: "accept" | "reject" | "ready";
  reason?: string;
  displayName?: string;
  address?: string;
  now?: Date;
}): {
  id: string;
  accountId: string;
  lane: typeof MERCHANT_QUEUE_LANE;
  type: string;
  payload: string;
  createdAt: string;
  attempts: number;
} {
  if (input.kind === "merchant_transition_fulfillment") {
    if (!input.fulfillmentId || !input.action) {
      throw new Error("merchant_transition_requires_fulfillment_and_action");
    }
    if (!["accept", "reject", "ready"].includes(input.action)) {
      throw new Error("merchant_transition_bad_action");
    }
  }
  if (input.kind === "merchant_update_storefront") {
    if (!input.displayName && !input.address) {
      throw new Error("merchant_storefront_requires_change");
    }
  }
  if (!Number.isInteger(input.providerId) || input.providerId <= 0) {
    throw new Error("merchant_provider_id_invalid");
  }
  const now = input.now ?? new Date();
  const idempotencyKey = newMerchantIdempotencyKey(
    input.kind === "merchant_transition_fulfillment" ? "mft" : "msp",
  );
  const payload: MerchantQueuedPayload = {
    kind: input.kind,
    providerId: input.providerId,
    fulfillmentId: input.fulfillmentId,
    action: input.action,
    reason: input.reason,
    displayName: input.displayName,
    address: input.address,
    idempotencyKey,
    queuedAt: now.toISOString(),
  };
  return {
    id: `${input.kind}-${idempotencyKey}`,
    accountId: input.accountId,
    lane: MERCHANT_QUEUE_LANE,
    type: input.kind,
    payload: JSON.stringify(payload),
    createdAt: now.toISOString(),
    attempts: 0,
  };
}

export function parseMerchantQueuedPayload(raw: string): MerchantQueuedPayload {
  const parsed = JSON.parse(raw) as MerchantQueuedPayload;
  if (
    parsed.kind !== "merchant_transition_fulfillment" &&
    parsed.kind !== "merchant_update_storefront"
  ) {
    throw new Error("merchant_queue_unknown_kind");
  }
  if (!MERCHANT_IDEMPOTENCY_KEY_RE.test(parsed.idempotencyKey)) {
    throw new Error("merchant_queue_bad_idempotency_key");
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Error mapping (merchantSelfServe mapMerchantSqlError pg-code contract)
// ---------------------------------------------------------------------------

export type MerchantApiErrorCode =
  | "forbidden" // 42501: not your portal / missing role
  | "not_found" // P0002
  | "conflict" // 23505/23514/55000: illegal state edge, duplicate
  | "bad_request" // 22023 + storefront_profile_no_changes
  | "offline"
  | "unknown";

export function mapMerchantApiError(error: unknown): MerchantApiErrorCode {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (message.includes("FORBIDDEN") || message.includes("merchant_portal_forbidden")) {
    return "forbidden";
  }
  if (message.includes("NOT_FOUND")) return "not_found";
  if (message.includes("CONFLICT") || message.includes("fulfillment_illegal_transition")) {
    return "conflict";
  }
  if (message.includes("BAD_REQUEST") || message.includes("storefront_profile_no_changes")) {
    return "bad_request";
  }
  if (message.includes("NETWORK") || message.includes("Failed to fetch")) return "offline";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Replica mappers (merchant_store bucket: service_providers + catalog)
// ---------------------------------------------------------------------------

export interface MerchantReplicaProviderRow {
  id: string;
  name: string;
  business_name: string | null;
  address: string | null;
  status: string;
}

/** Provider identity for the signed-in merchant (bucket pins provider_id). */
export function mapMerchantReplicaProviderRow(row: MerchantReplicaProviderRow): {
  providerId: number;
  name: string;
  businessName: string | null;
  address: string | null;
  status: string;
} {
  return {
    providerId: Number(row.id),
    name: row.name,
    businessName: row.business_name,
    address: row.address,
    status: row.status,
  };
}

export interface MerchantReplicaCatalogRow {
  id: string;
  provider_id: string;
  sku: string;
  item_name: string;
  description: string | null;
  price: string;
  currency: string;
  is_available: number;
}

export function mapMerchantReplicaCatalogRow(row: MerchantReplicaCatalogRow): MerchantCatalogItem {
  return {
    id: Number(row.id),
    providerId: Number(row.provider_id),
    sku: row.sku,
    itemName: row.item_name,
    description: row.description,
    priceMajor: row.price,
    currency: row.currency,
  };
}

export const MERCHANT_PROVIDER_SQL = `SELECT id, name, business_name, address, status
  FROM service_providers
 ORDER BY id
 LIMIT 1`;

export const MERCHANT_CATALOG_SQL = `SELECT id, provider_id, sku, item_name, description,
       price, currency, is_available
  FROM provider_catalog_items
 ORDER BY item_name
 LIMIT 200`;
