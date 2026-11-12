/**
 * Courier offers inbox (P4-N, WS-NATIVE courier).
 *
 * OFFLINE BOUNDARY:
 *   - READS: the live offer stream (driverDispatchFairness.listMyOffers)
 *     requires connectivity — offer disclosures are NOT replicated. Assigned
 *     orders (active trips) render from the PowerSync courier_assignments
 *     replica when disconnected.
 *   - WRITES (consumerRide.acceptRideOffer / driverDispatchFairness
 *     .declineOffer) are ONLINE-ONLY. Offline attempts queue a SyncAction in
 *     the operator outbox (lib/mobile/offline-sync-sqlite.ts, lane
 *     driver_delivery) with an embedded idempotency key for manual replay.
 */
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { router } from "expo-router";

import {
  EmptyState,
  LoadingSkeleton,
  SectionCard,
} from "@/components/mobile/operations-ui";
import { ScreenContainer } from "@/components/screen-container";
import { useAuth } from "@/hooks/use-auth";
import {
  buildCourierQueuedAction,
  COURIER_ASSIGNMENTS_SQL,
  mapCourierApiError,
  mapCourierReplicaOrderRow,
  newCourierIdempotencyKey,
  useAcceptRideOffer,
  useCourierOffers,
  useDeclineRideOffer,
  type CourierDeclineReason,
  type CourierOffer,
  type CourierReplicaOrderRow,
} from "@/lib/courierApi";
import { useConsumerDataMode, useReplicaQuery } from "@/lib/consumerOffline";
import { queueAction } from "@/lib/mobile/offline-sync-sqlite";
import { formatMinor } from "@/lib/money";

export default function CourierOffersScreen() {
  const { isAuthenticated, user } = useAuth();
  const { connected, mode } = useConsumerDataMode();
  const offers = useCourierOffers();
  const accept = useAcceptRideOffer();
  const decline = useDeclineRideOffer();
  const [notice, setNotice] = useState<string | null>(null);
  const [busyOfferId, setBusyOfferId] = useState<string | null>(null);

  const assignments = useReplicaQuery(
    isAuthenticated,
    COURIER_ASSIGNMENTS_SQL,
    [],
    mapCourierReplicaOrderRow,
  );

  const accountId = `courier:${user?.id ?? "unknown"}`;

  const queueOffline = async (
    kind: "courier_accept_offer" | "courier_decline_offer",
    offerId: string,
    reason?: CourierDeclineReason,
  ) => {
    try {
      const action = buildCourierQueuedAction({ accountId, kind, offerId, reason });
      await queueAction(action);
      setNotice("Offline — action queued in the outbox; replay it from the Queue tab.");
    } catch {
      setNotice("Offline — could not queue the action. Reconnect and retry.");
    }
  };

  const acceptOffer = async (offer: CourierOffer) => {
    if (!connected) {
      await queueOffline("courier_accept_offer", offer.offerId);
      return;
    }
    setBusyOfferId(offer.offerId);
    setNotice(null);
    try {
      const result = await accept.mutateAsync({
        offerId: offer.offerId,
        idempotencyKey: newCourierIdempotencyKey("coa"),
      });
      setNotice(`Offer accepted — trip ${result.tripId.slice(0, 8)}… is now ${result.state}.`);
      await offers.refetch();
    } catch (error) {
      setNotice(`Accept failed (${mapCourierApiError(error)}).`);
    } finally {
      setBusyOfferId(null);
    }
  };

  const declineOffer = async (offer: CourierOffer, reason: CourierDeclineReason) => {
    if (!connected) {
      await queueOffline("courier_decline_offer", offer.offerId, reason);
      return;
    }
    setBusyOfferId(offer.offerId);
    setNotice(null);
    try {
      await decline.mutateAsync({
        offerId: offer.offerId,
        reason,
        idempotencyKey: newCourierIdempotencyKey("cod"),
      });
      setNotice("Offer declined.");
      await offers.refetch();
    } catch (error) {
      setNotice(`Decline failed (${mapCourierApiError(error)}).`);
    } finally {
      setBusyOfferId(null);
    }
  };

  if (!isAuthenticated) {
    return (
      <ScreenContainer className="px-4 pb-6">
        <View className="pt-10">
          <EmptyState
            title="Sign in as a courier"
            body="Ride offers require an authenticated courier session with verified onboarding."
          />
        </View>
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer className="px-4 pb-6">
      <ScrollView contentContainerStyle={{ gap: 16, paddingTop: 20, paddingBottom: 24 }}>
        <View>
          <Text className="text-3xl font-bold text-foreground">Courier Offers</Text>
          <Text className="mt-2 text-sm leading-6 text-muted">
            Accept or decline ride offers with full fare disclosure. Offline,
            your assigned orders stay visible from the synced replica.
          </Text>
        </View>

        {mode === "offline-replica" ? (
          <View className="self-start rounded-full bg-background px-3 py-1">
            <Text className="text-[11px] font-semibold uppercase tracking-wide text-muted">
              Offline — synced replica (offers paused)
            </Text>
          </View>
        ) : null}

        {notice ? (
          <View className="rounded-[20px] border border-border bg-background/70 px-4 py-3">
            <Text className="text-sm text-foreground">{notice}</Text>
          </View>
        ) : null}

        <SectionCard
          title="Incoming offers"
          subtitle="Transparent fare disclosure: pickup cost, commission, and expected net."
        >
          {!connected ? (
            <EmptyState
              title="Offers require connection"
              body="The live offer stream is unavailable offline. Accept/decline taps are queued to the outbox for replay."
            />
          ) : offers.isLoading ? (
            <LoadingSkeleton rows={3} />
          ) : !offers.data || offers.data.length === 0 ? (
            <EmptyState
              title="No open offers"
              body="New offers appear here when dispatch matches you to a ride."
            />
          ) : (
            <View className="gap-3">
              {offers.data.map((offer) => (
                <View
                  key={offer.offerId}
                  className="rounded-[20px] border border-border bg-background/70 px-4 py-3"
                >
                  <View className="flex-row items-start justify-between gap-3">
                    <View className="flex-1">
                      <Text className="text-sm font-semibold text-foreground">
                        → {offer.destinationAddress}
                      </Text>
                      <Text className="mt-1 text-xs text-muted">
                        Pickup {(offer.pickupDistanceM / 1000).toFixed(1)} km · ETA{" "}
                        {Math.round(offer.pickupEtaS / 60)} min · expires{" "}
                        {new Date(offer.expiresAt).toLocaleTimeString()}
                      </Text>
                    </View>
                    <View className="items-end">
                      <Text className="text-sm font-semibold text-foreground">
                        {formatMinor(offer.expectedDriverNetKobo)}
                      </Text>
                      <Text className="text-xs text-muted">
                        net of {formatMinor(offer.grossFareKobo)} gross
                      </Text>
                    </View>
                  </View>
                  <View className="mt-3 flex-row flex-wrap gap-2">
                    <Pressable
                      onPress={() => void acceptOffer(offer)}
                      disabled={busyOfferId === offer.offerId}
                      className="rounded-full bg-primary px-4 py-2"
                    >
                      <Text className="text-xs font-semibold text-white">
                        {busyOfferId === offer.offerId ? "Working…" : "Accept"}
                      </Text>
                    </Pressable>
                    <Pressable
                      onPress={() => void declineOffer(offer, "other")}
                      disabled={busyOfferId === offer.offerId}
                      className="rounded-full bg-background px-4 py-2"
                    >
                      <Text className="text-xs font-semibold text-error">Decline</Text>
                    </Pressable>
                  </View>
                </View>
              ))}
            </View>
          )}
        </SectionCard>

        <SectionCard
          title="My assignments"
          subtitle="Orders assigned to you — synced to this device for offline access."
        >
          {assignments.rows.length === 0 ? (
            <EmptyState
              title="No assignments synced"
              body="Accepted rides and delivery assignments appear here once synced."
            />
          ) : (
            <View className="gap-3">
              {assignments.rows.map((assignment) => (
                <View
                  key={assignment.orderId}
                  className="rounded-[20px] border border-border bg-background/70 px-4 py-3"
                >
                  <Text className="text-sm font-semibold text-foreground">
                    {assignment.orderNumber} · {assignment.status}
                  </Text>
                  <Text className="mt-1 text-xs text-muted">
                    {assignment.deliveryAddress ?? "Address on file"}
                    {assignment.estimatedDeliveryTime
                      ? ` · ETA ${new Date(assignment.estimatedDeliveryTime).toLocaleTimeString()}`
                      : ""}
                  </Text>
                </View>
              ))}
            </View>
          )}
        </SectionCard>

        <Pressable
          onPress={() => router.push("/courier/earnings" as never)}
          className="rounded-full bg-accent2 px-4 py-3"
        >
          <Text className="text-center text-xs font-semibold text-white">
            View earnings
          </Text>
        </Pressable>
      </ScrollView>
    </ScreenContainer>
  );
}
