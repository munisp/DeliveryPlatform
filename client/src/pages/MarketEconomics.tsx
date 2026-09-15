import { FormEvent, useState } from "react";
import {
  CircleAlert,
  Fuel,
  Gavel,
  Landmark,
  Percent,
  Scale,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";

import DashboardLayout from "@/components/DashboardLayout";
import { formatMinor } from "@/components/FareBreakdown";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useSessionProfile } from "@/lib/sessionProfile";
import {
  useCheckFareAgainstFloor,
  useEconomicsSafetyInvalidation,
  useFareFloor,
  usePublishTakeRate,
  useRecordFloorOverride,
  useTakeRate,
  useUpdateCostIndex,
} from "@/lib/trpcEconomicsSafety";

const operationsRoles = new Set([
  "operator",
  "ops",
  "admin",
  "platform_admin",
  "super_admin",
]);

const inputClass =
  "rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100";

function FareFloorCard({ marketId }: { marketId: string }) {
  const floor = useFareFloor(marketId);
  const updateCostIndex = useUpdateCostIndex();
  const invalidation = useEconomicsSafetyInvalidation();
  const [form, setForm] = useState({
    fuelPriceMinor: "",
    cpiBp: "10000",
    maintenanceIndexBp: "10000",
    source: "",
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    updateCostIndex.mutate(
      {
        marketId,
        fuelPriceMinor: Number(form.fuelPriceMinor),
        cpiBp: Number(form.cpiBp),
        maintenanceIndexBp: Number(form.maintenanceIndexBp),
        source: form.source,
      },
      { onSuccess: () => invalidation.economics() },
    );
  };

  return (
    <Card className="border-slate-800 bg-slate-950/60">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base text-slate-100">
          <Fuel className="h-5 w-5 text-cyan-300" />
          Fare floor and cost index
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!marketId ? (
          <p className="text-sm text-slate-500">
            Enter a market ID above to load the fare floor.
          </p>
        ) : floor.isLoading ? (
          <p className="text-sm text-slate-400">Loading fare floor…</p>
        ) : floor.isError ? (
          <p className="text-sm text-amber-200">
            Fare floor unavailable — {floor.error?.message ?? "try again"}.
          </p>
        ) : floor.data === null || floor.data === undefined ? (
          <p className="text-sm text-slate-500">
            No fare floor has been published for this market yet.
          </p>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-4 md:grid-cols-3">
              <div>
                <p className="text-xs uppercase tracking-wide text-slate-500">
                  Fuel price index
                </p>
                <p className="mt-1 text-lg font-semibold text-slate-100">
                  {formatMinor(floor.data.costIndex.fuelPriceMinor)}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-slate-500">
                  CPI index
                </p>
                <p className="mt-1 text-lg font-semibold text-slate-100">
                  {(floor.data.costIndex.cpiBp / 100).toFixed(2)}%
                </p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-slate-500">
                  Maintenance index
                </p>
                <p className="mt-1 text-lg font-semibold text-slate-100">
                  {(floor.data.costIndex.maintenanceIndexBp / 100).toFixed(2)}%
                </p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-slate-500">
                  Sustainability multiplier
                </p>
                <p className="mt-1 text-lg font-semibold text-slate-100">
                  ×{floor.data.sustainabilityMultiplier.toFixed(3)}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-slate-500">
                  Status
                </p>
                <p
                  className={`mt-1 text-lg font-semibold ${floor.data.active ? "text-emerald-200" : "text-amber-200"}`}
                >
                  {floor.data.active ? "Active" : "Inactive"}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-slate-500">
                  Consultation
                </p>
                <p className="mt-1 font-mono text-sm text-slate-300">
                  {floor.data.consultationId ?? "—"}
                </p>
              </div>
            </div>
            <p className="text-xs text-slate-500">
              Source: {floor.data.costIndex.source} · updated{" "}
              {new Date(floor.data.costIndex.updatedAt).toLocaleString()}
            </p>
          </div>
        )}

        <form
          onSubmit={submit}
          className="grid gap-3 border-t border-slate-800 pt-4 md:grid-cols-2"
        >
          <p className="text-sm font-medium text-slate-200 md:col-span-2">
            Update cost index
          </p>
          <input
            inputMode="numeric"
            value={form.fuelPriceMinor}
            onChange={(event) =>
              setForm({ ...form, fuelPriceMinor: event.target.value })
            }
            placeholder="Fuel price (minor units)"
            className={inputClass}
            required
            disabled={!marketId}
          />
          <input
            value={form.source}
            onChange={(event) =>
              setForm({ ...form, source: event.target.value })
            }
            placeholder="Source (e.g. NBS fuel survey)"
            className={inputClass}
            required
            disabled={!marketId}
          />
          <input
            inputMode="numeric"
            value={form.cpiBp}
            onChange={(event) => setForm({ ...form, cpiBp: event.target.value })}
            placeholder="CPI basis points (10000 = 1.0×)"
            className={inputClass}
            required
            disabled={!marketId}
          />
          <input
            inputMode="numeric"
            value={form.maintenanceIndexBp}
            onChange={(event) =>
              setForm({ ...form, maintenanceIndexBp: event.target.value })
            }
            placeholder="Maintenance index basis points"
            className={inputClass}
            required
            disabled={!marketId}
          />
          <button
            type="submit"
            disabled={!marketId || updateCostIndex.isPending}
            className="rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-cyan-400 disabled:opacity-50 md:col-span-2 md:w-fit"
          >
            {updateCostIndex.isPending ? "Updating…" : "Update cost index"}
          </button>
          {updateCostIndex.isError ? (
            <p className="text-sm text-rose-200 md:col-span-2">
              {updateCostIndex.error?.message ?? "Cost index update failed."}
            </p>
          ) : null}
          {updateCostIndex.isSuccess ? (
            <p className="flex items-center gap-2 text-sm text-emerald-200 md:col-span-2">
              <ShieldCheck className="h-4 w-4" /> Cost index updated.
            </p>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}

function TakeRateCard({ marketId }: { marketId: string }) {
  const takeRate = useTakeRate(marketId);
  const publishTakeRate = usePublishTakeRate();
  const invalidation = useEconomicsSafetyInvalidation();
  const [form, setForm] = useState({
    rateBps: "1200",
    basis: "gross_fare",
    effectiveFrom: "",
    consultationId: "",
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const effectiveFrom = new Date(form.effectiveFrom);
    if (Number.isNaN(effectiveFrom.getTime())) return;
    publishTakeRate.mutate(
      {
        marketId,
        rateBps: Number(form.rateBps),
        basis: form.basis,
        effectiveFrom: effectiveFrom.toISOString(),
        consultationId: form.consultationId,
      },
      { onSuccess: () => invalidation.economics() },
    );
  };

  return (
    <Card className="border-slate-800 bg-slate-950/60">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base text-slate-100">
          <Percent className="h-5 w-5 text-cyan-300" />
          Take-rate registry
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!marketId ? (
          <p className="text-sm text-slate-500">
            Enter a market ID above to load the take rate.
          </p>
        ) : takeRate.isLoading ? (
          <p className="text-sm text-slate-400">Loading take rate…</p>
        ) : takeRate.isError ? (
          <p className="text-sm text-amber-200">
            Take rate unavailable — {takeRate.error?.message ?? "try again"}.
          </p>
        ) : takeRate.data === null || takeRate.data === undefined ? (
          <p className="text-sm text-slate-500">
            No take rate has been published for this market yet.
          </p>
        ) : (
          <div className="grid gap-4 md:grid-cols-4">
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500">
                Current rate
              </p>
              <p className="mt-1 text-lg font-semibold text-slate-100">
                {(takeRate.data.rateBps / 100).toFixed(2)}%
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500">
                Basis
              </p>
              <p className="mt-1 text-lg font-semibold text-slate-100">
                {takeRate.data.basis}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500">
                Version
              </p>
              <p className="mt-1 text-lg font-semibold text-slate-100">
                v{takeRate.data.version}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500">
                Effective from
              </p>
              <p className="mt-1 text-lg font-semibold text-slate-100">
                {new Date(takeRate.data.effectiveFrom).toLocaleDateString()}
              </p>
            </div>
          </div>
        )}

        <form
          onSubmit={submit}
          className="grid gap-3 border-t border-slate-800 pt-4 md:grid-cols-2"
        >
          <p className="text-sm font-medium text-slate-200 md:col-span-2">
            Publish new take rate
          </p>
          <p className="flex gap-2 text-xs leading-5 text-slate-400 md:col-span-2">
            <Landmark className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />
            Publishing requires the ID of an activated &quot;commission&quot;
            worker-council consultation — rate changes are co-governed, not
            unilateral.
          </p>
          <input
            inputMode="numeric"
            value={form.rateBps}
            onChange={(event) =>
              setForm({ ...form, rateBps: event.target.value })
            }
            placeholder="Rate in basis points (1200 = 12.00%)"
            className={inputClass}
            required
            disabled={!marketId}
          />
          <input
            value={form.basis}
            onChange={(event) => setForm({ ...form, basis: event.target.value })}
            placeholder="Basis (e.g. gross_fare)"
            className={inputClass}
            required
            disabled={!marketId}
          />
          <input
            type="datetime-local"
            value={form.effectiveFrom}
            onChange={(event) =>
              setForm({ ...form, effectiveFrom: event.target.value })
            }
            className={inputClass}
            required
            disabled={!marketId}
          />
          <input
            value={form.consultationId}
            onChange={(event) =>
              setForm({ ...form, consultationId: event.target.value })
            }
            placeholder="Activated commission consultation ID"
            className={inputClass}
            required
            disabled={!marketId}
          />
          <button
            type="submit"
            disabled={!marketId || publishTakeRate.isPending}
            className="rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-cyan-400 disabled:opacity-50 md:col-span-2 md:w-fit"
          >
            {publishTakeRate.isPending ? "Publishing…" : "Publish take rate"}
          </button>
          {publishTakeRate.isError ? (
            <p className="text-sm text-rose-200 md:col-span-2">
              {publishTakeRate.error?.message ?? "Take-rate publish failed."}
            </p>
          ) : null}
          {publishTakeRate.isSuccess ? (
            <p className="flex items-center gap-2 text-sm text-emerald-200 md:col-span-2">
              <ShieldCheck className="h-4 w-4" /> Take rate published.
            </p>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}

function FloorCheckCard({ marketId }: { marketId: string }) {
  const checkFare = useCheckFareAgainstFloor();
  const recordOverride = useRecordFloorOverride();
  const [fareInput, setFareInput] = useState("");
  const [overrideJustification, setOverrideJustification] = useState("");

  const runCheck = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    checkFare.mutate({ marketId, fareMinor: Number(fareInput) });
  };

  const settled = checkFare.data ?? null;

  const submitOverride = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    recordOverride.mutate({
      marketId,
      fareMinor: Number(fareInput),
      justification: overrideJustification,
    });
  };

  return (
    <Card className="border-slate-800 bg-slate-950/60">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base text-slate-100">
          <Scale className="h-5 w-5 text-cyan-300" />
          Fare floor check and override
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={runCheck} className="flex flex-wrap gap-3">
          <input
            inputMode="numeric"
            value={fareInput}
            onChange={(event) => setFareInput(event.target.value)}
            placeholder="Proposed fare (minor units, e.g. kobo)"
            className={inputClass}
            required
            disabled={!marketId}
          />
          <button
            type="submit"
            disabled={!marketId || checkFare.isPending}
            className="rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-cyan-400 disabled:opacity-50"
          >
            {checkFare.isPending ? "Checking…" : "Check against floor"}
          </button>
        </form>
        {checkFare.isError ? (
          <p className="text-sm text-rose-200">
            {checkFare.error?.message ?? "Floor check failed."}
          </p>
        ) : null}
        {settled ? (
          <div
            className={`space-y-2 rounded-md border p-4 text-sm ${
              settled.allowed
                ? "border-emerald-400/40 bg-emerald-500/5 text-emerald-100"
                : "border-amber-400/40 bg-amber-500/5 text-amber-100"
            }`}
          >
            <p className="flex items-center gap-2 font-semibold">
              {settled.allowed ? (
                <>
                  <ShieldCheck className="h-4 w-4" /> Fare allowed — meets the
                  floor of {formatMinor(settled.floorMinor)}.
                </>
              ) : (
                <>
                  <TriangleAlert className="h-4 w-4" /> Fare blocked — below the
                  floor of {formatMinor(settled.floorMinor)}.
                </>
              )}
            </p>
            {settled.requiresOverride ? (
              <p className="text-xs">
                This fare requires a recorded override to proceed.
              </p>
            ) : null}
          </div>
        ) : null}

        <form
          onSubmit={submitOverride}
          className="grid gap-3 border-t border-slate-800 pt-4"
        >
          <p className="text-sm font-medium text-slate-200">
            Record a floor override
          </p>
          <p className="flex gap-2 text-xs leading-5 text-amber-200">
            <Gavel className="mt-0.5 h-4 w-4 shrink-0" />
            Overrides are posted to the worker council record and are publicly
            auditable — provide a full operational justification.
          </p>
          <textarea
            value={overrideJustification}
            onChange={(event) =>
              setOverrideJustification(event.target.value)
            }
            placeholder="Justification for pricing below the sustainability floor"
            rows={3}
            className={inputClass}
            required
            disabled={!marketId || !fareInput}
          />
          <button
            type="submit"
            disabled={
              !marketId || !fareInput || recordOverride.isPending
            }
            className="rounded-md border border-amber-400/50 px-4 py-2 text-sm font-medium text-amber-100 hover:bg-amber-500/10 disabled:opacity-50 md:w-fit"
          >
            {recordOverride.isPending
              ? "Recording…"
              : "Record override (posts to council)"}
          </button>
          {recordOverride.isError ? (
            <p className="text-sm text-rose-200">
              {recordOverride.error?.message ?? "Override recording failed."}
            </p>
          ) : null}
          {recordOverride.isSuccess ? (
            <p className="flex items-center gap-2 text-sm text-emerald-200">
              <ShieldCheck className="h-4 w-4" /> Override recorded on the
              council record.
            </p>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}

export default function MarketEconomics() {
  const sessionProfile = useSessionProfile();
  const isOperator = Boolean(
    sessionProfile.data?.role && operationsRoles.has(sessionProfile.data.role),
  );
  const [marketId, setMarketId] = useState("");

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="space-y-2 border-b border-slate-800 pb-6">
          <p className="text-sm font-medium uppercase tracking-[0.18em] text-cyan-300">
            Market economics — fare floor, take rate, cost index
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-slate-50">
            Sustainable pricing governance
          </h1>
          <p className="max-w-3xl text-sm leading-6 text-slate-400">
            Maintain the cost index that drives the market fare floor, publish
            co-governed take-rate versions, and verify that proposed fares keep
            drivers above the sustainability floor.
          </p>
        </div>

        {isOperator ? (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <label
                htmlFor="market-id"
                className="text-sm font-medium text-slate-300"
              >
                Market
              </label>
              <input
                id="market-id"
                value={marketId}
                onChange={(event) => setMarketId(event.target.value)}
                placeholder="Market ID"
                className={`${inputClass} w-full max-w-md`}
              />
            </div>
            <FareFloorCard marketId={marketId} />
            <TakeRateCard marketId={marketId} />
            <FloorCheckCard marketId={marketId} />
          </>
        ) : (
          <div className="flex gap-3 border border-slate-700 bg-slate-900/60 p-4 text-sm text-slate-300">
            <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-slate-400" />
            <p className="leading-6 text-slate-400">
              Market economics controls are only visible to operations and
              administration roles. Server-side authorization is enforced
              independently of this view.
            </p>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
