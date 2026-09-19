import { TRPCError } from "@trpc/server";

import { getPool } from "../db";
import { ENV } from "./env";
import { resilientFetch } from "./resilientFetch";
import { hashIdReference } from "./riderVerification";

/**
 * Trip safety (R2 passenger manifest, R8 SOS).
 *
 * Privacy: raw national IDs (NIN) never touch the database and never leave
 * the platform — only their sha256 digest is stored on the manifest, exactly
 * like rider_verifications. The verification-intelligence service receives
 * names only; per-passenger `verified` therefore reflects name plausibility
 * (plus local NIN presence), and `nin_hash` proves an ID was supplied.
 *
 * Fail-open: when verification-intelligence is unreachable the manifest is
 * still stored with manifest_verified=false and a 'service_unavailable'
 * flag — safety intake must never be blocked by a screening outage.
 *
 * SOS: no h3 library is available server-side, so events store raw lat/lng
 * (h3_index left null). The notification hook is a trip_safety_signals row
 * of type 'sos_triggered' (the notification gateway requires per-device push
 * tokens, which trips do not model — no fabricated integration).
 */

export type ManifestPassenger = {
  name: string;
  ninHash: string | null;
  verified: boolean;
  flags: string[];
};

export type PassengerManifestRow = {
  id: string;
  trip_id: string;
  booked_by: number | string | null;
  passengers: unknown;
  manifest_verified: boolean;
  verified_via: string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

export type SosEventRow = {
  id: string;
  trip_id: string | null;
  user_id: number | string;
  role: "driver" | "rider";
  h3_index: string | null;
  lat: string | number | null;
  lng: string | number | null;
  status: "active" | "resolved" | "cancelled";
  resolved_by: number | string | null;
  resolved_at: string | Date | null;
  created_at: string | Date;
};

function parseFlags(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.map((flag) => `${flag}`) : [];
}

function parseStoredPassengers(raw: unknown): ManifestPassenger[] {
  const list = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!Array.isArray(list)) return [];
  return list.map((entry) => {
    const value = (entry ?? {}) as Record<string, unknown>;
    return {
      name: `${value.name ?? ""}`,
      ninHash: typeof value.ninHash === "string" ? value.ninHash : null,
      verified: value.verified === true,
      flags: parseFlags(value.flags),
    };
  });
}

type ManifestVerifyPassengerResult = {
  name?: string;
  name_ok?: boolean;
  nin_format_ok?: boolean | null;
  flags?: unknown;
};

export type TripRiskScore = {
  score: number;
  factors: Array<{ factor: string; weight: number }>;
};

/**
 * Score a trip's risk via the safety-engine service
 * (GET /trip/{trip_id}/risk, 0-100 + factors). Fail-open per module doc:
 * returns null on any outage — risk scoring is advisory and must never
 * block manifest intake or SOS handling.
 */
export async function scoreTripRisk(tripId: string): Promise<TripRiskScore | null> {
  const base = ENV.safetyEngineUrl.replace(/\/$/, "");
  try {
    const response = await resilientFetch(
      `${base}/trip/${encodeURIComponent(tripId)}/risk`,
      {
        method: "GET",
        headers: { "X-Internal-Service-Token": ENV.internalServiceToken },
        timeoutMs: 5_000,
        maxAttempts: 1,
      },
    );
    if (!response.ok) {
      throw new Error(`trip risk returned status ${response.status}`);
    }
    const body = (await response.json()) as {
      score?: number;
      factors?: Array<{ factor?: string; weight?: number }>;
    };
    if (typeof body.score !== "number" || !Number.isFinite(body.score)) {
      throw new Error("trip risk response invalid");
    }
    return {
      score: body.score,
      factors: Array.isArray(body.factors)
        ? body.factors.map((f) => ({
            factor: `${f?.factor ?? ""}`,
            weight: Number(f?.weight ?? 0),
          }))
        : [],
    };
  } catch (error) {
    console.warn(
      "[tripSafety] safety-engine trip risk unavailable; failing open",
      error,
    );
    return null;
  }
}

/**
 * Persist an advisory risk score as a trip_safety_signals row. Fail-open:
 * a missing score (service outage) records an 'unavailable' signal so the
 * gap is observable instead of silently absent. Never throws.
 */
async function recordTripRiskSignal(
  tripId: string,
  trigger: "manifest_attached" | "sos_triggered",
): Promise<void> {
  try {
    const risk = await scoreTripRisk(tripId);
    const pool = await getPool();
    await pool.query(
      `INSERT INTO public.trip_safety_signals (trip_id, signal_type, payload)
       VALUES ($1, 'trip_risk_scored', $2::jsonb)`,
      [
        tripId,
        JSON.stringify({
          trip_id: tripId,
          trigger,
          risk_score: risk?.score ?? null,
          risk_factors: risk?.factors ?? [],
          scored_via: risk ? "safety-engine" : "service_unavailable",
        }),
      ],
    );
  } catch (error) {
    console.warn(
      "[tripSafety] recording trip risk signal failed; continuing",
      error,
    );
  }
}

/**
 * Screen manifest passenger names via verification-intelligence
 * POST /manifest/verify. Raw NINs are never sent. Fail-open per module doc.
 */
export async function verifyManifestPassengers(
  passengers: Array<{ name: string; ninHash: string | null }>,
): Promise<{ passengers: ManifestPassenger[]; verifiedVia: string }> {
  const base = ENV.verificationIntelligenceUrl.replace(/\/$/, "");
  try {
    const response = await resilientFetch(`${base}/manifest/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        passengers: passengers.map((p) => ({ name: p.name })),
      }),
      timeoutMs: 5_000,
      maxAttempts: 1,
    });
    if (!response.ok) {
      throw new Error(`manifest/verify returned status ${response.status}`);
    }
    const body = (await response.json()) as {
      results?: ManifestVerifyPassengerResult[];
    };
    const results = Array.isArray(body.results) ? body.results : [];
    return {
      verifiedVia: "verification-intelligence",
      passengers: passengers.map((p, index) => {
        const result = results[index];
        const nameOk = result?.name_ok === true;
        // nin_format_ok is null when no NIN was supplied; a supplied NIN was
        // already format-screened locally (presence only — hash stored).
        const ninOk = result?.nin_format_ok !== false;
        return {
          name: p.name,
          ninHash: p.ninHash,
          verified: nameOk && ninOk,
          flags: parseFlags(result?.flags),
        };
      }),
    };
  } catch (error) {
    console.warn(
      "[tripSafety] verification-intelligence manifest/verify unavailable; failing open",
      error,
    );
    return {
      verifiedVia: "service_unavailable",
      passengers: passengers.map((p) => ({
        name: p.name,
        ninHash: p.ninHash,
        verified: false,
        flags: ["service_unavailable"],
      })),
    };
  }
}

/**
 * Attach (or replace) the passenger manifest for a trip. NINs are hashed
 * before anything else happens; the raw values never persist.
 */
export async function attachManifest(
  userId: number,
  input: { tripId: string; passengers: Array<{ name: string; nin?: string }> },
): Promise<PassengerManifestRow & { passengers: ManifestPassenger[] }> {
  const hashed = input.passengers.map((p) => ({
    name: p.name,
    ninHash:
      p.nin && p.nin.trim().length > 0 ? hashIdReference(p.nin) : null,
  }));
  const { passengers, verifiedVia } = await verifyManifestPassengers(hashed);
  const manifestVerified =
    verifiedVia !== "service_unavailable" &&
    passengers.length > 0 &&
    passengers.every((p) => p.verified);

  const pool = await getPool();
  const upserted = await pool.query<PassengerManifestRow>(
    `INSERT INTO public.passenger_manifests
       (trip_id, booked_by, passengers, manifest_verified, verified_via)
     VALUES ($1, $2, $3::jsonb, $4, $5)
     ON CONFLICT (trip_id)
     DO UPDATE SET
       booked_by = EXCLUDED.booked_by,
       passengers = EXCLUDED.passengers,
       manifest_verified = EXCLUDED.manifest_verified,
       verified_via = EXCLUDED.verified_via,
       updated_at = now()
     RETURNING *`,
    [
      input.tripId,
      userId,
      JSON.stringify(passengers),
      manifestVerified,
      verifiedVia,
    ],
  );
  const row = upserted.rows[0];
  if (!row) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "manifest_store_failed",
    });
  }
  // Advisory risk scoring via safety-engine (fail-open, never blocks intake).
  await recordTripRiskSignal(input.tripId, "manifest_attached");
  return { ...row, passengers };
}

/**
 * Read a manifest with NIN digests redacted. Callers must be the booker or
 * the driver assigned to the trip (mobility.ride_trip.assigned_driver_user_id).
 */
export async function getManifest(
  tripId: string,
  viewerUserId: number,
): Promise<{
  tripId: string;
  manifestVerified: boolean;
  verifiedVia: string | null;
  passengers: Array<{ name: string; verified: boolean; flags: string[] }>;
}> {
  const pool = await getPool();
  const result = await pool.query<PassengerManifestRow>(
    `SELECT * FROM public.passenger_manifests WHERE trip_id = $1`,
    [tripId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "manifest_not_found" });
  }
  const isBooker = Number(row.booked_by) === viewerUserId;
  let isAssignedDriver = false;
  if (!isBooker) {
    const trip = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM mobility.ride_trip t
         WHERE t.id::text = $1 AND t.assigned_driver_user_id = $2
       ) AS exists`,
      [tripId, viewerUserId],
    );
    isAssignedDriver = trip.rows[0]?.exists === true;
  }
  if (!isBooker && !isAssignedDriver) {
    throw new TRPCError({ code: "FORBIDDEN", message: "manifest_forbidden" });
  }
  return {
    tripId: row.trip_id,
    manifestVerified: row.manifest_verified,
    verifiedVia: row.verified_via,
    passengers: parseStoredPassengers(row.passengers).map((p) => ({
      name: p.name,
      verified: p.verified,
      flags: p.flags,
    })),
  };
}

/**
 * Trigger an SOS. Stores the event plus a 'sos_triggered' trip_safety_signals
 * row as the operator-facing notification hook (see module doc).
 */
export async function triggerSOS(
  userId: number,
  input: { tripId?: string; role: "driver" | "rider"; lat?: number; lng?: number },
): Promise<SosEventRow> {
  const pool = await getPool();
  const inserted = await pool.query<SosEventRow>(
    `INSERT INTO public.sos_events (trip_id, user_id, role, lat, lng)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [
      input.tripId ?? null,
      userId,
      input.role,
      input.lat ?? null,
      input.lng ?? null,
    ],
  );
  const row = inserted.rows[0];
  if (!row) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "sos_trigger_failed",
    });
  }
  if (row.trip_id) {
    await pool.query(
      `INSERT INTO public.trip_safety_signals (trip_id, signal_type, payload)
       VALUES ($1, 'sos_triggered', $2::jsonb)`,
      [
        row.trip_id,
        JSON.stringify({
          sos_id: row.id,
          user_id: Number(row.user_id),
          role: row.role,
          lat: row.lat === null ? null : Number(row.lat),
          lng: row.lng === null ? null : Number(row.lng),
        }),
      ],
    );
    // Advisory risk scoring via safety-engine (fail-open, never blocks SOS).
    await recordTripRiskSignal(row.trip_id, "sos_triggered");
  }
  return row;
}

export async function resolveSOS(
  operatorUserId: number,
  input: { sosId: string },
): Promise<SosEventRow> {
  const pool = await getPool();
  const updated = await pool.query<SosEventRow>(
    `UPDATE public.sos_events
     SET status = 'resolved', resolved_by = $2, resolved_at = now()
     WHERE id = $1 AND status = 'active'
     RETURNING *`,
    [input.sosId, operatorUserId],
  );
  const row = updated.rows[0];
  if (!row) {
    throw new TRPCError({ code: "CONFLICT", message: "sos_not_active" });
  }
  return row;
}

/** Riders/drivers cancel only their own active SOS events. */
export async function cancelSOS(
  userId: number,
  input: { sosId: string },
): Promise<SosEventRow> {
  const pool = await getPool();
  const updated = await pool.query<SosEventRow>(
    `UPDATE public.sos_events
     SET status = 'cancelled', resolved_at = now()
     WHERE id = $1 AND user_id = $2 AND status = 'active'
     RETURNING *`,
    [input.sosId, userId],
  );
  const row = updated.rows[0];
  if (!row) {
    throw new TRPCError({ code: "CONFLICT", message: "sos_not_active" });
  }
  return row;
}

export async function listActiveSOS(): Promise<SosEventRow[]> {
  const pool = await getPool();
  const result = await pool.query<SosEventRow>(
    `SELECT * FROM public.sos_events
     WHERE status = 'active'
     ORDER BY created_at DESC
     LIMIT 200`,
  );
  return result.rows;
}
