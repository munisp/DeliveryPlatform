/**
 * Merchant earnings (P4-N, WS-NATIVE merchant).
 *
 * OFFLINE BOUNDARY: merchantSelfServe.myEarnings is ONLINE-ONLY (commerce
 * aggregates are not replicated). Disconnected, the screen renders counts +
 * gross summed from the merchant_store replica orders (total_amount TEXT
 * major → integer minor via parseMajorToMinor; never floats). No writes on
 * this screen.
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
import { formatMajorAmount, parseMajorToMinor } from "@/lib/consumer";
import { useConsumerDataMode, useReplicaQuery } from "@/lib/consumerOffline";
import { formatMinor } from "@/lib/money";
import { useMerchantEarnings } from "@/lib/merchantApi";
import { useMerchantProvider } from "./orders";

interface MerchantOrderAmountRow {
  id: string;
  status: string;
  total_amount: string;
}

export default function MerchantEarningsScreen() {
  const { isAuthenticated } = useAuth();
  const { connected } = useConsumerDataMode();
  const { provider } = useMerchantProvider();
  const providerId = provider?.providerId ?? null;

  const earnings = useMerchantEarnings(connected ? providerId : null);
  const replicaOrders = useReplicaQuery(
    isAuthenticated && !connected,
    `SELECT id, status, total_amount FROM orders LIMIT 200`,
    [],
    (row: MerchantOrderAmountRow) => row,
  );

  if (!isAuthenticated) {
    return (
      <ScreenContainer className="px-4 pb-6">
        <View className="pt-10">
          <EmptyState
            title="Sign in as a merchant"
            body="Earnings require an authenticated merchant session."
          />
        </View>
      </ScreenContainer>
    );
  }

  // Offline estimate: integer minor sum of synced order totals.
  let offlineGrossMinor = 0;
  let offlineDelivered = 0;
  for (const order of replicaOrders.rows) {
    const minor = parseMajorToMinor(order.total_amount);
    if (minor !== null && minor > 0) {
      offlineGrossMinor += minor;
      if (order.status === "delivered") offlineDelivered += 1;
    }
  }

  return (
    <ScreenContainer className="px-4 pb-6">
      <ScrollView contentContainerStyle={{ gap: 16, paddingTop: 20, paddingBottom: 24 }}>
        <View>
          <Text className="text-3xl font-bold text-foreground">Store Earnings</Text>
          <Text className="mt-2 text-sm leading-6 text-muted">
            Order and fulfillment aggregates for your store. Offline figures
            are estimates from the synced replica.
          </Text>
        </View>

        {!connected ? (
          <View className="rounded-[20px] border border-warning/40 bg-warning/10 px-4 py-3">
            <Text className="text-sm font-semibold text-warning">Offline estimate</Text>
            <Text className="mt-1 text-sm leading-6 text-muted">
              Live aggregates need a connection; figures below are summed from
              synced orders.
            </Text>
          </View>
        ) : null}

        <SectionCard
          title="Summary"
          subtitle={connected ? "Live aggregates from the platform." : "Estimated from synced orders."}
        >
          {connected ? (
            earnings.isLoading ? (
              <LoadingSkeleton rows={3} />
            ) : !earnings.data ? (
              <EmptyState
                title="No earnings yet"
                body="Delivered orders build your gross earnings."
              />
            ) : (
              <View className="gap-3">
                <View className="flex-row flex-wrap gap-3">
                  <MetricPill label="Orders" value={earnings.data.orderCount} />
                  <MetricPill label="Delivered" value={earnings.data.deliveredOrderCount} />
                  <MetricPill
                    label="Payout"
                    value={earnings.data.payoutConfigured ? "Configured" : "Missing"}
                  />
                </View>
                <View className="rounded-[20px] border border-border bg-background/70 px-4 py-3">
                  <Text className="text-xs uppercase tracking-wide text-muted">
                    Gross (delivered orders)
                  </Text>
                  <Text className="mt-2 text-2xl font-semibold text-foreground">
                    {formatMajorAmount(
                      earnings.data.grossDeliveredMajor,
                      earnings.data.currency,
                    )}
                  </Text>
                </View>
                <View className="gap-2 rounded-[20px] border border-border bg-background/70 px-4 py-3">
                  <Text className="text-xs uppercase tracking-wide text-muted">
                    Fulfillments by state
                  </Text>
                  {Object.entries(earnings.data.fulfillmentsByState).map(([state, count]) => (
                    <View key={state} className="flex-row items-center justify-between">
                      <Text className="text-sm text-muted">{state}</Text>
                      <Text className="text-sm font-semibold text-foreground">{count}</Text>
                    </View>
                  ))}
                </View>
              </View>
            )
          ) : replicaOrders.rows.length === 0 ? (
            <EmptyState
              title="No synced orders"
              body="Connect once to sync store orders for offline estimates."
            />
          ) : (
            <View className="gap-3">
              <View className="flex-row flex-wrap gap-3">
                <MetricPill label="Synced orders" value={replicaOrders.rows.length} />
                <MetricPill label="Delivered" value={offlineDelivered} />
              </View>
              <View className="rounded-[20px] border border-border bg-background/70 px-4 py-3">
                <Text className="text-xs uppercase tracking-wide text-muted">
                  Gross (synced orders, estimate)
                </Text>
                <Text className="mt-2 text-2xl font-semibold text-foreground">
                  {formatMinor(offlineGrossMinor)}
                </Text>
              </View>
            </View>
          )}
        </SectionCard>

        <Pressable
          onPress={() => router.push("/merchant/orders" as never)}
          className="rounded-full bg-background px-4 py-3"
        >
          <Text className="text-center text-xs font-semibold text-foreground">
            Back to orders
          </Text>
        </Pressable>
      </ScrollView>
    </ScreenContainer>
  );
}
