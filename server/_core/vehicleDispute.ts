/**
 * Data-access wrappers for the settlement dispute wave
 * (drizzle/0097_settlement_disputes.sql). Every write goes through the
 * SECURITY DEFINER authority functions in the vehicle_access schema — this
 * module never issues INSERT/UPDATE/DELETE against vehicle_access tables.
 *
 * Own satellite pool (application_name "vehicle-dispute", hard-capped at 3
 * connections, 10 s statement timeout) so dispute traffic cannot starve the
 * primary vehicle_access pool.
 */
import { Pool } from "pg";

import { ENV } from "./env";

export type DisputeStatus = "open" | "upheld" | "rejected" | "adjusted";
export type DisputeReason =
  | "damage_charge"
  | "excess_km_charge"
  | "fuel_charge"
  | "odometer_dispute"
  | "other";

export type SettlementDispute = {
  id: string;
  contractId: string;
  settlementId: string;
  renterUserId: number;
  reason: DisputeReason;
  detail: string;
  status: DisputeStatus;
  adjustmentMinor: number | null;
  operatorNote: string | null;
  decidedBy: number | null;
  decidedAt: string | null;
  idempotencyKey: string;
  createdAt: string;
};

type SettlementDisputeWire = {
  id: string;
  contract_id: string;
  settlement_id: string;
  renter_user_id: number;
  reason: DisputeReason;
  detail: string;
  status: DisputeStatus;
  adjustment_minor: string | number | null;
  operator_note: string | null;
  decided_by: number | null;
  decided_at: string | null;
  idempotency_key: string;
  created_at: string;
};

function mapDispute(row: SettlementDisputeWire): SettlementDispute {
  return {
    id: row.id,
    contractId: row.contract_id,
    settlementId: row.settlement_id,
    renterUserId: Number(row.renter_user_id),
    reason: row.reason,
    detail: row.detail,
    status: row.status,
    adjustmentMinor:
      row.adjustment_minor === null ? null : Number(row.adjustment_minor),
    operatorNote: row.operator_note ?? null,
    decidedBy: row.decided_by === null ? null : Number(row.decided_by),
    decidedAt: row.decided_at ?? null,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  };
}

let pool: Pool | null = null;

function database() {
  if (!ENV.databaseUrl)
    throw new Error("vehicle_dispute_database_unconfigured");
  if (!pool) {
    pool = new Pool({
      connectionString: ENV.databaseUrl,
      application_name: "vehicle-dispute",
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

export async function openSettlementDispute(input: {
  actorUserId: number;
  contractId: string;
  reason: DisputeReason;
  detail: string;
  idempotencyKey: string;
}) {
  const result = await database().query<{ id: string }>(
    `SELECT vehicle_access.open_settlement_dispute($1,$2::uuid,$3::vehicle_access.dispute_reason,$4,$5) AS id`,
    [
      input.actorUserId,
      input.contractId,
      input.reason,
      input.detail,
      input.idempotencyKey,
    ],
  );
  return one(result.rows, "settlement_dispute").id;
}

export async function decideSettlementDispute(input: {
  actorUserId: number;
  disputeId: string;
  status: Exclude<DisputeStatus, "open">;
  adjustmentMinor?: number | null;
  operatorNote?: string | null;
  idempotencyKey: string;
}) {
  const result = await database().query<{ id: string }>(
    `SELECT vehicle_access.decide_settlement_dispute($1,$2::uuid,$3::vehicle_access.dispute_status,$4::bigint,$5,$6) AS id`,
    [
      input.actorUserId,
      input.disputeId,
      input.status,
      input.adjustmentMinor ?? null,
      input.operatorNote ?? null,
      input.idempotencyKey,
    ],
  );
  return one(result.rows, "settlement_dispute_decide").id;
}

export async function listSettlementDisputes(input: {
  actorUserId: number;
  contractId?: string | null;
  status?: DisputeStatus | null;
  limit?: number;
}) {
  const result = await database().query<{ dispute: SettlementDisputeWire }>(
    `SELECT t.dispute FROM vehicle_access.list_settlement_disputes($1,$2::uuid,$3::vehicle_access.dispute_status,$4) AS t(dispute)`,
    [
      input.actorUserId,
      input.contractId ?? null,
      input.status ?? null,
      input.limit ?? 50,
    ],
  );
  return result.rows.map((row) => mapDispute(row.dispute));
}

export async function getSettlementDispute(input: {
  actorUserId: number;
  disputeId: string;
}) {
  const result = await database().query<{ dispute: SettlementDisputeWire }>(
    `SELECT vehicle_access.get_settlement_dispute($1,$2::uuid) AS dispute`,
    [input.actorUserId, input.disputeId],
  );
  return mapDispute(one(result.rows, "settlement_dispute").dispute);
}
