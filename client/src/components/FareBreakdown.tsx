import { Receipt } from "lucide-react";

import { useOfferBreakdown } from "@/lib/trpcEconomicsSafety";

export function formatMinor(amountMinor: number, currency = "NGN") {
  return new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(amountMinor / 100);
}

/**
 * Line-item pre-trip fare disclosure (R6 — drivers and riders see exactly
 * how the fare is composed and what the platform keeps before anyone
 * commits). Renders inside driver offer cards and the earnings view.
 */
export default function FareBreakdown({ offerId }: { offerId: string }) {
  const breakdown = useOfferBreakdown(offerId);

  if (breakdown.isLoading) {
    return (
      <p className="text-sm text-slate-500">Loading fare breakdown…</p>
    );
  }

  if (breakdown.isError || !breakdown.data) {
    return (
      <p className="text-sm text-slate-500">
        Itemized fare breakdown is unavailable for this offer.
      </p>
    );
  }

  const data = breakdown.data;
  const currency = data.currency || "NGN";
  const surgeMinor = Math.round(
    ((data.baseMinor + data.distanceMinor + data.timeMinor) * data.surgeBps) /
      10_000,
  );
  const pickupMinutes = Math.round(data.pickupSeconds / 60);
  const pickupKm = (data.pickupMeters / 1000).toFixed(1);

  const rows: Array<{ label: string; amount: number; credit?: boolean }> = [
    { label: "Base fare", amount: data.baseMinor },
    { label: "Distance", amount: data.distanceMinor },
    { label: "Time", amount: data.timeMinor },
    {
      label: "Deadhead credit",
      amount: data.deadheadMinor,
      credit: true,
    },
    {
      label: `Surge (${(data.surgeBps / 100).toFixed(2)}%)`,
      amount: surgeMinor,
    },
    {
      label: `Platform fee (${data.takeRateBps} bps)`,
      amount: -data.platformFeeMinor,
    },
  ];

  return (
    <div className="space-y-2 rounded-md border border-slate-800 p-4">
      <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-slate-500">
        <Receipt className="h-4 w-4 text-cyan-300" />
        Itemized fare breakdown
      </p>
      <p className="text-sm text-slate-400">
        Pickup: {pickupMinutes} min · {pickupKm} km — deadhead credited
      </p>
      <dl className="divide-y divide-slate-800 text-sm">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex items-center justify-between py-1.5"
          >
            <dt className="text-slate-400">{row.label}</dt>
            <dd
              className={
                row.credit
                  ? "font-medium text-emerald-200"
                  : row.amount < 0
                    ? "font-medium text-rose-200"
                    : "font-medium text-slate-100"
              }
            >
              {row.credit && row.amount > 0 ? "+" : ""}
              {formatMinor(row.amount, currency)}
            </dd>
          </div>
        ))}
        <div className="flex items-center justify-between py-2">
          <dt className="font-semibold text-slate-100">Net to driver</dt>
          <dd className="text-base font-bold text-cyan-200">
            {formatMinor(data.netToDriverMinor, currency)}
          </dd>
        </div>
      </dl>
    </div>
  );
}
