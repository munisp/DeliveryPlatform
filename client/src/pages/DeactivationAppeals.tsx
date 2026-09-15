import { FormEvent, useMemo, useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  Clock,
  FileText,
  Gavel,
  Scale,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";

import DashboardLayout from "@/components/DashboardLayout";
import { EmptyState, QueryErrorState } from "@/components/QueryState";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useSessionProfile } from "@/lib/sessionProfile";
import {
  type AppealDecision,
  type DeactivationCase,
  useDeactivationCases,
  useFileAppeal,
  useMyDeactivationCase,
  useReviewAppeal,
  useTrustInvalidation,
} from "@/lib/trpcTrust";

const operationsRoles = new Set([
  "operator",
  "ops",
  "admin",
  "platform_admin",
  "super_admin",
]);

const decisionOptions: Array<{ key: AppealDecision; label: string }> = [
  { key: "upheld", label: "Uphold deactivation" },
  { key: "reinstated", label: "Reinstate account" },
  { key: "reinstated_with_backpay", label: "Reinstate with backpay" },
];

function dateLabel(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString() : "—";
}

function noticeCountdown(deactivationCase: DeactivationCase) {
  if (!deactivationCase.effectiveAt) return null;
  const remainingMs =
    new Date(deactivationCase.effectiveAt).getTime() - Date.now();
  if (remainingMs <= 0) return null;
  const days = Math.floor(remainingMs / 86_400_000);
  const hours = Math.floor((remainingMs % 86_400_000) / 3_600_000);
  return `${days}d ${hours}h before deactivation takes effect`;
}

type TimelineStep = { label: string; at: string | null; done: boolean };

function caseTimeline(deactivationCase: DeactivationCase): TimelineStep[] {
  const status = deactivationCase.status.toLowerCase();
  const appealed =
    status.includes("appeal") ||
    status.includes("review") ||
    status.includes("reinstated") ||
    status.includes("upheld") ||
    status.includes("decided");
  const decided =
    status.includes("reinstated") ||
    status.includes("upheld") ||
    status.includes("decided");
  return [
    {
      label: "Notice sent",
      at: deactivationCase.noticeSentAt,
      done: Boolean(deactivationCase.noticeSentAt),
    },
    {
      label: "Deactivation effective",
      at: deactivationCase.effectiveAt,
      done: decided || status.includes("active") || status.includes("effective"),
    },
    { label: "Appeal filed", at: null, done: appealed },
    { label: "Decision issued", at: null, done: decided },
  ];
}

function MyCaseSection() {
  const myCase = useMyDeactivationCase();
  const fileAppeal = useFileAppeal();
  const invalidate = useTrustInvalidation();
  const [statement, setStatement] = useState("");

  const submitAppeal = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const deactivationCase = myCase.data;
    if (!deactivationCase || !statement.trim()) return;
    fileAppeal.mutate(
      { caseId: deactivationCase.id, statement: statement.trim() },
      {
        onSuccess: () => {
          setStatement("");
          invalidate.deactivation();
        },
      },
    );
  };

  if (myCase.isError) {
    return (
      <QueryErrorState
        resource="your deactivation case"
        message={myCase.error?.message}
        onRetry={() => void myCase.refetch()}
        retrying={myCase.isRefetching}
      />
    );
  }

  if (myCase.isLoading) {
    return <p className="text-sm text-slate-400">Loading your case…</p>;
  }

  const deactivationCase = myCase.data;
  if (!deactivationCase) {
    return (
      <EmptyState
        title="No deactivation case on your account"
        description="Your account is in good standing. If the platform ever issues a deactivation notice you will see the 14-day timeline, the stated cause, and the appeal form here."
      />
    );
  }

  const countdown = noticeCountdown(deactivationCase);
  const timeline = caseTimeline(deactivationCase);

  return (
    <div className="space-y-4">
      <div className="flex gap-3 border border-amber-500/30 bg-amber-950/20 p-4 text-sm text-amber-100">
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
        <div>
          <p className="font-medium">
            Deactivation notice — {deactivationCase.causeCode}
          </p>
          <p className="mt-1 leading-6 text-amber-100/80">
            Deactivations require 14 days notice except where conduct is
            egregious. You may appeal with a written statement; the decision
            and its rationale are recorded here.
          </p>
          {deactivationCase.protectedActivity ? (
            <p className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-100">
              <ShieldCheck className="h-3.5 w-3.5" />
              Protected worker activity is flagged on this case
            </p>
          ) : null}
        </div>
      </div>

      <Card className="border-slate-800 bg-slate-950/60">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-base text-slate-100">
              <FileText className="h-5 w-5 text-cyan-300" />
              Case {deactivationCase.id}
            </CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{deactivationCase.subjectRole}</Badge>
              <Badge
                variant={deactivationCase.egregious ? "destructive" : "secondary"}
              >
                {deactivationCase.egregious
                  ? "Egregious — immediate"
                  : "14-day notice"}
              </Badge>
              <Badge variant="default">{deactivationCase.status}</Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {countdown ? (
            <div className="inline-flex items-center gap-2 rounded-full border border-amber-400/40 px-3 py-1 text-sm text-amber-200">
              <Clock className="h-4 w-4" />
              {countdown}
            </div>
          ) : null}

          <ol className="grid gap-3 md:grid-cols-4">
            {timeline.map((step) => (
              <li
                key={step.label}
                className={
                  step.done
                    ? "rounded-xl border border-cyan-400/30 bg-cyan-500/5 px-4 py-3"
                    : "rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3"
                }
              >
                <p
                  className={
                    step.done
                      ? "flex items-center gap-2 text-sm font-medium text-cyan-100"
                      : "flex items-center gap-2 text-sm font-medium text-slate-400"
                  }
                >
                  <CheckCircle2
                    className={
                      step.done
                        ? "h-4 w-4 text-cyan-300"
                        : "h-4 w-4 text-slate-600"
                    }
                  />
                  {step.label}
                </p>
                {step.at ? (
                  <p className="mt-1 text-xs text-slate-500">
                    {dateLabel(step.at)}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>

          <form onSubmit={submitAppeal} className="space-y-3">
            <label
              className="text-sm font-medium text-slate-200"
              htmlFor="appeal-statement"
            >
              Appeal statement
            </label>
            <textarea
              id="appeal-statement"
              value={statement}
              onChange={(event) => setStatement(event.target.value)}
              placeholder="State the facts the reviewer must consider — dates, trips, evidence references…"
              rows={5}
              required
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
            />
            <div>
              <button
                type="submit"
                disabled={fileAppeal.isPending || !statement.trim()}
                className="rounded-md bg-cyan-400 px-4 py-2 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {fileAppeal.isPending ? "Filing…" : "File appeal"}
              </button>
              {fileAppeal.isError ? (
                <span className="ml-3 text-sm text-red-200">
                  {fileAppeal.error?.message}
                </span>
              ) : null}
              {fileAppeal.isSuccess ? (
                <span className="ml-3 inline-flex items-center gap-1 text-sm text-emerald-200">
                  <CheckCircle2 className="h-4 w-4" />
                  Appeal filed
                </span>
              ) : null}
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function OperatorSection() {
  const cases = useDeactivationCases();
  const reviewAppeal = useReviewAppeal();
  const invalidate = useTrustInvalidation();
  const [selectedAppealId, setSelectedAppealId] = useState<string | null>(null);
  const [decision, setDecision] = useState<AppealDecision>("upheld");
  const [rationale, setRationale] = useState("");

  const rows = useMemo(() => cases.data ?? [], [cases.data]);

  const submitReview = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedAppealId || !rationale.trim()) return;
    reviewAppeal.mutate(
      { appealId: selectedAppealId, decision, rationale: rationale.trim() },
      {
        onSuccess: () => {
          setSelectedAppealId(null);
          setRationale("");
          invalidate.deactivation();
        },
      },
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-3 border border-cyan-400/30 bg-cyan-400/5 p-4 text-sm text-cyan-50">
        <Gavel className="mt-0.5 h-5 w-5 shrink-0 text-cyan-300" />
        <p>
          Operator review queue. Every decision requires a written rationale
          and is recorded against your reviewer identity. Reinstatement with
          backpay compensates lost proceeds for the deactivation period.
        </p>
      </div>

      {cases.isError ? (
        <QueryErrorState
          resource="deactivation cases"
          message={cases.error?.message}
          onRetry={() => void cases.refetch()}
          retrying={cases.isRefetching}
        />
      ) : cases.isLoading ? (
        <p className="text-sm text-slate-400">Loading deactivation cases…</p>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No deactivation cases"
          description="Cases appear here when a deactivation notice is issued for a driver, courier, or rider account."
        />
      ) : (
        <Card className="border-slate-800 bg-slate-950/60">
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-800 text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-4 py-3 font-medium">Case</th>
                    <th className="px-4 py-3 font-medium">Subject</th>
                    <th className="px-4 py-3 font-medium">Cause</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Effective</th>
                    <th className="px-4 py-3 font-medium">Appeals</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={row.id}
                      className="border-b border-slate-800/60 align-top text-slate-300"
                    >
                      <td className="px-4 py-3 font-mono text-xs text-slate-500">
                        {row.id}
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-100">
                          {row.subjectRole}
                        </div>
                        <div className="font-mono text-xs text-slate-500">
                          {row.subjectUserId}
                        </div>
                      </td>
                      <td className="px-4 py-3">{row.causeCode}</td>
                      <td className="px-4 py-3">
                        <Badge variant="secondary">{row.status}</Badge>
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {dateLabel(row.effectiveAt)}
                      </td>
                      <td className="px-4 py-3">
                        {row.appeals.length === 0 ? (
                          <span className="text-xs text-slate-500">None</span>
                        ) : (
                          <ul className="space-y-2">
                            {row.appeals.map((appeal) => (
                              <li
                                key={appeal.id}
                                className="rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-2"
                              >
                                <div className="flex flex-wrap items-center gap-2">
                                  <Badge
                                    variant={
                                      appeal.decision
                                        ? appeal.decision === "upheld"
                                          ? "destructive"
                                          : "default"
                                        : "secondary"
                                    }
                                  >
                                    {appeal.decision ?? appeal.status}
                                  </Badge>
                                  {appeal.slaDueAt ? (
                                    <span className="text-xs text-slate-500">
                                      SLA {dateLabel(appeal.slaDueAt)}
                                    </span>
                                  ) : null}
                                </div>
                                {!appeal.decision ? (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setSelectedAppealId(
                                        selectedAppealId === appeal.id
                                          ? null
                                          : appeal.id,
                                      )
                                    }
                                    className="mt-2 inline-flex rounded-full border border-cyan-400/30 bg-cyan-500/10 px-3 py-1 text-xs font-medium text-cyan-100 transition hover:bg-cyan-500/20"
                                  >
                                    {selectedAppealId === appeal.id
                                      ? "Close review"
                                      : "Review appeal"}
                                  </button>
                                ) : null}
                                {selectedAppealId === appeal.id ? (
                                  <form
                                    onSubmit={submitReview}
                                    className="mt-3 space-y-2"
                                  >
                                    <select
                                      value={decision}
                                      onChange={(event) =>
                                        setDecision(
                                          event.target.value as AppealDecision,
                                        )
                                      }
                                      className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                                    >
                                      {decisionOptions.map((option) => (
                                        <option
                                          key={option.key}
                                          value={option.key}
                                        >
                                          {option.label}
                                        </option>
                                      ))}
                                    </select>
                                    <textarea
                                      value={rationale}
                                      onChange={(event) =>
                                        setRationale(event.target.value)
                                      }
                                      placeholder="Decision rationale (required, recorded)…"
                                      rows={3}
                                      required
                                      className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                                    />
                                    <button
                                      type="submit"
                                      disabled={
                                        reviewAppeal.isPending ||
                                        !rationale.trim()
                                      }
                                      className="rounded-md bg-cyan-400 px-3 py-2 text-xs font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
                                    >
                                      {reviewAppeal.isPending
                                        ? "Recording…"
                                        : "Record decision"}
                                    </button>
                                    {reviewAppeal.isError ? (
                                      <span className="ml-2 text-xs text-red-200">
                                        {reviewAppeal.error?.message}
                                      </span>
                                    ) : null}
                                  </form>
                                ) : null}
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default function DeactivationAppeals() {
  const sessionProfile = useSessionProfile();
  const isOperator = Boolean(
    sessionProfile.data?.role && operationsRoles.has(sessionProfile.data.role),
  );

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="border-b border-slate-800 pb-6">
          <div className="space-y-2">
            <p className="text-sm font-medium uppercase tracking-[0.18em] text-cyan-300">
              Deactivation due process — notice and appeal
            </p>
            <h1 className="text-3xl font-semibold tracking-tight text-slate-50">
              Deactivation appeals
            </h1>
            <p className="max-w-3xl text-sm leading-6 text-slate-400">
              Union-represented workers are entitled to advance notice, a
              stated cause, and a human appeal with a recorded decision —
              including reinstatement with backpay where the deactivation was
              unjustified.
            </p>
          </div>
        </div>

        <section aria-label="My deactivation case" className="space-y-3">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-100">
            <Scale className="h-5 w-5 text-cyan-300" />
            My case
          </h2>
          <MyCaseSection />
        </section>

        {isOperator ? (
          <section aria-label="Operator review queue" className="space-y-3">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-100">
              <Gavel className="h-5 w-5 text-cyan-300" />
              Operator review
            </h2>
            <OperatorSection />
          </section>
        ) : (
          <div className="flex gap-3 border border-slate-700 bg-slate-900/60 p-4 text-sm text-slate-300">
            <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-slate-400" />
            <p className="leading-6 text-slate-400">
              The operator review queue is only visible to trust and
              operations roles. Server-side authorization is enforced
              independently of this view.
            </p>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
