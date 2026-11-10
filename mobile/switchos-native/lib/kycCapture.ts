/**
 * KYC document capture & AI extraction wave — mobile glue for the
 * `stakeholderVerification` tRPC router (frozen server contract on main).
 *
 * Same bridge pattern as lib/rentalCondition.ts: the platform router exists
 * on the deployed API but not in this app's embedded AppRouter type, so all
 * access is confined to this module's typed wrappers.
 *
 * Capture + extraction flow:
 *   1. captureDocumentPhoto() takes a camera photo (base64, quality 0.75)
 *      and hashes the bytes with the Hermes-safe pure-JS SHA-256 shared with
 *      the rental condition wave (expo-crypto is not available).
 *   2. recordEvidence is called WITH imageBase64 for image/jpeg payloads, so
 *      the server auto-runs MiniCPM-OCR extraction fire-and-forget and
 *      persists the result — extraction must never block submission.
 *   3. getExtractions({ caseId }) is polled/refetched to render the
 *      extracted fields once the background pass lands.
 *
 * Frozen contract limits enforced client-side BEFORE the mutation fires:
 *   - imageBase64 max 9,000,000 chars (zod .max(9_000_000))
 *   - objectKey ^[A-Za-z0-9][A-Za-z0-9._/-]+$, max 512
 *   - evidenceKind ^[a-z][a-z0-9_.-]{2,63}$
 *   - sha256Hex exactly 64 lowercase hex chars
 *   - idempotencyKey ^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$
 */
import * as ImagePicker from "expo-image-picker";

import {
  decodeBase64,
  isUuid,
  newIdempotencyKey,
  sha256HexOfBytes,
} from "@/lib/rentalCondition";
import { trpc } from "@/lib/trpc";

// ---------------------------------------------------------------------------
// Frozen contract enums
// ---------------------------------------------------------------------------

/**
 * Document kinds offered in the capture UI. The server pins evidenceKind only
 * by regex (^[a-z][a-z0-9_.-]{2,63}$); these are the kinds the extraction
 * prompt is tuned for (recordEvidence passes evidenceKind as documentHint).
 */
export type KycEvidenceKind =
  | "identity_document"
  | "driver_license"
  | "passport"
  | "utility_bill";

export const KYC_EVIDENCE_KINDS: { kind: KycEvidenceKind; label: string }[] = [
  { kind: "identity_document", label: "Identity document" },
  { kind: "driver_license", label: "Driver license" },
  { kind: "passport", label: "Passport" },
  { kind: "utility_bill", label: "Utility bill" },
];

/** Content types accepted by stakeholderVerification.recordEvidence. */
export type KycEvidenceContentType =
  | "application/pdf"
  | "image/jpeg"
  | "image/png"
  | "image/heic"
  | "video/mp4";

/** Frozen server cap: imageBase64 zod .max(9_000_000). */
export const MAX_IMAGE_BASE64_LENGTH = 9_000_000;

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/** stakeholderVerification.recordEvidence input shape (frozen contract). */
export interface RecordKycEvidenceInput {
  caseId: string;
  evidenceKind: KycEvidenceKind;
  objectKey: string;
  contentType: KycEvidenceContentType;
  sha256Hex: string;
  captureMetadata: Record<string, unknown>;
  imageBase64?: string;
  idempotencyKey: string;
}

/** stakeholderVerification.listCases row (data-access maps snake -> camel). */
export interface VerificationCaseSummary {
  id: string;
  subjectType: string;
  subjectKey: string;
  jurisdiction: string;
  purpose: string;
  state: string;
  expiresAt: string | null;
  updatedAt: string;
}

/** One extracted field inside a stakeholderVerification.getExtractions row. */
export interface DocumentExtractionField {
  field: string;
  value: string | null;
  confidence: number | null;
  needsReview: boolean;
}

/** stakeholderVerification.getExtractions row. */
export interface CaseExtraction {
  id: string;
  caseId: string;
  evidenceId: string;
  model: string;
  jevEnabled: boolean;
  fields: DocumentExtractionField[];
  extractedAt: string;
}

export interface KycQuery<TData> {
  data: TData | undefined;
  isLoading: boolean;
  isError: boolean;
  isRefetching: boolean;
  error: { message: string } | null;
  refetch: () => Promise<unknown>;
}

export interface KycMutationOptions<TData = unknown> {
  onSuccess?: (data: TData) => void;
  onError?: (error: { message: string }) => void;
}

export interface KycMutation<TVars, TData = unknown> {
  mutate: (vars: TVars, options?: KycMutationOptions<TData>) => void;
  mutateAsync: (vars: TVars) => Promise<TData>;
  data: TData | undefined;
  isPending: boolean;
  isError: boolean;
  isSuccess: boolean;
  error: { message: string } | null;
  reset: () => void;
}

const bridge = trpc as any;

function asQuery<TData>(query: any): KycQuery<TData> {
  return query as KycQuery<TData>;
}

function asMutation<TVars, TData = unknown>(
  mutation: any,
): KycMutation<TVars, TData> {
  return mutation as KycMutation<TVars, TData>;
}

// ---------------------------------------------------------------------------
// tRPC hooks
// ---------------------------------------------------------------------------

/** The caller's own verification cases (stakeholderVerification.listCases). */
export function useKycVerificationCases(limit = 50) {
  return asQuery<VerificationCaseSummary[]>(
    bridge.stakeholderVerification.listCases.useQuery(
      { limit },
      { staleTime: 15_000 },
    ),
  );
}

/**
 * Extraction rows for a case (stakeholderVerification.getExtractions). Pass
 * `poll: true` to refetch on an interval while a background extraction pass
 * is expected; the server runs it fire-and-forget after recordEvidence.
 */
export function useKycCaseExtractions(
  caseId: string,
  options: { poll?: boolean } = {},
) {
  const poll = options.poll === true;
  return asQuery<CaseExtraction[]>(
    bridge.stakeholderVerification.getExtractions.useQuery(
      { caseId },
      {
        enabled: isUuid(caseId),
        staleTime: 5_000,
        refetchInterval: poll ? 5_000 : false,
      },
    ),
  );
}

/**
 * recordEvidence carries imageBase64 for image/jpeg captures, which triggers
 * the server-side MiniCPM-OCR extraction (fire-and-forget, fail-open).
 */
export function useRecordKycEvidence() {
  return asMutation<RecordKycEvidenceInput, string>(
    bridge.stakeholderVerification.recordEvidence.useMutation(),
  );
}

export function useKycVerificationInvalidation() {
  const utils = bridge.useUtils();
  return {
    cases: () => {
      void utils.stakeholderVerification?.listCases?.invalidate();
    },
    extractions: () => {
      void utils.stakeholderVerification?.getExtractions?.invalidate();
    },
  };
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in the node sandbox)
// ---------------------------------------------------------------------------

/**
 * Deterministic object key for a document capture. The digest prefix is
 * embedded so retakes never collide and a replayed upload targets the same
 * object. Matches the frozen objectKey regex ^[A-Za-z0-9][A-Za-z0-9._/-]+$
 * (max 512) and the capture contract `kyc-evidence/<caseId>/<sha16>.jpg`.
 */
export function buildEvidenceObjectKey(
  caseId: string,
  sha256Hex: string,
): string {
  return `kyc-evidence/${caseId}/${sha256Hex.slice(0, 16)}.jpg`;
}

/**
 * Frozen-contract size guard: throws a user-presentable error when the
 * base64 payload would exceed the server's 9,000,000-char imageBase64 cap.
 * MUST run before recordEvidence is called.
 */
export function assertEvidenceImageSize(base64: string): void {
  if (base64.length > MAX_IMAGE_BASE64_LENGTH) {
    throw new Error(
      "This photo is too large to submit. Retake it a little farther from " +
        "the document or with more even lighting so it compresses smaller.",
    );
  }
}

/** Fresh idempotency slug: kyc-evidence-<ts36>-<rand16> (frozen key regex). */
export function newKycEvidenceIdempotencyKey(): string {
  return newIdempotencyKey("kyc-evidence");
}

/**
 * Build the recordEvidence input for a captured document. Applies the size
 * guard BEFORE returning, so callers can never dispatch an oversized payload.
 * imageBase64 is always included for image/jpeg so the server's automatic
 * MiniCPM-OCR extraction fires.
 */
export function buildRecordEvidenceInput(args: {
  caseId: string;
  evidenceKind: KycEvidenceKind;
  asset: CapturedDocumentPhoto;
  idempotencyKey?: string;
}): RecordKycEvidenceInput {
  assertEvidenceImageSize(args.asset.base64);
  return {
    caseId: args.caseId,
    evidenceKind: args.evidenceKind,
    objectKey: buildEvidenceObjectKey(args.caseId, args.asset.sha256Hex),
    contentType: args.asset.contentType,
    sha256Hex: args.asset.sha256Hex,
    captureMetadata: {
      source: "switchos-native/kyc-document-capture",
      byteLength: args.asset.byteLength,
      capturedAt: new Date().toISOString(),
    },
    imageBase64: args.asset.base64,
    idempotencyKey:
      args.idempotencyKey ?? newKycEvidenceIdempotencyKey(),
  };
}

/** Format an extraction confidence (0..1 or null) as a percentage label. */
export function formatConfidencePct(confidence: number | null): string {
  if (confidence === null || !Number.isFinite(confidence)) return "—";
  const clamped = Math.min(1, Math.max(0, confidence));
  return `${Math.round(clamped * 100)}%`;
}

// ---------------------------------------------------------------------------
// Capture + submit
// ---------------------------------------------------------------------------

/** A captured document photo ready for recordEvidence. */
export interface CapturedDocumentPhoto {
  base64: string;
  contentType: "image/jpeg";
  sha256Hex: string;
  /** Decoded byte length of the image payload. */
  byteLength: number;
  /** Local file URI used for the in-form preview only. */
  previewUri: string;
}

/**
 * Capture one document photo with the device camera and hash it. Returns
 * null when the user cancels. Throws with a user-presentable message on
 * permission failure, missing image data, or an oversized payload.
 */
export async function captureDocumentPhoto(): Promise<CapturedDocumentPhoto | null> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) {
    throw new Error(
      "Camera permission is required to capture your document.",
    );
  }
  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: ["images"],
    quality: 0.75,
    base64: true,
    exif: false,
  });
  if (result.canceled || !result.assets[0]) {
    return null;
  }
  const asset = result.assets[0];
  if (!asset.base64) {
    throw new Error("The captured photo did not include readable image data.");
  }
  assertEvidenceImageSize(asset.base64);
  const bytes = decodeBase64(asset.base64);
  const sha256Hex = sha256HexOfBytes(bytes);
  return {
    base64: asset.base64,
    contentType: "image/jpeg",
    sha256Hex,
    byteLength: bytes.length,
    previewUri: asset.uri,
  };
}

/**
 * Submit a captured document via recordEvidence WITH imageBase64 so the
 * server auto-runs MiniCPM-OCR extraction. The size guard runs inside
 * buildRecordEvidenceInput, before the mutation is dispatched. Resolves to
 * the evidence id returned by the server.
 */
export async function submitEvidenceWithExtraction(
  mutation: Pick<KycMutation<RecordKycEvidenceInput, string>, "mutateAsync">,
  args: {
    caseId: string;
    evidenceKind: KycEvidenceKind;
    asset: CapturedDocumentPhoto;
    idempotencyKey?: string;
  },
): Promise<string> {
  const input = buildRecordEvidenceInput(args);
  return mutation.mutateAsync(input);
}
