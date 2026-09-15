import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getPool: vi.fn(),
}));

vi.mock("../server/db", () => dbMocks);

import {
  attachManifest,
  cancelSOS,
  getManifest,
  listActiveSOS,
  resolveSOS,
  triggerSOS,
} from "./_core/tripSafety";

type QueryResult = { rows: unknown[]; rowCount?: number };

function createPool(handlers: Array<{ match: RegExp; result: QueryResult }>) {
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const RAW_NIN = "12345678901";
const NIN_HASH = createHash("sha256").update(RAW_NIN, "utf8").digest("hex");

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("attachManifest", () => {
  it("hashes NINs (never stores raw values) and stores per-passenger verdicts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          results: [
            { name: "Adaeze Okafor", name_ok: true, nin_format_ok: null, flags: [] },
            { name: "Snake", name_ok: false, nin_format_ok: null, flags: ["pseudonym"] },
          ],
        }),
      ),
    );
    const pool = createPool([
      {
        match: /INSERT INTO public\.passenger_manifests/,
        result: {
          rows: [
            {
              id: "m-1",
              trip_id: "trip-1",
              booked_by: 42,
              manifest_verified: false,
              verified_via: "verification-intelligence",
            },
          ],
        },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const row = await attachManifest(42, {
      tripId: "trip-1",
      passengers: [{ name: "Adaeze Okafor", nin: RAW_NIN }, { name: "Snake" }],
    });

    const insert = pool.calls.find((call) =>
      /INSERT INTO public\.passenger_manifests/.test(call.text),
    );
    expect(insert).toBeDefined();
    const storedPassengers = JSON.parse(insert!.values[2] as string) as Array<{
      name: string;
      ninHash: string | null;
      verified: boolean;
      flags: string[];
    }>;
    // Raw NIN never persisted anywhere in the stored payload.
    expect(JSON.stringify(storedPassengers)).not.toContain(RAW_NIN);
    expect(storedPassengers[0]).toEqual({
      name: "Adaeze Okafor",
      ninHash: NIN_HASH,
      verified: true,
      flags: [],
    });
    expect(storedPassengers[1]).toEqual({
      name: "Snake",
      ninHash: null,
      verified: false,
      flags: ["pseudonym"],
    });
    // Not every passenger verified -> manifest not verified.
    expect(insert!.values[3]).toBe(false);
    expect(insert!.values[4]).toBe("verification-intelligence");
    expect(row.trip_id).toBe("trip-1");

    // The external call carried names only — no raw NIN left the platform.
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(init.body)).not.toContain(RAW_NIN);
  });

  it("marks a fully verified manifest as manifest_verified", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          results: [{ name: "Adaeze Okafor", name_ok: true, nin_format_ok: null, flags: [] }],
        }),
      ),
    );
    const pool = createPool([
      {
        match: /INSERT INTO public\.passenger_manifests/,
        result: { rows: [{ id: "m-2", trip_id: "trip-2" }] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    await attachManifest(42, {
      tripId: "trip-2",
      passengers: [{ name: "Adaeze Okafor", nin: RAW_NIN }],
    });
    const insert = pool.calls.find((call) =>
      /INSERT INTO public\.passenger_manifests/.test(call.text),
    );
    expect(insert!.values[3]).toBe(true);
  });

  it("fails open when verification-intelligence is down", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const pool = createPool([
      {
        match: /INSERT INTO public\.passenger_manifests/,
        result: { rows: [{ id: "m-3", trip_id: "trip-3" }] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    await attachManifest(42, {
      tripId: "trip-3",
      passengers: [{ name: "Adaeze Okafor", nin: RAW_NIN }],
    });
    const insert = pool.calls.find((call) =>
      /INSERT INTO public\.passenger_manifests/.test(call.text),
    );
    expect(insert!.values[3]).toBe(false); // manifest_verified
    expect(insert!.values[4]).toBe("service_unavailable");
    const stored = JSON.parse(insert!.values[2] as string) as Array<{ flags: string[] }>;
    expect(stored[0]!.flags).toEqual(["service_unavailable"]);
    expect(warn).toHaveBeenCalled();
  });
});

describe("getManifest", () => {
  const manifestRow = {
    id: "m-1",
    trip_id: "trip-1",
    booked_by: 42,
    passengers: JSON.stringify([
      { name: "Adaeze Okafor", ninHash: NIN_HASH, verified: true, flags: [] },
    ]),
    manifest_verified: true,
    verified_via: "verification-intelligence",
  };

  it("returns names and verified flags with NIN hashes redacted for the booker", async () => {
    const pool = createPool([
      {
        match: /FROM public\.passenger_manifests WHERE trip_id/,
        result: { rows: [manifestRow] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const manifest = await getManifest("trip-1", 42);
    expect(manifest.manifestVerified).toBe(true);
    expect(manifest.passengers).toEqual([
      { name: "Adaeze Okafor", verified: true, flags: [] },
    ]);
    expect(JSON.stringify(manifest)).not.toContain(NIN_HASH);
  });

  it("allows the driver assigned to the trip", async () => {
    const pool = createPool([
      {
        match: /FROM public\.passenger_manifests WHERE trip_id/,
        result: { rows: [manifestRow] },
      },
      { match: /FROM mobility\.ride_trip/, result: { rows: [{ exists: true }] } },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const manifest = await getManifest("trip-1", 77);
    expect(manifest.passengers).toHaveLength(1);
  });

  it("forbids unrelated users", async () => {
    const pool = createPool([
      {
        match: /FROM public\.passenger_manifests WHERE trip_id/,
        result: { rows: [manifestRow] },
      },
      { match: /FROM mobility\.ride_trip/, result: { rows: [{ exists: false }] } },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    await expect(getManifest("trip-1", 99)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("SOS flow", () => {
  it("creates an active event plus an sos_triggered safety signal", async () => {
    const pool = createPool([
      {
        match: /INSERT INTO public\.sos_events/,
        result: {
          rows: [
            {
              id: "sos-1",
              trip_id: "trip-1",
              user_id: 42,
              role: "rider",
              status: "active",
              lat: "6.5244000",
              lng: "3.3792000",
            },
          ],
        },
      },
      { match: /INSERT INTO public\.trip_safety_signals/, result: { rows: [] } },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const event = await triggerSOS(42, {
      tripId: "trip-1",
      role: "rider",
      lat: 6.5244,
      lng: 3.3792,
    });
    expect(event.status).toBe("active");

    const signal = pool.calls.find((call) =>
      /INSERT INTO public\.trip_safety_signals/.test(call.text),
    );
    expect(signal).toBeDefined();
    expect(signal!.values[0]).toBe("trip-1");
    const payload = JSON.parse(signal!.values[1] as string);
    expect(payload).toMatchObject({ sos_id: "sos-1", user_id: 42, role: "rider" });
  });

  it("resolveSOS marks an active event resolved by the operator", async () => {
    const pool = createPool([
      {
        match: /UPDATE public\.sos_events/,
        result: { rows: [{ id: "sos-1", status: "resolved", resolved_by: 7 }] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const row = await resolveSOS(7, { sosId: "sos-1" });
    expect(row.status).toBe("resolved");
    const update = pool.calls[0];
    expect(update.text).toContain("status = 'resolved'");
    expect(update.values).toEqual(["sos-1", 7]);
  });

  it("cancelSOS only cancels the caller's own active events", async () => {
    const pool = createPool([
      { match: /UPDATE public\.sos_events/, result: { rows: [] } },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    await expect(cancelSOS(99, { sosId: "sos-1" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const update = pool.calls[0];
    expect(update.text).toContain("user_id = $2");
    expect(update.text).toContain("status = 'active'");
    expect(update.values).toEqual(["sos-1", 99]);
  });

  it("listActiveSOS returns active events newest first", async () => {
    const pool = createPool([
      {
        match: /FROM public\.sos_events/,
        result: { rows: [{ id: "sos-2", status: "active" }] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const rows = await listActiveSOS();
    expect(rows).toHaveLength(1);
    expect(pool.calls[0].text).toContain("WHERE status = 'active'");
  });
});
