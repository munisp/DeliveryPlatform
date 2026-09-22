import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, Text, TextInput, View } from "react-native";

import { SectionCard } from "@/components/mobile/operations-ui";
import { ScreenContainer } from "@/components/screen-container";
import { FareBreakdown } from "@/components/trust/fare-breakdown";
import {
  KeyValueRow,
  Notice,
  StatusPill,
  trustInputClass,
  trustPlaceholderColor,
} from "@/components/trust/ui";
import {
  type SosEvent,
  useActiveSOS,
  useCancelSOS,
  useEconomicsSafetyInvalidation,
  useManifest,
  useMyNetEarningsSummary,
  useMyOffers,
  useResolveSOS,
  useTriggerSOS,
} from "@/lib/economicsSafetyApi";
import { mobileHaptics } from "@/lib/mobile/haptics";
import { useNativeOperatorSession } from "@/lib/mobile/operator-session";
import { formatDateTime, formatMinor } from "@/lib/money";

/**
 * Driver safety center (Wave E1, R3 SOS + R2 manifest review + R8/R9
 * earnings transparency). Native port of the PWA's
 * client/src/pages/DriverSafetyCenter.tsx: SOS fires only after a sustained
 * three-second hold so an accidental tap can never alert the safety desk.
 *
 * Deviation from the PWA: geolocation is not attached — expo-location is not
 * among this app's dependencies, and the server treats lat/lng as optional.
 */

const HOLD_TO_CONFIRM_MS = 3_000;

function SOSButton({ tripId }: { tripId: string }) {
  const triggerSOS = useTriggerSOS();
  const cancelSOS = useCancelSOS();
  const [holding, setHolding] = useState(false);
  const [progress, setProgress] = useState(0);
  const [activeSOS, setActiveSOS] = useState<SosEvent | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frameRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef(0);

  const clearHold = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (frameRef.current) clearInterval(frameRef.current);
    timerRef.current = null;
    frameRef.current = null;
    setHolding(false);
    setProgress(0);
  };

  useEffect(() => clearHold, []);

  const fire = () => {
    clearHold();
    mobileHaptics.error();
    triggerSOS.mutate({
      role: "driver",
      tripId: tripId || undefined,
    });
  };

  const onPressIn = () => {
    if (triggerSOS.isPending || activeSOS) return;
    mobileHaptics.warning();
    setHolding(true);
    startedAtRef.current = Date.now();
    frameRef.current = setInterval(() => {
      const elapsed = Date.now() - startedAtRef.current;
      setProgress(Math.min(1, elapsed / HOLD_TO_CONFIRM_MS));
    }, 50);
    timerRef.current = setTimeout(fire, HOLD_TO_CONFIRM_MS);
  };

  // Track the triggered SOS id from the settled mutation result.
  const triggeredId = triggerSOS.data?.id ?? null;
  useEffect(() => {
    if (triggeredId && triggerSOS.data) setActiveSOS(triggerSOS.data);
  }, [triggeredId, triggerSOS.data]);

  return (
    <View className="gap-3">
      {activeSOS ? (
        <View className="gap-3 rounded-[20px] border border-error/50 bg-error/10 px-4 py-4">
          <Text className="text-sm font-semibold text-error">
            SOS active — status: {activeSOS.status}
          </Text>
          <Text className="text-xs text-muted">{activeSOS.id}</Text>
          <Pressable
            onPress={() =>
              cancelSOS.mutate(
                { sosId: activeSOS.id },
                { onSuccess: () => setActiveSOS(null) },
              )
            }
            disabled={cancelSOS.isPending}
            className="self-start rounded-full border border-error/50 px-4 py-2 disabled:opacity-50"
          >
            <Text className="text-xs font-semibold text-error">
              {cancelSOS.isPending ? "Cancelling…" : "Cancel SOS — I am safe"}
            </Text>
          </Pressable>
        </View>
      ) : (
        <Pressable
          onPressIn={onPressIn}
          onPressOut={clearHold}
          disabled={triggerSOS.isPending}
          accessibilityRole="button"
          accessibilityLabel="Hold for three seconds to trigger an SOS alert"
          className="relative h-32 items-center justify-center overflow-hidden rounded-[24px] border-2 border-error/60 bg-error/20 disabled:opacity-60"
        >
          <View
            pointerEvents="none"
            className="absolute inset-y-0 left-0 bg-error/40"
            style={{ width: `${progress * 100}%` }}
          />
          <View className="items-center gap-1">
            <Text className="text-lg font-bold tracking-wide text-error">
              {triggerSOS.isPending
                ? "Sending SOS…"
                : holding
                  ? "Keep holding…"
                  : "SOS — hold 3 seconds"}
            </Text>
            <Text className="px-6 text-center text-xs text-muted">
              Alerts the safety desk with your trip context
            </Text>
          </View>
        </Pressable>
      )}
      {triggerSOS.isError ? (
        <Notice
          tone="error"
          title="SOS could not be sent — try again"
          body={triggerSOS.error?.message ?? undefined}
        />
      ) : null}
    </View>
  );
}

function ManifestPanel({ tripId }: { tripId: string }) {
  const manifest = useManifest(tripId);

  if (!tripId) {
    return (
      <Text className="text-sm text-muted">
        Enter a trip ID above to load its passenger manifest before pickup.
      </Text>
    );
  }
  if (manifest.isLoading) {
    return <Text className="text-sm text-muted">Loading manifest…</Text>;
  }
  if (manifest.isError || !manifest.data) {
    return (
      <Notice
        tone="warning"
        title="Manifest unavailable"
        body={manifest.error?.message ?? "Try again."}
      />
    );
  }

  const passengers = manifest.data.passengers;
  const verifiedCount = passengers.filter((p) => p.verified).length;

  return (
    <View className="gap-3">
      <View className="flex-row flex-wrap items-center gap-2">
        <StatusPill
          label={
            manifest.data.manifestVerified
              ? "✓ Manifest verified"
              : "⚠ Manifest unverified"
          }
          tone={manifest.data.manifestVerified ? "success" : "warning"}
        />
        <Text className="text-sm text-muted">
          {verifiedCount} of {passengers.length} passenger
          {passengers.length === 1 ? "" : "s"} verified
        </Text>
      </View>
      {passengers.length === 0 ? (
        <Text className="text-sm text-muted">
          No passengers are attached to this trip yet.
        </Text>
      ) : (
        passengers.map((passenger, index) => (
          <View
            key={`${passenger.name}-${index}`}
            className="gap-2 rounded-[16px] border border-border bg-background/60 px-3 py-3"
          >
            <View className="flex-row flex-wrap items-center justify-between gap-2">
              <Text className="text-sm font-medium text-foreground">
                {passenger.name}
              </Text>
              <StatusPill
                label={passenger.verified ? "✓ Verified rider" : "⚠ Unverified"}
                tone={passenger.verified ? "success" : "warning"}
              />
            </View>
            {passenger.flags.length > 0 ? (
              <View className="flex-row flex-wrap gap-1">
                {passenger.flags.map((flag) => (
                  <StatusPill key={flag} label={flag} tone="error" />
                ))}
              </View>
            ) : null}
          </View>
        ))
      )}
    </View>
  );
}

function EarningsCard() {
  const summary = useMyNetEarningsSummary();
  const offers = useMyOffers();
  const latestOfferId = offers.data?.[0]?.offerId ?? "";

  return (
    <SectionCard
      title="My net earnings — last 30 days"
      subtitle="Gross fares, deadhead credits, and platform fees summed from your stored offer breakdowns."
    >
      {summary.isLoading ? (
        <Text className="text-sm text-muted">Loading earnings summary…</Text>
      ) : summary.isError || !summary.data ? (
        <Text className="text-sm text-muted">
          Net earnings summary is unavailable right now.
        </Text>
      ) : (
        <View className="rounded-[20px] border border-border bg-background/60 px-4 py-2">
          <KeyValueRow label="Offers" value={String(summary.data.offers)} />
          <KeyValueRow
            label="Gross"
            value={formatMinor(summary.data.grossMinor, summary.data.currency)}
          />
          <KeyValueRow
            label="Deadhead credited"
            value={formatMinor(summary.data.deadheadMinor, summary.data.currency)}
            valueClassName="text-success"
          />
          <KeyValueRow
            label="Platform fees"
            value={formatMinor(
              summary.data.platformFeeMinor,
              summary.data.currency,
            )}
            valueClassName="text-error"
          />
          <KeyValueRow
            label="Net to me"
            value={formatMinor(
              summary.data.netToDriverMinor,
              summary.data.currency,
            )}
            valueClassName="text-accent2 font-bold"
          />
        </View>
      )}
      {latestOfferId ? (
        <View className="gap-2">
          <Text className="text-xs font-semibold uppercase tracking-[1px] text-muted">
            Latest offer breakdown
          </Text>
          <FareBreakdown offerId={latestOfferId} />
        </View>
      ) : null}
    </SectionCard>
  );
}

type SosAlertRowProps = {
  alert: SosEvent;
  resolving: boolean;
  onResolve: (sosId: string) => void;
};

const SosAlertRow = memo(function SosAlertRow({
  alert,
  resolving,
  onResolve,
}: SosAlertRowProps) {
  const handlePress = useCallback(() => onResolve(alert.id), [alert.id, onResolve]);
  return (
    <View className="flex-row flex-wrap items-center justify-between gap-2 rounded-[16px] border border-error/40 bg-error/5 px-3 py-3">
      <View className="shrink">
        <Text className="text-xs text-muted">{alert.id}</Text>
        <Text className="text-sm font-medium text-error">
          {alert.role} · {alert.status} · {formatDateTime(alert.created_at)}
        </Text>
      </View>
      <Pressable
        onPress={handlePress}
        disabled={resolving}
        className="rounded-full border border-success/40 px-3 py-1.5 disabled:opacity-50"
      >
        <Text className="text-xs font-semibold text-success">Resolve</Text>
      </Pressable>
    </View>
  );
});

const sosAlertKeyExtractor = (alert: SosEvent) => alert.id;

// Stable empty list so the non-operator path never re-renders the FlatList.
const EMPTY_ALERTS: SosEvent[] = [];

export default function SafetyScreen() {
  const { role, isLoading } = useNativeOperatorSession();
  const isOperator = !isLoading && role === "admin";
  const [tripId, setTripId] = useState("");

  // Wave W4: the operator SOS queue query is enabled only once a verified
  // operator session resolves — the driver/rider fast path never fires it.
  const activeSOS = useActiveSOS(isOperator);
  const { mutate: resolveSOSMutate, isPending: resolveSOSPending } =
    useResolveSOS();
  const invalidation = useEconomicsSafetyInvalidation();
  const invalidationRef = useRef(invalidation);
  invalidationRef.current = invalidation;

  const handleResolveSOS = useCallback(
    (sosId: string) => {
      resolveSOSMutate(
        { sosId },
        { onSuccess: () => invalidationRef.current.safety() },
      );
    },
    [resolveSOSMutate],
  );

  const renderSosAlert = useCallback(
    ({ item }: { item: SosEvent }) => (
      <SosAlertRow
        alert={item}
        resolving={resolveSOSPending}
        onResolve={handleResolveSOS}
      />
    ),
    [resolveSOSPending, handleResolveSOS],
  );

  const alerts = useMemo(() => activeSOS.data ?? [], [activeSOS.data]);

  return (
    <ScreenContainer className="px-4 pb-6">
      <FlatList
        data={isOperator ? alerts : EMPTY_ALERTS}
        keyExtractor={sosAlertKeyExtractor}
        renderItem={renderSosAlert}
        windowSize={7}
        maxToRenderPerBatch={8}
        removeClippedSubviews
        contentContainerStyle={{ gap: 16, paddingTop: 20, paddingBottom: 24 }}
        ListHeaderComponent={
          <View className="gap-4">
            <View>
              <Text className="text-3xl font-bold text-foreground">
                Driver Safety Center
              </Text>
              <Text className="mt-2 text-sm leading-6 text-muted">
                Trigger an SOS with a three-second hold, review who is riding
                before pickup against the verified passenger manifest, and see
                exactly what you net after platform fees.
              </Text>
            </View>

            <SectionCard
              title="Emergency SOS"
              subtitle="Press and hold for three seconds. Releasing early cancels the alert before it is sent."
            >
              <TextInput
                value={tripId}
                onChangeText={setTripId}
                placeholder="Trip ID (optional context for SOS and manifest)"
                placeholderTextColor={trustPlaceholderColor}
                className={trustInputClass}
              />
              <SOSButton tripId={tripId.trim()} />
            </SectionCard>

            <SectionCard
              title="Trip passenger manifest"
              subtitle="Per-rider verification chips for the trip above, as the driver will see them before pickup."
            >
              <ManifestPanel tripId={tripId.trim()} />
            </SectionCard>

            <EarningsCard />

            {isOperator ? (
              <View className="gap-1">
                <Text className="text-lg font-semibold text-foreground">
                  Operator SOS queue
                </Text>
                <Text className="text-sm leading-5 text-muted">
                  Active SOS alerts across the platform. Resolving records your
                  operator identity.
                </Text>
                {activeSOS.isLoading ? (
                  <Text className="mt-2 text-sm text-muted">
                    Loading active SOS alerts…
                  </Text>
                ) : activeSOS.isError ? (
                  <Notice
                    tone="warning"
                    title="Active SOS list unavailable"
                    body={activeSOS.error?.message ?? "Try again."}
                  />
                ) : null}
              </View>
            ) : (
              <Notice
                tone="neutral"
                title="Operator SOS queue hidden"
                body="The operator SOS queue is only visible to trust and operations roles. Server-side authorization is enforced independently of this view."
              />
            )}
          </View>
        }
        ListEmptyComponent={
          isOperator && !activeSOS.isLoading && !activeSOS.isError ? (
            <Notice tone="success" title="No active SOS alerts" />
          ) : null
        }
      />
    </ScreenContainer>
  );
}
