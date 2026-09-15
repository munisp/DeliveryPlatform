import { createHash } from "crypto";

import { TRPCError } from "@trpc/server";

import { getPool } from "../db";
import { ENV } from "./env";
import { resilientFetch } from "./resilientFetch";

/**
 * Data transparency + portability (R14).
 *
 * A worker can request a signed export of their work record. The payload is
 * assembled from the trip/earnings sources that exist today (profile from
 * public.users, rider-side trips from rider_trips, driver earnings rollups
 * from offer_economics_breakdowns + mobility.driver_offer), serialized as
 * canonical JSON (recursively sorted keys, UTF-8) and POSTed to the Rust
 * work-record-signer (WORK_RECORD_SIGNER_URL, default http://127.0.0.1:8109)
 * which returns payload_hash/signature/key_id/public_key.
 *
 * KNOWN GAPS (assembled per-source with independent fail-open guards; each
 * missing source is listed in payload.meta.gaps):
 * - ratings: no user-keyed ratings table exists yet (driver_reviews keys on
 *   the courier-domain drivers.id, not public.users.id) — reported as a gap.
 * - safety/device: no user-keyed safety-signal or device-attestation store
 *   exists yet — reported as a gap.
 *
 * FAIL-OPEN contract: a signer outage never throws and never loses the
 * export — the row stays 'pending' with a retry hint. verifyExport returns
 * { valid: null, reason: 'verifier_unavailable' } plus offline-verify
 * instructions (sha256 of the canonical payload) when the signer is down.
 */

export const DISCLOSURE_CATEGORIES = [
  "profile",
  "trips",
  "earnings",
  "ratings",
  "safety",
  "device",
  "other",
] as const;
export type DisclosureCategory = (typeof DISCLOSURE_CATEGORIES)[number];

export const EXPORT_STATUSES = [
  "pending",
  "signed",
  "delivered",
  "revoked",
] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

export type WorkRecordExportRow = {
  id: string;
  user_id: number | string;
  period_start: string | Date;
  period_end: string | Date;
  payload: unknown;
  payload_hash: string | null;
  signature: string | null;
  signer_key_id: string | null;
  signer_public_key: string | null;
  status: ExportStatus;
  created_at: string | Date;
  signed_at: string | Date | null;
};

export type DataTransparencyDisclosureRow = {
  id: string;
  user_id: number | string;
  category: DisclosureCategory;
  detail: unknown;
  disclosed_at: string | Date;
};

/**
 * Canonical JSON: object keys recursively sorted, arrays kept in order,
 * numbers/booleans/null per JSON.stringify. This is the exact byte string
 * the signer hashes and signs — callers must never reformat it.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = sortKeysDeep(source[key]);
    }
    return out;
  }
  return value;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export type WorkRecordPayload = {
  schema: "work-record/v1";
  user_id: number;
  period: { start: string; end: string };
  generated_at: string;
  profile: Record<string, unknown> | null;
  trips: Array<Record<string, unknown>>;
  earnings: Record<string, unknown> | null;
  meta: { sources: string[]; gaps: string[] };
};

/**
 * Assemble the work-record payload. Every source is queried independently
 * and fail-open: an unavailable table degrades to a recorded gap instead of
 * failing the export.
 */
export async function assembleWorkRecordPayload(
  userId: number,
  periodStart: Date,
  periodEnd: Date,
): Promise<WorkRecordPayload> {
  const pool = await getPool();
  const sources: string[] = [];
  const gaps: string[] = [];

  let profile: Record<string, unknown> | null = null;
  try {
    const result = await pool.query(
      `SELECT id, name, email, login_method, role, created_at, last_signed_in
       FROM public.users WHERE id = $1`,
      [userId],
    );
    profile = result.rows[0] ?? null;
    sources.push("profile");
  } catch {
    gaps.push("profile_unavailable");
  }

  let trips: Array<Record<string, unknown>> = [];
  try {
    const result = await pool.query(
      `SELECT id, status, trip_type, vehicle_class, modality,
              pickup_label, dropoff_label, fare_minor, currency,
              requested_at, completed_at
       FROM public.rider_trips
       WHERE rider_user_id = $1
         AND requested_at >= $2 AND requested_at < $3
       ORDER BY requested_at ASC`,
      [userId, periodStart, periodEnd],
    );
    trips = result.rows;
    sources.push("trips");
  } catch {
    gaps.push("trips_unavailable");
  }

  let earnings: Record<string, unknown> | null = null;
  try {
    const result = await pool.query(
      `SELECT count(*)::int AS offers,
              coalesce(sum(b.base_minor + b.distance_minor + b.time_minor), 0) AS gross_minor,
              coalesce(sum(b.deadhead_minor), 0) AS deadhead_minor,
              coalesce(sum(b.platform_fee_minor), 0) AS platform_fee_minor,
              coalesce(sum(b.net_to_driver_minor), 0) AS net_to_driver_minor
       FROM public.offer_economics_breakdowns b
       JOIN mobility.driver_offer o ON o.id::text = b.offer_id
       WHERE o.driver_user_id = $1
         AND b.created_at >= $2 AND b.created_at < $3`,
      [userId, periodStart, periodEnd],
    );
    earnings = { currency: "NGN", ...(result.rows[0] ?? {}) };
    sources.push("earnings");
  } catch {
    gaps.push("earnings_unavailable");
  }

  // Documented gaps: no user-keyed ratings or safety/device stores exist yet.
  gaps.push("ratings_not_exportable_yet", "safety_device_not_exportable_yet");

  return {
    schema: "work-record/v1",
    user_id: userId,
    period: { start: periodStart.toISOString(), end: periodEnd.toISOString() },
    generated_at: new Date().toISOString(),
    profile,
    trips,
    earnings,
    meta: { sources, gaps },
  };
}

type SignerSignResponse = {
  payload_hash: string;
  signature_b64: string;
  key_id: string;
  public_key_b64: string;
};

/**
 * POST the canonical payload to the Rust work-record-signer. Strictly
 * fail-open per module doc: returns null on any outage, never throws.
 */
export async function signWorkRecord(
  canonicalPayload: string,
): Promise<SignerSignResponse | null> {
  const base = ENV.workRecordSignerUrl.replace(/\/$/, "");
  try {
    const response = await resilientFetch(`${base}/sign`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-service-token": ENV.internalServiceToken,
      },
      body: JSON.stringify({ payload: canonicalPayload }),
      timeoutMs: 5_000,
      maxAttempts: 1,
    });
    if (!response.ok) {
      throw new Error(`signer /sign returned status ${response.status}`);
    }
    return (await response.json()) as SignerSignResponse;
  } catch (error) {
    console.warn(
      "[dataPortability] work-record signer unavailable; export stays pending",
      error,
    );
    return null;
  }
}

/**
 * Request a signed work-record export. The row is persisted first (status
 * 'pending' with payload + payload_hash), then signing is attempted. Signer
 * down -> the export stays 'pending' and the caller gets a retry hint; the
 * procedure never throws on a signer outage.
 */
export async function requestExport(
  userId: number,
  input: { periodStart: Date; periodEnd: Date },
): Promise<{
  export: WorkRecordExportRow;
  signed: boolean;
  retryHint: string | null;
}> {
  if (input.periodEnd.getTime() <= input.periodStart.getTime()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "period_end_must_be_after_period_start",
    });
  }
  const payload = await assembleWorkRecordPayload(
    userId,
    input.periodStart,
    input.periodEnd,
  );
  const canonical = canonicalJson(payload);
  const payloadHash = sha256Hex(canonical);

  const pool = await getPool();
  const inserted = await pool.query<WorkRecordExportRow>(
    `INSERT INTO public.work_record_exports
       (user_id, period_start, period_end, payload, payload_hash, status)
     VALUES ($1, $2, $3, $4::jsonb, $5, 'pending')
     RETURNING *`,
    [
      userId,
      input.periodStart,
      input.periodEnd,
      canonical,
      payloadHash,
    ],
  );
  const row = inserted.rows[0];
  if (!row) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "work_record_export_creation_failed",
    });
  }

  const signed = await signWorkRecord(canonical);
  if (!signed) {
    return {
      export: row,
      signed: false,
      retryHint:
        "signer_unavailable:export_kept_pending;retry_request_or_resign_later",
    };
  }

  const updated = await pool.query<WorkRecordExportRow>(
    `UPDATE public.work_record_exports
     SET payload_hash = $2,
         signature = $3,
         signer_key_id = $4,
         signer_public_key = $5,
         status = 'signed',
         signed_at = now()
     WHERE id = $1
     RETURNING *`,
    [row.id, signed.payload_hash, signed.signature_b64, signed.key_id, signed.public_key_b64],
  );
  return { export: updated.rows[0] ?? row, signed: true, retryHint: null };
}

export async function listMyExports(
  userId: number,
): Promise<WorkRecordExportRow[]> {
  const pool = await getPool();
  const result = await pool.query<WorkRecordExportRow>(
    `SELECT * FROM public.work_record_exports
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 100`,
    [userId],
  );
  return result.rows;
}

/** Own-rows-only fetch: another worker's export id is a NOT_FOUND. */
export async function getExport(
  userId: number,
  input: { id: string },
): Promise<WorkRecordExportRow> {
  const pool = await getPool();
  const result = await pool.query<WorkRecordExportRow>(
    `SELECT * FROM public.work_record_exports
     WHERE id = $1 AND user_id = $2`,
    [input.id, userId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "work_record_export_not_found",
    });
  }
  return row;
}

/**
 * Public verification of an export against the signer. Fail-open: when the
 * verifier is unreachable the caller gets valid: null plus everything needed
 * to verify offline (sha256 of the canonical payload).
 */
export async function verifyExport(input: {
  payload: string;
  signature: string;
  publicKey: string;
}): Promise<{
  valid: boolean | null;
  reason: string | null;
  payloadHash: string;
  offlineVerify: { algorithm: string; instructions: string };
}> {
  const payloadHash = sha256Hex(input.payload);
  const offlineVerify = {
    algorithm: "ed25519 over sha256(canonical payload)",
    instructions:
      "Hash the exact payload string with sha256 (hex must equal payloadHash), " +
      "then verify `signature` (base64 ed25519) over the exact payload bytes " +
      "with `publicKey` (base64 ed25519 verifying key).",
  };
  const base = ENV.workRecordSignerUrl.replace(/\/$/, "");
  try {
    const response = await resilientFetch(`${base}/verify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-service-token": ENV.internalServiceToken,
      },
      body: JSON.stringify({
        payload: input.payload,
        signature_b64: input.signature,
        public_key_b64: input.publicKey,
      }),
      timeoutMs: 5_000,
      maxAttempts: 1,
    });
    if (!response.ok) {
      throw new Error(`signer /verify returned status ${response.status}`);
    }
    const body = (await response.json()) as { valid: boolean };
    return {
      valid: body.valid === true,
      reason: null,
      payloadHash,
      offlineVerify,
    };
  } catch (error) {
    console.warn(
      "[dataPortability] work-record verifier unavailable; returning null verdict",
      error,
    );
    return {
      valid: null,
      reason: "verifier_unavailable",
      payloadHash,
      offlineVerify,
    };
  }
}

/**
 * Per-category summary of the data the platform holds about the caller:
 * recorded disclosures plus live counts for the exportable categories.
 */
export async function getMyDataDisclosure(userId: number): Promise<{
  categories: Array<{
    category: DisclosureCategory;
    disclosures: number;
    lastDisclosedAt: string | Date | null;
  }>;
  heldData: {
    profile: boolean;
    trips: number;
    exports: number;
  };
  disclosures: DataTransparencyDisclosureRow[];
}> {
  const pool = await getPool();
  const grouped = await pool.query<{
    category: DisclosureCategory;
    disclosures: number;
    last_disclosed_at: string | Date | null;
  }>(
    `SELECT category, count(*)::int AS disclosures, max(disclosed_at) AS last_disclosed_at
     FROM public.data_transparency_disclosures
     WHERE user_id = $1
     GROUP BY category`,
    [userId],
  );
  const byCategory = new Map(grouped.rows.map((row) => [row.category, row]));
  const categories = DISCLOSURE_CATEGORIES.map((category) => ({
    category,
    disclosures: byCategory.get(category)?.disclosures ?? 0,
    lastDisclosedAt: byCategory.get(category)?.last_disclosed_at ?? null,
  }));

  let profile = false;
  let trips = 0;
  let exports = 0;
  try {
    const result = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM public.users WHERE id = $1) AS exists`,
      [userId],
    );
    profile = result.rows[0]?.exists === true;
  } catch {
    // fail-open: disclosure summary still returns
  }
  try {
    const result = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM public.rider_trips WHERE rider_user_id = $1`,
      [userId],
    );
    trips = result.rows[0]?.c ?? 0;
  } catch {
    // fail-open
  }
  try {
    const result = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM public.work_record_exports WHERE user_id = $1`,
      [userId],
    );
    exports = result.rows[0]?.c ?? 0;
  } catch {
    // fail-open
  }

  const disclosures = await pool.query<DataTransparencyDisclosureRow>(
    `SELECT * FROM public.data_transparency_disclosures
     WHERE user_id = $1
     ORDER BY disclosed_at DESC
     LIMIT 100`,
    [userId],
  );

  return {
    categories,
    heldData: { profile, trips, exports },
    disclosures: disclosures.rows,
  };
}

/** Operator-recorded transparency disclosure for a worker. */
export async function recordDisclosure(
  actorUserId: number,
  input: {
    userId: number;
    category: DisclosureCategory;
    detail?: Record<string, unknown>;
  },
): Promise<DataTransparencyDisclosureRow> {
  const pool = await getPool();
  const detail = { ...(input.detail ?? {}), recorded_by: actorUserId };
  const inserted = await pool.query<DataTransparencyDisclosureRow>(
    `INSERT INTO public.data_transparency_disclosures (user_id, category, detail)
     VALUES ($1, $2, $3::jsonb)
     RETURNING *`,
    [input.userId, input.category, JSON.stringify(detail)],
  );
  const row = inserted.rows[0];
  if (!row) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "disclosure_record_failed",
    });
  }
  return row;
}
