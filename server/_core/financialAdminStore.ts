import { Pool } from "pg";
import { ENV } from "./env";

let pool: Pool | null = null;

function requirePool() {
  if (!ENV.databaseUrl)
    throw new Error("financial_admin_database_unconfigured");
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
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 3000,
      options: "-c statement_timeout=10000",
    });
  }
  return pool;
}

export type FinancialAdminFilters = {
  query?: string;
  startDate?: Date;
  endDate?: Date;
  sort?: "updated_desc" | "updated_asc" | "created_desc" | "created_asc";
};
export type FinancialHealthObservation = {
  dependency: "tigerbeetle" | "temporal";
  status: "reachable" | "unhealthy" | "unreachable" | "unconfigured";
  latencyMs: number | null;
  detail: string | null;
  observedAt: string;
};
export type FinancialAdminAlert = {
  id: string;
  severity: "warning" | "critical";
  source: "reconciliation" | "dependency";
  title: string;
  detail: string;
  createdAt: string;
  action: "acknowledge" | "dismiss" | "note" | null;
  note: string | null;
};
export type FinancialDatabaseEvidence = {
  status: "verified" | "unencrypted" | "unreachable";
  tlsVersion: string | null;
  cipher: string | null;
  certificateExpiresAt: string | null;
  certificateStatus: "fresh" | "expiring" | "expired" | "unavailable";
  migrationVersions: Array<{ id: number; appliedAt: string }>;
  migrationStatus: "fresh" | "aging" | "unavailable";
  latestMigrationAgeDays: number | null;
  detail: string | null;
  checkedAt: string;
};
export type FinancialAdminSettings = {
  autoEscalationEnabled: boolean;
  autoEscalationMinutes: number;
  onCallWebhooks: string[];
  approvedWebhookHosts: string[];
  healthRetentionDays: number;
  updatedAt: string;
};

const transferOrder = (sort: FinancialAdminFilters["sort"]) =>
  sort === "updated_asc"
    ? "updated_at ASC"
    : sort === "created_desc"
      ? "created_at DESC"
      : sort === "created_asc"
        ? "created_at ASC"
        : "updated_at DESC";

export async function getFilteredFinancialAdminSnapshot(
  filters: FinancialAdminFilters = {},
) {
  const db = requirePool();
  const query = `${filters.query ?? ""}`.trim().slice(0, 100);
  const transferParams: unknown[] = [];
  const reconciliationParams: unknown[] = [];
  const transferWhere: string[] = [];
  const reconciliationWhere: string[] = ["ledger_consistent = FALSE"];
  if (filters.startDate) {
    transferParams.push(filters.startDate.toISOString());
    transferWhere.push(`updated_at >= $${transferParams.length}`);
    reconciliationParams.push(filters.startDate.toISOString());
    reconciliationWhere.push(`created_at >= $${reconciliationParams.length}`);
  }
  if (filters.endDate) {
    transferParams.push(filters.endDate.toISOString());
    transferWhere.push(`updated_at <= $${transferParams.length}`);
    reconciliationParams.push(filters.endDate.toISOString());
    reconciliationWhere.push(`created_at <= $${reconciliationParams.length}`);
  }
  if (query) {
    transferParams.push(`%${query}%`);
    transferWhere.push(
      `(transfer_id ILIKE $${transferParams.length} OR payer_fsp ILIKE $${transferParams.length} OR payee_fsp ILIKE $${transferParams.length} OR state ILIKE $${transferParams.length})`,
    );
    reconciliationParams.push(`%${query}%`);
    reconciliationWhere.push(
      `(transfer_id ILIKE $${reconciliationParams.length} OR transfer_state ILIKE $${reconciliationParams.length})`,
    );
  }
  const [transfers, reconciliations] = await Promise.all([
    db.query(
      `SELECT transfer_id, payer_fsp, payee_fsp, amount_minor, currency, state, created_at, updated_at FROM mojaloop_transfers ${transferWhere.length ? `WHERE ${transferWhere.join(" AND ")}` : ""} ORDER BY ${transferOrder(filters.sort)} LIMIT 100`,
      transferParams,
    ),
    db.query(
      `SELECT id, transfer_id, transfer_state, platform_refunded_minor, platform_net_settled_minor, created_at FROM mojaloop_reconciliation_audits WHERE ${reconciliationWhere.join(" AND ")} ORDER BY ${filters.sort === "created_asc" ? "created_at ASC" : "created_at DESC"} LIMIT 100`,
      reconciliationParams,
    ),
  ]);
  return {
    immutableTransfers: transfers.rows.map((row) => ({
      transferId: String(row.transfer_id),
      payerFsp: String(row.payer_fsp),
      payeeFsp: String(row.payee_fsp),
      amountMinor: String(row.amount_minor),
      currency: String(row.currency),
      state: String(row.state),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    })),
    inconsistentReconciliations: reconciliations.rows.map((row) => ({
      id: String(row.id),
      transferId: String(row.transfer_id),
      transferState: String(row.transfer_state),
      platformRefundedMinor: String(row.platform_refunded_minor),
      platformNetSettledMinor: String(row.platform_net_settled_minor),
      createdAt: new Date(row.created_at).toISOString(),
    })),
  };
}

export async function recordFinancialDependencyHealth(
  observation: FinancialHealthObservation,
) {
  await requirePool().query(
    `INSERT INTO financial_dependency_health_observations (dependency, status, latency_ms, detail, observed_at) VALUES ($1, $2, $3, $4, $5)`,
    [
      observation.dependency,
      observation.status,
      observation.latencyMs,
      observation.detail,
      observation.observedAt,
    ],
  );
}

export async function listFinancialDependencyHealthHistory(): Promise<
  FinancialHealthObservation[]
> {
  const settings = await getFinancialAdminSettings();
  const result = await requirePool().query(
    `SELECT dependency, status, latency_ms, detail, observed_at FROM (SELECT dependency, status, latency_ms, detail, observed_at, ROW_NUMBER() OVER (PARTITION BY dependency ORDER BY observed_at DESC) AS sequence FROM financial_dependency_health_observations WHERE observed_at >= GREATEST(NOW() - ($1::int * INTERVAL '1 day'), NOW() - INTERVAL '24 hours')) observations WHERE sequence <= 60 ORDER BY dependency, observed_at ASC`,
    [settings.healthRetentionDays],
  );
  return result.rows.map((row) => ({
    dependency: row.dependency,
    status: row.status,
    latencyMs: row.latency_ms === null ? null : Number(row.latency_ms),
    detail: row.detail ?? null,
    observedAt: new Date(row.observed_at).toISOString(),
  }));
}

export async function getFinancialAdminSettings(): Promise<FinancialAdminSettings> {
  const result = await requirePool().query(
    `SELECT auto_escalation_enabled, auto_escalation_minutes, on_call_webhooks, health_retention_days, updated_at FROM financial_admin_settings WHERE singleton = TRUE`,
  );
  const row = result.rows[0];
  if (!row)
    return {
      autoEscalationEnabled: false,
      autoEscalationMinutes: 60,
      onCallWebhooks: [],
      approvedWebhookHosts: [],
      healthRetentionDays: 30,
      updatedAt: new Date(0).toISOString(),
    };
  return {
    autoEscalationEnabled: Boolean(row.auto_escalation_enabled),
    autoEscalationMinutes: Number(row.auto_escalation_minutes),
    onCallWebhooks: Array.isArray(row.on_call_webhooks)
      ? row.on_call_webhooks.filter((item: unknown) => typeof item === "string")
      : [],
    approvedWebhookHosts: Array.isArray(row.approved_webhook_hosts)
      ? row.approved_webhook_hosts.filter(
          (item: unknown) => typeof item === "string",
        )
      : [],
    healthRetentionDays: Number(row.health_retention_days),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function updateFinancialAdminSettings(
  input: Omit<FinancialAdminSettings, "updatedAt"> & { actorId: number },
): Promise<FinancialAdminSettings> {
  const result = await requirePool().query(
    `INSERT INTO financial_admin_settings (singleton, auto_escalation_enabled, auto_escalation_minutes, on_call_webhooks, approved_webhook_hosts, health_retention_days, updated_by_operator_id, updated_at) VALUES (TRUE, $1, $2, $3::jsonb, $4::jsonb, $5, $6, NOW()) ON CONFLICT (singleton) DO UPDATE SET auto_escalation_enabled = EXCLUDED.auto_escalation_enabled, auto_escalation_minutes = EXCLUDED.auto_escalation_minutes, on_call_webhooks = EXCLUDED.on_call_webhooks, approved_webhook_hosts = EXCLUDED.approved_webhook_hosts, health_retention_days = EXCLUDED.health_retention_days, updated_by_operator_id = EXCLUDED.updated_by_operator_id, updated_at = NOW() RETURNING auto_escalation_enabled, auto_escalation_minutes, on_call_webhooks, approved_webhook_hosts, health_retention_days, updated_at`,
    [
      input.autoEscalationEnabled,
      input.autoEscalationMinutes,
      JSON.stringify(input.onCallWebhooks),
      JSON.stringify(input.approvedWebhookHosts),
      input.healthRetentionDays,
      input.actorId,
    ],
  );
  const row = result.rows[0];
  await requirePool().query(
    `DELETE FROM financial_dependency_health_observations WHERE observed_at < NOW() - ($1::int * INTERVAL '1 day')`,
    [input.healthRetentionDays],
  );
  return {
    autoEscalationEnabled: Boolean(row.auto_escalation_enabled),
    autoEscalationMinutes: Number(row.auto_escalation_minutes),
    onCallWebhooks: Array.isArray(row.on_call_webhooks)
      ? row.on_call_webhooks
      : [],
    approvedWebhookHosts: Array.isArray(row.approved_webhook_hosts)
      ? row.approved_webhook_hosts
      : [],
    healthRetentionDays: Number(row.health_retention_days),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function listFinancialAlertDeliveryReceipts() {
  const result = await requirePool().query(
    `SELECT alert_id, webhook_host, status, detail, routed_at, completed_at, 0::int AS retry_attempt, NULL::timestamptz AS retry_at FROM financial_alert_delivery_receipts ORDER BY routed_at DESC LIMIT 100`,
  );
  return result.rows.map((row) => ({
    alertId: String(row.alert_id),
    webhookHost: String(row.webhook_host),
    status: String(row.status),
    detail: row.detail ? String(row.detail) : null,
    routedAt: new Date(row.routed_at).toISOString(),
    completedAt: row.completed_at
      ? new Date(row.completed_at).toISOString()
      : null,
    retryAttempt: Number(row.retry_attempt),
    retryAt: row.retry_at ? new Date(row.retry_at).toISOString() : null,
  }));
}

export async function recordFinancialAlertDeliveryReceipt(input: {
  alertId: string;
  webhookHost: string;
  status: "queued" | "delivered" | "failed";
  detail: string | null;
  retryAttempt: number;
}) {
  const delayMinutes =
    input.status === "failed"
      ? Math.min(60, 2 ** Math.min(6, Math.max(0, input.retryAttempt)))
      : 0;
  await requirePool().query(
    `INSERT INTO financial_alert_delivery_receipts (alert_id, webhook_host, status, detail, routed_at, completed_at) VALUES ($1, $2, $3, $4, NOW(), CASE WHEN $3 = 'queued' THEN NULL ELSE NOW() END)`,
    [
      input.alertId,
      input.webhookHost,
      input.status,
      input.detail,
      input.retryAttempt,
    ],
  );
  return {
    retryAttempt: input.retryAttempt,
    retryAt: delayMinutes
      ? new Date(Date.now() + delayMinutes * 60_000).toISOString()
      : null,
  };
}

export async function getFinancialDatabaseEvidence(): Promise<FinancialDatabaseEvidence> {
  const checkedAt = new Date().toISOString();
  try {
    const db = requirePool();
    const [tls, migrations] = await Promise.all([
      db.query(
        `SELECT ssl, version, cipher FROM pg_stat_ssl WHERE pid = pg_backend_pid()`,
      ),
      db
        .query(
          `SELECT id, created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 20`,
        )
        .catch(() => ({ rows: [] })),
    ]);
    const connection = tls.rows[0];
    const migrationVersions = migrations.rows.map((row) => ({
      id: Number(row.id),
      appliedAt: new Date(Number(row.created_at)).toISOString(),
    }));
    const latestMigrationAgeDays = migrationVersions[0]
      ? Math.floor(
          (Date.now() - new Date(migrationVersions[0].appliedAt).getTime()) /
            86_400_000,
        )
      : null;
    const migrationStatus =
      latestMigrationAgeDays === null
        ? "unavailable"
        : latestMigrationAgeDays > 90
          ? "aging"
          : "fresh";
    const configuredExpiry =
      `${process.env.DATABASE_TLS_CERT_EXPIRES_AT ?? ""}`.trim();
    const expiryDate =
      configuredExpiry && !Number.isNaN(new Date(configuredExpiry).getTime())
        ? new Date(configuredExpiry)
        : null;
    const certificateStatus = !expiryDate
      ? "unavailable"
      : expiryDate.getTime() <= Date.now()
        ? "expired"
        : expiryDate.getTime() - Date.now() <= 30 * 86_400_000
          ? "expiring"
          : "fresh";
    const certificateExpiresAt = expiryDate?.toISOString() ?? null;
    if (!connection?.ssl)
      return {
        status: "unencrypted",
        tlsVersion: null,
        cipher: null,
        certificateExpiresAt,
        certificateStatus,
        migrationVersions,
        migrationStatus,
        latestMigrationAgeDays,
        detail: "The active PostgreSQL connection is not protected by TLS.",
        checkedAt,
      };
    return {
      status: "verified",
      tlsVersion: connection.version ?? null,
      cipher: connection.cipher ?? null,
      certificateExpiresAt,
      certificateStatus,
      migrationVersions,
      migrationStatus,
      latestMigrationAgeDays,
      detail: null,
      checkedAt,
    };
  } catch {
    return {
      status: "unreachable",
      tlsVersion: null,
      cipher: null,
      certificateExpiresAt: null,
      certificateStatus: "unavailable",
      migrationVersions: [],
      migrationStatus: "unavailable",
      latestMigrationAgeDays: null,
      detail: "PostgreSQL TLS and migration evidence could not be retrieved.",
      checkedAt,
    };
  }
}

export async function recordFinancialAdminAlertAction(input: {
  alertId: string;
  action: "acknowledge" | "dismiss" | "note";
  note: string | null;
  actorId: number;
}) {
  await requirePool().query(
    `INSERT INTO financial_admin_alert_actions (alert_id, action, note, actor_id) VALUES ($1, $2, $3, $4)`,
    [input.alertId, input.action, input.note, input.actorId],
  );
}

export async function assignAlertOwnership(input: {
  alertId: string;
  assignedTo: number;
  escalationDeadline: string | null;
  actorId: number;
}) {
  const note = `Assigned to operator ${input.assignedTo}${input.escalationDeadline ? ` with deadline ${input.escalationDeadline}` : ""}`;
  await requirePool().query(
    `INSERT INTO financial_admin_alert_actions (alert_id, action, note, actor_id, assigned_to_operator_id, escalation_deadline) VALUES ($1, 'assign', $2, $3, $4, $5)`,
    [
      input.alertId,
      note,
      input.actorId,
      input.assignedTo,
      input.escalationDeadline,
    ],
  );
}

export async function getAlertOwnership(
  alertId: string,
): Promise<{ assignedTo: number | null; escalationDeadline: string | null }> {
  const result = await requirePool().query(
    `SELECT assigned_to_operator_id, escalation_deadline FROM financial_admin_alert_actions WHERE alert_id = $1 AND assigned_to_operator_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
    [alertId],
  );
  if (result.rows.length === 0)
    return { assignedTo: null, escalationDeadline: null };
  return {
    assignedTo: result.rows[0].assigned_to_operator_id,
    escalationDeadline: result.rows[0].escalation_deadline
      ? new Date(result.rows[0].escalation_deadline).toISOString()
      : null,
  };
}

export async function getAlertActionHistory(): Promise<
  Array<{
    alertId: string;
    action: string;
    note: string | null;
    actorId: number;
    assignedTo: number | null;
    escalationDeadline: string | null;
    createdAt: string;
  }>
> {
  const result = await requirePool().query(
    `SELECT alert_id, action, note, actor_id, assigned_to_operator_id, escalation_deadline, created_at FROM financial_admin_alert_actions ORDER BY created_at DESC LIMIT 500`,
  );
  return result.rows.map((row) => ({
    alertId: String(row.alert_id),
    action: String(row.action),
    note: row.note ? String(row.note) : null,
    actorId: Number(row.actor_id),
    assignedTo: row.assigned_to_operator_id
      ? Number(row.assigned_to_operator_id)
      : null,
    escalationDeadline: row.escalation_deadline
      ? new Date(row.escalation_deadline).toISOString()
      : null,
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

export async function getAlertEscalations(): Promise<
  Array<{ alertId: string; assignedTo: number; escalationDeadline: string }>
> {
  const result = await requirePool().query(
    `SELECT DISTINCT ON (alert_id) alert_id, assigned_to_operator_id, escalation_deadline FROM financial_admin_alert_actions WHERE assigned_to_operator_id IS NOT NULL AND escalation_deadline IS NOT NULL ORDER BY alert_id, created_at DESC`,
  );
  return result.rows.map((row) => ({
    alertId: String(row.alert_id),
    assignedTo: Number(row.assigned_to_operator_id),
    escalationDeadline: new Date(row.escalation_deadline).toISOString(),
  }));
}

export async function getFinancialAdminAlerts(): Promise<
  FinancialAdminAlert[]
> {
  const db = requirePool();
  const [reconciliations, dependencies, actionRows, database] =
    await Promise.all([
      db.query(
        `SELECT id, transfer_id, transfer_state, created_at FROM mojaloop_reconciliation_audits WHERE ledger_consistent = FALSE ORDER BY created_at DESC LIMIT 50`,
      ),
      db.query(
        `SELECT DISTINCT ON (dependency) dependency, status, detail, observed_at FROM financial_dependency_health_observations ORDER BY dependency, observed_at DESC`,
      ),
      db.query(
        `SELECT DISTINCT ON (alert_id) alert_id, action, note FROM financial_admin_alert_actions ORDER BY alert_id, created_at DESC`,
      ),
      getFinancialDatabaseEvidence(),
    ]);
  const actions = new Map(
    actionRows.rows.map((row) => [
      String(row.alert_id),
      {
        action: row.action as FinancialAdminAlert["action"],
        note: row.note ?? null,
      },
    ]),
  );
  const applyAction = (
    alert: Omit<FinancialAdminAlert, "action" | "note">,
  ): FinancialAdminAlert => ({
    ...alert,
    ...(actions.get(alert.id) ?? { action: null, note: null }),
  });
  return [
    ...reconciliations.rows.map((row) =>
      applyAction({
        id: `reconciliation-${row.id}`,
        severity: "critical",
        source: "reconciliation",
        title: "Reconciliation inconsistency",
        detail: `Transfer ${row.transfer_id} is recorded as ${row.transfer_state}.`,
        createdAt: new Date(row.created_at).toISOString(),
      }),
    ),
    ...dependencies.rows
      .filter((row) => row.status !== "reachable")
      .map((row) =>
        applyAction({
          id: `dependency-${row.dependency}`,
          severity: row.status === "unreachable" ? "critical" : "warning",
          source: "dependency",
          title: `${row.dependency} ${row.status}`,
          detail:
            row.detail ||
            "Review the dependency health card and promotion contract before funds processing.",
          createdAt: new Date(row.observed_at).toISOString(),
        }),
      ),
    ...(database.certificateStatus === "fresh"
      ? []
      : [
          applyAction({
            id: "database-tls",
            severity:
              database.certificateStatus === "expired" ? "critical" : "warning",
            source: "dependency",
            title: `PostgreSQL TLS certificate ${database.certificateStatus}`,
            detail: database.certificateExpiresAt
              ? `Certificate evidence expires ${database.certificateExpiresAt}.`
              : "Certificate expiry evidence is unavailable; set DATABASE_TLS_CERT_EXPIRES_AT.",
            createdAt: database.checkedAt,
          }),
        ]),
    ...(database.migrationStatus === "aging"
      ? [
          applyAction({
            id: "migration-age",
            severity: "warning",
            source: "dependency",
            title: "Database migration evidence is aging",
            detail: `Latest recorded migration is ${database.latestMigrationAgeDays} days old.`,
            createdAt: database.checkedAt,
          }),
        ]
      : []),
  ]
    .filter((alert) => alert.action !== "dismiss")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 100);
}

export type FinancialDeadLetterCase = {
  caseId: string;
  outboxId: string;
  originalTransferId: string;
  state:
    | "open"
    | "approval_pending"
    | "rejected"
    | "replacement_intent_created";
  openedByUserId: number;
  requestedByUserId: number | null;
  approvedByUserId: number | null;
  ledgerDisposition:
    | "confirmed_not_committed"
    | "committed"
    | "uncertain"
    | "unavailable"
    | null;
  replacementTransferId: string | null;
  remediationOutboxId: string | null;
  lastError: string | null;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
};

function mapFinancialDeadLetterCase(
  row: Record<string, unknown>,
): FinancialDeadLetterCase {
  return {
    caseId: String(row.case_id),
    outboxId: String(row.outbox_id),
    originalTransferId: String(row.original_transfer_id),
    state: String(row.state) as FinancialDeadLetterCase["state"],
    openedByUserId: Number(row.opened_by_user_id),
    requestedByUserId:
      row.requested_by_user_id === null
        ? null
        : Number(row.requested_by_user_id),
    approvedByUserId:
      row.approved_by_user_id === null ? null : Number(row.approved_by_user_id),
    ledgerDisposition:
      row.ledger_disposition === null
        ? null
        : (String(
            row.ledger_disposition,
          ) as FinancialDeadLetterCase["ledgerDisposition"]),
    replacementTransferId:
      row.replacement_transfer_id === null
        ? null
        : String(row.replacement_transfer_id),
    remediationOutboxId:
      row.remediation_outbox_id === null
        ? null
        : String(row.remediation_outbox_id),
    lastError: row.last_error === null ? null : String(row.last_error),
    attemptCount: Number(row.attempt_count),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

export async function listFinancialDeadLetterCases(
  actorId: number,
  limit = 50,
): Promise<FinancialDeadLetterCase[]> {
  const result = await requirePool().query(
    `SELECT * FROM mojaloop_list_dead_letter_cases($1::integer, $2::integer)`,
    [actorId, limit],
  );
  return result.rows.map(mapFinancialDeadLetterCase);
}

export async function openFinancialDeadLetterCase(input: {
  actorId: number;
  outboxId: string;
  reason: string;
  investigationDigestHex: string;
  idempotencyKey: string;
}): Promise<{ caseId: string }> {
  const result = await requirePool().query(
    `SELECT mojaloop_open_dead_letter_case($1::integer, $2::bigint, $3::text, $4::text, $5::text, clock_timestamp()) AS case_id`,
    [
      input.actorId,
      input.outboxId,
      input.reason,
      input.investigationDigestHex,
      input.idempotencyKey,
    ],
  );
  return { caseId: String(result.rows[0]?.case_id ?? "") };
}

export async function requestFinancialDeadLetterRemediation(input: {
  actorId: number;
  caseId: string;
  reason: string;
  ledgerDisposition:
    | "confirmed_not_committed"
    | "committed"
    | "uncertain"
    | "unavailable";
  reconciliationReference: string;
  reconciliationDigestHex: string;
  replacementTransferId: string;
  replacementIlpPacket: string;
  replacementCondition: string;
  replacementExpiration: string;
  idempotencyKey: string;
}): Promise<{ state: string }> {
  const result = await requirePool().query(
    `SELECT mojaloop_request_dead_letter_remediation(
      $1::integer, $2::uuid, $3::text, $4::text, $5::text, $6::text,
      $7::text, $8::text, $9::text, $10::timestamptz, $11::text, clock_timestamp()
    ) AS state`,
    [
      input.actorId,
      input.caseId,
      input.reason,
      input.ledgerDisposition,
      input.reconciliationReference,
      input.reconciliationDigestHex,
      input.replacementTransferId,
      input.replacementIlpPacket,
      input.replacementCondition,
      input.replacementExpiration,
      input.idempotencyKey,
    ],
  );
  return { state: String(result.rows[0]?.state ?? "") };
}

export async function approveFinancialDeadLetterRemediation(input: {
  actorId: number;
  caseId: string;
  approvalReason: string;
  idempotencyKey: string;
}): Promise<{
  caseId: string;
  replacementTransferId: string;
  remediationOutboxId: string;
  state: string;
}> {
  const result = await requirePool().query(
    `SELECT * FROM mojaloop_approve_dead_letter_remediation($1::integer, $2::uuid, $3::text, $4::text, clock_timestamp())`,
    [input.actorId, input.caseId, input.approvalReason, input.idempotencyKey],
  );
  const row = result.rows[0];
  return {
    caseId: String(row?.case_id ?? ""),
    replacementTransferId: String(row?.replacement_transfer_id ?? ""),
    remediationOutboxId: String(row?.remediation_outbox_id ?? ""),
    state: String(row?.state ?? ""),
  };
}

export async function rejectFinancialDeadLetterRemediation(input: {
  actorId: number;
  caseId: string;
  reason: string;
  idempotencyKey: string;
}): Promise<{ state: string }> {
  const result = await requirePool().query(
    `SELECT mojaloop_reject_dead_letter_remediation($1::integer, $2::uuid, $3::text, $4::text, clock_timestamp()) AS state`,
    [input.actorId, input.caseId, input.reason, input.idempotencyKey],
  );
  return { state: String(result.rows[0]?.state ?? "") };
}

export type FinancialDeadLetterHeadResolution = {
  resolutionId: string;
  originalOutboxId: string;
  resolutionDisposition:
    | "original_confirmed_committed_resolved"
    | "original_confirmed_not_committed_superseded";
  state: "approval_pending" | "approved" | "rejected";
  requestedByUserId: number;
  requestedAt: string;
  approvedByUserId: number | null;
  approvedAt: string | null;
  rejectedByUserId: number | null;
  rejectedAt: string | null;
  reconciliationReference: string;
  reconciliationDigestHex: string;
  updatedAt: string;
};

function mapFinancialDeadLetterHeadResolution(
  row: Record<string, unknown>,
): FinancialDeadLetterHeadResolution {
  return {
    resolutionId: String(row.resolution_id),
    originalOutboxId: String(row.original_outbox_id),
    resolutionDisposition: String(row.resolution_disposition) as FinancialDeadLetterHeadResolution["resolutionDisposition"],
    state: String(row.state) as FinancialDeadLetterHeadResolution["state"],
    requestedByUserId: Number(row.requested_by_user_id),
    requestedAt: new Date(String(row.requested_at)).toISOString(),
    approvedByUserId:
      row.approved_by_user_id === null ? null : Number(row.approved_by_user_id),
    approvedAt:
      row.approved_at === null ? null : new Date(String(row.approved_at)).toISOString(),
    rejectedByUserId:
      row.rejected_by_user_id === null ? null : Number(row.rejected_by_user_id),
    rejectedAt:
      row.rejected_at === null ? null : new Date(String(row.rejected_at)).toISOString(),
    reconciliationReference: String(row.reconciliation_reference),
    reconciliationDigestHex: String(row.reconciliation_digest_hex),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

export async function getFinancialDeadLetterHeadResolution(input: {
  actorId: number;
  caseId: string;
}): Promise<FinancialDeadLetterHeadResolution | null> {
  const result = await requirePool().query(
    `SELECT * FROM mojaloop_get_dead_letter_head_resolution($1::integer, $2::uuid)`,
    [input.actorId, input.caseId],
  );
  return result.rows[0] ? mapFinancialDeadLetterHeadResolution(result.rows[0]) : null;
}

export async function requestFinancialDeadLetterHeadResolution(input: {
  actorId: number;
  caseId: string;
  resolutionDisposition: FinancialDeadLetterHeadResolution["resolutionDisposition"];
  reason: string;
  reconciliationReference: string;
  reconciliationDigestHex: string;
  idempotencyKey: string;
}): Promise<{ resolutionId: string; state: string }> {
  const result = await requirePool().query(
    `SELECT * FROM mojaloop_request_dead_letter_head_resolution(
      $1::integer, $2::uuid, $3::text, $4::text, $5::text, $6::text,
      $7::text, clock_timestamp()
    )`,
    [
      input.actorId,
      input.caseId,
      input.resolutionDisposition,
      input.reason,
      input.reconciliationReference,
      input.reconciliationDigestHex,
      input.idempotencyKey,
    ],
  );
  return {
    resolutionId: String(result.rows[0]?.resolution_id ?? ""),
    state: String(result.rows[0]?.state ?? ""),
  };
}

export async function approveFinancialDeadLetterHeadResolution(input: {
  actorId: number;
  caseId: string;
  reason: string;
  idempotencyKey: string;
}): Promise<{
  resolutionId: string;
  state: string;
  resolutionDisposition: string;
}> {
  const result = await requirePool().query(
    `SELECT * FROM mojaloop_approve_dead_letter_head_resolution(
      $1::integer, $2::uuid, $3::text, $4::text, clock_timestamp()
    )`,
    [input.actorId, input.caseId, input.reason, input.idempotencyKey],
  );
  return {
    resolutionId: String(result.rows[0]?.resolution_id ?? ""),
    state: String(result.rows[0]?.state ?? ""),
    resolutionDisposition: String(result.rows[0]?.resolution_disposition ?? ""),
  };
}

export async function rejectFinancialDeadLetterHeadResolution(input: {
  actorId: number;
  caseId: string;
  reason: string;
  idempotencyKey: string;
}): Promise<{ state: string }> {
  const result = await requirePool().query(
    `SELECT * FROM mojaloop_reject_dead_letter_head_resolution(
      $1::integer, $2::uuid, $3::text, $4::text, clock_timestamp()
    )`,
    [input.actorId, input.caseId, input.reason, input.idempotencyKey],
  );
  return { state: String(result.rows[0]?.state ?? "") };
}
