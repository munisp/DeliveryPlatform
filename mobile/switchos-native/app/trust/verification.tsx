import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { SectionCard } from "@/components/mobile/operations-ui";
import { ScreenContainer } from "@/components/screen-container";
import {
  BackHeader,
  Notice,
  StatusPill,
  trustInputClass,
  trustPlaceholderColor,
} from "@/components/trust/ui";
import {
  useMyVerificationStatus,
  useScreenName,
  useSubmitVerification,
  useTrustInvalidation,
} from "@/lib/trustApi";

/**
 * Verified rider identity (R1). Shows the caller's verification status and
 * badge level exactly as riderVerification.getMyVerificationStatus reports
 * it, and submits an ID reference for verification. Only the sha256 digest
 * of the ID reference is ever stored server-side.
 */

const idTypeOptions = [
  { key: "nin", label: "National ID (NIN)" },
  { key: "drivers_license", label: "Driver's license" },
  { key: "voters_card", label: "Voter's card" },
  { key: "international_passport", label: "Int'l passport" },
] as const;

function statusTone(status: string) {
  if (status === "verified") return "success" as const;
  if (status === "pending") return "info" as const;
  if (status === "rejected" || status === "suspended") return "error" as const;
  return "warning" as const;
}

function StatusCard() {
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
    <View className="gap-3">
      <View className="flex-row flex-wrap gap-2">
        <StatusPill
          label={verified ? "✓ Verified rider badge" : "No badge yet"}
          tone={verified ? "success" : "warning"}
        />
        <StatusPill
          label={`Status: ${status.data.status}`}
          tone={statusTone(status.data.status)}
        />
      </View>
      {status.data.flags.length > 0 ? (
        <View className="gap-1">
          <Text className="text-xs font-semibold uppercase tracking-[1px] text-muted">
            Screening flags
          </Text>
          <View className="flex-row flex-wrap gap-1">
            {status.data.flags.map((flag) => (
              <StatusPill key={flag} label={flag} tone="error" />
            ))}
          </View>
        </View>
      ) : null}
      <Text className="text-xs leading-5 text-muted">
        Drivers see the verified badge on dispatch offers before they accept.
        Verification requires a valid ID reference and a plausible account
        name.
      </Text>
    </View>
  );
}

function NamePrecheckCard() {
  const [name, setName] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const screening = useScreenName(name.trim(), submitted);

  return (
    <SectionCard
      title="Name plausibility pre-check"
      subtitle="Verification auto-fails implausible names. Check how the screening service reads a name before you submit an ID."
    >
      <TextInput
        value={name}
        onChangeText={(value) => {
          setName(value);
          setSubmitted(false);
        }}
        placeholder="Full name as on your account"
        placeholderTextColor={trustPlaceholderColor}
        className={trustInputClass}
      />
      <Pressable
        onPress={() => setSubmitted(true)}
        disabled={!name.trim() || (submitted && screening.isLoading)}
        className="self-start rounded-full bg-primary px-4 py-2 disabled:opacity-50"
      >
        <Text className="text-xs font-semibold text-white">
          {submitted && screening.isLoading ? "Checking…" : "Check name"}
        </Text>
      </Pressable>
      {submitted && screening.isError ? (
        <Notice
          tone="warning"
          title="Name screening unavailable"
          body={screening.error?.message ?? "Try again."}
        />
      ) : null}
      {submitted && screening.data ? (
        <Notice
          tone={screening.data.plausible ? "success" : "warning"}
          title={
            screening.data.plausible
              ? `Plausible (score ${screening.data.score.toFixed(2)})`
              : `Implausible (score ${screening.data.score.toFixed(2)})`
          }
          body={
            screening.data.flags.length > 0
              ? `Flags: ${screening.data.flags.join(", ")}`
              : "No screening flags."
          }
        />
      ) : null}
    </SectionCard>
  );
}

function SubmitCard() {
  const [idType, setIdType] = useState<string>("nin");
  const [idRef, setIdRef] = useState("");
  const submitVerification = useSubmitVerification();
  const invalidation = useTrustInvalidation();

  const submit = () => {
    const trimmed = idRef.trim();
    if (!trimmed) return;
    submitVerification.mutate(
      { idType, idRef: trimmed },
      {
        onSuccess: () => {
          setIdRef("");
          invalidation.riderVerification();
        },
      },
    );
  };

  return (
    <SectionCard
      title="Submit ID for verification"
      subtitle="Only the sha256 digest of your ID reference is stored — the raw number never persists."
    >
      <View className="flex-row flex-wrap gap-2">
        {idTypeOptions.map((option) => (
          <Pressable
            key={option.key}
            onPress={() => setIdType(option.key)}
            accessibilityRole="button"
            accessibilityState={{ selected: idType === option.key }}
            className={
              idType === option.key
                ? "rounded-full bg-accent2 px-4 py-2"
                : "rounded-full bg-background px-4 py-2"
            }
          >
            <Text
              className={
                idType === option.key
                  ? "text-xs font-semibold text-white"
                  : "text-xs font-semibold text-foreground"
              }
            >
              {option.label}
            </Text>
          </Pressable>
        ))}
      </View>
      <TextInput
        value={idRef}
        onChangeText={setIdRef}
        placeholder="ID reference number"
        placeholderTextColor={trustPlaceholderColor}
        autoCapitalize="characters"
        className={trustInputClass}
      />
      <Pressable
        onPress={submit}
        disabled={submitVerification.isPending || !idRef.trim()}
        className="self-start rounded-full bg-primary px-4 py-3 disabled:opacity-50"
      >
        <Text className="text-xs font-semibold text-white">
          {submitVerification.isPending
            ? "Submitting…"
            : "Submit for verification"}
        </Text>
      </Pressable>
      {submitVerification.isError ? (
        <Notice
          tone="error"
          title="Verification submission failed"
          body={submitVerification.error?.message ?? "Try again."}
        />
      ) : null}
      {submitVerification.data ? (
        <Notice
          tone={statusTone(submitVerification.data.status)}
          title={`Verification status: ${submitVerification.data.status}`}
          body="The decision is automatic in v1: valid ID format plus a plausible account name verifies immediately."
        />
      ) : null}
    </SectionCard>
  );
}

export default function VerificationScreen() {
  return (
    <ScreenContainer className="px-4 pb-6">
      <ScrollView
        contentContainerStyle={{ gap: 16, paddingTop: 20, paddingBottom: 24 }}
      >
        <BackHeader
          title="Identity verification"
          subtitle="Verified riders get a badge that drivers see on every dispatch offer (R1)."
        />
        <SectionCard
          title="My verification status"
          subtitle="As reported by the platform verification record."
        >
          <StatusCard />
        </SectionCard>
        <NamePrecheckCard />
        <SubmitCard />
      </ScrollView>
    </ScreenContainer>
  );
}
