/**
 * Courier earnings (P4-N, WS-NATIVE courier).
 *
 * OFFLINE BOUNDARY: the net earnings summary
 * (pricingTransparency.getMyNetEarningsSummary) is ONLINE-ONLY. When
 * disconnected, the screen renders synced driver performance scores and
 * review counts from the courier_assignments replica instead. No writes on
 * this screen.
 *
 * MONEY: all earnings figures are integer MINOR units (kobo) rendered via
 * lib/money.ts formatMinor; BIGINT-over-wire strings normalize through
 * toNumber (integer-safe) — never float math.
 */
import { Pressable, ScrollView, Text, View } from "react-native";
import { router } from "expo-router";

import {
  EmptyState,
  LoadingSkeleton,
  MetricPill,
  SectionCard,
} from "@/components/mobile/operations-ui";
import { ScreenContainer } from "@/components/screen-container";
import { useAuth } from "@/hooks/use-auth";
import { useCourierEarnings } from "@/lib/courierApi";
import { useConsumerDataMode, useReplicaQuery } from "@/lib/consumerOffline";
import { formatMinor, toNumber } from "@/lib/money";

interface PerformanceScoreRow {
  driver_id: number;
  score: string;
  tier: string;
  acceptance_rate: string;
  completion_rate: string;
  total_deliveries: number;
  on_time_deliveries: number;
  last_calculated_at: string;
}

export default function CourierEarningsScreen() {
  const { isAuthenticated } = useAuth();
  const { connected } = useConsumerDataMode();
  const earnings = useCourierEarnings();
  const scores = useReplicaQuery(
    isAuthenticated && !connected,
    `SELECT driver_id, score, tier, acceptance_rate, completion_rate,
            total_deliveries, on_time_deliveries, last_calculated_at
       FROM driver_performance_scores
      LIMIT 1`,
    [],
    (row: PerformanceScoreRow) => row,
  );

  if (!isAuthenticated) {
    return (
      <ScreenContainer className="px-4 pb-6">
        <View className="pt-10">
          <EmptyState
            title="Sign in as a courier"
            body="Earnings require an authenticated courier session."
          />
        </View>
      </ScreenContainer>
    );
  }

  const summary = earnings.data;

  return (
    <ScreenContainer className="px-4 pb-6">
      <ScrollView contentContainerStyle={{ gap: 16, paddingTop: 20, paddingBottom: 24 }}>
        <View>
          <Text className="text-3xl font-bold text-foreground">Earnings</Text>
          <Text className="mt-2 text-sm leading-6 text-muted">
            Transparent net earnings across your recent offer window — gross,
            deadhead cost, platform fee, and net to you.
          </Text>
        </View>

        {!connected ? (
          <View className="rounded-[20px] border border-warning/40 bg-warning/10 px-4 py-3">
            <Text className="text-sm font-semibold text-warning">Offline</Text>
            <Text className="mt-1 text-sm leading-6 text-muted">
              Live earnings need a connection. Synced performance scores are
              shown below instead.
            </Text>
          </View>
        ) : null}

        <SectionCard
          title={summary ? `Last ${summary.windowDays} days` : "Earnings summary"}
          subtitle="Net = gross − deadhead − platform fee (integer kobo)."
        >
          {!connected ? (
            scores.rows.length === 0 ? (
              <EmptyState
                title="No synced scores"
                body="Connect once to sync performance history for offline viewing."
              />
            ) : (
              <View className="gap-3">
                {scores.rows.map((score) => (
                  <View
                    key={score.driver_id}
                    className="rounded-[20px] border border-border bg-background/70 px-4 py-3"
                  >
                    <View className="flex-row items-center justify-between">
                      <Text className="text-sm font-semibold text-foreground">
                        Tier {score.tier} · score {score.score}
                      </Text>
                      <Text className="text-xs text-muted">
                        {new Date(score.last_calculated_at).toLocaleDateString()}
                      </Text>
                    </View>
                    <Text className="mt-1 text-xs text-muted">
                      Acceptance {score.acceptance_rate} · completion {score.completion_rate} ·{" "}
                      {score.on_time_deliveries}/{score.total_deliveries} on time
                    </Text>
                  </View>
                ))}
              </View>
            )
          ) : earnings.isLoading ? (
            <LoadingSkeleton rows={3} />
          ) : !summary ? (
            <EmptyState
              title="No earnings yet"
              body="Complete offers to build your earnings summary."
            />
          ) : (
            <View className="gap-3">
              <View className="flex-row flex-wrap gap-3">
                <MetricPill label="Offers" value={summary.offers} />
                <MetricPill label="Days" value={summary.windowDays} />
              </View>
              <View className="gap-2 rounded-[20px] border border-border bg-background/70 px-4 py-3">
                <Row label="Gross fares" value={formatMinor(toNumber(summary.grossMinor), summary.currency)} />
                <Row label="Deadhead cost" value={`−${formatMinor(toNumber(summary.deadheadMinor), summary.currency)}`} />
                <Row label="Platform fee" value={`−${formatMinor(toNumber(summary.platformFeeMinor), summary.currency)}`} />
                <Row label="Net to you" value={formatMinor(toNumber(summary.netToDriverMinor), summary.currency)} />
              </View>
            </View>
          )}
        </SectionCard>

        <Pressable
          onPress={() => router.push("/courier/offers" as never)}
          className="rounded-full bg-background px-4 py-3"
        >
          <Text className="text-center text-xs font-semibold text-foreground">
            Back to offers
          </Text>
        </Pressable>
      </ScrollView>
    </ScreenContainer>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row items-center justify-between gap-3">
      <Text className="text-sm text-muted">{label}</Text>
      <Text className="text-sm font-semibold text-foreground">{value}</Text>
    </View>
  );
}
