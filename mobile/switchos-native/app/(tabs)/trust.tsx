import { useRouter, type Href } from "expo-router";
import { Pressable, ScrollView, Text, View } from "react-native";

import { SectionCard } from "@/components/mobile/operations-ui";
import { ScreenContainer } from "@/components/screen-container";
import { Notice, StatusPill } from "@/components/trust/ui";
import { useMyVerificationStatus } from "@/lib/trustApi";

/**
 * Trust & transparency hub (Wave E1). Entry point for the driver/rider
 * facing R1–R9 screens: verified identity, passenger manifests, fare
 * transparency, market economics, worker council, and deactivation appeals.
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
      </ScrollView>
    </ScreenContainer>
  );
}
