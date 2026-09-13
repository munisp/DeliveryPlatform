import { FormEvent, useMemo, useState } from "react";
import { Link } from "wouter";
import {
  BadgeDollarSign,
  Car,
  CircleAlert,
  ClipboardList,
  Handshake,
  KeyRound,
  ShieldCheck,
  Wallet,
} from "lucide-react";

import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";

type TabKey = "earnings" | "settlements" | "rental" | "offers";

const tabs: Array<{ key: TabKey; label: string; icon: typeof Wallet }> = [
  { key: "earnings", label: "Earnings", icon: Wallet },
  { key: "settlements", label: "Settlements", icon: BadgeDollarSign },
  { key: "rental", label: "Vehicle rental", icon: Car },
  { key: "offers", label: "Offers", icon: ClipboardList },
];

const declineReasons = [
  ["pickup_distance_unprofitable", "Pickup distance is not viable"],
  ["pickup_time_unprofitable", "Pickup time is not viable"],
  ["fare_insufficient", "Expected net earnings are insufficient"],
  ["destination_unsuitable", "Destination is unsuitable"],
  ["safety_preference", "Safety preference"],
  ["vehicle_constraint", "Vehicle constraint"],
  ["other", "Other"],
] as const;

const contractActions = [
  ["handover", "Confirm handover (start rental)"],
  ["begin_return", "Begin return"],
  ["cancel", "Cancel request"],
  ["close", "Close contract"],
] as const;

function minor(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-NG", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(amount / 100);
  } catch {
    return `${(amount / 100).toFixed(2)} ${currency}`;
  }
}

function major(amount: unknown) {
  const value = Number(amount ?? 0);
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function isUnlinkedError(message?: string) {
  return Boolean(message && message.includes("no_driver_profile_linked"));
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex gap-3 border border-slate-700 bg-slate-900/60 p-4 text-sm text-slate-300">
      <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-slate-400" />
      <div>
        <p className="font-medium text-slate-100">{title}</p>
        <p className="mt-1 leading-6 text-slate-400">{body}</p>
      </div>
    </div>
  );
}

function ErrorState({ message }: { message?: string }) {
  return (
    <div className="flex gap-3 border border-rose-500/30 bg-rose-500/5 p-4 text-sm text-rose-100">
      <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-rose-300" />
      <p>Live data could not be loaded: {message ?? "unknown error"}</p>
    </div>
  );
}

function EarningsTab() {
  const profile = trpc.selfserve.myMarketplaceProfile.useQuery(undefined, {
    retry: false,
  });
  const performance = trpc.selfserve.myPerformance.useQuery(undefined, {
    retry: false,
  });
  const incentives = trpc.selfserve.myIncentives.useQuery(undefined, {
    retry: false,
  });

  if (isUnlinkedError(profile.error?.message)) {
    return (
      <EmptyState
        title="No courier profile is linked to this account"
        body="Earnings data is only available once your sign-in identity is linked to a courier record (by open id or email). Contact support to complete linking; nothing is fabricated in the meantime."
      />
    );
  }
  if (profile.error) return <ErrorState message={profile.error.message} />;

  const row = profile.data as Record<string, unknown> | null;
  const perf = performance.data as Record<string, unknown> | null;
  const incentiveRows = (incentives.data ?? []) as Array<
    Record<string, unknown>
  >;

  return (
    <div className="space-y-6">
      {!row ? (
        <EmptyState
          title="No earnings recorded yet"
          body="Your 30-day earnings, tier and job statistics appear here once you complete deliveries."
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-4">
          <Card className="border-slate-800 bg-slate-950/60">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-slate-400">
                30-day payout
              </CardTitle>
            </CardHeader>
            <CardContent className="text-3xl font-semibold text-slate-50">
              {major(row.driver_payout)}
            </CardContent>
          </Card>
          <Card className="border-slate-800 bg-slate-950/60">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-slate-400">
                Delivered jobs (30d)
              </CardTitle>
            </CardHeader>
            <CardContent className="text-3xl font-semibold text-slate-50">
              {major(row.delivered_jobs)}
            </CardContent>
          </Card>
          <Card className="border-slate-800 bg-slate-950/60">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-slate-400">Tier</CardTitle>
            </CardHeader>
            <CardContent className="text-3xl font-semibold capitalize text-slate-50">
              {String(row.tier ?? "bronze")}
            </CardContent>
          </Card>
          <Card className="border-slate-800 bg-slate-950/60">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-slate-400">
                Performance score
              </CardTitle>
            </CardHeader>
            <CardContent className="text-3xl font-semibold text-slate-50">
              {perf ? major(perf.score) : "—"}
            </CardContent>
          </Card>
        </div>
      )}

      <Card className="border-slate-800 bg-slate-950/60">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base text-slate-100">
            <Wallet className="h-5 w-5 text-cyan-300" />
            Incentives
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {incentives.error ? (
            <ErrorState message={incentives.error.message} />
          ) : incentiveRows.length === 0 ? (
            <p className="text-sm text-slate-400">
              No incentives earned yet. Incentives appear here as they are
              earned, then move through approval into a settlement.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="py-2 pr-4">Type</th>
                    <th className="py-2 pr-4">Description</th>
                    <th className="py-2 pr-4">Amount</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 pr-4">Earned</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800 text-slate-200">
                  {incentiveRows.map((incentive) => (
                    <tr key={String(incentive.id)}>
                      <td className="py-2 pr-4 capitalize">
                        {String(incentive.incentive_type ?? "").replaceAll(
                          "_",
                          " ",
                        )}
                      </td>
                      <td className="py-2 pr-4 text-slate-400">
                        {String(incentive.description ?? "—")}
                      </td>
                      <td className="py-2 pr-4">{major(incentive.amount)}</td>
                      <td className="py-2 pr-4">
                        <Badge
                          variant={
                            incentive.status === "approved"
                              ? "default"
                              : "secondary"
                          }
                        >
                          {String(incentive.status ?? "pending")}
                        </Badge>
                      </td>
                      <td className="py-2 pr-4 text-slate-400">
                        {incentive.earned_at
                          ? new Date(
                              String(incentive.earned_at),
                            ).toLocaleDateString()
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SettlementsTab() {
  const settlements = trpc.selfserve.mySettlements.useQuery(undefined, {
    retry: false,
  });

  if (isUnlinkedError(settlements.error?.message)) {
    return (
      <EmptyState
        title="No courier profile is linked to this account"
        body="Settlements are only available once your sign-in identity is linked to a courier record."
      />
    );
  }
  if (settlements.error)
    return <ErrorState message={settlements.error.message} />;

  const rows = (settlements.data ?? []) as Array<Record<string, unknown>>;
  const totals = rows.reduce<{ total: number; paid: number }>(
    (acc, row) => {
      acc.total += Number(row.total_amount ?? 0);
      if (row.status === "completed") acc.paid += Number(row.total_amount ?? 0);
      return acc;
    },
    { total: 0, paid: 0 },
  );

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-3">
        <Card className="border-slate-800 bg-slate-950/60">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-slate-400">
              Settlement periods
            </CardTitle>
          </CardHeader>
          <CardContent className="text-3xl font-semibold text-slate-50">
            {rows.length}
          </CardContent>
        </Card>
        <Card className="border-slate-800 bg-slate-950/60">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-slate-400">
              Total settled
            </CardTitle>
          </CardHeader>
          <CardContent className="text-3xl font-semibold text-slate-50">
            {major(totals.total)}
          </CardContent>
        </Card>
        <Card className="border-slate-800 bg-slate-950/60">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-slate-400">Paid out</CardTitle>
          </CardHeader>
          <CardContent className="text-3xl font-semibold text-slate-50">
            {major(totals.paid)}
          </CardContent>
        </Card>
      </div>

      <Card className="border-slate-800 bg-slate-950/60">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base text-slate-100">
            <BadgeDollarSign className="h-5 w-5 text-cyan-300" />
            Settlement history
          </CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-sm text-slate-400">
              No settlement periods yet. Approved incentives are batched into a
              settlement at the end of each payout period.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="py-2 pr-4">Period</th>
                    <th className="py-2 pr-4">Base</th>
                    <th className="py-2 pr-4">Bonus</th>
                    <th className="py-2 pr-4">Total</th>
                    <th className="py-2 pr-4">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800 text-slate-200">
                  {rows.map((row) => (
                    <tr key={String(row.id)}>
                      <td className="py-2 pr-4 text-slate-400">
                        {new Date(String(row.period_start)).toLocaleDateString()}{" "}
                        –{" "}
                        {new Date(String(row.period_end)).toLocaleDateString()}
                      </td>
                      <td className="py-2 pr-4">{major(row.base_earnings)}</td>
                      <td className="py-2 pr-4">{major(row.bonus_amount)}</td>
                      <td className="py-2 pr-4 font-medium text-slate-50">
                        {major(row.total_amount)}
                      </td>
                      <td className="py-2 pr-4">
                        <Badge
                          variant={
                            row.status === "completed"
                              ? "default"
                              : row.status === "pending"
                                ? "secondary"
                                : "outline"
                          }
                        >
                          {String(row.status ?? "pending")}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function RentalRequestForm({
  offerId,
  currency,
  onDone,
}: {
  offerId: string;
  currency: string;
  onDone: () => void;
}) {
  const utils = trpc.useUtils();
  const addOns = trpc.selfserve.myRentalAddOns.useQuery(
    { offerId },
    { retry: false },
  );
  const request = trpc.selfserve.requestRental.useMutation({
    onSuccess: () => {
      utils.selfserve.myVehicleContracts.invalidate();
      onDone();
    },
  });
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [quantities, setQuantities] = useState<Record<string, number>>({});

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const start = new Date(startsAt);
    const end = new Date(endsAt);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return;
    request.mutate({
      offerId,
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      addOns: Object.entries(quantities)
        .filter(([, quantity]) => quantity > 0)
        .map(([addOnVersionId, quantity]) => ({ addOnVersionId, quantity })),
      idempotencyKey: `courier-rental-${offerId.slice(0, 8)}-${Date.now()}`,
    });
  };

  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-md border border-slate-700 bg-slate-900/60 p-4"
    >
      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-xs uppercase tracking-wide text-slate-500">
          Rental starts
          <input
            type="datetime-local"
            value={startsAt}
            onChange={(event) => setStartsAt(event.target.value)}
            className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
            required
          />
        </label>
        <label className="text-xs uppercase tracking-wide text-slate-500">
          Rental ends
          <input
            type="datetime-local"
            value={endsAt}
            onChange={(event) => setEndsAt(event.target.value)}
            className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
            required
          />
        </label>
      </div>
      {(addOns.data ?? []).length > 0 && (
        <div className="space-y-2">
          <p className="text-xs uppercase tracking-wide text-slate-500">
            Optional add-ons
          </p>
          {(addOns.data ?? []).map((addOn) => (
            <label
              key={addOn.id}
              className="flex items-center justify-between gap-3 text-sm text-slate-300"
            >
              <span>
                {addOn.displayName}{" "}
                <span className="text-slate-500">
                  ({minor(addOn.unitPriceMinor, currency)} {addOn.chargeUnit},
                  max {addOn.maxQuantity})
                </span>
              </span>
              <input
                inputMode="numeric"
                min={0}
                max={addOn.maxQuantity}
                value={quantities[addOn.id] ?? 0}
                onChange={(event) =>
                  setQuantities({
                    ...quantities,
                    [addOn.id]: Math.max(
                      0,
                      Math.min(
                        addOn.maxQuantity,
                        Number(event.target.value) || 0,
                      ),
                    ),
                  })
                }
                className="w-16 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-100"
              />
            </label>
          ))}
        </div>
      )}
      {request.error && <ErrorState message={request.error.message} />}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={request.isPending}
          className="rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-cyan-400 disabled:opacity-50"
        >
          {request.isPending ? "Requesting…" : "Submit rental request"}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="rounded-md border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:border-slate-500"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function VehicleRentalTab() {
  const utils = trpc.useUtils();
  const offers = trpc.selfserve.myVehicleOffers.useQuery(undefined, {
    retry: false,
  });
  const contracts = trpc.selfserve.myVehicleContracts.useQuery(undefined, {
    retry: false,
  });
  const charges = trpc.selfserve.myRentalCharges.useQuery(undefined, {
    retry: false,
  });
  const transition = trpc.selfserve.transitionRentalContract.useMutation({
    onSuccess: () => {
      utils.selfserve.myVehicleContracts.invalidate();
      utils.selfserve.myRentalCharges.invalidate();
    },
  });
  const [requestingOffer, setRequestingOffer] = useState<string | null>(null);
  const [actionByContract, setActionByContract] = useState<
    Record<string, string>
  >({});

  const contractRows = contracts.data ?? [];
  const chargeRows = charges.data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex gap-3 border border-cyan-400/30 bg-cyan-400/5 p-4 text-sm text-cyan-50">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-cyan-300" />
        <p>
          Rental contracts are database-authoritative: requests, handovers and
          returns are validated by the vehicle-access service functions, and
          every charge below is written to the rental charge ledger when your
          contract activates.
        </p>
      </div>

      <Card className="border-slate-800 bg-slate-950/60">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base text-slate-100">
            <Car className="h-5 w-5 text-cyan-300" />
            Open rental offers
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {offers.error ? (
            <ErrorState message={offers.error.message} />
          ) : (offers.data ?? []).length === 0 ? (
            <p className="text-sm text-slate-400">
              No vehicles are on offer right now. Offers appear here when fleet
              providers publish available vehicles.
            </p>
          ) : (
            (offers.data ?? []).map((offer) => (
              <div
                key={offer.id}
                className="space-y-3 rounded-md border border-slate-800 p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="font-medium text-slate-100">
                      {offer.make} {offer.model} ({offer.manufactureYear})
                    </p>
                    <p className="text-sm text-slate-400">
                      {minor(offer.weeklyPriceMinor, offer.currency)} / week ·
                      deposit {minor(offer.depositMinor, offer.currency)} ·{" "}
                      {offer.includedKmPerWeek.toLocaleString()} km included ·
                      min {offer.minimumDays} days
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setRequestingOffer(
                        requestingOffer === offer.id ? null : offer.id,
                      )
                    }
                    className="rounded-md border border-cyan-400/40 px-4 py-2 text-sm font-medium text-cyan-200 hover:bg-cyan-400/10"
                  >
                    {requestingOffer === offer.id
                      ? "Hide request form"
                      : "Request this vehicle"}
                  </button>
                </div>
                {requestingOffer === offer.id && (
                  <RentalRequestForm
                    offerId={offer.id}
                    currency={offer.currency}
                    onDone={() => setRequestingOffer(null)}
                  />
                )}
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card className="border-slate-800 bg-slate-950/60">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base text-slate-100">
            <KeyRound className="h-5 w-5 text-cyan-300" />
            My rental contracts
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {contracts.error ? (
            <ErrorState message={contracts.error.message} />
          ) : contractRows.length === 0 ? (
            <p className="text-sm text-slate-400">
              You have no rental contracts yet. Request a vehicle from an open
              offer above to start one.
            </p>
          ) : (
            contractRows.map((contract) => (
              <div
                key={contract.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-slate-800 p-4"
              >
                <div>
                  <p className="font-mono text-sm text-slate-100">
                    {contract.publicReference}
                  </p>
                  <p className="text-sm text-slate-400">
                    {new Date(contract.startsAt).toLocaleDateString()} –{" "}
                    {new Date(contract.endsAt).toLocaleDateString()}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <Badge
                    variant={
                      contract.state === "active"
                        ? "default"
                        : contract.state === "requested" ||
                            contract.state === "approved"
                          ? "secondary"
                          : "outline"
                    }
                  >
                    {contract.state}
                  </Badge>
                  <select
                    value={actionByContract[contract.id] ?? ""}
                    onChange={(event) =>
                      setActionByContract({
                        ...actionByContract,
                        [contract.id]: event.target.value,
                      })
                    }
                    className="rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-sm text-slate-100"
                  >
                    <option value="">Choose action…</option>
                    {contractActions.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={
                      !actionByContract[contract.id] || transition.isPending
                    }
                    onClick={() =>
                      transition.mutate({
                        contractId: contract.id,
                        action: actionByContract[
                          contract.id
                        ] as (typeof contractActions)[number][0],
                        idempotencyKey: `courier-transition-${contract.publicReference}-${Date.now()}`,
                      })
                    }
                    className="rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:border-slate-500 disabled:opacity-40"
                  >
                    Apply
                  </button>
                </div>
              </div>
            ))
          )}
          {transition.error && (
            <ErrorState message={transition.error.message} />
          )}
        </CardContent>
      </Card>

      <Card className="border-slate-800 bg-slate-950/60">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base text-slate-100">
            <BadgeDollarSign className="h-5 w-5 text-cyan-300" />
            Rental charges
          </CardTitle>
        </CardHeader>
        <CardContent>
          {charges.error ? (
            <ErrorState message={charges.error.message} />
          ) : chargeRows.length === 0 ? (
            <p className="text-sm text-slate-400">
              No rental charges yet. A pending activation charge is written
              here, with its ledger reference, when a contract becomes active.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="py-2 pr-4">Charge</th>
                    <th className="py-2 pr-4">Amount</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 pr-4">Ledger reference</th>
                    <th className="py-2 pr-4">Created</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800 text-slate-200">
                  {chargeRows.map((charge) => (
                    <tr key={charge.id}>
                      <td className="py-2 pr-4 capitalize">
                        {charge.chargeType.replaceAll("_", " ")}
                      </td>
                      <td className="py-2 pr-4">
                        {minor(charge.amountMinor, charge.currency)}
                      </td>
                      <td className="py-2 pr-4">
                        <Badge
                          variant={
                            charge.status === "paid"
                              ? "default"
                              : charge.status === "pending"
                                ? "secondary"
                                : "outline"
                          }
                        >
                          {charge.status}
                        </Badge>
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs text-slate-400">
                        {charge.ledgerReference}
                      </td>
                      <td className="py-2 pr-4 text-slate-400">
                        {new Date(charge.createdAt).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function OffersTab() {
  const utils = trpc.useUtils();
  const offers = trpc.selfserve.myFairnessOffers.useQuery(undefined, {
    retry: false,
  });
  const decline = trpc.selfserve.declineOffer.useMutation({
    onSuccess: () => utils.selfserve.myFairnessOffers.invalidate(),
  });
  const [reasonByOffer, setReasonByOffer] = useState<Record<string, string>>(
    {},
  );

  const offerRows = offers.data ?? [];
  const summary = useMemo(
    () => ({
      count: offerRows.length,
      net: offerRows.reduce(
        (total, offer) => total + offer.expectedDriverNetKobo,
        0,
      ),
    }),
    [offerRows],
  );

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="border-slate-800 bg-slate-950/60">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-slate-400">
              Live dispatch offers
            </CardTitle>
          </CardHeader>
          <CardContent className="text-3xl font-semibold text-slate-50">
            {summary.count}
          </CardContent>
        </Card>
        <Card className="border-slate-800 bg-slate-950/60">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-slate-400">
              Expected proceeds across offers
            </CardTitle>
          </CardHeader>
          <CardContent className="text-3xl font-semibold text-slate-50">
            {minor(summary.net, "NGN")}
          </CardContent>
        </Card>
      </div>

      <Card className="border-slate-800 bg-slate-950/60">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base text-slate-100">
            <Handshake className="h-5 w-5 text-cyan-300" />
            Transparent dispatch offers
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {offers.error ? (
            <ErrorState message={offers.error.message} />
          ) : offerRows.length === 0 ? (
            <p className="text-sm text-slate-400">
              No dispatch offers right now. When dispatch offers you a trip,
              the full fare breakdown appears here before you commit.
            </p>
          ) : (
            offerRows.map((offer) => (
              <div
                key={offer.offerId}
                className="space-y-3 rounded-md border border-slate-800 p-4"
              >
                <div className="flex flex-wrap justify-between gap-3">
                  <div>
                    <p className="text-sm text-slate-400">
                      Pickup {offer.pickupDistanceM.toLocaleString()} m · ETA{" "}
                      {Math.round(offer.pickupEtaS / 60)} min · expires{" "}
                      {new Date(offer.expiresAt).toLocaleTimeString()}
                    </p>
                    <p className="font-medium text-slate-100">
                      {offer.destinationAddress}
                    </p>
                    <p className="text-sm text-slate-400">
                      {(offer.destinationDistanceM / 1000).toFixed(1)} km ·{" "}
                      {Math.round(offer.destinationDurationS / 60)} min trip
                    </p>
                  </div>
                  <div className="text-right text-sm">
                    <p className="text-slate-400">
                      Gross {minor(offer.grossFareKobo, "NGN")} · commission{" "}
                      {(offer.platformCommissionBp / 100).toFixed(2)}%
                    </p>
                    <p className="text-lg font-semibold text-slate-50">
                      Expected net {minor(offer.expectedDriverNetKobo, "NGN")}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <select
                    value={reasonByOffer[offer.offerId] ?? ""}
                    onChange={(event) =>
                      setReasonByOffer({
                        ...reasonByOffer,
                        [offer.offerId]: event.target.value,
                      })
                    }
                    className="rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-sm text-slate-100"
                  >
                    <option value="">Decline reason…</option>
                    {declineReasons.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={
                      !reasonByOffer[offer.offerId] || decline.isPending
                    }
                    onClick={() =>
                      decline.mutate({
                        offerId: offer.offerId,
                        reason: reasonByOffer[
                          offer.offerId
                        ] as (typeof declineReasons)[number][0],
                        idempotencyKey: `courier-decline-${offer.offerId.slice(0, 8)}-${Date.now()}`,
                      })
                    }
                    className="rounded-md border border-rose-500/40 px-4 py-2 text-sm text-rose-200 hover:bg-rose-500/10 disabled:opacity-40"
                  >
                    Decline offer
                  </button>
                </div>
              </div>
            ))
          )}
          {decline.error && <ErrorState message={decline.error.message} />}
        </CardContent>
      </Card>
    </div>
  );
}

export default function CourierPortal() {
  const [tab, setTab] = useState<TabKey>("earnings");
  const driverProfile = trpc.selfserve.myDriverProfile.useQuery(undefined, {
    retry: false,
  });

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="flex flex-col justify-between gap-4 border-b border-slate-800 pb-6 lg:flex-row lg:items-end">
          <div className="space-y-2">
            <p className="text-sm font-medium uppercase tracking-[0.18em] text-cyan-300">
              Courier self-serve
            </p>
            <h1 className="text-3xl font-semibold tracking-tight text-slate-50">
              Your earnings, settlements, rental and offers
            </h1>
            <p className="max-w-3xl text-sm leading-6 text-slate-400">
              Everything on this page is scoped to your own account: earnings
              and settlements resolve through your linked courier record, and
              rental contracts and dispatch offers are keyed to your sign-in
              identity.
            </p>
          </div>
          <Link
            href="/driver-offers"
            className="text-sm font-medium text-cyan-300 underline-offset-4 hover:underline"
          >
            Open full offer fairness console
          </Link>
        </div>

        {driverProfile.data ? (
          <div className="flex items-center gap-3 border border-slate-700 bg-slate-900/60 p-4 text-sm text-slate-300">
            <ShieldCheck className="h-5 w-5 shrink-0 text-cyan-300" />
            <p>
              Signed in as courier{" "}
              <span className="font-medium text-slate-100">
                {driverProfile.data.name}
              </span>{" "}
              (status {driverProfile.data.status}; account linked via{" "}
              {driverProfile.data.link === "open_id" ? "open id" : "email"}).
            </p>
          </div>
        ) : driverProfile.error ? (
          <div className="flex items-center gap-3 border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-100">
            <CircleAlert className="h-5 w-5 shrink-0 text-amber-300" />
            <p>
              {isUnlinkedError(driverProfile.error.message)
                ? "Your sign-in is not linked to a courier record yet, so earnings and settlements stay empty until linking is completed by support."
                : `Courier profile lookup failed: ${driverProfile.error.message}`}
            </p>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {tabs.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium ${
                tab === key
                  ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-100"
                  : "border-slate-700 text-slate-300 hover:border-slate-500"
              }`}
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          ))}
        </div>

        {tab === "earnings" && <EarningsTab />}
        {tab === "settlements" && <SettlementsTab />}
        {tab === "rental" && <VehicleRentalTab />}
        {tab === "offers" && <OffersTab />}
      </div>
    </DashboardLayout>
  );
}
