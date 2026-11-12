/**
 * Merchant fulfillment inbox (P4-N, WS-NATIVE merchant).
 *
 * OFFLINE BOUNDARY:
 *   - READS: fulfillment requests are ONLINE-ONLY (commerce schema is not
 *     replicated). Disconnected, the screen renders the store's orders from
 *     the PowerSync merchant_store replica for context.
 *   - WRITES (merchantSelfServe.transitionMyFulfillment — accept / reject /
 *     ready) are ONLINE-ONLY with idempotency keys. Offline attempts queue a
 *     SyncAction in the operator outbox (lane merchant_catalog) for manual
 *     replay from the Queue tab.
 *
 * Provider identity resolves from the replica service_providers row (the
 * merchant_store bucket pins the session token's provider_id).
 */
import { useState } from "react";
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
import { useConsumerDataMode, useReplicaQuery } from "@/lib/consumerOffline";
import { formatMajorAmount } from "@/lib/consumer";
import {
  buildMerchantQueuedAction,
  mapMerchantApiError,
  mapMerchantReplicaProviderRow,
  MERCHANT_PROVIDER_SQL,
  merchantFulfillmentActions,
  newMerchantIdempotencyKey,
  useMyFulfillmentRequests,
  useTransitionMyFulfillment,
  type MerchantFulfillmentRequest,
  type MerchantReplicaProviderRow,
} from "@/lib/merchantApi";
import { queueAction } from "@/lib/mobile/offline-sync-sqlite";

interface MerchantOrderRow {
  id: string;
  order_number: string;
  status: string;
  total_amount: string;
  created_at: string;
}

export function useMerchantProvider(): {
  provider: ReturnType<typeof mapMerchantReplicaProviderRow> | null;
  loaded: boolean;
} {
  const { isAuthenticated } = useAuth();
  const replica = useReplicaQuery(
    isAuthenticated,
    MERCHANT_PROVIDER_SQL,
    [],
    mapMerchantReplicaProviderRow,
  );
  return { provider: replica.rows[0] ?? null, loaded: replica.loaded };
}

export default function MerchantOrdersScreen() {
  const { isAuthenticated, user } = useAuth();
  const { connected } = useConsumerDataMode();
  const { provider, loaded: providerLoaded } = useMerchantProvider();
  const providerId = provider?.providerId ?? null;

  const fulfillments = useMyFulfillmentRequests(providerId);
  const transition = useTransitionMyFulfillment();
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const replicaOrders = useReplicaQuery(
    isAuthenticated && !connected,
    `SELECT id, order_number, status, total_amount, created_at
       FROM orders
      ORDER BY created_at DESC
      LIMIT 25`,
    [],
    (row: MerchantOrderRow) => row,
  );

  const accountId = `merchant:${user?.id ?? "unknown"}`;

  const runTransition = async (
    request: MerchantFulfillmentRequest,
    action: "accept" | "reject" | "ready",
  ) => {
    if (!providerId) return;
    if (!connected) {
      try {
        const queued = buildMerchantQueuedAction({
          accountId,
          kind: "merchant_transition_fulfillment",
          providerId,
          fulfillmentId: request.id,
          action,
        });
        await queueAction(queued);
        setNotice("Offline — transition queued in the outbox; replay from the Queue tab.");
      } catch {
        setNotice("Offline — could not queue the transition. Reconnect and retry.");
      }
      return;
    }
    setBusyId(request.id);
    setNotice(null);
    try {
      const result = await transition.mutateAsync({
        fulfillmentId: request.id,
        action,
        idempotencyKey: newMerchantIdempotencyKey("mft"),
      });
      setNotice(
        result.replayed
          ? "Already applied (idempotent replay)."
          : `${action} applied — now ${result.state}.`,
      );
      await fulfillments.refetch();
    } catch (error) {
      setNotice(`Transition failed (${mapMerchantApiError(error)}).`);
    } finally {
      setBusyId(null);
    }
  };

  if (!isAuthenticated) {
    return (
      <ScreenContainer className="px-4 pb-6">
        <View className="pt-10">
          <EmptyState
            title="Sign in as a merchant"
            body="The store console requires an authenticated merchant session."
          />
        </View>
      </ScreenContainer>
    );
  }

  if (providerLoaded && !provider) {
    return (
      <ScreenContainer className="px-4 pb-6">
        <View className="pt-10">
          <EmptyState
            title="No store linked"
            body="This account has no merchant store on this device. Merchant sessions sync their store identity automatically."
          />
        </View>
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer className="px-4 pb-6">
      <ScrollView contentContainerStyle={{ gap: 16, paddingTop: 20, paddingBottom: 24 }}>
        <View>
          <Text className="text-3xl font-bold text-foreground">Store Orders</Text>
          <Text className="mt-2 text-sm leading-6 text-muted">
            Accept, reject, and mark fulfillment requests ready. Offline, your
            store's orders remain visible from the synced replica.
          </Text>
        </View>

        {provider ? (
          <View className="flex-row flex-wrap gap-3">
            <MetricPill label="Store" value={provider.name} />
            <MetricPill label="Status" value={provider.status} />
          </View>
        ) : null}

        {!connected ? (
          <View className="self-start rounded-full bg-background px-3 py-1">
            <Text className="text-[11px] font-semibold uppercase tracking-wide text-muted">
              Offline — synced replica (fulfillment paused)
            </Text>
          </View>
        ) : null}

        {notice ? (
          <View className="rounded-[20px] border border-border bg-background/70 px-4 py-3">
            <Text className="text-sm text-foreground">{notice}</Text>
          </View>
        ) : null}

        <SectionCard
          title="Fulfillment requests"
          subtitle="Merchant-legal edges: requested → accept/reject; accepted → ready."
        >
          {!connected ? (
            replicaOrders.rows.length === 0 ? (
              <EmptyState
                title="No synced orders"
                body="Connect once to sync store orders for offline viewing."
              />
            ) : (
              <View className="gap-3">
                {replicaOrders.rows.map((order) => (
                  <View
                    key={order.id}
                    className="flex-row items-center justify-between rounded-[20px] border border-border bg-background/70 px-4 py-3"
                  >
                    <View className="flex-1">
                      <Text className="text-sm font-semibold text-foreground">
                        {order.order_number}
                      </Text>
                      <Text className="mt-1 text-xs text-muted">{order.status}</Text>
                    </View>
                    <Text className="text-sm font-semibold text-foreground">
                      {formatMajorAmount(order.total_amount)}
                    </Text>
                  </View>
                ))}
              </View>
            )
          ) : fulfillments.isLoading ? (
            <LoadingSkeleton rows={3} />
          ) : !fulfillments.data || fulfillments.data.length === 0 ? (
            <EmptyState
              title="No fulfillment requests"
              body="Consumer orders routed to your store appear here for action."
            />
          ) : (
            <View className="gap-3">
              {fulfillments.data.map((request) => {
                const actions = merchantFulfillmentActions(request.state);
                return (
                  <View
                    key={request.id}
                    className="rounded-[20px] border border-border bg-background/70 px-4 py-3"
                  >
                    <View className="flex-row items-center justify-between gap-3">
                      <View className="flex-1">
                        <Text className="text-sm font-semibold text-foreground">
                          Order {request.medusaOrderId}
                        </Text>
                        <Text className="mt-1 text-xs text-muted">
                          {request.state} · requested{" "}
                          {new Date(request.requestedAt).toLocaleString()}
                          {request.deliveryReference
                            ? ` · ref ${request.deliveryReference}`
                            : ""}
                        </Text>
                      </View>
                    </View>
                    {actions.length > 0 ? (
                      <View className="mt-3 flex-row flex-wrap gap-2">
                        {actions.map((action) => (
                          <Pressable
                            key={action}
                            onPress={() => void runTransition(request, action)}
                            disabled={busyId === request.id}
                            className={`rounded-full px-4 py-2 ${
                              action === "reject" ? "bg-background" : "bg-primary"
                            }`}
                          >
                            <Text
                              className={`text-xs font-semibold ${
                                action === "reject" ? "text-error" : "text-white"
                              }`}
                            >
                              {busyId === request.id
                                ? "Working…"
                                : action === "accept"
                                  ? "Accept"
                                  : action === "reject"
                                    ? "Reject"
                                    : "Mark ready"}
                            </Text>
                          </Pressable>
                        ))}
                      </View>
                    ) : (
                      <Text className="mt-2 text-xs text-muted">
                        No merchant actions in state {request.state} — dispatch is
                        operator-owned.
                      </Text>
                    )}
                  </View>
                );
              })}
            </View>
          )}
        </SectionCard>

        <View className="flex-row flex-wrap gap-3">
          <Pressable
            onPress={() => router.push("/merchant/catalog" as never)}
            className="rounded-full bg-accent2 px-4 py-3"
          >
            <Text className="text-xs font-semibold text-white">Catalog</Text>
          </Pressable>
          <Pressable
            onPress={() => router.push("/merchant/earnings" as never)}
            className="rounded-full bg-background px-4 py-3"
          >
            <Text className="text-xs font-semibold text-foreground">Earnings</Text>
          </Pressable>
        </View>
      </ScrollView>
    </ScreenContainer>
  );
}
