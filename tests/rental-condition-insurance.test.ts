/**
 * Rental condition & insurance wave (drizzle/0096) — unit + static tests.
 *
 * Covers:
 *   1. server/rental/settlementMath.ts — pure settlement arithmetic
 *      (boundaries, overflow guards, damage split, deposit rounding).
 *   2. drizzle/0096_rental_condition_insurance.sql — static assertions in the
 *      style of tests/gig-vehicle-rental-operations.config.test.ts.
 *   3. server/rental/conditionInsurance.ts — router shape and zod-level input
 *      validation via createCaller with a fake ctx (no database touched:
 *      validation rejects before any resolver runs).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  computeBilledWeeks,
  computeDamageSplit,
  computeDepositWithMultiplier,
  computeExcessKm,
  computeExcessKmCharge,
  computeNewDamageZones,
  MS_PER_WEEK,
} from "../server/rental/settlementMath";
import {
  rentalConditionRouter,
  rentalInsuranceRouter,
} from "../server/rental/conditionInsurance";

// ---------------------------------------------------------------------------
// settlementMath — pure helpers
// ---------------------------------------------------------------------------
const T0 = "2026-11-01T00:00:00.000Z";
const plus = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();

describe("computeBilledWeeks", () => {
  it("bills 6d23h as 1 week (ceil of a partial first week)", () => {
    const sixDays23h = 6 * 86_400_000 + 23 * 3_600_000;
    expect(computeBilledWeeks(T0, plus(sixDays23h))).toBe(1);
  });

  it("bills 7d+1s as 2 weeks", () => {
    expect(computeBilledWeeks(T0, plus(MS_PER_WEEK + 1_000))).toBe(2);
  });

  it("bills exactly 7 days as 1 week", () => {
    expect(computeBilledWeeks(T0, plus(MS_PER_WEEK))).toBe(1);
  });

  it("bills 15 days as 3 weeks", () => {
    expect(computeBilledWeeks(T0, plus(15 * 86_400_000))).toBe(3);
  });

  it("throws when now is not after activation", () => {
    expect(() => computeBilledWeeks(T0, T0)).toThrow(RangeError);
    expect(() => computeBilledWeeks(T0, plus(-1_000))).toThrow(RangeError);
  });

  it("throws on unparseable timestamps", () => {
    expect(() => computeBilledWeeks("not-a-date", T0)).toThrow(RangeError);
  });
});

describe("computeExcessKm", () => {
  const includedKmPerWeek = 1_000;

  it("treats distance exactly at the included boundary as 0 excess", () => {
    expect(
      computeExcessKm({ distanceKm: 2_000, includedKmPerWeek, billedWeeks: 2 }),
    ).toEqual({ includedKm: 2_000, excessKm: 0 });
  });

  it("treats distance below the included km as 0 excess", () => {
    expect(
      computeExcessKm({ distanceKm: 1_999, includedKmPerWeek, billedWeeks: 2 }),
    ).toEqual({ includedKm: 2_000, excessKm: 0 });
  });

  it("charges only the kilometres above the included allowance", () => {
    expect(
      computeExcessKm({ distanceKm: 2_001, includedKmPerWeek, billedWeeks: 2 }),
    ).toEqual({ includedKm: 2_000, excessKm: 1 });
  });
});

describe("computeExcessKmCharge", () => {
  it("multiplies excess km by the per-km price", () => {
    expect(computeExcessKmCharge(37, 12_500)).toBe(462_500);
  });

  it("is 0 for 0 excess km", () => {
    expect(computeExcessKmCharge(0, 12_500)).toBe(0);
  });

  it("throws RangeError when the product is not a safe integer", () => {
    expect(() =>
      computeExcessKmCharge(Number.MAX_SAFE_INTEGER, 2),
    ).toThrow(RangeError);
    expect(() =>
      computeExcessKmCharge(2 ** 53, 2 ** 10),
    ).toThrow(/exceeds bigint range/);
  });
});

describe("computeDamageSplit", () => {
  const tier = { excessMinor: 50_000, damageCapMinor: 500_000 };

  it("makes the renter bear the full damage charge without a tier", () => {
    expect(computeDamageSplit(120_000, null)).toEqual({
      renterLiabilityMinor: 120_000,
      insuranceCreditMinor: 0,
    });
  });

  it("charges the renter only, below the excess", () => {
    expect(computeDamageSplit(40_000, tier)).toEqual({
      renterLiabilityMinor: 40_000,
      insuranceCreditMinor: 0,
    });
  });

  it("splits at the excess when damage is within the damage cap", () => {
    expect(computeDamageSplit(120_000, tier)).toEqual({
      renterLiabilityMinor: 50_000,
      insuranceCreditMinor: 70_000,
    });
  });

  it("caps the insurance credit at the damage cap", () => {
    expect(computeDamageSplit(900_000, tier)).toEqual({
      renterLiabilityMinor: 50_000,
      insuranceCreditMinor: 500_000,
    });
  });
});

describe("computeDepositWithMultiplier", () => {
  it("scales the base deposit by the tier multiplier", () => {
    expect(computeDepositWithMultiplier(200_000, 15_000)).toBe(300_000);
  });

  it("rounds .5 up via Math.round", () => {
    // 1001 * 5000 / 10000 = 500.5 -> 501
    expect(computeDepositWithMultiplier(1_001, 5_000)).toBe(501);
  });

  it("throws RangeError when the adjusted deposit is not a safe integer", () => {
    expect(() =>
      computeDepositWithMultiplier(Number.MAX_SAFE_INTEGER, 100_000),
    ).toThrow(RangeError);
  });
});

describe("computeNewDamageZones", () => {
  it("returns the sorted set difference (check-in minus check-out)", () => {
    expect(
      computeNewDamageZones(
        ["front", "roof"],
        ["roof", "rear", "front", "left"],
      ),
    ).toEqual(["left", "rear"]);
  });

  it("dedupes repeated check-in flags", () => {
    expect(computeNewDamageZones([], ["wheels", "wheels"])).toEqual(["wheels"]);
  });

  it("is empty when check-in flags nothing new or nothing at all", () => {
    expect(computeNewDamageZones(["front", "roof"], ["front"])).toEqual([]);
    expect(computeNewDamageZones([], [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Migration static assertions (drizzle/0096), config-test style
// ---------------------------------------------------------------------------
const root = resolve(import.meta.dirname, "..");
const migration = readFileSync(
  resolve(root, "drizzle/0096_rental_condition_insurance.sql"),
  "utf8",
);

describe("drizzle/0096_rental_condition_insurance.sql", () => {
  it("creates all five tables", () => {
    for (const table of [
      "insurance_tier",
      "contract_insurance_selection",
      "condition_report",
      "condition_photo",
      "return_settlement",
    ]) {
      expect(migration).toContain(
        `CREATE TABLE IF NOT EXISTS vehicle_access.${table}`,
      );
    }
  });

  it("creates the three enums with the frozen value lists", () => {
    expect(migration).toContain(
      "CREATE TYPE vehicle_access.condition_phase AS ENUM ('check_out','check_in')",
    );
    expect(migration).toContain(
      "CREATE TYPE vehicle_access.condition_grade AS ENUM ('excellent','good','fair','poor','damaged')",
    );
    expect(migration).toContain(
      "CREATE TYPE vehicle_access.photo_zone AS ENUM ('front','rear','left','right','interior_front','interior_rear','dashboard_odometer','wheels','roof','other')",
    );
  });

  it("creates all seven SECURITY DEFINER authority functions", () => {
    for (const fn of [
      "create_insurance_tier",
      "retire_insurance_tier",
      "select_contract_insurance",
      "list_insurance_tiers_for_offer",
      "record_condition_report",
      "compute_return_settlement",
      "condition_delta_report",
    ]) {
      expect(migration).toContain(`vehicle_access.${fn}`);
    }
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain("SET search_path = pg_catalog, vehicle_access");
  });

  it("adds the three new transition gates to transition_contract", () => {
    expect(migration).toContain("check-out condition report required");
    expect(migration).toContain("check-in condition report required");
    expect(migration).toContain("return settlement required");
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION vehicle_access.transition_contract",
    );
  });

  it("keeps the four evidence tables append-only via trigger", () => {
    for (const table of [
      "contract_insurance_selection",
      "condition_report",
      "condition_photo",
      "return_settlement",
    ]) {
      expect(migration).toMatch(
        new RegExp(
          `CREATE TRIGGER[^;]*${table}[^;]*prevent_rental_operations_mutation`,
          "i",
        ),
      );
    }
  });

  it("extends the aggregate_type CHECK with the three new values", () => {
    expect(migration).toContain(
      "DROP CONSTRAINT IF EXISTS rental_operations_event_aggregate_type_check",
    );
    for (const value of ["insurance_tier", "condition_report", "settlement"]) {
      expect(migration).toContain(`'${value}'`);
    }
  });

  it("guards the GRANT block behind a pg_roles existence check", () => {
    expect(migration).toContain("GRANT EXECUTE");
    expect(migration).toContain("vehicle_access_service");
    expect(migration).toContain("pg_roles");
  });
});

// ---------------------------------------------------------------------------
// Router shape + zod-level input validation (no database)
// ---------------------------------------------------------------------------
type AnyRouter = { _def: { procedures: Record<string, unknown> } };

function procedureKeys(r: unknown): string[] {
  return Object.keys((r as AnyRouter)._def.procedures).sort();
}

function authedCaller(userId = 9) {
  return rentalConditionRouter.createCaller({
    req: { headers: {} },
    res: {},
    user: { id: userId, name: "Rental Worker", role: "user" },
  } as never);
}

function operatorCaller(userId = 1) {
  return rentalConditionRouter.createCaller({
    req: { headers: {} },
    res: {},
    user: { id: userId, name: "Ops", role: "operator" },
  } as never);
}

const VALID_SHA256 = "a".repeat(64);
const VALID_PHOTO = {
  zone: "dashboard_odometer" as const,
  objectKey: "condition/contract-1/check-out-odometer.jpg",
  contentType: "image/jpeg" as const,
  sha256Hex: VALID_SHA256,
  damageFlag: false,
};
const VALID_REPORT = {
  contractId: "2b1b6c3e-9f4d-4a3f-9b8d-0d2f6a1c5e77",
  phase: "check_out" as const,
  odometerKm: 12_345,
  fuelPct: 80,
  overallCondition: "good" as const,
  photos: [VALID_PHOTO],
  idempotencyKey: "report-key-0001",
};

describe("rentalInsurance / rentalCondition routers", () => {
  it("exposes the frozen insurance procedure keys", () => {
    expect(rentalInsuranceRouter).toBeDefined();
    expect(procedureKeys(rentalInsuranceRouter)).toEqual([
      "createTier",
      "listForOffer",
      "retireTier",
      "selectTier",
    ]);
  });

  it("exposes the frozen condition procedure keys", () => {
    expect(rentalConditionRouter).toBeDefined();
    expect(procedureKeys(rentalConditionRouter)).toEqual([
      "computeSettlement",
      "deltaReport",
      "recordReport",
    ]);
  });

  it("recordReport rejects a malformed sha256 digest", async () => {
    await expect(
      authedCaller().recordReport({
        ...VALID_REPORT,
        photos: [{ ...VALID_PHOTO, sha256Hex: "not-a-sha256" }],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("recordReport rejects a malformed idempotency key", async () => {
    await expect(
      authedCaller().recordReport({
        ...VALID_REPORT,
        idempotencyKey: "bad key!",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("recordReport rejects an empty photos array", async () => {
    await expect(
      authedCaller().recordReport({ ...VALID_REPORT, photos: [] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("recordReport rejects an unknown photo zone", async () => {
    await expect(
      authedCaller().recordReport({
        ...VALID_REPORT,
        photos: [{ ...VALID_PHOTO, zone: "undercarriage" as never }],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects unauthenticated callers before touching input", async () => {
    const anon = rentalConditionRouter.createCaller({
      req: { headers: {} },
      res: {},
      user: null,
    } as never);
    await expect(anon.recordReport(VALID_REPORT)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      anon.deltaReport({ contractId: VALID_REPORT.contractId }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("computeSettlement is operator-only (FORBIDDEN for workers)", async () => {
    await expect(
      authedCaller().computeSettlement({
        contractId: VALID_REPORT.contractId,
        damageChargeMinor: 10_000,
        fuelChargeMinor: 0,
        idempotencyKey: "settle-key-001",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("computeSettlement still validates input for operators", async () => {
    await expect(
      operatorCaller().computeSettlement({
        contractId: "not-a-uuid",
        damageChargeMinor: 10_000,
        fuelChargeMinor: 0,
        idempotencyKey: "settle-key-001",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
