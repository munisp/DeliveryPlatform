import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Perf wave W1 (audit findings 6 + 14):
 * - getFundsReconciliationSnapshot: history legs bounded to a trailing
 *   window + whole-snapshot 60s in-process TTL cache.
 * - sendCampaignToAudience: LIMIT/OFFSET audience paging + 202-style queued
 *   default response (awaitCompletion mode for synchronous callers/tests).
 */

type QueryResult = { rows: any[]; rowCount?: number };
type QueryHandler = (text: string, params?: any[]) => Promise<QueryResult>;

function normalizeSql(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

const sendEmailMock = vi.hoisted(() => vi.fn(async () => ({ accepted: true })));
const sendSMSMock = vi.hoisted(() => vi.fn(async () => ({ accepted: true })));

describe("W1 db hot paths", () => {
  let queryHandler: QueryHandler;
  let poolQueryMock: ReturnType<typeof vi.fn>;
  let clientQueryMock: ReturnType<typeof vi.fn>;
  let connectMock: ReturnType<typeof vi.fn>;
  let releaseMock: ReturnType<typeof vi.fn>;
  let poolConstructorMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    sendEmailMock.mockClear();
    sendSMSMock.mockClear();

    queryHandler = vi.fn(async () => ({ rows: [] }));
    poolQueryMock = vi.fn((text: string, params?: any[]) => queryHandler(text, params));
    clientQueryMock = vi.fn((text: string, params?: any[]) => queryHandler(text, params));
    releaseMock = vi.fn();
    connectMock = vi.fn(async () => ({ query: clientQueryMock, release: releaseMock }));
    poolConstructorMock = vi.fn(() => ({
      query: poolQueryMock,
      connect: connectMock,
    }));

    vi.doMock("pg", () => ({ Pool: poolConstructorMock }));
    vi.doMock("drizzle-orm/node-postgres", () => ({ drizzle: vi.fn(() => ({})) }));
    // isProduction: true skips ensurePlatformTables DDL so query counts only
    // reflect the function under test.
    vi.doMock("../server/_core/env", () => ({
      ENV: {
        databaseUrl: "postgres://switchos.test/platform",
        isProduction: true,
      },
    }));
    vi.doMock("../server/_core/notificationGateway", () => ({
      sendEmail: sendEmailMock,
      sendSMS: sendSMSMock,
    }));
  });

  function snapshotQueryCalls() {
    return poolQueryMock.mock.calls.filter(([text]: [string]) =>
      /last_transaction_update|last_settlement_event|last_incentive_event|last_order_event|last_wallet_event|last_dispute_event|last_reserve_event|last_mojaloop_event/.test(text),
    );
  }

  describe("getFundsReconciliationSnapshot", () => {
    beforeEach(() => {
      // W6: the snapshot probes the catalog for driver_incentives before
      // running its history legs. Production has no such table (no DDL
      // anywhere in-repo), so model it as absent: 7 history legs + 1
      // catalog probe per compute. The probe query does not match the
      // last_*_event filter in snapshotQueryCalls().
      queryHandler = vi.fn(async (text: string) => {
        if (text.includes("to_regclass('public.driver_incentives')")) {
          return { rows: [{ t: null }] };
        }
        return { rows: [{}] };
      });
    });

    it("bounds history legs to a trailing window and reports window_days", async () => {
      // FUNDS_SNAPSHOT_DEFAULT_WINDOW_DAYS is intentionally module-private
      // (code-health export-count guard); pin the literal here.
      const DEFAULT_WINDOW_DAYS = 365;
      const { getFundsReconciliationSnapshot } = await import("../server/db");
      const snapshot = await getFundsReconciliationSnapshot();

      expect(snapshot?.window_days).toBe(DEFAULT_WINDOW_DAYS);
      const calls = snapshotQueryCalls();
      expect(calls).toHaveLength(7);

      const windowedTables = [
        "FROM transactions",
        "FROM payout_settlements",
        "FROM orders",
        "FROM support_tickets",
        "FROM mojaloop_transfers",
      ];
      for (const table of windowedTables) {
        const call = calls.find(([text]: [string]) => text.includes(table));
        expect(call, table).toBeDefined();
        expect(call?.[0]).toContain("created_at >= now() - ($1 || ' days')::interval");
        expect(call?.[1]).toEqual([DEFAULT_WINDOW_DAYS]);
      }

      // W6: with driver_incentives absent (probe returned null), the
      // incentive leg is skipped entirely — no driver_incentives query.
      expect(
        calls.find(([text]: [string]) => text.includes("FROM driver_incentives")),
      ).toBeUndefined();
      // …but the catalog probe ran exactly once for this compute.
      expect(
        poolQueryMock.mock.calls.filter(([text]: [string]) =>
          text.includes("to_regclass('public.driver_incentives')"),
        ),
      ).toHaveLength(1);

      // Point-in-time state legs stay unbounded (no window predicate).
      const walletCall = calls.find(([text]: [string]) => text.includes("FROM wallets"));
      expect(walletCall?.[0]).not.toContain("days')::interval");
      const reserveCall = calls.find(([text]: [string]) => text.includes("FROM merchant_reserves"));
      expect(reserveCall?.[0]).not.toContain("days')::interval");
    });

    it("runs the windowed incentive leg when driver_incentives exists", async () => {
      // W6: when the catalog probe reports the table present, the snapshot
      // executes the real incentive leg (8 history legs total), bounded to
      // the same trailing window as the other history legs.
      queryHandler = vi.fn(async (text: string) => {
        if (text.includes("to_regclass('public.driver_incentives')")) {
          return { rows: [{ t: "driver_incentives" }] };
        }
        return { rows: [{}] };
      });
      const { getFundsReconciliationSnapshot } = await import("../server/db");
      await getFundsReconciliationSnapshot();

      const calls = snapshotQueryCalls();
      expect(calls).toHaveLength(8);
      const incentiveCall = calls.find(([text]: [string]) =>
        text.includes("FROM driver_incentives"),
      );
      expect(incentiveCall).toBeDefined();
      expect(incentiveCall?.[0]).toContain("created_at >= now() - ($1 || ' days')::interval");
      expect(incentiveCall?.[1]).toEqual([365]);
    });

    it("serves the identical snapshot from the 60s cache without new queries", async () => {
      const { getFundsReconciliationSnapshot } = await import("../server/db");

      const first = await getFundsReconciliationSnapshot();
      const callsAfterFirst = snapshotQueryCalls().length;
      expect(callsAfterFirst).toBe(7);

      const second = await getFundsReconciliationSnapshot();
      expect(second).toBe(first);
      expect(snapshotQueryCalls()).toHaveLength(callsAfterFirst);
    });

    it("refreshes after invalidation, forceRefresh, TTL expiry, or a window change", async () => {
      // FUNDS_SNAPSHOT_CACHE_TTL_MS is intentionally module-private
      // (code-health export-count guard); pin the literal here.
      const CACHE_TTL_MS = 60_000;
      const {
        getFundsReconciliationSnapshot,
        invalidateFundsReconciliationSnapshotCache,
      } = await import("../server/db");

      await getFundsReconciliationSnapshot();
      expect(snapshotQueryCalls()).toHaveLength(7);

      invalidateFundsReconciliationSnapshotCache();
      await getFundsReconciliationSnapshot();
      expect(snapshotQueryCalls()).toHaveLength(14);

      await getFundsReconciliationSnapshot({ forceRefresh: true });
      expect(snapshotQueryCalls()).toHaveLength(21);

      // TTL expiry: advance the clock beyond the TTL.
      vi.useFakeTimers();
      try {
        vi.setSystemTime(Date.now() + CACHE_TTL_MS + 1000);
        await getFundsReconciliationSnapshot();
        expect(snapshotQueryCalls()).toHaveLength(28);
      } finally {
        vi.useRealTimers();
      }

      // A different window is a different cache entry.
      await getFundsReconciliationSnapshot({ windowDays: 30 });
      expect(snapshotQueryCalls()).toHaveLength(35);
    });

    it("does not cache failures", async () => {
      let failures = 1;
      queryHandler = vi.fn(async (text: string) => {
        if (text.includes("to_regclass('public.driver_incentives')")) {
          return { rows: [{ t: null }] };
        }
        if (failures > 0 && text.includes("FROM wallets")) {
          failures -= 1;
          throw new Error("wallet aggregate query failed");
        }
        return { rows: [{}] };
      });

      const { getFundsReconciliationSnapshot } = await import("../server/db");
      await expect(getFundsReconciliationSnapshot()).rejects.toThrow("wallet aggregate query failed");
      // The failed result must not be cached: the next call recomputes.
      const snapshot = await getFundsReconciliationSnapshot();
      expect(snapshot).not.toBeNull();
      expect(snapshotQueryCalls().length).toBeGreaterThanOrEqual(14);
    });

    it("sets a server-side statement_timeout on the pool", async () => {
      const { getFundsReconciliationSnapshot } = await import("../server/db");
      await getFundsReconciliationSnapshot();
      expect(poolConstructorMock).toHaveBeenCalledWith(
        expect.objectContaining({
          max: 20,
          options: expect.stringContaining("statement_timeout=15000"),
        }),
      );
    });
  });

  describe("sendCampaignToAudience", () => {
    const campaign = {
      id: 9,
      campaign_name: "W1 Campaign",
      is_active: true,
      target_audience: "all",
      email_template: "Hello {{name}}",
      sms_template: null,
    };

    function campaignHandler(totalUsers: number): QueryHandler {
      let sendRecordId = 0;
      return vi.fn(async (text: string, params?: any[]) => {
        const sql = normalizeSql(text);
        if (sql.startsWith("CREATE TABLE") || sql.startsWith("BEGIN") || sql.startsWith("COMMIT")) {
          return { rows: [] };
        }
        if (sql.startsWith("SELECT * FROM marketing_campaigns WHERE id")) {
          return { rows: [campaign] };
        }
        if (sql.startsWith("SELECT COUNT(*)::int AS total FROM users")) {
          return { rows: [{ total: totalUsers }] };
        }
        const pageMatch = sql.match(/^SELECT id FROM users .* ORDER BY id LIMIT \$(\d+) OFFSET \$(\d+)$/);
        if (pageMatch) {
          const limit = Number(params?.[Number(pageMatch[1]) - 1]);
          const offset = Number(params?.[Number(pageMatch[2]) - 1]);
          const ids = Array.from(
            { length: Math.max(0, Math.min(limit, totalUsers - offset)) },
            (_, index) => ({ id: offset + index + 1 }),
          );
          return { rows: ids };
        }
        if (sql.startsWith("INSERT INTO platform_idempotency_keys")) {
          return { rows: [{ id: 1 }] };
        }
        if (sql.startsWith("SELECT * FROM users WHERE id")) {
          const id = params?.[0];
          return { rows: [{ id, name: `User ${id}`, email: `user-${id}@example.com`, phone: null }] };
        }
        if (sql.startsWith("SELECT tier, points_balance FROM loyalty_points")) {
          return { rows: [] };
        }
        if (sql.startsWith("INSERT INTO campaign_sends")) {
          sendRecordId += 1;
          return { rows: [{ id: sendRecordId, status: "pending" }] };
        }
        if (sql.startsWith("UPDATE campaign_sends")) {
          return { rows: [{ id: sendRecordId, status: "sent" }] };
        }
        if (sql.startsWith("UPDATE marketing_campaigns")) {
          return { rows: [] };
        }
        if (sql.startsWith("UPDATE platform_idempotency_keys")) {
          return { rows: [] };
        }
        throw new Error(`Unexpected SQL in test: ${sql}`);
      });
    }

    it("pages the audience with LIMIT/OFFSET 500 and sends per page (awaitCompletion)", async () => {
      queryHandler = campaignHandler(1200);
      const { sendCampaignToAudience, CAMPAIGN_AUDIENCE_PAGE_SIZE } = await import("../server/db");

      const result = await sendCampaignToAudience(9, "w1-campaign-key", { awaitCompletion: true });

      expect(CAMPAIGN_AUDIENCE_PAGE_SIZE).toBe(500);
      expect(result).toMatchObject({
        status: "completed",
        campaign_id: 9,
        total: 1200,
        page_size: 500,
        sent: 1200,
        failed: 0,
      });

      const pageCalls = poolQueryMock.mock.calls.filter(([text]: [string]) =>
        /^SELECT id FROM users .* ORDER BY id LIMIT/.test(normalizeSql(text)),
      );
      expect(pageCalls).toHaveLength(3);
      expect(pageCalls.map((call: [string, any[]]) => call[1])).toEqual([
        [500, 0],
        [500, 500],
        [500, 1000],
      ]);
      expect(sendEmailMock).toHaveBeenCalledTimes(1200);
    });

    it("returns a 202-style queued response immediately by default", async () => {
      queryHandler = campaignHandler(3);
      const { sendCampaignToAudience } = await import("../server/db");

      const result = await sendCampaignToAudience(9, "w1-campaign-key");

      expect(result).toEqual({
        status: "queued",
        campaign_id: 9,
        total: 3,
        page_size: 500,
        sent: 0,
        failed: 0,
      });

      // The background dispatch still delivers every paged send.
      await vi.waitFor(() => {
        expect(sendEmailMock).toHaveBeenCalledTimes(3);
      });
    });

    it("scopes tier audiences and rejects unknown/inactive campaigns", async () => {
      const tierCampaign = { ...campaign, id: 10, target_audience: "gold" };
      queryHandler = vi.fn(async (text: string, params?: any[]) => {
        const sql = normalizeSql(text);
        if (sql.startsWith("SELECT * FROM marketing_campaigns WHERE id")) {
          return { rows: [params?.[0] === 10 ? tierCampaign : { ...campaign, is_active: false }] };
        }
        if (sql.startsWith("SELECT COUNT(*)::int AS total FROM users")) {
          expect(sql).toContain("id IN (SELECT user_id FROM loyalty_points WHERE tier = $1)");
          expect(params).toEqual(["gold"]);
          return { rows: [{ total: 0 }] };
        }
        if (sql.startsWith("SELECT id FROM users")) return { rows: [] };
        return { rows: [] };
      });
      const { sendCampaignToAudience } = await import("../server/db");

      const queued = await sendCampaignToAudience(10, "w1-tier-key", { awaitCompletion: true });
      expect(queued).toMatchObject({ status: "completed", total: 0, sent: 0, failed: 0 });

      await expect(sendCampaignToAudience(11, "w1-inactive-key")).rejects.toThrow(
        "Campaign not found or inactive",
      );
    });
  });
});
