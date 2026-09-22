import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BellRing,
  DatabaseZap,
  FlaskConical,
  Landmark,
  RefreshCw,
  Search,
  ShieldCheck,
} from "lucide-react";

type FinancialOverview = {
  immutableIdentityEnforced: boolean;
  retrievedAt: string;
  immutableTransfers: Array<{
    transferId: string;
    payerFsp: string;
    payeeFsp: string;
    amountMinor: string;
    currency: string;
    state: string;
    updatedAt: string;
  }>;
  inconsistentReconciliations: Array<{
    id: string;
    transferId: string;
    transferState: string;
    platformRefundedMinor: string;
    platformNetSettledMinor: string;
    createdAt: string;
  }>;
};
type HealthStatus = "reachable" | "unhealthy" | "unreachable" | "unconfigured";
type Health = {
  dependencies: Array<{
    name: string;
    status: HealthStatus;
    checkedAt: string;
    latencyMs: number | null;
    detail: string | null;
  }>;
  history: Array<{
    dependency: "tigerbeetle" | "temporal";
    status: HealthStatus;
    latencyMs: number | null;
    detail: string | null;
    observedAt: string;
  }>;
  database: {
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
  retrievedAt: string;
};
type Coverage = {
  collectedAt: string;
  testCount: number;
  skippedCount: number;
  lineCoverage: number;
  branchCoverage: number;
  functionCoverage: number;
  statementCoverage: number;
  goal: number;
  scope: string;
  note: string;
  history: Array<{
    collectedAt: string;
    lineCoverage: number;
    branchCoverage: number;
    functionCoverage: number;
    testCount: number;
    source: string;
    modules?: Array<{
      name: string;
      lineCoverage: number | null;
      detail: string;
    }>;
  }>;
  executionLog: Array<{
    recordedAt: string;
    workflow: string;
    status: "passed" | "failed" | "not_run";
    level: "success" | "warning" | "error";
    detail: string;
    testCount: number;
    errorTrace?: string | null;
  }>;
  retrievedAt: string;
};
type Escalation = {
  alertId: string;
  assignedTo: number;
  escalationDeadline: string;
};
type Simulations = {
  enabled: boolean;
  productionBlocked: boolean;
  scenarios: string[];
};
type Alert = {
  id: string;
  severity: "warning" | "critical";
  source: "reconciliation" | "dependency";
  title: string;
  detail: string;
  createdAt: string;
  action: "acknowledge" | "dismiss" | "note" | null;
  note: string | null;
};
type DeadLetterCase = {
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
type DeadLetterAction = { path: string; body: Record<string, unknown> };

async function fetchAdmin<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok)
    throw new Error(
      (await response.json().catch(() => ({ error: "request_failed" })))
        .error ?? "request_failed",
    );
  return response.json() as Promise<T>;
}
async function postFinancialAdmin<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(
      (await response.json().catch(() => ({ error: "request_failed" })))
        .error ?? "request_failed",
    );
  return response.json() as Promise<T>;
}
const remediationIdempotencyKey = (prefix: string) =>
  `${prefix}-${crypto.randomUUID()}`;
const statusClass = (status: HealthStatus) =>
  status === "reachable"
    ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
    : status === "unconfigured"
      ? "border-slate-600 bg-slate-800 text-slate-300"
      : "border-rose-400/30 bg-rose-400/10 text-rose-100";

function Trend({
  label,
  values,
}: {
  label: string;
  values: Health["history"];
}) {
  if (!values.length)
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4 text-sm text-slate-400">
        {label}: no persisted observations yet.
      </div>
    );
  const highestLatency = Math.max(
    1,
    ...values.map((item) => item.latencyMs ?? 0),
  );
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-slate-200">{label}</span>
        <span className="text-slate-500">
          Last {values.length} observations
        </span>
      </div>
      <div
        className="mt-4 flex h-16 items-end gap-1"
        aria-label={`${label} uptime trend`}
      >
        {values.map((point) => (
          <button
            type="button"
            key={point.observedAt}
            title={`${point.status} · ${new Date(point.observedAt).toLocaleString()} · ${point.detail ?? "No error detail recorded."}`}
            aria-label={`${point.status} at ${new Date(point.observedAt).toLocaleString()}: ${point.detail ?? "No error detail recorded."}`}
            className={
              point.status === "reachable"
                ? "bg-emerald-400"
                : point.status === "unconfigured"
                  ? "bg-slate-500"
                  : "bg-rose-400"
            }
            style={{
              height: `${Math.max(12, ((point.latencyMs ?? highestLatency) / highestLatency) * 100)}%`,
              width: `${Math.max(4, 100 / values.length - 1)}%`,
            }}
          />
        ))}
      </div>
    </div>
  );
}

export default function FinancialAdministration() {
  const [query, setQuery] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [sort, setSort] = useState("updated_desc");
  const [noteDraft, setNoteDraft] = useState<Record<string, string>>({});
  const [exportStatus, setExportStatus] = useState("");
  const [executionQuery, setExecutionQuery] = useState("");
  const [executionStatus, setExecutionStatus] = useState("all");
  const [expandedTraces, setExpandedTraces] = useState<Set<string>>(new Set());
  const [alertExportStatus, setAlertExportStatus] = useState("");
  const [settingsStatus, setSettingsStatus] = useState("");
  const [playwrightStatus, setPlaywrightStatus] = useState("");
  const [routingEnabled, setRoutingEnabled] = useState(false);
  const [routingMinutes, setRoutingMinutes] = useState(60);
  const [routingWebhooks, setRoutingWebhooks] = useState("");
  const [retentionDays, setRetentionDays] = useState(30);
  const [deadLetterStatus, setDeadLetterStatus] = useState("");
  const [caseOpenForm, setCaseOpenForm] = useState(() => ({
    outboxId: "",
    reason: "",
    investigationDigestHex: "",
    idempotencyKey: remediationIdempotencyKey("case-open"),
  }));
  const [remediationRequestForm, setRemediationRequestForm] = useState(() => ({
    caseId: "",
    reason: "",
    reconciliationReference: "",
    reconciliationDigestHex: "",
    replacementTransferId: "",
    replacementIlpPacket: "",
    replacementCondition: "",
    replacementExpiration: new Date(Date.now() + 2 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 16),
    idempotencyKey: remediationIdempotencyKey("remediation-request"),
  }));
  const [approvalForm, setApprovalForm] = useState(() => ({
    caseId: "",
    approvalReason: "",
    idempotencyKey: remediationIdempotencyKey("remediation-approval"),
  }));
  const [rejectionForm, setRejectionForm] = useState(() => ({
    caseId: "",
    reason: "",
    idempotencyKey: remediationIdempotencyKey("remediation-rejection"),
  }));
  const escalations = useQuery<{ escalations: Escalation[] }>({
    queryKey: ["finance-admin-escalations"],
    queryFn: () =>
      fetchAdmin<{ escalations: Escalation[] }>(
        "/api/admin/finance/alert-escalations",
      ),
    refetchInterval: 60_000,
  });
  const settings = useQuery<{
    settings: {
      autoEscalationEnabled: boolean;
      autoEscalationMinutes: number;
      onCallWebhooks: string[];
      approvedWebhookHosts: string[];
      healthRetentionDays: number;
    };
  }>({
    queryKey: ["finance-admin-settings"],
    queryFn: () => fetchAdmin("/api/admin/finance/settings"),
  });
  const [approvedHosts, setApprovedHosts] = useState("");
  const receipts = useQuery<{
    receipts: Array<{
      alertId: string;
      webhookHost: string;
      status: string;
      detail: string | null;
      routedAt: string;
      completedAt: string | null;
    }>;
  }>({
    queryKey: ["finance-admin-receipts"],
    queryFn: () => fetchAdmin("/api/admin/finance/alert-delivery-receipts"),
    refetchInterval: 60_000,
  });
  useEffect(() => {
    const value = settings.data?.settings;
    if (value) {
      setRoutingEnabled(value.autoEscalationEnabled);
      setRoutingMinutes(value.autoEscalationMinutes);
      setRoutingWebhooks(value.onCallWebhooks.join("\n"));
      setApprovedHosts(value.approvedWebhookHosts.join("\n"));
      setRetentionDays(value.healthRetentionDays);
    }
  }, [settings.data]);
  const escalationMap = useMemo(
    () =>
      new Map((escalations.data?.escalations ?? []).map((e) => [e.alertId, e])),
    [escalations.data],
  );
  const toggleTrace = (key: string) =>
    setExpandedTraces((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const exportAlertHistory = async () => {
    setAlertExportStatus("Exporting…");
    try {
      const resp = await fetch("/api/admin/finance/alert-actions/history.csv", {
        credentials: "include",
      });
      if (!resp.ok) throw new Error("export failed");
      const blob = await resp.blob();
      const count = resp.headers.get("X-Row-Count") ?? "?";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `alert-action-history-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      setAlertExportStatus(`Downloaded ${count} rows.`);
      setTimeout(() => setAlertExportStatus(""), 4000);
    } catch {
      setAlertExportStatus("Export failed.");
      setTimeout(() => setAlertExportStatus(""), 4000);
    }
  };
  const saveSettings = async () => {
    setSettingsStatus("Saving…");
    try {
      const response = await fetch("/api/admin/finance/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          autoEscalationEnabled: routingEnabled,
          autoEscalationMinutes: routingMinutes,
          onCallWebhooks: routingWebhooks
            .split("\n")
            .map((value) => value.trim())
            .filter(Boolean),
          approvedWebhookHosts: approvedHosts
            .split("\n")
            .map((value) => value.trim())
            .filter(Boolean),
          healthRetentionDays: retentionDays,
        }),
      });
      if (!response.ok) throw new Error("settings unavailable");
      await settings.refetch();
      setSettingsStatus("Saved.");
    } catch {
      setSettingsStatus(
        "Settings unavailable. Use approved HTTPS webhook hosts only.",
      );
    }
  };
  const runPlaywright = async () => {
    setPlaywrightStatus("Submitting isolated run…");
    try {
      const response = await fetch("/api/admin/quality/playwright/run", {
        method: "POST",
        credentials: "include",
      });
      if (!response.ok) throw new Error("run unavailable");
      setPlaywrightStatus(
        "Submitted. The execution log will refresh when the isolated runner publishes evidence.",
      );
      void coverage.refetch();
    } catch {
      setPlaywrightStatus(
        "Run unavailable: configure an isolated non-production executor.",
      );
    }
  };
  const filterQuery = useMemo(
    () =>
      new URLSearchParams(
        Object.entries({ query, startDate, endDate, sort }).filter(
          ([, value]) => value,
        ),
      ).toString(),
    [query, startDate, endDate, sort],
  );
  const overview = useQuery({
    queryKey: ["finance-admin-overview", filterQuery],
    queryFn: () =>
      fetchAdmin<FinancialOverview>(
        `/api/admin/finance/overview?${filterQuery}`,
      ),
    refetchInterval: 60_000,
  });
  const health = useQuery({
    queryKey: ["finance-admin-health"],
    queryFn: () => fetchAdmin<Health>("/api/admin/finance/health"),
    refetchInterval: 60_000,
  });
  const alerts = useQuery({
    queryKey: ["finance-admin-alerts"],
    queryFn: () => fetchAdmin<{ alerts: Alert[] }>("/api/admin/finance/alerts"),
    refetchInterval: 60_000,
  });
  const coverage = useQuery({
    queryKey: ["finance-admin-coverage"],
    queryFn: () => fetchAdmin<Coverage>("/api/admin/quality/coverage"),
    refetchInterval: 60_000,
  });
  const simulations = useQuery({
    queryKey: ["finance-admin-simulations"],
    queryFn: () => fetchAdmin<Simulations>("/api/admin/finance/simulations"),
  });
  const deadLetterCases = useQuery<{ cases: DeadLetterCase[] }>({
    queryKey: ["finance-admin-dead-letter-cases"],
    queryFn: () => fetchAdmin("/api/admin/finance/dead-letter-cases?limit=100"),
    refetchInterval: 60_000,
  });
  const deadLetterAction = useMutation({
    mutationFn: ({ path, body }: DeadLetterAction) =>
      postFinancialAdmin(path, body),
    onSuccess: async () => {
      await deadLetterCases.refetch();
    },
  });
  const alertAction = useMutation({
    mutationFn: async ({
      alertId,
      action,
      note,
    }: {
      alertId: string;
      action: "acknowledge" | "dismiss" | "note";
      note?: string;
    }) => {
      const response = await fetch(
        `/api/admin/finance/alerts/${alertId}/actions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ action, note }),
        },
      );
      if (!response.ok)
        throw new Error(
          (
            await response
              .json()
              .catch(() => ({ error: "financial_alert_action_unavailable" }))
          ).error ?? "financial_alert_action_unavailable",
        );
    },
    onSuccess: () => {
      void alerts.refetch();
    },
  });
  const simulation = useMutation({
    mutationFn: async (scenario: string) => {
      const response = await fetch(
        `/api/admin/finance/simulations/${scenario}`,
        { method: "POST", credentials: "include" },
      );
      if (!response.ok)
        throw new Error(
          (
            await response
              .json()
              .catch(() => ({ error: "simulation_unavailable" }))
          ).error ?? "simulation_unavailable",
        );
      return response.json() as Promise<{ scenario: string; status: string }>;
    },
  });
  const accessError = [
    overview.error,
    health.error,
    alerts.error,
    coverage.error,
    simulations.error,
    deadLetterCases.error,
  ].find(Boolean) as Error | undefined;
  const history = health.data?.history ?? [];
  const filteredExecutions = useMemo(
    () =>
      (coverage.data?.executionLog ?? []).filter(
        (entry) =>
          (executionStatus === "all" || entry.status === executionStatus) &&
          `${entry.workflow} ${entry.detail}`
            .toLowerCase()
            .includes(executionQuery.trim().toLowerCase()),
      ),
    [coverage.data?.executionLog, executionQuery, executionStatus],
  );
  const exportReport = async () => {
    setExportStatus("");
    try {
      const response = await fetch(
        `/api/admin/finance/report.csv?${filterQuery}`,
        { credentials: "include" },
      );
      if (!response.ok)
        throw new Error(
          (
            await response
              .json()
              .catch(() => ({ error: "financial_report_export_unavailable" }))
          ).error,
        );
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "financial-administration-report.csv";
      anchor.click();
      URL.revokeObjectURL(url);
      setExportStatus(
        `${response.headers.get("X-Exported-Row-Count") ?? "0"} records exported.`,
      );
    } catch (error) {
      setExportStatus(
        `Export unavailable: ${(error as Error).message.replace(/_/g, " ")}.`,
      );
    }
  };
  if (accessError)
    return (
      <section className="mx-auto max-w-3xl rounded-2xl border border-rose-400/30 bg-rose-400/10 p-8 text-rose-100">
        <ShieldCheck className="mb-4 h-8 w-8" />
        <h1 className="text-2xl font-semibold">
          Financial administration is restricted
        </h1>
        <p className="mt-3 leading-7">
          This workspace requires an authenticated platform financial
          administrator with verified MFA.{" "}
          {accessError.message.replace(/_/g, " ")}.
        </p>
      </section>
    );
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-cyan-200">
            <Landmark className="h-5 w-5" />
            Financial administration
          </div>
          <h1 className="mt-2 text-3xl font-semibold text-white">
            Immutable funds oversight
          </h1>
          <p className="mt-2 max-w-3xl leading-7 text-slate-300">
            Read-only transfer evidence, reconciliation warnings, and dependency
            health. This workspace cannot alter existing funds rows; it can only
            create a separately audited replacement intent after reconciliation
            evidence and independent MFA-administrator approval.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            void overview.refetch();
            void health.refetch();
            void alerts.refetch();
            void coverage.refetch();
            void deadLetterCases.refetch();
          }}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-sm text-slate-100 hover:border-cyan-400/50"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      </header>
      <section className="grid gap-4 md:grid-cols-3">
        <div className="rounded-2xl border border-emerald-400/30 bg-emerald-400/10 p-5">
          <ShieldCheck className="h-5 w-5 text-emerald-200" />
          <div className="mt-3 text-sm text-emerald-100">
            Financial identity
          </div>
          <div className="mt-1 text-xl font-semibold text-white">
            {overview.data?.immutableIdentityEnforced
              ? "Immutable"
              : "Unavailable"}
          </div>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <DatabaseZap className="h-5 w-5 text-cyan-200" />
          <div className="mt-3 text-sm text-slate-300">Filtered transfers</div>
          <div className="mt-1 text-xl font-semibold text-white">
            {overview.data?.immutableTransfers.length ?? "—"}
          </div>
        </div>
        <div className="rounded-2xl border border-amber-400/30 bg-amber-400/10 p-5">
          <AlertTriangle className="h-5 w-5 text-amber-200" />
          <div className="mt-3 text-sm text-amber-100">Open warnings</div>
          <div className="mt-1 text-xl font-semibold text-white">
            {alerts.data?.alerts.length ?? "—"}
          </div>
        </div>
      </section>
      <section className="rounded-2xl border border-amber-400/30 bg-amber-400/5 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-200" />
            <div>
              <h2 className="font-semibold text-white">
                TigerBeetle dead-letter remediation
              </h2>
              <p className="mt-1 max-w-3xl text-sm text-amber-100/80">
                A terminal dead-letter row is never retried, reopened, or edited
                here. After evidence shows{" "}
                <span className="font-medium">confirmed not committed</span>, a
                different MFA-authenticated financial administrator may approve
                creation of one new pending remediation intent.
              </p>
            </div>
          </div>
          <span className="rounded-full border border-amber-400/30 px-3 py-1 text-xs text-amber-100">
            {deadLetterCases.data?.cases.length ?? 0} cases
          </span>
        </div>
        <div className="mt-4 grid gap-4 xl:grid-cols-2">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setDeadLetterStatus("Opening immutable case…");
              deadLetterAction.mutate(
                {
                  path: "/api/admin/finance/dead-letter-cases",
                  body: caseOpenForm,
                },
                {
                  onSuccess: () => {
                    setDeadLetterStatus(
                      "Case opened. Record reconciliation evidence before requesting approval.",
                    );
                    setCaseOpenForm({
                      outboxId: "",
                      reason: "",
                      investigationDigestHex: "",
                      idempotencyKey: remediationIdempotencyKey("case-open"),
                    });
                  },
                  onError: (error) =>
                    setDeadLetterStatus(
                      `Case opening rejected: ${(error as Error).message.replace(/_/g, " ")}.`,
                    ),
                },
              );
            }}
            className="rounded-xl border border-slate-700 bg-slate-950/40 p-4"
          >
            <h3 className="font-medium text-white">
              1. Open investigation case
            </h3>
            <p className="mt-1 text-xs leading-5 text-slate-400">
              Use the immutable terminal outbox ID and the SHA-256 digest of the
              investigation record. This action cannot change the old row.
            </p>
            <div className="mt-3 grid gap-2">
              <input
                required
                inputMode="numeric"
                value={caseOpenForm.outboxId}
                onChange={(event) =>
                  setCaseOpenForm((current) => ({
                    ...current,
                    outboxId: event.target.value
                      .replace(/[^0-9]/g, "")
                      .slice(0, 19),
                  }))
                }
                placeholder="Terminal outbox ID"
                aria-label="Terminal dead-letter outbox ID"
                className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white"
              />
              <textarea
                required
                minLength={3}
                maxLength={1000}
                value={caseOpenForm.reason}
                onChange={(event) =>
                  setCaseOpenForm((current) => ({
                    ...current,
                    reason: event.target.value.slice(0, 1000),
                  }))
                }
                placeholder="Investigation reason"
                aria-label="Investigation reason"
                className="min-h-20 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white"
              />
              <input
                required
                pattern="[a-f0-9]{64}"
                value={caseOpenForm.investigationDigestHex}
                onChange={(event) =>
                  setCaseOpenForm((current) => ({
                    ...current,
                    investigationDigestHex: event.target.value
                      .toLowerCase()
                      .replace(/[^a-f0-9]/g, "")
                      .slice(0, 64),
                  }))
                }
                placeholder="Investigation SHA-256 digest (64 lowercase hex)"
                aria-label="Investigation SHA-256 digest"
                className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-xs text-white"
              />
            </div>
            <button
              type="submit"
              disabled={deadLetterAction.isPending}
              className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-100 disabled:opacity-50"
            >
              Open case
            </button>
          </form>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setDeadLetterStatus(
                "Submitting evidence-backed approval request…",
              );
              deadLetterAction.mutate(
                {
                  path: `/api/admin/finance/dead-letter-cases/${remediationRequestForm.caseId}/remediation-requests`,
                  body: {
                    ...remediationRequestForm,
                    ledgerDisposition: "confirmed_not_committed",
                    replacementExpiration: new Date(
                      remediationRequestForm.replacementExpiration,
                    ).toISOString(),
                  },
                },
                {
                  onSuccess: () => {
                    setDeadLetterStatus(
                      "Approval request recorded. A different financial administrator must decide it.",
                    );
                    setRemediationRequestForm((current) => ({
                      ...current,
                      reason: "",
                      reconciliationReference: "",
                      reconciliationDigestHex: "",
                      replacementTransferId: "",
                      replacementIlpPacket: "",
                      replacementCondition: "",
                      idempotencyKey: remediationIdempotencyKey(
                        "remediation-request",
                      ),
                    }));
                  },
                  onError: (error) =>
                    setDeadLetterStatus(
                      `Remediation request rejected: ${(error as Error).message.replace(/_/g, " ")}.`,
                    ),
                },
              );
            }}
            className="rounded-xl border border-slate-700 bg-slate-950/40 p-4"
          >
            <h3 className="font-medium text-white">2. Request a new intent</h3>
            <p className="mt-1 text-xs leading-5 text-slate-400">
              Only use independently reconciled, approved operator evidence. The
              packet and condition are validated and stored only for the
              proposed new transfer.
            </p>
            <div className="mt-3 grid gap-2">
              <select
                required
                value={remediationRequestForm.caseId}
                onChange={(event) =>
                  setRemediationRequestForm((current) => ({
                    ...current,
                    caseId: event.target.value,
                  }))
                }
                aria-label="Case for remediation request"
                className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white"
              >
                <option value="">Choose open or rejected case</option>
                {(deadLetterCases.data?.cases ?? [])
                  .filter(
                    (item) =>
                      item.state === "open" || item.state === "rejected",
                  )
                  .map((item) => (
                    <option key={item.caseId} value={item.caseId}>
                      {item.originalTransferId} · outbox {item.outboxId} ·{" "}
                      {item.state}
                    </option>
                  ))}
              </select>
              <textarea
                required
                minLength={3}
                maxLength={1000}
                value={remediationRequestForm.reason}
                onChange={(event) =>
                  setRemediationRequestForm((current) => ({
                    ...current,
                    reason: event.target.value.slice(0, 1000),
                  }))
                }
                placeholder="Why a replacement is necessary"
                aria-label="Remediation request reason"
                className="min-h-16 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white"
              />
              <div className="grid gap-2 md:grid-cols-2">
                <input
                  required
                  value={remediationRequestForm.reconciliationReference}
                  onChange={(event) =>
                    setRemediationRequestForm((current) => ({
                      ...current,
                      reconciliationReference: event.target.value.slice(0, 200),
                    }))
                  }
                  placeholder="Reconciliation reference"
                  aria-label="Reconciliation reference"
                  className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white"
                />
                <input
                  required
                  pattern="[a-f0-9]{64}"
                  value={remediationRequestForm.reconciliationDigestHex}
                  onChange={(event) =>
                    setRemediationRequestForm((current) => ({
                      ...current,
                      reconciliationDigestHex: event.target.value
                        .toLowerCase()
                        .replace(/[^a-f0-9]/g, "")
                        .slice(0, 64),
                    }))
                  }
                  placeholder="Evidence SHA-256 digest"
                  aria-label="Reconciliation evidence SHA-256 digest"
                  className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-xs text-white"
                />
              </div>
              <input
                required
                value={remediationRequestForm.replacementTransferId}
                onChange={(event) =>
                  setRemediationRequestForm((current) => ({
                    ...current,
                    replacementTransferId: event.target.value.slice(0, 192),
                  }))
                }
                placeholder="New replacement transfer ID"
                aria-label="Replacement transfer ID"
                className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-xs text-white"
              />
              <textarea
                required
                minLength={3}
                maxLength={16384}
                value={remediationRequestForm.replacementIlpPacket}
                onChange={(event) =>
                  setRemediationRequestForm((current) => ({
                    ...current,
                    replacementIlpPacket: event.target.value.slice(0, 16384),
                  }))
                }
                placeholder="Approved replacement ILP packet"
                aria-label="Approved replacement ILP packet"
                className="min-h-16 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-xs text-white"
              />
              <div className="grid gap-2 md:grid-cols-2">
                <input
                  required
                  value={remediationRequestForm.replacementCondition}
                  onChange={(event) =>
                    setRemediationRequestForm((current) => ({
                      ...current,
                      replacementCondition: event.target.value.slice(0, 255),
                    }))
                  }
                  placeholder="Replacement condition"
                  aria-label="Replacement condition"
                  className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-xs text-white"
                />
                <input
                  required
                  type="datetime-local"
                  value={remediationRequestForm.replacementExpiration}
                  onChange={(event) =>
                    setRemediationRequestForm((current) => ({
                      ...current,
                      replacementExpiration: event.target.value,
                    }))
                  }
                  aria-label="Replacement expiration"
                  className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white"
                />
              </div>
            </div>
            <button
              type="submit"
              disabled={
                deadLetterAction.isPending || !remediationRequestForm.caseId
              }
              className="mt-3 rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 py-2 text-sm text-cyan-100 disabled:opacity-50"
            >
              Request independent approval
            </button>
          </form>
        </div>
        <div className="mt-4 overflow-x-auto rounded-xl border border-slate-800">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="bg-slate-950/60 text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-4 py-3">Original transfer</th>
                <th className="px-4 py-3">Terminal outbox</th>
                <th className="px-4 py-3">State</th>
                <th className="px-4 py-3">Reconciliation</th>
                <th className="px-4 py-3">Replacement intent</th>
                <th className="px-4 py-3">Decision</th>
              </tr>
            </thead>
            <tbody>
              {deadLetterCases.data?.cases.length ? (
                deadLetterCases.data.cases.map((item) => (
                  <tr
                    key={item.caseId}
                    className="border-t border-slate-800 text-slate-200"
                  >
                    <td className="px-4 py-3 font-mono text-xs">
                      {item.originalTransferId}
                    </td>
                    <td className="px-4 py-3">
                      {item.outboxId}
                      <div className="mt-1 text-xs text-rose-200">
                        {item.lastError ?? "terminal dead-letter"}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-full px-2 py-1 text-xs ${item.state === "approval_pending" ? "bg-amber-400/10 text-amber-100" : item.state === "replacement_intent_created" ? "bg-emerald-400/10 text-emerald-100" : "bg-slate-700 text-slate-200"}`}
                      >
                        {item.state.replace(/_/g, " ")}
                      </span>
                      <div className="mt-1 text-xs text-slate-400">
                        attempts {item.attemptCount}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {item.ledgerDisposition ?? "not submitted"}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">
                      {item.replacementTransferId ?? "—"}
                      {item.remediationOutboxId ? (
                        <div className="mt-1 text-emerald-200">
                          new outbox {item.remediationOutboxId}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      {item.state === "approval_pending" ? (
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() =>
                              setApprovalForm({
                                caseId: item.caseId,
                                approvalReason: "",
                                idempotencyKey: remediationIdempotencyKey(
                                  "remediation-approval",
                                ),
                              })
                            }
                            className="rounded border border-emerald-400/30 px-2 py-1 text-xs text-emerald-100"
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setRejectionForm({
                                caseId: item.caseId,
                                reason: "",
                                idempotencyKey: remediationIdempotencyKey(
                                  "remediation-rejection",
                                ),
                              })
                            }
                            className="rounded border border-rose-400/30 px-2 py-1 text-xs text-rose-100"
                          >
                            Reject
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs text-slate-500">
                          No decision action
                        </span>
                      )}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="px-4 py-5 text-sm text-slate-400">
                    No dead-letter cases are open. The dashboard cannot replay
                    terminal outbox rows.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="mt-4 grid gap-4 xl:grid-cols-2">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setDeadLetterStatus("Submitting independent approval…");
              deadLetterAction.mutate(
                {
                  path: `/api/admin/finance/dead-letter-cases/${approvalForm.caseId}/approve`,
                  body: approvalForm,
                },
                {
                  onSuccess: () => {
                    setDeadLetterStatus(
                      "Independent approval recorded. A new pending remediation intent was created; no money completion is implied.",
                    );
                    setApprovalForm({
                      caseId: "",
                      approvalReason: "",
                      idempotencyKey: remediationIdempotencyKey(
                        "remediation-approval",
                      ),
                    });
                  },
                  onError: (error) =>
                    setDeadLetterStatus(
                      `Approval rejected: ${(error as Error).message.replace(/_/g, " ")}.`,
                    ),
                },
              );
            }}
            className="rounded-xl border border-emerald-400/30 bg-emerald-400/5 p-4"
          >
            <h3 className="font-medium text-emerald-100">
              3. Independent approval
            </h3>
            <p className="mt-1 text-xs leading-5 text-emerald-100/80">
              You cannot approve your own request. Approval creates a new{" "}
              <span className="font-medium">PENDING</span> replacement transfer
              and outbox intent; it does not mark any funds as completed.
            </p>
            <select
              required
              value={approvalForm.caseId}
              onChange={(event) =>
                setApprovalForm((current) => ({
                  ...current,
                  caseId: event.target.value,
                }))
              }
              aria-label="Case for independent approval"
              className="mt-3 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white"
            >
              <option value="">Choose approval-pending case</option>
              {(deadLetterCases.data?.cases ?? [])
                .filter((item) => item.state === "approval_pending")
                .map((item) => (
                  <option key={item.caseId} value={item.caseId}>
                    {item.originalTransferId} → {item.replacementTransferId}
                  </option>
                ))}
            </select>
            <textarea
              required
              minLength={3}
              maxLength={1000}
              value={approvalForm.approvalReason}
              onChange={(event) =>
                setApprovalForm((current) => ({
                  ...current,
                  approvalReason: event.target.value.slice(0, 1000),
                }))
              }
              placeholder="Independent approval rationale"
              aria-label="Independent approval rationale"
              className="mt-2 min-h-20 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white"
            />
            <button
              type="submit"
              disabled={deadLetterAction.isPending || !approvalForm.caseId}
              className="mt-3 rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-sm text-emerald-100 disabled:opacity-50"
            >
              Create new remediation intent
            </button>
          </form>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setDeadLetterStatus("Recording rejection…");
              deadLetterAction.mutate(
                {
                  path: `/api/admin/finance/dead-letter-cases/${rejectionForm.caseId}/reject`,
                  body: rejectionForm,
                },
                {
                  onSuccess: () => {
                    setDeadLetterStatus(
                      "Request rejected. The original terminal outbox row remains unchanged.",
                    );
                    setRejectionForm({
                      caseId: "",
                      reason: "",
                      idempotencyKey: remediationIdempotencyKey(
                        "remediation-rejection",
                      ),
                    });
                  },
                  onError: (error) =>
                    setDeadLetterStatus(
                      `Rejection unavailable: ${(error as Error).message.replace(/_/g, " ")}.`,
                    ),
                },
              );
            }}
            className="rounded-xl border border-rose-400/30 bg-rose-400/5 p-4"
          >
            <h3 className="font-medium text-rose-100">
              Reject pending request
            </h3>
            <p className="mt-1 text-xs leading-5 text-rose-100/80">
              A different financial administrator can reject incomplete or
              contradictory evidence. The case may be re-requested with new
              evidence; the dead-letter row remains terminal.
            </p>
            <select
              required
              value={rejectionForm.caseId}
              onChange={(event) =>
                setRejectionForm((current) => ({
                  ...current,
                  caseId: event.target.value,
                }))
              }
              aria-label="Case for rejection"
              className="mt-3 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white"
            >
              <option value="">Choose approval-pending case</option>
              {(deadLetterCases.data?.cases ?? [])
                .filter((item) => item.state === "approval_pending")
                .map((item) => (
                  <option key={item.caseId} value={item.caseId}>
                    {item.originalTransferId} → {item.replacementTransferId}
                  </option>
                ))}
            </select>
            <textarea
              required
              minLength={3}
              maxLength={1000}
              value={rejectionForm.reason}
              onChange={(event) =>
                setRejectionForm((current) => ({
                  ...current,
                  reason: event.target.value.slice(0, 1000),
                }))
              }
              placeholder="Reason for rejection"
              aria-label="Reason for rejection"
              className="mt-2 min-h-20 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white"
            />
            <button
              type="submit"
              disabled={deadLetterAction.isPending || !rejectionForm.caseId}
              className="mt-3 rounded-lg border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-sm text-rose-100 disabled:opacity-50"
            >
              Reject remediation request
            </button>
          </form>
        </div>
        {deadLetterStatus && (
          <p role="status" className="mt-3 text-sm text-slate-200">
            {deadLetterStatus}
          </p>
        )}
        {deadLetterAction.isError && (
          <p role="alert" className="mt-2 text-sm text-rose-200">
            Financial remediation action failed:{" "}
            {(deadLetterAction.error as Error).message.replace(/_/g, " ")}.
          </p>
        )}
      </section>
      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <div className="mb-4 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <BellRing className="h-5 w-5 text-amber-200" />
            <div>
              <h2 className="font-semibold text-white">Notification center</h2>
              <p className="text-sm text-slate-400">
                Refreshes every 15 seconds with reconciliation and dependency
                warnings.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={exportAlertHistory}
              className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-200 hover:border-cyan-400/50"
              aria-label="Export alert-action history as CSV"
            >
              Export history
            </button>
            {alertExportStatus && (
              <span className="text-xs text-cyan-200" role="status">
                {alertExportStatus}
              </span>
            )}
          </div>
        </div>
        <div className="space-y-2">
          {alerts.data?.alerts.length ? (
            alerts.data.alerts.map((alert) => {
              const esc = escalationMap.get(alert.id);
              const deadlineMs = esc?.escalationDeadline
                ? new Date(esc.escalationDeadline).getTime() - Date.now()
                : null;
              const deadlineHours =
                deadlineMs !== null
                  ? Math.max(0, Math.round(deadlineMs / 3600000))
                  : null;
              const isOverdue = deadlineMs !== null && deadlineMs <= 0;
              return (
                <div
                  key={alert.id}
                  className={`rounded-xl border p-3 ${alert.severity === "critical" ? "border-rose-400/30 bg-rose-400/10" : "border-amber-400/30 bg-amber-400/10"}`}
                >
                  <div className="flex flex-wrap justify-between gap-3">
                    <span className="font-medium text-white">
                      {alert.title}
                    </span>
                    <div className="flex items-center gap-2">
                      {esc && (
                        <span
                          title={`Assigned to operator ${esc.assignedTo}${esc.escalationDeadline ? ", deadline " + new Date(esc.escalationDeadline).toLocaleString() : ""}`}
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${isOverdue ? "bg-rose-500/20 text-rose-200" : deadlineHours !== null && deadlineHours <= 24 ? "bg-amber-500/20 text-amber-200" : "bg-cyan-500/20 text-cyan-200"}`}
                        >
                          {isOverdue
                            ? "OVERDUE"
                            : deadlineHours !== null
                              ? `${deadlineHours}h left`
                              : "Assigned"}
                        </span>
                      )}
                      <span className="text-xs text-slate-300">
                        {new Date(alert.createdAt).toLocaleString()}
                      </span>
                    </div>
                  </div>
                  <p className="mt-1 text-sm text-slate-200">{alert.detail}</p>
                </div>
              );
            })
          ) : (
            <p className="text-sm text-slate-400">
              No active reconciliation or dependency warnings are recorded.
            </p>
          )}
        </div>
      </section>
      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <div className="mb-4 flex items-center gap-2">
          <Activity className="h-5 w-5 text-cyan-200" />
          <div>
            <h2 className="font-semibold text-white">Dependency health</h2>
            <p className="text-sm text-slate-400">
              Color-coded current checks and persisted 24-hour observations.
            </p>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          {health.data?.dependencies.map((dependency) => (
            <div
              key={dependency.name}
              className={`rounded-xl border p-4 ${statusClass(dependency.status)}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{dependency.name}</span>
                <span className="text-xs uppercase tracking-wide">
                  {dependency.status}
                </span>
              </div>
              <div className="mt-2 text-xs opacity-80">
                Checked {new Date(dependency.checkedAt).toLocaleTimeString()} ·{" "}
                {dependency.latencyMs === null
                  ? "no endpoint configured"
                  : `${dependency.latencyMs} ms`}
              </div>
            </div>
          ))}
          {health.data?.database && (
            <div
              className={`rounded-xl border p-4 ${health.data.database.status === "verified" ? statusClass("reachable") : statusClass("unreachable")}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">PostgreSQL TLS</span>
                <span className="text-xs uppercase tracking-wide">
                  {health.data.database.status}
                </span>
              </div>
              <div className="mt-2 text-xs opacity-80">
                {health.data.database.tlsVersion ??
                  health.data.database.detail ??
                  "No TLS evidence."}
              </div>
              <div className="mt-1 text-xs opacity-80">
                {health.data.database.migrationVersions.length} recorded
                migrations
              </div>
              {health.data.database.certificateStatus !== "fresh" ? (
                <p
                  role="status"
                  title={
                    health.data.database.certificateExpiresAt
                      ? `Certificate expiry: ${new Date(health.data.database.certificateExpiresAt).toLocaleString()}`
                      : "Set DATABASE_TLS_CERT_EXPIRES_AT to report expiry."
                  }
                  className="mt-2 text-xs text-amber-200"
                >
                  ⚠ TLS certificate{" "}
                  {health.data.database.certificateStatus === "unavailable"
                    ? "expiry evidence unavailable"
                    : health.data.database.certificateStatus}
                  .
                </p>
              ) : null}
              {health.data.database.migrationStatus === "aging" ? (
                <p
                  role="status"
                  title={`Latest migration is ${health.data.database.latestMigrationAgeDays} days old.`}
                  className="mt-2 text-xs text-amber-200"
                >
                  ⚠ Latest migration evidence is aging.
                </p>
              ) : null}
            </div>
          )}
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <Trend
            label="TigerBeetle adapter uptime"
            values={history.filter(
              (point) => point.dependency === "tigerbeetle",
            )}
          />
          <Trend
            label="Temporal bridge uptime"
            values={history.filter((point) => point.dependency === "temporal")}
          />
        </div>
        {health.data?.database?.migrationVersions.length ? (
          <p className="mt-4 text-xs text-slate-400">
            Latest migrations:{" "}
            {health.data.database.migrationVersions
              .slice(0, 5)
              .map((migration) => migration.id)
              .join(", ")}
            .
          </p>
        ) : (
          <p className="mt-4 text-xs text-amber-200">
            No migration evidence was returned by the database.
          </p>
        )}
      </section>
      <section className="rounded-2xl border border-cyan-400/30 bg-cyan-400/5 p-5">
        <div className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-cyan-200" />
          <div>
            <h2 className="font-semibold text-white">Testing and coverage</h2>
            <p className="text-sm text-slate-300">
              Measured repository coverage—not a proxy for production
              infrastructure proof.
            </p>
          </div>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-4">
          {[
            ["Lines", coverage.data?.lineCoverage],
            ["Branches", coverage.data?.branchCoverage],
            ["Functions", coverage.data?.functionCoverage],
            ["Tests", coverage.data?.testCount],
          ].map(([label, value]) => (
            <div
              key={`${label}`}
              className="rounded-xl border border-cyan-400/20 bg-slate-950/40 p-3"
            >
              <div className="text-xs uppercase tracking-wide text-cyan-100">
                {label}
              </div>
              <div className="mt-1 text-2xl font-semibold text-white">
                {typeof value === "number"
                  ? `${value}${label === "Tests" ? "" : "%"}`
                  : "—"}
              </div>
            </div>
          ))}
        </div>
        <div
          className="mt-4 flex h-20 items-end gap-2"
          aria-label="Coverage history trend"
        >
          {coverage.data?.history.map((point) => (
            <button
              type="button"
              key={point.collectedAt}
              title={`${new Date(point.collectedAt).toLocaleString()} · lines ${point.lineCoverage}% · branches ${point.branchCoverage}% · functions ${point.functionCoverage}% · ${point.testCount} tests${point.modules?.length ? "\n\nModules:\n" + point.modules.map((m: { name: string; lineCoverage: number | null; detail: string }) => (m.lineCoverage !== null ? `  ${m.name}: ${m.lineCoverage}%` : `  ${m.name}: ${m.detail}`)).join("\n") : ""}`}
              className="flex-1 rounded-t bg-cyan-400/70"
              style={{ height: `${Math.max(8, point.lineCoverage)}%` }}
              aria-label={`Coverage run at ${new Date(point.collectedAt).toLocaleString()}, ${point.lineCoverage}% lines`}
            />
          ))}
        </div>
        <p className="mt-4 text-xs text-slate-400">
          Collected{" "}
          {coverage.data
            ? new Date(coverage.data.collectedAt).toLocaleString()
            : "—"}{" "}
          · Goal {coverage.data?.goal ?? 100}% ·{" "}
          {coverage.data?.skippedCount ?? 0} environment-gated tests skipped.
        </p>
        <div className="mt-4 space-y-2">
          <h3 className="text-sm font-medium text-white">
            Playwright execution log
          </h3>
          <div className="mb-3 flex flex-wrap gap-2">
            <input
              type="text"
              value={executionQuery}
              onChange={(e) => setExecutionQuery(e.target.value)}
              placeholder="Search workflows…"
              className="flex-1 min-w-[180px] rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none"
              aria-label="Search Playwright execution log"
            />
            <select
              value={executionStatus}
              onChange={(e) => setExecutionStatus(e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100 focus:border-cyan-400 focus:outline-none"
              aria-label="Filter by execution status"
            >
              <option value="all">All statuses</option>
              <option value="passed">Passed</option>
              <option value="failed">Failed</option>
              <option value="not_run">Not run</option>
            </select>
          </div>
          {filteredExecutions.length === 0 ? (
            <p className="text-sm text-slate-400">No matching executions.</p>
          ) : (
            filteredExecutions.map((entry) => {
              const traceKey = `${entry.workflow}-${entry.recordedAt}`;
              return (
                <div
                  key={traceKey}
                  className={`rounded-lg border p-3 text-sm ${entry.level === "success" ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-100" : entry.level === "error" ? "border-rose-400/30 bg-rose-400/10 text-rose-100" : "border-amber-400/30 bg-amber-400/10 text-amber-100"}`}
                >
                  <div className="flex justify-between gap-3">
                    <span className="font-medium">{entry.workflow}</span>
                    <span className="uppercase text-xs">{entry.status}</span>
                  </div>
                  <p className="mt-1">{entry.detail}</p>
                  <p className="mt-1 text-xs opacity-80">
                    {new Date(entry.recordedAt).toLocaleString()} ·{" "}
                    {entry.testCount} tests
                  </p>
                  {entry.errorTrace && (
                    <button
                      type="button"
                      onClick={() => toggleTrace(traceKey)}
                      className="mt-2 text-xs underline opacity-70 hover:opacity-100"
                      aria-label={
                        expandedTraces.has(traceKey)
                          ? "Collapse error trace"
                          : "Expand error trace"
                      }
                    >
                      {expandedTraces.has(traceKey)
                        ? "Hide error trace"
                        : "Show error trace"}
                    </button>
                  )}
                  {entry.errorTrace && expandedTraces.has(traceKey) && (
                    <pre className="mt-2 max-h-48 overflow-auto rounded bg-slate-950/60 p-2 text-xs leading-relaxed text-slate-300">
                      {entry.errorTrace}
                    </pre>
                  )}
                </div>
              );
            })
          )}
        </div>
      </section>
      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <div className="mb-4 flex items-center gap-2">
          <Search className="h-5 w-5 text-cyan-200" />
          <div>
            <h2 className="font-semibold text-white">
              Find immutable financial records
            </h2>
            <p className="text-sm text-slate-400">
              Search is bounded to 100 characters and the service returns no
              more than 100 matching records.
            </p>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-4">
          <label className="md:col-span-2">
            <span className="sr-only">Search transfers</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Transfer ID, FSP, or state"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
            />
          </label>
          <input
            aria-label="Start date"
            type="date"
            value={startDate}
            onChange={(event) => setStartDate(event.target.value)}
            className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
          />
          <input
            aria-label="End date"
            type="date"
            value={endDate}
            onChange={(event) => setEndDate(event.target.value)}
            className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
          />
          <select
            aria-label="Sort records"
            value={sort}
            onChange={(event) => setSort(event.target.value)}
            className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
          >
            <option value="updated_desc">Newest updated</option>
            <option value="updated_asc">Oldest updated</option>
            <option value="created_desc">Newest created</option>
            <option value="created_asc">Oldest created</option>
          </select>
        </div>
      </section>
      <section className="overflow-x-auto rounded-2xl border border-slate-800 bg-slate-900">
        <div className="border-b border-slate-800 px-5 py-4">
          <h2 className="font-semibold text-white">
            Immutable transfer records
          </h2>
          <p className="mt-1 text-sm text-slate-400">
            Monetary amounts are stored in minor units.
          </p>
        </div>
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="bg-slate-950/60 text-xs uppercase tracking-wide text-slate-400">
            <tr>
              <th className="px-5 py-3">Transfer</th>
              <th className="px-5 py-3">Parties</th>
              <th className="px-5 py-3">Minor units</th>
              <th className="px-5 py-3">State</th>
              <th className="px-5 py-3">Updated</th>
            </tr>
          </thead>
          <tbody>
            {overview.data?.immutableTransfers.map((transfer) => (
              <tr
                key={transfer.transferId}
                className="border-t border-slate-800 text-slate-200"
              >
                <td className="px-5 py-3 font-mono text-xs">
                  {transfer.transferId}
                </td>
                <td className="px-5 py-3">
                  {transfer.payerFsp} → {transfer.payeeFsp}
                </td>
                <td className="px-5 py-3">
                  {transfer.amountMinor} {transfer.currency}
                </td>
                <td className="px-5 py-3">{transfer.state}</td>
                <td className="px-5 py-3 text-slate-400">
                  {new Date(transfer.updatedAt).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="rounded-2xl border border-rose-400/30 bg-rose-400/5 p-5">
        <h2 className="font-semibold text-rose-100">
          Failed-refund reconciliation events
        </h2>
        <p className="mt-1 text-sm text-rose-200/80">
          Any record below requires investigation before settlement or customer
          communication.
        </p>
        <div className="mt-4 space-y-2">
          {overview.data?.inconsistentReconciliations.length ? (
            overview.data.inconsistentReconciliations.map((event) => (
              <div
                key={event.id}
                className="rounded-lg border border-rose-400/20 bg-slate-950/40 p-3 text-sm text-slate-200"
              >
                <span className="font-mono text-xs">{event.transferId}</span> ·{" "}
                {event.transferState} · refunded {event.platformRefundedMinor} ·
                net {event.platformNetSettledMinor} ·{" "}
                {new Date(event.createdAt).toLocaleString()}
              </div>
            ))
          ) : (
            <p className="text-sm text-slate-400">
              No inconsistent reconciliation events are currently recorded.
            </p>
          )}
        </div>
      </section>
      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="font-semibold text-white">
          Escalation routing and retention
        </h2>
        <p className="mt-1 text-sm text-slate-400">
          Approved HTTPS webhook hosts only. Health observations older than the
          selected retention period are pruned when this policy is saved.
        </p>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <label className="flex items-center gap-2 text-sm text-slate-200">
            <input
              type="checkbox"
              checked={routingEnabled}
              onChange={(event) => setRoutingEnabled(event.target.checked)}
            />{" "}
            Enable overdue-alert routing
          </label>
          <label className="text-sm text-slate-300">
            Escalate after minutes
            <input
              type="number"
              min="5"
              max="10080"
              value={routingMinutes}
              onChange={(event) =>
                setRoutingMinutes(Number(event.target.value))
              }
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white"
            />
          </label>
          <label className="text-sm text-slate-300">
            Health retention days
            <input
              type="number"
              min="1"
              max="365"
              value={retentionDays}
              onChange={(event) => setRetentionDays(Number(event.target.value))}
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white"
            />
          </label>
          <label className="text-sm text-slate-300 md:row-span-2">
            On-call webhook URLs
            <textarea
              value={routingWebhooks}
              onChange={(event) => setRoutingWebhooks(event.target.value)}
              placeholder="https://approved.example/on-call"
              className="mt-1 min-h-24 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white"
            />
          </label>
        </div>
        <button
          type="button"
          onClick={() => {
            void saveSettings();
          }}
          className="mt-4 rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-4 py-2 text-sm text-cyan-100"
        >
          Save routing policy
        </button>
        {settingsStatus && (
          <p role="status" className="mt-2 text-sm text-slate-300">
            {settingsStatus}
          </p>
        )}
      </section>
      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <div className="mb-4 flex items-center gap-2">
          <FlaskConical className="h-5 w-5 text-violet-200" />
          <div>
            <h2 className="font-semibold text-white">
              Isolated recovery scenarios and browser tests
            </h2>
            <p className="mt-1 text-sm text-slate-400">
              Controls remain disabled unless an explicit non-production
              executor is configured.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-3">
          {simulations.data?.scenarios.map((scenario) => (
            <button
              key={scenario}
              type="button"
              disabled={!simulations.data.enabled || simulation.isPending}
              onClick={() => simulation.mutate(scenario)}
              className="rounded-lg border border-violet-400/30 bg-violet-400/10 px-4 py-2 text-sm text-violet-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Run {scenario.replace(/-/g, " ")}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              void runPlaywright();
            }}
            className="rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-4 py-2 text-sm text-cyan-100"
          >
            Run Playwright suite
          </button>
        </div>
        {playwrightStatus && (
          <p role="status" className="mt-3 text-sm text-slate-300">
            {playwrightStatus}
          </p>
        )}
        {simulation.isError && (
          <p role="alert" className="mt-4 text-sm text-rose-200">
            Simulation was not submitted:{" "}
            {(simulation.error as Error).message.replace(/_/g, " ")}.
          </p>
        )}
        {simulation.data && (
          <p role="status" className="mt-4 text-sm text-emerald-200">
            {simulation.data.scenario} scenario submitted to the isolated
            executor.
          </p>
        )}
      </section>
      <section className="rounded-2xl border border-amber-400/30 bg-amber-400/5 p-5">
        <h2 className="font-semibold text-amber-100">Alert workflow</h2>
        <p className="mt-1 text-sm text-amber-100/80">
          Actions are recorded with your administrator identity. Dismissal only
          changes dashboard visibility; it never changes financial state.
        </p>
        <div className="mt-4 space-y-3">
          {alerts.data?.alerts.length ? (
            alerts.data.alerts.map((alert) => (
              <div
                key={`workflow-${alert.id}`}
                className="rounded-xl border border-slate-700 bg-slate-950/40 p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-white">{alert.title}</span>
                  <span className="text-xs text-slate-400">
                    {alert.action
                      ? `Latest action: ${alert.action}`
                      : "No action recorded"}
                  </span>
                </div>
                {alert.note && (
                  <p className="mt-2 text-sm text-slate-300">
                    Note: {alert.note}
                  </p>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={alertAction.isPending}
                    onClick={() =>
                      alertAction.mutate({
                        alertId: alert.id,
                        action: "acknowledge",
                      })
                    }
                    className="rounded-lg border border-cyan-400/30 px-3 py-2 text-sm text-cyan-100 disabled:opacity-50"
                  >
                    Acknowledge
                  </button>
                  <button
                    type="button"
                    disabled={alertAction.isPending}
                    onClick={() =>
                      alertAction.mutate({
                        alertId: alert.id,
                        action: "dismiss",
                      })
                    }
                    className="rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-200 disabled:opacity-50"
                  >
                    Dismiss
                  </button>
                  <input
                    value={noteDraft[alert.id] ?? ""}
                    onChange={(event) =>
                      setNoteDraft((current) => ({
                        ...current,
                        [alert.id]: event.target.value.slice(0, 500),
                      }))
                    }
                    placeholder="Add investigation note"
                    aria-label={`Note for ${alert.title}`}
                    className="min-w-52 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white"
                  />
                  <button
                    type="button"
                    disabled={
                      alertAction.isPending ||
                      !(noteDraft[alert.id] ?? "").trim()
                    }
                    onClick={() =>
                      alertAction.mutate({
                        alertId: alert.id,
                        action: "note",
                        note: noteDraft[alert.id],
                      })
                    }
                    className="rounded-lg border border-amber-400/30 px-3 py-2 text-sm text-amber-100 disabled:opacity-50"
                  >
                    Save note
                  </button>
                </div>
              </div>
            ))
          ) : (
            <p className="text-sm text-slate-400">
              No alerts require acknowledgement.
            </p>
          )}
        </div>
        {alertAction.isError && (
          <p role="alert" className="mt-3 text-sm text-rose-200">
            Alert action unavailable:{" "}
            {(alertAction.error as Error).message.replace(/_/g, " ")}.
          </p>
        )}
      </section>
      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="font-semibold text-white">Filtered financial report</h2>
        <p className="mt-1 text-sm text-slate-400">
          Downloads the same bounded transfer and reconciliation records
          currently shown by your search, date range, and sorting choices.
        </p>
        <button
          type="button"
          onClick={() => {
            void exportReport();
          }}
          className="mt-4 rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-4 py-2 text-sm text-cyan-100"
        >
          Download CSV report
        </button>
        {exportStatus && (
          <p role="status" className="mt-3 text-sm text-emerald-200">
            {exportStatus}
          </p>
        )}
      </section>
      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="font-semibold text-white">
          Routed-alert delivery receipts
        </h2>
        <p className="mt-1 text-sm text-slate-400">
          Receipt status is supplied by the on-call delivery worker; queued
          receipts are not treated as delivered.
        </p>
        <div className="mt-3 space-y-2">
          {receipts.data?.receipts.length ? (
            receipts.data.receipts.map((receipt) => (
              <div
                key={`${receipt.alertId}-${receipt.routedAt}`}
                className={`rounded-lg border p-3 text-sm ${receipt.status === "delivered" ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-100" : receipt.status === "failed" ? "border-rose-400/30 bg-rose-400/10 text-rose-100" : "border-amber-400/30 bg-amber-400/10 text-amber-100"}`}
              >
                <div className="flex justify-between gap-3">
                  <span className="font-medium">{receipt.alertId}</span>
                  <span className="uppercase text-xs">{receipt.status}</span>
                </div>
                <p className="mt-1 text-xs opacity-80">
                  {receipt.webhookHost} · routed{" "}
                  {new Date(receipt.routedAt).toLocaleString()}
                </p>
                {receipt.detail && (
                  <p className="mt-1 text-xs opacity-80">{receipt.detail}</p>
                )}
              </div>
            ))
          ) : (
            <p className="text-sm text-slate-400">
              No routed-alert delivery receipts have been recorded.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
