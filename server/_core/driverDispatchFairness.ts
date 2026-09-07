import { Pool } from "pg";

import { ENV } from "./env";

let pool: Pool | null = null;

function database() {
  if (!ENV.databaseUrl) {
    throw new Error("driver_dispatch_fairness_database_unconfigured");
  }
  if (!pool) {
    pool = new Pool({
      connectionString: ENV.databaseUrl,
      ssl:
        ENV.isProduction && !ENV.databaseUrl.includes("sslmode=disable")
          ? {
              rejectUnauthorized: true,
              ...(ENV.databaseSslCa ? { ca: ENV.databaseSslCa } : {}),
            }
          : false,
      max: 5,
    });
  }
  return pool;
}

function one<T>(rows: T[], label: string): T {
  const row = rows[0];
  if (!row) throw new Error(`${label}_not_found`);
  return row;
}

export type TransparentDriverOffer = {
  offerId: string;
  tripId: string;
  expiresAt: string;
  pickupDistanceM: number;
  pickupEtaS: number;
  destinationAddress: string;
  destinationDistanceM: number;
  destinationDurationS: number;
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

type OfferEconomicsRow = {
  offer_id: string;
  driver_earnings_floor_kobo: string | number;
  pickup_subsidy_kobo: string | number;
  base_driver_net_kobo: string | number;
  economics_policy_version: string;
};

type OfferRow = {
  offer_id: string;
  trip_id: string;
  expires_at: string | Date;
  pickup_distance_m: number;
  pickup_eta_s: number;
  destination_address: string;
  destination_distance_m: number;
  destination_duration_s: number;
  gross_fare_kobo: string | number;
  taxes_and_fees_kobo: string | number;
  platform_commission_bp: number;
  platform_commission_kobo: string | number;
  expected_driver_net_kobo: string | number;
  disclosure_version: string;
};

export async function listTransparentDriverOffers(driverUserId: number) {
  const [offersResult, economicsResult] = await Promise.all([
    database().query<OfferRow>(
      `SELECT * FROM mobility.list_driver_offer_disclosures($1)`,
      [driverUserId],
    ),
    database().query<OfferEconomicsRow>(
      `SELECT * FROM mobility.list_driver_offer_economics($1)`,
      [driverUserId],
    ),
  ]);
  const economicsByOfferId = new Map(
    economicsResult.rows.map((row) => [row.offer_id, row]),
  );
  return offersResult.rows.map((row): TransparentDriverOffer => {
    const economics = economicsByOfferId.get(row.offer_id);
    return {
      offerId: row.offer_id,
      tripId: row.trip_id,
      expiresAt: new Date(row.expires_at).toISOString(),
      pickupDistanceM: Number(row.pickup_distance_m),
      pickupEtaS: Number(row.pickup_eta_s),
      destinationAddress: row.destination_address,
      destinationDistanceM: Number(row.destination_distance_m),
      destinationDurationS: Number(row.destination_duration_s),
      grossFareKobo: Number(row.gross_fare_kobo),
      taxesAndFeesKobo: Number(row.taxes_and_fees_kobo),
      platformCommissionBp: Number(row.platform_commission_bp),
      platformCommissionKobo: Number(row.platform_commission_kobo),
      expectedDriverNetKobo: Number(row.expected_driver_net_kobo),
      disclosureVersion: row.disclosure_version,
      driverEarningsFloorKobo: economics
        ? Number(economics.driver_earnings_floor_kobo)
        : null,
      pickupSubsidyKobo: economics
        ? Number(economics.pickup_subsidy_kobo)
        : null,
      baseDriverNetKobo: economics
        ? Number(economics.base_driver_net_kobo)
        : null,
      economicsPolicyVersion: economics?.economics_policy_version ?? null,
    };
  });
}

export async function declineTransparentDriverOffer(input: {
  driverUserId: number;
  offerId: string;
  reason:
    | "pickup_distance_unprofitable"
    | "pickup_time_unprofitable"
    | "fare_insufficient"
    | "destination_unsuitable"
    | "safety_preference"
    | "vehicle_constraint"
    | "other";
  idempotencyKey: string;
}) {
  const result = await database().query<{
    trip_id: string;
    state: string;
    rematch_required: boolean;
  }>(
    `SELECT trip_id::text,state::text,rematch_required
     FROM mobility.decline_driver_offer_fairly(
       $1::uuid,$2,$3::mobility.driver_offer_decline_reason,$4
     )`,
    [input.offerId, input.driverUserId, input.reason, input.idempotencyKey],
  );
  const row = one(result.rows, "transparent_driver_offer_decline");
  return {
    tripId: row.trip_id,
    state: row.state,
    rematchRequired: row.rematch_required,
  };
}

export async function setDriverOfferEconomicsPolicy(input: {
  actorUserId: number;
  zoneId: string;
  version: string;
  driverTimeFloorKoboPerMin: number;
  driverDistanceFloorKoboPerKm: number;
  fuelCostIndexBp: number;
  maintenanceCostIndexBp: number;
  pickupSubsidyKoboPerKm: number;
  maxPickupSubsidyKobo: number;
  platformVariableCostKobo: number;
  platformContributionTargetKobo: number;
  effectiveFrom: string;
}) {
  const result = await database().query<{ id: string }>(
    `SELECT mobility.set_driver_offer_economics_policy(
       $1,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz
     ) AS id`,
    [
      input.actorUserId,
      input.zoneId,
      input.version,
      input.driverTimeFloorKoboPerMin,
      input.driverDistanceFloorKoboPerKm,
      input.fuelCostIndexBp,
      input.maintenanceCostIndexBp,
      input.pickupSubsidyKoboPerKm,
      input.maxPickupSubsidyKobo,
      input.platformVariableCostKobo,
      input.platformContributionTargetKobo,
      input.effectiveFrom,
    ],
  );
  return one(result.rows, "driver_offer_economics_policy").id;
}

export async function setDriverDispatchFairnessPolicy(input: {
  actorUserId: number;
  zoneId: string;
  version: string;
  platformCommissionBp: number;
  maxPickupDistanceM: number;
  maxPickupEtaS: number;
  effectiveFrom: string;
}) {
  const result = await database().query<{ id: string }>(
    `SELECT mobility.set_driver_dispatch_fairness_policy(
       $1,$2::uuid,$3,$4,$5,$6,$7::timestamptz
     ) AS id`,
    [
      input.actorUserId,
      input.zoneId,
      input.version,
      input.platformCommissionBp,
      input.maxPickupDistanceM,
      input.maxPickupEtaS,
      input.effectiveFrom,
    ],
  );
  return one(result.rows, "driver_dispatch_fairness_policy").id;
}
