/**
 * Settlement / refund / funds-aggregate audit tests (S-1, S-3, S-4, S-5, S-6).
 *
 * The TZ tests pin a non-UTC server timezone: settlement windows must be UTC
 * half-open intervals [period_start, period_end) regardless of the host TZ.
 */
process.env.TZ = "America/New_York";

import { beforeEach, describe, expect, it, vi } from "vitest";

type QueryResult = { rows: any[] };
type QueryHandler = (text: string, params?: any[]) => Promise<QueryResult>;

function normalizeSql(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function installPoolMock() {
  const state = {
    handler: (async () => ({ rows: [] })) as QueryHandler,
    clientQueryMock: null as any,
    poolQueryMock: null as any,
  };
  const poolQueryMock = vi.fn((text: string, params?: any[]) => state.handler(text, params));
  const clientQueryMock = vi.fn((text: string, params?: any[]) => state.handler(text, params));
  const releaseMock = vi.fn();
  const connectMock = vi.fn(async () => ({ query: clientQueryMock, release: releaseMock }));

  vi.doMock("pg", () => ({
    Pool: vi.fn(() => ({ query: poolQueryMock, connect: connectMock })),
  }));
  vi.doMock("drizzle-orm/node-postgres", () => ({ drizzle: vi.fn(() => ({})) }));
  vi.doMock("../server/_core/env", () => ({
    ENV: { databaseUrl: "postgres://switchos.test/platform", isProduction: false },
  }));

  state.clientQueryMock = clientQueryMock;
  state.poolQueryMock = poolQueryMock;
  return state;
}

const passthroughPrefixes = [
  "CREATE TABLE IF NOT EXISTS platform_idempotency_keys",
  "INSERT INTO loyalty_rewards",
  "SELECT id FROM referral_leaderboard_periods",
  "INSERT INTO referral_leaderboard_periods",
];

function isPassthrough(sql: string) {
  return ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)
    || sql.includes("pg_advisory_xact_lock")
    || passthroughPrefixes.some((prefix) => sql.includes(prefix));
}

describe("settlement audit fixes", () => {
  let state: ReturnType<typeof installPoolMock>;

  beforeEach(() => {
    vi.resetModules();
    state = installPoolMock();
  });

  it("S-1: a concurrent double-settle attempt produces a single payout leg", async () => {
    const createdSettlement = {
      id: 901,
      driver_id: 42,
      period_start: "2026-06-01T00:00:00.000Z",
      period_end: "2026-07-01T00:00:00.000Z",
      total_amount: "150",
      status: "pending",
    };
    let settlementRow: any = null;

    state.handler = vi.fn(async (text: string, params?: any[]) => {
      const sql = normalizeSql(text);
      if (isPassthrough(sql)) return { rows: [] };
      if (sql.includes("INSERT INTO platform_idempotency_keys")) return { rows: [{ id: 1 }] };
      if (sql.includes("SELECT * FROM payout_settlements WHERE driver_id = $1")) {
        if (sql.includes("FOR UPDATE")) {
          // Pre-insert existence check: simulate the race window in which the
          // concurrent winner has not committed yet.
          return { rows: [] };
        }
        // Post-conflict re-read: the winner's row is now visible.
        return { rows: settlementRow ? [settlementRow] : [] };
      }
      if (sql.includes("FROM orders")) return { rows: [{ base_earnings: "120" }] };
      if (sql.includes("FROM driver_incentives") && sql.startsWith("SELECT")) {
        return { rows: [{ bonus_amount: "30" }] };
      }
      if (sql.includes("INSERT INTO payout_settlements")) {
        expect(sql).toContain("ON CONFLICT (driver_id, period_start, period_end) DO NOTHING");
        if (!settlementRow) {
          settlementRow = createdSettlement;
          return { rows: [createdSettlement] };
        }
        // Unique-index conflict: the losing concurrent worker inserts nothing.
        return { rows: [] };
      }
      if (sql.includes("UPDATE driver_incentives SET settlement_id = $1")) return { rows: [] };
      if (sql.includes("UPDATE platform_idempotency_keys")) return { rows: [] };
      throw new Error(`Unexpected SQL in test: ${sql}`);
    });

    const { generateMonthlySettlement } = await import("../server/db");

    const first = await generateMonthlySettlement(42, 6, 2026);
    const second = await generateMonthlySettlement(42, 6, 2026);

    expect(first).toEqual(createdSettlement);
    // The losing attempt settles to the same single payout row.
    expect(second).toEqual(createdSettlement);
    // Exactly one payout leg: the incentive-claiming UPDATE ran once.
    const incentiveClaims = state.clientQueryMock.mock.calls.filter(([sql]: [string]) =>
      normalizeSql(sql).includes("UPDATE driver_incentives SET settlement_id = $1"));
    expect(incentiveClaims).toHaveLength(1);
    // Both attempts took the transaction-scoped advisory lock.
    const lockCalls = state.clientQueryMock.mock.calls.filter(([sql]: [string]) =>
      normalizeSql(sql).includes("pg_advisory_xact_lock"));
    expect(lockCalls).toHaveLength(2);
    expect(String(lockCalls[0][1][0])).toContain("settlement:42:");
  });

  it("S-2: settlement aggregation queries no longer carry FOR UPDATE", async () => {
    state.handler = vi.fn(async (text: string) => {
      const sql = normalizeSql(text);
      if (isPassthrough(sql)) return { rows: [] };
      if (sql.includes("INSERT INTO platform_idempotency_keys")) return { rows: [{ id: 1 }] };
      if (sql.includes("SELECT * FROM payout_settlements WHERE driver_id = $1")) return { rows: [] };
      if (sql.includes("FROM orders") && sql.startsWith("SELECT")) {
        expect(sql).not.toContain("FOR UPDATE");
        return { rows: [{ base_earnings: "0" }] };
      }
      if (sql.includes("FROM driver_incentives") && sql.startsWith("SELECT")) {
        expect(sql).not.toContain("FOR UPDATE");
        return { rows: [{ bonus_amount: "0" }] };
      }
      if (sql.includes("INSERT INTO payout_settlements")) return { rows: [{ id: 1 }] };
      if (sql.includes("UPDATE driver_incentives")) return { rows: [] };
      if (sql.includes("UPDATE platform_idempotency_keys")) return { rows: [] };
      throw new Error(`Unexpected SQL in test: ${sql}`);
    });

    const { generateMonthlySettlement } = await import("../server/db");
    await generateMonthlySettlement(7, 1, 2026);
  });

  it("S-3: settlement windows are UTC half-open intervals under a non-UTC server TZ", async () => {
    expect(process.env.TZ).toBe("America/New_York");
    const { computeSettlementPeriodUtc } = await import("../server/db");

    const { periodStart, periodEnd } = computeSettlementPeriodUtc(6, 2026);
    // Under server-local Date math (old code) with TZ=America/New_York these
    // would be 2026-06-01T04:00:00.000Z and 2026-06-30T04:00:00.000Z.
    expect(periodStart.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(periodEnd.toISOString()).toBe("2026-07-01T00:00:00.000Z");

    const december = computeSettlementPeriodUtc(12, 2026);
    expect(december.periodStart.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(december.periodEnd.toISOString()).toBe("2027-01-01T00:00:00.000Z");

    expect(() => computeSettlementPeriodUtc(13, 2026)).toThrow();
    expect(() => computeSettlementPeriodUtc(0, 2026)).toThrow();
  });

  it("S-3: generateMonthlySettlement queries with UTC half-open bounds", async () => {
    let earningsParams: any[] | null = null;
    let earningsSql = "";
    state.handler = vi.fn(async (text: string, params?: any[]) => {
      const sql = normalizeSql(text);
      if (isPassthrough(sql)) return { rows: [] };
      if (sql.includes("INSERT INTO platform_idempotency_keys")) return { rows: [{ id: 1 }] };
      if (sql.includes("SELECT * FROM payout_settlements WHERE driver_id = $1")) return { rows: [] };
      if (sql.includes("FROM orders") && sql.startsWith("SELECT")) {
        earningsSql = sql;
        earningsParams = params ?? [];
        return { rows: [{ base_earnings: "0" }] };
      }
      if (sql.includes("FROM driver_incentives") && sql.startsWith("SELECT")) return { rows: [{ bonus_amount: "0" }] };
      if (sql.includes("INSERT INTO payout_settlements")) return { rows: [{ id: 1 }] };
      if (sql.includes("UPDATE driver_incentives")) return { rows: [] };
      if (sql.includes("UPDATE platform_idempotency_keys")) return { rows: [] };
      throw new Error(`Unexpected SQL in test: ${sql}`);
    });

    const { generateMonthlySettlement } = await import("../server/db");
    await generateMonthlySettlement(9, 3, 2026);

    expect(earningsSql).toContain("actual_delivery_time >= $2");
    expect(earningsSql).toContain("actual_delivery_time < $3");
    expect(earningsSql).not.toContain("<= $3");
    expect((earningsParams![1] as Date).toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect((earningsParams![2] as Date).toISOString()).toBe("2026-04-01T00:00:00.000Z");
  });

  it("S-4/S-5: a retried refund cannot double-credit and notification stays in the same transaction", async () => {
    const refundTxn = {
      id: 555,
      transaction_id: "refund-key-1",
      order_id: 77,
      type: "refund",
      amount: "25.00",
      status: "completed",
    };
    let refundInserted = false;
    const outboxWrites: any[] = [];
    const orderUpdates: any[] = [];

    state.handler = vi.fn(async (text: string, params?: any[]) => {
      const sql = normalizeSql(text);
      if (isPassthrough(sql)) return { rows: [] };
      if (sql.includes("INSERT INTO platform_idempotency_keys")) return { rows: [{ id: 1 }] };
      if (sql.includes("SELECT id, customer_id, status FROM orders WHERE id = $1 FOR UPDATE")) {
        return { rows: [{ id: 77, customer_id: 500, status: refundInserted ? "refunded" : "delivered" }] };
      }
      if (sql.includes("INSERT INTO transactions")) {
        expect(sql).toContain("ON CONFLICT (transaction_id) DO NOTHING");
        if (!refundInserted) {
          refundInserted = true;
          return { rows: [refundTxn] };
        }
        return { rows: [] };
      }
      if (sql.includes("SELECT * FROM transactions WHERE transaction_id = $1")) {
        return { rows: [refundTxn] };
      }
      if (sql.includes("UPDATE orders SET status = 'refunded'")) {
        orderUpdates.push(params);
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO mojaloop_funds_outbox")) {
        expect(sql).toContain("ON CONFLICT (destination, idempotency_key) DO NOTHING");
        outboxWrites.push(params);
        return { rows: [] };
      }
      if (sql.includes("UPDATE platform_idempotency_keys")) return { rows: [] };
      throw new Error(`Unexpected SQL in test: ${sql}`);
    });

    const { refundOrderPayment, deriveRefundIdempotencyKey } = await import("../server/db");

    const first = await refundOrderPayment(77, 25, "missing item", "refund-key-1");
    const second = await refundOrderPayment(77, 25, "missing item", "refund-key-1");

    expect(first).toEqual(refundTxn);
    // Retry replays the original refund row; it does not credit again.
    expect(second).toEqual(refundTxn);
    expect(orderUpdates).toHaveLength(1);
    // Notification event written to the outbox exactly once, inside the tx.
    expect(outboxWrites).toHaveLength(1);
    expect(String(outboxWrites[0][1])).toContain("refund-notify:");
    const payload = JSON.parse(outboxWrites[0][4]);
    expect(payload).toMatchObject({ orderId: 77, customerId: 500, amount: "25.00", notificationType: "refund_completed" });

    // Derived key is deterministic from order + amount + reason.
    expect(deriveRefundIdempotencyKey(77, "25.00", "missing item"))
      .toBe(deriveRefundIdempotencyKey(77, "25.00", "missing item"));
    expect(deriveRefundIdempotencyKey(77, "25.00", "missing item"))
      .not.toBe(deriveRefundIdempotencyKey(77, "26.00", "missing item"));
  });

  it("S-6: funds reconciliation snapshot propagates aggregate failures instead of returning zeros", async () => {
    state.handler = vi.fn(async (text: string) => {
      const sql = normalizeSql(text);
      if (isPassthrough(sql)) return { rows: [] };
      if (sql.includes("FROM wallets")) {
        throw new Error("wallet aggregate query failed");
      }
      const zeroRow: Record<string, unknown> = {};
      return { rows: [zeroRow] };
    });

    const { getFundsReconciliationSnapshot } = await import("../server/db");
    await expect(getFundsReconciliationSnapshot()).rejects.toThrow("wallet aggregate query failed");
  });
});
