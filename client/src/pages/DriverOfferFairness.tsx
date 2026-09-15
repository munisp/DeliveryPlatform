import { FormEvent, useMemo, useState } from "react";
import { Link } from "wouter";
import {
  BadgeDollarSign,
  CircleAlert,
  MapPinned,
  Route,
  ShieldCheck,
} from "lucide-react";

import DashboardLayout from "@/components/DashboardLayout";
import VerifiedRiderBadge from "@/components/VerifiedRiderBadge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";

const declineReasons = [
  ["pickup_distance_unprofitable", "Pickup distance is not viable"],
  ["pickup_time_unprofitable", "Pickup time is not viable"],
  ["fare_insufficient", "Expected net earnings are insufficient"],
  ["destination_unsuitable", "Destination is unsuitable"],
  ["safety_preference", "Safety preference"],
  ["vehicle_constraint", "Vehicle constraint"],
  ["other", "Other"],
] as const;

function kobo(amount: number) {
  return new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    maximumFractionDigits: 2,
  }).format(amount / 100);
}

function idempotencyKey(offerId: string) {
  return `driver-offer-decline-${offerId.slice(0, 20)}-${Date.now()}`;
}

export default function DriverOfferFairness() {
  const offers = trpc.driverDispatchFairness.listMyOffers.useQuery();
  const utils = trpc.useUtils();
  const [policy, setPolicy] = useState({
    zoneId: "",
    version: "fairness-v1",
    platformCommissionBp: "1200",
    maxPickupDistanceM: "3000",
    maxPickupEtaS: "600",
    effectiveFrom: "",
  });
  const [economicsPolicy, setEconomicsPolicy] = useState({
    zoneId: "",
    version: "economics-v1",
    driverTimeFloorKoboPerMin: "100",
    driverDistanceFloorKoboPerKm: "1000",
    fuelCostIndexBp: "10000",
    maintenanceCostIndexBp: "10000",
    pickupSubsidyKoboPerKm: "0",
    maxPickupSubsidyKobo: "0",
    platformVariableCostKobo: "0",
    platformContributionTargetKobo: "0",
    effectiveFrom: "",
  });
  const decline = trpc.driverDispatchFairness.declineOffer.useMutation({
    onSuccess: () => utils.driverDispatchFairness.listMyOffers.invalidate(),
  });
  const policyMutation = trpc.driverDispatchFairness.setPolicy.useMutation();
  const economicsPolicyMutation =
    trpc.driverDispatchFairness.setEconomicsPolicy.useMutation();
  const submitEconomicsPolicy = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const effectiveFrom = new Date(economicsPolicy.effectiveFrom);
    if (Number.isNaN(effectiveFrom.getTime())) return;
    economicsPolicyMutation.mutate({
      zoneId: economicsPolicy.zoneId,
      version: economicsPolicy.version,
      driverTimeFloorKoboPerMin: Number(
        economicsPolicy.driverTimeFloorKoboPerMin,
      ),
      driverDistanceFloorKoboPerKm: Number(
        economicsPolicy.driverDistanceFloorKoboPerKm,
      ),
      fuelCostIndexBp: Number(economicsPolicy.fuelCostIndexBp),
      maintenanceCostIndexBp: Number(economicsPolicy.maintenanceCostIndexBp),
      pickupSubsidyKoboPerKm: Number(economicsPolicy.pickupSubsidyKoboPerKm),
      maxPickupSubsidyKobo: Number(economicsPolicy.maxPickupSubsidyKobo),
      platformVariableCostKobo: Number(
        economicsPolicy.platformVariableCostKobo,
      ),
      platformContributionTargetKobo: Number(
        economicsPolicy.platformContributionTargetKobo,
      ),
      effectiveFrom: effectiveFrom.toISOString(),
    });
  };
  const submitPolicy = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const effectiveFrom = new Date(policy.effectiveFrom);
    if (Number.isNaN(effectiveFrom.getTime())) return;
    policyMutation.mutate({
      zoneId: policy.zoneId,
      version: policy.version,
      platformCommissionBp: Number(policy.platformCommissionBp),
      maxPickupDistanceM: Number(policy.maxPickupDistanceM),
      maxPickupEtaS: Number(policy.maxPickupEtaS),
      effectiveFrom: effectiveFrom.toISOString(),
    });
  };

  const summary = useMemo(() => {
    const all = offers.data ?? [];
    return {
      count: all.length,
      net: all.reduce((total, offer) => total + offer.expectedDriverNetKobo, 0),
      maxPickup: Math.max(0, ...all.map((offer) => offer.pickupDistanceM)),
    };
  }, [offers.data]);

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="flex flex-col justify-between gap-4 border-b border-slate-800 pb-6 lg:flex-row lg:items-end">
          <div className="space-y-2">
            <p className="text-sm font-medium uppercase tracking-[0.18em] text-cyan-300">
              Driver choice and earnings transparency
            </p>
            <h1 className="text-3xl font-semibold tracking-tight text-slate-50">
              Review the complete offer before committing
            </h1>
            <p className="max-w-3xl text-sm leading-6 text-slate-400">
              Each current offer shows pickup burden, destination, fare,
              platform commission, taxes and fees, and expected driver proceeds.
              A decline records its operational reason but does not
              automatically suspend your account or change eligibility.
            </p>
          </div>
          <Link
            href="/driver-mobility"
            className="text-sm font-medium text-cyan-300 underline-offset-4 hover:underline"
          >
            Return to driver mobility
          </Link>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <Card className="border-slate-800 bg-slate-950/60">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-slate-400">
                Live offers
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
              {kobo(summary.net)}
            </CardContent>
          </Card>
          <Card className="border-slate-800 bg-slate-950/60">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-slate-400">
                Longest offered pickup
              </CardTitle>
            </CardHeader>
            <CardContent className="text-3xl font-semibold text-slate-50">
              {summary.maxPickup.toLocaleString()} m
            </CardContent>
          </Card>
        </div>

        <div className="flex gap-3 border border-cyan-400/30 bg-cyan-400/5 p-4 text-sm text-cyan-50">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-cyan-300" />
          <p>
            The displayed expected proceeds are a pre-trip disclosure, not a
            settlement promise. Final payment remains verified, idempotent, and
            governed by the completed-trip and payment-authorization workflow.
          </p>
        </div>

        <Card className="border-slate-800 bg-slate-950/60">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base text-slate-100">
              <BadgeDollarSign className="h-5 w-5 text-cyan-300" />
              Operator policy control
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm leading-6 text-slate-400">
              Authorized operators can publish the next policy version. The
              database rejects commission above 15.00%, pickup distance above
              5,000 m, and pickup time above 1,200 seconds; active dispatch will
              fail closed rather than issue an opaque offer without an active
              policy.
            </p>
            <form onSubmit={submitPolicy} className="grid gap-3 md:grid-cols-3">
              <input
                value={policy.zoneId}
                onChange={(event) =>
                  setPolicy({ ...policy, zoneId: event.target.value })
                }
                placeholder="Service-zone UUID"
                className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                required
              />
              <input
                value={policy.version}
                onChange={(event) =>
                  setPolicy({ ...policy, version: event.target.value })
                }
                placeholder="Policy version"
                className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                required
              />
              <input
                type="datetime-local"
                value={policy.effectiveFrom}
                onChange={(event) =>
                  setPolicy({ ...policy, effectiveFrom: event.target.value })
                }
                className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                required
              />
              <input
                inputMode="numeric"
                value={policy.platformCommissionBp}
                onChange={(event) =>
                  setPolicy({
                    ...policy,
                    platformCommissionBp: event.target.value,
                  })
                }
                placeholder="Commission basis points"
                className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                required
              />
              <input
                inputMode="numeric"
                value={policy.maxPickupDistanceM}
                onChange={(event) =>
                  setPolicy({
                    ...policy,
                    maxPickupDistanceM: event.target.value,
                  })
                }
                placeholder="Maximum pickup metres"
                className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                required
              />
              <input
                inputMode="numeric"
                value={policy.maxPickupEtaS}
                onChange={(event) =>
                  setPolicy({
                    ...policy,
                    maxPickupEtaS: event.target.value,
                  })
                }
                placeholder="Maximum pickup seconds"
                className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                required
              />
              <div className="md:col-span-3">
                <button
                  type="submit"
                  disabled={policyMutation.isPending}
                  className="rounded-md bg-cyan-400 px-4 py-2 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {policyMutation.isPending
                    ? "Publishing…"
                    : "Publish fairness policy"}
                </button>
                {policyMutation.error ? (
                  <span className="ml-3 text-sm text-red-200">
                    {policyMutation.error.message}
                  </span>
                ) : null}
                {policyMutation.data ? (
                  <span className="ml-3 text-sm text-cyan-200">
                    Policy published: {policyMutation.data}
                  </span>
                ) : null}
              </div>
            </form>
          </CardContent>
        </Card>

        <Card className="border-slate-800 bg-slate-950/60">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base text-slate-100">
              <BadgeDollarSign className="h-5 w-5 text-emerald-300" />
              Driver floor and pickup-subsidy policy
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm leading-6 text-slate-400">
              Authorized operators publish a dated cost model. Dispatch fails
              closed when the disclosed driver floor or the platform
              contribution target cannot be met within the independent 15.00%
              commission cap. Fuel and maintenance indexes are approved policy
              inputs, not individual-driver scoring signals.
            </p>
            <form
              onSubmit={submitEconomicsPolicy}
              className="grid gap-3 md:grid-cols-3"
            >
              {[
                ["zoneId", "Service-zone UUID"],
                ["version", "Economics policy version"],
                [
                  "driverTimeFloorKoboPerMin",
                  "Driver floor kobo / active minute",
                ],
                [
                  "driverDistanceFloorKoboPerKm",
                  "Driver floor kobo / kilometre",
                ],
                ["fuelCostIndexBp", "Fuel cost index (10,000 = baseline)"],
                [
                  "maintenanceCostIndexBp",
                  "Maintenance index (10,000 = baseline)",
                ],
                ["pickupSubsidyKoboPerKm", "Pickup subsidy kobo / kilometre"],
                ["maxPickupSubsidyKobo", "Maximum pickup subsidy kobo"],
                ["platformVariableCostKobo", "Variable platform cost kobo"],
                ["platformContributionTargetKobo", "Contribution target kobo"],
              ].map(([field, placeholder]) => (
                <input
                  key={field}
                  value={economicsPolicy[field as keyof typeof economicsPolicy]}
                  onChange={(event) =>
                    setEconomicsPolicy({
                      ...economicsPolicy,
                      [field]: event.target.value,
                    })
                  }
                  placeholder={placeholder}
                  className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                  required
                />
              ))}
              <input
                type="datetime-local"
                value={economicsPolicy.effectiveFrom}
                onChange={(event) =>
                  setEconomicsPolicy({
                    ...economicsPolicy,
                    effectiveFrom: event.target.value,
                  })
                }
                className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                required
              />
              <div className="md:col-span-3">
                <button
                  type="submit"
                  disabled={economicsPolicyMutation.isPending}
                  className="rounded-md bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {economicsPolicyMutation.isPending
                    ? "Publishing…"
                    : "Publish economics policy"}
                </button>
                {economicsPolicyMutation.error ? (
                  <span className="ml-3 text-sm text-red-200">
                    {economicsPolicyMutation.error.message}
                  </span>
                ) : null}
                {economicsPolicyMutation.data ? (
                  <span className="ml-3 text-sm text-emerald-200">
                    Economics policy published: {economicsPolicyMutation.data}
                  </span>
                ) : null}
              </div>
            </form>
          </CardContent>
        </Card>

        {offers.isLoading ? (
          <p className="text-sm text-slate-400">Loading active offers…</p>
        ) : null}
        {offers.error ? (
          <p className="border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-100">
            {offers.error.message}
          </p>
        ) : null}
        {!offers.isLoading && !offers.error && summary.count === 0 ? (
          <Card className="border-slate-800 bg-slate-950/60">
            <CardContent className="p-6 text-sm text-slate-400">
              No active offer is awaiting your response.
            </CardContent>
          </Card>
        ) : null}

        <div className="space-y-5">
          {(offers.data ?? []).map((offer) => {
            const expiresIn = Math.max(
              0,
              Math.ceil(
                (new Date(offer.expiresAt).getTime() - Date.now()) / 1000,
              ),
            );
            return (
              <Card
                key={offer.offerId}
                className="border-slate-700 bg-slate-950/70"
              >
                <CardHeader className="border-b border-slate-800">
                  <div className="flex flex-col justify-between gap-3 md:flex-row md:items-center">
                    <div>
                      <CardTitle className="flex items-center gap-2 text-lg text-slate-50">
                        <Route className="h-5 w-5 text-cyan-300" />
                        Trip offer
                      </CardTitle>
                      <p className="mt-1 font-mono text-xs text-slate-500">
                        {offer.offerId}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <VerifiedRiderBadge offerId={offer.offerId} />
                      <div className="rounded-full border border-amber-400/40 px-3 py-1 text-sm text-amber-200">
                        Expires in {expiresIn}s
                      </div>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-5 p-5">
                  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
                    <div>
                      <p className="text-xs uppercase tracking-wide text-slate-500">
                        Pickup burden
                      </p>
                      <p className="mt-1 text-lg font-semibold text-slate-100">
                        {offer.pickupDistanceM.toLocaleString()} m ·{" "}
                        {Math.ceil(offer.pickupEtaS / 60)} min
                      </p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-wide text-slate-500">
                        Trip distance / duration
                      </p>
                      <p className="mt-1 text-lg font-semibold text-slate-100">
                        {(offer.destinationDistanceM / 1000).toFixed(1)} km ·{" "}
                        {Math.ceil(offer.destinationDurationS / 60)} min
                      </p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-wide text-slate-500">
                        Gross rider fare
                      </p>
                      <p className="mt-1 text-lg font-semibold text-slate-100">
                        {kobo(offer.grossFareKobo)}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-wide text-cyan-300">
                        Expected driver proceeds
                      </p>
                      <p className="mt-1 text-lg font-semibold text-cyan-200">
                        {kobo(offer.expectedDriverNetKobo)}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-wide text-emerald-300">
                        Published earnings floor
                      </p>
                      <p className="mt-1 text-lg font-semibold text-emerald-200">
                        {offer.driverEarningsFloorKobo === null
                          ? "Unavailable"
                          : kobo(offer.driverEarningsFloorKobo)}
                      </p>
                    </div>
                  </div>
                  <div className="grid gap-4 border-y border-slate-800 py-4 md:grid-cols-3">
                    <div>
                      <p className="text-xs uppercase tracking-wide text-slate-500">
                        Platform commission
                      </p>
                      <p className="mt-1 font-medium text-slate-100">
                        {(offer.platformCommissionBp / 100).toFixed(2)}% ·{" "}
                        {kobo(offer.platformCommissionKobo)}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-wide text-slate-500">
                        Taxes and fees
                      </p>
                      <p className="mt-1 font-medium text-slate-100">
                        {kobo(offer.taxesAndFeesKobo)}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-wide text-emerald-300">
                        Pickup subsidy
                      </p>
                      <p className="mt-1 font-medium text-emerald-200">
                        {offer.pickupSubsidyKobo === null
                          ? "Not allocated"
                          : kobo(offer.pickupSubsidyKobo)}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-wide text-slate-500">
                        Disclosure policy
                      </p>
                      <p className="mt-1 font-medium text-slate-100">
                        {offer.disclosureVersion}
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-2 text-sm text-slate-200">
                    <MapPinned className="h-5 w-5 shrink-0 text-cyan-300" />
                    <div>
                      <p className="font-medium">
                        Destination before acceptance
                      </p>
                      <p className="text-slate-400">
                        {offer.destinationAddress}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-col justify-between gap-4 border-t border-slate-800 pt-4 lg:flex-row lg:items-center">
                    <p className="flex max-w-xl gap-2 text-xs leading-5 text-slate-500">
                      <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                      Selecting a reason records feedback for fairness review.
                      This action does not suspend the driver, lower a rating,
                      or directly alter driver eligibility.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {declineReasons.map(([reason, label]) => (
                        <button
                          key={reason}
                          type="button"
                          disabled={decline.isPending}
                          onClick={() =>
                            decline.mutate({
                              offerId: offer.offerId,
                              reason,
                              idempotencyKey: idempotencyKey(offer.offerId),
                            })
                          }
                          className="rounded-md border border-slate-700 px-3 py-2 text-xs font-medium text-slate-200 hover:border-cyan-300 hover:text-cyan-100 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>
    </DashboardLayout>
  );
}
