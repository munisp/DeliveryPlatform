/**
 * Consumer orders (P2-C): myOrders list + detail with tracking timeline.
 *
 * OFFLINE BOUNDARY:
 *   - READS: online renders consumer.myOrders / myOrderDetail (timeline +
 *     ledger + support cases). Disconnected renders the PowerSync replica
 *     (orders + order_tracking_events tables) with an "offline replica"
 *     badge; detail shows the replicated tracking timeline only.
 *   - WRITES: rating (consumer.rateOrder) is ONLINE-ONLY — the rating row
 *     is replaced by a "requires connection" note while offline.
 */
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import {
  EmptyState,
  LoadingSkeleton,
  SectionCard,
} from "@/components/mobile/operations-ui";
import { ScreenContainer } from "@/components/screen-container";
import { useAuth } from "@/hooks/use-auth";
import {
  formatMajorAmount,
  isValidRating,
  sortTimeline,
  useMyOrderDetail,
  useMyOrders,
  useRateOrder,
  type ConsumerOrderSummary,
} from "@/lib/consumer";
import {
  mapReplicaOrderRow,
  mapReplicaTrackingRow,
  useConsumerDataMode,
  useReplicaQuery,
  type ReplicaOrderRow,
  type ReplicaTrackingRow,
} from "@/lib/consumerOffline";

export default function ConsumerOrdersScreen() {
  const { isAuthenticated } = useAuth();
  const { mode } = useConsumerDataMode();
  const live = useMyOrders();
  const replica = useReplicaQuery<ReplicaOrderRow, ReturnType<typeof mapReplicaOrderRow>>(
    mode === "offline-replica",
    `SELECT id, order_number, status, total_amount, created_at, updated_at,
            delivery_address, estimated_delivery_time, actual_delivery_time
       FROM orders
      ORDER BY created_at DESC
      LIMIT 25`,
    [],
    mapReplicaOrderRow,
  );

  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(null);

  if (!isAuthenticated) {
    return (
      <ScreenContainer className="px-4 pb-6">
        <View className="pt-10">
          <EmptyState
            title="Sign in to view orders"
            body="Order history requires an authenticated consumer session."
          />
        </View>
      </ScreenContainer>
    );
  }

  const offline = mode === "offline-replica";

  return (
    <ScreenContainer className="px-4 pb-6">
      <ScrollView contentContainerStyle={{ gap: 16, paddingTop: 20, paddingBottom: 24 }}>
        <View>
          <Text className="text-3xl font-bold text-foreground">My Orders</Text>
          <Text className="mt-2 text-sm leading-6 text-muted">
            Track orders end-to-end. Offline, this list renders the last synced
            replica; rating requires a connection.
          </Text>
        </View>

        {offline ? (
          <View className="self-start rounded-full bg-background px-3 py-1">
            <Text className="text-[11px] font-semibold uppercase tracking-wide text-muted">
              Offline — synced replica
            </Text>
          </View>
        ) : null}

        {offline ? (
          <ReplicaOrdersList
            rows={replica.rows}
            loading={!replica.loaded}
            selectedOrderId={selectedOrderId}
            onSelect={setSelectedOrderId}
          />
        ) : live.isLoading ? (
          <LoadingSkeleton rows={4} />
        ) : !live.data || live.data.length === 0 ? (
          <EmptyState
            title="No orders yet"
            body="Orders you place from the Shop screen appear here with live tracking."
          />
        ) : (
          <View className="gap-3">
            {live.data.map((order) => (
              <LiveOrderCard
                key={order.id}
                order={order}
                expanded={selectedOrderId === order.id}
                onToggle={() =>
                  setSelectedOrderId(selectedOrderId === order.id ? null : order.id)
                }
              />
            ))}
          </View>
        )}
      </ScrollView>
    </ScreenContainer>
  );
}

function LiveOrderCard({
  order,
  expanded,
  onToggle,
}: {
  order: ConsumerOrderSummary;
  expanded: boolean;
  onToggle: () => void;
}) {
  const detail = useMyOrderDetail(expanded ? order.id : null);
  const rate = useRateOrder();
  const [rated, setRated] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const submitRating = async (rating: number) => {
    if (!isValidRating(rating) || !detail.data) return;
    try {
      await rate.mutateAsync({
        orderId: order.id,
        overallRating: rating,
        punctualityRating: rating,
        professionalismRating: rating,
        vehicleConditionRating: rating,
        communicationRating: rating,
      });
      setRated(rating);
      setNotice("Thanks — rating recorded.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Rating failed");
    }
  };

  return (
    <View className="rounded-[24px] border border-border bg-surface px-4 py-4">
      <Pressable onPress={onToggle}>
        <View className="flex-row items-center justify-between gap-3">
          <View className="flex-1">
            <Text className="text-sm font-semibold text-foreground">
              {order.orderNumber}
            </Text>
            <Text className="mt-1 text-xs text-muted">
              {order.providerName ?? order.verticalName ?? "Order"} · {order.status}
            </Text>
          </View>
          <Text className="text-sm font-semibold text-foreground">
            {formatMajorAmount(order.totalAmount, order.currency)}
          </Text>
        </View>
      </Pressable>

      {expanded ? (
        <View className="mt-4 gap-4">
          {detail.isLoading ? (
            <LoadingSkeleton rows={3} />
          ) : !detail.data ? (
            <EmptyState title="No detail" body="Order detail is unavailable." />
          ) : (
            <>
              <View className="gap-2 rounded-[20px] border border-border bg-background/70 px-4 py-3">
                <Text className="text-xs font-semibold uppercase tracking-wide text-muted">
                  Tracking timeline
                </Text>
                {detail.data.timeline.length === 0 ? (
                  <Text className="text-sm text-muted">No tracking events yet.</Text>
                ) : (
                  sortTimeline(detail.data.timeline).map((event, index) => (
                    <View key={`${event.kind}-${index}`} className="flex-row gap-3">
                      <View className="mt-1 h-2 w-2 rounded-full bg-primary" />
                      <View className="flex-1">
                        <Text className="text-sm font-semibold text-foreground">
                          {event.label}
                        </Text>
                        <Text className="text-xs text-muted">
                          {new Date(event.occurredAt).toLocaleString()}
                          {event.detail ? ` · ${event.detail}` : ""}
                        </Text>
                      </View>
                    </View>
                  ))
                )}
              </View>

              {detail.data.supportCases.length > 0 ? (
                <View className="rounded-[20px] border border-border bg-background/70 px-4 py-3">
                  <Text className="text-xs font-semibold uppercase tracking-wide text-muted">
                    Support cases
                  </Text>
                  {detail.data.supportCases.map((supportCase) => (
                    <Text key={supportCase.id} className="mt-2 text-sm text-foreground">
                      {supportCase.ticketNumber} · {supportCase.status} · {supportCase.subject}
                    </Text>
                  ))}
                </View>
              ) : null}

              <View className="rounded-[20px] border border-border bg-background/70 px-4 py-3">
                <Text className="text-xs font-semibold uppercase tracking-wide text-muted">
                  Rate this order
                </Text>
                <View className="mt-2 flex-row gap-2">
                  {[1, 2, 3, 4, 5].map((value) => (
                    <Pressable
                      key={value}
                      onPress={() => void submitRating(value)}
                      disabled={rate.isPending || rated !== null}
                      className={`rounded-full px-3 py-2 ${
                        rated === value ? "bg-primary" : "bg-background"
                      }`}
                    >
                      <Text
                        className={`text-xs font-semibold ${
                          rated === value ? "text-white" : "text-foreground"
                        }`}
                      >
                        {value}★
                      </Text>
                    </Pressable>
                  ))}
                </View>
                {notice ? (
                  <Text className="mt-2 text-xs text-muted">{notice}</Text>
                ) : null}
              </View>
            </>
          )}
        </View>
      ) : null}
    </View>
  );
}

function ReplicaOrdersList({
  rows,
  loading,
  selectedOrderId,
  onSelect,
}: {
  rows: ReturnType<typeof mapReplicaOrderRow>[];
  loading: boolean;
  selectedOrderId: number | null;
  onSelect: (id: number | null) => void;
}) {
  if (loading) return <LoadingSkeleton rows={4} />;
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No synced orders"
        body="Connect once to sync your order history for offline viewing."
      />
    );
  }
  return (
    <View className="gap-3">
      {rows.map((order) => {
        const expanded = selectedOrderId === order.id;
        return (
          <View
            key={order.id}
            className="rounded-[24px] border border-border bg-surface px-4 py-4"
          >
            <Pressable onPress={() => onSelect(expanded ? null : order.id)}>
              <View className="flex-row items-center justify-between gap-3">
                <View className="flex-1">
                  <Text className="text-sm font-semibold text-foreground">
                    {order.orderNumber}
                  </Text>
                  <Text className="mt-1 text-xs text-muted">{order.status}</Text>
                </View>
                <Text className="text-sm font-semibold text-foreground">
                  {formatMajorAmount(order.totalAmount)}
                </Text>
              </View>
            </Pressable>
            {expanded ? <ReplicaTimeline orderId={order.id} /> : null}
          </View>
        );
      })}
    </View>
  );
}

function ReplicaTimeline({ orderId }: { orderId: number }) {
  const events = useReplicaQuery<ReplicaTrackingRow, ReturnType<typeof mapReplicaTrackingRow>>(
    true,
    `SELECT id, order_id, event_type, status_label, eta_minutes, event_time, metadata
       FROM order_tracking_events
      WHERE order_id = ?
      ORDER BY event_time`,
    [String(orderId)],
    mapReplicaTrackingRow,
  );
  return (
    <View className="mt-4 gap-2 rounded-[20px] border border-border bg-background/70 px-4 py-3">
      <Text className="text-xs font-semibold uppercase tracking-wide text-muted">
        Tracking timeline (synced)
      </Text>
      {events.rows.length === 0 ? (
        <Text className="text-sm text-muted">No synced tracking events.</Text>
      ) : (
        sortTimeline(events.rows).map((event, index) => (
          <View key={index} className="flex-row gap-3">
            <View className="mt-1 h-2 w-2 rounded-full bg-primary" />
            <View className="flex-1">
              <Text className="text-sm font-semibold text-foreground">{event.label}</Text>
              <Text className="text-xs text-muted">
                {new Date(event.occurredAt).toLocaleString()}
                {event.detail ? ` · ${event.detail}` : ""}
              </Text>
            </View>
          </View>
        ))
      )}
      <Text className="mt-1 text-xs text-muted">
        Rating requires connection.
      </Text>
    </View>
  );
}
