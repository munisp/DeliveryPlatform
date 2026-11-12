/**
 * Consumer subscription (P2-C): membership plans, subscribe, cancel.
 *
 * OFFLINE BOUNDARY:
 *   - READS come from the PowerSync replica (membership_plans is
 *     global_reference; consumer_memberships is user_own). There is no
 *     server-side plans-listing procedure in v1, so the replica is the
 *     primary source both online and offline (it stays fresh while
 *     connected). If the device has never synced, an empty state explains it.
 *   - WRITES (consumer.subscribePlan / cancelSubscription) are ONLINE-ONLY
 *     with a clear "requires connection" state while offline.
 *
 * CANCEL CAVEAT (documented for the program): cancelSubscription takes the
 * consumer_subscriptions uuid, which is not in the v1 PowerSync publication.
 * This screen persists the subscription id locally (AsyncStorage) at
 * subscribe time and cancels from that record; subscriptions started on
 * another device cannot be cancelled here until a mySubscription read
 * procedure or publication table lands.
 */
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  EmptyState,
  SectionCard,
} from "@/components/mobile/operations-ui";
import { ScreenContainer } from "@/components/screen-container";
import { useAuth } from "@/hooks/use-auth";
import {
  formatMajorAmount,
  newConsumerIdempotencyKey,
  useCancelSubscription,
  useSubscribePlan,
} from "@/lib/consumer";
import {
  useConsumerDataMode,
  useReplicaQuery,
  type ReplicaMembershipPlanRow,
  type ReplicaMembershipRow,
} from "@/lib/consumerOffline";

const SUBSCRIPTION_STORAGE_KEY = "consumer.activeSubscription.v1";

type StoredSubscription = {
  subscriptionId: string;
  planId: number;
  storedAt: string;
};

export default function ConsumerSubscriptionScreen() {
  const { isAuthenticated } = useAuth();
  const { connected, mode } = useConsumerDataMode();

  const plans = useReplicaQuery<ReplicaMembershipPlanRow, ReplicaMembershipPlanRow>(
    isAuthenticated,
    `SELECT id, plan_code, plan_name, monthly_price, delivery_fee_discount,
            priority_support, cashback_rate, perks, is_active
       FROM membership_plans
      WHERE COALESCE(is_active, 1) = 1
      ORDER BY monthly_price`,
    [],
    (row) => row,
  );
  const memberships = useReplicaQuery<ReplicaMembershipRow, ReplicaMembershipRow>(
    isAuthenticated,
    `SELECT id, plan_id, status, renewal_at, created_at
       FROM consumer_memberships
      ORDER BY created_at DESC`,
    [],
    (row) => row,
  );

  const subscribe = useSubscribePlan();
  const cancel = useCancelSubscription();
  const [stored, setStored] = useState<StoredSubscription | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyPlanId, setBusyPlanId] = useState<number | null>(null);

  useEffect(() => {
    void AsyncStorage.getItem(SUBSCRIPTION_STORAGE_KEY).then((raw) => {
      if (!raw) return;
      try {
        setStored(JSON.parse(raw) as StoredSubscription);
      } catch {
        // Corrupt local record: ignore and require a fresh subscribe.
      }
    });
  }, []);

  const activeMembership =
    memberships.rows.find((row) => row.status === "active") ?? null;

  const subscribeToPlan = async (plan: ReplicaMembershipPlanRow) => {
    if (!connected) return;
    setBusyPlanId(Number(plan.id));
    setNotice(null);
    try {
      const result = await subscribe.mutateAsync({
        planId: Number(plan.id),
        idempotencyKey: newConsumerIdempotencyKey("sub"),
      });
      const record: StoredSubscription = {
        subscriptionId: result.id,
        planId: result.planId,
        storedAt: new Date().toISOString(),
      };
      await AsyncStorage.setItem(SUBSCRIPTION_STORAGE_KEY, JSON.stringify(record));
      setStored(record);
      setNotice(
        result.replayed
          ? "Subscription already existed for this key (idempotent replay)."
          : `Subscribed to ${plan.plan_name}.`,
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Subscribe failed");
    } finally {
      setBusyPlanId(null);
    }
  };

  const cancelActive = async () => {
    if (!connected || !stored) return;
    setNotice(null);
    try {
      await cancel.mutateAsync({ subscriptionId: stored.subscriptionId });
      await AsyncStorage.removeItem(SUBSCRIPTION_STORAGE_KEY);
      setStored(null);
      setNotice("Subscription cancelled.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Cancel failed");
    }
  };

  if (!isAuthenticated) {
    return (
      <ScreenContainer className="px-4 pb-6">
        <View className="pt-10">
          <EmptyState
            title="Sign in to manage plans"
            body="Membership plans require an authenticated consumer session."
          />
        </View>
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer className="px-4 pb-6">
      <ScrollView contentContainerStyle={{ gap: 16, paddingTop: 20, paddingBottom: 24 }}>
        <View>
          <Text className="text-3xl font-bold text-foreground">Membership</Text>
          <Text className="mt-2 text-sm leading-6 text-muted">
            Plans and membership status read from the synced replica and stay
            available offline. Subscribing or cancelling requires a connection.
          </Text>
        </View>

        {mode === "offline-replica" ? (
          <View className="self-start rounded-full bg-background px-3 py-1">
            <Text className="text-[11px] font-semibold uppercase tracking-wide text-muted">
              Offline — synced replica
            </Text>
          </View>
        ) : null}

        {notice ? (
          <View className="rounded-[20px] border border-border bg-background/70 px-4 py-3">
            <Text className="text-sm text-foreground">{notice}</Text>
          </View>
        ) : null}

        <SectionCard
          title="Current membership"
          subtitle="Latest membership record synced to this device."
        >
          {activeMembership ? (
            <View className="gap-2 rounded-[20px] border border-border bg-background/70 px-4 py-3">
              <Row label="Plan" value={`#${activeMembership.plan_id}`} />
              <Row label="Status" value={activeMembership.status} />
              {activeMembership.renewal_at ? (
                <Row
                  label="Renews"
                  value={new Date(activeMembership.renewal_at).toLocaleDateString()}
                />
              ) : null}
            </View>
          ) : (
            <EmptyState
              title="No active membership"
              body="Subscribe to a plan below; it appears here after the next sync."
            />
          )}
          {stored ? (
            connected ? (
              <Pressable
                onPress={() => void cancelActive()}
                disabled={cancel.isPending}
                className="self-start rounded-full bg-background px-4 py-3"
              >
                <Text className="text-xs font-semibold text-error">
                  {cancel.isPending ? "Cancelling…" : "Cancel subscription"}
                </Text>
              </Pressable>
            ) : (
              <Text className="text-xs font-semibold text-muted">
                Requires connection to cancel
              </Text>
            )
          ) : null}
        </SectionCard>

        <SectionCard
          title="Plans"
          subtitle="Synced from the platform reference data."
        >
          {plans.rows.length === 0 ? (
            <EmptyState
              title="No plans synced"
              body="Connect once to sync the membership catalog, then browse offline afterwards."
            />
          ) : (
            <View className="gap-3">
              {plans.rows.map((plan) => (
                <View
                  key={plan.id}
                  className="rounded-[20px] border border-border bg-background/70 px-4 py-3"
                >
                  <View className="flex-row items-center justify-between gap-3">
                    <View className="flex-1">
                      <Text className="text-sm font-semibold text-foreground">
                        {plan.plan_name}
                      </Text>
                      <Text className="mt-1 text-xs text-muted">
                        {plan.plan_code}
                        {plan.cashback_rate ? ` · ${plan.cashback_rate}% cashback` : ""}
                        {Number(plan.priority_support) === 1 ? " · priority support" : ""}
                      </Text>
                    </View>
                    <Text className="text-sm font-semibold text-foreground">
                      {formatMajorAmount(plan.monthly_price)}/mo
                    </Text>
                  </View>
                  {connected ? (
                    <Pressable
                      onPress={() => void subscribeToPlan(plan)}
                      disabled={busyPlanId === Number(plan.id)}
                      className="mt-3 self-start rounded-full bg-primary px-4 py-2"
                    >
                      <Text className="text-xs font-semibold text-white">
                        {busyPlanId === Number(plan.id) ? "Subscribing…" : "Subscribe"}
                      </Text>
                    </Pressable>
                  ) : (
                    <Text className="mt-3 text-xs font-semibold text-muted">
                      Requires connection to subscribe
                    </Text>
                  )}
                </View>
              ))}
            </View>
          )}
        </SectionCard>
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
