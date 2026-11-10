/**
 * Rental condition & insurance wave — mobile glue for the `rentalCondition`
 * and `rentalInsurance` tRPC routers (contract: dp-rental-wave/CONTRACT.md).
 *
 * Same bridge pattern as lib/economicsSafetyApi.ts: the platform routers
 * exist on the deployed API but not in this app's embedded AppRouter type,
 * so all access is confined to this module's typed wrappers.
 *
 * Photo evidence: expo-image-picker is available; expo-crypto is not, so the
 * SHA-256 of the captured bytes is computed by the Hermes-safe pure-JS
 * implementation below (same "no native deps" approach as lib/openride.ts).
 * Captures are uploaded to the API's condition-photo object endpoint before
 * the report is submitted — `record_condition_report` only accepts
 * pre-uploaded object keys plus their sha256 digest.
 */
import * as ImagePicker from "expo-image-picker";

import { getApiBaseUrl } from "@/constants/oauth";
import * as Auth from "@/lib/_core/auth";
import { trpc } from "@/lib/trpc";

// ---------------------------------------------------------------------------
// Frozen contract enums (mirror of the vehicle_access Postgres enums)
// ---------------------------------------------------------------------------

export type ConditionPhase = "check_out" | "check_in";

export type ConditionGrade =
  | "excellent"
  | "good"
  | "fair"
  | "poor"
  | "damaged";

export const CONDITION_GRADES: ConditionGrade[] = [
  "excellent",
  "good",
  "fair",
  "poor",
  "damaged",
];

export type PhotoZone =
  | "front"
  | "rear"
  | "left"
  | "right"
  | "interior_front"
  | "interior_rear"
  | "dashboard_odometer"
  | "wheels"
  | "roof"
  | "other";

export type PhotoZoneSpec = {
  zone: PhotoZone;
  label: string;
  /** dashboard_odometer is REQUIRED server-side; submit is blocked without it. */
  required: boolean;
};

export const PHOTO_ZONES: PhotoZoneSpec[] = [
  { zone: "front", label: "Front", required: false },
  { zone: "rear", label: "Rear", required: false },
  { zone: "left", label: "Left side", required: false },
  { zone: "right", label: "Right side", required: false },
  { zone: "interior_front", label: "Interior (front)", required: false },
  { zone: "interior_rear", label: "Interior (rear)", required: false },
  { zone: "dashboard_odometer", label: "Dashboard / odometer", required: true },
  { zone: "wheels", label: "Wheels & tyres", required: false },
  { zone: "roof", label: "Roof", required: false },
  { zone: "other", label: "Other", required: false },
];

/** Content types accepted by vehicle_access.condition_photo. */
export type ConditionPhotoContentType =
  | "image/jpeg"
  | "image/png"
  | "image/heic";

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/** One photo attached to a condition report (recordReport input shape). */
export interface ConditionPhotoInput {
  zone: PhotoZone;
  objectKey: string;
  contentType: ConditionPhotoContentType;
  sha256Hex: string;
  damageFlag: boolean;
  note?: string;
}

export interface RecordConditionReportInput {
  contractId: string;
  phase: ConditionPhase;
  odometerKm: number;
  fuelPct: number;
  overallCondition: ConditionGrade;
  notes?: string;
  photos: ConditionPhotoInput[];
  idempotencyKey: string;
}

/** listInsuranceTiersForOffer row (data-access layer maps snake -> camel). */
export interface InsuranceTier {
  id: string;
  tierCode: string;
  displayName: string;
  currency: string;
  /** bigint columns may arrive as strings over the wire. */
  dailyRateMinor: number | string;
  excessMinor: number | string;
  liabilityCapMinor: number | string;
  damageCapMinor: number | string;
  theftCovered: boolean;
  depositMultiplierBp: number;
}

export interface ComputeSettlementInput {
  contractId: string;
  damageChargeMinor: number;
  fuelChargeMinor: number;
  idempotencyKey: string;
}

export interface RentalQuery<TData> {
  data: TData | undefined;
  isLoading: boolean;
  isError: boolean;
  isRefetching: boolean;
  error: { message: string } | null;
  refetch: () => Promise<unknown>;
}

export interface RentalMutationOptions<TData = unknown> {
  onSuccess?: (data: TData) => void;
  onError?: (error: { message: string }) => void;
}

export interface RentalMutation<TVars, TData = unknown> {
  mutate: (vars: TVars, options?: RentalMutationOptions<TData>) => void;
  data: TData | undefined;
  isPending: boolean;
  isError: boolean;
  isSuccess: boolean;
  error: { message: string } | null;
  reset: () => void;
}

const bridge = trpc as any;

function asQuery<TData>(query: any): RentalQuery<TData> {
  return query as RentalQuery<TData>;
}

function asMutation<TVars, TData = unknown>(
  mutation: any,
): RentalMutation<TVars, TData> {
  return mutation as RentalMutation<TVars, TData>;
}

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isUuid(value: string | undefined | null): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

// ---------------------------------------------------------------------------
// tRPC hooks
// ---------------------------------------------------------------------------

export function useInsuranceTiersForOffer(offerId: string) {
  return asQuery<InsuranceTier[]>(
    bridge.rentalInsurance.listForOffer.useQuery(
      { offerId },
      { enabled: isUuid(offerId), staleTime: 30_000 },
    ),
  );
}

/** Worker-side insurance selection; the selection snapshot is frozen server-side. */
export function useSelectContractInsurance() {
  return asMutation<
    { contractId: string; tierId: string; idempotencyKey: string },
    string
  >(bridge.rentalInsurance.selectTier.useMutation());
}

export function useRecordConditionReport() {
  return asMutation<RecordConditionReportInput, string>(
    bridge.rentalCondition.recordReport.useMutation(),
  );
}

export function useConditionDeltaReport(contractId: string) {
  return asQuery<unknown>(
    bridge.rentalCondition.deltaReport.useQuery(
      { contractId },
      { enabled: isUuid(contractId), staleTime: 15_000 },
    ),
  );
}

/** Operator-only on the server (protectedProcedure + SQL is_operator gate). */
export function useComputeReturnSettlement() {
  return asMutation<ComputeSettlementInput, string>(
    bridge.rentalCondition.computeSettlement.useMutation(),
  );
}

export function useRentalConditionInvalidation() {
  const utils = bridge.useUtils();
  return {
    deltaReport: () => {
      void utils.rentalCondition?.deltaReport?.invalidate();
    },
    insurance: () => {
      void utils.rentalInsurance?.listForOffer?.invalidate();
    },
  };
}

// ---------------------------------------------------------------------------
// Idempotency keys — ^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$
// ---------------------------------------------------------------------------

const IDEMPOTENCY_ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/**
 * Timestamped slug key (Hermes has no guaranteed crypto.randomUUID). The
 * prefix must already match the key alphabet; time + random suffix keep
 * retries of the same user action distinct across form resets.
 */
export function newIdempotencyKey(prefix: string): string {
  const time = Date.now().toString(36);
  let random = "";
  for (let i = 0; i < 16; i += 1) {
    random += IDEMPOTENCY_ALPHABET.charAt(
      Math.floor(Math.random() * IDEMPOTENCY_ALPHABET.length),
    );
  }
  const key = `${prefix}-${time}-${random}`;
  return key.length > 128 ? key.slice(0, 128) : key;
}

// ---------------------------------------------------------------------------
// Hermes-safe base64 decode + SHA-256 (no native deps; see lib/openride.ts)
// ---------------------------------------------------------------------------

const BASE64_LOOKUP: Record<string, number> = (() => {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const table: Record<string, number> = {};
  for (let i = 0; i < alphabet.length; i += 1) {
    table[alphabet.charAt(i)] = i;
  }
  return table;
})();

/** Decode standard base64 (padding tolerated) into bytes. */
export function decodeBase64(value: string): Uint8Array {
  const clean = value.replace(/[^A-Za-z0-9+/=]/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = BASE64_LOOKUP[clean.charAt(i)] ?? 0;
    const c1 = BASE64_LOOKUP[clean.charAt(i + 1)] ?? 0;
    const c2 =
      clean.charAt(i + 2) === "=" ? 0 : (BASE64_LOOKUP[clean.charAt(i + 2)] ?? 0);
    const c3 =
      clean.charAt(i + 3) === "=" ? 0 : (BASE64_LOOKUP[clean.charAt(i + 3)] ?? 0);
    const triple = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    bytes.push((triple >> 16) & 0xff);
    if (clean.charAt(i + 2) !== "=" && i + 2 < clean.length) {
      bytes.push((triple >> 8) & 0xff);
    }
    if (clean.charAt(i + 3) !== "=" && i + 3 < clean.length) {
      bytes.push(triple & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

const SHA256_K: number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotr32(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/** FIPS 180-4 SHA-256 over raw bytes; verified against hashlib test vectors. */
export function sha256HexOfBytes(message: Uint8Array): string {
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const bitLength = message.length * 8;
  const paddedLength = (((message.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const w = new Uint32Array(64);
  for (let block = 0; block < paddedLength; block += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(block + i * 4);
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let i = 0; i < 64; i += 1) {
      const sum1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const choose = (e & f) ^ (~e & g);
      const t1 = (h + sum1 + choose + SHA256_K[i] + w[i]) >>> 0;
      const sum0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((word) => word.toString(16).padStart(8, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Photo capture + upload
// ---------------------------------------------------------------------------

/** A captured, uploaded zone photo ready for recordReport. */
export interface CapturedZonePhoto {
  zone: PhotoZone;
  objectKey: string;
  contentType: ConditionPhotoContentType;
  sha256Hex: string;
  /** Local file URI used for the in-form thumbnail only. */
  previewUri: string;
}

function normalizeContentType(
  mimeType: string | undefined,
): ConditionPhotoContentType {
  if (mimeType === "image/png" || mimeType === "image/heic") {
    return mimeType;
  }
  return "image/jpeg";
}

function extensionFor(contentType: ConditionPhotoContentType): string {
  switch (contentType) {
    case "image/png":
      return "png";
    case "image/heic":
      return "heic";
    default:
      return "jpg";
  }
}

/**
 * Deterministic object key for a zone photo. The digest is embedded so
 * retakes never collide and a replayed upload targets the same object.
 * Matches condition_photo.object_key: ^[A-Za-z0-9][A-Za-z0-9._/-]+$, 3..512.
 */
export function buildConditionPhotoObjectKey(
  contractId: string,
  phase: ConditionPhase,
  zone: PhotoZone,
  sha256Hex: string,
  contentType: ConditionPhotoContentType,
): string {
  return `rental-condition/${contractId}/${phase}/${zone}-${sha256Hex.slice(
    0,
    16,
  )}.${extensionFor(contentType)}`;
}

/**
 * Upload one captured photo to the platform object store. The companion API
 * route accepts the base64 payload, persists it under `objectKey`, and treats
 * repeat uploads of the same key + digest as an idempotent no-op. The binary
 * never travels through the tRPC mutation itself — recordReport only carries
 * objectKey + sha256Hex evidence.
 */
export async function uploadConditionPhoto(args: {
  objectKey: string;
  contentType: ConditionPhotoContentType;
  contentBase64: string;
}): Promise<void> {
  const token = await Auth.getSessionToken();
  const response = await fetch(`${getApiBaseUrl()}/api/rental-condition/photo`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      objectKey: args.objectKey,
      contentType: args.contentType,
      contentBase64: args.contentBase64,
    }),
  });
  if (!response.ok) {
    throw new Error(`Photo upload failed (${response.status})`);
  }
}

/**
 * Capture one zone photo with the device camera, hash it, upload it, and
 * return the evidence record. Returns null when the driver cancels.
 * Throws with a user-presentable message on permission or upload failure.
 */
export async function captureZonePhoto(
  zone: PhotoZone,
  context: { contractId: string; phase: ConditionPhase },
): Promise<CapturedZonePhoto | null> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) {
    throw new Error(
      "Camera permission is required to document the vehicle condition.",
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
  const contentType = normalizeContentType(asset.mimeType);
  const sha256Hex = sha256HexOfBytes(decodeBase64(asset.base64));
  const objectKey = buildConditionPhotoObjectKey(
    context.contractId,
    context.phase,
    zone,
    sha256Hex,
    contentType,
  );
  await uploadConditionPhoto({
    objectKey,
    contentType,
    contentBase64: asset.base64,
  });
  return { zone, objectKey, contentType, sha256Hex, previewUri: asset.uri };
}

// ---------------------------------------------------------------------------
// deltaReport normalization (jsonb payload; tolerate snake_case and the
// camelCase mapping the data-access wrapper may apply)
// ---------------------------------------------------------------------------

export interface NormalizedConditionPhoto {
  zone: PhotoZone;
  objectKey: string;
  damageFlag: boolean;
  note: string | null;
  sha256Hex: string;
}

export interface NormalizedPhaseReport {
  odometerKm: number;
  fuelPct: number;
  overallCondition: ConditionGrade | string;
  notes: string | null;
  createdAt: string | null;
  photos: NormalizedConditionPhoto[];
}

export interface NormalizedSettlement {
  currency: string;
  odometerOutKm: number;
  odometerInKm: number;
  distanceKm: number;
  billedWeeks: number;
  includedKm: number;
  excessKm: number;
  excessKmChargeMinor: number | string;
  fuelOutPct: number;
  fuelInPct: number;
  fuelChargeMinor: number | string;
  newDamageZones: string[];
  damageChargeMinor: number | string;
  renterDamageLiabilityMinor: number | string;
  insuranceCreditMinor: number | string;
  totalChargeMinor: number | string;
  createdAt: string | null;
}

export interface NormalizedDeltaReport {
  contractId: string | null;
  checkOut: NormalizedPhaseReport | null;
  checkIn: NormalizedPhaseReport | null;
  deltas: {
    odometerKm: number | null;
    fuelPct: number | null;
    newDamageZones: string[];
  } | null;
  settlement: NormalizedSettlement | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pick<T>(record: Record<string, unknown>, ...keys: string[]): T | undefined {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) {
      return record[key] as T;
    }
  }
  return undefined;
}

function toInt(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function normalizePhotos(raw: unknown): NormalizedConditionPhoto[] {
  if (!Array.isArray(raw)) return [];
  const photos: NormalizedConditionPhoto[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    if (!record) continue;
    const zone = pick<string>(record, "zone");
    if (!zone) continue;
    photos.push({
      zone: zone as PhotoZone,
      objectKey: pick<string>(record, "object_key", "objectKey") ?? "",
      damageFlag: Boolean(pick<boolean>(record, "damage_flag", "damageFlag")),
      note: pick<string>(record, "note") ?? null,
      sha256Hex: pick<string>(record, "sha256_hex", "sha256Hex") ?? "",
    });
  }
  return photos;
}

/** Accepts either {report, photos} or a flat report row with a photos array. */
export function normalizePhaseReport(raw: unknown): NormalizedPhaseReport | null {
  const wrapper = asRecord(raw);
  if (!wrapper) return null;
  const report = asRecord(wrapper.report) ?? wrapper;
  const odometer = pick<unknown>(report, "odometer_km", "odometerKm");
  if (odometer === undefined) return null;
  return {
    odometerKm: toInt(odometer),
    fuelPct: toInt(pick<unknown>(report, "fuel_pct", "fuelPct")),
    overallCondition:
      pick<string>(report, "overall_condition", "overallCondition") ?? "unknown",
    notes: pick<string>(report, "notes") ?? null,
    createdAt: pick<string>(report, "created_at", "createdAt") ?? null,
    photos: normalizePhotos(wrapper.photos ?? report.photos),
  };
}

export function normalizeSettlement(raw: unknown): NormalizedSettlement | null {
  const record = asRecord(raw);
  if (!record) return null;
  return {
    currency: pick<string>(record, "currency") ?? "NGN",
    odometerOutKm: toInt(pick<unknown>(record, "odometer_out_km", "odometerOutKm")),
    odometerInKm: toInt(pick<unknown>(record, "odometer_in_km", "odometerInKm")),
    distanceKm: toInt(pick<unknown>(record, "distance_km", "distanceKm")),
    billedWeeks: toInt(pick<unknown>(record, "billed_weeks", "billedWeeks")),
    includedKm: toInt(pick<unknown>(record, "included_km", "includedKm")),
    excessKm: toInt(pick<unknown>(record, "excess_km", "excessKm")),
    excessKmChargeMinor:
      pick<number | string>(record, "excess_km_charge_minor", "excessKmChargeMinor") ?? 0,
    fuelOutPct: toInt(pick<unknown>(record, "fuel_out_pct", "fuelOutPct")),
    fuelInPct: toInt(pick<unknown>(record, "fuel_in_pct", "fuelInPct")),
    fuelChargeMinor:
      pick<number | string>(record, "fuel_charge_minor", "fuelChargeMinor") ?? 0,
    newDamageZones: Array.isArray(
      pick<unknown>(record, "new_damage_zones", "newDamageZones"),
    )
      ? (pick<string[]>(record, "new_damage_zones", "newDamageZones") ?? [])
      : [],
    damageChargeMinor:
      pick<number | string>(record, "damage_charge_minor", "damageChargeMinor") ?? 0,
    renterDamageLiabilityMinor:
      pick<number | string>(
        record,
        "renter_damage_liability_minor",
        "renterDamageLiabilityMinor",
      ) ?? 0,
    insuranceCreditMinor:
      pick<number | string>(record, "insurance_credit_minor", "insuranceCreditMinor") ?? 0,
    totalChargeMinor:
      pick<number | string>(record, "total_charge_minor", "totalChargeMinor") ?? 0,
    createdAt: pick<string>(record, "created_at", "createdAt") ?? null,
  };
}

export function normalizeDeltaReport(raw: unknown): NormalizedDeltaReport | null {
  const record = asRecord(raw);
  if (!record) return null;
  const deltas = asRecord(record.deltas);
  return {
    contractId: pick<string>(record, "contract_id", "contractId") ?? null,
    checkOut: normalizePhaseReport(pick<unknown>(record, "check_out", "checkOut")),
    checkIn: normalizePhaseReport(pick<unknown>(record, "check_in", "checkIn")),
    deltas: deltas
      ? {
          odometerKm:
            pick<unknown>(deltas, "odometer_km", "odometerKm") === undefined
              ? null
              : toInt(pick<unknown>(deltas, "odometer_km", "odometerKm")),
          fuelPct:
            pick<unknown>(deltas, "fuel_pct", "fuelPct") === undefined
              ? null
              : toInt(pick<unknown>(deltas, "fuel_pct", "fuelPct")),
          newDamageZones: Array.isArray(
            pick<unknown>(deltas, "new_damage_zones", "newDamageZones"),
          )
            ? (pick<string[]>(deltas, "new_damage_zones", "newDamageZones") ?? [])
            : [],
        }
      : null,
    settlement: normalizeSettlement(record.settlement),
  };
}
