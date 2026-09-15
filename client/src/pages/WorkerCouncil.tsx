import { FormEvent, useMemo, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  Clock,
  Handshake,
  MessageSquare,
  Send,
} from "lucide-react";

import DashboardLayout from "@/components/DashboardLayout";
import { EmptyState, QueryErrorState } from "@/components/QueryState";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  type ConsultationObject,
  type ConsultationStance,
  type ConsultationStatus,
  useConsultation,
  useConsultations,
  useRespondToConsultation,
  useTrustInvalidation,
} from "@/lib/trpcTrust";

const statusFilters: Array<{ key: ConsultationStatus | undefined; label: string }> = [
  { key: undefined, label: "All" },
  { key: "open", label: "Open" },
  { key: "activated", label: "Activated" },
  { key: "closed", label: "Closed" },
  { key: "withdrawn", label: "Withdrawn" },
];

const stances: Array<{ key: ConsultationStance; label: string }> = [
  { key: "support", label: "Support" },
  { key: "object", label: "Object" },
  { key: "comment", label: "Comment" },
];

function dateLabel(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString() : "—";
}

function statusBadgeVariant(status: ConsultationStatus) {
  if (status === "open") return "default" as const;
  if (status === "activated") return "default" as const;
  if (status === "withdrawn") return "destructive" as const;
  return "secondary" as const;
}

function slaLabel(responseSlaAt: string | null, status: ConsultationStatus) {
  if (!responseSlaAt || status !== "open") return null;
  const remainingMs = new Date(responseSlaAt).getTime() - Date.now();
  if (remainingMs <= 0) return { text: "Response window elapsed", overdue: true };
  const hours = Math.floor(remainingMs / 3_600_000);
  if (hours >= 48) {
    return { text: `${Math.floor(hours / 24)}d ${hours % 24}h to respond`, overdue: false };
  }
  const minutes = Math.floor((remainingMs % 3_600_000) / 60_000);
  return { text: `${hours}h ${minutes}m to respond`, overdue: false };
}

function TallyBars({ consultation }: { consultation: ConsultationObject }) {
  const { support, object, comment } = consultation.responseCounts;
  const total = Math.max(1, support + object + comment);
  const rows: Array<{ label: string; count: number; className: string }> = [
    { label: "Support", count: support, className: "bg-emerald-400/70" },
    { label: "Object", count: object, className: "bg-rose-400/70" },
    { label: "Comment", count: comment, className: "bg-slate-400/70" },
  ];
  return (
    <div className="space-y-1.5">
      {rows.map((row) => (
        <div key={row.label} className="flex items-center gap-2 text-xs">
          <span className="w-14 shrink-0 text-slate-400">{row.label}</span>
          <div className="h-2 min-w-0 flex-1 rounded-full bg-slate-800">
            <div
              className={`h-2 rounded-full ${row.className}`}
              style={{ width: `${Math.round((row.count / total) * 100)}%` }}
            />
          </div>
          <span className="w-8 shrink-0 text-right font-medium text-slate-200">
            {row.count}
          </span>
        </div>
      ))}
    </div>
  );
}

function ConsultationDetailView({
  id,
  onBack,
}: {
  id: string;
  onBack: () => void;
}) {
  const detail = useConsultation(id);
  const respond = useRespondToConsultation();
  const invalidate = useTrustInvalidation();
  const [stance, setStance] = useState<ConsultationStance>("support");
  const [body, setBody] = useState("");

  const consultation = detail.data;

  const submitResponse = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!body.trim()) return;
    respond.mutate(
      { id, stance, body: body.trim() },
      {
        onSuccess: () => {
          setBody("");
          invalidate.council();
        },
      },
    );
  };

  if (detail.isError) {
    return (
      <QueryErrorState
        resource="consultation detail"
        message={detail.error?.message}
        onRetry={() => void detail.refetch()}
        retrying={detail.isRefetching}
      />
    );
  }

  if (!consultation) {
    return <p className="text-sm text-slate-400">Loading consultation…</p>;
  }

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-2 rounded-full border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 transition hover:border-cyan-300 hover:text-cyan-100"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to consultations
      </button>

      <Card className="border-slate-800 bg-slate-950/60">
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{consultation.kind}</Badge>
            <Badge variant={statusBadgeVariant(consultation.status)}>
              {consultation.status}
            </Badge>
            {consultation.myResponse ? (
              <Badge variant="secondary">
                You responded: {consultation.myResponse.stance}
              </Badge>
            ) : null}
          </div>
          <CardTitle className="text-xl text-slate-50">
            {consultation.title}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 text-sm md:grid-cols-3">
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500">
                Opened
              </p>
              <p className="mt-1 font-medium text-slate-100">
                {dateLabel(consultation.createdAt)}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500">
                Response SLA
              </p>
              <p className="mt-1 font-medium text-slate-100">
                {dateLabel(consultation.responseSlaAt)}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500">
                Activated
              </p>
              <p className="mt-1 font-medium text-slate-100">
                {consultation.activatedAt
                  ? dateLabel(consultation.activatedAt)
                  : "Not yet activated"}
              </p>
            </div>
          </div>

          <div>
            <p className="text-xs uppercase tracking-wide text-slate-500">
              Proposal payload
            </p>
            <pre className="mt-2 max-h-80 overflow-auto rounded-xl border border-slate-800 bg-slate-950 p-4 text-xs leading-5 text-slate-300">
              {JSON.stringify(consultation.payload, null, 2)}
            </pre>
          </div>

          <TallyBars consultation={consultation} />
        </CardContent>
      </Card>

      <Card className="border-slate-800 bg-slate-950/60">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base text-slate-100">
            <MessageSquare className="h-5 w-5 text-cyan-300" />
            Member responses
          </CardTitle>
        </CardHeader>
        <CardContent>
          {(consultation.responses ?? []).length === 0 ? (
            <p className="text-sm text-slate-400">
              No responses yet. Be the first council member to weigh in.
            </p>
          ) : (
            <ul className="space-y-3 text-sm text-slate-300">
              {consultation.responses.map((response) => (
                <li
                  key={response.id}
                  className="rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono text-xs text-slate-500">
                      {response.memberId}
                    </span>
                    <Badge
                      variant={
                        response.stance === "object"
                          ? "destructive"
                          : response.stance === "support"
                            ? "default"
                            : "secondary"
                      }
                    >
                      {response.stance}
                    </Badge>
                  </div>
                  <p className="mt-2 leading-6 text-slate-300">
                    {response.body}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {dateLabel(response.createdAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card className="border-slate-800 bg-slate-950/60">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base text-slate-100">
            <Send className="h-5 w-5 text-cyan-300" />
            Your response
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={submitResponse} className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {stances.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  onClick={() => setStance(option.key)}
                  aria-pressed={stance === option.key}
                  className={
                    stance === option.key
                      ? "rounded-md border border-cyan-300 bg-cyan-500/15 px-3 py-2 text-xs font-medium text-cyan-100"
                      : "rounded-md border border-slate-700 px-3 py-2 text-xs font-medium text-slate-200 hover:border-cyan-300 hover:text-cyan-100"
                  }
                >
                  {option.label}
                </button>
              ))}
            </div>
            <textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="Explain your position for the record…"
              rows={4}
              required
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
            />
            <div>
              <button
                type="submit"
                disabled={respond.isPending || !body.trim()}
                className="rounded-md bg-cyan-400 px-4 py-2 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {respond.isPending ? "Submitting…" : "Submit response"}
              </button>
              {respond.isError ? (
                <span className="ml-3 text-sm text-red-200">
                  {respond.error?.message}
                </span>
              ) : null}
              {respond.isSuccess ? (
                <span className="ml-3 inline-flex items-center gap-1 text-sm text-emerald-200">
                  <CheckCircle2 className="h-4 w-4" />
                  Response recorded
                </span>
              ) : null}
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

export default function WorkerCouncil() {
  const [statusFilter, setStatusFilter] = useState<ConsultationStatus | undefined>(
    undefined,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const consultations = useConsultations(statusFilter);

  const list = useMemo(
    () => consultations.data ?? [],
    [consultations.data],
  );

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="flex flex-col justify-between gap-4 border-b border-slate-800 pb-6 lg:flex-row lg:items-end">
          <div className="space-y-2">
            <p className="text-sm font-medium uppercase tracking-[0.18em] text-cyan-300">
              Worker council — consultation and co-determination
            </p>
            <h1 className="text-3xl font-semibold tracking-tight text-slate-50">
              Consultations that bind the platform
            </h1>
            <p className="max-w-3xl text-sm leading-6 text-slate-400">
              Policy changes affecting drivers and couriers are tabled here
              before activation. Review the payload, respond within the SLA
              window, and track whether the platform honoured the outcome.
            </p>
          </div>
        </div>

        {selectedId ? (
          <ConsultationDetailView
            id={selectedId}
            onBack={() => setSelectedId(null)}
          />
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {statusFilters.map((filter) => (
                <button
                  key={filter.label}
                  type="button"
                  onClick={() => setStatusFilter(filter.key)}
                  aria-pressed={statusFilter === filter.key}
                  className={
                    statusFilter === filter.key
                      ? "rounded-full border border-cyan-300 bg-cyan-500/15 px-4 py-2 text-sm font-medium text-cyan-100"
                      : "rounded-full border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:border-cyan-300 hover:text-cyan-100"
                  }
                >
                  {filter.label}
                </button>
              ))}
            </div>

            {consultations.isError ? (
              <QueryErrorState
                resource="council consultations"
                message={consultations.error?.message}
                onRetry={() => void consultations.refetch()}
                retrying={consultations.isRefetching}
              />
            ) : consultations.isLoading ? (
              <p className="text-sm text-slate-400">
                Loading consultations…
              </p>
            ) : list.length === 0 ? (
              <EmptyState
                title="No consultations in this state"
                description="When the platform tables a policy change for worker consultation it will appear here with its response deadline."
              />
            ) : (
              <div className="space-y-4">
                {list.map((consultation) => {
                  const sla = slaLabel(
                    consultation.responseSlaAt,
                    consultation.status,
                  );
                  return (
                    <Card
                      key={consultation.id}
                      className="border-slate-700 bg-slate-950/70"
                    >
                      <CardHeader className="border-b border-slate-800">
                        <div className="flex flex-col justify-between gap-3 md:flex-row md:items-center">
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge variant="outline">
                                {consultation.kind}
                              </Badge>
                              <Badge
                                variant={statusBadgeVariant(consultation.status)}
                              >
                                {consultation.status}
                              </Badge>
                              {consultation.myResponse ? (
                                <Badge variant="secondary">
                                  Responded
                                </Badge>
                              ) : null}
                            </div>
                            <CardTitle className="mt-2 flex items-center gap-2 text-lg text-slate-50">
                              <Handshake className="h-5 w-5 text-cyan-300" />
                              {consultation.title}
                            </CardTitle>
                          </div>
                          {sla ? (
                            <div
                              className={
                                sla.overdue
                                  ? "inline-flex items-center gap-2 rounded-full border border-rose-400/40 px-3 py-1 text-sm text-rose-200"
                                  : "inline-flex items-center gap-2 rounded-full border border-amber-400/40 px-3 py-1 text-sm text-amber-200"
                              }
                            >
                              <Clock className="h-4 w-4" />
                              {sla.text}
                            </div>
                          ) : null}
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-4 p-5">
                        <div className="grid gap-3 text-sm md:grid-cols-3">
                          <div>
                            <p className="text-xs uppercase tracking-wide text-slate-500">
                              Opened
                            </p>
                            <p className="mt-1 font-medium text-slate-100">
                              {dateLabel(consultation.createdAt)}
                            </p>
                          </div>
                          <div>
                            <p className="text-xs uppercase tracking-wide text-slate-500">
                              Activated
                            </p>
                            <p className="mt-1 font-medium text-slate-100">
                              {consultation.activatedAt
                                ? dateLabel(consultation.activatedAt)
                                : "Pending council outcome"}
                            </p>
                          </div>
                          <div>
                            <p className="text-xs uppercase tracking-wide text-slate-500">
                              Response SLA
                            </p>
                            <p className="mt-1 font-medium text-slate-100">
                              {dateLabel(consultation.responseSlaAt)}
                            </p>
                          </div>
                        </div>
                        <TallyBars consultation={consultation} />
                        <div>
                          <button
                            type="button"
                            onClick={() => setSelectedId(consultation.id)}
                            className="inline-flex rounded-full border border-cyan-400/30 bg-cyan-500/10 px-4 py-2 text-sm font-medium text-cyan-100 transition hover:bg-cyan-500/20"
                          >
                            Review and respond
                          </button>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
