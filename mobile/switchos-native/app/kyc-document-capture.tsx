import { Stack } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  Image,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from "react-native";

import { SectionCard } from "@/components/mobile/operations-ui";
import { ScreenContainer } from "@/components/screen-container";
import {
  BackHeader,
  KeyValueRow,
  Notice,
  StatusPill,
} from "@/components/trust/ui";
import * as Auth from "@/lib/_core/auth";
import {
  KYC_EVIDENCE_KINDS,
  buildRecordEvidenceInput,
  captureDocumentPhoto,
  formatConfidencePct,
  newKycEvidenceIdempotencyKey,
  useKycCaseExtractions,
  useKycVerificationCases,
  useRecordKycEvidence,
  type CapturedDocumentPhoto,
  type CaseExtraction,
  type KycEvidenceKind,
  type VerificationCaseSummary,
} from "@/lib/kycCapture";
import { formatDateTime } from "@/lib/money";
import { isUuid, newIdempotencyKey } from "@/lib/rentalCondition";

/**
 * KYC document capture & AI extraction screen.
 *
 * The driver picks one of their own stakeholderVerification cases, chooses a
 * document kind, captures a photo, and submits it via recordEvidence WITH
 * imageBase64 — the server then auto-runs MiniCPM-OCR extraction
 * (fire-and-forget) and the extracted fields appear below via getExtractions
 * (polled briefly after each submission, plus pull-to-refresh).
 */

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 60_000;

function caseStateTone(state: string) {
  if (state === "verified" || state === "approved") return "success" as const;
  if (state === "pending" || state === "in_review") return "info" as const;
  if (state === "rejected" || state === "expired") return "error" as const;
  return "warning" as const;
}

function CaseSelector({
  cases,
  selectedCaseId,
  onSelect,
}: {
  cases: VerificationCaseSummary[];
  selectedCaseId: string | null;
  onSelect: (caseId: string) => void;
}) {
  return (
    <SectionCard
      title="Verification case"
      subtitle="Evidence is attached to one of your own verification cases."
    >
      {cases.map((entry) => {
        const selected = entry.id === selectedCaseId;
        return (
          <Pressable
            key={entry.id}
            onPress={() => onSelect(entry.id)}
            accessibilityRole="button"
            accessibilityLabel={`Select ${entry.purpose} case`}
            className={`gap-2 rounded-[16px] border px-4 py-3 ${
              selected
                ? "border-primary bg-primary/20"
                : "border-border bg-background/60"
            }`}
          >
            <View className="flex-row flex-wrap items-center gap-2">
              <Text
                className={`text-sm font-semibold ${
                  selected ? "text-foreground" : "text-muted"
                }`}
              >
                {entry.purpose}
              </Text>
              <StatusPill
                label={entry.state}
                tone={caseStateTone(entry.state)}
              />
            </View>
            <Text className="text-xs text-muted">
              {entry.subjectType} · {entry.jurisdiction} · updated{" "}
              {formatDateTime(entry.updatedAt)}
            </Text>
          </Pressable>
        );
      })}
    </SectionCard>
  );
}

function DocumentKindSelector({
  kind,
  onSelect,
}: {
  kind: KycEvidenceKind;
  onSelect: (kind: KycEvidenceKind) => void;
}) {
  return (
    <View className="gap-1">
      <Text className="text-xs uppercase tracking-wide text-muted">
        Document kind
      </Text>
      <View className="flex-row flex-wrap gap-2">
        {KYC_EVIDENCE_KINDS.map((entry) => {
          const selected = entry.kind === kind;
          return (
            <Pressable
              key={entry.kind}
              onPress={() => onSelect(entry.kind)}
              accessibilityRole="button"
              accessibilityLabel={`Document kind: ${entry.label}`}
              className={`rounded-full border px-3 py-2 ${
                selected
                  ? "border-primary bg-primary/20"
                  : "border-border bg-background/60"
              }`}
            >
              <Text
                className={`text-xs font-semibold ${
                  selected ? "text-foreground" : "text-muted"
                }`}
              >
                {entry.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function ExtractionCard({ extraction }: { extraction: CaseExtraction }) {
  return (
    <View className="gap-3 rounded-[16px] border border-border/60 bg-surface px-4 py-3">
      <View className="flex-row flex-wrap items-center gap-2">
        <StatusPill label={extraction.model} tone="info" />
        <StatusPill
          label={extraction.jevEnabled ? "JEV on" : "JEV off"}
          tone="neutral"
        />
        <Text className="text-[10px] text-muted">
          {formatDateTime(extraction.extractedAt)}
        </Text>
      </View>
      <View>
        {extraction.fields.map((field) => (
          <View
            key={field.field}
            className="gap-1 border-b border-border/40 py-2 last:border-b-0"
          >
            <View className="flex-row items-center justify-between gap-3">
              <Text className="text-sm capitalize text-muted">
                {field.field}
              </Text>
              <Text className="shrink text-right text-sm font-medium text-foreground">
                {field.value ?? "Not detected"}
              </Text>
            </View>
            <View className="flex-row items-center justify-between gap-3">
              <Text className="text-xs text-muted">
                Confidence {formatConfidencePct(field.confidence)}
              </Text>
              {field.needsReview ? (
                <StatusPill label="Needs review" tone="warning" />
              ) : null}
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

function ExtractionsSection({
  extractions,
  polling,
}: {
  extractions: ReturnType<typeof useKycCaseExtractions>;
  polling: boolean;
}) {
  return (
    <SectionCard
      title="Extracted fields"
      subtitle="MiniCPM-OCR reads the submitted document and flags uncertain fields for review."
    >
      {extractions.isLoading ? (
        <Text className="text-sm text-muted">Loading extractions…</Text>
      ) : extractions.isError ? (
        <Notice
          tone="warning"
          title="Extractions unavailable"
          body={
            extractions.error?.message ??
            "Could not load extractions. Pull to refresh."
          }
        />
      ) : !extractions.data || extractions.data.length === 0 ? (
        <Notice
          tone="neutral"
          title="No extractions yet"
          body="Extraction runs automatically after submission — pull to refresh."
        />
      ) : (
        extractions.data.map((extraction) => (
          <ExtractionCard key={extraction.id} extraction={extraction} />
        ))
      )}
      {polling ? (
        <Text className="text-xs text-muted">
          Waiting for extraction… this refreshes automatically.
        </Text>
      ) : null}
    </SectionCard>
  );
}

export default function KycDocumentCaptureScreen() {
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);

  const casesQuery = useKycVerificationCases();
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [kind, setKind] = useState<KycEvidenceKind>("identity_document");
  const [capture, setCapture] = useState<CapturedDocumentPhoto | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [submittedEvidenceId, setSubmittedEvidenceId] = useState<
    string | null
  >(null);
  const [polling, setPolling] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const recordEvidence = useRecordKycEvidence();
  const extractions = useKycCaseExtractions(selectedCaseId ?? "", { poll: polling });
  const idempotencyKeyRef = useRef(newKycEvidenceIdempotencyKey());

  // tRPC calls authenticate with the driver session bearer (see lib/trpc.ts);
  // surface the missing-session case explicitly like rental-condition does.
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

  // Preselect the most recently updated case once the list loads.
  useEffect(() => {
    if (!selectedCaseId && casesQuery.data && casesQuery.data.length > 0) {
      setSelectedCaseId(casesQuery.data[0].id);
    }
  }, [casesQuery.data, selectedCaseId]);

  // Stop polling as soon as extraction rows land or after the timeout.
  useEffect(() => {
    if (polling && extractions.data && extractions.data.length > 0) {
      setPolling(false);
      return;
    }
    if (!polling) return;
    const timer = setTimeout(() => setPolling(false), POLL_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [polling, extractions.data]);

  const onCapture = async () => {
    setActionError(null);
    setCapturing(true);
    try {
      const photo = await captureDocumentPhoto();
      if (photo) {
        setCapture(photo);
        setSubmittedEvidenceId(null);
      }
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Could not capture the photo.",
      );
    } finally {
      setCapturing(false);
    }
  };

  const onSubmit = () => {
    if (!selectedCaseId || !isUuid(selectedCaseId) || !capture) return;
    setActionError(null);
    let input;
    try {
      // The frozen-contract size guard runs here, BEFORE the mutation fires.
      input = buildRecordEvidenceInput({
        caseId: selectedCaseId,
        evidenceKind: kind,
        asset: capture,
        idempotencyKey: idempotencyKeyRef.current,
      });
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "The photo cannot be submitted.",
      );
      return;
    }
    recordEvidence.mutate(input, {
      onSuccess: (evidenceId) => {
        idempotencyKeyRef.current = newIdempotencyKey("kyc-evidence");
        setSubmittedEvidenceId(
          typeof evidenceId === "string" ? evidenceId : null,
        );
        setCapture(null);
        setPolling(true);
        void extractions.refetch();
      },
      onError: (mutationError) => setActionError(mutationError.message),
    });
  };

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await casesQuery.refetch();
      if (selectedCaseId) {
        await extractions.refetch();
      }
    } finally {
      setRefreshing(false);
    }
  };

  const cases = casesQuery.data ?? [];

  return (
    <ScreenContainer className="px-4">
      <Stack.Screen
        options={{ title: "Document verification", headerShown: false }}
      />
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingVertical: 16, gap: 16 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
      >
        <BackHeader
          title="Document verification"
          subtitle="Photograph an identity or residency document. It is hashed on-device, attached to your verification case, and read automatically by the extraction service."
        />

        {sessionLoading ? (
          <SectionCard title="Checking session">
            <Text className="text-sm text-muted">Loading your session…</Text>
          </SectionCard>
        ) : !sessionToken ? (
          <Notice
            tone="error"
            title="Sign-in required"
            body="No session was found on this device. Sign in again so the evidence is recorded under your account."
          />
        ) : casesQuery.isLoading ? (
          <SectionCard title="Loading cases">
            <Text className="text-sm text-muted">
              Loading your verification cases…
            </Text>
          </SectionCard>
        ) : casesQuery.isError ? (
          <View className="gap-3">
            <Notice
              tone="warning"
              title="Verification cases unavailable"
              body={
                casesQuery.error?.message ??
                "Your verification cases could not be loaded."
              }
            />
            <Pressable
              onPress={() => void casesQuery.refetch()}
              disabled={casesQuery.isRefetching}
              accessibilityRole="button"
              accessibilityLabel="Retry loading cases"
              className="self-start rounded-full bg-primary px-4 py-2 disabled:opacity-50"
            >
              <Text className="text-xs font-semibold text-white">
                {casesQuery.isRefetching ? "Retrying…" : "Retry"}
              </Text>
            </Pressable>
          </View>
        ) : cases.length === 0 ? (
          <Notice
            tone="info"
            title="No verification cases yet"
            body="A verification case is created when you start identity verification. Come back once a case exists to attach document evidence."
          />
        ) : (
          <>
            <CaseSelector
              cases={cases}
              selectedCaseId={selectedCaseId}
              onSelect={(caseId) => {
                setSelectedCaseId(caseId);
                setCapture(null);
                setActionError(null);
              }}
            />

            <SectionCard
              title="Capture document"
              subtitle="Lay the document flat with even lighting. The photo is hashed on-device; the digest proves integrity."
            >
              <DocumentKindSelector kind={kind} onSelect={setKind} />

              {capture ? (
                <View className="gap-2 rounded-[16px] border border-border/60 bg-surface px-3 py-3">
                  <Image
                    source={{ uri: capture.previewUri }}
                    accessibilityLabel="Captured document preview"
                    style={{ width: "100%", height: 220, borderRadius: 12 }}
                    resizeMode="cover"
                  />
                  <View>
                    <KeyValueRow
                      label="SHA-256"
                      value={`${capture.sha256Hex.slice(0, 16)}…`}
                    />
                    <KeyValueRow
                      label="Size"
                      value={`${capture.byteLength.toLocaleString()} bytes`}
                    />
                  </View>
                </View>
              ) : null}

              {actionError ? (
                <Notice tone="error" title="Not submitted" body={actionError} />
              ) : null}
              {submittedEvidenceId ? (
                <Notice
                  tone="success"
                  title="Evidence recorded"
                  body={`Evidence ${submittedEvidenceId.slice(0, 8)}… was attached to the case. Extraction runs automatically.`}
                />
              ) : null}

              <View className="flex-row gap-3">
                <Pressable
                  onPress={onCapture}
                  disabled={capturing || recordEvidence.isPending}
                  accessibilityRole="button"
                  accessibilityLabel={
                    capture ? "Retake photo" : "Capture document photo"
                  }
                  className={`items-center rounded-full border px-4 py-3 ${
                    capture
                      ? "border-border bg-surface"
                      : "flex-1 border-primary bg-primary"
                  }`}
                  style={({ pressed }) => ({
                    opacity: pressed || capturing ? 0.6 : 1,
                  })}
                >
                  <Text
                    className={`text-sm font-semibold ${
                      capture ? "text-foreground" : "text-white"
                    }`}
                  >
                    {capturing
                      ? "Opening camera…"
                      : capture
                        ? "Retake"
                        : "Capture photo"}
                  </Text>
                </Pressable>
                {capture ? (
                  <Pressable
                    onPress={onSubmit}
                    disabled={recordEvidence.isPending || !selectedCaseId}
                    accessibilityRole="button"
                    accessibilityLabel="Submit document evidence"
                    className="flex-1 items-center rounded-full bg-primary px-4 py-3"
                    style={({ pressed }) => ({
                      opacity:
                        pressed || recordEvidence.isPending ? 0.6 : 1,
                    })}
                  >
                    <Text className="text-sm font-semibold text-white">
                      {recordEvidence.isPending
                        ? "Submitting…"
                        : "Submit evidence"}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            </SectionCard>

            {selectedCaseId ? (
              <ExtractionsSection
                extractions={extractions}
                polling={polling}
              />
            ) : null}
          </>
        )}
      </ScrollView>
    </ScreenContainer>
  );
}
