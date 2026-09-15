import { TRPCError } from "@trpc/server";

import { getPool } from "../db";
import { getFareFloorPolicy, getLatestTakeRate } from "./economicsPolicy";

/**
 * Per-offer fare breakdown (R3) with deadhead compensation (R9).
 *
 * Source of truth is the 0051/0052 transparent-offer record
 * (mobility.driver_offer_disclosure) joined to the fare quote for the
 * base/distance/time/demand split. The breakdown is stored once per offer
 * (idempotent upsert by offer_id) so drivers can audit exactly where every
 * kobo goes: fare components, surge, deadhead credit, platform take, net.
 *
 * Deadhead credit: pickups longer than DEADHEAD_THRESHOLD_SECONDS are
 * compensated per started minute beyond the threshold at a fuel-derived
 * per-minute rate from the market's active cost index
 * (fuel_price_minor / 20 ~= 0.05 L/min city burn), falling back to
 * DEFAULT_DEADHEAD_PER_MINUTE_MINOR (50 NGN = 5000 kobo) when the market has
 * no cost index yet.
 */

export const DEADHEAD_THRESHOLD_SECONDS = 300;
export const DEFAULT_DEADHEAD_PER_MINUTE_MINOR = 5000;
/** Litres-per-minute denominator: fuel_price_minor / 20 ~= 0.05 L/min burn. */
export const DEADHEAD_FUEL_DERIVATION_DIVISOR = 20;

export function computeDeadheadMinor(
  pickupSeconds: number,
  perMinuteMinor: number,
): number {
  if (pickupSeconds <= DEADHEAD_THRESHOLD_SECONDS) return 0;
  return (
    Math.ceil((pickupSeconds - DEADHEAD_THRESHOLD_SECONDS) / 60) * perMinuteMinor
  );
}

export function computePlatformFeeMinor(
  fareMinor: number,
  takeRateBps: number,
): number {
  return Math.round((fareMinor * takeRateBps) / 10000);
}

export function computeSurgeBps(input: {
  baseMinor: number;
  distanceMinor: number;
  timeMinor: number;
  demandMinor: number;
}): number {
  const core = input.baseMinor + input.distanceMinor + input.timeMinor;
  if (core <= 0 || input.demandMinor <= 0) return 0;
  return Math.round((input.demandMinor / core) * 10000);
}

export type OfferEconomicsBreakdownRow = {
  id: string;
  offer_id: string;
  market_id: string | null;
  base_minor: string | number;
  distance_minor: string | number;
  time_minor: string | number;
  deadhead_minor: string | number;
  pickup_seconds: number;
  pickup_meters: number;
  surge_bps: number;
  take_rate_bps: number;
  platform_fee_minor: string | number;
  net_to_driver_minor: string | number;
  currency: string;
  created_at: string | Date;
};

type OfferSourceRow = {
  offer_id: string;
  trip_id: string;
  driver_user_id: number | string;
  pickup_distance_m: number;
  pickup_eta_s: number;
  gross_fare_kobo: string | number;
  taxes_and_fees_kobo: string | number;
  platform_commission_bp: number;
  base_kobo: string | number;
  distance_kobo: string | number;
  time_kobo: string | number;
  demand_kobo: string | number;
  zone_id: string;
};

/**
 * Compute the breakdown for a dispatch offer and store it (idempotent upsert
 * keyed by offer_id). Returns the stored row.
 */
export async function computeAndStoreBreakdown(input: {
  offerId: string;
  marketId?: string;
}): Promise<OfferEconomicsBreakdownRow> {
  const pool = await getPool();
  const source = await pool.query<OfferSourceRow>(
    `SELECT o.id::text AS offer_id,
            o.trip_id::text AS trip_id,
            o.driver_user_id,
            d.pickup_distance_m,
            d.pickup_eta_s,
            d.gross_fare_kobo,
            d.taxes_and_fees_kobo,
            d.platform_commission_bp,
            q.base_kobo,
            q.distance_kobo,
            q.time_kobo,
            q.demand_kobo,
            t.zone_id::text AS zone_id
     FROM mobility.driver_offer o
     JOIN mobility.driver_offer_disclosure d ON d.offer_id = o.id
     JOIN mobility.ride_trip t ON t.id = o.trip_id
     JOIN mobility.fare_quote q ON q.id = t.fare_quote_id
     WHERE o.id = $1`,
    [input.offerId],
  );
  const offer = source.rows[0];
  if (!offer) {
    throw new TRPCError({ code: "NOT_FOUND", message: "offer_not_found" });
  }

  const marketId = input.marketId ?? offer.zone_id;
  const pickupSeconds = Number(offer.pickup_eta_s);
  const pickupMeters = Number(offer.pickup_distance_m);
  const grossMinor = Number(offer.gross_fare_kobo);
  const taxesMinor = Number(offer.taxes_and_fees_kobo);
  const fareMinor = grossMinor - taxesMinor;

  const [takeRate, floorPolicy] = await Promise.all([
    getLatestTakeRate(marketId),
    getFareFloorPolicy(marketId),
  ]);
  const takeRateBps = takeRate
    ? Number(takeRate.rate_bps)
    : Number(offer.platform_commission_bp);
  const perMinuteMinor = (() => {
    const costIndex = floorPolicy?.cost_index;
    const fuel = costIndex ? Number(costIndex.fuel_price_minor) : NaN;
    return Number.isFinite(fuel) && fuel > 0
      ? Math.max(1, Math.ceil(fuel / DEADHEAD_FUEL_DERIVATION_DIVISOR))
      : DEFAULT_DEADHEAD_PER_MINUTE_MINOR;
  })();

  const deadheadMinor = computeDeadheadMinor(pickupSeconds, perMinuteMinor);
  const platformFeeMinor = computePlatformFeeMinor(fareMinor, takeRateBps);
  const netToDriverMinor = fareMinor + deadheadMinor - platformFeeMinor;
  const surgeBps = computeSurgeBps({
    baseMinor: Number(offer.base_kobo),
    distanceMinor: Number(offer.distance_kobo),
    timeMinor: Number(offer.time_kobo),
    demandMinor: Number(offer.demand_kobo),
  });

  const upserted = await pool.query<OfferEconomicsBreakdownRow>(
    `INSERT INTO public.offer_economics_breakdowns
       (offer_id, market_id, base_minor, distance_minor, time_minor,
        deadhead_minor, pickup_seconds, pickup_meters, surge_bps,
        take_rate_bps, platform_fee_minor, net_to_driver_minor, currency)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'NGN')
     ON CONFLICT (offer_id)
     DO UPDATE SET
       market_id = EXCLUDED.market_id,
       base_minor = EXCLUDED.base_minor,
       distance_minor = EXCLUDED.distance_minor,
       time_minor = EXCLUDED.time_minor,
       deadhead_minor = EXCLUDED.deadhead_minor,
       pickup_seconds = EXCLUDED.pickup_seconds,
       pickup_meters = EXCLUDED.pickup_meters,
       surge_bps = EXCLUDED.surge_bps,
       take_rate_bps = EXCLUDED.take_rate_bps,
       platform_fee_minor = EXCLUDED.platform_fee_minor,
       net_to_driver_minor = EXCLUDED.net_to_driver_minor
     RETURNING *`,
    [
      input.offerId,
      marketId,
      Number(offer.base_kobo),
      Number(offer.distance_kobo),
      Number(offer.time_kobo),
      deadheadMinor,
      pickupSeconds,
      pickupMeters,
      surgeBps,
      takeRateBps,
      platformFeeMinor,
      netToDriverMinor,
    ],
  );
  const row = upserted.rows[0];
  if (!row) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "offer_breakdown_store_failed",
    });
  }
  return row;
}

export async function getOfferBreakdown(
  offerId: string,
): Promise<OfferEconomicsBreakdownRow> {
  const pool = await getPool();
  const existing = await pool.query<OfferEconomicsBreakdownRow>(
    `SELECT * FROM public.offer_economics_breakdowns WHERE offer_id = $1`,
    [offerId],
  );
  const row = existing.rows[0];
  if (row) return row;
  return computeAndStoreBreakdown({ offerId });
}

/**
 * Self-serve driver earnings rollup for the last 30 days, summed from stored
 * breakdowns joined to the driver's offers (offer -> driver_user_id linkage
 * per driverDispatchFairness).
 */
export async function getMyNetEarningsSummary(driverUserId: number): Promise<{
  currency: string;
  windowDays: number;
  offers: number;
  grossMinor: number;
  deadheadMinor: number;
  platformFeeMinor: number;
  netToDriverMinor: number;
}> {
  const pool = await getPool();
  const result = await pool.query<{
    offers: number;
    gross_minor: string | number | null;
    deadhead_minor: string | number | null;
    platform_fee_minor: string | number | null;
    net_to_driver_minor: string | number | null;
  }>(
    `SELECT count(*)::int AS offers,
            sum(b.base_minor + b.distance_minor + b.time_minor) AS gross_minor,
            sum(b.deadhead_minor) AS deadhead_minor,
            sum(b.platform_fee_minor) AS platform_fee_minor,
            sum(b.net_to_driver_minor) AS net_to_driver_minor
     FROM public.offer_economics_breakdowns b
     JOIN mobility.driver_offer o ON o.id::text = b.offer_id
     WHERE o.driver_user_id = $1
       AND b.created_at >= now() - interval '30 days'`,
    [driverUserId],
  );
  const row = result.rows[0];
  return {
    currency: "NGN",
    windowDays: 30,
    offers: row?.offers ?? 0,
    grossMinor: Number(row?.gross_minor ?? 0),
    deadheadMinor: Number(row?.deadhead_minor ?? 0),
    platformFeeMinor: Number(row?.platform_fee_minor ?? 0),
    netToDriverMinor: Number(row?.net_to_driver_minor ?? 0),
  };
}
