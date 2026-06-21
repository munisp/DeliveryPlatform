import { beforeEach, describe, expect, it, vi } from "vitest";

type QueryResult = { rows: any[] };
type QueryHandler = (text: string, params?: any[]) => Promise<QueryResult>;

function normalizeSql(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

describe("SwitchOS finance integrity", () => {
  let queryHandler: QueryHandler;
  let poolQueryMock: ReturnType<typeof vi.fn>;
  let clientQueryMock: ReturnType<typeof vi.fn>;
  let connectMock: ReturnType<typeof vi.fn>;
  let releaseMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();

    queryHandler = vi.fn(async () => ({ rows: [] }));
    poolQueryMock = vi.fn((text: string, params?: any[]) => queryHandler(text, params));
    clientQueryMock = vi.fn((text: string, params?: any[]) => queryHandler(text, params));
    releaseMock = vi.fn();
    connectMock = vi.fn(async () => ({
      query: clientQueryMock,
      release: releaseMock,
    }));

    vi.doMock("pg", () => ({
      Pool: vi.fn(() => ({
        query: poolQueryMock,
        connect: connectMock,
      })),
    }));

    vi.doMock("drizzle-orm/node-postgres", () => ({
      drizzle: vi.fn(() => ({})),
    }));

    vi.doMock("../server/_core/env", () => ({
      ENV: {
        databaseUrl: "postgres://switchos.test/platform",
        isProduction: false,
      },
    }));
  });

  it("replays monthly settlement generation for the same idempotency key instead of creating a duplicate settlement", async () => {
    let idempotencyInserted = false;
    let storedRequestHash = "";
    const createdSettlement = {
      id: 701,
      driver_id: 11,
      total_amount: 150,
      status: "pending",
    };

    queryHandler = vi.fn(async (text: string, params?: any[]) => {
      const sql = normalizeSql(text);

      if (
        sql.includes("CREATE TABLE IF NOT EXISTS platform_idempotency_keys")
        || sql.startsWith("INSERT INTO loyalty_rewards")
        || sql.startsWith("SELECT id FROM referral_leaderboard_periods")
        || sql.startsWith("INSERT INTO referral_leaderboard_periods")
      ) {
        return { rows: [] };
      }
      if (["BEGIN", "COMMIT"].includes(sql)) {
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO platform_idempotency_keys")) {
        if (!idempotencyInserted) {
          idempotencyInserted = true;
          storedRequestHash = `${params?.[2] ?? ""}`;
          return { rows: [{ id: 1 }] };
        }
        return { rows: [] };
      }
      if (sql.includes("SELECT request_hash, status, response_payload FROM platform_idempotency_keys")) {
        return {
          rows: [{
            request_hash: storedRequestHash,
            status: "completed",
            response_payload: createdSettlement,
          }],
        };
      }
      if (sql.includes("SELECT * FROM payout_settlements WHERE driver_id = $1")) {
        return { rows: [] };
      }
      if (sql.includes("SELECT COALESCE(SUM(driver_fee), 0) as base_earnings FROM orders")) {
        return { rows: [{ base_earnings: "120" }] };
      }
      if (sql.includes("SELECT COALESCE(SUM(amount), 0) as bonus_amount FROM driver_incentives")) {
        return { rows: [{ bonus_amount: "30" }] };
      }
      if (sql.includes("INSERT INTO payout_settlements")) {
        return { rows: [createdSettlement] };
      }
      if (sql.includes("UPDATE driver_incentives SET settlement_id = $1")) {
        return { rows: [] };
      }
      if (sql.includes("UPDATE platform_idempotency_keys SET status = $3")) {
        return { rows: [] };
      }

      throw new Error(`Unexpected SQL in test: ${sql}`);
    });

    const { generateMonthlySettlement } = await import("../server/db");

    const first = await generateMonthlySettlement(11, 6, 2026, "monthly-settlement-key");
    const second = await generateMonthlySettlement(11, 6, 2026, "monthly-settlement-key");

    expect(first).toEqual(createdSettlement);
    expect(second).toEqual(createdSettlement);
    expect(clientQueryMock.mock.calls.filter(([sql]) => normalizeSql(sql).includes("INSERT INTO payout_settlements"))).toHaveLength(1);
  });

  it("blocks conflicting settlement processing payloads when an idempotency key is reused", async () => {
    let idempotencyInserted = false;
    let storedRequestHash = "";

    queryHandler = vi.fn(async (text: string, params?: any[]) => {
      const sql = normalizeSql(text);

      if (
        sql.includes("CREATE TABLE IF NOT EXISTS platform_idempotency_keys")
        || sql.startsWith("INSERT INTO loyalty_rewards")
        || sql.startsWith("SELECT id FROM referral_leaderboard_periods")
        || sql.startsWith("INSERT INTO referral_leaderboard_periods")
      ) {
        return { rows: [] };
      }
      if (["BEGIN", "ROLLBACK", "COMMIT"].includes(sql)) {
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO platform_idempotency_keys")) {
        if (!idempotencyInserted) {
          idempotencyInserted = true;
          storedRequestHash = `${params?.[2] ?? ""}`;
          return { rows: [{ id: 2 }] };
        }
        return { rows: [] };
      }
      if (sql.includes("SELECT request_hash, status, response_payload FROM platform_idempotency_keys")) {
        return {
          rows: [{
            request_hash: storedRequestHash,
            status: "completed",
            response_payload: true,
          }],
        };
      }
      if (sql.includes("SELECT id, status, payment_method, payment_reference FROM payout_settlements")) {
        return { rows: [{ id: 88, status: "approved", payment_method: null, payment_reference: null }] };
      }
      if (sql.includes("UPDATE payout_settlements SET status = 'completed'")) {
        return { rows: [{ id: 88 }] };
      }
      if (sql.includes("UPDATE driver_incentives SET status = 'paid'")) {
        return { rows: [] };
      }
      if (sql.includes("UPDATE platform_idempotency_keys SET status = $3")) {
        return { rows: [] };
      }

      throw new Error(`Unexpected SQL in test: ${sql}`);
    });

    const { processSettlement } = await import("../server/db");

    await expect(processSettlement(88, "bank_transfer", "ref-1", "process-key")).resolves.toBe(true);
    await expect(processSettlement(88, "wallet", "ref-2", "process-key")).rejects.toThrow(/Idempotency key reuse detected/);
  });

  it("includes reserve coverage and treasury drift in the funds reconciliation snapshot", async () => {
    queryHandler = vi.fn(async (text: string) => {
      const sql = normalizeSql(text);

      if (
        sql.includes("CREATE TABLE IF NOT EXISTS platform_idempotency_keys")
        || sql.startsWith("INSERT INTO loyalty_rewards")
        || sql.startsWith("SELECT id FROM referral_leaderboard_periods")
        || sql.startsWith("INSERT INTO referral_leaderboard_periods")
      ) {
        return { rows: [] };
      }
      if (sql.includes("FROM transactions")) {
        return {
          rows: [{
            transaction_count: 5,
            completed_payments: "500",
            completed_refunds: "40",
            chargeback_exposure: "120",
            chargeback_count: 2,
            pending_payout_exposure: "60",
            failed_transactions: 0,
            pending_transactions: 0,
            last_transaction_update: "2026-06-21T00:00:00.000Z",
          }],
        };
      }
      if (sql.includes("FROM payout_settlements")) {
        return {
          rows: [{
            settlement_count: 2,
            pending_settlements: "50",
            approved_settlements: "30",
            completed_settlements: "70",
            last_settlement_event: "2026-06-21T00:00:00.000Z",
          }],
        };
      }
      if (sql.includes("FROM driver_incentives")) {
        return {
          rows: [{
            approved_unsettled_incentives: "25",
            paid_incentives: "10",
            unsettled_incentive_count: 1,
            last_incentive_event: "2026-06-21T00:00:00.000Z",
          }],
        };
      }
      if (sql.includes("FROM orders")) {
        return {
          rows: [{
            cancelled_orders: 1,
            delivered_orders: 9,
            delivered_driver_fees: "95",
            last_order_event: "2026-06-21T00:00:00.000Z",
          }],
        };
      }
      if (sql.includes("FROM wallets")) {
        return {
          rows: [{
            wallet_count: 3,
            total_wallet_balance: "280",
            negative_wallets: 0,
            last_wallet_event: "2026-06-21T00:00:00.000Z",
          }],
        };
      }
      if (sql.includes("FROM support_tickets")) {
        return {
          rows: [{
            open_dispute_like_tickets: 1,
            critical_dispute_tickets: 0,
            last_dispute_event: "2026-06-21T00:00:00.000Z",
          }],
        };
      }
      if (sql.includes("FROM merchant_reserves") && sql.includes("FROM treasury_reserves")) {
        return {
          rows: [{
            merchant_reserves_held: "70",
            treasury_reserves_held: "20",
            merchant_reserve_entries: 2,
            treasury_reserve_entries: 1,
            last_reserve_event: "2026-06-21T00:00:00.000Z",
          }],
        };
      }

      throw new Error(`Unexpected SQL in test: ${sql}`);
    });

    const { getFundsReconciliationSnapshot } = await import("../server/db");
    const snapshot = await getFundsReconciliationSnapshot();

    expect(snapshot?.reserves).toMatchObject({
      merchant_reserves_held: 70,
      treasury_reserves_held: 20,
      total_reserves_held: 90,
      merchant_reserve_entries: 2,
      treasury_reserve_entries: 1,
    });
    expect(snapshot?.derived).toMatchObject({
      net_collected: 340,
      treasury_drift: -60,
      reserve_coverage_gap: 30,
    });
    expect(snapshot?.recommendation).toMatch(/reserve coverage/i);
  });
});
