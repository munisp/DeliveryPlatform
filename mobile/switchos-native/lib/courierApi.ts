/**
 * Courier native API bridge (P4-N, WS-NATIVE courier).
 *
 * Typed bridge over the deployed platform routers (P3 mounts on main):
 *   driverDispatchFairness.listMyOffers   -> TransparentDriverOffer[] (offer inbox)
 *   driverDispatchFairness.declineOffer   -> reject with reason enum
 *   consumerRide.acceptRideOffer          -> { tripId, state } (driver-side, idempotent)
 *   consumerRide.myRideTrips / myRideTrip -> RIDER-scoped reads (contract note below)
 *   consumerRide.transitionRide           -> RIDER-scoped cancel|complete only
 *   pricingTransparency.getMyNetEarningsSummary -> courier earnings (integer kobo)
 *
 * CONTRACT NOTES (verified against server/_core/consumerRide.ts on main):
 *   - myRideTrips / myRideTrip filter WHERE rider_user_id = caller — they are
 *     rider-side reads, NOT courier trip views. Courier active-trip status
 *     comes from the PowerSync courier_assignments replica (orders where
 *     driver_id = bucket.driver_id) and from acceptRideOffer's returned
 *     tripId stored locally.
 *   - transitionRide only exposes rider-initiated cancel|complete
 *     (RIDE_TRANSITION_EDGES: everything else is worker/driver-owned
 *     server-side). The courier app never calls it; it is bridged for
 *     completeness but gated out of the courier UI.
 *
 * OFFLINE BOUNDARY:
 *   - READS: offers require connectivity (offer disclosures are not
 *     replicated); assigned orders/active trip read from the replica.
 *   - WRITES (accept / decline): ONLINE-ONLY. When offline the screen queues
 *     a SyncAction via lib/mobile/offline-sync-sqlite.ts (lane
 *     "driver_delivery") for manual replay from the Queue tab — the pure
 *     builders/parsers here are unit-tested in Node.
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

export const COURIER_IDEMPOTENCY_KEY_RE = CONSUMER_IDEMPOTENCY_KEY_RE;

export function newCourierIdempotencyKey(prefix: string): string {
  return newConsumerIdempotencyKey(prefix);
}

// ---------------------------------------------------------------------------
// Contract-mirrored types
// ---------------------------------------------------------------------------

/** driverDispatchFairness.listMyOffers row (server driverDispatchFairness.ts:37). */
export type CourierOffer = {
  offerId: string;
  tripId: string;
  expiresAt: string;
  pickupDistanceM: number;
  pickupEtaS: number;
  destinationAddress: string;
  destinationDistanceM: number;
  destinationDurationS: number;
  /** Integer kobo (server Number()s the BIGINT columns). */
  grossFareKobo: number;
  taxesAndFeesKobo: number;
  platformCommissionBp: number;
  platformCommissionKobo: number;
  expectedDriverNetKobo: number;
  disclosureVersion: string;
  driverEarningsFloorKobo: number | null;
  pickupSubsidyKobo: number | null;
  baseDriverNetKobo: number | null;
  economicsPolicyVersion: string | null;
};

export type AcceptRideOfferResult = { tripId: string; state: string };

export type DeclineOfferResult = {
  offerId: string;
  declined: boolean;
  replayed: boolean;
};

/** pricingTransparency.getMyNetEarningsSummary (offerEconomics.ts:220). */
export type CourierEarningsSummary = {
  currency: string;
  windowDays: number;
  offers: number;
  grossMinor: number | string;
  deadheadMinor: number | string;
  platformFeeMinor: number | string;
  netToDriverMinor: number | string;
};

/** Serialized mobility.ride_trip (rider-scoped read — see header). */
export type RideTrip = {
  id: string;
  riderUserId: number;
  state: string;
  zoneId: string;
  fareQuoteId: string | null;
  pickupAddress: string;
  destinationAddress: string;
  assignedDriverUserId: number | null;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  cancellationActor: string | null;
  cancellationCode: string | null;
  stateVersion: number;
  createdAt: string;
  updatedAt: string;
};

/** declineOffer reason enum (driverDispatchFairness.ts:137-144). */
export const COURIER_DECLINE_REASONS = [
  "pickup_distance_unprofitable",
  "pickup_time_unprofitable",
  "fare_insufficient",
  "destination_unsuitable",
  "safety_preference",
  "vehicle_constraint",
  "other",
] as const;

export type CourierDeclineReason = (typeof COURIER_DECLINE_REASONS)[number];

export function isCourierDeclineReason(value: string): value is CourierDeclineReason {
  return (COURIER_DECLINE_REASONS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Hooks (ONLINE-ONLY writes)
// ---------------------------------------------------------------------------

export function useCourierOffers() {
  return asQuery<{
    data: CourierOffer[] | undefined;
    isLoading: boolean;
    isError: boolean;
    refetch: () => Promise<unknown>;
  }>(bridge.driverDispatchFairness.listMyOffers.useQuery(undefined, { retry: 1 }));
}

export function useAcceptRideOffer() {
  return asMutation<{
    mutateAsync: (input: {
      offerId: string;
      idempotencyKey: string;
    }) => Promise<AcceptRideOfferResult>;
    isPending: boolean;
  }>(bridge.consumerRide.acceptRideOffer.useMutation());
}

export function useDeclineRideOffer() {
  return asMutation<{
    mutateAsync: (input: {
      offerId: string;
      reason: CourierDeclineReason;
      idempotencyKey: string;
    }) => Promise<DeclineOfferResult>;
    isPending: boolean;
  }>(bridge.driverDispatchFairness.declineOffer.useMutation());
}

/** RIDER-scoped (see header) — bridged for completeness, not courier UI. */
export function useMyRideTrips(limit = 20) {
  return asQuery<{ data: RideTrip[] | undefined; isLoading: boolean }>(
    bridge.consumerRide.myRideTrips.useQuery({ limit }, { retry: 1 }),
  );
}

/** RIDER-scoped (see header) — bridged for completeness, not courier UI. */
export function useMyRideTrip(tripId: string | null) {
  return asQuery<{ data: RideTrip | null | undefined; isLoading: boolean }>(
    bridge.consumerRide.myRideTrip.useQuery(
      { tripId: tripId ?? "" },
      { enabled: tripId !== null, retry: 1 },
    ),
  );
}

export function useCourierEarnings() {
  return asQuery<{
    data: CourierEarningsSummary | undefined;
    isLoading: boolean;
    isError: boolean;
  }>(bridge.pricingTransparency.getMyNetEarningsSummary.useQuery(undefined, { retry: 1 }));
}

// ---------------------------------------------------------------------------
// Offline queue fallback (lib/mobile/offline-sync-sqlite.ts SyncAction shape)
// ---------------------------------------------------------------------------

export const COURIER_QUEUE_LANE = "driver_delivery" as const;

export type CourierQueuedActionType =
  | "courier_accept_offer"
  | "courier_decline_offer";

export type CourierQueuedPayload = {
  kind: CourierQueuedActionType;
  offerId: string;
  reason?: CourierDeclineReason;
  idempotencyKey: string;
  queuedAt: string;
};

/** Build the SyncAction to enqueue when a write is attempted offline. */
export function buildCourierQueuedAction(input: {
  accountId: string;
  kind: CourierQueuedActionType;
  offerId: string;
  reason?: CourierDeclineReason;
  now?: Date;
}): {
  id: string;
  accountId: string;
  lane: typeof COURIER_QUEUE_LANE;
  type: string;
  payload: string;
  createdAt: string;
  attempts: number;
} {
  if (input.kind === "courier_decline_offer") {
    if (!input.reason || !isCourierDeclineReason(input.reason)) {
      throw new Error("courier_decline_reason_required");
    }
  }
  const now = input.now ?? new Date();
  const idempotencyKey = newCourierIdempotencyKey(
    input.kind === "courier_accept_offer" ? "coa" : "cod",
  );
  const payload: CourierQueuedPayload = {
    kind: input.kind,
    offerId: input.offerId,
    reason: input.reason,
    idempotencyKey,
    queuedAt: now.toISOString(),
  };
  return {
    id: `${input.kind}-${idempotencyKey}`,
    accountId: input.accountId,
    lane: COURIER_QUEUE_LANE,
    type: input.kind,
    payload: JSON.stringify(payload),
    createdAt: now.toISOString(),
    attempts: 0,
  };
}

/** Parse a queued action payload back (throws on unknown kind). */
export function parseCourierQueuedPayload(raw: string): CourierQueuedPayload {
  const parsed = JSON.parse(raw) as CourierQueuedPayload;
  if (parsed.kind !== "courier_accept_offer" && parsed.kind !== "courier_decline_offer") {
    throw new Error("courier_queue_unknown_kind");
  }
  if (!COURIER_IDEMPOTENCY_KEY_RE.test(parsed.idempotencyKey)) {
    throw new Error("courier_queue_bad_idempotency_key");
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Error mapping (server TRPCError codes/messages -> courier-facing codes)
// ---------------------------------------------------------------------------

export type CourierApiErrorCode =
  | "driver_not_verified"
  | "offer_not_acceptable"
  | "not_found"
  | "forbidden"
  | "conflict"
  | "offline"
  | "unknown";

export function mapCourierApiError(error: unknown): CourierApiErrorCode {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (message.includes("driver_not_verified")) return "driver_not_verified";
  if (message.includes("ride_offer_not_acceptable")) return "offer_not_acceptable";
  if (message.includes("ride_trip_not_found")) return "not_found";
  if (message.includes("FORBIDDEN")) return "forbidden";
  if (message.includes("CONFLICT")) return "conflict";
  if (message.includes("NETWORK") || message.includes("Failed to fetch")) return "offline";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Replica mappers (courier_assignments bucket: orders assigned to driver)
// ---------------------------------------------------------------------------

export interface CourierReplicaOrderRow {
  id: string;
  order_number: string;
  status: string;
  pickup_address: string | null;
  delivery_address: string | null;
  estimated_delivery_time: string | null;
  created_at: string;
}

export interface CourierAssignment {
  orderId: number;
  orderNumber: string;
  status: string;
  pickupAddress: string | null;
  deliveryAddress: string | null;
  estimatedDeliveryTime: string | null;
  createdAt: string;
}

export function mapCourierReplicaOrderRow(row: CourierReplicaOrderRow): CourierAssignment {
  return {
    orderId: Number(row.id),
    orderNumber: row.order_number,
    status: row.status,
    pickupAddress: row.pickup_address,
    deliveryAddress: row.delivery_address,
    estimatedDeliveryTime: row.estimated_delivery_time,
    createdAt: row.created_at,
  };
}

/** Replica SQL for the courier's assigned orders (active trip view). */
export const COURIER_ASSIGNMENTS_SQL = `SELECT id, order_number, status, pickup_address,
       delivery_address, estimated_delivery_time, created_at
  FROM orders
 ORDER BY created_at DESC
 LIMIT 25`;
