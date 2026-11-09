/**
 * OpenRide Phase 2 (contract C2) — pure fare-verification helpers.
 *
 * No I/O, no database access: everything here is deterministic and unit-tested
 * in tests/openride-fare-verification.test.ts.
 *
 * Contract rules (INTEGRATION_SPEC.md §C2, FROZEN):
 *   variance_pct = (trackDistanceM - quotedDistanceM) / quotedDistanceM * 100
 *   verdict = 'suspect'      when |variance_pct| > 15
 *             'ok'           otherwise (|variance_pct| <= 15, inclusive)
 *             'unverifiable' when the fare quote (quotedDistanceM) is missing
 */

export type LatLon = { lat: number; lon: number };

export type TrackVerdict = "ok" | "suspect" | "unverifiable";

/** |variance_pct| strictly greater than this threshold is 'suspect'. */
export const SUSPECT_THRESHOLD_PCT = 15;

/** Mean Earth radius (m) used for haversine distances. */
const EARTH_RADIUS_M = 6_371_000;

/**
 * Decode a Google-encoded polyline at the given precision (decimal places).
 * Precision 6 matches OpenRide's shared encodePolyline6 (coordinates are
 * scaled by 1e6 before delta encoding).
 */
export function decodePolyline(encoded: string, precision: number): LatLon[] {
  if (!Number.isInteger(precision) || precision < 1 || precision > 12) {
    throw new Error(`Invalid polyline precision: ${precision}`);
  }
  const factor = 10 ** precision;
  const points: LatLon[] = [];
  let index = 0;
  let latE6 = 0;
  let lonE6 = 0;

  const readDelta = (): number => {
    let shift = 0;
    let result = 0;
    let byte: number;
    do {
      if (index >= encoded.length) {
        throw new Error("Invalid polyline: truncated variable-length integer");
      }
      byte = encoded.charCodeAt(index++) - 63;
      if (byte < 0) {
        throw new Error("Invalid polyline: character out of range");
      }
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >>> 1) : result >>> 1;
  };

  while (index < encoded.length) {
    latE6 += readDelta();
    lonE6 += readDelta();
    points.push({ lat: latE6 / factor, lon: lonE6 / factor });
  }
  return points;
}

/** Decode an OpenRide precision-6 polyline (contract C2 `polyline6` field). */
export function decodePolyline6(encoded: string): LatLon[] {
  return decodePolyline(encoded, 6);
}

/** Great-circle distance between two WGS84 points, in metres. */
export function haversineM(a: LatLon, b: LatLon): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h =
    sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Percentage variance of the tracked distance vs the quoted distance.
 * Returns null when the quote is missing or non-positive (unverifiable).
 */
export function computeVariancePct(
  trackDistanceM: number,
  quotedDistanceM: number | null | undefined,
): number | null {
  if (
    quotedDistanceM === null ||
    quotedDistanceM === undefined ||
    !Number.isFinite(quotedDistanceM) ||
    quotedDistanceM <= 0
  ) {
    return null;
  }
  if (!Number.isFinite(trackDistanceM)) {
    return null;
  }
  return ((trackDistanceM - quotedDistanceM) / quotedDistanceM) * 100;
}

/**
 * Contract verdict: 'unverifiable' when variance is unknown (no quote),
 * 'suspect' when |variance_pct| > 15, else 'ok'.
 */
export function verdictFor(variancePct: number | null): TrackVerdict {
  if (variancePct === null || !Number.isFinite(variancePct)) {
    return "unverifiable";
  }
  return Math.abs(variancePct) > SUSPECT_THRESHOLD_PCT ? "suspect" : "ok";
}

/**
 * Verify a C2 track summary's distance against the trip's quoted distance.
 */
export function verifyTrackDistance(
  track: { distanceM: number },
  quotedDistanceM: number | null | undefined,
): { variancePct: number | null; verdict: TrackVerdict } {
  const variancePct = computeVariancePct(track.distanceM, quotedDistanceM);
  return { variancePct, verdict: verdictFor(variancePct) };
}
