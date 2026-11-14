import { randomUUID } from "crypto";

import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { getPool } from "../db";
import { consumerIdempotencyKeySchema } from "./consumerCommerce";
import { getVerifiedDriverAccess } from "./driverOnboarding";
import {
  normalizePricingModelRow,
  type PlatformFeePayer,
  type PricingModel,
} from "./economicsPolicy";
import { ENV } from "./env";
import { resolvePublicUser } from "./publicUsers";
import { requestRideMatchAttempt } from "./rideMatchingClient";
import { authenticatedProcedure, router } from "./trpc";

/**
 * P3-R consumer ride-hailing (WS-RIDER). Resurrects the dormant 0026
 * ride-hailing dispatch substrate behind a consumer-facing tRPC surface:
 *
 * - requestRide: zone-gated (mobility.service_zone, city_code='LAG',
 *   active+dispatch_enabled, ST_Contains — fail-closed outside LAG zones),
 *   integer-kobo fare quote against the live mobility.fare_rule_version
 *   honouring the fare_quote CHECK (total = base+distance+time+demand+taxes),
 *   inserts mobility.ride_trip (dispatch source of truth) + a public
 *   .rider_trips mirror row (0073; the mirror has no FK back to ride_trip,
 *   so later transitions update the rider's latest non-terminal mirror row),
 *   dedupes via public.consumer_processed_events (consumer 'consumer-ride',
 *   topic 'consumer.ride.request', event_id = idempotency key), then
 *   fire-and-forget kicks the internal Go matching worker via
 *   rideMatchingClient (RIDE_MATCHING_WORKER_URL; fail-closed warn-once).
 * - transitionRide: rider-side state edges. cancel from
 *   requested|matching|driver_offered|driver_reserved -> 'cancelled'
 *   (rider cancellation, no fee charged at this surface — documented).
 *   complete from in_progress -> 'completed_pending_payment' then runs the
 *   EXACT mojaloop initiation pattern from
 *   consumerCommerce.checkoutConsumerCart: deterministic ids
 *   (quote rq-{tripId}, transfer rt-{tripId}, reference rp-{tripId}),
 *   X-Internal-Service-Token header, resilient timeout, crash-window guard
 *   via consumer_processed_events (topic 'consumer.ride.payment'): the
 *   dedupe record is written only after a successful initiation, so a crash
 *   between initiation and the record is healed on retry because the Go
 *   side collapses duplicate deterministic quote/transfer ids.
 * - acceptRideOffer: driver-side. Gates through getVerifiedDriverAccess
 *   (same fail-closed pattern as
 *   driverDispatchFairness.listTransparentDriverOffers) then delegates the
 *   state machine to SECURITY DEFINER mobility.accept_driver_offer.
 * - rateTrip: wraps SECURITY DEFINER mobility.submit_trip_feedback
 *   (0043:165). One rating per (trip, author) enforced by
 *   UNIQUE(trip_id, author_user_id); a replay with the same key returns the
 *   stored feedback id; 23505 surfaces as trip_already_rated.
 *
 * Money is integer kobo end-to-end (bigint columns). The rider NEVER sees
 * float arithmetic: all quote math below is integer floor division.
 *
 * P7 flexible pricing modes (drizzle/0106): the zone's live
 * fare_rule_version carries a pricing block (pricing_model /
 * platform_fee_flat_kobo / platform_fee_payer, normalized via
 * economicsPolicy.normalizePricingModelRow). A flat_fee model adds a
 * platform_fee_kobo line to the quote — RIDER-PAID fees are inside
 * total_kobo (rider pays fare + fee), DRIVER-PAID fees are recorded on the
 * quote but sit OUTSIDE total_kobo (they come out of the driver share at
 * settlement). The quote payload exposes platformFeeKobo / feePayer /
 * pricingModel for the RideStatus fare breakdown. Legacy rows resolve to
 * the commission default and quote exactly as before.
 */

export const rideTripStateSchema = z.enum([
  "quote_created",
  "requested",
  "matching",
  "driver_offered",
  "driver_reserved",
  "driver_en_route",
  "driver_arrived",
  "pickup_verified",
  "in_progress",
  "completed_pending_payment",
  "completed",
  "cancelled",
  "unfulfilled",
  "payment_failed",
  "payment_review",
  "safety_paused",
  "disputed",
  "refunded",
]);
export type RideTripState = z.infer<typeof rideTripStateSchema>;

export const RIDE_TERMINAL_STATES: ReadonlySet<RideTripState> = new Set([
  "completed",
  "cancelled",
  "unfulfilled",
  "refunded",
]);

/** Rider-initiated transitions (everything else is worker/driver owned). */
export const RIDE_TRANSITION_EDGES: Readonly<
  Record<"cancel" | "complete", ReadonlyArray<RideTripState>>
> = {
  cancel: ["requested", "matching", "driver_offered", "driver_reserved"],
  complete: ["in_progress"],
};

const RIDE_CONSUMER_NAME = "consumer-ride";
const RIDE_REQUEST_TOPIC = "consumer.ride.request";
const RIDE_PAYMENT_TOPIC = "consumer.ride.payment";
const RIDE_CITY_CODE = "LAG";
const ROUTE_PROVIDER = "haversine";
const ROUTE_PROVIDER_VERSION = "1";
const QUOTE_TTL_MINUTES = 10;
/** Assumed average urban speed for the haversine duration estimate. */
const AVERAGE_SPEED_METRES_PER_SECOND = 8; // ~28.8 km/h

export const requestRideInputSchema = z.object({
  pickupLat: z.number().min(-90).max(90),
  pickupLng: z.number().min(-180).max(180),
  pickupAddress: z.string().trim().min(3).max(255),
  destinationLat: z.number().min(-90).max(90),
  destinationLng: z.number().min(-180).max(180),
  destinationAddress: z.string().trim().min(3).max(255),
  idempotencyKey: consumerIdempotencyKeySchema,
});

export const transitionRideInputSchema = z.object({
  tripId: z.string().uuid(),
  action: z.enum(["cancel", "complete"]),
  cancellationCode: z.string().trim().min(1).max(64).optional(),
  idempotencyKey: consumerIdempotencyKeySchema,
});

export const acceptRideOfferInputSchema = z.object({
  offerId: z.string().uuid(),
  idempotencyKey: consumerIdempotencyKeySchema,
});

export const rateTripInputSchema = z.object({
  tripId: z.string().uuid(),
  score: z.number().int().min(1).max(5),
  tags: z.array(z.string().trim().min(1).max(64)).max(8).default([]),
  comment: z.string().trim().min(1).max(1000).optional(),
  idempotencyKey: consumerIdempotencyKeySchema,
});

// ---------------------------------------------------------------------------
// Pure quote math (integer kobo only — unit-tested at the pool boundary).
// ---------------------------------------------------------------------------

export type RideFareRule = {
  fareRuleId: string;
  baseKobo: bigint;
  perKmKobo: bigint;
  perMinuteKobo: bigint;
  minimumKobo: bigint;
  cancellationKobo: bigint;
  demandCapBasisPoints: number;
};

export function haversineDistanceMeters(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const earthRadiusMeters = 6_371_000;
  const dLat = toRadians(toLat - fromLat);
  const dLng = toRadians(toLng - fromLng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(fromLat)) *
      Math.cos(toRadians(toLat)) *
      Math.sin(dLng / 2) ** 2;
  const meters = 2 * earthRadiusMeters * Math.asin(Math.min(1, Math.sqrt(a)));
  return Math.max(0, Math.round(meters));
}

export function estimateRideDurationSeconds(distanceMeters: number): number {
  return Math.max(
    60,
    Math.ceil(distanceMeters / AVERAGE_SPEED_METRES_PER_SECOND),
  );
}

export type RideQuoteAmounts = {
  baseKobo: bigint;
  distanceKobo: bigint;
  timeKobo: bigint;
  demandKobo: bigint;
  taxesAndFeesKobo: bigint;
  platformFeeKobo: bigint;
  feePayer: PlatformFeePayer;
  pricingModel: PricingModel;
  totalKobo: bigint;
};

/** P7 pricing block applied to a quote (normalized from the fare rule). */
export type RideQuotePricing = {
  model: PricingModel;
  flatFeeKobo: bigint;
  feePayer: PlatformFeePayer;
};

/** Pre-P7 behaviour: commission model, no platform fee. */
export const DEFAULT_RIDE_QUOTE_PRICING: RideQuotePricing = {
  model: "commission",
  flatFeeKobo: 0n,
  feePayer: "rider",
};

/**
 * Integer-kobo quote. demandBasisPoints is clamped to the zone's
 * demand_cap_basis_points (DDL guarantees >= 10000, i.e. no negative demand
 * is possible). Any shortfall to the zone minimum fare is itemised into
 * taxes_and_fees_kobo. The fare_quote total identity (REPLACED by
 * drizzle/0106) holds both ways: total = base + distance + time + demand +
 * taxes + (platform fee when rider-paid) — a rider-paid flat fee is inside
 * the total, a driver-paid flat fee is recorded on the row but leaves the
 * total unchanged.
 */
export function computeRideQuoteAmounts(
  rule: RideFareRule,
  distanceMeters: number,
  durationSeconds: number,
  demandBasisPoints = 0,
  pricing: RideQuotePricing = DEFAULT_RIDE_QUOTE_PRICING,
): RideQuoteAmounts {
  const baseKobo = rule.baseKobo;
  const distanceKobo =
    (rule.perKmKobo * BigInt(Math.max(0, Math.trunc(distanceMeters)))) /
    1000n;
  const timeKobo =
    (rule.perMinuteKobo * BigInt(Math.max(0, Math.trunc(durationSeconds)))) /
    60n;
  const appliedDemandBps = Math.min(
    Math.max(0, Math.trunc(demandBasisPoints)),
    rule.demandCapBasisPoints,
  );
  const subtotal = baseKobo + distanceKobo + timeKobo;
  const demandKobo = (subtotal * BigInt(appliedDemandBps)) / 10000n;
  const preTax = subtotal + demandKobo;
  const taxesAndFeesKobo =
    rule.minimumKobo > preTax ? rule.minimumKobo - preTax : 0n;
  const platformFeeKobo =
    pricing.model === "flat_fee" && pricing.flatFeeKobo > 0n
      ? pricing.flatFeeKobo
      : 0n;
  const riderPaidFee =
    pricing.feePayer === "rider" ? platformFeeKobo : 0n;
  return {
    baseKobo,
    distanceKobo,
    timeKobo,
    demandKobo,
    taxesAndFeesKobo,
    platformFeeKobo,
    feePayer: pricing.feePayer,
    pricingModel: pricing.model,
    totalKobo: preTax + taxesAndFeesKobo + riderPaidFee,
  };
}

export function assertRideTransition(
  action: "cancel" | "complete",
  state: RideTripState,
): void {
  if (RIDE_TERMINAL_STATES.has(state)) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "ride_trip_terminal",
    });
  }
  if (!RIDE_TRANSITION_EDGES[action].includes(state)) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `ride_transition_invalid:${state}->${action}`,
    });
  }
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

type ZoneRuleRow = {
  zone_id: string;
  zone_code: string;
  display_name: string;
  fare_rule_id: string;
  base_kobo: string | number;
  per_km_kobo: string | number;
  per_minute_kobo: string | number;
  minimum_kobo: string | number;
  cancellation_kobo: string | number;
  demand_cap_basis_points: number;
  // P7 pricing block (drizzle/0106 columns on fare_rule_version).
  pricing_model: string | null;
  platform_fee_flat_kobo: string | number | null;
  platform_fee_payer: string | null;
};

type RideTripRow = {
  id: string;
  rider_user_id: number;
  state: RideTripState;
  zone_id: string;
  fare_quote_id: string;
  pickup_address: string;
  destination_address: string;
  assigned_driver_user_id: number | null;
  requested_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  cancellation_actor: string | null;
  cancellation_code: string | null;
  state_version: string | number;
  created_at: string;
  updated_at: string;
};

function toBigInt(value: string | number | bigint): bigint {
  if (typeof value === "bigint") return value;
  return BigInt(value);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listMyRideTrips(input: {
  consumerUserId: number;
  limit?: number;
}) {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
  const result = await (await getPool()).query<RideTripRow>(
    `SELECT id, rider_user_id, state, zone_id, fare_quote_id,
            pickup_address, destination_address, assigned_driver_user_id,
            requested_at, started_at, completed_at,
            cancellation_actor, cancellation_code, state_version,
            created_at, updated_at
       FROM mobility.ride_trip
      WHERE rider_user_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [input.consumerUserId, limit],
  );
  return result.rows.map((row) => serializeTrip(row));
}

export async function getMyRideTrip(input: {
  consumerUserId: number;
  tripId: string;
}) {
  const pool = await getPool();
  const tripResult = await pool.query<RideTripRow>(
    `SELECT id, rider_user_id, state, zone_id, fare_quote_id,
            pickup_address, destination_address, assigned_driver_user_id,
            requested_at, started_at, completed_at,
            cancellation_actor, cancellation_code, state_version,
            created_at, updated_at
       FROM mobility.ride_trip
      WHERE id = $1 AND rider_user_id = $2`,
    [input.tripId, input.consumerUserId],
  );
  const trip = tripResult.rows[0];
  if (!trip) {
    throw new TRPCError({ code: "NOT_FOUND", message: "ride_trip_not_found" });
  }

  const [quoteResult, eventsResult, paymentResult] = await Promise.all([
    pool.query<{
      id: string;
      base_kobo: string | number;
      distance_kobo: string | number;
      time_kobo: string | number;
      demand_kobo: string | number;
      taxes_and_fees_kobo: string | number;
      platform_fee_kobo: string | number;
      total_kobo: string | number;
      quoted_distance_m: number;
      quoted_duration_s: number;
      route_provider: string;
      expires_at: string;
      created_at: string;
      pricing_model: string | null;
      platform_fee_payer: string | null;
    }>(
      `SELECT fq.id, fq.base_kobo, fq.distance_kobo, fq.time_kobo,
              fq.demand_kobo, fq.taxes_and_fees_kobo,
              fq.platform_fee_kobo, fq.total_kobo,
              fq.quoted_distance_m, fq.quoted_duration_s, fq.route_provider,
              fq.expires_at, fq.created_at,
              frv.pricing_model, frv.platform_fee_payer
         FROM mobility.fare_quote fq
         JOIN mobility.fare_rule_version frv ON frv.id = fq.fare_rule_id
        WHERE fq.id = $1`,
      [trip.fare_quote_id],
    ),
    pool.query<{
      id: string;
      sequence_no: number;
      event_type: string;
      actor_kind: string;
      previous_state: RideTripState | null;
      next_state: RideTripState | null;
      occurred_at: string;
    }>(
      `SELECT id, sequence_no, event_type, actor_kind,
              previous_state, next_state, occurred_at
         FROM mobility.trip_event
        WHERE trip_id = $1
        ORDER BY sequence_no ASC
        LIMIT 100`,
      [input.tripId],
    ),
    pool.query<{ result_json: { paymentReference?: string } | null }>(
      `SELECT result_json
         FROM public.consumer_processed_events
        WHERE consumer_name = $1 AND topic = $2 AND event_id = $3`,
      [RIDE_CONSUMER_NAME, RIDE_PAYMENT_TOPIC, trip.id],
    ),
  ]);

  const quote = quoteResult.rows[0];
  const quotePricing = quote
    ? normalizePricingModelRow({
        pricing_model: quote.pricing_model,
        platform_fee_flat_kobo: null,
        platform_fee_payer: quote.platform_fee_payer,
      })
    : null;
  return {
    trip: serializeTrip(trip),
    quote: quote
      ? {
          quoteId: quote.id,
          baseKobo: quote.base_kobo.toString(),
          distanceKobo: quote.distance_kobo.toString(),
          timeKobo: quote.time_kobo.toString(),
          demandKobo: quote.demand_kobo.toString(),
          taxesAndFeesKobo: quote.taxes_and_fees_kobo.toString(),
          platformFeeKobo: quote.platform_fee_kobo.toString(),
          feePayer: quotePricing?.feePayer ?? "rider",
          pricingModel: quotePricing?.model ?? "commission",
          totalKobo: quote.total_kobo.toString(),
          quotedDistanceM: quote.quoted_distance_m,
          quotedDurationS: quote.quoted_duration_s,
          routeProvider: quote.route_provider,
          expiresAt: quote.expires_at,
          createdAt: quote.created_at,
        }
      : null,
    events: eventsResult.rows.map((event) => ({
      id: event.id,
      sequenceNo: event.sequence_no,
      eventType: event.event_type,
      actorKind: event.actor_kind,
      previousState: event.previous_state,
      nextState: event.next_state,
      occurredAt: event.occurred_at,
    })),
    paymentReference:
      paymentResult.rows[0]?.result_json?.paymentReference ?? null,
  };
}

function serializeTrip(row: RideTripRow) {
  return {
    tripId: row.id,
    riderUserId: row.rider_user_id,
    state: row.state,
    zoneId: row.zone_id,
    fareQuoteId: row.fare_quote_id,
    pickupAddress: row.pickup_address,
    destinationAddress: row.destination_address,
    assignedDriverUserId: row.assigned_driver_user_id,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    cancellationActor: row.cancellation_actor,
    cancellationCode: row.cancellation_code,
    stateVersion:
      typeof row.state_version === "string"
        ? Number(row.state_version)
        : row.state_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isTerminal: RIDE_TERMINAL_STATES.has(row.state),
  };
}

// ---------------------------------------------------------------------------
// requestRide
// ---------------------------------------------------------------------------

export type RequestRideResult = {
  tripId: string;
  state: RideTripState;
  totalKobo: string;
  currency: "NGN";
  replayed: boolean;
  matchingDispatched: boolean;
  /** P7 pricing disclosure (populated on the fresh-request path). */
  platformFeeKobo?: string;
  feePayer?: PlatformFeePayer;
  pricingModel?: PricingModel;
};

export async function requestRide(
  input: z.infer<typeof requestRideInputSchema> & { consumerUserId: number },
): Promise<RequestRideResult> {
  const pool = await getPool();

  // Idempotent replay: a previously processed request key returns the same
  // trip without inserting anything.
  const existing = await pool.query<{
    result_json: { tripId?: string } | null;
  }>(
    `SELECT result_json
       FROM public.consumer_processed_events
      WHERE consumer_name = $1 AND topic = $2 AND event_id = $3`,
    [RIDE_CONSUMER_NAME, RIDE_REQUEST_TOPIC, input.idempotencyKey],
  );
  const existingTripId = existing.rows[0]?.result_json?.tripId;
  if (existingTripId) {
    const trip = await pool.query<{ id: string; state: RideTripState }>(
      `SELECT id, state FROM mobility.ride_trip WHERE id = $1 AND rider_user_id = $2`,
      [existingTripId, input.consumerUserId],
    );
    if (trip.rows[0]) {
      const quote = await pool.query<{ total_kobo: string | number }>(
        `SELECT fq.total_kobo
           FROM mobility.ride_trip rt
           JOIN mobility.fare_quote fq ON fq.id = rt.fare_quote_id
          WHERE rt.id = $1`,
        [existingTripId],
      );
      return {
        tripId: existingTripId,
        state: trip.rows[0].state,
        totalKobo: (quote.rows[0]?.total_kobo ?? 0).toString(),
        currency: "NGN",
        replayed: true,
        matchingDispatched: false,
      };
    }
    // Fall through: the recorded trip is not visible to this caller; treat
    // as a fresh request (defensive — should never happen).
  }

  // LAG zone resolution, fail-closed.
  const zoneResult = await pool.query<ZoneRuleRow>(
    `SELECT sz.id AS zone_id, sz.zone_code, sz.display_name,
            frv.id AS fare_rule_id, frv.base_kobo, frv.per_km_kobo,
            frv.per_minute_kobo, frv.minimum_kobo, frv.cancellation_kobo,
            frv.demand_cap_basis_points,
            frv.pricing_model, frv.platform_fee_flat_kobo,
            frv.platform_fee_payer
       FROM mobility.service_zone sz
       JOIN mobility.fare_rule_version frv
         ON frv.zone_id = sz.id
        AND frv.effective_from <= now()
        AND (frv.effective_to IS NULL OR frv.effective_to > now())
      WHERE sz.city_code = $3
        AND sz.active
        AND sz.dispatch_enabled
        AND sz.effective_from <= now()
        AND (sz.effective_to IS NULL OR sz.effective_to > now())
        AND ST_Contains(
              sz.boundary,
              ST_SetSRID(ST_MakePoint($2, $1), 4326)::geometry
            )
      ORDER BY frv.effective_from DESC
      LIMIT 1`,
    [input.pickupLat, input.pickupLng, RIDE_CITY_CODE],
  );
  const zone = zoneResult.rows[0];
  if (!zone) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "ride_zone_unavailable",
    });
  }

  const distanceMeters = haversineDistanceMeters(
    input.pickupLat,
    input.pickupLng,
    input.destinationLat,
    input.destinationLng,
  );
  const durationSeconds = estimateRideDurationSeconds(distanceMeters);
  // P7: resolve the zone pricing block (via economicsPolicy normalization)
  // from the fare rule columns already fetched above — no extra query.
  const zonePricing = normalizePricingModelRow(zone);
  const pricing: RideQuotePricing = {
    model: zonePricing.model,
    flatFeeKobo: BigInt(zonePricing.flatFeeKobo),
    feePayer: zonePricing.feePayer,
  };
  const amounts = computeRideQuoteAmounts(
    {
      fareRuleId: zone.fare_rule_id,
      baseKobo: toBigInt(zone.base_kobo),
      perKmKobo: toBigInt(zone.per_km_kobo),
      perMinuteKobo: toBigInt(zone.per_minute_kobo),
      minimumKobo: toBigInt(zone.minimum_kobo),
      cancellationKobo: toBigInt(zone.cancellation_kobo),
      demandCapBasisPoints: zone.demand_cap_basis_points,
    },
    distanceMeters,
    durationSeconds,
    0,
    pricing,
  );

  const client = await pool.connect();
  let tripId: string;
  try {
    await client.query("BEGIN");

    const quoteInsert = await client.query<{ id: string }>(
      `INSERT INTO mobility.fare_quote (
         rider_user_id, zone_id, fare_rule_id,
         route_provider, route_provider_version,
         quoted_distance_m, quoted_duration_s,
         base_kobo, distance_kobo, time_kobo, demand_kobo,
         taxes_and_fees_kobo, platform_fee_kobo, total_kobo,
         disclosure_version, calculation, expires_at
       ) VALUES (
         $1, $2, $3,
         $4, $5,
         $6, $7,
         $8, $9, $10, $11,
         $12, $13, $14,
         $15, $16, now() + ($17 || ' minutes')::interval
       ) RETURNING id`,
      [
        input.consumerUserId,
        zone.zone_id,
        zone.fare_rule_id,
        ROUTE_PROVIDER,
        ROUTE_PROVIDER_VERSION,
        distanceMeters,
        durationSeconds,
        amounts.baseKobo.toString(),
        amounts.distanceKobo.toString(),
        amounts.timeKobo.toString(),
        amounts.demandKobo.toString(),
        amounts.taxesAndFeesKobo.toString(),
        amounts.platformFeeKobo.toString(),
        amounts.totalKobo.toString(),
        "consumer-ride/1",
        JSON.stringify({
          zoneCode: zone.zone_code,
          fareRuleId: zone.fare_rule_id,
          distanceMeters,
          durationSeconds,
          demandBasisPoints: 0,
          minimumFareUpliftKobo: amounts.taxesAndFeesKobo.toString(),
          pricingModel: amounts.pricingModel,
          feePayer: amounts.feePayer,
          platformFeeKobo: amounts.platformFeeKobo.toString(),
        }),
        QUOTE_TTL_MINUTES,
      ],
    );
    const fareQuoteId = quoteInsert.rows[0].id;

    const tripInsert = await client.query<{ id: string }>(
      `INSERT INTO mobility.ride_trip (
         rider_user_id, state, zone_id, fare_quote_id,
         pickup, destination, pickup_address, destination_address,
         requested_at
       ) VALUES (
         $1, 'requested', $2, $3,
         ST_SetSRID(ST_MakePoint($5, $4), 4326)::geography,
         ST_SetSRID(ST_MakePoint($7, $6), 4326)::geography,
         $8, $9,
         now()
       ) RETURNING id`,
      [
        input.consumerUserId,
        zone.zone_id,
        fareQuoteId,
        input.pickupLat,
        input.pickupLng,
        input.destinationLat,
        input.destinationLng,
        input.pickupAddress,
        input.destinationAddress,
      ],
    );
    tripId = tripInsert.rows[0].id;

    // 0073 rider_trips mirror (no FK back to ride_trip exists — documented).
    await client.query(
      `INSERT INTO public.rider_trips (
         rider_user_id, status,
         pickup_latitude, pickup_longitude, pickup_label,
         dropoff_latitude, dropoff_longitude, dropoff_label,
         fare_minor, currency, requested_at
       ) VALUES ($1, 'requested', $2, $3, $4, $5, $6, $7, $8, 'NGN', now())`,
      [
        input.consumerUserId,
        input.pickupLat,
        input.pickupLng,
        input.pickupAddress,
        input.destinationLat,
        input.destinationLng,
        input.destinationAddress,
        amounts.totalKobo.toString(),
      ],
    );

    await client.query(
      `INSERT INTO mobility.trip_event (
         trip_id, sequence_no, event_type, actor_kind, actor_user_id,
         correlation_id, idempotency_key, previous_state, next_state, payload
       ) VALUES ($1, 1, 'trip.requested', 'rider', $2, $3, $4, NULL, 'requested', $5)`,
      [
        tripId,
        input.consumerUserId,
        randomUUID(),
        `${input.idempotencyKey}:request`,
        JSON.stringify({ zoneCode: zone.zone_code }),
      ],
    );

    // Dedupe record inside the same transaction: a concurrent retry with the
    // same key conflicts here and aborts, making the whole request atomic.
    await client.query(
      `INSERT INTO public.consumer_processed_events (
         consumer_name, topic, event_id, result_json
       ) VALUES ($1, $2, $3, $4)`,
      [
        RIDE_CONSUMER_NAME,
        RIDE_REQUEST_TOPIC,
        input.idempotencyKey,
        JSON.stringify({ tripId }),
      ],
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: string }).code === "23505"
    ) {
      // Lost a same-key race: read back the winner and replay it.
      const winner = await pool.query<{
        result_json: { tripId?: string } | null;
      }>(
        `SELECT result_json
           FROM public.consumer_processed_events
          WHERE consumer_name = $1 AND topic = $2 AND event_id = $3`,
        [RIDE_CONSUMER_NAME, RIDE_REQUEST_TOPIC, input.idempotencyKey],
      );
      const winnerTripId = winner.rows[0]?.result_json?.tripId;
      if (winnerTripId) {
        return {
          tripId: winnerTripId,
          state: "requested",
          totalKobo: amounts.totalKobo.toString(),
          currency: "NGN",
          replayed: true,
          matchingDispatched: false,
        };
      }
    }
    throw error;
  } finally {
    client.release();
  }

  // Fire-and-forget matching kick AFTER commit — never blocks the mutation.
  const matchingDispatched = await requestRideMatchAttempt({
    tripId,
    idempotencyKey: `${input.idempotencyKey}:match`,
  });

  return {
    tripId,
    state: "requested",
    totalKobo: amounts.totalKobo.toString(),
    currency: "NGN",
    replayed: false,
    matchingDispatched,
    platformFeeKobo: amounts.platformFeeKobo.toString(),
    feePayer: amounts.feePayer,
    pricingModel: amounts.pricingModel,
  };
}

// ---------------------------------------------------------------------------
// transitionRide (cancel / complete + mojaloop initiation on completion)
// ---------------------------------------------------------------------------

export type TransitionRideResult = {
  tripId: string;
  state: RideTripState;
  replayed: boolean;
  paymentReference: string | null;
};

async function initiateRidePayment(input: {
  tripId: string;
  riderUserId: number;
  totalKobo: string;
}): Promise<string> {
  // EXACT consumerCommerce.checkoutConsumerCart mojaloop pattern with
  // deterministic ride ids: quote rq-, transfer rt-, reference rp-.
  const paymentReference = `rp-${input.tripId}`;
  const quoteId = `rq-${input.tripId}`;
  const transferId = `rt-${input.tripId}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${ENV.mojaloopServiceUrl}/payments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Service-Token": ENV.internalServiceToken,
      },
      body: JSON.stringify({
        quoteId,
        transferId,
        paymentReference,
        payerId: `consumer:${input.riderUserId}`,
        amountMinor: input.totalKobo,
        currency: "NGN",
        description: "SwitchOS ride trip payment",
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `ride payment initiation failed: HTTP ${response.status} ${body}`.trim(),
      );
    }
    return paymentReference;
  } finally {
    clearTimeout(timeout);
  }
}

async function updateRiderTripsMirror(input: {
  riderUserId: number;
  status: "completed" | "cancelled";
  completedAt: boolean;
}): Promise<void> {
  // The mirror has no FK to ride_trip; update the rider's latest
  // non-terminal mirror row (documented substrate limitation).
  await (await getPool()).query(
    `UPDATE public.rider_trips
        SET status = $2,
            completed_at = CASE WHEN $3 THEN now() ELSE completed_at END,
            updated_at = now()
      WHERE id = (
        SELECT id FROM public.rider_trips
         WHERE rider_user_id = $1
           AND status IN ('requested', 'assigned', 'in_progress')
         ORDER BY requested_at DESC
         LIMIT 1
      )`,
    [input.riderUserId, input.status, input.completedAt],
  );
}

export async function transitionRide(
  input: z.infer<typeof transitionRideInputSchema> & {
    consumerUserId: number;
  },
): Promise<TransitionRideResult> {
  const pool = await getPool();
  const client = await pool.connect();
  let trip: RideTripRow;
  try {
    await client.query("BEGIN");
    const tripResult = await client.query<RideTripRow>(
      `SELECT id, rider_user_id, state, zone_id, fare_quote_id,
              pickup_address, destination_address, assigned_driver_user_id,
              requested_at, started_at, completed_at,
              cancellation_actor, cancellation_code, state_version,
              created_at, updated_at
         FROM mobility.ride_trip
        WHERE id = $1 AND rider_user_id = $2
        FOR UPDATE`,
      [input.tripId, input.consumerUserId],
    );
    const row = tripResult.rows[0];
    if (!row) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "ride_trip_not_found",
      });
    }
    trip = row;

    if (input.action === "cancel") {
      if (row.state === "cancelled") {
        await client.query("COMMIT");
        return {
          tripId: row.id,
          state: row.state,
          replayed: true,
          paymentReference: null,
        };
      }
      assertRideTransition("cancel", row.state);
      await client.query(
        `UPDATE mobility.ride_trip
            SET state = 'cancelled',
                cancellation_actor = 'rider',
                cancellation_code = $3,
                state_version = state_version + 1,
                updated_at = now()
          WHERE id = $1 AND state_version = $2`,
        [row.id, row.state_version.toString(), input.cancellationCode ?? "rider_cancelled"],
      );
      await client.query(
        `INSERT INTO mobility.trip_event (
           trip_id, sequence_no, event_type, actor_kind, actor_user_id,
           correlation_id, idempotency_key, previous_state, next_state, payload
         )
         SELECT $1, COALESCE(MAX(sequence_no), 0) + 1, 'trip.cancelled',
                'rider', $2, $3, $4, $5, 'cancelled', $6
           FROM mobility.trip_event
          WHERE trip_id = $1`,
        [
          row.id,
          input.consumerUserId,
          randomUUID(),
          `${input.idempotencyKey}:cancel`,
          row.state,
          JSON.stringify({ cancellationCode: input.cancellationCode ?? null }),
        ],
      );
      await client.query("COMMIT");
    } else {
      // complete
      if (row.state === "completed" || row.state === "completed_pending_payment") {
        const recorded = await pool.query<{
          result_json: { paymentReference?: string } | null;
        }>(
          `SELECT result_json
             FROM public.consumer_processed_events
            WHERE consumer_name = $1 AND topic = $2 AND event_id = $3`,
          [RIDE_CONSUMER_NAME, RIDE_PAYMENT_TOPIC, row.id],
        );
        await client.query("COMMIT");
        return {
          tripId: row.id,
          state: row.state,
          replayed: true,
          paymentReference: recorded.rows[0]?.result_json?.paymentReference ?? null,
        };
      }
      assertRideTransition("complete", row.state);
      await client.query(
        `UPDATE mobility.ride_trip
            SET state = 'completed_pending_payment',
                completed_at = now(),
                state_version = state_version + 1,
                updated_at = now()
          WHERE id = $1 AND state_version = $2`,
        [row.id, row.state_version.toString()],
      );
      await client.query(
        `INSERT INTO mobility.trip_event (
           trip_id, sequence_no, event_type, actor_kind, actor_user_id,
           correlation_id, idempotency_key, previous_state, next_state, payload
         )
         SELECT $1, COALESCE(MAX(sequence_no), 0) + 1, 'trip.completed',
                'rider', $2, $3, $4, $5, 'completed_pending_payment', '{}'::jsonb
           FROM mobility.trip_event
          WHERE trip_id = $1`,
        [
          row.id,
          input.consumerUserId,
          randomUUID(),
          `${input.idempotencyKey}:complete`,
          row.state,
        ],
      );
      await client.query("COMMIT");
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  if (input.action === "cancel") {
    await updateRiderTripsMirror({
      riderUserId: input.consumerUserId,
      status: "cancelled",
      completedAt: false,
    });
    return {
      tripId: trip.id,
      state: "cancelled",
      replayed: false,
      paymentReference: null,
    };
  }

  // ---- complete: mojaloop initiation with the crash-window guard ----------
  const quoteResult = await pool.query<{ total_kobo: string | number }>(
    `SELECT total_kobo FROM mobility.fare_quote WHERE id = $1`,
    [trip.fare_quote_id],
  );
  const totalKobo = (quoteResult.rows[0]?.total_kobo ?? 0).toString();

  try {
    const paymentReference = await initiateRidePayment({
      tripId: trip.id,
      riderUserId: input.consumerUserId,
      totalKobo,
    });
    await pool.query(
      `INSERT INTO public.consumer_processed_events (
         consumer_name, topic, event_id, result_json
       ) VALUES ($1, $2, $3, $4)
       ON CONFLICT (consumer_name, topic, event_id) DO NOTHING`,
      [
        RIDE_CONSUMER_NAME,
        RIDE_PAYMENT_TOPIC,
        trip.id,
        JSON.stringify({ paymentReference, totalKobo }),
      ],
    );
    await updateRiderTripsMirror({
      riderUserId: input.consumerUserId,
      status: "completed",
      completedAt: true,
    });
    return {
      tripId: trip.id,
      state: "completed_pending_payment",
      replayed: false,
      paymentReference,
    };
  } catch (error) {
    // Trip stays completed_pending_payment with NO dedupe record, so a retry
    // with the same idempotency key re-initiates with the SAME deterministic
    // rq-/rt- ids (the Go side collapses duplicate quote/transfer ids).
    console.error(
      `[consumer-ride] payment initiation failed for trip ${trip.id}:`,
      error instanceof Error ? error.message : error,
    );
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "payment_initiation_failed",
    });
  }
}

// ---------------------------------------------------------------------------
// acceptRideOffer (driver side)
// ---------------------------------------------------------------------------

export type AcceptRideOfferResult = {
  tripId: string;
  state: RideTripState;
};

export async function acceptRideOffer(
  input: z.infer<typeof acceptRideOfferInputSchema> & { driverUserId: number },
): Promise<AcceptRideOfferResult> {
  // Same fail-closed verified-driver gate as
  // driverDispatchFairness.listTransparentDriverOffers.
  const access = await getVerifiedDriverAccess(input.driverUserId);
  if (!access) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "driver_not_verified",
    });
  }
  try {
    const result = await (await getPool()).query<{
      trip_id: string;
      driver_user_id: number;
      new_trip_state: RideTripState;
    }>(`SELECT * FROM mobility.accept_driver_offer($1, $2, $3)`, [
      input.offerId,
      input.driverUserId,
      input.idempotencyKey,
    ]);
    const row = result.rows[0];
    if (!row) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "ride_offer_not_acceptable",
      });
    }
    return { tripId: row.trip_id, state: row.new_trip_state };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    const pgCode = (error as { code?: string }).code;
    const message = error instanceof Error ? error.message : "";
    if (pgCode === "23514" || pgCode === "22023" || pgCode === "P0002") {
      throw new TRPCError({
        code: "CONFLICT",
        message: `ride_offer_not_acceptable:${message}`,
      });
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// rateTrip
// ---------------------------------------------------------------------------

export type RateTripResult = {
  feedbackId: string;
  replayed: boolean;
};

export async function rateTrip(
  input: z.infer<typeof rateTripInputSchema> & { consumerUserId: number },
): Promise<RateTripResult> {
  const pool = await getPool();
  // Replay detection for the client: feedback by this author+key already
  // stored returns the same id (the SQL function itself is idempotent too).
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM mobility.trip_feedback
      WHERE author_user_id = $1 AND idempotency_key = $2`,
    [input.consumerUserId, input.idempotencyKey],
  );
  if (existing.rows[0]) {
    return { feedbackId: existing.rows[0].id, replayed: true };
  }
  try {
    const result = await pool.query<{ submit_trip_feedback: string }>(
      `SELECT mobility.submit_trip_feedback($1, $2, $3, $4::jsonb, $5, $6)`,
      [
        input.tripId,
        input.consumerUserId,
        input.score,
        JSON.stringify(input.tags),
        input.comment ?? null,
        input.idempotencyKey,
      ],
    );
    return { feedbackId: result.rows[0].submit_trip_feedback, replayed: false };
  } catch (error) {
    const pgCode = (error as { code?: string }).code;
    const message = error instanceof Error ? error.message : "";
    if (pgCode === "23505") {
      // UNIQUE(trip_id, author_user_id): one rating per order/trip.
      throw new TRPCError({ code: "CONFLICT", message: "trip_already_rated" });
    }
    if (pgCode === "23514" || message.includes("not eligible")) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "trip_not_eligible_for_feedback",
      });
    }
    if (pgCode === "P0002") {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "ride_trip_not_found",
      });
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const consumerRideRouter = router({
  requestRide: authenticatedProcedure
    .input(requestRideInputSchema)
    .mutation(async ({ ctx, input }) => {
      const user = await resolvePublicUser(ctx.user);
      return requestRide({ ...input, consumerUserId: user.id });
    }),

  myRideTrips: authenticatedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(50).default(20) }).optional())
    .query(async ({ ctx, input }) => {
      const user = await resolvePublicUser(ctx.user);
      return listMyRideTrips({
        consumerUserId: user.id,
        limit: input?.limit,
      });
    }),

  myRideTrip: authenticatedProcedure
    .input(z.object({ tripId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const user = await resolvePublicUser(ctx.user);
      return getMyRideTrip({ consumerUserId: user.id, tripId: input.tripId });
    }),

  transitionRide: authenticatedProcedure
    .input(transitionRideInputSchema)
    .mutation(async ({ ctx, input }) => {
      const user = await resolvePublicUser(ctx.user);
      return transitionRide({ ...input, consumerUserId: user.id });
    }),

  acceptRideOffer: authenticatedProcedure
    .input(acceptRideOfferInputSchema)
    .mutation(async ({ ctx, input }) => {
      const user = await resolvePublicUser(ctx.user);
      return acceptRideOffer({ ...input, driverUserId: user.id });
    }),

  rateTrip: authenticatedProcedure
    .input(rateTripInputSchema)
    .mutation(async ({ ctx, input }) => {
      const user = await resolvePublicUser(ctx.user);
      return rateTrip({ ...input, consumerUserId: user.id });
    }),
});
