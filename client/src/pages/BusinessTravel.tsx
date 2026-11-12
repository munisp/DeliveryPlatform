import { useState } from "react";
import { Briefcase, PlusCircle, Receipt, ScrollText, Users } from "lucide-react";

import DashboardLayout from "@/components/DashboardLayout";
import { QueryErrorState } from "@/components/QueryState";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";

function money(amount: number) {
  return new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    maximumFractionDigits: 2,
  }).format(amount);
}

/** Integer minor units (kobo) -> major display string. */
function minorToMajor(minor: number) {
  return money(minor / 100);
}

/**
 * Exact major-string -> integer-minor parse (no float math on money):
 * accepts "12500" or "12500.50", rejects anything else.
 */
function majorToMinor(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, frac = ""] = trimmed.split(".");
  return Number(whole) * 100 + Number((frac + "00").slice(0, 2));
}

/** Idempotency keys per merchantSelfServe.ts:68 pattern. */
function newKey(prefix: string) {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  return `${prefix}-${random}`;
}

const APPROVAL_MODES = ["manager-review", "auto-with-cap", "care-coordinator"] as const;

const inputClass =
  "w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500";
const buttonClass =
  "rounded-md border border-cyan-500/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-200 hover:bg-cyan-500/20 disabled:opacity-50";
const dangerButtonClass =
  "rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-xs font-medium text-rose-200 hover:bg-rose-500/20 disabled:opacity-50";

export default function BusinessTravel() {
  const travel = trpc.mobility.businessTravel.useQuery();
  const myTrips = trpc.verticalOps.myTravelTrips.useQuery();
  const utils = trpc.useUtils();
  const data = travel.data;

  const [notice, setNotice] = useState<string | null>(null);
  const [accountForm, setAccountForm] = useState({
    companyName: "",
    billingEmail: "",
    approvalMode: "manager-review" as (typeof APPROVAL_MODES)[number],
    monthlyBudget: "",
  });
  const [tripForm, setTripForm] = useState({
    accountId: "",
    fare: "",
    costCenter: "",
    purpose: "",
  });
  const [opsTripId, setOpsTripId] = useState("");
  const [opsReason, setOpsReason] = useState("");

  const onWriteSuccess = async (message: string) => {
    setNotice(message);
    await Promise.all([
      utils.mobility.businessTravel.invalidate(),
      utils.verticalOps.myTravelTrips.invalidate(),
    ]);
  };
  const onWriteError = (error: { message: string }) => setNotice(error.message);

  const createAccount = trpc.verticalOps.createTravelAccount.useMutation({
    onSuccess: (result) =>
      void onWriteSuccess(
        `Travel account #${result.accountId} active${result.replayed ? " (replayed)" : ""}.`,
      ),
    onError: onWriteError,
  });
  const submitTrip = trpc.verticalOps.submitTravelTrip.useMutation({
    onSuccess: (result) =>
      void onWriteSuccess(
        `Trip #${result.tripId}: ${result.status}, expense ${result.expenseState}.`,
      ),
    onError: onWriteError,
  });
  const approveTrip = trpc.verticalOps.approveTravelTrip.useMutation({
    onSuccess: (result) => void onWriteSuccess(`Trip #${result.tripId} approved.`),
    onError: onWriteError,
  });
  const rejectTrip = trpc.verticalOps.rejectTravelTrip.useMutation({
    onSuccess: (result) => void onWriteSuccess(`Trip #${result.tripId} rejected.`),
    onError: onWriteError,
  });
  const reconcileExpense = trpc.verticalOps.reconcileTravelExpense.useMutation({
    onSuccess: (result) => void onWriteSuccess(`Trip #${result.tripId} expense reconciled.`),
    onError: onWriteError,
  });

  const busy =
    createAccount.isPending ||
    submitTrip.isPending ||
    approveTrip.isPending ||
    rejectTrip.isPending ||
    reconcileExpense.isPending;

  const submitAccount = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const budget =
      accountForm.monthlyBudget.trim() === "" ? undefined : majorToMinor(accountForm.monthlyBudget);
    if (budget === null) {
      setNotice("Monthly budget must be a non-negative amount with at most 2 decimals.");
      return;
    }
    createAccount.mutate({
      companyName: accountForm.companyName.trim(),
      billingEmail: accountForm.billingEmail.trim(),
      approvalMode: accountForm.approvalMode,
      monthlyBudgetMinor: budget,
      idempotencyKey: newKey("travel-account"),
    });
  };

  const submitNewTrip = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const accountId = Number(tripForm.accountId);
    const fareMinor = majorToMinor(tripForm.fare);
    if (!Number.isInteger(accountId) || accountId <= 0) {
      setNotice("Enter a numeric travel account id.");
      return;
    }
    if (fareMinor === null) {
      setNotice("Fare must be a non-negative amount with at most 2 decimals.");
      return;
    }
    submitTrip.mutate({
      accountId,
      fareMinor,
      costCenter: tripForm.costCenter.trim() || undefined,
      purpose: tripForm.purpose.trim() || undefined,
      idempotencyKey: newKey("travel-trip"),
    });
  };

  const opsTripIdNumber = Number(opsTripId);
  const opsTripIdValid = opsTripId.trim() !== "" && Number.isInteger(opsTripIdNumber) && opsTripIdNumber > 0;

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="space-y-2 border-b border-slate-800 pb-6">
          <p className="text-sm font-medium uppercase tracking-[0.18em] text-cyan-300">
            Enterprise travel
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-slate-50">
            Business travel programs
          </h1>
          <p className="max-w-3xl text-sm leading-6 text-slate-400">
            Enterprise accounts, traveler spend, and open expense items from
            the live business travel ledger.
          </p>
        </div>

        {travel.isLoading ? (
          <p className="text-sm text-slate-400">Loading business travel…</p>
        ) : null}
        {travel.isError ? (
          <QueryErrorState
            resource="business travel data"
            message={travel.error.message}
            onRetry={() => void travel.refetch()}
            retrying={travel.isRefetching}
          />
        ) : null}

        {notice ? (
          <p className="rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200">
            {notice}
          </p>
        ) : null}

        <Card className="border-slate-800 bg-slate-950/60">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base text-slate-100">
              <PlusCircle className="h-5 w-5 text-cyan-300" />
              Onboard travel account
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={submitAccount} className="grid gap-3 md:grid-cols-2">
              <input
                className={inputClass}
                placeholder="Company name"
                value={accountForm.companyName}
                onChange={(event) =>
                  setAccountForm((prev) => ({ ...prev, companyName: event.target.value }))
                }
              />
              <input
                className={inputClass}
                placeholder="Billing email"
                type="email"
                value={accountForm.billingEmail}
                onChange={(event) =>
                  setAccountForm((prev) => ({ ...prev, billingEmail: event.target.value }))
                }
              />
              <select
                className={inputClass}
                value={accountForm.approvalMode}
                onChange={(event) =>
                  setAccountForm((prev) => ({
                    ...prev,
                    approvalMode: event.target.value as (typeof APPROVAL_MODES)[number],
                  }))
                }
              >
                {APPROVAL_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode}
                  </option>
                ))}
              </select>
              <input
                className={inputClass}
                placeholder="Monthly budget (NGN, optional)"
                inputMode="decimal"
                value={accountForm.monthlyBudget}
                onChange={(event) =>
                  setAccountForm((prev) => ({ ...prev, monthlyBudget: event.target.value }))
                }
              />
              <div className="md:col-span-2">
                <button type="submit" className={buttonClass} disabled={busy}>
                  Create account
                </button>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card className="border-slate-800 bg-slate-950/60">
          <CardHeader>
            <CardTitle className="text-base text-slate-100">Book a business trip</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={submitNewTrip} className="grid gap-3 md:grid-cols-2">
              <input
                className={inputClass}
                placeholder="Travel account id"
                inputMode="numeric"
                value={tripForm.accountId}
                onChange={(event) =>
                  setTripForm((prev) => ({ ...prev, accountId: event.target.value }))
                }
              />
              <input
                className={inputClass}
                placeholder="Fare (NGN, e.g. 1250.00)"
                inputMode="decimal"
                value={tripForm.fare}
                onChange={(event) =>
                  setTripForm((prev) => ({ ...prev, fare: event.target.value }))
                }
              />
              <input
                className={inputClass}
                placeholder="Cost center (optional)"
                value={tripForm.costCenter}
                onChange={(event) =>
                  setTripForm((prev) => ({ ...prev, costCenter: event.target.value }))
                }
              />
              <input
                className={inputClass}
                placeholder="Purpose (optional)"
                value={tripForm.purpose}
                onChange={(event) =>
                  setTripForm((prev) => ({ ...prev, purpose: event.target.value }))
                }
              />
              <div className="md:col-span-2">
                <button type="submit" className={buttonClass} disabled={busy}>
                  Submit trip
                </button>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card className="border-slate-800 bg-slate-950/60">
          <CardHeader>
            <CardTitle className="text-base text-slate-100">My trips</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {myTrips.isLoading ? (
              <p className="text-sm text-slate-400">Loading your trips…</p>
            ) : myTrips.isError ? (
              <p className="text-sm text-slate-400">{myTrips.error.message}</p>
            ) : (myTrips.data?.trips.length ?? 0) === 0 ? (
              <p className="text-sm text-slate-400">
                You have not booked any business trips yet.
              </p>
            ) : (
              myTrips.data?.trips.map((trip) => (
                <div
                  key={trip.id}
                  className="flex flex-col justify-between gap-2 border-b border-slate-800 pb-3 last:border-0 md:flex-row md:items-center"
                >
                  <div>
                    <p className="font-medium text-slate-100">
                      #{trip.id} · {trip.companyName}
                    </p>
                    <p className="text-xs text-slate-500">
                      {trip.status} · expense {trip.expenseState}
                      {trip.costCenter ? ` · ${trip.costCenter}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-semibold text-slate-100">
                      {minorToMajor(trip.fareMinor)}
                    </span>
                    {trip.expenseState === "open" ? (
                      <button
                        type="button"
                        className={buttonClass}
                        disabled={busy}
                        onClick={() =>
                          submitTrip.mutate({
                            tripId: trip.id,
                            idempotencyKey: newKey("travel-submit"),
                          })
                        }
                      >
                        Submit expense
                      </button>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card className="border-slate-800 bg-slate-950/60">
          <CardHeader>
            <CardTitle className="text-base text-slate-100">
              Operator trip actions
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-slate-500">
              Approve or reject requested trips and reconcile submitted
              expenses by trip id. Operator role required.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                className="w-32 rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500"
                placeholder="Trip id"
                inputMode="numeric"
                value={opsTripId}
                onChange={(event) => setOpsTripId(event.target.value)}
              />
              <input
                className="w-56 rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500"
                placeholder="Reject reason (required to reject)"
                value={opsReason}
                onChange={(event) => setOpsReason(event.target.value)}
              />
              <button
                type="button"
                className={buttonClass}
                disabled={busy || !opsTripIdValid}
                onClick={() =>
                  approveTrip.mutate({
                    tripId: opsTripIdNumber,
                    idempotencyKey: newKey("travel-approve"),
                  })
                }
              >
                Approve
              </button>
              <button
                type="button"
                className={dangerButtonClass}
                disabled={busy || !opsTripIdValid || opsReason.trim().length === 0}
                onClick={() =>
                  rejectTrip.mutate({
                    tripId: opsTripIdNumber,
                    reason: opsReason.trim(),
                    idempotencyKey: newKey("travel-reject"),
                  })
                }
              >
                Reject
              </button>
              <button
                type="button"
                className={buttonClass}
                disabled={busy || !opsTripIdValid}
                onClick={() =>
                  reconcileExpense.mutate({
                    tripId: opsTripIdNumber,
                    idempotencyKey: newKey("travel-reconcile"),
                  })
                }
              >
                Reconcile expense
              </button>
            </div>
          </CardContent>
        </Card>

        {data ? (
          <>
            <div className="grid gap-4 md:grid-cols-4">
              {[
                ["Enterprise accounts", data.summary.enterprise_accounts],
                ["Active travelers", data.summary.active_travelers],
                ["Open expense items", data.summary.open_expense_items],
                ["Policy templates", data.summary.policy_templates],
              ].map(([label, value]) => (
                <Card
                  key={label}
                  className="border-slate-800 bg-slate-950/60"
                >
                  <CardHeader className="pb-2">
                    <CardTitle className="text-xs text-slate-400">
                      {label}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-2xl font-semibold text-slate-50">
                    {value}
                  </CardContent>
                </Card>
              ))}
            </div>

            <p className="text-sm text-slate-400">
              {data.summary.recommended_action}
            </p>

            <Card className="border-slate-800 bg-slate-950/60">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base text-slate-100">
                  <Briefcase className="h-5 w-5 text-cyan-300" />
                  Travel programs
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {data.travel_programs.length === 0 ? (
                  <p className="text-sm text-slate-400">
                    No enterprise travel accounts exist yet. Programs appear
                    here once a business travel account is created.
                  </p>
                ) : (
                  data.travel_programs.map((program) => (
                    <div
                      key={program.id}
                      className="flex flex-col justify-between gap-2 border-b border-slate-800 pb-3 last:border-0 md:flex-row md:items-center"
                    >
                      <div>
                        <p className="font-medium text-slate-100">
                          {program.name}
                        </p>
                        <p className="text-xs text-slate-500">
                          {program.service_mix}
                        </p>
                      </div>
                      <span className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-300">
                        {program.approval_mode}
                      </span>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            <Card className="border-slate-800 bg-slate-950/60">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base text-slate-100">
                  <Users className="h-5 w-5 text-emerald-300" />
                  Travelers
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {data.travelers.length === 0 ? (
                  <p className="text-sm text-slate-400">
                    No travelers have booked business trips yet. Spend and
                    compliance appear here once trips are recorded.
                  </p>
                ) : (
                  data.travelers.map((traveler) => (
                    <div
                      key={traveler.id}
                      className="flex flex-col justify-between gap-2 border-b border-slate-800 pb-3 last:border-0 md:flex-row md:items-center"
                    >
                      <div>
                        <p className="font-medium text-slate-100">
                          {traveler.name ?? traveler.email ?? `User ${traveler.id}`}
                        </p>
                        <p className="text-xs text-slate-500">
                          {traveler.role}
                          {traveler.email ? ` · ${traveler.email}` : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-4 text-sm">
                        <span className="text-slate-100">
                          {money(traveler.spend_ytd)} YTD
                        </span>
                        <span
                          className={
                            traveler.compliance_state === "review"
                              ? "text-amber-200"
                              : "text-emerald-200"
                          }
                        >
                          {traveler.compliance_state === "review"
                            ? "Review"
                            : "In policy"}
                        </span>
                      </div>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            <Card className="border-slate-800 bg-slate-950/60">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base text-slate-100">
                  <ScrollText className="h-5 w-5 text-amber-300" />
                  Policy templates
                </CardTitle>
              </CardHeader>
              <CardContent className="grid gap-2 md:grid-cols-2">
                {data.policy_templates.map((template) => (
                  <div
                    key={template}
                    className="flex items-center gap-2 rounded-md border border-slate-800 p-3 text-sm text-slate-300"
                  >
                    <Receipt className="h-4 w-4 shrink-0 text-slate-500" />
                    {template}
                  </div>
                ))}
              </CardContent>
            </Card>
          </>
        ) : null}
      </div>
    </DashboardLayout>
  );
}
