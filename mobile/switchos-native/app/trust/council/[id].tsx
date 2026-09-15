import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { SectionCard } from "@/components/mobile/operations-ui";
import { ScreenContainer } from "@/components/screen-container";
import {
  BackHeader,
  KeyValueRow,
  Notice,
  QueryErrorNotice,
  StatusPill,
  trustInputClass,
  trustPlaceholderColor,
} from "@/components/trust/ui";
import {
  type ConsultationStance,
  useConsultation,
  useRespondToConsultation,
  useTrustInvalidation,
} from "@/lib/trustApi";
import { formatDateTime } from "@/lib/money";

/**
 * Council consultation detail (R5). Shows the tabled payload, the caller's
 * recorded response, and the member response composer. Only active council
 * members can respond — the server enforces membership.
 */

const stances: { key: ConsultationStance; label: string }[] = [
  { key: "support", label: "Support" },
  { key: "object", label: "Object" },
  { key: "comment", label: "Comment" },
];

function stanceTone(stance: ConsultationStance) {
  if (stance === "support") return "success" as const;
  if (stance === "object") return "error" as const;
  return "neutral" as const;
}

function statusTone(status: string) {
  if (status === "open") return "info" as const;
  if (status === "activated") return "success" as const;
  if (status === "withdrawn") return "error" as const;
  return "neutral" as const;
}

function RespondCard({ consultationId }: { consultationId: string }) {
  const respond = useRespondToConsultation();
  const invalidation = useTrustInvalidation();
  const [stance, setStance] = useState<ConsultationStance>("support");
  const [body, setBody] = useState("");

  const submit = () => {
    if (!body.trim()) return;
    respond.mutate(
      { id: consultationId, stance, body: body.trim() },
      {
        onSuccess: () => {
          setBody("");
          invalidation.council();
        },
      },
    );
  };

  return (
    <SectionCard
      title="Your response"
      subtitle="Recorded against your council membership for the public record."
    >
      <View className="flex-row flex-wrap gap-2">
        {stances.map((option) => (
          <Pressable
            key={option.key}
            onPress={() => setStance(option.key)}
            accessibilityRole="button"
            accessibilityState={{ selected: stance === option.key }}
            className={
              stance === option.key
                ? "rounded-full bg-accent2 px-4 py-2"
                : "rounded-full bg-background px-4 py-2"
            }
          >
            <Text
              className={
                stance === option.key
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
        value={body}
        onChangeText={setBody}
        placeholder="Explain your position for the record…"
        placeholderTextColor={trustPlaceholderColor}
        multiline
        className={`${trustInputClass} min-h-[96px]`}
      />
      <Pressable
        onPress={submit}
        disabled={respond.isPending || !body.trim()}
        className="self-start rounded-full bg-primary px-4 py-3 disabled:opacity-50"
      >
        <Text className="text-xs font-semibold text-white">
          {respond.isPending ? "Submitting…" : "Submit response"}
        </Text>
      </Pressable>
      {respond.isError ? (
        <Notice
          tone="error"
          title="Response could not be recorded"
          body={
            respond.error?.message ??
            "Only active council members can respond to consultations."
          }
        />
      ) : null}
      {respond.isSuccess ? (
        <Notice tone="success" title="Response recorded" />
      ) : null}
    </SectionCard>
  );
}

export default function ConsultationDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const detail = useConsultation(typeof id === "string" ? id : null);

  if (detail.isError) {
    return (
      <ScreenContainer className="px-4 pb-6">
        <View className="gap-4 pt-5">
          <BackHeader title="Consultation" />
          <QueryErrorNotice
            resource="consultation detail"
            message={detail.error?.message}
            onRetry={() => void detail.refetch()}
            retrying={detail.isRefetching}
          />
        </View>
      </ScreenContainer>
    );
  }

  const consultation = detail.data?.consultation;
  const myResponse = detail.data?.myResponse ?? null;

  return (
    <ScreenContainer className="px-4 pb-6">
      <ScrollView
        contentContainerStyle={{ gap: 16, paddingTop: 20, paddingBottom: 24 }}
      >
        <BackHeader
          title="Consultation detail"
          subtitle="Proposal payload, SLA window, and your council response."
        />
        {!consultation ? (
          <Text className="text-sm text-muted">Loading consultation…</Text>
        ) : (
          <>
            <SectionCard title={consultation.title}>
              <View className="flex-row flex-wrap gap-2">
                <StatusPill label={consultation.kind} tone="neutral" />
                <StatusPill
                  label={consultation.status}
                  tone={statusTone(consultation.status)}
                />
                {myResponse ? (
                  <StatusPill
                    label={`You responded: ${myResponse.stance}`}
                    tone={stanceTone(myResponse.stance)}
                  />
                ) : null}
              </View>
              <View className="rounded-[20px] border border-border bg-background/60 px-4 py-2">
                <KeyValueRow
                  label="Opened"
                  value={formatDateTime(consultation.created_at)}
                />
                <KeyValueRow
                  label="Response SLA"
                  value={formatDateTime(consultation.response_sla_at)}
                />
                <KeyValueRow
                  label="Activated"
                  value={
                    consultation.activated_at
                      ? formatDateTime(consultation.activated_at)
                      : "Not yet activated"
                  }
                />
                <KeyValueRow
                  label="Responses"
                  value={String(consultation.response_count)}
                />
              </View>
              <View className="gap-2">
                <Text className="text-xs font-semibold uppercase tracking-[1px] text-muted">
                  Proposal payload
                </Text>
                <ScrollView
                  className="max-h-72 rounded-[16px] border border-border bg-background px-3 py-2"
                  nestedScrollEnabled
                >
                  <Text className="font-mono text-xs leading-5 text-foreground">
                    {JSON.stringify(consultation.payload, null, 2)}
                  </Text>
                </ScrollView>
              </View>
            </SectionCard>

            {myResponse ? (
              <SectionCard
                title="My recorded response"
                subtitle="Your stance on the council record."
              >
                <View className="gap-2 rounded-[16px] border border-border bg-background/60 px-3 py-3">
                  <StatusPill
                    label={myResponse.stance}
                    tone={stanceTone(myResponse.stance)}
                  />
                  <Text className="text-sm leading-6 text-foreground">
                    {myResponse.body}
                  </Text>
                  <Text className="text-xs text-muted">
                    {formatDateTime(myResponse.created_at)}
                  </Text>
                </View>
              </SectionCard>
            ) : null}

            <RespondCard consultationId={consultation.id} />
          </>
        )}
      </ScrollView>
    </ScreenContainer>
  );
}
