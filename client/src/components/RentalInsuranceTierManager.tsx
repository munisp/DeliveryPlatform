/**
 * Rental insurance tier manager (drizzle/0096 wave) — operator admin for the
 * `rentalInsurance` router: list the active tiers compatible with an offer,
 * create tiers (major-unit money inputs converted to integer minor units),
 * retire tiers behind a two-step confirm, and lock a tier onto a contract.
 * Tier lifecycle authority stays in vehicle_access.create_insurance_tier /
 * retire_insurance_tier / select_contract_insurance.
 */
import { FormEvent, useState } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
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
  formatDepositMultiplier,
  isUuid,
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

export function RentalInsuranceTierManager({
  onNotice,
}: {
  onNotice: (message: string) => void;
}) {
  const utils = trpc.useUtils();
  const sessionProfile = useSessionProfile();
  const isOperator = operatorRoles.has(sessionProfile.data?.role ?? "");
  const [offerId, setOfferId] = useState("");
  const [selectionContractId, setSelectionContractId] = useState("");
  const [retireArmedId, setRetireArmedId] = useState<string | null>(null);
  const [tier, setTier] = useState({
    providerId: "",
    tierCode: "",
    displayName: "",
    currency: "NGN",
    dailyRate: "",
    excess: "",
    liabilityCap: "",
    damageCap: "",
    theftCovered: false,
    depositMultiplierBp: "10000",
  });

  const tiersQuery = trpc.rentalInsurance.listForOffer.useQuery(
    { offerId, limit: 24 },
    { enabled: isUuid(offerId) },
  );
  const tiers = tiersQuery.data?.tiers ?? [];

  const refresh = async (message: string) => {
    await utils.rentalInsurance.listForOffer.invalidate();
    onNotice(message);
  };

  const createTierMutation = trpc.rentalInsurance.createTier.useMutation({
    onSuccess: (result) => refresh(`Insurance tier created: ${result.tierId}`),
    onError: (error) => onNotice(error.message),
  });
  const retireTierMutation = trpc.rentalInsurance.retireTier.useMutation({
    onSuccess: () => {
      setRetireArmedId(null);
      void refresh("Insurance tier retired.");
    },
    onError: (error) => onNotice(error.message),
  });
  const selectTierMutation = trpc.rentalInsurance.selectTier.useMutation({
    onSuccess: (result) =>
      onNotice(`Insurance tier locked onto the contract: ${result.selectionId}`),
    onError: (error) => onNotice(error.message),
  });

  const submitCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      createTierMutation.mutate({
        providerId: tier.providerId,
        tierCode: tier.tierCode.toLowerCase(),
        displayName: tier.displayName,
        currency: tier.currency.toUpperCase(),
        dailyRateMinor: parseMajorToMinor(tier.dailyRate, "daily rate"),
        excessMinor: parseMajorToMinor(tier.excess, "excess"),
        liabilityCapMinor: parseMajorToMinor(
          tier.liabilityCap,
          "liability cap",
        ),
        damageCapMinor: parseMajorToMinor(tier.damageCap, "damage cap"),
        theftCovered: tier.theftCovered,
        depositMultiplierBp: Number(tier.depositMultiplierBp),
        idempotencyKey: idempotency("rental-insurance-tier"),
      });
    } catch (error) {
      onNotice(
        error instanceof Error ? error.message : "Invalid insurance tier input.",
      );
    }
  };

  const selectForContract = (tierId: string) => {
    selectTierMutation.mutate({
      contractId: selectionContractId,
      tierId,
      idempotencyKey: idempotency("rental-insurance-select"),
    });
  };

  return (
    <section className="space-y-5" aria-labelledby="rental-insurance-heading">
      <div className="border-b border-slate-800 pb-4">
        <div className="flex items-center gap-2 text-sm font-medium uppercase tracking-[0.18em] text-cyan-300">
          <ShieldCheck className="h-4 w-4" /> Rental insurance
        </div>
        <h2
          id="rental-insurance-heading"
          className="mt-2 text-xl font-semibold text-white"
        >
          Insurance tiers, deposits, and contract cover
        </h2>
        <p className="mt-2 max-w-4xl text-sm leading-6 text-slate-400">
          Tiers are provider-scoped and priced per day. Selecting a tier freezes
          an immutable snapshot onto the contract and recomputes the deposit
          from the basis-point multiplier; creation and retirement remain
          operator-only and database-authorized.
        </p>
      </div>

      <section className="grid gap-5 xl:grid-cols-[1.45fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Tiers for an offer</CardTitle>
            <CardDescription>
              Only active tiers matching the offer provider and currency are
              listed. Locking a tier requires the rental contract UUID; the
              database enforces that only the contract worker can select.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <input
              className={inputClass}
              placeholder="Offer UUID"
              value={offerId}
              onChange={(event) => setOfferId(event.target.value)}
            />
            {!isOperator ? (
              <input
                className={inputClass}
                placeholder="Contract UUID (for tier selection)"
                value={selectionContractId}
                onChange={(event) => setSelectionContractId(event.target.value)}
              />
            ) : null}
            {tiersQuery.isFetching ? (
              <div className="flex items-center gap-2 py-6 text-sm text-slate-400">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading insurance
                tiers…
              </div>
            ) : null}
            {tiersQuery.isError ? (
              <p className="py-4 text-sm text-rose-300">
                {tiersQuery.error?.message}
              </p>
            ) : null}
            {isUuid(offerId) &&
            !tiersQuery.isFetching &&
            !tiersQuery.isError &&
            !tiers.length ? (
              <p className="py-4 text-sm text-slate-400">
                No active insurance tiers are compatible with this offer. The
                rental continues without add-on cover.
              </p>
            ) : null}
            {tiers.map((item) => (
              <div
                key={item.id}
                className="space-y-2 border border-slate-800 p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-medium text-slate-100">
                      {item.displayName}
                    </p>
                    <p className="font-mono text-xs uppercase tracking-wide text-slate-500">
                      {item.tierCode}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="rounded-full border border-cyan-400/30 bg-cyan-500/10 px-2 py-1 text-cyan-100">
                      {formatMinor(Number(item.dailyRateMinor), item.currency)}{" "}
                      / day
                    </span>
                    <span
                      className={
                        item.theftCovered
                          ? "rounded-full border border-emerald-400/30 bg-emerald-500/10 px-2 py-1 text-emerald-100"
                          : "rounded-full border border-amber-400/30 bg-amber-500/10 px-2 py-1 text-amber-100"
                      }
                    >
                      {item.theftCovered ? "Theft covered" : "No theft cover"}
                    </span>
                    <span className="rounded-full border border-slate-700 px-2 py-1 text-slate-300">
                      {formatDepositMultiplier(Number(item.depositMultiplierBp))}{" "}
                      deposit
                    </span>
                  </div>
                </div>
                <dl className="grid gap-2 text-sm sm:grid-cols-3">
                  <div>
                    <dt className="text-slate-500">Excess (renter max)</dt>
                    <dd className="text-slate-200">
                      {formatMinor(Number(item.excessMinor), item.currency)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Liability cover up to</dt>
                    <dd className="text-slate-200">
                      {formatMinor(Number(item.liabilityCapMinor), item.currency)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Damage cover up to</dt>
                    <dd className="text-slate-200">
                      {formatMinor(Number(item.damageCapMinor), item.currency)}
                    </dd>
                  </div>
                </dl>
                <p className="break-all font-mono text-xs text-slate-600">
                  {item.id}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  {isOperator ? (
                    <p className="text-xs text-slate-500">
                      Renters lock tiers from their account.
                    </p>
                  ) : (
                    <button
                      type="button"
                      className="rounded-md bg-cyan-500 px-3 py-2 text-sm font-medium text-slate-950 disabled:opacity-60"
                      disabled={
                        !isUuid(selectionContractId) || selectTierMutation.isPending
                      }
                      onClick={() => selectForContract(item.id)}
                    >
                      {selectTierMutation.isPending
                        ? "Locking…"
                        : "Lock onto contract"}
                    </button>
                  )}
                  {isOperator ? (
                    retireArmedId === item.id ? (
                      <>
                        <button
                          type="button"
                          className="rounded-md border border-rose-400/50 bg-rose-500/10 px-3 py-2 text-sm text-rose-100 disabled:opacity-60"
                          disabled={retireTierMutation.isPending}
                          onClick={() =>
                            retireTierMutation.mutate({
                              tierId: item.id,
                              idempotencyKey:
                                idempotency("rental-insurance-retire"),
                            })
                          }
                        >
                          {retireTierMutation.isPending
                            ? "Retiring…"
                            : "Confirm retire"}
                        </button>
                        <button
                          type="button"
                          className="rounded-md border border-slate-600 px-3 py-2 text-sm text-slate-100"
                          onClick={() => setRetireArmedId(null)}
                        >
                          Keep tier
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="rounded-md border border-rose-400/40 px-3 py-2 text-sm text-rose-200"
                        onClick={() => setRetireArmedId(item.id)}
                      >
                        Retire
                      </button>
                    )
                  ) : null}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        {isOperator ? (
          <Card>
            <CardHeader>
              <CardTitle>Create insurance tier</CardTitle>
              <CardDescription>
                Money fields are entered in major units (e.g. 1500.00) and
                stored as integer minor units. The deposit multiplier is basis
                points of the base deposit: 10000 bp = ×1.00, 12500 bp = ×1.25.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form className="space-y-3" onSubmit={submitCreate}>
                <input
                  className={inputClass}
                  placeholder="Provider UUID"
                  value={tier.providerId}
                  onChange={(event) =>
                    setTier({ ...tier, providerId: event.target.value })
                  }
                  required
                />
                <input
                  className={inputClass}
                  placeholder="Tier code, e.g. standard_cover"
                  pattern="[a-z][a-z0-9_-]{1,62}"
                  value={tier.tierCode}
                  onChange={(event) =>
                    setTier({
                      ...tier,
                      tierCode: event.target.value.toLowerCase(),
                    })
                  }
                  required
                />
                <input
                  className={inputClass}
                  placeholder="Display name"
                  minLength={2}
                  maxLength={120}
                  value={tier.displayName}
                  onChange={(event) =>
                    setTier({ ...tier, displayName: event.target.value })
                  }
                  required
                />
                <input
                  className={inputClass}
                  placeholder="Currency"
                  maxLength={3}
                  value={tier.currency}
                  onChange={(event) =>
                    setTier({
                      ...tier,
                      currency: event.target.value.toUpperCase(),
                    })
                  }
                  required
                />
                <div className="grid grid-cols-2 gap-2">
                  <input
                    className={inputClass}
                    placeholder="Daily rate (major)"
                    inputMode="decimal"
                    value={tier.dailyRate}
                    onChange={(event) =>
                      setTier({ ...tier, dailyRate: event.target.value })
                    }
                    required
                  />
                  <input
                    className={inputClass}
                    placeholder="Excess (major)"
                    inputMode="decimal"
                    value={tier.excess}
                    onChange={(event) =>
                      setTier({ ...tier, excess: event.target.value })
                    }
                    required
                  />
                  <input
                    className={inputClass}
                    placeholder="Liability cap (major)"
                    inputMode="decimal"
                    value={tier.liabilityCap}
                    onChange={(event) =>
                      setTier({ ...tier, liabilityCap: event.target.value })
                    }
                    required
                  />
                  <input
                    className={inputClass}
                    placeholder="Damage cap (major)"
                    inputMode="decimal"
                    value={tier.damageCap}
                    onChange={(event) =>
                      setTier({ ...tier, damageCap: event.target.value })
                    }
                    required
                  />
                </div>
                <label className="flex items-center gap-2 text-sm text-slate-300">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-cyan-500"
                    checked={tier.theftCovered}
                    onChange={(event) =>
                      setTier({ ...tier, theftCovered: event.target.checked })
                    }
                  />
                  Theft covered under this tier
                </label>
                <input
                  className={inputClass}
                  placeholder="Deposit multiplier (basis points)"
                  inputMode="numeric"
                  value={tier.depositMultiplierBp}
                  onChange={(event) =>
                    setTier({
                      ...tier,
                      depositMultiplierBp: event.target.value,
                    })
                  }
                  required
                />
                <p className="text-xs text-slate-500">
                  Basis points of the base deposit: 0–100000;{" "}
                  {formatDepositMultiplier(Number(tier.depositMultiplierBp) || 0)}{" "}
                  = the selected multiplier.
                </p>
                <button
                  className="rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 disabled:opacity-60"
                  type="submit"
                  disabled={createTierMutation.isPending}
                >
                  {createTierMutation.isPending
                    ? "Creating…"
                    : "Create insurance tier"}
                </button>
              </form>
            </CardContent>
          </Card>
        ) : (
          <p className="border border-slate-800 bg-slate-950/40 px-4 py-3 text-sm text-slate-400">
            Insurance tier creation and retirement are displayed only to
            operations roles. Tier selection remains server- and
            database-authorized regardless of this presentation rule.
          </p>
        )}
      </section>
    </section>
  );
}
