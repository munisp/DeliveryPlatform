import { useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";

import { SectionCard } from "@/components/mobile/operations-ui";
import { ScreenContainer } from "@/components/screen-container";
import { PassengerManifestForm } from "@/components/trust/passenger-manifest-form";
import {
  BackHeader,
  Notice,
  StatusPill,
  trustInputClass,
  trustPlaceholderColor,
} from "@/components/trust/ui";
import { useManifest } from "@/lib/economicsSafetyApi";

/**
 * Passenger manifest (R2). Riders name everyone on the trip before pickup;
 * drivers see per-rider verification chips. Raw NINs never persist — only
 * sha256 digests are stored server-side.
 */

function ManifestLookup() {
  const [tripId, setTripId] = useState("");
  const manifest = useManifest(tripId.trim());

  return (
    <SectionCard
      title="Look up a trip manifest"
      subtitle="Visible to the trip's booker and the assigned driver."
    >
      <TextInput
        value={tripId}
        onChangeText={setTripId}
        placeholder="Trip ID"
        placeholderTextColor={trustPlaceholderColor}
        className={trustInputClass}
      />
      {!tripId.trim() ? (
        <Text className="text-sm text-muted">
          Enter a trip ID to load its manifest.
        </Text>
      ) : manifest.isLoading ? (
        <Text className="text-sm text-muted">Loading manifest…</Text>
      ) : manifest.isError || !manifest.data ? (
        <Notice
          tone="warning"
          title="Manifest unavailable"
          body={manifest.error?.message ?? "Try again."}
        />
      ) : (
        <View className="gap-2">
          <View className="flex-row flex-wrap items-center gap-2">
            <StatusPill
              label={
                manifest.data.manifestVerified
                  ? "✓ Manifest verified"
                  : "⚠ Manifest unverified"
              }
              tone={manifest.data.manifestVerified ? "success" : "warning"}
            />
            {manifest.data.verifiedVia ? (
              <StatusPill
                label={`via ${manifest.data.verifiedVia}`}
                tone="neutral"
              />
            ) : null}
          </View>
          {manifest.data.passengers.map((passenger, index) => (
            <View
              key={`${passenger.name}-${index}`}
              className="flex-row flex-wrap items-center justify-between gap-2 rounded-[16px] border border-border bg-background/60 px-3 py-2"
            >
              <Text className="text-sm font-medium text-foreground">
                {passenger.name}
              </Text>
              <StatusPill
                label={passenger.verified ? "✓ Verified" : "⚠ Unverified"}
                tone={passenger.verified ? "success" : "warning"}
              />
            </View>
          ))}
        </View>
      )}
    </SectionCard>
  );
}

export default function ManifestScreen() {
  return (
    <ScreenContainer className="px-4 pb-6">
      <ScrollView
        contentContainerStyle={{ gap: 16, paddingTop: 20, paddingBottom: 24 }}
      >
        <BackHeader
          title="Passenger manifest"
          subtitle="Name every rider before dispatch so drivers know who they are picking up (R2)."
        />
        <SectionCard
          title="Attach a manifest"
          subtitle="Attach or replace the passenger list for a trip. Names are screened; NINs are hashed and never stored raw."
        >
          <PassengerManifestForm />
        </SectionCard>
        <ManifestLookup />
      </ScrollView>
    </ScreenContainer>
  );
}
