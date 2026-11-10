import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import { ConditionReportForm } from "@/components/ConditionReportForm";
import { SectionCard } from "@/components/mobile/operations-ui";
import { ScreenContainer } from "@/components/screen-container";
import { Notice } from "@/components/trust/ui";
import * as Auth from "@/lib/_core/auth";
import { isUuid, type ConditionPhase } from "@/lib/rentalCondition";

/**
 * Rental condition evidence screen.
 *
 * Opened as:
 *   /rental-condition?contractId=<uuid>&phase=check_out|check_in
 *
 * Hosts ConditionReportForm; the recorded report id is shown with an exit
 * affordance once the append-only report is stored.
 */
export default function RentalConditionScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ contractId?: string; phase?: string }>();

  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [submittedReportId, setSubmittedReportId] = useState<string | null>(
    null,
  );

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
  const phase: ConditionPhase | null =
    params.phase === "check_out" || params.phase === "check_in"
      ? params.phase
      : null;
  const paramsError = !isUuid(contractId)
    ? "Missing or invalid contractId param"
    : !phase
      ? 'phase param must be "check_out" or "check_in"'
      : null;

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
