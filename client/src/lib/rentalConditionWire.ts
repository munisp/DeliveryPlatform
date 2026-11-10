/**
 * Wire-shape normalizers and minor-unit helpers for the rental condition &
 * insurance wave (drizzle/0096_rental_condition_insurance.sql; routers in
 * server/rental/conditionInsurance.ts).
 *
 * `rentalCondition.deltaReport` preserves the check-out / check-in report
 * and return-settlement jsonb verbatim (snake_case keys, bigint columns
 * possibly stringified); these normalizers map the payloads to the
 * camelCase view models the panels render, tolerating either key style —
 * the same defensive approach as ./economicsWire and the mobile sibling
 * mobile/switchos-native/lib/rentalCondition.ts. Free of trpc/react imports
 * so the wire contract can be unit-tested against server fixtures.
 */

// ---------- frozen contract enums (mirror of the vehicle_access Postgres enums) ----------

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

export function photoZoneLabel(zone: string): string {
  return PHOTO_ZONES.find((spec) => spec.zone === zone)?.label ?? zone;
}

/** Content types accepted by vehicle_access.condition_photo. */
export type ConditionPhotoContentType =
  | "image/jpeg"
  | "image/png"
  | "image/heic";

export const CONDITION_PHOTO_CONTENT_TYPES: ConditionPhotoContentType[] = [
  "image/jpeg",
  "image/png",
  "image/heic",
];

// ---------- identifiers & minor-unit money ----------

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isUuid(value: string | undefined | null): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/**
 * Convert a major-unit form value (e.g. "1500.00") to integer minor units
 * with a bigint-range guard mirroring the server-side `z.number().int().min(0).safe()`
 * checks. Throws with a user-presentable message on invalid input.
 */
export function parseMajorToMinor(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Enter a valid non-negative ${label}.`);
  }
  const minor = Math.round(parsed * 100);
  if (!Number.isSafeInteger(minor)) {
    throw new Error(
      `The ${label} exceeds the supported range for minor-unit storage.`,
    );
  }
  return minor;
}

/** deposit_multiplier_bp is basis points of the base deposit: 12500 -> ×1.25. */
export function formatDepositMultiplier(multiplierBp: number): string {
  return `×${(multiplierBp / 10_000).toFixed(2)}`;
}

// ---------- deltaReport normalization ----------

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
  excessKmChargeMinor: number;
  fuelOutPct: number;
  fuelInPct: number;
  fuelChargeMinor: number;
  newDamageZones: string[];
  damageChargeMinor: number;
  renterDamageLiabilityMinor: number;
  insuranceCreditMinor: number;
  totalChargeMinor: number;
  createdAt: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pick<T>(
  record: Record<string, unknown>,
  ...keys: string[]
): T | undefined {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) {
      return record[key] as T;
    }
  }
  return undefined;
}

/** bigint columns arrive as string|number; coerce defensively, never NaN. */
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
export function normalizePhaseReport(
  raw: unknown,
): NormalizedPhaseReport | null {
  const wrapper = asRecord(raw);
  if (!wrapper) return null;
  const report = asRecord(wrapper.report) ?? wrapper;
  const odometer = pick<unknown>(report, "odometer_km", "odometerKm");
  if (odometer === undefined) return null;
  return {
    odometerKm: toInt(odometer),
    fuelPct: toInt(pick<unknown>(report, "fuel_pct", "fuelPct")),
    overallCondition:
      pick<string>(report, "overall_condition", "overallCondition") ??
      "unknown",
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
    odometerOutKm: toInt(
      pick<unknown>(record, "odometer_out_km", "odometerOutKm"),
    ),
    odometerInKm: toInt(
      pick<unknown>(record, "odometer_in_km", "odometerInKm"),
    ),
    distanceKm: toInt(pick<unknown>(record, "distance_km", "distanceKm")),
    billedWeeks: toInt(pick<unknown>(record, "billed_weeks", "billedWeeks")),
    includedKm: toInt(pick<unknown>(record, "included_km", "includedKm")),
    excessKm: toInt(pick<unknown>(record, "excess_km", "excessKm")),
    excessKmChargeMinor: toInt(
      pick<unknown>(record, "excess_km_charge_minor", "excessKmChargeMinor"),
    ),
    fuelOutPct: toInt(pick<unknown>(record, "fuel_out_pct", "fuelOutPct")),
    fuelInPct: toInt(pick<unknown>(record, "fuel_in_pct", "fuelInPct")),
    fuelChargeMinor: toInt(
      pick<unknown>(record, "fuel_charge_minor", "fuelChargeMinor"),
    ),
    newDamageZones: Array.isArray(
      pick<unknown>(record, "new_damage_zones", "newDamageZones"),
    )
      ? (pick<string[]>(record, "new_damage_zones", "newDamageZones") ?? [])
      : [],
    damageChargeMinor: toInt(
      pick<unknown>(record, "damage_charge_minor", "damageChargeMinor"),
    ),
    renterDamageLiabilityMinor: toInt(
      pick<unknown>(
        record,
        "renter_damage_liability_minor",
        "renterDamageLiabilityMinor",
      ),
    ),
    insuranceCreditMinor: toInt(
      pick<unknown>(record, "insurance_credit_minor", "insuranceCreditMinor"),
    ),
    totalChargeMinor: toInt(
      pick<unknown>(record, "total_charge_minor", "totalChargeMinor"),
    ),
    createdAt: pick<string>(record, "created_at", "createdAt") ?? null,
  };
}
