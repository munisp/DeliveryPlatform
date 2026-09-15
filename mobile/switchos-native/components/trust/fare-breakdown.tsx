import { Text, View } from "react-native";

import { KeyValueRow } from "@/components/trust/ui";
import { useOfferBreakdown } from "@/lib/economicsSafetyApi";
import { formatBpsPercent, formatMinor, toNumber } from "@/lib/money";

/**
 * Line-item pre-trip fare disclosure (R9 — drivers and riders see exactly how
 * the fare is composed, including the R8 deadhead credit and the R7 published
 * take rate, before anyone commits). Native port of the PWA's
 * client/src/components/FareBreakdown.tsx, consuming the offer economics
 * breakdown row returned by pricingTransparency.getOfferBreakdown.
 */
export function FareBreakdown({ offerId }: { offerId: string }) {
  const breakdown = useOfferBreakdown(offerId);

  if (breakdown.isLoading) {
    return (
      <Text className="text-sm text-muted">Loading fare breakdown…</Text>
    );
  }

  if (breakdown.isError || !breakdown.data) {
    return (
      <Text className="text-sm text-muted">
        Itemized fare breakdown is unavailable for this offer.
      </Text>
    );
  }

  const data = breakdown.data;
  const currency = data.currency || "NGN";
  const baseMinor = toNumber(data.base_minor);
  const distanceMinor = toNumber(data.distance_minor);
  const timeMinor = toNumber(data.time_minor);
  const deadheadMinor = toNumber(data.deadhead_minor);
  const platformFeeMinor = toNumber(data.platform_fee_minor);
  const surgeBps = toNumber(data.surge_bps);
  const takeRateBps = toNumber(data.take_rate_bps);
  const surgeMinor = Math.round(
    ((baseMinor + distanceMinor + timeMinor) * surgeBps) / 10_000,
  );
  const pickupMinutes = Math.round(toNumber(data.pickup_seconds) / 60);
  const pickupKm = (toNumber(data.pickup_meters) / 1000).toFixed(1);

  const rows: { label: string; amount: number; credit?: boolean }[] = [
    { label: "Base fare", amount: baseMinor },
    { label: "Distance", amount: distanceMinor },
    { label: "Time", amount: timeMinor },
    { label: "Deadhead credit", amount: deadheadMinor, credit: true },
    { label: `Surge (${formatBpsPercent(surgeBps)})`, amount: surgeMinor },
    {
      label: `Platform fee (${formatBpsPercent(takeRateBps)} take rate)`,
      amount: -platformFeeMinor,
    },
  ];

  return (
    <View className="gap-2 rounded-[20px] border border-border bg-background/60 px-4 py-3">
      <Text className="text-xs font-semibold uppercase tracking-[1px] text-muted">
        Itemized fare breakdown
      </Text>
      <Text className="text-sm text-muted">
        Pickup: {pickupMinutes} min · {pickupKm} km — deadhead credited
      </Text>
      <View className="mt-1">
        {rows.map((row) => (
          <KeyValueRow
            key={row.label}
            label={row.label}
            value={`${row.credit && row.amount > 0 ? "+" : ""}${formatMinor(row.amount, currency)}`}
            valueClassName={
              row.credit
                ? "text-success"
                : row.amount < 0
                  ? "text-error"
                  : undefined
            }
          />
        ))}
        <View className="flex-row items-center justify-between border-t border-border py-2">
          <Text className="text-sm font-semibold text-foreground">
            Net to driver
          </Text>
          <Text className="text-base font-bold text-accent2">
            {formatMinor(data.net_to_driver_minor, currency)}
          </Text>
        </View>
      </View>
    </View>
  );
}
