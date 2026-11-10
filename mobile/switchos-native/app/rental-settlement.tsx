import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { SectionCard } from "@/components/mobile/operations-ui";
import { ScreenContainer } from "@/components/screen-container";
import {
  KeyValueRow,
  Notice,
  StatusPill,
  trustInputClass,
  trustPlaceholderColor,
} from "@/components/trust/ui";
import * as Auth from "@/lib/_core/auth";
import { formatMinor, formatDateTime } from "@/lib/money";
import {
  PHOTO_ZONES,
  isUuid,
  newIdempotencyKey,
  normalizeDeltaReport,
  useComputeReturnSettlement,
  useConditionDeltaReport,
  useRentalConditionInvalidation,
  type NormalizedConditionPhoto,
  type NormalizedDeltaReport,
  type PhotoZone,
} from "@/lib/rentalCondition";

/**
 * Rental return settlement screen.
 *
 * Opened as:
 *   /rental-settlement?contractId=<uuid>[&operator=1]
 *
 * Renders rentalCondition.deltaReport: check-out vs check-in readings, the
 * per-zone photo evidence side by side, new damage zones, and the computed
 * settlement charge lines. The computeSettlement control is gated behind the
 * `operator` flag — a presentation rule only (same pattern as the PWA's
 * VehicleRentalOperationsPanel); the server independently enforces the
 * operator role via protectedProcedure and the SQL is_operator gate.
 */

const ZONE_LABELS: Record<PhotoZone, string> = Object.fromEntries(
  PHOTO_ZONES.map((spec) => [spec.zone, spec.label]),
) as Record<PhotoZone, string>;

function zoneLabel(zone: string): string {
  return ZONE_LABELS[zone as PhotoZone] ?? zone;
}

function PhasePhotoCell({
  label,
  photo,
}: {
  label: string;
  photo: NormalizedConditionPhoto | undefined;
}) {
  return (
    <View className="flex-1 gap-1 rounded-[16px] border border-border/60 bg-surface px-3 py-2">
      <Text className="text-[10px] uppercase tracking-wide text-muted">
        {label}
      </Text>
      {photo ? (
        <>
          <Text className="font-mono text-[10px] text-muted" numberOfLines={1}>
            {photo.objectKey.split("/").pop()}
          </Text>
          {photo.damageFlag ? (
            <StatusPill label="Damage" tone="error" />
          ) : (
            <StatusPill label="No damage" tone="success" />
          )}
          {photo.note ? (
            <Text className="text-xs leading-4 text-foreground">
              {photo.note}
            </Text>
          ) : null}
        </>
      ) : (
        <Text className="text-xs text-muted">No photo</Text>
      )}
    </View>
  );
}

function ComparisonCard({ report }: { report: NormalizedDeltaReport }) {
  const { checkOut, checkIn, deltas } = report;
  return (
    <SectionCard
      title="Check-out vs check-in"
      subtitle="Readings from the two append-only condition reports."
    >
      <View className="rounded-[20px] border border-border bg-background/60 px-4 py-2">
        <KeyValueRow
          label="Odometer at check-out"
          value={checkOut ? `${checkOut.odometerKm.toLocaleString()} km` : "—"}
        />
        <KeyValueRow
          label="Odometer at check-in"
          value={checkIn ? `${checkIn.odometerKm.toLocaleString()} km` : "—"}
        />
        <KeyValueRow
          label="Distance driven"
          value={
            deltas?.odometerKm !== null && deltas?.odometerKm !== undefined
              ? `${deltas.odometerKm.toLocaleString()} km`
              : "—"
          }
        />
        <KeyValueRow
          label="Fuel at check-out"
          value={checkOut ? `${checkOut.fuelPct}%` : "—"}
        />
        <KeyValueRow
          label="Fuel at check-in"
          value={checkIn ? `${checkIn.fuelPct}%` : "—"}
        />
        <KeyValueRow
          label="Fuel delta"
          value={
            deltas?.fuelPct !== null && deltas?.fuelPct !== undefined
              ? `${deltas.fuelPct > 0 ? "+" : ""}${deltas.fuelPct}%`
              : "—"
          }
        />
      </View>
      {deltas && deltas.newDamageZones.length > 0 ? (
        <View className="gap-2">
          <Text className="text-xs uppercase tracking-wide text-muted">
            New damage zones
          </Text>
          <View className="flex-row flex-wrap gap-2">
            {deltas.newDamageZones.map((zone) => (
              <StatusPill key={zone} label={zoneLabel(zone)} tone="error" />
            ))}
          </View>
        </View>
      ) : (
        <Notice
          tone="success"
          title="No new damage flagged"
          body="No zone was flagged as damaged at check-in that was clean at check-out."
        />
      )}
    </SectionCard>
  );
}

function PhotosCard({ report }: { report: NormalizedDeltaReport }) {
  const zones = useMemo(() => {
    const seen = new Set<string>();
    for (const photo of report.checkOut?.photos ?? []) seen.add(photo.zone);
    for (const photo of report.checkIn?.photos ?? []) seen.add(photo.zone);
    const order = new Map(PHOTO_ZONES.map((spec, index) => [spec.zone, index]));
    return [...seen].sort(
      (a, b) => (order.get(a as PhotoZone) ?? 99) - (order.get(b as PhotoZone) ?? 99),
    );
  }, [report]);

  if (zones.length === 0) {
    return (
      <SectionCard title="Photo evidence">
        <Notice
          tone="neutral"
          title="No photos yet"
          body="Zone photos appear here once condition reports are recorded."
        />
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title="Photo evidence"
      subtitle="Check-out (left) against check-in (right), per zone."
    >
      {zones.map((zone) => (
        <View key={zone} className="gap-1">
          <Text className="text-xs font-semibold uppercase tracking-wide text-muted">
            {zoneLabel(zone)}
          </Text>
          <View className="flex-row gap-2">
            <PhasePhotoCell
              label="Check-out"
              photo={report.checkOut?.photos.find((p) => p.zone === zone)}
            />
            <PhasePhotoCell
              label="Check-in"
              photo={report.checkIn?.photos.find((p) => p.zone === zone)}
            />
          </View>
        </View>
      ))}
    </SectionCard>
  );
}

function SettlementCard({ report }: { report: NormalizedDeltaReport }) {
  const settlement = report.settlement;
  if (!settlement) {
    return (
      <SectionCard title="Settlement">
        <Notice
          tone="neutral"
          title="No settlement computed yet"
          body="An operator computes the settlement once both condition reports exist and the contract is pending return."
        />
      </SectionCard>
    );
  }
  const currency = settlement.currency;
  return (
    <SectionCard
      title="Settlement"
      subtitle={`Computed ${formatDateTime(settlement.createdAt)} · total = excess km + fuel + renter damage liability`}
    >
      <View className="rounded-[20px] border border-border bg-background/60 px-4 py-2">
        <KeyValueRow
          label="Distance / included"
          value={`${settlement.distanceKm.toLocaleString()} km / ${settlement.includedKm.toLocaleString()} km (${settlement.billedWeeks} wk)`}
        />
        <KeyValueRow
          label={`Excess km (${settlement.excessKm.toLocaleString()} km)`}
          value={formatMinor(settlement.excessKmChargeMinor, currency)}
        />
        <KeyValueRow
          label={`Fuel (${settlement.fuelOutPct}% → ${settlement.fuelInPct}%)`}
          value={formatMinor(settlement.fuelChargeMinor, currency)}
        />
        <KeyValueRow
          label="Assessed damage"
          value={formatMinor(settlement.damageChargeMinor, currency)}
        />
        <KeyValueRow
          label="Renter damage liability"
          value={formatMinor(settlement.renterDamageLiabilityMinor, currency)}
        />
        <KeyValueRow
          label="Insurance credit"
          value={`-${formatMinor(settlement.insuranceCreditMinor, currency)}`}
        />
        <KeyValueRow
          label="Total charge"
          value={formatMinor(settlement.totalChargeMinor, currency)}
          valueClassName="text-base font-bold"
        />
      </View>
    </SectionCard>
  );
}

function OperatorSettlementPanel({
  contractId,
  hasSettlement,
}: {
  contractId: string;
  hasSettlement: boolean;
}) {
  const computeSettlement = useComputeReturnSettlement();
  const invalidation = useRentalConditionInvalidation();
  const [damageText, setDamageText] = useState("");
  const [fuelText, setFuelText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const idempotencyKeyRef = useRef(newIdempotencyKey("return-settlement"));

  const submit = () => {
    const damage = Number(damageText.trim());
    const fuel = Number(fuelText.trim());
    if (
      !/^\d+$/.test(damageText.trim()) ||
      !Number.isSafeInteger(damage) ||
      damage < 0
    ) {
      setError("Damage charge must be a non-negative integer in minor units.");
      return;
    }
    if (!/^\d+$/.test(fuelText.trim()) || !Number.isSafeInteger(fuel) || fuel < 0) {
      setError("Fuel charge must be a non-negative integer in minor units.");
      return;
    }
    setError(null);
    computeSettlement.mutate(
      {
        contractId,
        damageChargeMinor: damage,
        fuelChargeMinor: fuel,
        idempotencyKey: idempotencyKeyRef.current,
      },
      {
        onSuccess: () => {
          idempotencyKeyRef.current = newIdempotencyKey("return-settlement");
          invalidation.deltaReport();
        },
        onError: (mutationError) => setError(mutationError.message),
      },
    );
  };

  return (
    <SectionCard
      title="Operator: compute settlement"
      subtitle="Charges are integer minor units (e.g. kobo). The server recomputes distance, excess-km, and the insurance split; replaying the same idempotency key is a no-op."
    >
      {hasSettlement ? (
        <Notice
          tone="warning"
          title="Settlement already recorded"
          body="return_settlement is append-only (one row per contract). Recomputing with a different key will be rejected."
        />
      ) : null}
      <View className="flex-row gap-3">
        <View className="flex-1 gap-1">
          <Text className="text-xs uppercase tracking-wide text-muted">
            Damage charge (minor)
          </Text>
          <TextInput
            value={damageText}
            onChangeText={setDamageText}
            placeholder="e.g. 150000"
            placeholderTextColor={trustPlaceholderColor}
            keyboardType="number-pad"
            editable={!computeSettlement.isPending}
            className={trustInputClass}
          />
        </View>
        <View className="flex-1 gap-1">
          <Text className="text-xs uppercase tracking-wide text-muted">
            Fuel charge (minor)
          </Text>
          <TextInput
            value={fuelText}
            onChangeText={setFuelText}
            placeholder="e.g. 25000"
            placeholderTextColor={trustPlaceholderColor}
            keyboardType="number-pad"
            editable={!computeSettlement.isPending}
            className={trustInputClass}
          />
        </View>
      </View>
      {error ? (
        <Notice tone="error" title="Settlement not computed" body={error} />
      ) : null}
      <Pressable
        onPress={submit}
        disabled={computeSettlement.isPending}
        accessibilityRole="button"
        accessibilityLabel="Compute return settlement"
        className="items-center rounded-full bg-primary px-4 py-4"
        style={({ pressed }) => ({
          opacity: pressed || computeSettlement.isPending ? 0.6 : 1,
        })}
      >
        <Text className="text-sm font-semibold text-white">
          {computeSettlement.isPending
            ? "Computing…"
            : "Compute return settlement"}
        </Text>
      </Pressable>
    </SectionCard>
  );
}

export default function RentalSettlementScreen() {
  const params = useLocalSearchParams<{
    contractId?: string;
    operator?: string;
  }>();

  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    void Auth.getSessionToken().then((token) => {
      if (!mounted) return;
      setSessionToken(token);
      setSessionLoading(false);
    });
    return () => {
      mounted = false;
    };
  }, []);

  const contractId = params.contractId ?? "";
  const valid = isUuid(contractId);
  // Presentation-only gate (see header note); the server is authoritative.
  const isOperator = params.operator === "1" || params.operator === "true";

  const delta = useConditionDeltaReport(valid ? contractId : "");
  const report = useMemo(
    () => normalizeDeltaReport(delta.data),
    [delta.data],
  );

  return (
    <ScreenContainer className="px-4">
      <Stack.Screen options={{ title: "Return settlement", headerShown: false }} />
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingVertical: 16, gap: 16 }}
      >
        <View>
          <Text className="text-2xl font-bold text-foreground">
            Return settlement
          </Text>
          <Text className="mt-1 text-sm leading-5 text-muted">
            Check-out vs check-in evidence, new damage, and the computed
            settlement for this rental contract.
          </Text>
        </View>

        {!valid ? (
          <SectionCard
            title="Cannot load settlement"
            subtitle="Missing or invalid contractId param"
          >
            <Text className="text-sm leading-6 text-muted">
              Reopen this screen from the rental contract so the parameters are
              passed correctly.
            </Text>
          </SectionCard>
        ) : sessionLoading ? (
          <SectionCard title="Checking session">
            <Text className="text-sm text-muted">Loading your session…</Text>
          </SectionCard>
        ) : !sessionToken ? (
          <Notice
            tone="error"
            title="Sign-in required"
            body="No session was found on this device. Sign in again to view condition evidence."
          />
        ) : delta.isLoading ? (
          <SectionCard title="Loading evidence">
            <Text className="text-sm text-muted">
              Loading condition reports…
            </Text>
          </SectionCard>
        ) : delta.isError || !report ? (
          <View className="gap-3">
            <Notice
              tone="warning"
              title="Condition report unavailable"
              body={
                delta.error?.message ??
                "The delta report could not be loaded. Only the contract worker and operators can view it."
              }
            />
            <Pressable
              onPress={() => void delta.refetch()}
              disabled={delta.isRefetching}
              accessibilityRole="button"
              accessibilityLabel="Retry loading settlement"
              className="self-start rounded-full bg-primary px-4 py-2 disabled:opacity-50"
            >
              <Text className="text-xs font-semibold text-white">
                {delta.isRefetching ? "Retrying…" : "Retry"}
              </Text>
            </Pressable>
          </View>
        ) : (
          <>
            {!report.checkOut || !report.checkIn ? (
              <Notice
                tone="info"
                title="Condition reports incomplete"
                body={
                  !report.checkOut
                    ? "No check-out report exists yet. It is required before handover."
                    : "No check-in report exists yet. It is required before the settlement can be computed."
                }
              />
            ) : null}
            <ComparisonCard report={report} />
            <PhotosCard report={report} />
            <SettlementCard report={report} />
            {isOperator ? (
              <OperatorSettlementPanel
                contractId={contractId}
                hasSettlement={report.settlement !== null}
              />
            ) : (
              <Text className="text-center text-xs leading-5 text-muted">
                Settlement computation is shown to operations roles only. The
                server enforces operator authority regardless of this display
                rule.
              </Text>
            )}
          </>
        )}
      </ScrollView>
    </ScreenContainer>
  );
}
