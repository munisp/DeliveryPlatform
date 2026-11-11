import { useRouter, type Href } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { SectionCard } from "@/components/mobile/operations-ui";
import { ScreenContainer } from "@/components/screen-container";
import {
  Notice,
  StatusPill,
  trustInputClass,
  trustPlaceholderColor,
} from "@/components/trust/ui";
import { isUuid } from "@/lib/rentalCondition";
import { useMyVerificationStatus } from "@/lib/trustApi";

/**
 * Trust & transparency hub (Wave E1). Entry point for the driver/rider
 * facing R1–R9 screens: verified identity, passenger manifests, fare
 * transparency, market economics, worker council, and deactivation appeals.
 * Also hosts the vehicle-rental entry points (condition evidence, insurance
 * cover, return settlement) and KYC document capture.
 */

type HubLink = {
  href: Href;
  title: string;
  body: string;
};

const hubLinks: HubLink[] = [
  {
    href: "/trust/verification",
    title: "Identity verification",
    body: "Check your verified-rider badge status and submit an ID reference (R1).",
  },
  {
    href: "/trust/manifest",
    title: "Passenger manifest",
    body: "Name everyone riding before pickup; NINs are stored only as digests (R2).",
  },
  {
    href: "/trust/fares",
    title: "Fare transparency",
    body: "Itemized per-offer breakdown with deadhead credit and take rate (R7–R9).",
  },
  {
    href: "/trust/economics",
    title: "Market economics",
    body: "The fare floor, cost index, and published take rate for your market (R6/R7).",
  },
  {
    href: "/trust/council",
    title: "Worker council",
    body: "Consultations that bind the platform — review and respond in the SLA window (R5).",
  },
  {
    href: "/trust/appeals",
    title: "Deactivation appeals",
    body: "Notice timeline, stated cause, and the appeal form for your case (R4).",
  },
  {
    href: "/kyc-document-capture",
    title: "Document verification",
    body: "Photograph an identity or residency document; it is hashed on-device, attached to your verification case, and read by the extraction service.",
  },
];

function VerificationSummaryCard() {
  const status = useMyVerificationStatus();

  if (status.isLoading) {
    return (
      <Text className="text-sm text-muted">Loading verification status…</Text>
    );
  }
  if (status.isError || !status.data) {
    return (
      <Notice
        tone="warning"
        title="Verification status unavailable"
        body={status.error?.message ?? "Sign in and try again."}
      />
    );
  }

  const verified = status.data.badgeLevel === "verified";
  return (
    <View className="gap-2">
      <View className="flex-row flex-wrap items-center gap-2">
        <StatusPill
          label={verified ? "✓ Verified badge" : "No verified badge"}
          tone={verified ? "success" : "warning"}
        />
        <StatusPill label={`Status: ${status.data.status}`} tone="neutral" />
      </View>
      {status.data.flags.length > 0 ? (
        <Text className="text-xs leading-5 text-muted">
          Screening flags: {status.data.flags.join(", ")}
        </Text>
      ) : null}
    </View>
  );
}

type RentalEntry = {
  title: string;
  body: string;
  href: Href;
};

/**
 * Vehicle rental entry points. rental-condition and rental-settlement are
 * contract-context screens (they need the contract UUID; insurance tiers
 * additionally need the offer UUID), so this section collects those ids once
 * and pushes the three screens with the parameters they expect.
 */
function VehicleRentalsSection() {
  const router = useRouter();
  const [contractId, setContractId] = useState("");
  const [offerId, setOfferId] = useState("");
  const trimmedContractId = contractId.trim();
  const trimmedOfferId = offerId.trim();
  const contractReady = isUuid(trimmedContractId);

  const entries: RentalEntry[] = [
    {
      title: "Pick-up check-out",
      body: "Record condition evidence before handover. With the offer UUID set, insurance tiers can be reviewed and locked here.",
      href: {
        pathname: "/rental-condition",
        params: isUuid(trimmedOfferId)
          ? {
              contractId: trimmedContractId,
              phase: "check_out",
              offerId: trimmedOfferId,
            }
          : { contractId: trimmedContractId, phase: "check_out" },
      },
    },
    {
      title: "Return check-in",
      body: "Record the return condition evidence that anchors the settlement delta.",
      href: {
        pathname: "/rental-condition",
        params: { contractId: trimmedContractId, phase: "check_in" },
      },
    },
    {
      title: "Return settlement",
      body: "Check-out vs check-in comparison, the computed settlement, and the dispute form.",
      href: {
        pathname: "/rental-settlement",
        params: { contractId: trimmedContractId },
      },
    },
  ];

  return (
    <SectionCard
      title="Vehicle rentals"
      subtitle="Condition evidence, insurance cover, and the return settlement for a vehicle rental contract. Paste the contract UUID from the rental confirmation; the offer UUID additionally unlocks insurance tier selection at check-out."
    >
      <View className="gap-1">
        <Text className="text-xs uppercase tracking-wide text-muted">
          Contract UUID
        </Text>
        <TextInput
          value={contractId}
          onChangeText={setContractId}
          placeholder="Rental contract UUID"
          placeholderTextColor={trustPlaceholderColor}
          autoCapitalize="none"
          autoCorrect={false}
          className={trustInputClass}
        />
      </View>
      <View className="gap-1">
        <Text className="text-xs uppercase tracking-wide text-muted">
          Offer UUID (optional, for insurance tiers)
        </Text>
        <TextInput
          value={offerId}
          onChangeText={setOfferId}
          placeholder="Rental offer UUID"
          placeholderTextColor={trustPlaceholderColor}
          autoCapitalize="none"
          autoCorrect={false}
          className={trustInputClass}
        />
      </View>
      {!contractReady ? (
        <Text className="text-xs leading-5 text-muted">
          Enter a valid contract UUID to open the rental screens below.
        </Text>
      ) : null}
      {entries.map((entry) => (
        <Pressable
          key={entry.title}
          onPress={() => router.push(entry.href)}
          disabled={!contractReady}
          accessibilityRole="button"
          className="rounded-[28px] border border-border bg-surface px-4 py-4"
          style={({ pressed }) => ({
            opacity: pressed || !contractReady ? 0.6 : 1,
          })}
        >
          <View className="flex-row items-center justify-between gap-3">
            <View className="flex-1">
              <Text className="text-lg font-semibold text-foreground">
                {entry.title}
              </Text>
              <Text className="mt-1 text-sm leading-5 text-muted">
                {entry.body}
              </Text>
            </View>
            <Text className="text-xl font-semibold text-muted">›</Text>
          </View>
        </Pressable>
      ))}
    </SectionCard>
  );
}

export default function TrustHubScreen() {
  const router = useRouter();

  return (
    <ScreenContainer className="px-4 pb-6">
      <ScrollView
        contentContainerStyle={{ gap: 16, paddingTop: 20, paddingBottom: 24 }}
      >
        <View>
          <Text className="text-3xl font-bold text-foreground">
            Trust &amp; Transparency
          </Text>
          <Text className="mt-2 text-sm leading-6 text-muted">
            Verified identity, honest fares, co-governed policy, and due
            process — the protections drivers and riders asked for, in one
            place.
          </Text>
        </View>

        <SectionCard
          title="My rider verification"
          subtitle="Identity assurance status as shown to drivers on dispatch offers."
        >
          <VerificationSummaryCard />
        </SectionCard>

        <View className="gap-3">
          {hubLinks.map((link) => (
            <Pressable
              key={link.title}
              onPress={() => router.push(link.href)}
              accessibilityRole="button"
              className="rounded-[28px] border border-border bg-surface px-4 py-4"
            >
              <View className="flex-row items-center justify-between gap-3">
                <View className="flex-1">
                  <Text className="text-lg font-semibold text-foreground">
                    {link.title}
                  </Text>
                  <Text className="mt-1 text-sm leading-5 text-muted">
                    {link.body}
                  </Text>
                </View>
                <Text className="text-xl font-semibold text-muted">›</Text>
              </View>
            </Pressable>
          ))}
        </View>

        <VehicleRentalsSection />
      </ScrollView>
    </ScreenContainer>
  );
}
