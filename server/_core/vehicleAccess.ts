import { Pool } from "pg";
import { ENV } from "./env";
import { vehicleTrackerMetrics } from "./vehicleTrackerMetrics";

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
let trackerPool: Pool | null = null;

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
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 30000,
      options: "-c statement_timeout=10000",
    });
  }
  return pool;
}

function trackerDatabase() {
  if (!ENV.databaseUrl)
    throw new Error("vehicle_tracker_database_unconfigured");
  if (!trackerPool) {
    trackerPool = new Pool({
      connectionString: ENV.databaseUrl,
      application_name: "vehicle-tracker-ingest",
      ssl:
        ENV.isProduction && !ENV.databaseUrl.includes("sslmode=disable")
          ? {
              rejectUnauthorized: true,
              ...(ENV.databaseSslCa ? { ca: ENV.databaseSslCa } : {}),
            }
          : false,
      // Hard-capped like every other satellite pool (perf finding 10).
      max: Math.min(ENV.vehicleTrackerDatabasePoolMax, 5),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 3000,
      options: "-c statement_timeout=10000",
    });
  }
  return trackerPool;
}

function updateTrackerPoolMetrics(databasePool: Pool) {
  vehicleTrackerMetrics.setPool(
    databasePool.totalCount,
    databasePool.idleCount,
    databasePool.waitingCount,
    ENV.vehicleTrackerDatabasePoolMax,
  );
}

async function trackerQuery<T>(
  operation:
    | "claim"
    | "renew"
    | "bulk_record"
    | "complete"
    | "release"
    | "observability",
  text: string,
  values: unknown[],
) {
  const databasePool = trackerDatabase();
  updateTrackerPoolMetrics(databasePool);
  const startedAt = performance.now();
  let sqlState: string | undefined;
  try {
    return await databasePool.query<T>(text, values);
  } catch (error) {
    sqlState =
      error && typeof error === "object" && "code" in error
        ? `${(error as { code?: unknown }).code ?? ""}`
        : undefined;
    if (sqlState === "55000") {
      vehicleTrackerMetrics.observeFence("other", operation);
    }
    throw error;
  } finally {
    vehicleTrackerMetrics.observeDatabaseQuery(
      operation,
      (performance.now() - startedAt) / 1_000,
      sqlState,
    );
    updateTrackerPoolMetrics(databasePool);
  }
}

export async function closeVehicleTrackerPool() {
  const databasePool = trackerPool;
  trackerPool = null;
  if (databasePool) await databasePool.end();
}

export function getVehicleTrackerPoolSnapshot() {
  const databasePool = trackerPool;
  if (!databasePool) {
    return {
      total: 0,
      idle: 0,
      waiting: 0,
      max: ENV.vehicleTrackerDatabasePoolMax,
    };
  }
  updateTrackerPoolMetrics(databasePool);
  return {
    total: databasePool.totalCount,
    idle: databasePool.idleCount,
    waiting: databasePool.waitingCount,
    max: ENV.vehicleTrackerDatabasePoolMax,
  };
}

function one<T>(rows: T[], label: string) {
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

export type RentalAddOn = {
  id: string;
  addOnCode: string;
  displayName: string;
  category: string;
  chargeUnit: "flat" | "per_day" | "per_week";
  unitPriceMinor: number;
  maxQuantity: number;
  currency: string;
};

export type RentalOperationsSnapshot = {
  assetStateCounts: Record<string, number>;
  activeAvailabilityBlocks: number;
  activeAvailabilityBlockItems: Array<{
    id: string;
    assetId: string;
    reason: string;
    note: string;
    startsAt: string;
    endsAt: string;
  }>;
  requestedExtensions: number;
  requestedExtensionItems: Array<{
    id: string;
    contractId: string;
    reference: string;
    workerUserId: number;
    requestedEndsAt: string;
    createdAt: string;
  }>;
  providerLocations: Array<{
    id: string;
    providerId: string;
    locationCode: string;
    displayName: string;
    addressSummary: string;
    timezoneName: string;
  }>;
  currentAssetLocations: Array<{
    assetId: string;
    registrationNumber: string;
    make: string;
    model: string;
    providerId: string;
    locationId: string | null;
    locationName: string | null;
    locationCode: string | null;
    assignedAt: string | null;
  }>;
  upcomingPickups: Array<{
    contractId: string;
    reference: string;
    assetId: string;
    startsAt: string;
    location: string | null;
  }>;
  upcomingReturns: Array<{
    contractId: string;
    reference: string;
    assetId: string;
    endsAt: string;
    state: ContractState;
  }>;
};

type RentalOperationsSnapshotWire = {
  asset_state_counts: Record<string, number>;
  active_availability_blocks: number;
  active_availability_block_items: Array<{
    id: string;
    asset_id: string;
    reason: string;
    note: string;
    starts_at: string;
    ends_at: string;
  }>;
  requested_extensions: number;
  requested_extension_items: Array<{
    id: string;
    contract_id: string;
    reference: string;
    worker_user_id: number;
    requested_ends_at: string;
    created_at: string;
  }>;
  provider_locations: Array<{
    id: string;
    provider_id: string;
    location_code: string;
    display_name: string;
    address_summary: string;
    timezone_name: string;
  }>;
  current_asset_locations: Array<{
    asset_id: string;
    registration_number: string;
    make: string;
    model: string;
    provider_id: string;
    location_id: string | null;
    location_name: string | null;
    location_code: string | null;
    assigned_at: string | null;
  }>;
  upcoming_pickups: Array<{
    contract_id: string;
    reference: string;
    asset_id: string;
    starts_at: string;
    location: string | null;
  }>;
  upcoming_returns: Array<{
    contract_id: string;
    reference: string;
    asset_id: string;
    ends_at: string;
    state: ContractState;
  }>;
};

export async function createVehicleProviderLocation(input: {
  actorUserId: number;
  providerId: string;
  locationCode: string;
  displayName: string;
  addressSummary: string;
  timezoneName: string;
  idempotencyKey: string;
}) {
  const result = await database().query<{ id: string }>(
    `SELECT vehicle_access.create_provider_location($1,$2::uuid,$3,$4,$5,$6,$7) AS id`,
    [
      input.actorUserId,
      input.providerId,
      input.locationCode,
      input.displayName,
      input.addressSummary,
      input.timezoneName,
      input.idempotencyKey,
    ],
  );
  return one(result.rows, "vehicle_provider_location").id;
}

export async function assignVehicleAssetLocation(input: {
  actorUserId: number;
  assetId: string;
  locationId: string;
  idempotencyKey: string;
}) {
  const result = await database().query<{ id: string }>(
    `SELECT vehicle_access.assign_asset_location($1,$2::uuid,$3::uuid,$4) AS id`,
    [input.actorUserId, input.assetId, input.locationId, input.idempotencyKey],
  );
  return one(result.rows, "vehicle_asset_location_assignment").id;
}

export async function createVehicleAvailabilityBlock(input: {
  actorUserId: number;
  assetId: string;
  reason:
    | "maintenance"
    | "inspection"
    | "operator_hold"
    | "seasonal_unavailable"
    | "repair";
  note: string;
  startsAt: string;
  endsAt: string;
  idempotencyKey: string;
}) {
  const result = await database().query<{ id: string }>(
    `SELECT vehicle_access.create_availability_block($1,$2::uuid,$3,$4,$5::timestamptz,$6::timestamptz,$7) AS id`,
    [
      input.actorUserId,
      input.assetId,
      input.reason,
      input.note,
      input.startsAt,
      input.endsAt,
      input.idempotencyKey,
    ],
  );
  return one(result.rows, "vehicle_availability_block").id;
}

export async function cancelVehicleAvailabilityBlock(input: {
  actorUserId: number;
  availabilityBlockId: string;
  reason: string;
  idempotencyKey: string;
}) {
  const result = await database().query<{ state: "cancelled" }>(
    `SELECT vehicle_access.cancel_availability_block($1,$2::uuid,$3,$4) AS state`,
    [
      input.actorUserId,
      input.availabilityBlockId,
      input.reason,
      input.idempotencyKey,
    ],
  );
  return one(result.rows, "vehicle_availability_block_state").state;
}

export async function createVehicleRentalAddOn(input: {
  actorUserId: number;
  providerId: string;
  addOnCode: string;
  displayName: string;
  category:
    | "protection"
    | "equipment"
    | "fuel_plan"
    | "additional_driver"
    | "assistance"
    | "other";
  currency: string;
  chargeUnit: "flat" | "per_day" | "per_week";
  unitPriceMinor: number;
  maxQuantity: number;
  idempotencyKey: string;
}) {
  const result = await database().query<{ id: string }>(
    `SELECT vehicle_access.create_rental_add_on($1,$2::uuid,$3,$4,$5,$6::char(3),$7::vehicle_access.rental_add_on_charge_unit,$8::bigint,$9::smallint,$10) AS id`,
    [
      input.actorUserId,
      input.providerId,
      input.addOnCode,
      input.displayName,
      input.category,
      input.currency,
      input.chargeUnit,
      input.unitPriceMinor,
      input.maxQuantity,
      input.idempotencyKey,
    ],
  );
  return one(result.rows, "vehicle_rental_add_on").id;
}

export async function listVehicleRentalAddOns(input: {
  offerId: string;
  limit: number;
}) {
  const result = await database().query<{
    id: string;
    add_on_code: string;
    display_name: string;
    category: string;
    charge_unit: RentalAddOn["chargeUnit"];
    unit_price_minor: string | number;
    max_quantity: number;
    currency: string;
  }>(
    `SELECT * FROM vehicle_access.list_rental_add_ons_for_offer($1::uuid,$2)`,
    [input.offerId, input.limit],
  );
  return result.rows.map(
    (row): RentalAddOn => ({
      id: row.id,
      addOnCode: row.add_on_code,
      displayName: row.display_name,
      category: row.category,
      chargeUnit: row.charge_unit,
      unitPriceMinor: Number(row.unit_price_minor),
      maxQuantity: Number(row.max_quantity),
      currency: row.currency,
    }),
  );
}

export async function requestVehicleAccessWithAddOns(input: {
  workerUserId: number;
  offerId: string;
  startsAt: string;
  endsAt: string;
  addOns: Array<{ addOnVersionId: string; quantity: number }>;
  idempotencyKey: string;
}) {
  const result = await database().query<{ id: string }>(
    `SELECT vehicle_access.request_contract_with_add_ons($1,$2::uuid,$3::timestamptz,$4::timestamptz,$5::jsonb,$6) AS id`,
    [
      input.workerUserId,
      input.offerId,
      input.startsAt,
      input.endsAt,
      JSON.stringify(
        input.addOns.map((entry) => ({
          add_on_version_id: entry.addOnVersionId,
          quantity: entry.quantity,
        })),
      ),
      input.idempotencyKey,
    ],
  );
  return one(result.rows, "vehicle_access_contract").id;
}

export async function recordVehicleAgreementAcceptance(input: {
  workerUserId: number;
  contractId: string;
  agreementVersion: string;
  agreementSha256Hex: string;
  acceptanceSha256Hex: string;
  idempotencyKey: string;
}) {
  const result = await database().query<{ id: string }>(
    `SELECT vehicle_access.record_agreement_acceptance($1,$2::uuid,$3,$4,$5,$6) AS id`,
    [
      input.workerUserId,
      input.contractId,
      input.agreementVersion,
      input.agreementSha256Hex,
      input.acceptanceSha256Hex,
      input.idempotencyKey,
    ],
  );
  return one(result.rows, "vehicle_contract_agreement").id;
}

export async function requestVehicleContractExtension(input: {
  workerUserId: number;
  contractId: string;
  requestedEndsAt: string;
  idempotencyKey: string;
}) {
  const result = await database().query<{ id: string }>(
    `SELECT vehicle_access.request_contract_extension($1,$2::uuid,$3::timestamptz,$4) AS id`,
    [
      input.workerUserId,
      input.contractId,
      input.requestedEndsAt,
      input.idempotencyKey,
    ],
  );
  return one(result.rows, "vehicle_contract_extension").id;
}

export async function decideVehicleContractExtension(input: {
  actorUserId: number;
  extensionRequestId: string;
  action: "approve" | "reject";
  reason?: string | null;
  idempotencyKey: string;
}) {
  const result = await database().query<{
    state: "approved" | "rejected";
  }>(
    `SELECT vehicle_access.decide_contract_extension($1,$2::uuid,$3,$4,$5) AS state`,
    [
      input.actorUserId,
      input.extensionRequestId,
      input.action,
      input.reason ?? null,
      input.idempotencyKey,
    ],
  );
  return one(result.rows, "vehicle_contract_extension_state").state;
}

export async function getVehicleRentalOperationsSnapshot(actorUserId: number) {
  const result = await database().query<{
    snapshot: RentalOperationsSnapshotWire;
  }>(`SELECT vehicle_access.rental_operations_snapshot($1) AS snapshot`, [
    actorUserId,
  ]);
  const snapshot = one(
    result.rows,
    "vehicle_rental_operations_snapshot",
  ).snapshot;
  return {
    assetStateCounts: snapshot.asset_state_counts ?? {},
    activeAvailabilityBlocks: Number(snapshot.active_availability_blocks ?? 0),
    activeAvailabilityBlockItems: (
      snapshot.active_availability_block_items ?? []
    ).map((item) => ({
      id: item.id,
      assetId: item.asset_id,
      reason: item.reason,
      note: item.note,
      startsAt: item.starts_at,
      endsAt: item.ends_at,
    })),
    requestedExtensions: Number(snapshot.requested_extensions ?? 0),
    requestedExtensionItems: (snapshot.requested_extension_items ?? []).map(
      (item) => ({
        id: item.id,
        contractId: item.contract_id,
        reference: item.reference,
        workerUserId: Number(item.worker_user_id),
        requestedEndsAt: item.requested_ends_at,
        createdAt: item.created_at,
      }),
    ),
    providerLocations: (snapshot.provider_locations ?? []).map((item) => ({
      id: item.id,
      providerId: item.provider_id,
      locationCode: item.location_code,
      displayName: item.display_name,
      addressSummary: item.address_summary,
      timezoneName: item.timezone_name,
    })),
    currentAssetLocations: (snapshot.current_asset_locations ?? []).map(
      (item) => ({
        assetId: item.asset_id,
        registrationNumber: item.registration_number,
        make: item.make,
        model: item.model,
        providerId: item.provider_id,
        locationId: item.location_id,
        locationName: item.location_name,
        locationCode: item.location_code,
        assignedAt: item.assigned_at,
      }),
    ),
    upcomingPickups: (snapshot.upcoming_pickups ?? []).map((item) => ({
      contractId: item.contract_id,
      reference: item.reference,
      assetId: item.asset_id,
      startsAt: item.starts_at,
      location: item.location,
    })),
    upcomingReturns: (snapshot.upcoming_returns ?? []).map((item) => ({
      contractId: item.contract_id,
      reference: item.reference,
      assetId: item.asset_id,
      endsAt: item.ends_at,
      state: item.state,
    })),
  } satisfies RentalOperationsSnapshot;
}

type TrackerOperationsSnapshotWire = {
  active_trackers?: number;
  open_flags?: number;
  recent_positions?: Array<{
    tracker_id: string;
    asset_id: string;
    contract_id: string | null;
    observed_at: string;
    latitude: number;
    longitude: number;
    speed_kph: number | null;
    ignition_on: boolean | null;
    integrity_score: number;
  }>;
  recent_flags?: Array<{
    id: string;
    asset_id: string;
    contract_id: string | null;
    flag_code: string;
    severity: "info" | "warning" | "critical";
    detected_at: string;
    detail: Record<string, unknown>;
  }>;
  control_cases?: Array<{
    id: string;
    contract_id: string;
    asset_id: string;
    state: string;
    reason_code: string;
    requested_by_user_id: number | null;
    authorized_by_user_id: number | null;
    expires_at: string;
    created_at: string;
  }>;
};

export type VehicleTrackerOperationsSnapshot = {
  activeTrackers: number;
  openFlags: number;
  recentPositions: Array<{
    trackerId: string;
    assetId: string;
    contractId: string | null;
    observedAt: string;
    latitude: number;
    longitude: number;
    speedKph: number | null;
    ignitionOn: boolean | null;
    integrityScore: number;
  }>;
  recentFlags: Array<{
    id: string;
    assetId: string;
    contractId: string | null;
    flagCode: string;
    severity: "info" | "warning" | "critical";
    detectedAt: string;
    detail: Record<string, unknown>;
  }>;
  controlCases: Array<{
    id: string;
    contractId: string;
    assetId: string;
    state: string;
    reasonCode: string;
    requestedByUserId: number | null;
    authorizedByUserId: number | null;
    expiresAt: string;
    createdAt: string;
  }>;
};

export type VehicleTrackerProviderKind =
  | "generic_webhook"
  | "samsara_webhook"
  | "geotab_feed"
  | "traccar_rest"
  | "oem_gateway"
  | "aftermarket_gateway";

export type VehicleTrackerSignalKind =
  | "position"
  | "engine"
  | "tamper"
  | "emergency"
  | "provider_geofence"
  | "command_ack";

export async function createVehicleTrackerProvider(input: {
  actorUserId: number;
  fleetProviderId: string;
  providerKind: VehicleTrackerProviderKind;
  integrationKey: string;
  displayName: string;
  credentialRef: string;
  idempotencyKey: string;
}) {
  const result = await database().query<{ id: string }>(
    `SELECT vehicle_access.create_tracker_provider($1,$2::uuid,$3::vehicle_access.tracker_provider_kind,$4,$5,$6,$7) AS id`,
    [
      input.actorUserId,
      input.fleetProviderId,
      input.providerKind,
      input.integrationKey,
      input.displayName,
      input.credentialRef,
      input.idempotencyKey,
    ],
  );
  return one(result.rows, "vehicle_tracker_provider").id;
}

export async function registerVehicleAssetTracker(input: {
  actorUserId: number;
  assetId: string;
  trackerProviderId: string;
  externalDeviceId: string;
  deviceIdentifierSha256: string;
  supportsPreventNextStart: boolean;
  idempotencyKey: string;
}) {
  const result = await database().query<{ id: string }>(
    `SELECT vehicle_access.register_asset_tracker($1,$2::uuid,$3::uuid,$4,$5,$6,$7) AS id`,
    [
      input.actorUserId,
      input.assetId,
      input.trackerProviderId,
      input.externalDeviceId,
      input.deviceIdentifierSha256,
      input.supportsPreventNextStart,
      input.idempotencyKey,
    ],
  );
  return one(result.rows, "vehicle_asset_tracker").id;
}

export async function createVehicleRentalGeofence(input: {
  actorUserId: number;
  assetId: string;
  geofenceKind: "restricted" | "return_zone" | "service_zone";
  code: string;
  displayName: string;
  geojson: Record<string, unknown>;
  idempotencyKey: string;
}) {
  const result = await database().query<{ id: string }>(
    `SELECT vehicle_access.create_rental_asset_geofence($1,$2::uuid,$3::vehicle_access.rental_geofence_kind,$4,$5,$6::jsonb,$7) AS id`,
    [
      input.actorUserId,
      input.assetId,
      input.geofenceKind,
      input.code,
      input.displayName,
      JSON.stringify(input.geojson),
      input.idempotencyKey,
    ],
  );
  return one(result.rows, "vehicle_rental_geofence").id;
}

export async function recordVehicleTrackerControlConsent(input: {
  workerUserId: number;
  contractId: string;
  consentVersion: string;
  consentSha256Hex: string;
  idempotencyKey: string;
}) {
  const result = await database().query<{ id: string }>(
    `SELECT vehicle_access.record_tracker_control_consent($1,$2::uuid,$3,$4,$5) AS id`,
    [
      input.workerUserId,
      input.contractId,
      input.consentVersion,
      input.consentSha256Hex,
      input.idempotencyKey,
    ],
  );
  return one(result.rows, "vehicle_tracker_control_consent").id;
}

export async function ingestVehicleTrackerSignal(input: {
  trackerId: string;
  externalEventId: string;
  signalKind: VehicleTrackerSignalKind;
  observedAt: string;
  latitude?: number | null;
  longitude?: number | null;
  speedKph?: number | null;
  headingDegrees?: number | null;
  accuracyM?: number | null;
  odometerKm?: number | null;
  ignitionOn?: boolean | null;
  integrityScore: number;
  payloadSha256Hex: string;
  normalizedPayload: Record<string, unknown>;
}) {
  const result = await database().query<{ id: string }>(
    `SELECT vehicle_access.record_vehicle_tracker_signal(
      $1::uuid,$2,$3::vehicle_access.tracker_signal_kind,$4::timestamptz,
      $5::numeric,$6::numeric,$7::numeric,$8::numeric,$9::numeric,$10::numeric,
      $11::boolean,$12::smallint,$13,$14::jsonb
    ) AS id`,
    [
      input.trackerId,
      input.externalEventId,
      input.signalKind,
      input.observedAt,
      input.latitude ?? null,
      input.longitude ?? null,
      input.speedKph ?? null,
      input.headingDegrees ?? null,
      input.accuracyM ?? null,
      input.odometerKm ?? null,
      input.ignitionOn ?? null,
      input.integrityScore,
      input.payloadSha256Hex,
      JSON.stringify(input.normalizedPayload),
    ],
  );
  return one(result.rows, "vehicle_tracker_signal").id;
}

export async function recordVehicleRentalPaymentTrackingSignal(input: {
  actorUserId: number;
  contractId: string;
  paymentReferenceSha256Hex: string;
  state: "past_due" | "cured" | "disputed" | "unknown";
  effectiveAt: string;
  graceEndsAt?: string | null;
  evidenceSha256Hex: string;
  source: string;
  idempotencyKey: string;
}) {
  const result = await database().query<{ id: string }>(
    `SELECT vehicle_access.record_rental_payment_tracking_signal($1,$2::uuid,$3,$4::vehicle_access.rental_payment_tracking_state,$5::timestamptz,$6::timestamptz,$7,$8,$9) AS id`,
    [
      input.actorUserId,
      input.contractId,
      input.paymentReferenceSha256Hex,
      input.state,
      input.effectiveAt,
      input.graceEndsAt ?? null,
      input.evidenceSha256Hex,
      input.source,
      input.idempotencyKey,
    ],
  );
  return one(result.rows, "vehicle_rental_payment_tracking_signal").id;
}

export async function requestVehiclePreventNextStart(input: {
  actorUserId: number;
  contractId: string;
  paymentTrackingSignalId: string;
  reasonCode: string;
  idempotencyKey: string;
}) {
  const result = await database().query<{ id: string }>(
    `SELECT vehicle_access.request_prevent_next_start($1,$2::uuid,$3::uuid,$4,$5) AS id`,
    [
      input.actorUserId,
      input.contractId,
      input.paymentTrackingSignalId,
      input.reasonCode,
      input.idempotencyKey,
    ],
  );
  return one(result.rows, "vehicle_prevent_next_start_case").id;
}

export async function authorizeVehiclePreventNextStart(input: {
  actorUserId: number;
  controlCaseId: string;
  idempotencyKey: string;
}) {
  const result = await database().query<{ state: "authorized" }>(
    `SELECT vehicle_access.authorize_prevent_next_start($1,$2::uuid,$3) AS state`,
    [input.actorUserId, input.controlCaseId, input.idempotencyKey],
  );
  return one(result.rows, "vehicle_prevent_next_start_state").state;
}

export async function cancelVehiclePreventNextStart(input: {
  actorUserId: number;
  controlCaseId: string;
  reason: string;
  idempotencyKey: string;
}) {
  const result = await database().query<{ state: "cancelled" }>(
    `SELECT vehicle_access.cancel_prevent_next_start($1,$2::uuid,$3,$4) AS state`,
    [
      input.actorUserId,
      input.controlCaseId,
      input.reason,
      input.idempotencyKey,
    ],
  );
  return one(result.rows, "vehicle_prevent_next_start_state").state;
}

export async function getVehicleTrackerOperationsSnapshot(actorUserId: number) {
  const result = await database().query<{
    snapshot: TrackerOperationsSnapshotWire;
  }>(`SELECT vehicle_access.tracker_operations_snapshot($1) AS snapshot`, [
    actorUserId,
  ]);
  const snapshot = one(
    result.rows,
    "vehicle_tracker_operations_snapshot",
  ).snapshot;
  return {
    activeTrackers: Number(snapshot.active_trackers ?? 0),
    openFlags: Number(snapshot.open_flags ?? 0),
    recentPositions: (snapshot.recent_positions ?? []).map((item) => ({
      trackerId: item.tracker_id,
      assetId: item.asset_id,
      contractId: item.contract_id,
      observedAt: item.observed_at,
      latitude: Number(item.latitude),
      longitude: Number(item.longitude),
      speedKph: item.speed_kph === null ? null : Number(item.speed_kph),
      ignitionOn: item.ignition_on,
      integrityScore: Number(item.integrity_score),
    })),
    recentFlags: (snapshot.recent_flags ?? []).map((item) => ({
      id: item.id,
      assetId: item.asset_id,
      contractId: item.contract_id,
      flagCode: item.flag_code,
      severity: item.severity,
      detectedAt: item.detected_at,
      detail: item.detail,
    })),
    controlCases: (snapshot.control_cases ?? []).map((item) => ({
      id: item.id,
      contractId: item.contract_id,
      assetId: item.asset_id,
      state: item.state,
      reasonCode: item.reason_code,
      requestedByUserId: item.requested_by_user_id,
      authorizedByUserId: item.authorized_by_user_id,
      expiresAt: item.expires_at,
      createdAt: item.created_at,
    })),
  } satisfies VehicleTrackerOperationsSnapshot;
}

export type ClaimedVehiclePreventNextStartCommand = {
  commandId: string;
  controlCaseId: string;
  claimToken: string;
  trackerId: string;
  providerKind: VehicleTrackerProviderKind;
  externalDeviceId: string;
};

export async function resolveActiveVehicleTrackerForIngress(input: {
  integrationKey: string;
  externalDeviceId: string;
}) {
  const result = await database().query<{
    tracker_id: string;
    provider_kind: VehicleTrackerProviderKind;
  }>(`SELECT * FROM vehicle_access.resolve_active_tracker_for_ingress($1,$2)`, [
    input.integrationKey,
    input.externalDeviceId,
  ]);
  return result.rows[0]
    ? {
        trackerId: result.rows[0].tracker_id,
        providerKind: result.rows[0].provider_kind,
      }
    : null;
}

export async function claimVehiclePreventNextStartCommand(input: {
  workerId: string;
}) {
  const result = await database().query<{
    command_id: string;
    case_id: string;
    claim_token: string;
    tracker_id: string;
    provider_kind: VehicleTrackerProviderKind;
    external_device_id: string;
  }>(`SELECT * FROM vehicle_access.claim_prevent_next_start_command($1)`, [
    input.workerId,
  ]);
  const row = result.rows[0];
  if (!row) return null;
  return {
    commandId: row.command_id,
    controlCaseId: row.case_id,
    claimToken: row.claim_token,
    trackerId: row.tracker_id,
    providerKind: row.provider_kind,
    externalDeviceId: row.external_device_id,
  } satisfies ClaimedVehiclePreventNextStartCommand;
}

export async function markVehiclePreventNextStartDispatched(input: {
  commandId: string;
  claimToken: string;
  providerCommandId: string;
}) {
  const result = await database().query<{ state: "dispatched" }>(
    `SELECT vehicle_access.mark_prevent_next_start_dispatched($1::uuid,$2::uuid,$3) AS state`,
    [input.commandId, input.claimToken, input.providerCommandId],
  );
  return one(result.rows, "vehicle_prevent_next_start_dispatch").state;
}

export async function completeVehiclePreventNextStartCommand(input: {
  commandId: string;
  claimToken: string;
  success: boolean;
  acknowledgementSha256Hex: string;
  reason: string;
}) {
  const result = await database().query<{
    state: "acknowledged" | "failed";
  }>(
    `SELECT vehicle_access.complete_prevent_next_start_command($1::uuid,$2::uuid,$3,$4,$5) AS state`,
    [
      input.commandId,
      input.claimToken,
      input.success,
      input.acknowledgementSha256Hex,
      input.reason,
    ],
  );
  return one(result.rows, "vehicle_prevent_next_start_completion").state;
}

export async function failClaimedVehiclePreventNextStartCommand(input: {
  commandId: string;
  claimToken: string;
  reason: string;
}) {
  const result = await database().query<{ state: "failed" }>(
    `SELECT vehicle_access.fail_claimed_prevent_next_start_command($1::uuid,$2::uuid,$3) AS state`,
    [input.commandId, input.claimToken, input.reason],
  );
  return one(result.rows, "vehicle_prevent_next_start_failure").state;
}

export type VehicleTrackerIngestSource =
  | "geotab_getfeed"
  | "traccar_rest"
  | "traccar_websocket";

export type ClaimedVehicleTrackerProviderIngest = {
  trackerProviderId: string;
  integrationKey: string;
  credentialRef: string;
  providerKind: "geotab_feed" | "traccar_rest";
  feedCursor: string | null;
  claimToken: string;
};

export async function claimVehicleTrackerProviderIngest(input: {
  providerKind: "geotab_feed" | "traccar_rest";
  workerId: string;
}) {
  const result = await trackerQuery<{
    tracker_provider_id: string;
    integration_key: string;
    credential_ref: string;
    provider_kind: "geotab_feed" | "traccar_rest";
    feed_cursor: string | null;
    claim_token: string;
  }>(
    "claim",
    `SELECT * FROM vehicle_access.claim_tracker_provider_ingest(
      $1::vehicle_access.tracker_provider_kind,$2
    )`,
    [input.providerKind, input.workerId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    trackerProviderId: row.tracker_provider_id,
    integrationKey: row.integration_key,
    credentialRef: row.credential_ref,
    providerKind: row.provider_kind,
    feedCursor: row.feed_cursor,
    claimToken: row.claim_token,
  } satisfies ClaimedVehicleTrackerProviderIngest;
}

export async function renewVehicleTrackerProviderIngestClaim(input: {
  trackerProviderId: string;
  claimToken: string;
}) {
  await trackerQuery(
    "renew",
    `SELECT vehicle_access.renew_tracker_provider_ingest_claim($1::uuid,$2::uuid)`,
    [input.trackerProviderId, input.claimToken],
  );
}

export async function completeVehicleTrackerProviderIngestBatch(input: {
  trackerProviderId: string;
  claimToken: string;
  source: VehicleTrackerIngestSource;
  batchKey: string;
  expectedCursor?: string | null;
  nextCursor?: string | null;
  payloadSha256Hex: string;
  recordCount: number;
  keepClaim?: boolean;
}) {
  const result = await trackerQuery<{ cursor: string }>(
    "complete",
    `SELECT vehicle_access.complete_tracker_provider_ingest_batch(
      $1::uuid,$2::uuid,$3::vehicle_access.tracker_ingest_source,
      $4,$5,$6,$7,$8,$9
    ) AS cursor`,
    [
      input.trackerProviderId,
      input.claimToken,
      input.source,
      input.batchKey,
      input.expectedCursor ?? null,
      input.nextCursor ?? null,
      input.payloadSha256Hex,
      input.recordCount,
      input.keepClaim ?? false,
    ],
  );
  return one(result.rows, "vehicle_tracker_provider_ingest_cursor").cursor;
}

export async function releaseVehicleTrackerProviderIngestClaim(input: {
  trackerProviderId: string;
  claimToken: string;
  errorCode: string;
}) {
  await trackerQuery(
    "release",
    `SELECT vehicle_access.release_tracker_provider_ingest_claim($1::uuid,$2::uuid,$3)`,
    [input.trackerProviderId, input.claimToken, input.errorCode],
  );
}

export type BulkVehicleTrackerSignalInput = {
  externalDeviceId: string;
  externalEventId: string;
  signalKind: VehicleTrackerSignalKind;
  observedAt: string;
  latitude?: number | null;
  longitude?: number | null;
  speedKph?: number | null;
  headingDegrees?: number | null;
  accuracyM?: number | null;
  odometerKm?: number | null;
  ignitionOn?: boolean | null;
  integrityScore: number;
  payloadSha256Hex: string;
  normalizedPayload: Record<string, unknown>;
};

export type BulkVehicleTrackerSignalResult = {
  recorded: number;
  duplicates: number;
  unknownDevices: number;
  outcomes: Array<{
    index: number;
    external_event_id: string;
    tracker_signal_id?: string;
    outcome: "recorded" | "duplicate" | "unknown_device";
  }>;
};

export async function bulkRecordVehicleTrackerProviderSignals(input: {
  trackerProviderId: string;
  claimToken: string;
  source: VehicleTrackerIngestSource;
  records: BulkVehicleTrackerSignalInput[];
}) {
  const result = await trackerQuery<{
    result: {
      recorded: number;
      duplicates: number;
      unknown_devices: number;
      outcomes: BulkVehicleTrackerSignalResult["outcomes"];
    };
  }>(
    "bulk_record",
    `SELECT vehicle_access.bulk_record_tracker_provider_signals(
      $1::uuid,$2::uuid,$3::vehicle_access.tracker_ingest_source,$4::jsonb
    ) AS result`,
    [
      input.trackerProviderId,
      input.claimToken,
      input.source,
      JSON.stringify(
        input.records.map((record) => ({
          external_device_id: record.externalDeviceId,
          external_event_id: record.externalEventId,
          signal_kind: record.signalKind,
          observed_at: record.observedAt,
          latitude: record.latitude ?? null,
          longitude: record.longitude ?? null,
          speed_kph: record.speedKph ?? null,
          heading_degrees: record.headingDegrees ?? null,
          accuracy_m: record.accuracyM ?? null,
          odometer_km: record.odometerKm ?? null,
          ignition_on: record.ignitionOn ?? null,
          integrity_score: record.integrityScore,
          payload_sha256_hex: record.payloadSha256Hex,
          normalized_payload: record.normalizedPayload,
        })),
      ),
    ],
  );
  const bulk = one(result.rows, "vehicle_tracker_bulk_signal_result").result;
  return {
    recorded: Number(bulk.recorded),
    duplicates: Number(bulk.duplicates),
    unknownDevices: Number(bulk.unknown_devices),
    outcomes: bulk.outcomes,
  } satisfies BulkVehicleTrackerSignalResult;
}

export async function getVehicleTrackerDatabaseLockMetrics() {
  const result = await trackerQuery<{
    active_transactions: number;
    lock_waiting_transactions: number;
    max_lock_wait_seconds: string | number;
  }>(
    "observability",
    `SELECT * FROM vehicle_access.tracker_worker_database_lock_metrics()`,
    [],
  );
  const row = one(result.rows, "vehicle_tracker_database_lock_metrics");
  return {
    activeTransactions: Number(row.active_transactions),
    lockWaitingTransactions: Number(row.lock_waiting_transactions),
    maxLockWaitSeconds: Number(row.max_lock_wait_seconds),
  };
}

export async function listVehicleTrackerProviderIngestObservability() {
  const result = await trackerQuery<{
    provider_kind: "geotab_feed" | "traccar_rest";
    integration_key: string;
    lease_expires_at_epoch: string | number;
    cursor_age_seconds: string | number;
    last_error_age_seconds: string | number | null;
  }>(
    "claim",
    `SELECT * FROM vehicle_access.list_tracker_provider_ingest_observability()`,
    [],
  );
  return result.rows.map((row) => ({
    providerKind: row.provider_kind,
    integrationKey: row.integration_key,
    leaseExpiresAtSeconds: Number(row.lease_expires_at_epoch),
    cursorAgeSeconds: Number(row.cursor_age_seconds),
    lastErrorAgeSeconds:
      row.last_error_age_seconds === null
        ? null
        : Number(row.last_error_age_seconds),
  }));
}

export async function resolveActiveVehicleTrackerForProviderIngest(input: {
  trackerProviderId: string;
  externalDeviceId: string;
}) {
  const result = await database().query<{ tracker_id: string }>(
    `SELECT vehicle_access.resolve_active_tracker_for_provider_ingest($1::uuid,$2) AS tracker_id`,
    [input.trackerProviderId, input.externalDeviceId],
  );
  return result.rows[0]?.tracker_id ?? null;
}
