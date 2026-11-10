import { ActivityIndicator, Pressable, Text, View } from "react-native";

import {
  KeyValueRow,
  Notice,
  StatusPill,
} from "@/components/trust/ui";
import { useColors } from "@/hooks/use-colors";
import { formatMinor, toNumber } from "@/lib/money";
import {
  useInsuranceTiersForOffer,
  type InsuranceTier,
} from "@/lib/rentalCondition";

/**
 * Insurance tier picker for a rental offer. Lists the active tiers exposed by
 * rentalInsurance.listForOffer and reports the driver's choice through
 * onSelect — persisting the selection (rentalInsurance.selectTier) is the
 * host screen's responsibility because it needs the contract id.
 *
 * All money columns are integer minor units and may arrive as strings
 * (Postgres bigint); formatMinor renders them in major currency units.
 */

export type InsuranceTierPickerProps = {
  offerId: string;
  selectedTierId?: string;
  onSelect: (tierId: string) => void;
};

/** deposit_multiplier_bp is basis points of the base deposit: 12500 -> ×1.25. */
export function formatDepositMultiplier(multiplierBp: number): string {
  return `×${(multiplierBp / 10_000).toFixed(2)}`;
}

function TierRow({
  tier,
  selected,
  onSelect,
}: {
  tier: InsuranceTier;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <Pressable
      onPress={onSelect}
      accessibilityRole="button"
      accessibilityLabel={`Select ${tier.displayName} insurance tier`}
      className={`gap-2 rounded-[20px] border px-4 py-3 ${
        selected
          ? "border-primary bg-primary/10"
          : "border-border bg-background/60"
      }`}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
    >
      <View className="flex-row items-start justify-between gap-2">
        <View className="flex-1">
          <Text className="text-sm font-semibold text-foreground">
            {tier.displayName}
          </Text>
          <Text className="mt-0.5 text-xs uppercase tracking-wide text-muted">
            {tier.tierCode}
          </Text>
        </View>
        {selected ? <StatusPill label="Selected" tone="info" /> : null}
      </View>

      <View className="flex-row flex-wrap items-center gap-2">
        <StatusPill
          label={`${formatMinor(tier.dailyRateMinor, tier.currency)} / day`}
          tone="info"
        />
        <StatusPill
          label={tier.theftCovered ? "Theft covered" : "No theft cover"}
          tone={tier.theftCovered ? "success" : "warning"}
        />
        <StatusPill
          label={`${formatDepositMultiplier(tier.depositMultiplierBp)} deposit`}
          tone="neutral"
        />
      </View>

      <View className="rounded-[16px] border border-border/60 bg-surface px-3 py-1">
        <KeyValueRow
          label="Excess (your max damage cost)"
          value={formatMinor(tier.excessMinor, tier.currency)}
        />
        <KeyValueRow
          label="Liability cover up to"
          value={formatMinor(tier.liabilityCapMinor, tier.currency)}
        />
        <KeyValueRow
          label="Damage cover up to"
          value={formatMinor(tier.damageCapMinor, tier.currency)}
        />
      </View>
    </Pressable>
  );
}

export function InsuranceTierPicker({
  offerId,
  selectedTierId,
  onSelect,
}: InsuranceTierPickerProps) {
  const colors = useColors();
  const tiers = useInsuranceTiersForOffer(offerId);

  if (!offerId) {
    return (
      <Notice
        tone="neutral"
        title="No offer selected"
        body="Insurance tiers load once a rental offer is chosen."
      />
    );
  }

  if (tiers.isLoading) {
    return (
      <View className="flex-row items-center gap-2 rounded-[18px] border border-border bg-background/70 px-4 py-3">
        <ActivityIndicator size="small" color={colors.primary} />
        <Text className="text-sm text-muted">Loading insurance tiers...</Text>
      </View>
    );
  }

  if (tiers.isError) {
    return (
      <View className="gap-3">
        <Notice
          tone="warning"
          title="Insurance tiers unavailable"
          body={tiers.error?.message ?? "Check your connection and try again."}
        />
        <Pressable
          onPress={() => void tiers.refetch()}
          disabled={tiers.isRefetching}
          accessibilityRole="button"
          accessibilityLabel="Retry loading insurance tiers"
          className="self-start rounded-full bg-primary px-4 py-2 disabled:opacity-50"
        >
          <Text className="text-xs font-semibold text-white">
            {tiers.isRefetching ? "Retrying…" : "Retry"}
          </Text>
        </Pressable>
      </View>
    );
  }

  const items = tiers.data ?? [];
  if (items.length === 0) {
    return (
      <Notice
        tone="neutral"
        title="No insurance tiers"
        body="This provider has no active insurance tiers for the offer. The rental continues without add-on cover."
      />
    );
  }

  // Defensive ordering: cheapest daily rate first; the server does not
  // guarantee an order beyond its LIMIT.
  const ordered = [...items].sort(
    (a, b) => toNumber(a.dailyRateMinor) - toNumber(b.dailyRateMinor),
  );

  return (
    <View className="gap-3">
      {ordered.map((tier) => (
        <TierRow
          key={tier.id}
          tier={tier}
          selected={tier.id === selectedTierId}
          onSelect={() => onSelect(tier.id)}
        />
      ))}
    </View>
  );
}
