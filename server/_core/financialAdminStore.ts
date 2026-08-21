import { Pool } from "pg";
import { ENV } from "./env";

let pool: Pool | null = null;

function requirePool() {
  if (!ENV.databaseUrl) throw new Error("financial_admin_database_unconfigured");
  if (!pool) {
    pool = new Pool({
      connectionString: ENV.databaseUrl,
      ssl: ENV.isProduction && !ENV.databaseUrl.includes("sslmode=disable") ? { rejectUnauthorized: false } : false,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }
  return pool;
}

export type FinancialAdminFilters = { query?: string; startDate?: Date; endDate?: Date; sort?: "updated_desc" | "updated_asc" | "created_desc" | "created_asc" };
export type FinancialHealthObservation = { dependency: "tigerbeetle" | "temporal"; status: "reachable" | "unhealthy" | "unreachable" | "unconfigured"; latencyMs: number | null; observedAt: string };
export type FinancialAdminAlert = { id: string; severity: "warning" | "critical"; source: "reconciliation" | "dependency"; title: string; detail: string; createdAt: string };

const transferOrder = (sort: FinancialAdminFilters["sort"]) => sort === "updated_asc" ? "updated_at ASC" : sort === "created_desc" ? "created_at DESC" : sort === "created_asc" ? "created_at ASC" : "updated_at DESC";

export async function getFilteredFinancialAdminSnapshot(filters: FinancialAdminFilters = {}) {
  const db = requirePool();
  const query = `${filters.query ?? ""}`.trim().slice(0, 100);
  const transferParams: unknown[] = [];
  const reconciliationParams: unknown[] = [];
  const transferWhere: string[] = [];
  const reconciliationWhere: string[] = ["ledger_consistent = FALSE"];
  if (filters.startDate) {
    transferParams.push(filters.startDate.toISOString()); transferWhere.push(`updated_at >= $${transferParams.length}`);
    reconciliationParams.push(filters.startDate.toISOString()); reconciliationWhere.push(`created_at >= $${reconciliationParams.length}`);
  }
  if (filters.endDate) {
    transferParams.push(filters.endDate.toISOString()); transferWhere.push(`updated_at <= $${transferParams.length}`);
    reconciliationParams.push(filters.endDate.toISOString()); reconciliationWhere.push(`created_at <= $${reconciliationParams.length}`);
  }
  if (query) {
    transferParams.push(`%${query}%`); transferWhere.push(`(transfer_id ILIKE $${transferParams.length} OR payer_fsp ILIKE $${transferParams.length} OR payee_fsp ILIKE $${transferParams.length} OR state ILIKE $${transferParams.length})`);
    reconciliationParams.push(`%${query}%`); reconciliationWhere.push(`(transfer_id ILIKE $${reconciliationParams.length} OR transfer_state ILIKE $${reconciliationParams.length})`);
  }
  const [transfers, reconciliations] = await Promise.all([
    db.query(`SELECT transfer_id, payer_fsp, payee_fsp, amount_minor, currency, state, created_at, updated_at FROM mojaloop_transfers ${transferWhere.length ? `WHERE ${transferWhere.join(" AND ")}` : ""} ORDER BY ${transferOrder(filters.sort)} LIMIT 100`, transferParams),
    db.query(`SELECT id, transfer_id, transfer_state, platform_refunded_minor, platform_net_settled_minor, created_at FROM mojaloop_reconciliation_audits WHERE ${reconciliationWhere.join(" AND ")} ORDER BY ${filters.sort === "created_asc" ? "created_at ASC" : "created_at DESC"} LIMIT 100`, reconciliationParams),
  ]);
  return {
    immutableTransfers: transfers.rows.map((row) => ({ transferId: String(row.transfer_id), payerFsp: String(row.payer_fsp), payeeFsp: String(row.payee_fsp), amountMinor: String(row.amount_minor), currency: String(row.currency), state: String(row.state), createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() })),
    inconsistentReconciliations: reconciliations.rows.map((row) => ({ id: String(row.id), transferId: String(row.transfer_id), transferState: String(row.transfer_state), platformRefundedMinor: String(row.platform_refunded_minor), platformNetSettledMinor: String(row.platform_net_settled_minor), createdAt: new Date(row.created_at).toISOString() })),
  };
}

export async function recordFinancialDependencyHealth(observation: FinancialHealthObservation) {
  await requirePool().query(`INSERT INTO financial_dependency_health_observations (dependency, status, latency_ms, observed_at) VALUES ($1, $2, $3, $4)`, [observation.dependency, observation.status, observation.latencyMs, observation.observedAt]);
}

export async function listFinancialDependencyHealthHistory(): Promise<FinancialHealthObservation[]> {
  const result = await requirePool().query(`SELECT dependency, status, latency_ms, observed_at FROM (SELECT dependency, status, latency_ms, observed_at, ROW_NUMBER() OVER (PARTITION BY dependency ORDER BY observed_at DESC) AS sequence FROM financial_dependency_health_observations WHERE observed_at >= NOW() - INTERVAL '24 hours') observations WHERE sequence <= 60 ORDER BY dependency, observed_at ASC`);
  return result.rows.map((row) => ({ dependency: row.dependency, status: row.status, latencyMs: row.latency_ms === null ? null : Number(row.latency_ms), observedAt: new Date(row.observed_at).toISOString() }));
}

export async function getFinancialAdminAlerts(): Promise<FinancialAdminAlert[]> {
  const db = requirePool();
  const [reconciliations, dependencies] = await Promise.all([
    db.query(`SELECT id, transfer_id, transfer_state, created_at FROM mojaloop_reconciliation_audits WHERE ledger_consistent = FALSE ORDER BY created_at DESC LIMIT 50`),
    db.query(`SELECT DISTINCT ON (dependency) dependency, status, observed_at FROM financial_dependency_health_observations ORDER BY dependency, observed_at DESC`),
  ]);
  return [
    ...reconciliations.rows.map((row) => ({ id: `reconciliation-${row.id}`, severity: "critical" as const, source: "reconciliation" as const, title: "Reconciliation inconsistency", detail: `Transfer ${row.transfer_id} is recorded as ${row.transfer_state}.`, createdAt: new Date(row.created_at).toISOString() })),
    ...dependencies.rows.filter((row) => row.status !== "reachable").map((row) => ({ id: `dependency-${row.dependency}-${new Date(row.observed_at).getTime()}`, severity: row.status === "unreachable" ? "critical" as const : "warning" as const, source: "dependency" as const, title: `${row.dependency} ${row.status}`, detail: "Review the dependency health card and promotion contract before funds processing.", createdAt: new Date(row.observed_at).toISOString() })),
  ].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 100);
}
