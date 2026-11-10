/**
 * Rental settlement dispute panel (rentalDispute router). Renters open a
 * dispute against a computed return settlement (damage / excess-km / fuel /
 * odometer charges) and track its lifecycle; operations roles work the open
 * queue and decide each dispute as upheld, rejected, or adjusted (with an
 * adjustment amount in minor units). Dispute authority stays in the
 * rentalDispute router and the vehicle_access SQL gates; the UI never decides
 * or adjusts charges itself.
 */
import { FormEvent, useMemo, useState } from "react";
import { Loader2, Scale } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useSessionProfile } from "@/lib/sessionProfile";
import { formatMinor } from "@/components/FareBreakdown";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DISPUTE_REASONS,
  disputeReasonLabel,
  isUuid,
  normalizeDisputes,
  parseMajorToMinor,
  type DisputeReason,
  type DisputeStatus,
  type NormalizedDispute,
} from "@/lib/rentalConditionWire";

function idempotency(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

const inputClass =
  "w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100";
const operatorRoles = new Set([
  "operator",
  "ops",
  "admin",
  "platform_admin",
  "super_admin",
]);

const DECISION_STATUSES = ["upheld", "rejected", "adjusted"] as const;
type DecisionStatus = (typeof DECISION_STATUSES)[number];

function disputeStatusPillClass(status: string): string {
  switch (status as DisputeStatus) {
    case "open":
      return "border-amber-400/40 bg-amber-500/10 text-amber-200";
    case "upheld":
      return "border-slate-400/40 bg-slate-500/10 text-slate-200";
    case "rejected":
      return "border-rose-400/40 bg-rose-500/10 text-rose-200";
    case "adjusted":
      return "border-cyan-400/40 bg-cyan-500/10 text-cyan-200";
    default:
      return "border-slate-400/40 bg-slate-500/10 text-slate-200";
  }
}

function DisputeStatusPill({ status }: { status: string }) {
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-xs ${disputeStatusPillClass(status)}`}
    >
      {status.replace("_", " ")}
    </span>
  );
}

function DisputeRow({ dispute }: { dispute: NormalizedDispute }) {
  return (
    <div className="space-y-2 border border-slate-800 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-slate-100">
          {disputeReasonLabel(dispute.reason)}
        </span>
        <DisputeStatusPill status={dispute.status} />
      </div>
      <p className="text-sm leading-6 text-slate-400">{dispute.detail}</p>
      <p className="font-mono text-xs text-slate-500">
        {dispute.id}
        {dispute.createdAt
          ? ` · opened ${new Date(dispute.createdAt).toLocaleString()}`
          : ""}
      </p>
      {dispute.status === "adjusted" && dispute.adjustmentMinor !== null ? (
        <p className="text-sm text-cyan-200">
          Adjustment: {formatMinor(dispute.adjustmentMinor, "NGN")}
        </p>
      ) : null}
      {dispute.operatorNote ? (
        <p className="text-sm text-slate-400">
          Operator note: {dispute.operatorNote}
        </p>
      ) : null}
    </div>
  );
}

function OperatorDisputeCard({
  dispute,
  onNotice,
  onDecided,
}: {
  dispute: NormalizedDispute;
  onNotice: (message: string) => void;
  onDecided: () => void;
}) {
  const [pending, setPending] = useState<DecisionStatus | null>(null);
  const [adjustmentMajor, setAdjustmentMajor] = useState("");
  const [operatorNote, setOperatorNote] = useState("");

  const decideMutation = trpc.rentalDispute.decide.useMutation({
    onSuccess: (disputeId) => {
      onDecided();
      onNotice(`Dispute decided: ${disputeId}`);
    },
    onError: (error) => onNotice(error.message),
  });

  const confirmDecision = () => {
    if (!pending) return;
    try {
      decideMutation.mutate({
        disputeId: dispute.id,
        status: pending,
        adjustmentMinor:
          pending === "adjusted"
            ? parseMajorToMinor(adjustmentMajor, "adjustment amount")
            : undefined,
        operatorNote: operatorNote.trim() ? operatorNote.trim() : undefined,
        idempotencyKey: idempotency("rental-dispute-decide"),
      });
      setPending(null);
    } catch (error) {
      onNotice(
        error instanceof Error ? error.message : "Invalid adjustment input.",
      );
    }
  };

  return (
    <div className="space-y-3 border border-slate-800 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-slate-100">
          {disputeReasonLabel(dispute.reason)}
        </span>
        <DisputeStatusPill status={dispute.status} />
      </div>
      <p className="text-sm leading-6 text-slate-400">{dispute.detail}</p>
      <p className="font-mono text-xs text-slate-500">
        contract {dispute.contractId.slice(0, 8)}…
        {dispute.createdAt
          ? ` · opened ${new Date(dispute.createdAt).toLocaleString()}`
          : ""}
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded-md border border-slate-600 px-3 py-1.5 text-xs font-medium text-slate-100 disabled:opacity-60"
          disabled={decideMutation.isPending}
          onClick={() => setPending("upheld")}
        >
          Uphold
        </button>
        <button
          type="button"
          className="rounded-md border border-rose-500/60 px-3 py-1.5 text-xs font-medium text-rose-200 disabled:opacity-60"
          disabled={decideMutation.isPending}
          onClick={() => setPending("rejected")}
        >
          Reject
        </button>
        <button
          type="button"
          className="rounded-md border border-cyan-500/60 px-3 py-1.5 text-xs font-medium text-cyan-200 disabled:opacity-60"
          disabled={decideMutation.isPending}
          onClick={() => setPending("adjusted")}
        >
          Adjust
        </button>
      </div>
      {pending === "adjusted" ? (
        <div className="space-y-2">
          <input
            className={inputClass}
            placeholder="Adjustment amount (major units)"
            inputMode="decimal"
            value={adjustmentMajor}
            onChange={(event) => setAdjustmentMajor(event.target.value)}
          />
          <textarea
            className={inputClass}
            placeholder="Operator note (optional)"
            maxLength={2000}
            rows={3}
            value={operatorNote}
            onChange={(event) => setOperatorNote(event.target.value)}
          />
        </div>
      ) : null}
      {pending ? (
        <div className="flex flex-wrap items-center gap-2 border border-slate-800 bg-slate-950/40 p-3">
          <p className="text-sm text-slate-300">
            Mark this dispute as {pending}?
          </p>
          <button
            type="button"
            className="rounded-md bg-cyan-500 px-3 py-1.5 text-xs font-medium text-slate-950 disabled:opacity-60"
            disabled={decideMutation.isPending}
            onClick={confirmDecision}
          >
            {decideMutation.isPending ? "Deciding…" : `Confirm ${pending}`}
          </button>
          <button
            type="button"
            className="rounded-md border border-slate-600 px-3 py-1.5 text-xs font-medium text-slate-100 disabled:opacity-60"
            disabled={decideMutation.isPending}
            onClick={() => setPending(null)}
          >
            Cancel
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function RentalDisputePanel({
  onNotice,
}: {
  onNotice: (message: string) => void;
}) {
  const utils = trpc.useUtils();
  const sessionProfile = useSessionProfile();
  const isOperator = operatorRoles.has(sessionProfile.data?.role ?? "");
  const [contractId, setContractId] = useState("");
  const [reason, setReason] = useState<DisputeReason>("damage_charge");
  const [detail, setDetail] = useState("");

  const renterDisputes = trpc.rentalDispute.list.useQuery(
    { contractId },
    { enabled: !isOperator && isUuid(contractId), staleTime: 15_000 },
  );
  const openQueue = trpc.rentalDispute.list.useQuery(
    { status: "open", limit: 50 },
    { enabled: isOperator, staleTime: 15_000 },
  );
  const activeQuery = isOperator ? openQueue : renterDisputes;
  const disputes = useMemo(
    () => normalizeDisputes(activeQuery.data),
    [activeQuery.data],
  );

  const openMutation = trpc.rentalDispute.open.useMutation({
    onSuccess: async (disputeId) => {
      await utils.rentalDispute.list.invalidate();
      setDetail("");
      onNotice(`Dispute opened: ${disputeId}`);
    },
    onError: (error) => onNotice(error.message),
  });

  const submitDispute = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = detail.trim();
    if (trimmed.length < 10 || trimmed.length > 2000) {
      onNotice("Describe the dispute in 10 to 2000 characters.");
      return;
    }
    openMutation.mutate({
      contractId,
      reason,
      detail: trimmed,
      idempotencyKey: idempotency("rental-dispute"),
    });
  };

  return (
    <section className="space-y-5" aria-labelledby="rental-dispute-heading">
      <div className="border-b border-slate-800 pb-4">
        <div className="flex items-center gap-2 text-sm font-medium uppercase tracking-[0.18em] text-cyan-300">
          <Scale className="h-4 w-4" /> Settlement disputes
        </div>
        <h2
          id="rental-dispute-heading"
          className="mt-2 text-xl font-semibold text-white"
        >
          Dispute a return settlement
        </h2>
        <p className="mt-2 max-w-4xl text-sm leading-6 text-slate-400">
          Renters can contest settlement charges once, per issue; operators
          review the open queue and uphold, reject, or adjust each dispute.
          Decisions are recorded server-side with the deciding operator and an
          audit note.
        </p>
      </div>

      {isOperator ? (
        <Card>
          <CardHeader>
            <CardTitle>Open dispute queue</CardTitle>
            <CardDescription>
              Disputes awaiting an operator decision. Each decision requires an
              inline confirmation; adjustments carry a minor-unit amount and an
              optional operator note.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {openQueue.isFetching ? (
              <div className="flex items-center gap-2 py-6 text-sm text-slate-400">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading disputes…
              </div>
            ) : null}
            {openQueue.isError ? (
              <p className="py-4 text-sm text-rose-300">
                {openQueue.error?.message}
              </p>
            ) : null}
            {!openQueue.isFetching && !openQueue.isError && !disputes.length ? (
              <p className="py-4 text-sm text-slate-400">
                No open settlement disputes.
              </p>
            ) : null}
            {disputes.map((dispute) => (
              <OperatorDisputeCard
                key={dispute.id}
                dispute={dispute}
                onNotice={onNotice}
                onDecided={() => void utils.rentalDispute.list.invalidate()}
              />
            ))}
          </CardContent>
        </Card>
      ) : (
        <section className="grid gap-5 xl:grid-cols-[1.45fr_1fr]">
          <Card>
            <CardHeader>
              <CardTitle>Your disputes</CardTitle>
              <CardDescription>
                Enter the contract UUID to list the disputes opened against its
                settlement.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <input
                className={inputClass}
                placeholder="Contract UUID"
                value={contractId}
                onChange={(event) => setContractId(event.target.value)}
              />
              {renterDisputes.isFetching ? (
                <div className="flex items-center gap-2 py-6 text-sm text-slate-400">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading disputes…
                </div>
              ) : null}
              {renterDisputes.isError ? (
                <p className="py-4 text-sm text-rose-300">
                  {renterDisputes.error?.message}
                </p>
              ) : null}
              {isUuid(contractId) &&
              !renterDisputes.isFetching &&
              !renterDisputes.isError &&
              !disputes.length ? (
                <p className="py-4 text-sm text-slate-400">
                  No disputes have been opened for this contract yet.
                </p>
              ) : null}
              {disputes.map((dispute) => (
                <DisputeRow key={dispute.id} dispute={dispute} />
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Dispute this settlement</CardTitle>
              <CardDescription>
                Choose the charge you are contesting and describe the issue in
                at least 10 characters. Replaying the same submission is a
                no-op via the idempotency key.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form className="space-y-3" onSubmit={submitDispute}>
                <select
                  className={inputClass}
                  value={reason}
                  onChange={(event) =>
                    setReason(event.target.value as DisputeReason)
                  }
                >
                  {DISPUTE_REASONS.map((entry) => (
                    <option key={entry.value} value={entry.value}>
                      {entry.label}
                    </option>
                  ))}
                </select>
                <textarea
                  className={inputClass}
                  placeholder="Describe the dispute (minimum 10 characters)"
                  minLength={10}
                  maxLength={2000}
                  rows={4}
                  value={detail}
                  onChange={(event) => setDetail(event.target.value)}
                  required
                />
                <p className="text-xs text-slate-500">
                  {detail.trim().length}/2000 characters
                  {detail.trim().length < 10
                    ? " — at least 10 characters are required"
                    : ""}
                </p>
                <button
                  className="rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 disabled:opacity-60"
                  type="submit"
                  disabled={openMutation.isPending || !isUuid(contractId)}
                >
                  {openMutation.isPending ? "Opening…" : "Open dispute"}
                </button>
              </form>
            </CardContent>
          </Card>
        </section>
      )}
    </section>
  );
}
