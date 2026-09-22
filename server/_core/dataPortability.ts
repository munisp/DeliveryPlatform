import { createHash } from "crypto";

import { TRPCError } from "@trpc/server";

import { getPool } from "../db";
import { ENV } from "./env";
import { FAIL_OPEN_FAST, resilientFetch } from "./resilientFetch";

/** R9/R10 data portability: worker work-record assembly, Rust-signed export,
 * verification, and the R10 data-transparency disclosure surface. */

const EXPORT_SCHEMA = "work-record/v1";
const DISCLOSURE_CATEGORIES = [
  "profile",
  "trips",
  "ratings",
  "safety",
  "earnings",
  "exports",
  "appeals",
] as const;
type DisclosureCategory = (typeof DISCLOSURE_CATEGORIES)[number];

/** Key-sorted deterministic JSON: identical payload -> identical hash. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

type Period = { periodStart: Date; periodEnd: Date };

type ProfileRow = {
  id: number;
  name: string | null;
  email: string | null;
  phone: string | null;
  created_at: string;
};

type TripRow = {
  id: string;
  status: string;
  trip_type: string | null;
  vehicle_class: string | null;
  modality: string | null;
  requested_at: string | null;
  assigned_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  fare_minor: string | number | null;
  currency: string | null;
};

type EarningsRow = {
  offers: string | number | null;
  gross_minor: string | number | null;
  deadhead_minor: string | number | null;
  platform_fee_minor: string | number | null;
  net_to_driver_minor: string | number | null;
};

type ExportRow = {
  id: string;
  user_id: number;
  period_start: string;
  period_end: string;
  payload: Record<string, unknown>;
  payload_hash: string;
  signature: string | null;
  signer_key_id: string | null;
  signer_public_key: string | null;
  status: string;
  created_at: string;
  signed_at: string | null;
};

function num(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toIso(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function safeQuery<T>(
  label: string,
  gaps: string[],
  sources: string[],
  query: () => Promise<T>,
): Promise<T | null> {
  try {
    const result = await query();
    sources.push(label);
    return result;
  } catch (error) {
    console.warn(`[dataPortability] ${label} assembly unavailable`, error);
    gaps.push(`${label}_unavailable`);
    return null;
  }
}

export async function assembleWorkRecordPayload(
  userId: number,
  periodStart: Date,
  periodEnd: Date,
): Promise<Record<string, unknown>> {
  const pool = await getPool();
  const gaps: string[] = [];
  const sources: string[] = [];

  const profile = await safeQuery("profile", gaps, sources, async () => {
    const result = await pool.query<ProfileRow>(
      `SELECT id, name, email, phone, created_at FROM public.users WHERE id = $1`,
      [userId],
    );
    const row = result.rows[0];
    return row
      ? {
          name: row.name,
          email: row.email,
          phone: row.phone,
          member_since: toIso(row.created_at),
        }
      : null;
  });

  const trips = await safeQuery("trips", gaps, sources, async () => {
    const result = await pool.query<TripRow>(
      `SELECT id::text, status, trip_type, vehicle_class, modality,
              requested_at, assigned_at, completed_at, cancelled_at,
              fare_minor, currency
         FROM public.rider_trips
        WHERE rider_user_id = $1
          AND created_at >= $2 AND created_at < $3
        ORDER BY created_at ASC`,
      [userId, periodStart, periodEnd],
    );
    return result.rows.map((row) => ({
      id: row.id,
      status: row.status,
      trip_type: row.trip_type,
      vehicle_class: row.vehicle_class,
      modality: row.modality,
      requested_at: toIso(row.requested_at),
      assigned_at: toIso(row.assigned_at),
      completed_at: toIso(row.completed_at),
      cancelled_at: toIso(row.cancelled_at),
      fare_minor: num(row.fare_minor),
      currency: row.currency ?? "NGN",
    }));
  });

  const earnings = await safeQuery("earnings", gaps, sources, async () => {
    const result = await pool.query<EarningsRow>(
      `SELECT count(*) AS offers,
              COALESCE(sum(base_minor + distance_minor + time_minor), 0) AS gross_minor,
              COALESCE(sum(deadhead_minor), 0) AS deadhead_minor,
              COALESCE(sum(platform_fee_minor), 0) AS platform_fee_minor,
              COALESCE(sum(net_to_driver_minor), 0) AS net_to_driver_minor
         FROM public.offer_economics_breakdowns
        WHERE created_at >= $1 AND created_at < $2`,
      [periodStart, periodEnd],
    );
    const row = result.rows[0];
    return {
      offers: num(row?.offers),
      gross_minor: num(row?.gross_minor),
      deadhead_minor: num(row?.deadhead_minor),
      platform_fee_minor: num(row?.platform_fee_minor),
      net_to_driver_minor: num(row?.net_to_driver_minor),
      currency: "NGN",
    };
  });

  gaps.push("ratings_not_exportable_yet", "safety_device_not_exportable_yet");

  return {
    schema: EXPORT_SCHEMA,
    user_id: userId,
    period: {
      start: periodStart.toISOString(),
      end: periodEnd.toISOString(),
    },
    generated_at: new Date().toISOString(),
    profile,
    trips: trips ?? [],
    earnings,
    meta: { sources, gaps },
  };
}

type SignerResponse = {
  payload_hash?: string;
  signature_b64?: string;
  key_id?: string;
  public_key_b64?: string;
};

export async function requestExport(
  userId: number,
  input: Period,
): Promise<{ export: ExportRow; signed: boolean; retryHint: string | null }> {
  if (input.periodEnd <= input.periodStart) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "period_inverted" });
  }
  const pool = await getPool();
  const payload = await assembleWorkRecordPayload(
    userId,
    input.periodStart,
    input.periodEnd,
  );
  const canonical = canonicalJson(payload);
  const hash = sha256Hex(canonical);

  const inserted = await pool.query<ExportRow>(
    `INSERT INTO public.work_record_exports
       (user_id, period_start, period_end, payload, payload_hash, status)
     VALUES ($1, $2, $3, $4::jsonb, $5, 'pending')
     RETURNING *`,
    [userId, input.periodStart, input.periodEnd, canonical, hash],
  );
  const row = inserted.rows[0];
  if (!row) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "export_create_failed",
    });
  }

  try {
    const base = ENV.workRecordSignerUrl.replace(/\/$/, "");
    const response = await resilientFetch(`${base}/sign`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-service-token": ENV.internalServiceToken,
      },
      body: JSON.stringify({ payload: canonical }),
      ...FAIL_OPEN_FAST,
    });
    if (!response.ok) {
      throw new Error(`signer returned status ${response.status}`);
    }
    const signed = (await response.json()) as SignerResponse;
    if (!signed.signature_b64 || !signed.public_key_b64) {
      throw new Error("signer response invalid");
    }
    const updated = await pool.query<ExportRow>(
      `UPDATE public.work_record_exports
          SET payload_hash = $2,
              signature = $3,
              signer_key_id = $4,
              signer_public_key = $5,
              status = 'signed',
              signed_at = now()
        WHERE id = $1
        RETURNING *`,
      [
        row.id,
        signed.payload_hash ?? hash,
        signed.signature_b64,
        signed.key_id ?? null,
        signed.public_key_b64,
      ],
    );
    return {
      export: updated.rows[0] ?? row,
      signed: true,
      retryHint: null,
    };
  } catch (error) {
    console.warn(
      "[dataPortability] signer unavailable; export left pending",
      error,
    );
    return {
      export: row,
      signed: false,
      retryHint: "signer_unavailable: retry signing later",
    };
  }
}

export async function listMyExports(userId: number): Promise<ExportRow[]> {
  const pool = await getPool();
  const result = await pool.query<ExportRow>(
    `SELECT * FROM public.work_record_exports
      WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [userId],
  );
  return result.rows;
}

export async function getExport(
  userId: number,
  input: { id: string },
): Promise<ExportRow> {
  const pool = await getPool();
  const result = await pool.query<ExportRow>(
    `SELECT * FROM public.work_record_exports
      WHERE id = $1 AND user_id = $2`,
    [input.id, userId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "export_not_found" });
  }
  return row;
}

export async function verifyExport(input: {
  payload: string;
  signature: string;
  publicKey: string;
}): Promise<{
  valid: boolean | null;
  reason: string | null;
  payloadHash: string;
  offlineVerify: { algorithm: string; payloadHash: string; instructions: string };
}> {
  const payloadHash = sha256Hex(input.payload);
  const offlineVerify = {
    algorithm: "ed25519 over sha256(canonical payload)",
    payloadHash,
    instructions:
      "Compute sha256 over the payload bytes, then verify the base64 signature against the base64 ed25519 public key.",
  };
  try {
    const base = ENV.workRecordSignerUrl.replace(/\/$/, "");
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
      ...FAIL_OPEN_FAST,
    });
    if (!response.ok) {
      throw new Error(`verifier returned status ${response.status}`);
    }
    const body = (await response.json()) as { valid?: boolean };
    return {
      valid: body.valid === true,
      reason: null,
      payloadHash,
      offlineVerify,
    };
  } catch (error) {
    console.warn("[dataPortability] verifier unavailable; failing open", error);
    return {
      valid: null,
      reason: "verifier_unavailable",
      payloadHash,
      offlineVerify,
    };
  }
}

export async function getMyDataDisclosure(userId: number): Promise<{
  categories: Array<{
    category: DisclosureCategory;
    disclosures: number;
    lastDisclosedAt: string | null;
  }>;
  heldData: { profile: boolean; trips: number; exports: number };
}> {
  const pool = await getPool();
  const grouped = await pool.query<{
    category: DisclosureCategory;
    disclosures: string | number;
    last_disclosed_at: string | null;
  }>(
    `SELECT category, count(*) AS disclosures, max(disclosed_at) AS last_disclosed_at
       FROM public.data_transparency_disclosures
      WHERE user_id = $1
      GROUP BY category`,
    [userId],
  );
  const byCategory = new Map(grouped.rows.map((row) => [row.category, row]));

  const heldProfile = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM public.users WHERE id = $1) AS exists`,
    [userId],
  );
  const heldTrips = await pool.query<{ c: string | number }>(
    `SELECT count(*) AS c FROM public.rider_trips WHERE rider_user_id = $1`,
    [userId],
  );
  const heldExports = await pool.query<{ c: string | number }>(
    `SELECT count(*) AS c FROM public.work_record_exports WHERE user_id = $1`,
    [userId],
  );

  return {
    categories: DISCLOSURE_CATEGORIES.map((category) => ({
      category,
      disclosures: num(byCategory.get(category)?.disclosures),
      lastDisclosedAt:
        byCategory.get(category)?.last_disclosed_at ?? null,
    })),
    heldData: {
      profile: heldProfile.rows[0]?.exists === true,
      trips: num(heldTrips.rows[0]?.c),
      exports: num(heldExports.rows[0]?.c),
    },
  };
}

export async function recordDisclosure(
  operatorUserId: number,
  input: {
    userId: number;
    category: DisclosureCategory;
    detail: Record<string, unknown>;
  },
) {
  if (!DISCLOSURE_CATEGORIES.includes(input.category)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "category_invalid" });
  }
  const pool = await getPool();
  const detail = {
    ...input.detail,
    recorded_by: operatorUserId,
  };
  const result = await pool.query<{
    id: string;
    user_id: number;
    category: DisclosureCategory;
    detail: Record<string, unknown>;
    disclosed_at: string;
  }>(
    `INSERT INTO public.data_transparency_disclosures
       (user_id, category, detail)
     VALUES ($1, $2, $3::jsonb)
     RETURNING *`,
    [input.userId, input.category, JSON.stringify(detail)],
  );
  const row = result.rows[0];
  if (!row) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "disclosure_record_failed",
    });
  }
  return row;
}
