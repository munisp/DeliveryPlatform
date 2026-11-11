import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import { ConditionReportForm } from "@/components/ConditionReportForm";
import { InsuranceTierPicker } from "@/components/InsuranceTierPicker";
import { SectionCard } from "@/components/mobile/operations-ui";
import { ScreenContainer } from "@/components/screen-container";
import { Notice } from "@/components/trust/ui";
import * as Auth from "@/lib/_core/auth";
import {
  isUuid,
  newIdempotencyKey,
  useSelectContractInsurance,
  type ConditionPhase,
} from "@/lib/rentalCondition";

/**
 * Rental condition evidence screen.
 *
 * Opened as:
 *   /rental-condition?contractId=<uuid>&phase=check_out|check_in[&offerId=<uuid>]
 *
 * Hosts ConditionReportForm; the recorded report id is shown with an exit
 * affordance once the append-only report is stored. At check-out (before
 * handover) the InsuranceTierPicker is hosted here so the renter can review
 * the offer's tiers and lock one onto the contract — the selection needs the
 * contract id, and the tier list needs the offer id, so `offerId` is an
 * optional param that gates the lock control (rentalInsurance.selectTier is
 * server-authorized to the contract worker).
 */
export default function RentalConditionScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    contractId?: string;
    phase?: string;
    offerId?: string;
  }>();

  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [submittedReportId, setSubmittedReportId] = useState<string | null>(
    null,
  );
  const [selectedTierId, setSelectedTierId] = useState<string | null>(null);
  const [insuranceError, setInsuranceError] = useState<string | null>(null);
  const [lockedSelectionId, setLockedSelectionId] = useState<string | null>(
    null,
  );
  const selectInsurance = useSelectContractInsurance();
  const insuranceKeyRef = useRef(newIdempotencyKey("rental-insurance-select"));

  // tRPC calls authenticate with the driver session bearer (see lib/trpc.ts);
  // surface the missing-session case explicitly like job-navigate does.
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
  const offerId = params.offerId ?? "";
  const phase: ConditionPhase | null =
    params.phase === "check_out" || params.phase === "check_in"
      ? params.phase
      : null;
  const paramsError = !isUuid(contractId)
    ? "Missing or invalid contractId param"
    : !phase
      ? 'phase param must be "check_out" or "check_in"'
      : null;

  const onLockInsurance = () => {
    if (!selectedTierId || !isUuid(contractId)) return;
    setInsuranceError(null);
    selectInsurance.mutate(
      {
        contractId,
        tierId: selectedTierId,
        idempotencyKey: insuranceKeyRef.current,
      },
      {
        onSuccess: (selectionId) => {
          insuranceKeyRef.current = newIdempotencyKey(
            "rental-insurance-select",
          );
          setLockedSelectionId(
            typeof selectionId === "string" ? selectionId : "locked",
          );
        },
        onError: (mutationError) => setInsuranceError(mutationError.message),
      },
    );
  };

  return (
    <ScreenContainer className="px-4">
      <Stack.Screen options={{ title: "Rental condition", headerShown: false }} />
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingVertical: 16, gap: 16 }}
      >
        <View>
          <Text className="text-2xl font-bold text-foreground">
            {phase === "check_in" ? "Return check-in" : "Pick-up check-out"}
          </Text>
          <Text className="mt-1 text-sm leading-5 text-muted">
            {phase === "check_in"
              ? "Document the vehicle's condition at return. The deltas against check-out drive the settlement."
              : "Document the vehicle's condition before handover. This evidence anchors the return settlement."}
          </Text>
        </View>

        {paramsError ? (
          <SectionCard title="Cannot record condition" subtitle={paramsError}>
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
            body="No session was found on this device. Sign in again so the condition report is recorded under your account."
          />
        ) : (
          <>
            {phase === "check_out" ? (
              <SectionCard
                title="Insurance cover"
                subtitle="Optional daily cover locked onto this contract before handover. The locked snapshot recomputes the deposit from its multiplier."
              >
                <InsuranceTierPicker
                  offerId={offerId}
                  selectedTierId={selectedTierId ?? undefined}
                  onSelect={(tierId) => {
                    setSelectedTierId(tierId);
                    setInsuranceError(null);
                  }}
                />
                {insuranceError ? (
                  <Notice
                    tone="error"
                    title="Insurance not locked"
                    body={insuranceError}
                  />
                ) : null}
                {lockedSelectionId ? (
                  <Notice
                    tone="success"
                    title="Insurance locked"
                    body={`Selection ${lockedSelectionId.slice(0, 8)}… is frozen onto this contract.`}
                  />
                ) : (
                  <Pressable
                    onPress={onLockInsurance}
                    disabled={
                      !selectedTierId ||
                      !isUuid(offerId) ||
                      selectInsurance.isPending
                    }
                    accessibilityRole="button"
                    accessibilityLabel="Lock selected insurance tier"
                    className="items-center rounded-full bg-primary px-4 py-4"
                    style={({ pressed }) => ({
                      opacity: pressed || selectInsurance.isPending ? 0.6 : 1,
                    })}
                  >
                    <Text className="text-sm font-semibold text-white">
                      {selectInsurance.isPending
                        ? "Locking…"
                        : "Lock selected tier"}
                    </Text>
                  </Pressable>
                )}
              </SectionCard>
            ) : null}
            <ConditionReportForm
              contractId={contractId}
              phase={phase}
              onSubmitted={setSubmittedReportId}
            />
            {submittedReportId ? (
              <Pressable
                onPress={() => router.back()}
                accessibilityRole="button"
                accessibilityLabel="Back to contract"
                className="items-center rounded-full border border-border bg-surface px-4 py-4"
                style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
              >
                <Text className="text-sm font-semibold text-foreground">
                  Back to contract
                </Text>
              </Pressable>
            ) : null}
          </>
        )}
      </ScrollView>
    </ScreenContainer>
  );
}
