import { createHash } from "node:crypto";

import { TRPCError } from "@trpc/server";

import { getPool } from "../db";
import { ENV } from "./env";
import { resilientFetch } from "./resilientFetch";

/**
 * Verified rider identity (R1).
 *
 * Privacy: raw national ID references (NIN, BVN, ...) never touch the
 * database — only their sha256 hex digest is stored (`id_ref_hash`).
 *
 * Name plausibility is screened by the Python verification-intelligence
 * service (`POST /screen-name`). The service is fail-open for v1: on
 * outage/timeout the name is treated as plausible with a
 * `service_unavailable` flag, and the failure is logged. The screening
 * service never throws into the request path.
 */

export type RiderVerificationStatus =
  | "unverified"
  | "pending"
  | "verified"
  | "rejected"
  | "suspended";

export type NameScreeningResult = {
  score: number | null;
  flags: string[];
  plausible: boolean;
};

const NAME_PLAUSIBILITY_THRESHOLD = 0.6;

export function hashIdReference(idRef: string): string {
  return createHash("sha256").update(idRef.trim(), "utf8").digest("hex");
}

type VerificationRow = {
  id: string;
  user_id: number | string;
  status: RiderVerificationStatus;
  id_type: string | null;
  id_ref_hash: string | null;
  name_plausibility_score: string | number | null;
  name_screening_flags: unknown;
  verified_at: string | Date | null;
};

function parseFlags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((flag) => `${flag}`);
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map((flag) => `${flag}`) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Screen a rider-supplied name for plausibility ("Snake", "Mr. Dot" style
 * pseudonyms score low). Fail-open: on any service failure returns
 * {score: null, flags: ['service_unavailable'], plausible: true} and logs.
 */
export async function screenName(name: string): Promise<NameScreeningResult> {
  const base = ENV.verificationIntelligenceUrl.replace(/\/$/, "");
  try {
    const response = await resilientFetch(`${base}/screen-name`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
      timeoutMs: 5_000,
      maxAttempts: 1,
    });
    if (!response.ok) {
      throw new Error(`screen-name returned status ${response.status}`);
    }
    const body = (await response.json()) as {
      score?: number | null;
      flags?: unknown;
      plausible?: boolean;
    };
    const score =
      typeof body.score === "number" && Number.isFinite(body.score)
        ? body.score
        : null;
    const flags = parseFlags(body.flags);
    const plausible =
      typeof body.plausible === "boolean"
        ? body.plausible
        : score !== null
          ? score >= NAME_PLAUSIBILITY_THRESHOLD
          : true;
    return { score, flags, plausible };
  } catch (error) {
    console.warn(
      "[riderVerification] verification-intelligence screen-name unavailable; failing open",
      error,
    );
    return { score: null, flags: ["service_unavailable"], plausible: true };
  }
}

async function ensureVerificationRow(userId: number): Promise<VerificationRow> {
  const pool = await getPool();
  const existing = await pool.query<VerificationRow>(
    `SELECT * FROM public.rider_verifications WHERE user_id = $1`,
    [userId],
  );
  const row = existing.rows[0];
  if (row) return row;
  const inserted = await pool.query<VerificationRow>(
    `INSERT INTO public.rider_verifications (user_id)
     VALUES ($1)
     ON CONFLICT (user_id) DO NOTHING
     RETURNING *`,
    [userId],
  );
  const created = inserted.rows[0];
  if (created) return created;
  const raced = await pool.query<VerificationRow>(
    `SELECT * FROM public.rider_verifications WHERE user_id = $1`,
    [userId],
  );
  const racedRow = raced.rows[0];
  if (!racedRow) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "rider_verification_provisioning_failed",
    });
  }
  return racedRow;
}

export async function getMyVerificationStatus(userId: number): Promise<{
  status: RiderVerificationStatus;
  badgeLevel: "none" | "verified";
  flags: string[];
}> {
  const row = await ensureVerificationRow(userId);
  return {
    status: row.status,
    badgeLevel: row.status === "verified" ? "verified" : "none",
    flags: parseFlags(row.name_screening_flags),
  };
}

/**
 * Submit an ID reference for verification. Only the sha256 digest is stored.
 * v1 auto-transition: idRef format valid (>= 5 chars) AND screenName
 * plausible => 'verified'; otherwise 'rejected' with flags recorded.
 */
export async function submitVerification(
  userId: number,
  input: { idType: string; idRef: string; name: string },
): Promise<{ status: RiderVerificationStatus }> {
  const pool = await getPool();
  await ensureVerificationRow(userId);

  const idRefHash = hashIdReference(input.idRef);
  // Record the submission as pending before the v1 auto-decision so a crash
  // between submission and decision never loses the intake.
  await pool.query(
    `UPDATE public.rider_verifications
     SET status = 'pending', id_type = $2, id_ref_hash = $3, updated_at = now()
     WHERE user_id = $1`,
    [userId, input.idType, idRefHash],
  );
  const formatValid = input.idRef.trim().length >= 5;
  const screening = await screenName(input.name);

  await pool.query(
    `INSERT INTO public.rider_name_screenings (user_id, input_name, score, flags)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [userId, input.name, screening.score, JSON.stringify(screening.flags)],
  );

  const verified = formatValid && screening.plausible;
  const status: RiderVerificationStatus = verified ? "verified" : "rejected";
  const flags = [...screening.flags];
  if (!formatValid) flags.push("id_ref_format_invalid");
  if (!screening.plausible) flags.push("name_implausible");

  await pool.query(
    `UPDATE public.rider_verifications
     SET status = $2,
         id_type = $3,
         id_ref_hash = $4,
         name_plausibility_score = $5,
         name_screening_flags = $6::jsonb,
         verified_at = CASE WHEN $2 = 'verified' THEN now() ELSE NULL END,
         updated_at = now()
     WHERE user_id = $1`,
    [
      userId,
      status,
      input.idType,
      idRefHash,
      screening.score,
      JSON.stringify(flags),
    ],
  );
  return { status };
}

/**
 * Resolve the rider behind a dispatch offer and return the badge the driver
 * sees before accepting. Linkage choice: mobility.driver_offer has no rider
 * column; it references mobility.ride_trip via trip_id, and ride_trip carries
 * rider_user_id (drizzle/0026). So offer -> trip -> rider_user_id.
 */
export async function getOfferRiderBadge(offerId: string): Promise<{
  verified: boolean;
  firstName: string | null;
  rating: number | null;
}> {
  const pool = await getPool();
  const result = await pool.query<{
    rider_user_id: number | string;
    rider_name: string | null;
    verification_status: RiderVerificationStatus | null;
  }>(
    `SELECT t.rider_user_id,
            u.name AS rider_name,
            rv.status AS verification_status
     FROM mobility.driver_offer o
     JOIN mobility.ride_trip t ON t.id = o.trip_id
     JOIN public.users u ON u.id = t.rider_user_id
     LEFT JOIN public.rider_verifications rv ON rv.user_id = t.rider_user_id
     WHERE o.id = $1`,
    [offerId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "offer_not_found" });
  }
  const name = row.rider_name?.trim() ?? "";
  return {
    verified: row.verification_status === "verified",
    firstName: name.length > 0 ? name.split(/\s+/)[0] : null,
    rating: null, // rider ratings are not modeled yet (Wave A1 scope)
  };
}
