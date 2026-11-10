/**
 * Settlement dispute wave (drizzle/0097) — unit + static tests.
 *
 * Covers:
 *   1. server/rental/disputes.ts — pure decision helpers (adjustment ceiling,
 *      overflow guard, decision shape).
 *   2. drizzle/0097_settlement_disputes.sql — static assertions in the style of
 *      tests/rental-condition-insurance.test.ts.
 *   3. server/rental/disputes.ts — router shape and zod-level input validation
 *      via createCaller with a fake ctx (no database touched: validation rejects
 *      before any resolver runs).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  decisionRequiresAdjustment,
  maxDisputeAdjustmentMinor,
  rentalDisputeRouter,
} from "../server/rental/disputes";

// ---------------------------------------------------------------------------
// Pure decision helpers
// ---------------------------------------------------------------------------
describe("decisionRequiresAdjustment", () => {
  it("requires an adjustment only for 'adjusted'", () => {
    expect(decisionRequiresAdjustment("adjusted")).toBe(true);
    expect(decisionRequiresAdjustment("upheld")).toBe(false);
    expect(decisionRequiresAdjustment("rejected")).toBe(false);
  });
});

describe("maxDisputeAdjustmentMinor", () => {
  it("sums renter damage liability and excess-km charge", () => {
    expect(maxDisputeAdjustmentMinor(50_000, 12_500)).toBe(62_500);
  });

  it("allows zero disputable total", () => {
    expect(maxDisputeAdjustmentMinor(0, 0)).toBe(0);
  });

  it("throws RangeError when the total is not a safe integer", () => {
    expect(() =>
      maxDisputeAdjustmentMinor(Number.MAX_SAFE_INTEGER, 1),
    ).toThrow(RangeError);
    expect(() =>
      maxDisputeAdjustmentMinor(2 ** 53, 2 ** 53),
    ).toThrow(/exceeds bigint range/);
  });
});

// ---------------------------------------------------------------------------
// Migration static assertions (drizzle/0097), config-test style
// ---------------------------------------------------------------------------
const root = resolve(import.meta.dirname, "..");
const migration = readFileSync(
  resolve(root, "drizzle/0097_settlement_disputes.sql"),
  "utf8",
);

describe("drizzle/0097_settlement_disputes.sql", () => {
  it("creates the settlement_dispute table", () => {
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS vehicle_access.settlement_dispute",
    );
  });

  it("creates the two enums with the frozen value lists", () => {
    expect(migration).toContain(
      "CREATE TYPE vehicle_access.dispute_status AS ENUM ('open','upheld','rejected','adjusted')",
    );
    expect(migration).toContain(
      "CREATE TYPE vehicle_access.dispute_reason AS ENUM ('damage_charge','excess_km_charge','fuel_charge','odometer_dispute','other')",
    );
  });

  it("creates both enums behind duplicate_object guards", () => {
    expect(migration.match(/EXCEPTION WHEN duplicate_object THEN NULL/g)).toHaveLength(2);
  });

  it("creates the four SECURITY DEFINER authority functions", () => {
    for (const fn of [
      "open_settlement_dispute",
      "decide_settlement_dispute",
      "list_settlement_disputes",
      "get_settlement_dispute",
    ]) {
      expect(migration).toContain(
        `CREATE OR REPLACE FUNCTION vehicle_access.${fn}`,
      );
    }
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain("SET search_path = pg_catalog, vehicle_access");
  });

  it("enforces one open dispute per contract via a partial unique index", () => {
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX[^;]*settlement_dispute\(contract_id\)\s*WHERE status = 'open'/i,
    );
  });

  it("enforces the idempotency key regex and global uniqueness", () => {
    expect(migration).toContain(
      "idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'",
    );
    expect(migration).toContain("UNIQUE (idempotency_key)");
    // Every function validates the key regex before writing.
    const validations = migration.match(
      /p_key !~ '\^\[A-Za-z0-9\]\[A-Za-z0-9\._:-\]\{7,127\}\$'/g,
    );
    expect(validations).not.toBeNull();
    expect(validations!.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps settlement_dispute a mutable decision table (0058 extension-request precedent)", () => {
    // Option (a): no append-only trigger — the trigger raises on EVERY
    // UPDATE/DELETE, and decide_settlement_dispute must UPDATE status/decided_*.
    expect(migration).not.toMatch(
      /CREATE TRIGGER[^;]*settlement_dispute[^;]*prevent_rental_operations_mutation/i,
    );
    expect(migration).toContain("status = 'open'");
    expect(migration).toContain("decided_by");
    expect(migration).toContain("decided_at");
  });

  it("extends the aggregate_type CHECK with 'settlement_dispute'", () => {
    expect(migration).toContain(
      "DROP CONSTRAINT IF EXISTS rental_operations_event_aggregate_type_check",
    );
    expect(migration).toContain("'settlement_dispute'");
  });

  it("gates decisions behind is_operator and the dispute_not_open guard", () => {
    expect(migration).toContain("vehicle_access.is_operator(p_actor)");
    expect(migration).toContain("'dispute_not_open'");
  });

  it("caps adjustments at renter damage liability plus excess-km charge", () => {
    expect(migration).toContain(
      "v_settlement.renter_damage_liability_minor + v_settlement.excess_km_charge_minor",
    );
    expect(migration).toContain("'adjustment exceeds disputable charge total'");
  });

  it("emits dual-channel events on open and decide", () => {
    for (const event of [
      "vehicle_access.settlement_dispute.opened",
      "vehicle_access.settlement_dispute.decided",
    ]) {
      expect(migration).toContain(event);
    }
    expect(migration).toContain("vehicle_access.append_rental_operations_event");
    expect(migration).toContain("vehicle_access.append_event");
    expect(migration).toContain("vehicle_access.enqueue_event");
  });

  it("marks money movement as out of scope in the decision event", () => {
    expect(migration).toContain(
      "out_of_scope_operator_applies_via_financial_ops",
    );
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
  return rentalDisputeRouter.createCaller({
    req: { headers: {} },
    res: {},
    user: { id: userId, name: "Rental Worker", role: "user" },
  } as never);
}

function operatorCaller(userId = 1) {
  return rentalDisputeRouter.createCaller({
    req: { headers: {} },
    res: {},
    user: { id: userId, name: "Ops", role: "operator" },
  } as never);
}

const VALID_OPEN = {
  contractId: "2b1b6c3e-9f4d-4a3f-9b8d-0d2f6a1c5e77",
  reason: "damage_charge" as const,
  detail: "The charged scratch existed before check-out.",
  idempotencyKey: "dispute-key-0001",
};

const VALID_DECIDE = {
  disputeId: "6f0b2a4d-3d1c-4e5a-9c8b-7a6d5e4f3c21",
  status: "adjusted" as const,
  adjustmentMinor: 12_500,
  operatorNote: "Partial adjustment applied via financial ops.",
  idempotencyKey: "decide-key-0001",
};

describe("rentalDispute router", () => {
  it("exposes the frozen procedure keys", () => {
    expect(rentalDisputeRouter).toBeDefined();
    expect(procedureKeys(rentalDisputeRouter)).toEqual([
      "decide",
      "get",
      "list",
      "open",
    ]);
  });

  it("open rejects a malformed idempotency key", async () => {
    await expect(
      authedCaller().open({ ...VALID_OPEN, idempotencyKey: "bad key!" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("open rejects a detail shorter than 10 characters", async () => {
    await expect(
      authedCaller().open({ ...VALID_OPEN, detail: "too short" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("open rejects an unknown dispute reason", async () => {
    await expect(
      authedCaller().open({ ...VALID_OPEN, reason: "vibes" as never }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects unauthenticated callers before touching input", async () => {
    const anon = rentalDisputeRouter.createCaller({
      req: { headers: {} },
      res: {},
      user: null,
    } as never);
    await expect(anon.open(VALID_OPEN)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      anon.get({ disputeId: VALID_DECIDE.disputeId }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(anon.list({})).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("decide is operator-only (FORBIDDEN for renters)", async () => {
    await expect(authedCaller().decide(VALID_DECIDE)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("decide rejects 'open' as a decision at the zod level", async () => {
    await expect(
      operatorCaller().decide({ ...VALID_DECIDE, status: "open" as never }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("decide still validates input for operators", async () => {
    await expect(
      operatorCaller().decide({ ...VALID_DECIDE, disputeId: "not-a-uuid" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      operatorCaller().decide({ ...VALID_DECIDE, adjustmentMinor: -5 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      operatorCaller().decide({
        ...VALID_DECIDE,
        operatorNote: "x".repeat(2001),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("list rejects an out-of-range limit", async () => {
    await expect(
      authedCaller().list({ limit: 0 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      authedCaller().list({ limit: 201 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
