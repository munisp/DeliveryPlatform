import { Pool } from "pg";
import { ENV } from "./env";

type ContractState =
  | "requested"
  | "approved"
  | "active"
  | "return_pending"
  | "closed"
  | "cancelled"
  | "suspended";
type ContractAction =
  | "approve"
  | "handover"
  | "begin_return"
  | "close"
  | "cancel"
  | "suspend"
  | "begin_safe_return";
type InspectionKind = "handover" | "return";
type AssetEvidenceKind =
  | "registration"
  | "roadworthiness"
  | "commercial_cover"
  | "ownership_authority"
  | "inspection";

let pool: Pool | null = null;

function database() {
  if (!ENV.databaseUrl) throw new Error("vehicle_access_database_unconfigured");
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

export type VehicleAccessOffer = {
  id: string;
  assetId: string;
  providerId: string;
  make: string;
  model: string;
  manufactureYear: number;
  odometerKm: number;
  currency: string;
  weeklyPriceMinor: number;
  depositMinor: number;
  includedKmPerWeek: number;
  minimumDays: number;
};

export type VehicleAccessContract = {
  id: string;
  publicReference: string;
  workerUserId: number;
  assetId: string;
  state: ContractState;
  startsAt: string;
  endsAt: string;
  updatedAt: string;
};

export async function createFleetProvider(input: {
  actorUserId: number;
  displayName: string;
  legalName: string;
}) {
  const result = await database().query<{ id: string }>(
    `SELECT vehicle_access.create_provider($1,$2,$3) AS id`,
    [input.actorUserId, input.displayName, input.legalName],
  );
  return one(result.rows, "fleet_provider").id;
}

export async function upsertWorkerVehicleEligibility(input: {
  actorUserId: number;
  workerUserId: number;
  allowedWorkCategories: string[];
  expiresAt: string;
}) {
  const result = await database().query<{ state: string }>(
    `SELECT vehicle_access.upsert_worker_eligibility($1,$2,$3::jsonb,$4::timestamptz) AS state`,
    [
      input.actorUserId,
      input.workerUserId,
      JSON.stringify(input.allowedWorkCategories),
      input.expiresAt,
    ],
  );
  return one(result.rows, "worker_vehicle_eligibility").state;
}

export async function registerVehicleAsset(input: {
  actorUserId: number;
  providerId: string;
  registrationNumber: string;
  vinSha256: string;
  make: string;
  model: string;
  manufactureYear: number;
  odometerKm: number;
  passengerCapacity: number;
  allowedWorkCategories: string[];
}) {
  const result = await database().query<{ id: string }>(
    `SELECT vehicle_access.register_asset($1,$2::uuid,$3,$4,$5,$6,$7,$8,$9::smallint,$10::jsonb) AS id`,
    [
      input.actorUserId,
      input.providerId,
      input.registrationNumber,
      input.vinSha256,
      input.make,
      input.model,
      input.manufactureYear,
      input.odometerKm,
      input.passengerCapacity,
      JSON.stringify(input.allowedWorkCategories),
    ],
  );
  return one(result.rows, "vehicle_asset").id;
}

export async function recordAssetEvidence(input: {
  actorUserId: number;
  assetId: string;
  kind: AssetEvidenceKind;
  objectKey: string;
  sha256Hex: string;
  expiresAt?: string | null;
  idempotencyKey: string;
}) {
  const result = await database().query<{ id: string }>(
    `SELECT vehicle_access.record_asset_evidence($1,$2::uuid,$3,$4,$5,$6::timestamptz,$7) AS id`,
    [
      input.actorUserId,
      input.assetId,
      input.kind,
      input.objectKey,
      input.sha256Hex,
      input.expiresAt ?? null,
      input.idempotencyKey,
    ],
  );
  return one(result.rows, "asset_evidence").id;
}

export async function activateVehicleAsset(input: {
  actorUserId: number;
  assetId: string;
  idempotencyKey: string;
}) {
  const result = await database().query<{ state: string }>(
    `SELECT vehicle_access.activate_asset($1,$2::uuid,$3) AS state`,
    [input.actorUserId, input.assetId, input.idempotencyKey],
  );
  return one(result.rows, "vehicle_asset_state").state;
}

export async function createVehicleOffer(input: {
  actorUserId: number;
  providerId: string;
  assetId: string;
  currency: string;
  weeklyPriceMinor: number;
  depositMinor: number;
  includedKmPerWeek: number;
  excessKmPriceMinor: number;
  minimumDays: number;
}) {
  const result = await database().query<{ id: string }>(
    `SELECT vehicle_access.create_offer($1,$2::uuid,$3::uuid,$4::char(3),$5::bigint,$6::bigint,$7,$8::bigint,$9::smallint) AS id`,
    [
      input.actorUserId,
      input.providerId,
      input.assetId,
      input.currency,
      input.weeklyPriceMinor,
      input.depositMinor,
      input.includedKmPerWeek,
      input.excessKmPriceMinor,
      input.minimumDays,
    ],
  );
  return one(result.rows, "vehicle_offer").id;
}

export async function listVehicleAccessOffers(limit: number) {
  const result = await database().query<{
    id: string;
    asset_id: string;
    provider_id: string;
    make: string;
    model: string;
    manufacture_year: number;
    odometer_km: number;
    currency: string;
    weekly_price_minor: string | number;
    deposit_minor: string | number;
    included_km_per_week: number;
    minimum_days: number;
  }>(`SELECT * FROM vehicle_access.list_active_offers($1)`, [limit]);
  return result.rows.map(
    (row): VehicleAccessOffer => ({
      id: row.id,
      assetId: row.asset_id,
      providerId: row.provider_id,
      make: row.make,
      model: row.model,
      manufactureYear: Number(row.manufacture_year),
      odometerKm: Number(row.odometer_km),
      currency: row.currency,
      weeklyPriceMinor: Number(row.weekly_price_minor),
      depositMinor: Number(row.deposit_minor),
      includedKmPerWeek: Number(row.included_km_per_week),
      minimumDays: Number(row.minimum_days),
    }),
  );
}

export async function requestVehicleAccess(input: {
  workerUserId: number;
  offerId: string;
  startsAt: string;
  endsAt: string;
  idempotencyKey: string;
}) {
  const result = await database().query<{ id: string }>(
    `SELECT vehicle_access.request_contract($1,$2::uuid,$3::timestamptz,$4::timestamptz,$5) AS id`,
    [
      input.workerUserId,
      input.offerId,
      input.startsAt,
      input.endsAt,
      input.idempotencyKey,
    ],
  );
  return one(result.rows, "vehicle_access_contract").id;
}

export async function transitionVehicleAccessContract(input: {
  actorUserId: number;
  contractId: string;
  action: ContractAction;
  reason?: string | null;
  idempotencyKey: string;
}) {
  const result = await database().query<{ state: ContractState }>(
    `SELECT vehicle_access.transition_contract($1,$2::uuid,$3,$4,$5) AS state`,
    [
      input.actorUserId,
      input.contractId,
      input.action,
      input.reason ?? null,
      input.idempotencyKey,
    ],
  );
  return one(result.rows, "vehicle_access_contract_state").state;
}

export async function recordVehicleInspection(input: {
  actorUserId: number;
  contractId: string;
  kind: InspectionKind;
  objectKey: string;
  contentType: "image/jpeg" | "image/png" | "image/heic" | "application/pdf";
  sha256Hex: string;
  odometerKm: number;
  idempotencyKey: string;
}) {
  const result = await database().query<{ id: string }>(
    `SELECT vehicle_access.record_inspection($1,$2::uuid,$3,$4,$5,$6,$7,$8) AS id`,
    [
      input.actorUserId,
      input.contractId,
      input.kind,
      input.objectKey,
      input.contentType,
      input.sha256Hex,
      input.odometerKm,
      input.idempotencyKey,
    ],
  );
  return one(result.rows, "vehicle_inspection").id;
}

export async function listVehicleAccessContracts(input: {
  actorUserId: number;
  limit: number;
}) {
  const result = await database().query<{
    id: string;
    public_reference: string;
    worker_user_id: number;
    asset_id: string;
    state: ContractState;
    starts_at: Date;
    ends_at: Date;
    updated_at: Date;
  }>(`SELECT * FROM vehicle_access.list_contracts_for_actor($1,$2)`, [
    input.actorUserId,
    input.limit,
  ]);
  return result.rows.map(
    (row): VehicleAccessContract => ({
      id: row.id,
      publicReference: row.public_reference,
      workerUserId: Number(row.worker_user_id),
      assetId: row.asset_id,
      state: row.state,
      startsAt: new Date(row.starts_at).toISOString(),
      endsAt: new Date(row.ends_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    }),
  );
}
