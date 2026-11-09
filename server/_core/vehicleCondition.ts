/**
 * Data-access wrappers for the rental condition & insurance wave
 * (drizzle/0096_rental_condition_insurance.sql). Every write goes through the
 * SECURITY DEFINER authority functions in the vehicle_access schema — this
 * module never issues INSERT/UPDATE/DELETE against vehicle_access tables.
 *
 * Own satellite pool (application_name "vehicle-condition", hard-capped at 3
 * connections, 10 s statement timeout) so condition-photo / settlement
 * traffic cannot starve the primary vehicle_access pool.
 */
import { Pool } from "pg";

import { ENV } from "./env";

export type ConditionPhase = "check_out" | "check_in";
export type ConditionGrade =
  | "excellent"
  | "good"
  | "fair"
  | "poor"
  | "damaged";
export type PhotoZone =
  | "front"
  | "rear"
  | "left"
  | "right"
  | "interior_front"
  | "interior_rear"
  | "dashboard_odometer"
  | "wheels"
  | "roof"
  | "other";

let pool: Pool | null = null;

function database() {
  if (!ENV.databaseUrl)
    throw new Error("vehicle_condition_database_unconfigured");
  if (!pool) {
    pool = new Pool({
      connectionString: ENV.databaseUrl,
      application_name: "vehicle-condition",
      ssl:
        ENV.isProduction && !ENV.databaseUrl.includes("sslmode=disable")
          ? {
              rejectUnauthorized: true,
              ...(ENV.databaseSslCa ? { ca: ENV.databaseSslCa } : {}),
            }
          : false,
      // Hard-capped like every other satellite pool (perf finding 10).
      max: 3,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 30000,
      options: "-c statement_timeout=10000",
    });
  }
  return pool;
}

function one<T>(rows: T[], label: string) {
  const row = rows[0];
  if (!row) throw new Error(`${label}_not_found`);
  return row;
}

export type InsuranceTier = {
  id: string;
  tierCode: string;
  displayName: string;
  currency: string;
  dailyRateMinor: number;
  excessMinor: number;
  liabilityCapMinor: number;
  damageCapMinor: number;
  theftCovered: boolean;
  depositMultiplierBp: number;
};

export type ConditionPhotoInput = {
  zone: PhotoZone;
  objectKey: string;
  contentType: "image/jpeg" | "image/png" | "image/heic";
  sha256Hex: string;
  damageFlag: boolean;
  note?: string | null;
};

export async function createInsuranceTier(input: {
  actorUserId: number;
  providerId: string;
  tierCode: string;
  displayName: string;
  currency: string;
  dailyRateMinor: number;
  excessMinor: number;
  liabilityCapMinor: number;
  damageCapMinor: number;
  theftCovered: boolean;
  depositMultiplierBp: number;
  idempotencyKey: string;
}) {
  const result = await database().query<{ id: string }>(
    `SELECT vehicle_access.create_insurance_tier($1,$2::uuid,$3,$4,$5::char(3),$6::bigint,$7::bigint,$8::bigint,$9::bigint,$10::boolean,$11,$12) AS id`,
    [
      input.actorUserId,
      input.providerId,
      input.tierCode,
      input.displayName,
      input.currency,
      input.dailyRateMinor,
      input.excessMinor,
      input.liabilityCapMinor,
      input.damageCapMinor,
      input.theftCovered,
      input.depositMultiplierBp,
      input.idempotencyKey,
    ],
  );
  return one(result.rows, "insurance_tier").id;
}

export async function retireInsuranceTier(input: {
  actorUserId: number;
  tierId: string;
  idempotencyKey: string;
}) {
  const result = await database().query<{ retired: boolean }>(
    `SELECT vehicle_access.retire_insurance_tier($1,$2::uuid,$3) AS retired`,
    [input.actorUserId, input.tierId, input.idempotencyKey],
  );
  return one(result.rows, "insurance_tier_retire").retired;
}

export async function selectContractInsurance(input: {
  workerUserId: number;
  contractId: string;
  tierId: string;
  idempotencyKey: string;
}) {
  const result = await database().query<{ id: string }>(
    `SELECT vehicle_access.select_contract_insurance($1,$2::uuid,$3::uuid,$4) AS id`,
    [
      input.workerUserId,
      input.contractId,
      input.tierId,
      input.idempotencyKey,
    ],
  );
  return one(result.rows, "contract_insurance_selection").id;
}

export async function listInsuranceTiersForOffer(input: {
  offerId: string;
  limit: number;
}) {
  const result = await database().query<{
    id: string;
    tier_code: string;
    display_name: string;
    currency: string;
    daily_rate_minor: string | number;
    excess_minor: string | number;
    liability_cap_minor: string | number;
    damage_cap_minor: string | number;
    theft_covered: boolean;
    deposit_multiplier_bp: number;
  }>(`SELECT * FROM vehicle_access.list_insurance_tiers_for_offer($1::uuid,$2)`, [
    input.offerId,
    input.limit,
  ]);
  return result.rows.map(
    (row): InsuranceTier => ({
      id: row.id,
      tierCode: row.tier_code,
      displayName: row.display_name,
      currency: row.currency,
      dailyRateMinor: Number(row.daily_rate_minor),
      excessMinor: Number(row.excess_minor),
      liabilityCapMinor: Number(row.liability_cap_minor),
      damageCapMinor: Number(row.damage_cap_minor),
      theftCovered: row.theft_covered,
      depositMultiplierBp: Number(row.deposit_multiplier_bp),
    }),
  );
}

export async function recordConditionReport(input: {
  actorUserId: number;
  contractId: string;
  phase: ConditionPhase;
  odometerKm: number;
  fuelPct: number;
  overallCondition: ConditionGrade;
  notes?: string | null;
  photos: ConditionPhotoInput[];
  idempotencyKey: string;
}) {
  const result = await database().query<{ id: string }>(
    `SELECT vehicle_access.record_condition_report(
      $1,$2::uuid,$3::vehicle_access.condition_phase,$4,$5::smallint,
      $6::vehicle_access.condition_grade,$7,$8::jsonb,$9
    ) AS id`,
    [
      input.actorUserId,
      input.contractId,
      input.phase,
      input.odometerKm,
      input.fuelPct,
      input.overallCondition,
      input.notes ?? null,
      JSON.stringify(
        input.photos.map((photo) => ({
          zone: photo.zone,
          object_key: photo.objectKey,
          content_type: photo.contentType,
          sha256_hex: photo.sha256Hex,
          damage_flag: photo.damageFlag,
          note: photo.note ?? null,
        })),
      ),
      input.idempotencyKey,
    ],
  );
  return one(result.rows, "condition_report").id;
}

export async function computeReturnSettlement(input: {
  actorUserId: number;
  contractId: string;
  damageChargeMinor: number;
  fuelChargeMinor: number;
  idempotencyKey: string;
}) {
  const result = await database().query<{ id: string }>(
    `SELECT vehicle_access.compute_return_settlement($1,$2::uuid,$3::bigint,$4::bigint,$5) AS id`,
    [
      input.actorUserId,
      input.contractId,
      input.damageChargeMinor,
      input.fuelChargeMinor,
      input.idempotencyKey,
    ],
  );
  return one(result.rows, "return_settlement").id;
}

export type ConditionDeltaReport = {
  contractId: string;
  /** Raw report+photos payloads (snake_case evidence preserved verbatim). */
  checkOut: Record<string, unknown> | null;
  checkIn: Record<string, unknown> | null;
  deltas: {
    odometerKm: number | null;
    fuelPct: number | null;
    newDamageZones: string[];
  } | null;
  settlement: Record<string, unknown> | null;
};

type ConditionDeltaReportWire = {
  contract_id: string;
  check_out: Record<string, unknown> | null;
  check_in: Record<string, unknown> | null;
  deltas: {
    odometer_km: string | number | null;
    fuel_pct: string | number | null;
    new_damage_zones: string[] | null;
  } | null;
  settlement: Record<string, unknown> | null;
};

export async function getConditionDeltaReport(input: {
  actorUserId: number;
  contractId: string;
}) {
  const result = await database().query<{ report: ConditionDeltaReportWire }>(
    `SELECT vehicle_access.condition_delta_report($1,$2::uuid) AS report`,
    [input.actorUserId, input.contractId],
  );
  const report = one(result.rows, "condition_delta_report").report;
  return {
    contractId: report.contract_id,
    checkOut: report.check_out ?? null,
    checkIn: report.check_in ?? null,
    deltas: report.deltas
      ? {
          odometerKm:
            report.deltas.odometer_km === null
              ? null
              : Number(report.deltas.odometer_km),
          fuelPct:
            report.deltas.fuel_pct === null
              ? null
              : Number(report.deltas.fuel_pct),
          newDamageZones: report.deltas.new_damage_zones ?? [],
        }
      : null,
    settlement: report.settlement ?? null,
  } satisfies ConditionDeltaReport;
}
