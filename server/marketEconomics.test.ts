import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Audit B orphan-service wiring: market-economics (8110) report generation
 * persisted server-side, and safety-engine (8107) trip risk scoring on the
 * tripSafety manifest/SOS paths. Both fail-open.
 */

const dbMocks = vi.hoisted(() => ({
  getPool: vi.fn(),
}));

const fetchMocks = vi.hoisted(() => ({
  resilientFetch: vi.fn(),
  // Mirrors the FAIL_OPEN_FAST preset shape (merged to main with PR #46);
  // the mocked resilientFetch ignores the options either way.
  FAIL_OPEN_FAST: { timeoutMs: 1_500 },
}));

vi.mock("../server/db", () => dbMocks);
vi.mock("./_core/resilientFetch", () => fetchMocks);

import { generateMarketEconomicsReport } from "./_core/economicsPolicy";
import { attachManifest, scoreTripRisk } from "./_core/tripSafety";

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

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("generateMarketEconomicsReport", () => {
  function economicsPool() {
    return createPool([
      {
        match: /FROM public\.take_rate_registry/,
        result: { rows: [{ id: "tr-1", market_id: "lagos", rate_bps: 2500 }] },
      },
      {
        match: /FROM public\.fare_floor_policies/,
        result: { rows: [] },
      },
      {
        match: /INSERT INTO public\.market_economics_reports/,
        result: {
          rows: [
            {
              id: "report-1",
              market_id: "lagos",
              period: { start: "2026-08-01", end: "2026-08-31" },
              report: { market_id: "lagos" },
              created_at: new Date("2026-09-01T00:00:00Z"),
            },
          ],
          rowCount: 1,
        },
      },
    ]);
  }

  it("POSTs the published take rate + fare floor and persists the report", async () => {
    const pool = economicsPool();
    dbMocks.getPool.mockResolvedValue(pool);
    fetchMocks.resilientFetch.mockResolvedValue(
      jsonResponse({ report: { market_id: "lagos" }, markdown: "# report" }),
    );

    const result = await generateMarketEconomicsReport(1, {
      marketId: "lagos",
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
    });

    expect(result).toMatchObject({
      marketId: "lagos",
      persisted: true,
      unavailable: false,
      reportId: "report-1",
    });
    const [url, init] = fetchMocks.resilientFetch.mock.calls[0]!;
    expect(`${url}`).toContain("/reports/generate");
    const body = JSON.parse(`${init?.body}`);
    expect(body).toMatchObject({
      market_id: "lagos",
      period: { start: "2026-08-01", end: "2026-08-31" },
      published_take_rate_bps: 2500,
      fare_floor_minor: 0,
      trips: [],
    });
    const insert = pool.calls.find((call) =>
      /INSERT INTO public\.market_economics_reports/.test(call.text),
    );
    expect(insert).toBeDefined();
  });

  it("is fail-open when the service is unreachable", async () => {
    dbMocks.getPool.mockResolvedValue(economicsPool());
    fetchMocks.resilientFetch.mockRejectedValue(new Error("connection refused"));

    const result = await generateMarketEconomicsReport(1, {
      marketId: "lagos",
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
    });

    expect(result).toMatchObject({
      persisted: false,
      unavailable: true,
      reportId: null,
    });
  });

  it("is fail-open on non-OK service responses", async () => {
    dbMocks.getPool.mockResolvedValue(economicsPool());
    fetchMocks.resilientFetch.mockResolvedValue(
      jsonResponse({ detail: "invalid" }, false, 422),
    );

    const result = await generateMarketEconomicsReport(1, {
      marketId: "lagos",
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
    });
    expect(result.unavailable).toBe(true);
    expect(result.persisted).toBe(false);
  });
});

describe("scoreTripRisk (safety-engine)", () => {
  it("returns the service risk score and factors", async () => {
    fetchMocks.resilientFetch.mockResolvedValue(
      jsonResponse({ score: 42, factors: [{ factor: "night_trip", weight: 3 }] }),
    );
    const risk = await scoreTripRisk("trip-1");
    expect(risk).toEqual({
      score: 42,
      factors: [{ factor: "night_trip", weight: 3 }],
    });
    const [url] = fetchMocks.resilientFetch.mock.calls[0]!;
    expect(`${url}`).toContain("/trip/trip-1/risk");
  });

  it("is fail-open: outage returns null", async () => {
    fetchMocks.resilientFetch.mockRejectedValue(new Error("connection refused"));
    await expect(scoreTripRisk("trip-1")).resolves.toBeNull();
  });

  it("is fail-open on non-OK responses", async () => {
    fetchMocks.resilientFetch.mockResolvedValue(
      jsonResponse({ error: "risk_unavailable" }, false, 503),
    );
    await expect(scoreTripRisk("trip-1")).resolves.toBeNull();
  });
});

describe("attachManifest risk scoring", () => {
  function manifestPool() {
    return createPool([
      {
        match: /INSERT INTO public\.passenger_manifests/,
        result: {
          rows: [
            {
              id: "m-1",
              trip_id: "trip-1",
              booked_by: 10,
              passengers: [],
              manifest_verified: true,
              verified_via: "verification-intelligence",
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
          rowCount: 1,
        },
      },
      {
        match: /INSERT INTO public\.trip_safety_signals/,
        result: { rows: [], rowCount: 1 },
      },
    ]);
  }

  it("records a trip_risk_scored signal with the safety-engine score", async () => {
    const pool = manifestPool();
    dbMocks.getPool.mockResolvedValue(pool);
    fetchMocks.resilientFetch.mockImplementation(async (url: string) => {
      if (`${url}`.includes("/manifest/verify")) {
        return jsonResponse({ results: [{ name: "Ada Lovelace", name_ok: true, flags: [] }] });
      }
      return jsonResponse({ score: 55, factors: [] });
    });

    const manifest = await attachManifest(10, {
      tripId: "trip-1",
      passengers: [{ name: "Ada Lovelace" }],
    });

    expect(manifest.id).toBe("m-1");
    const signal = pool.calls.find((call) =>
      /INSERT INTO public\.trip_safety_signals/.test(call.text),
    );
    expect(signal).toBeDefined();
    const payload = JSON.parse(`${signal!.values[1]}`);
    expect(payload).toMatchObject({
      trip_id: "trip-1",
      trigger: "manifest_attached",
      risk_score: 55,
      scored_via: "safety-engine",
    });
  });

  it("still stores the manifest when safety-engine is down (fail-open signal)", async () => {
    const pool = manifestPool();
    dbMocks.getPool.mockResolvedValue(pool);
    fetchMocks.resilientFetch.mockImplementation(async (url: string) => {
      if (`${url}`.includes("/manifest/verify")) {
        return jsonResponse({ results: [{ name: "Ada Lovelace", name_ok: true, flags: [] }] });
      }
      throw new Error("connection refused");
    });

    const manifest = await attachManifest(10, {
      tripId: "trip-1",
      passengers: [{ name: "Ada Lovelace" }],
    });

    expect(manifest.id).toBe("m-1");
    const signal = pool.calls.find((call) =>
      /INSERT INTO public\.trip_safety_signals/.test(call.text),
    );
    const payload = JSON.parse(`${signal!.values[1]}`);
    expect(payload).toMatchObject({
      risk_score: null,
      scored_via: "service_unavailable",
    });
  });
});
