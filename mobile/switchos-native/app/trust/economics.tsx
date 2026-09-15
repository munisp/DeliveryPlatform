import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { SectionCard } from "@/components/mobile/operations-ui";
import { ScreenContainer } from "@/components/screen-container";
import {
  BackHeader,
  KeyValueRow,
  Notice,
  StatusPill,
  trustInputClass,
  trustPlaceholderColor,
} from "@/components/trust/ui";
import {
  useFareFloor,
  useFareFloorCheck,
  useTakeRate,
} from "@/lib/economicsSafetyApi";
import {
  formatBpsPercent,
  formatDateTime,
  formatMinor,
  toNumber,
} from "@/lib/money";

/**
 * Market economics view (R6 fare floor, R7 published take rate). Read-only
 * for drivers and riders — the operator mutations (cost index updates,
 * take-rate publishing, floor overrides) stay in the PWA operator console.
 * Shows the sustainability floor and the co-governed take rate that apply to
 * a market, plus a self-serve "would this fare meet the floor?" check.
 */

function FareFloorCard({ marketId }: { marketId: string }) {
  const floor = useFareFloor(marketId);

  if (floor.isLoading) {
    return <Text className="text-sm text-muted">Loading fare floor…</Text>;
  }
  if (floor.isError) {
    return (
      <Notice
        tone="warning"
        title="Fare floor unavailable"
        body={floor.error?.message ?? "Try again."}
      />
    );
  }
  if (!floor.data) {
    return (
      <Notice
        tone="neutral"
        title="No fare floor published"
        body="No active fare floor policy exists for this market yet."
      />
    );
  }

  const policy = floor.data;
  return (
    <View className="gap-3">
      <View className="flex-row flex-wrap items-center gap-2">
        <StatusPill
          label={policy.active ? "Active" : "Inactive"}
          tone={policy.active ? "success" : "warning"}
        />
        <StatusPill
          label={`Floor ${formatMinor(policy.floor_minor)}`}
          tone="info"
        />
      </View>
      <View className="rounded-[20px] border border-border bg-background/60 px-4 py-2">
        <KeyValueRow
          label="Fuel price index"
          value={formatMinor(policy.cost_index.fuel_price_minor)}
        />
        <KeyValueRow
          label="CPI index"
          value={formatBpsPercent(policy.cost_index.cpi_bp)}
        />
        <KeyValueRow
          label="Maintenance index"
          value={formatBpsPercent(policy.cost_index.maintenance_index_bp)}
        />
        <KeyValueRow
          label="Sustainability multiplier"
          value={`×${toNumber(policy.sustainability_multiplier).toFixed(3)}`}
        />
        <KeyValueRow
          label="Council consultation"
          value={policy.consultation_id ?? "—"}
        />
      </View>
      <Text className="text-xs text-muted">
        Source: {policy.cost_index.source} · updated{" "}
        {formatDateTime(policy.cost_index.updated_at)}
      </Text>
    </View>
  );
}

function TakeRateCard({ marketId }: { marketId: string }) {
  const takeRate = useTakeRate(marketId);

  if (takeRate.isLoading) {
    return <Text className="text-sm text-muted">Loading take rate…</Text>;
  }
  if (takeRate.isError) {
    return (
      <Notice
        tone="warning"
        title="Take rate unavailable"
        body={takeRate.error?.message ?? "Try again."}
      />
    );
  }
  if (!takeRate.data) {
    return (
      <Notice
        tone="neutral"
        title="No take rate published"
        body="No take-rate version has been published for this market yet."
      />
    );
  }

  return (
    <View className="gap-3">
      <StatusPill
        label={`${formatBpsPercent(takeRate.data.rate_bps)} of ${takeRate.data.basis}`}
        tone="info"
      />
      <View className="rounded-[20px] border border-border bg-background/60 px-4 py-2">
        <KeyValueRow label="Registry version" value={`v${takeRate.data.version}`} />
        <KeyValueRow
          label="Effective from"
          value={formatDateTime(takeRate.data.effective_from)}
        />
        <KeyValueRow
          label="Council consultation"
          value={takeRate.data.consultation_id ?? "—"}
        />
      </View>
      <Text className="text-xs leading-5 text-muted">
        Take-rate changes are co-governed: publishing requires an activated
        worker-council &quot;commission&quot; consultation.
      </Text>
    </View>
  );
}

function FloorCheckCard({ marketId }: { marketId: string }) {
  const [nairaInput, setNairaInput] = useState("");
  const [checkRequested, setCheckRequested] = useState(false);
  const fareMinor = (() => {
    const naira = Number(nairaInput);
    return nairaInput.trim() && Number.isFinite(naira) && naira >= 0
      ? Math.round(naira * 100)
      : null;
  })();
  const check = useFareFloorCheck(marketId, fareMinor, checkRequested);

  return (
    <View className="gap-3">
      <Text className="text-sm leading-5 text-muted">
        Enter a proposed fare in naira to check it against the market floor.
      </Text>
      <View className="flex-row items-center gap-2">
        <TextInput
          value={nairaInput}
          onChangeText={(value) => {
            setNairaInput(value);
            setCheckRequested(false);
          }}
          placeholder="Fare in ₦ (e.g. 2500)"
          placeholderTextColor={trustPlaceholderColor}
          keyboardType="decimal-pad"
          className={`${trustInputClass} flex-1`}
        />
        <Pressable
          onPress={() => setCheckRequested(true)}
          disabled={!marketId || fareMinor === null || check.isRefetching}
          className="rounded-full bg-primary px-4 py-3 disabled:opacity-50"
        >
          <Text className="text-xs font-semibold text-white">
            {check.isRefetching ? "Checking…" : "Check"}
          </Text>
        </Pressable>
      </View>
      {checkRequested && check.isError ? (
        <Notice
          tone="warning"
          title="Floor check failed"
          body={check.error?.message ?? "Try again."}
        />
      ) : null}
      {checkRequested && check.data ? (
        <Notice
          tone={check.data.allowed ? "success" : "warning"}
          title={
            check.data.allowed
              ? `Fare allowed${check.data.floorMinor !== null ? ` — meets the floor of ${formatMinor(check.data.floorMinor)}` : " — no floor published"}`
              : `Fare blocked — below the floor of ${formatMinor(check.data.floorMinor ?? 0)}`
          }
          body={
            check.data.requiresOverride
              ? "This fare requires a recorded operator override to proceed."
              : undefined
          }
        />
      ) : null}
    </View>
  );
}

export default function EconomicsScreen() {
  const [marketInput, setMarketInput] = useState("");
  const marketId = marketInput.trim();

  return (
    <ScreenContainer className="px-4 pb-6">
      <ScrollView
        contentContainerStyle={{ gap: 16, paddingTop: 20, paddingBottom: 24 }}
      >
        <BackHeader
          title="Market economics"
          subtitle="The cost-indexed fare floor and the published take rate for your market (R6/R7) — the numbers behind every fare you see."
        />

        <SectionCard
          title="Market"
          subtitle="Enter a market ID (zone) to load its economics policy."
        >
          <TextInput
            value={marketInput}
            onChangeText={setMarketInput}
            placeholder="Market ID"
            placeholderTextColor={trustPlaceholderColor}
            autoCapitalize="none"
            className={trustInputClass}
          />
        </SectionCard>

        {marketId ? (
          <>
            <SectionCard
              title="Fare floor and cost index"
              subtitle="Floor = fuel price × CPI × maintenance × sustainability multiplier."
            >
              <FareFloorCard marketId={marketId} />
            </SectionCard>
            <SectionCard
              title="Published take rate"
              subtitle="What the platform keeps, by registry version."
            >
              <TakeRateCard marketId={marketId} />
            </SectionCard>
            <SectionCard
              title="Check a fare against the floor"
              subtitle="Self-serve check — no override is recorded from this screen."
            >
              <FloorCheckCard marketId={marketId} />
            </SectionCard>
          </>
        ) : (
          <Notice
            tone="neutral"
            title="Enter a market ID above"
            body="The fare floor, take rate, and floor check load once a market is selected."
          />
        )}
      </ScrollView>
    </ScreenContainer>
  );
}
