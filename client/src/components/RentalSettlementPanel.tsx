/**
 * Rental return settlement panel (drizzle/0096 wave) — operator-only view over
 * `rentalCondition.computeSettlement` and the settlement half of
 * `rentalCondition.deltaReport`. Displays distance, billed weeks, included /
 * excess kilometres, the excess-km and fuel charges, the damage split (renter
 * liability vs insurer credit), and the total, alongside the new damage zones
 * surfaced by the delta report. Settlement authority stays in
 * vehicle_access.compute_return_settlement; the UI never recomputes totals.
 */
import { FormEvent, useMemo, useState } from "react";
import { Calculator, Loader2 } from "lucide-react";
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
  isUuid,
  normalizeSettlement,
  photoZoneLabel,
  parseMajorToMinor,
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

export function RentalSettlementPanel({
  onNotice,
}: {
  onNotice: (message: string) => void;
}) {
  const utils = trpc.useUtils();
  const sessionProfile = useSessionProfile();
  const isOperator = operatorRoles.has(sessionProfile.data?.role ?? "");
  const [contractId, setContractId] = useState("");
  const [charges, setCharges] = useState({ damage: "0", fuel: "0" });

  const delta = trpc.rentalCondition.deltaReport.useQuery(
    { contractId },
    { enabled: isOperator && isUuid(contractId), staleTime: 15_000 },
  );
  const settlement = useMemo(
    () => normalizeSettlement(delta.data?.settlement),
    [delta.data],
  );
  const newDamageZones =
    delta.data?.deltas?.newDamageZones ?? settlement?.newDamageZones ?? [];

  const computeMutation = trpc.rentalCondition.computeSettlement.useMutation({
    onSuccess: async (result) => {
      await utils.rentalCondition.deltaReport.invalidate();
      onNotice(`Return settlement computed: ${result.settlementId}`);
    },
    onError: (error) => onNotice(error.message),
  });

  const submitSettlement = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      computeMutation.mutate({
        contractId,
        damageChargeMinor: parseMajorToMinor(charges.damage, "damage charge"),
        fuelChargeMinor: parseMajorToMinor(charges.fuel, "fuel charge"),
        idempotencyKey: idempotency("rental-settlement"),
      });
    } catch (error) {
      onNotice(
        error instanceof Error ? error.message : "Invalid settlement input.",
      );
    }
  };

  if (!isOperator) {
    return (
      <section aria-labelledby="rental-settlement-heading">
        <p className="border border-slate-800 bg-slate-950/40 px-4 py-3 text-sm text-slate-400">
          Return settlement controls are displayed only to operations roles.
          Settlement computation remains server- and database-authorized
          regardless of this presentation rule.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-5" aria-labelledby="rental-settlement-heading">
      <div className="border-b border-slate-800 pb-4">
        <div className="flex items-center gap-2 text-sm font-medium uppercase tracking-[0.18em] text-cyan-300">
          <Calculator className="h-4 w-4" /> Return settlement
        </div>
        <h2
          id="rental-settlement-heading"
          className="mt-2 text-xl font-semibold text-white"
        >
          Final return settlement and damage split
        </h2>
        <p className="mt-2 max-w-4xl text-sm leading-6 text-slate-400">
          Computing a settlement requires both condition reports and a
          return-pending contract. It is append-only: one settlement per
          contract, with the damage charge split between the renter (up to the
          selected tier excess) and the insurer credit (up to the damage cap).
        </p>
      </div>

      <section className="grid gap-5 xl:grid-cols-[1.45fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Settlement breakdown</CardTitle>
            <CardDescription>
              The persisted settlement for the contract, plus the new damage
              zones detected between check-out and check-in.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <input
              className={inputClass}
              placeholder="Contract UUID"
              value={contractId}
              onChange={(event) => setContractId(event.target.value)}
            />
            {delta.isFetching ? (
              <div className="flex items-center gap-2 py-6 text-sm text-slate-400">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading settlement…
              </div>
            ) : null}
            {delta.isError ? (
              <p className="py-4 text-sm text-rose-300">
                {delta.error?.message}
              </p>
            ) : null}
            {settlement ? (
              <dl className="divide-y divide-slate-800 text-sm">
                {[
                  ["Distance driven", `${settlement.distanceKm.toLocaleString()} km`],
                  ["Billed weeks", settlement.billedWeeks.toLocaleString()],
                  ["Included kilometres", `${settlement.includedKm.toLocaleString()} km`],
                  ["Excess kilometres", `${settlement.excessKm.toLocaleString()} km`],
                ].map(([label, value]) => (
                  <div
                    key={String(label)}
                    className="flex items-center justify-between py-1.5"
                  >
                    <dt className="text-slate-400">{label}</dt>
                    <dd className="font-medium text-slate-100">{value}</dd>
                  </div>
                ))}
                <div className="flex items-center justify-between py-1.5">
                  <dt className="text-slate-400">Excess km charge</dt>
                  <dd className="font-medium text-slate-100">
                    {formatMinor(settlement.excessKmChargeMinor, settlement.currency)}
                  </dd>
                </div>
                <div className="flex items-center justify-between py-1.5">
                  <dt className="text-slate-400">
                    Fuel charge ({settlement.fuelOutPct}% → {settlement.fuelInPct}
                    %)
                  </dt>
                  <dd className="font-medium text-slate-100">
                    {formatMinor(settlement.fuelChargeMinor, settlement.currency)}
                  </dd>
                </div>
                <div className="flex items-center justify-between py-1.5">
                  <dt className="text-slate-400">Assessed damage charge</dt>
                  <dd className="font-medium text-slate-100">
                    {formatMinor(settlement.damageChargeMinor, settlement.currency)}
                  </dd>
                </div>
                <div className="flex items-center justify-between py-1.5">
                  <dt className="text-slate-400">Renter damage liability</dt>
                  <dd className="font-medium text-rose-200">
                    {formatMinor(
                      settlement.renterDamageLiabilityMinor,
                      settlement.currency,
                    )}
                  </dd>
                </div>
                <div className="flex items-center justify-between py-1.5">
                  <dt className="text-slate-400">Insurer credit</dt>
                  <dd className="font-medium text-emerald-200">
                    {formatMinor(
                      settlement.insuranceCreditMinor,
                      settlement.currency,
                    )}
                  </dd>
                </div>
                <div className="flex items-center justify-between py-2">
                  <dt className="font-semibold text-slate-100">
                    Total renter charge
                  </dt>
                  <dd className="text-base font-bold text-cyan-200">
                    {formatMinor(settlement.totalChargeMinor, settlement.currency)}
                  </dd>
                </div>
              </dl>
            ) : null}
            {isUuid(contractId) &&
            !delta.isFetching &&
            !delta.isError &&
            !settlement ? (
              <p className="py-4 text-sm text-slate-400">
                No return settlement has been computed for this contract yet.
              </p>
            ) : null}
            {newDamageZones.length ? (
              <div className="space-y-2 border border-slate-800 bg-slate-950/40 p-3">
                <p className="text-sm font-medium text-slate-100">
                  New damage zones at check-in
                </p>
                <div className="flex flex-wrap gap-2">
                  {newDamageZones.map((zone) => (
                    <span
                      key={zone}
                      className="rounded-full border border-rose-400/40 bg-rose-500/10 px-2 py-0.5 text-xs text-rose-200"
                    >
                      {photoZoneLabel(zone)}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Compute return settlement</CardTitle>
            <CardDescription>
              Charges are entered in major units and stored as integer minor
              units. The excess-km charge, damage split, and total are computed
              by the database from the condition reports and the frozen
              insurance snapshot.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-3" onSubmit={submitSettlement}>
              <input
                className={inputClass}
                placeholder="Damage charge (major units)"
                inputMode="decimal"
                value={charges.damage}
                onChange={(event) =>
                  setCharges({ ...charges, damage: event.target.value })
                }
                required
              />
              <input
                className={inputClass}
                placeholder="Fuel charge (major units)"
                inputMode="decimal"
                value={charges.fuel}
                onChange={(event) =>
                  setCharges({ ...charges, fuel: event.target.value })
                }
                required
              />
              <button
                className="rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 disabled:opacity-60"
                type="submit"
                disabled={computeMutation.isPending || !isUuid(contractId)}
              >
                {computeMutation.isPending
                  ? "Computing…"
                  : "Compute settlement"}
              </button>
            </form>
          </CardContent>
        </Card>
      </section>
    </section>
  );
}
