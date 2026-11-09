/**
 * OpenRide Phase 2 (contract C2) — track summary ingestion + fare verification.
 *
 * tRPC router `openrideTelemetry`:
 *   - ingestTrack        driver-authenticated upload of a C2 track summary;
 *                        verifies distanceM vs fare_quote.quoted_distance_m and
 *                        persists to mobility.trip_track (migration 0095).
 *   - getForTrip         rider-or-driver read of stored tracks + verification.
 *   - verificationSummary ops/admin aggregate (repo admin-guard pattern:
 *                        protectedProcedure = operator role).
 *
 * Auth note: in this codebase `protectedProcedure` additionally requires an
 * operator role, so driver/rider-facing endpoints use `authenticatedProcedure`
 * (any signed-in user) plus in-procedure authorization against
 * mobility.ride_trip (caller must be the assigned driver / a participant).
 *
 * Mobility tables (fare_quote, ride_trip, trip_track) exist only as raw SQL
 * migrations, so all access is via raw SQL through getPool() — the same
 * pattern as server/db.ts and server/_core/tripSafety.ts.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  authenticatedProcedure,
  protectedProcedure,
  router,
} from "../_core/trpc";
import { getPool } from "../db";
import {
  verifyTrackDistance,
  type TrackVerdict,
} from "./fareVerification";

/** Contract C2 payload — field names are FROZEN (INTEGRATION_SPEC.md §C2). */
export const trackSummaryInputSchema = z.object({
  schema: z.literal("openride.track.v1"),
  jobId: z.string().uuid(),
  deviceId: z.string().trim().min(1).max(255),
  startedAt: z.string().datetime({ offset: true }),
  endedAt: z.string().datetime({ offset: true }),
  distanceM: z.number().int().nonnegative(),
  movingTimeS: z.number().int().nonnegative(),
  totalTimeS: z.number().int().nonnegative(),
  maxSpeedMps: z.number().nonnegative().optional(),
  ascentM: z.number().optional(),
  descentM: z.number().optional(),
  polyline6: z.string().max(200_000),
  epoch0: z.number().int().nonnegative(),
  dtS: z.array(z.number().int().nonnegative()).max(200_000),
  pointCount: z.number().int().nonnegative(),
});

export type TrackSummaryInput = z.infer<typeof trackSummaryInputSchema>;

/** Row shape read from mobility.ride_trip for authorization + quote lookup. */
export type TripAuthRow = {
  id: string;
  rider_user_id: number;
  assigned_driver_user_id: number | null;
  fare_quote_id: string | null;
  state: string;
};

/**
 * ingestTrack authorization (pure): the caller must be the driver assigned to
 * the trip. Exported for unit tests.
 */
export function assertAssignedDriver(
  trip: Pick<TripAuthRow, "assigned_driver_user_id">,
  callerUserId: number,
): void {
  if (
    trip.assigned_driver_user_id === null ||
    trip.assigned_driver_user_id !== callerUserId
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "NOT_ASSIGNED_DRIVER",
    });
  }
}

/**
 * getForTrip authorization (pure): the caller must be the trip's rider or its
 * assigned driver. Exported for unit tests.
 */
export function assertTripParticipant(
  trip: Pick<TripAuthRow, "rider_user_id" | "assigned_driver_user_id">,
  callerUserId: number,
): void {
  if (
    callerUserId !== trip.rider_user_id &&
    callerUserId !== trip.assigned_driver_user_id
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "NOT_TRIP_PARTICIPANT",
    });
  }
}

/** Stored verification fields echoed back to callers. */
export type StoredTrackVerification = {
  trackId: string;
  verdict: TrackVerdict;
  variancePct: number | null;
};

async function loadTripForAuth(tripId: string): Promise<TripAuthRow> {
  const pool = await getPool();
  const result = await pool.query<TripAuthRow>(
    `SELECT id, rider_user_id, assigned_driver_user_id, fare_quote_id, state
       FROM mobility.ride_trip
      WHERE id = $1`,
    [tripId],
  );
  const trip = result.rows[0];
  if (!trip) {
    throw new TRPCError({ code: "NOT_FOUND", message: "TRIP_NOT_FOUND" });
  }
  return trip;
}

export const openrideTelemetryRouter = router({
  /**
   * C2 upload endpoint. Idempotent-ish: OpenRide's store-and-forward queue can
   * retry the same summary; replays are deduped on (trip_id, deviceId,
   * startedAt) read back out of the stored raw payload and return the
   * originally persisted verification instead of inserting a duplicate.
   */
  ingestTrack: authenticatedProcedure
    .input(trackSummaryInputSchema)
    .mutation(async ({ ctx, input }): Promise<StoredTrackVerification> => {
      const callerUserId = ctx.user!.id;
      const pool = await getPool();

      const trip = await loadTripForAuth(input.jobId);
      assertAssignedDriver(trip, callerUserId);

      // Dedupe store-and-forward retries before doing any verification work.
      const existing = await pool.query<{
        id: string;
        verdict: TrackVerdict;
        variance_pct: number | string | null;
      }>(
        `SELECT id, verdict, variance_pct
           FROM mobility.trip_track
          WHERE trip_id = $1
            AND raw->>'deviceId' = $2
            AND raw->>'startedAt' = $3
          ORDER BY created_at DESC
          LIMIT 1`,
        [input.jobId, input.deviceId, input.startedAt],
      );
      const replay = existing.rows[0];
      if (replay) {
        return {
          trackId: replay.id,
          verdict: replay.verdict,
          variancePct:
            replay.variance_pct === null ? null : Number(replay.variance_pct),
        };
      }

      let quotedDistanceM: number | null = null;
      if (trip.fare_quote_id) {
        const quote = await pool.query<{ quoted_distance_m: number | null }>(
          `SELECT quoted_distance_m
             FROM mobility.fare_quote
            WHERE id = $1`,
          [trip.fare_quote_id],
        );
        quotedDistanceM = quote.rows[0]?.quoted_distance_m ?? null;
      }

      const { variancePct, verdict } = verifyTrackDistance(
        { distanceM: input.distanceM },
        quotedDistanceM,
      );

      const maxSpeedKph =
        input.maxSpeedMps === undefined ? null : input.maxSpeedMps * 3.6;

      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO mobility.trip_track (
           trip_id, driver_user_id, distance_m, moving_time_s, total_time_s,
           max_speed_kph, polyline6, point_count, variance_pct, verdict, raw
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
         RETURNING id`,
        [
          input.jobId,
          callerUserId,
          input.distanceM,
          input.movingTimeS,
          input.totalTimeS,
          maxSpeedKph,
          input.polyline6,
          input.pointCount,
          variancePct,
          verdict,
          JSON.stringify(input),
        ],
      );

      return { trackId: inserted.rows[0].id, verdict, variancePct };
    }),

  /** Read stored track(s) + verification for a trip the caller is part of. */
  getForTrip: authenticatedProcedure
    .input(z.object({ tripId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const callerUserId = ctx.user!.id;
      const pool = await getPool();

      const trip = await loadTripForAuth(input.tripId);
      assertTripParticipant(trip, callerUserId);

      const tracks = await pool.query<{
        id: string;
        trip_id: string;
        driver_user_id: number;
        distance_m: number | null;
        moving_time_s: number | null;
        total_time_s: number | null;
        max_speed_kph: number | string | null;
        polyline6: string | null;
        point_count: number | null;
        variance_pct: number | string | null;
        verdict: TrackVerdict;
        created_at: Date | string;
      }>(
        `SELECT id, trip_id, driver_user_id, distance_m, moving_time_s,
                total_time_s, max_speed_kph, polyline6, point_count,
                variance_pct, verdict, created_at
           FROM mobility.trip_track
          WHERE trip_id = $1
          ORDER BY created_at DESC`,
        [input.tripId],
      );

      return {
        tripId: input.tripId,
        tracks: tracks.rows.map((row) => ({
          trackId: row.id,
          driverUserId: row.driver_user_id,
          distanceM: row.distance_m,
          movingTimeS: row.moving_time_s,
          totalTimeS: row.total_time_s,
          maxSpeedKph:
            row.max_speed_kph === null ? null : Number(row.max_speed_kph),
          polyline6: row.polyline6,
          pointCount: row.point_count,
          variancePct:
            row.variance_pct === null ? null : Number(row.variance_pct),
          verdict: row.verdict,
          createdAt: new Date(row.created_at).toISOString(),
        })),
      };
    }),

  /**
   * Ops/admin aggregate over mobility.trip_track. Uses protectedProcedure —
   * the repo's admin guard (authenticated + operator role).
   */
  verificationSummary: protectedProcedure
    .input(
      z
        .object({
          recentSuspectLimit: z.number().int().min(1).max(100).optional(),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      const pool = await getPool();
      const recentSuspectLimit = input?.recentSuspectLimit ?? 20;

      const totals = await pool.query<{
        verdict: TrackVerdict;
        count: string | number;
        avg_abs_variance_pct: number | string | null;
      }>(
        `SELECT verdict,
                COUNT(*) AS count,
                AVG(ABS(variance_pct)) AS avg_abs_variance_pct
           FROM mobility.trip_track
          GROUP BY verdict`,
      );

      const recentSuspect = await pool.query<{
        id: string;
        trip_id: string;
        driver_user_id: number;
        variance_pct: number | string | null;
        created_at: Date | string;
      }>(
        `SELECT id, trip_id, driver_user_id, variance_pct, created_at
           FROM mobility.trip_track
          WHERE verdict = 'suspect'
          ORDER BY created_at DESC
          LIMIT $1`,
        [recentSuspectLimit],
      );

      return {
        totals: totals.rows.map((row) => ({
          verdict: row.verdict,
          count: Number(row.count),
          avgAbsVariancePct:
            row.avg_abs_variance_pct === null
              ? null
              : Number(row.avg_abs_variance_pct),
        })),
        recentSuspect: recentSuspect.rows.map((row) => ({
          trackId: row.id,
          tripId: row.trip_id,
          driverUserId: row.driver_user_id,
          variancePct:
            row.variance_pct === null ? null : Number(row.variance_pct),
          createdAt: new Date(row.created_at).toISOString(),
        })),
      };
    }),
});
