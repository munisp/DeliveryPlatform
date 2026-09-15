import { Text, View } from "react-native";

import { StatusPill } from "@/components/trust/ui";
import { useOfferRiderBadge } from "@/lib/trustApi";

/**
 * Rider identity assurance pill shown on driver offer cards (R1 — drivers
 * must know whether the passenger on an offer has completed identity
 * verification before accepting). Native port of the PWA's
 * client/src/components/VerifiedRiderBadge.tsx.
 */
export function VerifiedRiderBadge({ offerId }: { offerId: string }) {
  const badge = useOfferRiderBadge(offerId);

  if (badge.isLoading) {
    return <StatusPill label="Checking rider…" tone="neutral" />;
  }

  if (badge.isError || !badge.data) {
    return <StatusPill label="Rider status unavailable" tone="neutral" />;
  }

  if (badge.data.verified) {
    const detail = [
      badge.data.firstName ? `Rider: ${badge.data.firstName}` : null,
      badge.data.rating !== null ? `Rating: ${badge.data.rating.toFixed(1)}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <View className="gap-1">
        <StatusPill label="✓ Verified rider" tone="success" />
        {detail ? <Text className="text-xs text-muted">{detail}</Text> : null}
      </View>
    );
  }

  return <StatusPill label="⚠ Unverified rider" tone="warning" />;
}
