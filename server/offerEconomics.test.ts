import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getPool: vi.fn(),
}));

vi.mock("../server/db", () => dbMocks);

import {
  computeAndStoreBreakdown,
  computeDeadheadMinor,
  computePlatformFeeMinor,
  computeSurgeBps,
  DEFAULT_DEADHEAD_PER_MINUTE_MINOR,
  getMyNetEarningsSummary,
  getOfferBreakdown,
} from "./_core/offerEconomics";
// economicsPolicy reads (take rate / fare floor) are cached in-process
// (perf wave W2); clear the cache so tests stay isolated.
import { invalidateEconomicsPolicyCache } from "./_core/economicsPolicy";

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

const OFFER_SOURCE = {
  offer_id: "offer-1",
  trip_id: "trip-1",
  driver_user_id: 42,
  pickup_distance_m: 1800,
  pickup_eta_s: 600,
  gross_fare_kobo: 500000,
  taxes_and_fees_kobo: 25000,
  platform_commission_bp: 1500,
  base_kobo: 100000,
  distance_kobo: 250000,
  time_kobo: 100000,
  demand_kobo: 25000,
  zone_id: "zone-lagos",
};

beforeEach(() => {
  vi.resetAllMocks();
  invalidateEconomicsPolicyCache();
});

describe("computeDeadheadMinor", () => {
  it("pays nothing at or below the 300s threshold", () => {
    expect(computeDeadheadMinor(299, 5000)).toBe(0);
    expect(computeDeadheadMinor(300, 5000)).toBe(0);
  });

  it("pays per started minute beyond the threshold (600s = 5 credits)", () => {
    expect(computeDeadheadMinor(600, 5000)).toBe(5 * 5000);
    expect(computeDeadheadMinor(301, 5000)).toBe(5000);
  });
});

describe("computePlatformFeeMinor", () => {
  it("rounds fare * bps / 10000", () => {
    expect(computePlatformFeeMinor(475000, 2000)).toBe(95000);
    expect(computePlatformFeeMinor(101, 1500)).toBe(15);
  });
});

describe("computeSurgeBps", () => {
  it("derives surge from the demand component over the core fare", () => {
    expect(
      computeSurgeBps({ baseMinor: 100000, distanceMinor: 250000, timeMinor: 100000, demandMinor: 25000 }),
    ).toBe(556);
    expect(
      computeSurgeBps({ baseMinor: 0, distanceMinor: 0, timeMinor: 0, demandMinor: 5 }),
    ).toBe(0);
  });
});

describe("computeAndStoreBreakdown", () => {
  function breakdownPool() {
    return createPool([
      { match: /FROM mobility\.driver_offer o/, result: { rows: [OFFER_SOURCE] } },
      { match: /FROM public\.take_rate_registry/, result: { rows: [] } },
      { match: /FROM public\.fare_floor_policies/, result: { rows: [] } },
      {
        match: /INSERT INTO public\.offer_economics_breakdowns/,
        result: {
          rows: [{ id: "bd-1", offer_id: "offer-1" }],
        },
      },
    ]);
  }

  it("computes deadhead, fee and net then upserts idempotently by offer_id", async () => {
    const pool = breakdownPool();
    dbMocks.getPool.mockResolvedValue(pool);

    const row = await computeAndStoreBreakdown({ offerId: "offer-1" });
    expect(row.offer_id).toBe("offer-1");

    const upsert = pool.calls.find((call) =>
      /INSERT INTO public\.offer_economics_breakdowns/.test(call.text),
    );
    expect(upsert).toBeDefined();
    expect(upsert!.text).toContain("ON CONFLICT (offer_id)");
    const values = upsert!.values;
    // [offer_id, market_id, base, distance, time, deadhead, pickup_s, pickup_m,
    //  surge_bps, take_rate_bps, platform_fee, net_to_driver]
    expect(values[0]).toBe("offer-1");
    expect(values[1]).toBe("zone-lagos"); // market defaults to trip zone
    expect(values[5]).toBe(5 * DEFAULT_DEADHEAD_PER_MINUTE_MINOR); // 600s pickup
    expect(values[6]).toBe(600);
    expect(values[7]).toBe(1800);
    expect(values[9]).toBe(1500); // falls back to disclosure commission bp
    const fare = 500000 - 25000;
    expect(values[10]).toBe(Math.round((fare * 1500) / 10000));
    expect(values[11]).toBe(fare + 5 * DEFAULT_DEADHEAD_PER_MINUTE_MINOR - Math.round((fare * 1500) / 10000));
  });

  it("prefers the published take rate and fuel-derived deadhead rate", async () => {
    const pool = createPool([
      { match: /FROM mobility\.driver_offer o/, result: { rows: [OFFER_SOURCE] } },
      {
        match: /FROM public\.take_rate_registry/,
        result: { rows: [{ rate_bps: 2000 }] },
      },
      {
        match: /FROM public\.fare_floor_policies/,
        result: {
          rows: [
            {
              cost_index: { fuel_price_minor: 120000 },
              sustainability_multiplier: "1.000",
            },
          ],
        },
      },
      {
        match: /INSERT INTO public\.offer_economics_breakdowns/,
        result: { rows: [{ id: "bd-2", offer_id: "offer-1" }] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    await computeAndStoreBreakdown({ offerId: "offer-1" });
    const upsert = pool.calls.find((call) =>
      /INSERT INTO public\.offer_economics_breakdowns/.test(call.text),
    );
    // perMinute = ceil(120000/20) = 6000; deadhead = 5 * 6000
    expect(upsert!.values[5]).toBe(30000);
    expect(upsert!.values[9]).toBe(2000);
  });

  it("throws NOT_FOUND for unknown offers", async () => {
    const pool = createPool([
      { match: /FROM mobility\.driver_offer o/, result: { rows: [] } },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    await expect(computeAndStoreBreakdown({ offerId: "nope" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("getOfferBreakdown", () => {
  it("returns the stored row without recomputing when present", async () => {
    const pool = createPool([
      {
        match: /SELECT \* FROM public\.offer_economics_breakdowns WHERE offer_id/,
        result: { rows: [{ id: "bd-1", offer_id: "offer-1", net_to_driver_minor: 1 }] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const row = await getOfferBreakdown("offer-1");
    expect(row.id).toBe("bd-1");
    expect(
      pool.calls.some((call) => /FROM mobility\.driver_offer o/.test(call.text)),
    ).toBe(false);
  });
});

describe("getMyNetEarningsSummary", () => {
  it("sums the last 30 days of breakdowns joined to the driver offers", async () => {
    const pool = createPool([
      {
        match: /FROM public\.offer_economics_breakdowns b/,
        result: {
          rows: [
            {
              offers: 3,
              gross_minor: "1200000",
              deadhead_minor: "30000",
              platform_fee_minor: "180000",
              net_to_driver_minor: "1050000",
            },
          ],
        },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const summary = await getMyNetEarningsSummary(42);
    expect(summary).toEqual({
      currency: "NGN",
      windowDays: 30,
      offers: 3,
      grossMinor: 1200000,
      deadheadMinor: 30000,
      platformFeeMinor: 180000,
      netToDriverMinor: 1050000,
    });
    const call = pool.calls[0];
    expect(call.text).toContain("mobility.driver_offer");
    expect(call.text).toContain("30 days");
    expect(call.values).toEqual([42]);
  });
});
