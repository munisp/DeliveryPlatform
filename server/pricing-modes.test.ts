import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P7 flexible pricing modes tests (P7_SPEC deliverable 6). Pool-boundary
 * mocks only (same pattern as economicsPolicy.test.ts /
 * consumer-ride.test.ts): SQL is intercepted by regex handlers; all money
 * math runs through the real module code (integer kobo, BigInt, no floats).
 *
 * Covered: 4-model settlement split exactness + trip_settlement identity,
 * quote total identity incl. platform fee (0106 REPLACED CHECK), the
 * worker-council consultation gate on pricing-model publishes, negative-rate
 * bounds (-2001 rejected / -2000 accepted), the flat-fee-required invariant,
 * pricing-block resolution + hot cache, and publish replay idempotency.
 */

type QueryResult = { rows: unknown[]; rowCount?: number };
type Handler = {
  match: RegExp;
  result: QueryResult | ((text: string) => QueryResult);
};

const dbMocks = vi.hoisted(() => ({
  getPool: vi.fn(),
}));

vi.mock("../server/db", () => dbMocks);

// Router assembly is not under test — stub the trpc builder (same stub as
// consumer-ride.test.ts) so importing consumerRide stays cheap.
vi.mock("../server/_core/trpc", () => {
  const procedure: any = {
    input: () => procedure,
    query: () => ({}),
    mutation: () => ({}),
  };
  return {
    router: (routes: unknown) => routes,
    authenticatedProcedure: procedure,
  };
});

import {
  computeSettlementSplit,
  invalidateEconomicsPolicyCache,
  invalidatePricingModelCache,
  normalizePricingModelRow,
  previewPricingImpact,
  publishPricingModel,
  resolvePricingModel,
} from "./_core/economicsPolicy";
import {
  computeRideQuoteAmounts,
  DEFAULT_RIDE_QUOTE_PRICING,
  type RideFareRule,
} from "./_core/consumerRide";

function createPool(handlers: Handler[]) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const query = vi.fn(async (text: string, values: unknown[] = []) => {
    calls.push({ text, values });
    const handler = handlers.find((candidate) => candidate.match.test(text));
    if (!handler) return { rows: [], rowCount: 0 };
    return typeof handler.result === "function"
      ? handler.result(text)
      : handler.result;
  });
  return {
    calls,
    query,
    connect: async () => ({ query, release: () => undefined }),
  };
}

const ZONE_ID = "22222222-2222-2222-2222-222222222222";
const CONSULTATION_ID = "11111111-1111-1111-1111-111111111111";

const ELIGIBLE_CONSULTATION = {
  id: CONSULTATION_ID,
  kind: "commission",
  title: "Unilag pilot: 0% + flat fee",
  payload: {},
  status: "activated",
  posted_by: 7,
  response_sla_at: new Date(Date.now() - 60_000).toISOString(),
  activated_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
};

const LIVE_RULE_ROW = {
  id: "frv-1",
  zone_id: ZONE_ID,
  version: "3",
  currency: "NGN",
  base_kobo: "50000",
  per_km_kobo: "25000",
  per_minute_kobo: "1500",
  minimum_kobo: "150000",
  cancellation_kobo: "0",
  demand_cap_basis_points: 20000,
};

function publishHandlers(options?: {
  consultationRows?: unknown[];
  liveRule?: unknown;
}) {
  return [
    {
      match: /FROM public\.consultation_objects WHERE id/,
      result: {
        rows: options?.consultationRows ?? [ELIGIBLE_CONSULTATION],
      } as QueryResult,
    },
    {
      match: /FROM mobility\.fare_rule_version/,
      result: ((text: string): QueryResult =>
        text.includes("FOR UPDATE")
          ? { rows: options?.liveRule === undefined ? [LIVE_RULE_ROW] : options.liveRule === null ? [] : [options.liveRule] }
          : { rows: [] }) as (text: string) => QueryResult,
    },
    {
      match: /UPDATE mobility\.fare_rule_version SET effective_to/,
      result: { rows: [], rowCount: 1 } as QueryResult,
    },
    {
      match: /INSERT INTO mobility\.fare_rule_version/,
      result: {
        rows: [{ id: "frv-2", effective_from: new Date().toISOString() }],
      } as QueryResult,
    },
  ] as Handler[];
}

beforeEach(() => {
  vi.resetAllMocks();
  invalidateEconomicsPolicyCache();
  invalidatePricingModelCache();
});

// ---------------------------------------------------------------------------
// computeSettlementSplit — 4-model exactness + settlement identity
// ---------------------------------------------------------------------------

describe("computeSettlementSplit", () => {
  it("commission model: 25% take splits gross exactly (integer kobo)", () => {
    const split = computeSettlementSplit({
      grossKobo: 400_000,
      taxKobo: 10_000,
      pricing: { model: "commission", takeRateBps: 2500, feePayer: "rider" },
    });
    expect(split.commissionKobo).toBe(100_000n);
    expect(split.platformFeeKobo).toBe(0n);
    expect(split.driverEarningsKobo).toBe(290_000n);
    // trip_settlement identity: gross = driver + commission + tax (+ driver-paid fee)
    expect(
      split.driverEarningsKobo + split.commissionKobo + 10_000n,
    ).toBe(400_000n);
  });

  it("commission model: bps multiply truncates toward zero (no float drift)", () => {
    const split = computeSettlementSplit({
      grossKobo: 99_999,
      taxKobo: 0,
      pricing: { model: "commission", takeRateBps: 2500, feePayer: "rider" },
    });
    expect(split.commissionKobo).toBe(24_999n); // floor(99999 * 0.25)
    expect(split.driverEarningsKobo).toBe(75_000n);
  });

  it("zero_commission model: no commission, no fee, driver keeps fare minus tax", () => {
    const split = computeSettlementSplit({
      grossKobo: 400_000,
      taxKobo: 10_000,
      pricing: { model: "zero_commission", takeRateBps: 0, feePayer: "rider" },
    });
    expect(split.commissionKobo).toBe(0n);
    expect(split.platformFeeKobo).toBe(0n);
    expect(split.driverEarningsKobo).toBe(390_000n);
  });

  it("flat_fee rider-paid: fee sits OUTSIDE gross (identity unchanged)", () => {
    const split = computeSettlementSplit({
      grossKobo: 400_000,
      taxKobo: 10_000,
      pricing: {
        model: "flat_fee",
        flatFeeKobo: 10_000,
        feePayer: "rider",
      },
    });
    expect(split.commissionKobo).toBe(0n);
    expect(split.platformFeeKobo).toBe(10_000n);
    expect(split.feePayer).toBe("rider");
    expect(split.driverEarningsKobo).toBe(390_000n);
    // Identity WITHOUT the fee (rider-paid fee outside gross):
    expect(split.driverEarningsKobo + split.commissionKobo + 10_000n).toBe(
      400_000n,
    );
  });

  it("flat_fee driver-paid: fee comes out of the driver share (identity incl. fee)", () => {
    const split = computeSettlementSplit({
      grossKobo: 400_000,
      taxKobo: 10_000,
      pricing: {
        model: "flat_fee",
        flatFeeKobo: 10_000,
        feePayer: "driver",
      },
    });
    expect(split.platformFeeKobo).toBe(10_000n);
    expect(split.feePayer).toBe("driver");
    expect(split.driverEarningsKobo).toBe(380_000n);
    // Identity WITH the driver-paid fee:
    expect(
      split.driverEarningsKobo +
        split.commissionKobo +
        10_000n +
        split.platformFeeKobo,
    ).toBe(400_000n);
  });

  it("subsidized model: -10% rate pays the driver a bonus, identity holds", () => {
    const split = computeSettlementSplit({
      grossKobo: 400_000,
      taxKobo: 10_000,
      pricing: { model: "subsidized", takeRateBps: -1000, feePayer: "rider" },
    });
    expect(split.commissionKobo).toBe(-40_000n); // driver bonus
    expect(split.driverEarningsKobo).toBe(430_000n); // 400k - 10k + 40k bonus
    expect(
      split.driverEarningsKobo + split.commissionKobo + 10_000n,
    ).toBe(400_000n);
  });

  it("subsidized model: bounded at -2000 bps and clamped to -gross", () => {
    const atBound = computeSettlementSplit({
      grossKobo: 400_000,
      pricing: { model: "subsidized", takeRateBps: -2000, feePayer: "rider" },
    });
    expect(atBound.commissionKobo).toBe(-80_000n); // exactly -20%
    // Belt-and-braces clamp below the schema bound: bonus never exceeds gross
    // (the 0106 CHECK platform_commission_kobo >= -1 * gross_fare_kobo).
    const clamped = computeSettlementSplit({
      grossKobo: 1_000,
      pricing: { model: "subsidized", takeRateBps: -999_999, feePayer: "rider" },
    });
    expect(clamped.commissionKobo).toBe(-1_000n);
    expect(clamped.driverEarningsKobo).toBe(2_000n);
  });
});

// ---------------------------------------------------------------------------
// computeRideQuoteAmounts — quote total identity incl. platform fee (0106)
// ---------------------------------------------------------------------------

const RULE: RideFareRule = {
  fareRuleId: "frv-1",
  baseKobo: 50_000n,
  perKmKobo: 25_000n,
  perMinuteKobo: 1_500n,
  minimumKobo: 150_000n,
  cancellationKobo: 0n,
  demandCapBasisPoints: 20_000,
};

describe("computeRideQuoteAmounts pricing modes", () => {
  it("default pricing reproduces the legacy quote (no fee line)", () => {
    const amounts = computeRideQuoteAmounts(RULE, 10_000, 600, 0);
    // base 50000 + distance 250000 + time 15000 = 315000; minimum 150000 not binding
    expect(amounts.totalKobo).toBe(315_000n);
    expect(amounts.platformFeeKobo).toBe(0n);
    expect(amounts.feePayer).toBe("rider");
    expect(amounts.pricingModel).toBe("commission");
    expect(amounts.totalKobo).toBe(
      amounts.baseKobo +
        amounts.distanceKobo +
        amounts.timeKobo +
        amounts.demandKobo +
        amounts.taxesAndFeesKobo,
    );
  });

  it("flat_fee rider-paid: fee is INSIDE total (0106 identity, rider pays fare + fee)", () => {
    const amounts = computeRideQuoteAmounts(RULE, 10_000, 600, 0, {
      model: "flat_fee",
      flatFeeKobo: 10_000n,
      feePayer: "rider",
    });
    expect(amounts.platformFeeKobo).toBe(10_000n);
    expect(amounts.totalKobo).toBe(325_000n);
    expect(amounts.totalKobo).toBe(
      amounts.baseKobo +
        amounts.distanceKobo +
        amounts.timeKobo +
        amounts.demandKobo +
        amounts.taxesAndFeesKobo +
        amounts.platformFeeKobo,
    );
  });

  it("flat_fee driver-paid: fee recorded, total unchanged", () => {
    const amounts = computeRideQuoteAmounts(RULE, 10_000, 600, 0, {
      model: "flat_fee",
      flatFeeKobo: 10_000n,
      feePayer: "driver",
    });
    expect(amounts.platformFeeKobo).toBe(10_000n);
    expect(amounts.feePayer).toBe("driver");
    expect(amounts.totalKobo).toBe(315_000n);
    expect(amounts.totalKobo).toBe(
      amounts.baseKobo +
        amounts.distanceKobo +
        amounts.timeKobo +
        amounts.demandKobo +
        amounts.taxesAndFeesKobo,
    );
  });

  it("zero_commission and subsidized add no fee to the quote", () => {
    for (const model of ["zero_commission", "subsidized"] as const) {
      const amounts = computeRideQuoteAmounts(RULE, 10_000, 600, 0, {
        ...DEFAULT_RIDE_QUOTE_PRICING,
        model,
      });
      expect(amounts.platformFeeKobo).toBe(0n);
      expect(amounts.totalKobo).toBe(315_000n);
      expect(amounts.pricingModel).toBe(model);
    }
  });
});

// ---------------------------------------------------------------------------
// previewPricingImpact — pure preview, bounds, fee-required invariant
// ---------------------------------------------------------------------------

describe("previewPricingImpact", () => {
  it("returns exact example splits at the three default fare levels", () => {
    const preview = previewPricingImpact({
      model: "commission",
      feePayer: "rider",
      takeRateBps: 2500,
    });
    expect(preview.examples).toHaveLength(3);
    expect(preview.examples.map((e) => e.grossKobo)).toEqual([
      150_000, 400_000, 900_000,
    ]);
    expect(preview.examples[1]).toEqual({
      grossKobo: 400_000,
      riderTotalKobo: 400_000,
      driverEarningsKobo: 300_000,
      commissionKobo: 100_000,
      platformFeeKobo: 0,
    });
  });

  it("flat_fee: rider-paid fee raises the rider total; driver-paid does not", () => {
    const riderPaid = previewPricingImpact({
      model: "flat_fee",
      feePayer: "rider",
      flatFeeKobo: 10_000,
    });
    expect(riderPaid.examples[0].riderTotalKobo).toBe(160_000);
    expect(riderPaid.examples[0].driverEarningsKobo).toBe(150_000);
    const driverPaid = previewPricingImpact({
      model: "flat_fee",
      feePayer: "driver",
      flatFeeKobo: 10_000,
    });
    expect(driverPaid.examples[0].riderTotalKobo).toBe(150_000);
    expect(driverPaid.examples[0].driverEarningsKobo).toBe(140_000);
  });

  it("rejects take rates below the bounded-subsidy floor (-2001)", () => {
    expect(() =>
      previewPricingImpact({
        model: "subsidized",
        feePayer: "rider",
        takeRateBps: -2001,
      }),
    ).toThrowError(/take_rate_out_of_bounds/);
    // -2000 (exactly -20%) is the inclusive bound and is accepted.
    const ok = previewPricingImpact({
      model: "subsidized",
      feePayer: "rider",
      takeRateBps: -2000,
    });
    expect(ok.examples[1].commissionKobo).toBe(-80_000);
  });

  it("enforces the fee-required invariant (flat_fee without fee rejected)", () => {
    expect(() =>
      previewPricingImpact({ model: "flat_fee", feePayer: "rider" }),
    ).toThrowError(/platform_fee_required_for_flat_fee/);
    expect(() =>
      previewPricingImpact({
        model: "zero_commission",
        feePayer: "rider",
        flatFeeKobo: 5_000,
      }),
    ).toThrowError(/platform_fee_only_for_flat_fee/);
  });
});

// ---------------------------------------------------------------------------
// publishPricingModel — consultation gate, invariants, versioning, replay
// ---------------------------------------------------------------------------

describe("publishPricingModel", () => {
  it("rejects flat_fee without a fee before touching the council or the DB", async () => {
    const pool = createPool([]);
    dbMocks.getPool.mockResolvedValue(pool);
    await expect(
      publishPricingModel(7, {
        zoneId: ZONE_ID,
        model: "flat_fee",
        feePayer: "rider",
        consultationId: CONSULTATION_ID,
      }),
    ).rejects.toThrowError(/platform_fee_required_for_flat_fee/);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("rejects a flat fee on non-flat_fee models", async () => {
    const pool = createPool([]);
    dbMocks.getPool.mockResolvedValue(pool);
    await expect(
      publishPricingModel(7, {
        zoneId: ZONE_ID,
        model: "zero_commission",
        flatFeeKobo: 5_000,
        feePayer: "rider",
        consultationId: CONSULTATION_ID,
      }),
    ).rejects.toThrowError(/platform_fee_only_for_flat_fee/);
  });

  it("enforces the consultation gate (open consultation, SLA not elapsed)", async () => {
    const pool = createPool(
      publishHandlers({
        consultationRows: [
          {
            ...ELIGIBLE_CONSULTATION,
            status: "open",
            response_sla_at: new Date(Date.now() + 3_600_000).toISOString(),
            activated_at: null,
          },
        ],
      }),
    );
    dbMocks.getPool.mockResolvedValue(pool);
    await expect(
      publishPricingModel(7, {
        zoneId: ZONE_ID,
        model: "flat_fee",
        flatFeeKobo: 10_000,
        feePayer: "rider",
        consultationId: CONSULTATION_ID,
      }),
    ).rejects.toThrowError(/consultation_gate_unmet/);
    // Gate fired before any fare_rule_version write.
    expect(
      pool.calls.some((call) => /INSERT INTO mobility\.fare_rule_version/.test(call.text)),
    ).toBe(false);
  });

  it("rejects a consultation of the wrong kind", async () => {
    const pool = createPool(
      publishHandlers({
        consultationRows: [{ ...ELIGIBLE_CONSULTATION, kind: "pricing" }],
      }),
    );
    dbMocks.getPool.mockResolvedValue(pool);
    await expect(
      publishPricingModel(7, {
        zoneId: ZONE_ID,
        model: "flat_fee",
        flatFeeKobo: 10_000,
        feePayer: "rider",
        consultationId: CONSULTATION_ID,
      }),
    ).rejects.toThrowError(/consultation_kind_mismatch/);
  });

  it("publishes a versioned flat_fee rule: closes the live row, inserts the successor", async () => {
    const pool = createPool(publishHandlers());
    dbMocks.getPool.mockResolvedValue(pool);
    const result = await publishPricingModel(7, {
      zoneId: ZONE_ID,
      model: "flat_fee",
      flatFeeKobo: 10_000,
      feePayer: "rider",
      consultationId: CONSULTATION_ID,
    });
    expect(result.model).toBe("flat_fee");
    expect(result.flatFeeKobo).toBe(10_000);
    expect(result.version).toBe("4"); // numeric version increments
    const update = pool.calls.find((call) =>
      /UPDATE mobility\.fare_rule_version SET effective_to/.test(call.text),
    );
    expect(update?.values[0]).toBe("frv-1");
    const insert = pool.calls.find((call) =>
      /INSERT INTO mobility\.fare_rule_version/.test(call.text),
    );
    expect(insert).toBeDefined();
    // Fare parameters carried over verbatim; pricing block from the publish.
    expect(insert!.values[3]).toBe("50000"); // base_kobo
    expect(insert!.values[10]).toBe("flat_fee");
    expect(insert!.values[11]).toBe(10_000);
    expect(insert!.values[12]).toBe("rider");
  });

  it("publish replay is effect-idempotent: the active block does not drift", async () => {
    const pool = createPool(publishHandlers());
    dbMocks.getPool.mockResolvedValue(pool);
    const input = {
      zoneId: ZONE_ID,
      model: "flat_fee" as const,
      flatFeeKobo: 10_000,
      feePayer: "rider" as const,
      consultationId: CONSULTATION_ID,
    };
    const first = await publishPricingModel(7, input);
    const second = await publishPricingModel(7, input);
    // Both publishes succeed (each versions a new fare rule); the pricing
    // effect is identical — no stacked fees, same block.
    expect(second.model).toBe(first.model);
    expect(second.flatFeeKobo).toBe(first.flatFeeKobo);
    expect(second.feePayer).toBe(first.feePayer);
    const flatFeeRow = {
      fare_rule_id: "frv-2",
      pricing_model: "flat_fee",
      platform_fee_flat_kobo: "10000",
      platform_fee_payer: "rider",
    };
    const readPool = createPool([
      {
        match: /FROM mobility\.fare_rule_version/,
        result: { rows: [flatFeeRow] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(readPool);
    invalidatePricingModelCache(ZONE_ID);
    const afterFirst = await resolvePricingModel(ZONE_ID);
    const afterSecond = await resolvePricingModel(ZONE_ID);
    expect(afterFirst).toMatchObject({
      model: "flat_fee",
      flatFeeKobo: 10_000,
      feePayer: "rider",
    });
    expect(afterSecond).toEqual(afterFirst);
  });
});

// ---------------------------------------------------------------------------
// resolvePricingModel — resolution, legacy defaults, hot cache
// ---------------------------------------------------------------------------

describe("resolvePricingModel", () => {
  it("resolves the live fare rule pricing block and hot-caches it per zone", async () => {
    const pool = createPool([
      {
        match: /FROM mobility\.fare_rule_version/,
        result: {
          rows: [
            {
              fare_rule_id: "frv-1",
              pricing_model: "flat_fee",
              platform_fee_flat_kobo: "10000",
              platform_fee_payer: "driver",
            },
          ],
        },
      },
      {
        match: /FROM public\.take_rate_registry/,
        result: { rows: [{ rate_bps: -1000 }] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    const first = await resolvePricingModel(ZONE_ID, "lagos");
    expect(first).toMatchObject({
      fareRuleId: "frv-1",
      zoneId: ZONE_ID,
      model: "flat_fee",
      flatFeeKobo: 10_000,
      feePayer: "driver",
      takeRateBps: -1000, // negative published rate flows through (subsidy)
    });
    const second = await resolvePricingModel(ZONE_ID, "lagos");
    expect(second).toEqual(first);
    // Hot cache: only ONE fare_rule_version read across both resolves.
    expect(
      pool.calls.filter((call) =>
        /FROM mobility\.fare_rule_version/.test(call.text),
      ),
    ).toHaveLength(1);
  });

  it("legacy rows (pre-0106 NULLs) resolve to the commission default", async () => {
    const pool = createPool([
      {
        match: /FROM mobility\.fare_rule_version/,
        result: {
          rows: [
            {
              fare_rule_id: "frv-1",
              pricing_model: null,
              platform_fee_flat_kobo: null,
              platform_fee_payer: null,
            },
          ],
        },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    const block = await resolvePricingModel(ZONE_ID);
    expect(block).toMatchObject({
      model: "commission",
      flatFeeKobo: 0,
      feePayer: "rider",
      takeRateBps: 0, // no marketId supplied
    });
  });

  it("returns null (cached) when the zone has no live fare rule", async () => {
    const pool = createPool([
      { match: /FROM mobility\.fare_rule_version/, result: { rows: [] } },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    expect(await resolvePricingModel(ZONE_ID)).toBeNull();
    expect(await resolvePricingModel(ZONE_ID)).toBeNull();
    expect(
      pool.calls.filter((call) =>
        /FROM mobility\.fare_rule_version/.test(call.text),
      ),
    ).toHaveLength(1);
  });

  it("invalidatePricingModelCache forces a re-read for the zone", async () => {
    const pool = createPool([
      {
        match: /FROM mobility\.fare_rule_version/,
        result: {
          rows: [
            {
              fare_rule_id: "frv-1",
              pricing_model: "commission",
              platform_fee_flat_kobo: null,
              platform_fee_payer: "rider",
            },
          ],
        },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    await resolvePricingModel(ZONE_ID);
    invalidatePricingModelCache(ZONE_ID);
    await resolvePricingModel(ZONE_ID);
    expect(
      pool.calls.filter((call) =>
        /FROM mobility\.fare_rule_version/.test(call.text),
      ),
    ).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// normalizePricingModelRow — pure normalization guards
// ---------------------------------------------------------------------------

describe("normalizePricingModelRow", () => {
  it("normalizes a flat_fee row and clamps junk to safe defaults", () => {
    expect(
      normalizePricingModelRow({
        pricing_model: "flat_fee",
        platform_fee_flat_kobo: "10000",
        platform_fee_payer: "driver",
      }),
    ).toEqual({ model: "flat_fee", flatFeeKobo: 10_000, feePayer: "driver" });
    expect(
      normalizePricingModelRow({
        pricing_model: "bogus",
        platform_fee_flat_kobo: "10000",
        platform_fee_payer: "alien",
      }),
    ).toEqual({ model: "commission", flatFeeKobo: 0, feePayer: "rider" });
    // A non-flat_fee model never carries a fee into quote math.
    expect(
      normalizePricingModelRow({
        pricing_model: "zero_commission",
        platform_fee_flat_kobo: "10000",
        platform_fee_payer: "rider",
      }),
    ).toEqual({ model: "zero_commission", flatFeeKobo: 0, feePayer: "rider" });
  });
});
