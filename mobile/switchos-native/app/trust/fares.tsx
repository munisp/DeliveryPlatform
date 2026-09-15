import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { SectionCard } from "@/components/mobile/operations-ui";
import { ScreenContainer } from "@/components/screen-container";
import { FareBreakdown } from "@/components/trust/fare-breakdown";
import { VerifiedRiderBadge } from "@/components/trust/verified-rider-badge";
import {
  BackHeader,
  Notice,
  QueryErrorNotice,
  StatusPill,
  trustInputClass,
  trustPlaceholderColor,
} from "@/components/trust/ui";
import {
  type TransparentDriverOffer,
  useMyOffers,
} from "@/lib/economicsSafetyApi";
import { formatDateTime, formatMinor } from "@/lib/money";

/**
 * Fare transparency (R9, with R7 take-rate and R8 deadhead display, plus the
 * R1 rider badge on each offer). Drivers pick one of their dispatch offers
 * to see the full itemized breakdown before accepting; anyone can also look
 * up a breakdown by offer ID.
 */

function OfferRow({
  offer,
  selected,
  onSelect,
}: {
  offer: TransparentDriverOffer;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <Pressable
      onPress={onSelect}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      className={
        selected
          ? "rounded-[20px] border border-accent2/60 bg-accent2/10 px-4 py-3"
          : "rounded-[20px] border border-border bg-background/60 px-4 py-3"
      }
    >
      <View className="flex-row flex-wrap items-center justify-between gap-2">
        <Text className="text-base font-semibold text-foreground">
          {formatMinor(offer.grossFareKobo)}
        </Text>
        <Text className="text-xs text-muted">
          expires {formatDateTime(offer.expiresAt)}
        </Text>
      </View>
      <Text className="mt-1 text-sm text-muted" numberOfLines={1}>
        {offer.destinationAddress ?? "Destination unavailable"}
      </Text>
      <Text className="mt-1 text-xs text-muted">
        Est. net {formatMinor(offer.expectedDriverNetKobo)} · pickup{" "}
        {(offer.pickupDistanceM / 1000).toFixed(1)} km
      </Text>
    </Pressable>
  );
}

function MyOffersSection({
  selectedOfferId,
  onSelect,
}: {
  selectedOfferId: string;
  onSelect: (offerId: string) => void;
}) {
  const offers = useMyOffers();

  if (offers.isError) {
    return (
      <QueryErrorNotice
        resource="your dispatch offers"
        message={offers.error?.message}
        onRetry={() => void offers.refetch()}
        retrying={offers.isRefetching}
      />
    );
  }
  if (offers.isLoading) {
    return <Text className="text-sm text-muted">Loading your offers…</Text>;
  }
  const list = offers.data ?? [];
  if (list.length === 0) {
    return (
      <Notice
        tone="neutral"
        title="No active dispatch offers"
        body="When the platform offers you a trip it will appear here with its full fare breakdown."
      />
    );
  }
  return (
    <View className="gap-2">
      {list.map((offer) => (
        <OfferRow
          key={offer.offerId}
          offer={offer}
          selected={selectedOfferId === offer.offerId}
          onSelect={() => onSelect(offer.offerId)}
        />
      ))}
    </View>
  );
}

export default function FaresScreen() {
  const [selectedOfferId, setSelectedOfferId] = useState("");
  const [manualOfferId, setManualOfferId] = useState("");

  const effectiveOfferId = manualOfferId.trim() || selectedOfferId;

  return (
    <ScreenContainer className="px-4 pb-6">
      <ScrollView
        contentContainerStyle={{ gap: 16, paddingTop: 20, paddingBottom: 24 }}
      >
        <BackHeader
          title="Fare transparency"
          subtitle="Every kobo accounted for before you commit: base, distance, time, deadhead credit, surge, and the published take rate (R7–R9)."
        />

        <SectionCard
          title="My dispatch offers"
          subtitle="Select an offer to inspect its itemized breakdown and the rider's verification badge."
        >
          <MyOffersSection
            selectedOfferId={manualOfferId.trim() ? "" : selectedOfferId}
            onSelect={(offerId) => {
              setManualOfferId("");
              setSelectedOfferId(offerId);
            }}
          />
        </SectionCard>

        <SectionCard
          title="Look up by offer ID"
          subtitle="Paste any offer ID to load its stored breakdown."
        >
          <TextInput
            value={manualOfferId}
            onChangeText={setManualOfferId}
            placeholder="Offer ID (UUID)"
            placeholderTextColor={trustPlaceholderColor}
            autoCapitalize="none"
            className={trustInputClass}
          />
        </SectionCard>

        {effectiveOfferId ? (
          <SectionCard
            title="Offer detail"
            subtitle="Rider identity assurance and the itemized fare for the selected offer."
          >
            <VerifiedRiderBadge offerId={effectiveOfferId} />
            <FareBreakdown offerId={effectiveOfferId} />
            <View className="flex-row flex-wrap gap-2">
              <StatusPill
                label={`Offer ${effectiveOfferId.slice(0, 8)}…`}
                tone="neutral"
              />
            </View>
          </SectionCard>
        ) : null}
      </ScrollView>
    </ScreenContainer>
  );
}
