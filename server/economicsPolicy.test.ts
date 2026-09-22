import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getPool: vi.fn(),
}));

vi.mock("../server/db", () => dbMocks);

import {
  checkFareAgainstFloor,
  computeFareFloorMinor,
  getFareFloorPolicy,
  getLatestTakeRate,
  invalidateEconomicsPolicyCache,
  publishTakeRate,
  recordFloorOverride,
  updateCostIndex,
} from "./_core/economicsPolicy";

type QueryResult = { rows: unknown[]; rowCount?: number };

function createPool(handlers: Array<{ match: RegExp; result: QueryResult }>) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  return {
    calls,
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      const handler = handlers.find((candidate) => candidate.match.test(text));
      if (!handler) return { rows: [], rowCount: 0 };
      return typeof handler.result === "function"
        ? handler.result()
        : handler.result;
    }),
  };
}

const ACTIVE_POLICY = {
  id: "policy-1",
  market_id: "lagos",
  cost_index: {
    fuel_price_minor: 100000,
    cpi_bp: 11000,
    maintenance_index_bp: 10000,
    source: "nms",
    updated_at: "2026-09-15T00:00:00.000Z",
  },
  sustainability_multiplier: "1.000",
  active: true,
  consultation_id: null,
  created_by: 7,
  created_at: new Date().toISOString(),
};

beforeEach(() => {
  vi.resetAllMocks();
  invalidateEconomicsPolicyCache(); // hot-read cache must not leak between tests
});

describe("computeFareFloorMinor", () => {
  it("scales the fuel cost index by cpi, maintenance and multiplier", () => {
    expect(
      computeFareFloorMinor(
        { fuel_price_minor: 100000, cpi_bp: 10000, maintenance_index_bp: 10000 },
        1,
      ),
    ).toBe(100000);
    expect(
      computeFareFloorMinor(
        { fuel_price_minor: 100000, cpi_bp: 11000, maintenance_index_bp: 10000 },
        1,
      ),
    ).toBe(110000);
    expect(
      computeFareFloorMinor(
        { fuel_price_minor: 100000, cpi_bp: 11000, maintenance_index_bp: 10500 },
        "1.200",
      ),
    ).toBe(126000);
  });
});

describe("checkFareAgainstFloor", () => {
  it("allows fares at/above the floor and requires override below it", async () => {
    const pool = createPool([
      {
        match: /FROM public\.fare_floor_policies/,
        result: { rows: [ACTIVE_POLICY] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    // floor = 100000 * 1.1 * 1.0 * 1.0 = 110000
    const ok = await checkFareAgainstFloor({ marketId: "lagos", fareMinor: 110000 });
    expect(ok).toEqual({ allowed: true, floorMinor: 110000, requiresOverride: false });

    const low = await checkFareAgainstFloor({ marketId: "lagos", fareMinor: 90000 });
    expect(low).toEqual({ allowed: false, floorMinor: 110000, requiresOverride: true });
  });

  it("allows any fare when the market has no active floor policy", async () => {
    const pool = createPool([
      { match: /FROM public\.fare_floor_policies/, result: { rows: [] } },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const result = await checkFareAgainstFloor({ marketId: "kano", fareMinor: 1 });
    expect(result).toEqual({ allowed: true, floorMinor: null, requiresOverride: false });
  });
});

describe("updateCostIndex", () => {
  it("upserts the cost index into the active floor policy", async () => {
    const pool = createPool([
      {
        match: /UPDATE public\.fare_floor_policies/,
        result: { rows: [{ ...ACTIVE_POLICY, floor_minor: 0 }] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const row = await updateCostIndex(7, {
      marketId: "lagos",
      fuelPriceMinor: 100000,
      cpiBp: 11000,
      maintenanceIndexBp: 10000,
      source: "nms",
    });
    expect(row.floor_minor).toBe(110000);
    const updateCall = pool.calls.find((call) =>
      /UPDATE public\.fare_floor_policies/.test(call.text),
    );
    expect(updateCall).toBeDefined();
    const costIndex = JSON.parse(updateCall!.values[1] as string);
    expect(costIndex.fuel_price_minor).toBe(100000);
    expect(costIndex.cpi_bp).toBe(11000);
  });
});

describe("publishTakeRate", () => {
  const eligibleConsultation = {
    id: "11111111-1111-1111-1111-111111111111",
    kind: "commission",
    title: "Take rate 20%",
    payload: {},
    status: "activated",
    posted_by: 7,
    response_sla_at: new Date(Date.now() - 60_000).toISOString(),
    activated_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };

  it("inserts the next version when the consultation gate is satisfied", async () => {
    const pool = createPool([
      {
        match: /FROM public\.consultation_objects WHERE id/,
        result: { rows: [eligibleConsultation] },
      },
      {
        match: /COALESCE\(max\(version\), 0\) \+ 1/,
        result: { rows: [{ next_version: 3 }] },
      },
      {
        match: /INSERT INTO public\.take_rate_registry/,
        result: {
          rows: [
            {
              id: "tr-3",
              market_id: "lagos",
              rate_bps: 2000,
              basis: "gross",
              version: 3,
              consultation_id: eligibleConsultation.id,
            },
          ],
        },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const row = await publishTakeRate(7, {
      marketId: "lagos",
      rateBps: 2000,
      basis: "gross",
      effectiveFrom: new Date().toISOString(),
      consultationId: eligibleConsultation.id,
    });
    expect(row.version).toBe(3);
    const insertCall = pool.calls.find((call) =>
      /INSERT INTO public\.take_rate_registry/.test(call.text),
    );
    expect(insertCall!.values[5]).toBe(3); // version = max + 1
  });

  it("rejects when the consultation is open and the SLA has not elapsed", async () => {
    const pool = createPool([
      {
        match: /FROM public\.consultation_objects WHERE id/,
        result: {
          rows: [
            {
              ...eligibleConsultation,
              status: "open",
              response_sla_at: new Date(Date.now() + 3_600_000).toISOString(),
            },
          ],
        },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    await expect(
      publishTakeRate(7, {
        marketId: "lagos",
        rateBps: 2000,
        basis: "gross",
        effectiveFrom: new Date().toISOString(),
        consultationId: eligibleConsultation.id,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      pool.calls.some((call) => /INSERT INTO public\.take_rate_registry/.test(call.text)),
    ).toBe(false);
  });

  it("rejects a consultation of the wrong kind", async () => {
    const pool = createPool([
      {
        match: /FROM public\.consultation_objects WHERE id/,
        result: { rows: [{ ...eligibleConsultation, kind: "pricing" }] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    await expect(
      publishTakeRate(7, {
        marketId: "lagos",
        rateBps: 2000,
        basis: "gross",
        effectiveFrom: new Date().toISOString(),
        consultationId: eligibleConsultation.id,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("recordFloorOverride", () => {
  it("writes the override and auto-posts a pricing consultation object", async () => {
    const pool = createPool([
      {
        match: /FROM public\.fare_floor_policies/,
        result: { rows: [ACTIVE_POLICY] },
      },
      {
        match: /INSERT INTO public\.fare_floor_overrides/,
        result: { rows: [{ id: "override-1" }] },
      },
      {
        match: /INSERT INTO public\.consultation_objects/,
        result: {
          rows: [
            {
              id: "cons-1",
              kind: "pricing",
              status: "open",
            },
          ],
        },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const result = await recordFloorOverride(7, {
      marketId: "lagos",
      fareMinor: 90000,
      justification: "fuel subsidy transition week",
    });
    expect(result).toEqual({
      overrideId: "override-1",
      floorMinor: 110000,
      consultationId: "cons-1",
    });

    const overrideCall = pool.calls.find((call) =>
      /INSERT INTO public\.fare_floor_overrides/.test(call.text),
    );
    expect(overrideCall!.values).toEqual([
      "lagos",
      7,
      "fuel subsidy transition week",
      90000,
      110000,
    ]);

    const consultationCall = pool.calls.find((call) =>
      /INSERT INTO public\.consultation_objects/.test(call.text),
    );
    expect(consultationCall).toBeDefined();
    expect(consultationCall!.values[0]).toBe("pricing");
    const payload = JSON.parse(consultationCall!.values[2] as string);
    expect(payload).toMatchObject({
      override_id: "override-1",
      market_id: "lagos",
      fare_minor: 90000,
      floor_minor: 110000,
    });
  });
});

describe("economics policy hot-read cache", () => {
  it("serves repeated getFareFloorPolicy reads from cache (one DB query)", async () => {
    const pool = createPool([
      { match: /FROM public\.fare_floor_policies/, result: { rows: [ACTIVE_POLICY] } },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const first = await getFareFloorPolicy("lagos");
    const second = await getFareFloorPolicy("lagos");
    expect(first?.floor_minor).toBe(110000);
    expect(second).toEqual(first);
    expect(
      pool.calls.filter((call) => /FROM public\.fare_floor_policies/.test(call.text)),
    ).toHaveLength(1);
  });

  it("caches the null (no active policy) result too", async () => {
    const pool = createPool([
      { match: /FROM public\.fare_floor_policies/, result: { rows: [] } },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    expect(await getFareFloorPolicy("kano")).toBeNull();
    expect(await getFareFloorPolicy("kano")).toBeNull();
    expect(
      pool.calls.filter((call) => /FROM public\.fare_floor_policies/.test(call.text)),
    ).toHaveLength(1);
  });

  it("serves repeated getLatestTakeRate reads from cache", async () => {
    const takeRate = {
      id: "tr-1",
      market_id: "lagos",
      rate_bps: 1800,
      basis: "gross",
      effective_from: "2026-09-01T00:00:00.000Z",
      consultation_id: null,
      version: 3,
      created_by: 7,
      created_at: "2026-09-01T00:00:00.000Z",
    };
    const pool = createPool([
      { match: /FROM public\.take_rate_registry/, result: { rows: [takeRate] } },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    expect((await getLatestTakeRate("lagos"))?.rate_bps).toBe(1800);
    expect((await getLatestTakeRate("lagos"))?.version).toBe(3);
    expect(
      pool.calls.filter((call) => /FROM public\.take_rate_registry/.test(call.text)),
    ).toHaveLength(1);
  });

  it("updateCostIndex invalidates the cached floor for the market", async () => {
    const pool = createPool([
      {
        match: /SELECT \* FROM public\.fare_floor_policies/,
        result: { rows: [ACTIVE_POLICY] },
      },
      {
        match: /UPDATE public\.fare_floor_policies/,
        result: { rows: [{ ...ACTIVE_POLICY }] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    await getFareFloorPolicy("lagos"); // prime cache
    await updateCostIndex(7, {
      marketId: "lagos",
      fuelPriceMinor: 200000,
      cpiBp: 10000,
      maintenanceIndexBp: 10000,
      source: "nms",
    });
    await getFareFloorPolicy("lagos"); // must re-read after invalidation
    expect(
      pool.calls.filter((call) => /SELECT \* FROM public\.fare_floor_policies/.test(call.text)),
    ).toHaveLength(2);
  });

  it("invalidation is scoped per market", async () => {
    const pool = createPool([
      { match: /FROM public\.fare_floor_policies/, result: { rows: [ACTIVE_POLICY] } },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    await getFareFloorPolicy("lagos");
    await getFareFloorPolicy("kano"); // cached null
    invalidateEconomicsPolicyCache("lagos");
    await getFareFloorPolicy("lagos"); // re-reads
    await getFareFloorPolicy("kano"); // still cached
    expect(
      pool.calls.filter((call) => /FROM public\.fare_floor_policies/.test(call.text)),
    ).toHaveLength(3);
  });
});
