import { useRouter } from "expo-router";
import { useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";

import { SectionCard } from "@/components/mobile/operations-ui";
import { ScreenContainer } from "@/components/screen-container";
import {
  BackHeader,
  Notice,
  QueryErrorNotice,
  StatusPill,
} from "@/components/trust/ui";
import {
  type ConsultationRow,
  type ConsultationStatus,
  useConsultations,
} from "@/lib/trustApi";
import { formatDateTime } from "@/lib/money";

/**
 * Worker council consultations (R5). Policy changes affecting drivers and
 * couriers are tabled here before activation; members respond inside the SLA
 * window. Native port of the PWA's client/src/pages/WorkerCouncil.tsx list.
 */

const statusFilters: { key: ConsultationStatus | undefined; label: string }[] = [
  { key: undefined, label: "All" },
  { key: "open", label: "Open" },
  { key: "activated", label: "Activated" },
  { key: "closed", label: "Closed" },
  { key: "withdrawn", label: "Withdrawn" },
];

function statusTone(status: ConsultationStatus) {
  if (status === "open") return "info" as const;
  if (status === "activated") return "success" as const;
  if (status === "withdrawn") return "error" as const;
  return "neutral" as const;
}

function slaLabel(consultation: ConsultationRow) {
  if (!consultation.response_sla_at || consultation.status !== "open") {
    return null;
  }
  const remainingMs =
    new Date(consultation.response_sla_at).getTime() - Date.now();
  if (remainingMs <= 0) {
    return { text: "Response window elapsed", overdue: true };
  }
  const hours = Math.floor(remainingMs / 3_600_000);
  if (hours >= 48) {
    return {
      text: `${Math.floor(hours / 24)}d ${hours % 24}h to respond`,
      overdue: false,
    };
  }
  const minutes = Math.floor((remainingMs % 3_600_000) / 60_000);
  return { text: `${hours}h ${minutes}m to respond`, overdue: false };
}

function ConsultationCard({ consultation }: { consultation: ConsultationRow }) {
  const router = useRouter();
  const sla = slaLabel(consultation);

  return (
    <View className="gap-3 rounded-[28px] border border-border bg-surface px-4 py-4">
      <View className="flex-row flex-wrap items-center gap-2">
        <StatusPill label={consultation.kind} tone="neutral" />
        <StatusPill
          label={consultation.status}
          tone={statusTone(consultation.status)}
        />
        {sla ? (
          <StatusPill
            label={sla.text}
            tone={sla.overdue ? "error" : "warning"}
          />
        ) : null}
      </View>
      <Text className="text-lg font-semibold leading-6 text-foreground">
        {consultation.title}
      </Text>
      <View className="flex-row flex-wrap gap-x-4 gap-y-1">
        <Text className="text-xs text-muted">
          Opened {formatDateTime(consultation.created_at)}
        </Text>
        <Text className="text-xs text-muted">
          {consultation.activated_at
            ? `Activated ${formatDateTime(consultation.activated_at)}`
            : "Pending council outcome"}
        </Text>
        <Text className="text-xs text-muted">
          {consultation.response_count} response
          {consultation.response_count === 1 ? "" : "s"}
        </Text>
      </View>
      <Pressable
        onPress={() =>
          router.push({
            pathname: "/trust/council/[id]",
            params: { id: consultation.id },
          })
        }
        accessibilityRole="button"
        className="self-start rounded-full bg-accent2 px-4 py-2"
      >
        <Text className="text-xs font-semibold text-white">
          Review and respond
        </Text>
      </Pressable>
    </View>
  );
}

export default function CouncilScreen() {
  const [statusFilter, setStatusFilter] = useState<
    ConsultationStatus | undefined
  >(undefined);
  const consultations = useConsultations(statusFilter);

  return (
    <ScreenContainer className="px-4 pb-6">
      <FlatList
        data={consultations.data ?? []}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ gap: 16, paddingTop: 20, paddingBottom: 24 }}
        ListHeaderComponent={
          <View className="gap-4">
            <BackHeader
              title="Worker council"
              subtitle="Consultations that bind the platform. Review the payload, respond within the SLA window, and track whether the platform honoured the outcome (R5)."
            />
            <View className="flex-row flex-wrap gap-2">
              {statusFilters.map((filter) => (
                <Pressable
                  key={filter.label}
                  onPress={() => setStatusFilter(filter.key)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: statusFilter === filter.key }}
                  className={
                    statusFilter === filter.key
                      ? "rounded-full bg-accent2 px-4 py-2"
                      : "rounded-full bg-surface px-4 py-2"
                  }
                >
                  <Text
                    className={
                      statusFilter === filter.key
                        ? "text-xs font-semibold text-white"
                        : "text-xs font-semibold text-foreground"
                    }
                  >
                    {filter.label}
                  </Text>
                </Pressable>
              ))}
            </View>
            {consultations.isError ? (
              <QueryErrorNotice
                resource="council consultations"
                message={consultations.error?.message}
                onRetry={() => void consultations.refetch()}
                retrying={consultations.isRefetching}
              />
            ) : consultations.isLoading ? (
              <Text className="text-sm text-muted">Loading consultations…</Text>
            ) : null}
          </View>
        }
        renderItem={({ item }) => <ConsultationCard consultation={item} />}
        ListEmptyComponent={
          consultations.isLoading || consultations.isError ? null : (
            <SectionCard title="No consultations in this state">
              <Notice
                tone="neutral"
                title="Nothing tabled right now"
                body="When the platform tables a policy change for worker consultation it will appear here with its response deadline."
              />
            </SectionCard>
          )
        }
      />
    </ScreenContainer>
  );
}
