import { ENV } from "./env";

/**
 * P3-R ride-hailing matching dispatch (fire-and-forget).
 *
 * After a rider request lands in mobility.ride_trip (state 'requested'),
 * requestRide notifies the internal Go matching worker
 * (services/matching/cmd/server/main.go: POST /matches/attempts, gated by
 * INTERNAL_SERVICE_TOKEN — the same token constant-time-compared by the
 * worker). The worker owns offer fan-out; this client never blocks the
 * request path:
 * - RIDE_MATCHING_WORKER_URL unset  -> fail-closed: warn ONCE per process
 *   and skip (the trip stays 'requested' and is pickable by an operator
 *   replay of the matching tick).
 * - call fails / non-2xx           -> warn (every failure, not silent) and
 *   resolve null; never throw into the rider mutation.
 */

let warnedUnavailable = false;

export type RideMatchAttemptRequest = {
  tripId: string;
  idempotencyKey: string;
};

export function isRideMatchingConfigured(): boolean {
  return ENV.rideMatchingWorkerUrl.trim().length > 0;
}

/**
 * Fire-and-forget match kick. Resolves true on a 2xx, false otherwise.
 * Never throws.
 */
export async function requestRideMatchAttempt(
  input: RideMatchAttemptRequest,
): Promise<boolean> {
  const baseUrl = ENV.rideMatchingWorkerUrl.trim();
  if (!baseUrl) {
    if (!warnedUnavailable) {
      warnedUnavailable = true;
      console.warn(
        "[consumer-ride] RIDE_MATCHING_WORKER_URL is not set — ride matching dispatch is disabled (fail-closed). Trips remain in 'requested' until the worker is configured.",
      );
    }
    return false;
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(250, ENV.rideMatchingTimeoutMs),
  );
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/matches/attempts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ENV.internalServiceToken}`,
      },
      body: JSON.stringify({
        trip_id: input.tripId,
        idempotency_key: input.idempotencyKey,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn(
        `[consumer-ride] matching worker rejected match attempt for trip ${input.tripId}: HTTP ${response.status}`,
      );
      return false;
    }
    return true;
  } catch (error) {
    console.warn(
      `[consumer-ride] matching worker unreachable for trip ${input.tripId}:`,
      error instanceof Error ? error.message : error,
    );
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
