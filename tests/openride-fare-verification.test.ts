/**
 * OpenRide Phase 2 (contract C2) — fare verification unit tests.
 *
 * The polyline encoder below is an independent test-side implementation of the
 * Google encoded-polyline algorithm; it is validated against the classic
 * known-answer vector at precision 5 before being used to cross-check the
 * precision-6 decoder shipped in server/openride/fareVerification.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getPool: vi.fn(),
}));

vi.mock("../server/db", () => dbMocks);

import {
  computeVariancePct,
  decodePolyline,
  decodePolyline6,
  haversineM,
  SUSPECT_THRESHOLD_PCT,
  verdictFor,
  verifyTrackDistance,
  type LatLon,
} from "../server/openride/fareVerification";
import {
  assertAssignedDriver,
  assertTripParticipant,
  openrideTelemetryRouter,
} from "../server/openride/telemetry";

// ---------------------------------------------------------------------------
// Test-side encoder (algorithm spec implementation, precision-parameterized)
// ---------------------------------------------------------------------------
function encodePolyline(points: LatLon[], precision: number): string {
  const factor = 10 ** precision;
  let output = "";
  let prevLat = 0;
  let prevLon = 0;

  const encodeSigned = (value: number) => {
    let shifted = value < 0 ? ~(value << 1) : value << 1;
    while (shifted >= 0x20) {
      output += String.fromCharCode((0x20 | (shifted & 0x1f)) + 63);
      shifted >>= 5;
    }
    output += String.fromCharCode(shifted + 63);
  };

  for (const point of points) {
    const lat = Math.round(point.lat * factor);
    const lon = Math.round(point.lon * factor);
    encodeSigned(lat - prevLat);
    encodeSigned(lon - prevLon);
    prevLat = lat;
    prevLon = lon;
  }
  return output;
}

const GOOGLE_REFERENCE_POINTS: LatLon[] = [
  { lat: 38.5, lon: -120.2 },
  { lat: 40.7, lon: -120.95 },
  { lat: 43.252, lon: -126.453 },
];
const GOOGLE_REFERENCE_POLYLINE5 = "_p~iF~ps|U_ulLnnqC_mqNvxq`@";

const LAGOS_TRACK_POINTS: LatLon[] = [
  { lat: 6.5176, lon: 3.3787 }, // University of Lagos (Unilag)
  { lat: 6.52, lon: 3.39 },
  { lat: 6.4281, lon: 3.4219 }, // Victoria Island
];

describe("polyline decoding", () => {
  it("test-side encoder matches the classic Google precision-5 vector", () => {
    // Known-answer check of the test harness itself.
    expect(encodePolyline(GOOGLE_REFERENCE_POINTS, 5)).toBe(
      GOOGLE_REFERENCE_POLYLINE5,
    );
  });

  it("decodes the classic Google precision-5 vector", () => {
    const decoded = decodePolyline(GOOGLE_REFERENCE_POLYLINE5, 5);
    expect(decoded).toHaveLength(GOOGLE_REFERENCE_POINTS.length);
    decoded.forEach((point, i) => {
      expect(Math.abs(point.lat - GOOGLE_REFERENCE_POINTS[i].lat)).toBeLessThan(
        1e-5,
      );
      expect(Math.abs(point.lon - GOOGLE_REFERENCE_POINTS[i].lon)).toBeLessThan(
        1e-5,
      );
    });
  });

  it("round-trips precision-6 (OpenRide encodePolyline6 compatibility)", () => {
    const encoded = encodePolyline(LAGOS_TRACK_POINTS, 6);
    const decoded = decodePolyline6(encoded);
    expect(decoded).toHaveLength(LAGOS_TRACK_POINTS.length);
    decoded.forEach((point, i) => {
      expect(Math.abs(point.lat - LAGOS_TRACK_POINTS[i].lat)).toBeLessThan(
        1e-6,
      );
      expect(Math.abs(point.lon - LAGOS_TRACK_POINTS[i].lon)).toBeLessThan(
        1e-6,
      );
    });
  });

  it("precision-6 decode of a precision-5 string is NOT accidentally equal", () => {
    // Guards against a decoder that silently ignores its precision argument.
    const wrongPrecision = decodePolyline6(GOOGLE_REFERENCE_POLYLINE5);
    expect(
      Math.abs(wrongPrecision[0].lat - GOOGLE_REFERENCE_POINTS[0].lat),
    ).toBeGreaterThan(1);
  });

  it("rejects truncated input", () => {
    expect(() => decodePolyline6("_izlhA")).toThrow();
  });
});

describe("haversineM", () => {
  it("computes Unilag -> Victoria Island within the expected Lagos band", () => {
    const metres = haversineM(LAGOS_TRACK_POINTS[0], LAGOS_TRACK_POINTS[2]);
    expect(metres).toBeGreaterThan(8_000);
    expect(metres).toBeLessThan(25_000);
  });

  it("is zero for identical points and symmetric", () => {
    expect(haversineM(LAGOS_TRACK_POINTS[0], LAGOS_TRACK_POINTS[0])).toBe(0);
    const ab = haversineM(LAGOS_TRACK_POINTS[0], LAGOS_TRACK_POINTS[1]);
    const ba = haversineM(LAGOS_TRACK_POINTS[1], LAGOS_TRACK_POINTS[0]);
    expect(Math.abs(ab - ba)).toBeLessThan(1e-6);
  });
});

describe("fare variance + verdict thresholds (contract: suspect when |v| > 15)", () => {
  it("threshold constant is exactly 15", () => {
    expect(SUSPECT_THRESHOLD_PCT).toBe(15);
  });

  it("14.9% variance is ok", () => {
    expect(computeVariancePct(11_490, 10_000)).toBeCloseTo(14.9, 6);
    expect(verdictFor(14.9)).toBe("ok");
    expect(verifyTrackDistance({ distanceM: 11_490 }, 10_000)).toEqual({
      variancePct: expect.closeTo(14.9, 6),
      verdict: "ok",
    });
  });

  it("exactly 15% variance is ok (rule is strictly greater than)", () => {
    expect(computeVariancePct(11_500, 10_000)).toBeCloseTo(15, 6);
    expect(verdictFor(15)).toBe("ok");
    expect(verdictFor(-15)).toBe("ok");
  });

  it("15.1% variance is suspect, in both directions", () => {
    expect(computeVariancePct(11_510, 10_000)).toBeCloseTo(15.1, 6);
    expect(verdictFor(15.1)).toBe("suspect");
    expect(verdictFor(-15.1)).toBe("suspect");
    expect(verifyTrackDistance({ distanceM: 8_490 }, 10_000).verdict).toBe(
      "suspect",
    );
  });

  it("missing or unusable quote is unverifiable with null variance", () => {
    expect(computeVariancePct(10_000, null)).toBeNull();
    expect(computeVariancePct(10_000, undefined)).toBeNull();
    expect(computeVariancePct(10_000, 0)).toBeNull();
    expect(verdictFor(null)).toBe("unverifiable");
    expect(verifyTrackDistance({ distanceM: 10_000 }, null)).toEqual({
      variancePct: null,
      verdict: "unverifiable",
    });
  });
});

describe("ingest authorization (pure parts)", () => {
  it("allows the assigned driver", () => {
    expect(() =>
      assertAssignedDriver({ assigned_driver_user_id: 42 }, 42),
    ).not.toThrow();
  });

  it("rejects a different driver and unassigned trips", () => {
    expect(() =>
      assertAssignedDriver({ assigned_driver_user_id: 42 }, 7),
    ).toThrowError(/NOT_ASSIGNED_DRIVER/);
    expect(() =>
      assertAssignedDriver({ assigned_driver_user_id: null }, 42),
    ).toThrowError(/NOT_ASSIGNED_DRIVER/);
  });

  it("getForTrip allows rider or assigned driver, rejects strangers", () => {
    const trip = { rider_user_id: 11, assigned_driver_user_id: 42 };
    expect(() => assertTripParticipant(trip, 11)).not.toThrow();
    expect(() => assertTripParticipant(trip, 42)).not.toThrow();
    expect(() => assertTripParticipant(trip, 7)).toThrowError(
      /NOT_TRIP_PARTICIPANT/,
    );
  });
});

// ---------------------------------------------------------------------------
// ingestTrack end-to-end against an in-memory fake pool (no Postgres needed),
// following the query-handler convention from server/tripSafety.test.ts.
// ---------------------------------------------------------------------------
type QueryResult = { rows: Record<string, unknown>[]; rowCount?: number };

function createFakePool(handlers: Array<{ match: RegExp; result: QueryResult }>) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  return {
    calls,
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      const handler = handlers.find((candidate) => candidate.match.test(text));
      if (!handler) return { rows: [], rowCount: 0 };
      return handler.result;
    }),
  };
}

const TRIP_ID = "2b1b6c3e-9f4d-4a3f-9b8d-0d2f6a1c5e77";
const DRIVER_USER_ID = 42;

const C2_PAYLOAD = {
  schema: "openride.track.v1" as const,
  jobId: TRIP_ID,
  deviceId: "openride-install-abc123",
  startedAt: "2026-11-10T08:15:00Z",
  endedAt: "2026-11-10T08:45:00Z",
  distanceM: 15_490,
  movingTimeS: 648,
  totalTimeS: 812,
  maxSpeedMps: 16.2,
  ascentM: 34.0,
  descentM: 31.0,
  polyline6: encodePolyline(LAGOS_TRACK_POINTS, 6),
  epoch0: 1_731_234_567,
  dtS: [0, 3, 5],
  pointCount: 3,
};

function caller(userId: number) {
  return openrideTelemetryRouter.createCaller({
    req: { headers: {} },
    res: {},
    user: { id: userId, name: "Test Driver", role: "user" },
  } as never);
}

describe("openrideTelemetry.ingestTrack (fake pool)", () => {
  it("verifies against the fare quote and persists the track", async () => {
    const pool = createFakePool([
      {
        match: /FROM mobility\.ride_trip/,
        result: {
          rows: [
            {
              id: TRIP_ID,
              rider_user_id: 11,
              assigned_driver_user_id: DRIVER_USER_ID,
              fare_quote_id: "5c4d3b2a-1e0f-4a9b-8c7d-6e5f4a3b2c1d",
              state: "in_progress",
            },
          ],
        },
      },
      {
        match: /FROM mobility\.fare_quote/,
        result: { rows: [{ quoted_distance_m: 15_000 }] },
      },
      {
        match: /INSERT INTO mobility\.trip_track/,
        result: { rows: [{ id: "track-uuid-1" }] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const result = await caller(DRIVER_USER_ID).ingestTrack(C2_PAYLOAD);

    expect(result.trackId).toBe("track-uuid-1");
    expect(result.verdict).toBe("ok"); // 15490 vs 15000 = 3.27%
    expect(result.variancePct).toBeCloseTo(3.2666, 3);

    const insert = pool.calls.find((c) =>
      /INSERT INTO mobility\.trip_track/.test(c.text),
    );
    expect(insert).toBeDefined();
    // driver_user_id column binds the caller, raw carries the full C2 payload.
    expect(insert!.values[1]).toBe(DRIVER_USER_ID);
    expect(JSON.parse(insert!.values[10] as string).deviceId).toBe(
      C2_PAYLOAD.deviceId,
    );
  });

  it("dedupes store-and-forward retries on (trip, deviceId, startedAt)", async () => {
    const pool = createFakePool([
      {
        match: /FROM mobility\.ride_trip/,
        result: {
          rows: [
            {
              id: TRIP_ID,
              rider_user_id: 11,
              assigned_driver_user_id: DRIVER_USER_ID,
              fare_quote_id: "5c4d3b2a-1e0f-4a9b-8c7d-6e5f4a3b2c1d",
              state: "in_progress",
            },
          ],
        },
      },
      {
        match: /FROM mobility\.trip_track/,
        result: {
          rows: [{ id: "track-uuid-existing", verdict: "ok", variance_pct: "3.27" }],
        },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const result = await caller(DRIVER_USER_ID).ingestTrack(C2_PAYLOAD);

    expect(result).toEqual({
      trackId: "track-uuid-existing",
      verdict: "ok",
      variancePct: 3.27,
    });
    expect(
      pool.calls.some((c) => /INSERT INTO mobility\.trip_track/.test(c.text)),
    ).toBe(false);
  });

  it("marks the track unverifiable when the trip has no fare quote row", async () => {
    const pool = createFakePool([
      {
        match: /FROM mobility\.ride_trip/,
        result: {
          rows: [
            {
              id: TRIP_ID,
              rider_user_id: 11,
              assigned_driver_user_id: DRIVER_USER_ID,
              fare_quote_id: "5c4d3b2a-1e0f-4a9b-8c7d-6e5f4a3b2c1d",
              state: "in_progress",
            },
          ],
        },
      },
      { match: /FROM mobility\.fare_quote/, result: { rows: [] } },
      {
        match: /INSERT INTO mobility\.trip_track/,
        result: { rows: [{ id: "track-uuid-2" }] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const result = await caller(DRIVER_USER_ID).ingestTrack(C2_PAYLOAD);
    expect(result.verdict).toBe("unverifiable");
    expect(result.variancePct).toBeNull();
  });

  it("rejects callers who are not the assigned driver", async () => {
    const pool = createFakePool([
      {
        match: /FROM mobility\.ride_trip/,
        result: {
          rows: [
            {
              id: TRIP_ID,
              rider_user_id: 11,
              assigned_driver_user_id: DRIVER_USER_ID,
              fare_quote_id: null,
              state: "in_progress",
            },
          ],
        },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    await expect(caller(7).ingestTrack(C2_PAYLOAD)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(
      pool.calls.some((c) => /INSERT INTO mobility\.trip_track/.test(c.text)),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Contract C3 — bundle manifest + geo search proxy (no network: fetch stubbed)
// ---------------------------------------------------------------------------
import {
  openrideBundlesRouter,
  openrideGeoRouter,
} from "../server/openride/bundleRegistry";

function publicCaller() {
  return openrideBundlesRouter.createCaller({
    req: { headers: {} },
    res: {},
    user: null,
  } as never);
}

function geoCaller(userId = 9) {
  return openrideGeoRouter.createCaller({
    req: { headers: {} },
    res: {},
    user: { id: userId, name: "Customer", role: "user" },
  } as never);
}

describe("openrideBundles.list", () => {
  const REGISTRY_ENV = process.env.BUNDLE_REGISTRY;

  afterEach(() => {
    if (REGISTRY_ENV === undefined) delete process.env.BUNDLE_REGISTRY;
    else process.env.BUNDLE_REGISTRY = REGISTRY_ENV;
  });

  it("returns the C3 manifest with the checked-in lagos default", async () => {
    delete process.env.BUNDLE_REGISTRY;
    const manifest = await publicCaller().list();
    expect(manifest.schema).toBe("openride.bundles.v1");
    expect(manifest.bundles).toHaveLength(1);
    const lagos = manifest.bundles[0];
    expect(lagos.city).toBe("lagos");
    expect(lagos.version).toBe("2026-11-09");
    expect(lagos.bounds).toEqual({
      minLat: 6.4,
      minLon: 3.2,
      maxLat: 6.7,
      maxLon: 3.55,
    });
    expect(lagos.sizeBytes).toBe(148_000_000);
    for (const file of Object.values(lagos.files)) {
      expect(file.url).toMatch(/^https:\/\/.+\/lagos\/2026-11-09\//);
      expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("honours the BUNDLE_REGISTRY env override and fails closed on bad JSON", async () => {
    process.env.BUNDLE_REGISTRY = "not-json";
    await expect(publicCaller().list()).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "BUNDLE_REGISTRY_INVALID_JSON",
    });
  });
});

describe("openrideGeo.search", () => {
  const GEO_ENV = process.env.OPENRIDE_GEO_URL;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (GEO_ENV === undefined) delete process.env.OPENRIDE_GEO_URL;
    else process.env.OPENRIDE_GEO_URL = GEO_ENV;
  });

  it("fails closed when OPENRIDE_GEO_URL is unset", async () => {
    delete process.env.OPENRIDE_GEO_URL;
    await expect(geoCaller().search({ q: "unilag" })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "OPENRIDE_GEO_URL_NOT_CONFIGURED",
    });
  });

  it("proxies GET /search and returns the validated contract shape", async () => {
    process.env.OPENRIDE_GEO_URL = "http://geo.internal:8090";
    const upstream = [
      { name: "University of Lagos", kind: "poi", lat: 6.5176, lon: 3.3787 },
      {
        name: "Victoria Island",
        kind: "area",
        lat: 6.4281,
        lon: 3.4219,
        distanceM: null,
      },
    ];
    const fetchMock = vi.fn(
      async (_url: unknown, _init?: unknown) =>
        new Response(JSON.stringify(upstream), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await geoCaller().search({
      q: "unilag",
      lat: 6.5,
      lon: 3.39,
      limit: 8,
    });

    expect(result).toEqual(upstream);
    const calledUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(calledUrl.origin).toBe("http://geo.internal:8090");
    expect(calledUrl.pathname).toBe("/search");
    expect(calledUrl.searchParams.get("q")).toBe("unilag");
    expect(calledUrl.searchParams.get("lat")).toBe("6.5");
    expect(calledUrl.searchParams.get("lon")).toBe("3.39");
    expect(calledUrl.searchParams.get("limit")).toBe("8");
  });

  it("maps upstream failures and bad payloads to SERVICE_UNAVAILABLE", async () => {
    process.env.OPENRIDE_GEO_URL = "http://geo.internal:8090";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 502 })),
    );
    await expect(geoCaller().search({ q: "x" })).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ not: "an-array" }), { status: 200 }),
      ),
    );
    await expect(geoCaller().search({ q: "x" })).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: "OPENRIDE_GEO_INVALID_RESPONSE",
    });
  });
});
