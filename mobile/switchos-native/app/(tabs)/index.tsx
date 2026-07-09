import { useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import {
  ActionCard,
  ConnectivityBanner,
  EmptyState,
  LoadingSkeleton,
  MetricPill,
  SectionCard,
  SnapshotCard,
  SyncStatusBar,
} from "@/components/mobile/operations-ui";
import { ScreenContainer } from "@/components/screen-container";
import { buildRecentOperationalSeries, buildSparkline, trendDirection } from "@/lib/mobile/analytics";
import { useMobileApp } from "@/lib/mobile/provider";
import { formatFreshness } from "@/lib/mobile/workspace";

export default function HomeScreen() {
  const {
    connectivityMode,
    isInternetReachable,
    snapshot,
    syncing,
    lastSyncedAt,
    refreshSnapshot,
    queueAction,
  } = useMobileApp();

  const topInventory = snapshot.inventory[0];
  const topDispatch = snapshot.dispatch[0];
  const topMerchant = snapshot.merchants[0];
  const topLoyalty = snapshot.loyalty[0];

  const pulseDelta = useMemo(() => {
    const criticalTotal = (snapshot.summary.criticalInventory ?? 0) + (snapshot.summary.criticalDispatch ?? 0) + (snapshot.summary.criticalMerchantSignals ?? 0);
    if (criticalTotal === 0 && (snapshot.summary.loyaltyAttention ?? 0) === 0) {
      return "No critical operational deltas are currently cached.";
    }
    return `${snapshot.summary.criticalInventory ?? 0} inventory, ${snapshot.summary.criticalDispatch ?? 0} dispatch, ${snapshot.summary.criticalMerchantSignals ?? 0} merchant, and ${snapshot.summary.loyaltyAttention ?? 0} loyalty items need attention.`;
  }, [snapshot.summary]);

  const inventorySeries = buildRecentOperationalSeries(snapshot.summary.criticalInventory ?? 0, snapshot.summary.queueCount, snapshot.summary.failedCount);
  const dispatchSeries = buildRecentOperationalSeries(snapshot.summary.criticalDispatch ?? 0, snapshot.summary.queueCount, snapshot.summary.failedCount);
  const merchantSeries = buildRecentOperationalSeries(snapshot.summary.criticalMerchantSignals ?? 0, snapshot.summary.queueCount, snapshot.summary.failedCount);

  return (
    <ScreenContainer className="px-4 pb-6">
      <ScrollView contentContainerStyle={{ gap: 16, paddingTop: 20, paddingBottom: 24 }}>
        <View>
          <Text className="text-3xl font-bold text-foreground">Command Center</Text>
          <Text className="mt-2 text-sm leading-6 text-muted">
            Monitor delivery resilience, queue field actions, and keep SwitchOS moving even through intermittent connectivity.
          </Text>
        </View>

        <ConnectivityBanner mode={connectivityMode} reachable={isInternetReachable} />
        <SyncStatusBar syncing={syncing} lastSyncedAt={lastSyncedAt} queueCount={snapshot.summary.queueCount} />

        <SectionCard title="Operational KPI strip" subtitle="Track the most important cross-tab counts at a glance before diving into a specific workflow.">
          <View className="flex-row flex-wrap gap-3">
            <MetricPill label="Inventory risk" value={snapshot.summary.criticalInventory ?? 0} />
            <MetricPill label="Dispatch pressure" value={snapshot.summary.criticalDispatch ?? 0} />
            <MetricPill label="Merchant gaps" value={snapshot.summary.criticalMerchantSignals ?? 0} />
            <MetricPill label="Loyalty attention" value={snapshot.summary.loyaltyAttention ?? 0} />
          </View>
          <View className="gap-3">
            <TrendRow label="Inventory" sparkline={buildSparkline(inventorySeries)} direction={trendDirection(inventorySeries)} />
            <TrendRow label="Dispatch" sparkline={buildSparkline(dispatchSeries)} direction={trendDirection(dispatchSeries)} />
            <TrendRow label="Merchant" sparkline={buildSparkline(merchantSeries)} direction={trendDirection(merchantSeries)} />
          </View>
        </SectionCard>

        <SectionCard title="Operational pulse" subtitle={snapshot.summary.logisticsHeadline}>
          <View className="flex-row flex-wrap gap-3">
            <MetricPill label="Services" value={snapshot.summary.serviceCount} />
            <MetricPill label="Queued actions" value={snapshot.summary.queueCount} />
            <MetricPill label="Failed syncs" value={snapshot.summary.failedCount} />
          </View>
          <View className="rounded-[20px] border border-border bg-background/70 px-4 py-3">
            <Text className="text-xs uppercase tracking-[1px] text-muted">Refresh delta summary</Text>
            <Text className="mt-2 text-sm font-semibold text-foreground">{pulseDelta}</Text>
            <Text className="mt-1 text-sm text-muted">Snapshot freshness: {snapshot.summary.freshnessLabel}</Text>
          </View>
          <ActionCard
            eyebrow="Snapshot"
            title="Refresh operational payloads"
            body="Pull the latest logistics, dispatch, merchant, and loyalty state from configured backend snapshot endpoints."
            cta={syncing ? "Refreshing" : "Refresh now"}
            onPress={() => void refreshSnapshot()}
          />
        </SectionCard>

        {syncing && !topInventory && !topDispatch && !topMerchant && !topLoyalty ? (
          <LoadingSkeleton rows={6} />
        ) : topInventory || topDispatch || topMerchant ? (
          <View className="gap-4">
            {topInventory ? (
              <SnapshotCard
                eyebrow="Logistics"
                title={topInventory.name}
                body={topInventory.note || "Inventory posture synced from the latest logistics payload."}
                accentLabel="Coverage"
                accentValue={topInventory.stockCoverageHours ? `${topInventory.stockCoverageHours}h · ${formatFreshness(topInventory.freshnessMinutes)}` : formatFreshness(topInventory.freshnessMinutes)}
                risk={topInventory.risk}
              />
            ) : null}
            {topDispatch ? (
              <SnapshotCard
                eyebrow="Dispatch"
                title={topDispatch.name}
                body={topDispatch.suggestedAction || topDispatch.note || "Dispatch posture synced from the latest field payload."}
                accentLabel="Driver balance"
                accentValue={topDispatch.driverBalance ? `${topDispatch.driverBalance} · ${formatFreshness(topDispatch.freshnessMinutes)}` : formatFreshness(topDispatch.freshnessMinutes)}
                risk={topDispatch.pressure}
              />
            ) : null}
            {topMerchant ? (
              <SnapshotCard
                eyebrow="Growth"
                title={topMerchant.merchantName}
                body={topMerchant.nextAction || "Merchant posture synced from platform growth payloads."}
                accentLabel="Readiness"
                accentValue={topMerchant.campaignReadiness ? `${topMerchant.campaignReadiness} · ${formatFreshness(topMerchant.freshnessMinutes)}` : formatFreshness(topMerchant.freshnessMinutes)}
                risk={topMerchant.benchmarkStatus}
              />
            ) : null}
            {topLoyalty ? (
              <SnapshotCard
                eyebrow="Loyalty"
                title={topLoyalty.customerLabel}
                body={topLoyalty.recommendedAction || "Loyalty safeguard ready for review."}
                accentLabel="Last touchpoint"
                accentValue={topLoyalty.lastTouchpoint ? `${topLoyalty.lastTouchpoint} · ${formatFreshness(topLoyalty.freshnessMinutes)}` : formatFreshness(topLoyalty.freshnessMinutes)}
                risk={topLoyalty.status}
              />
            ) : null}
          </View>
        ) : (
          <SectionCard title="No operational snapshot cached" subtitle="Guide the device back to a recoverable live-data state from here if the command center is empty.">
            <EmptyState
              title="No operational snapshot cached"
              body="Add live snapshot endpoint URLs in the Queue tab settings, then refresh to pull logistics, dispatch, merchant, and loyalty payloads into the command center."
            />
            <View className="flex-row flex-wrap gap-3">
              <Pressable onPress={() => void queueAction("replenishment", { title: "Recover empty snapshot", note: "Prompt operator to configure endpoint settings." })} className="rounded-full bg-primary px-4 py-3">
                <Text className="text-xs font-semibold text-white">Queue recovery reminder</Text>
              </Pressable>
              <Pressable onPress={() => void refreshSnapshot()} className="rounded-full bg-background px-4 py-3">
                <Text className="text-xs font-semibold text-foreground">Retry refresh</Text>
              </Pressable>
            </View>
          </SectionCard>
        )}

        <ActionCard
          eyebrow="Logistics"
          title="Queue replenishment review"
          body="Capture an urgent replenishment decision locally so it can be replayed when the network returns."
          cta="Queue action"
          onPress={() => void queueAction("replenishment", { title: "Replenishment review", note: "Queued from command center.", priority: "high" })}
        />
        <ActionCard
          eyebrow="Dispatch"
          title="Queue zone rebalance"
          body="Record a rebalance instruction for driver coverage without depending on immediate API reachability."
          cta="Queue dispatch"
          onPress={() => void queueAction("dispatch_rebalance", { title: "Zone rebalance", note: "Queued from command center.", priority: "high" })}
        />
        <ActionCard
          eyebrow="Growth"
          title="Queue loyalty intervention"
          body="Capture a retention response for later sync whenever a loyalty anomaly appears in the field."
          cta="Queue outreach"
          onPress={() => void queueAction("loyalty_intervention", { title: "Loyalty intervention", note: "Queued from command center.", priority: "normal" })}
        />
      </ScrollView>
    </ScreenContainer>
  );
}

function TrendRow({
  label,
  sparkline,
  direction,
}: {
  label: string;
  sparkline: string;
  direction: "up" | "down" | "steady";
}) {
  return (
    <View className="rounded-[18px] border border-border bg-background/70 px-4 py-3">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="text-sm font-semibold text-foreground">{label}</Text>
        <Text className="text-xs font-semibold uppercase tracking-[1px] text-muted">{direction}</Text>
      </View>
      <Text className="mt-2 text-lg tracking-[2px] text-foreground">{sparkline}</Text>
    </View>
  );
}
