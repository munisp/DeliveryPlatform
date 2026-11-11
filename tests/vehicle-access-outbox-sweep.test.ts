import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Settlement dispute notification wave: vehicle_access.outbox_event finally
 * has a consumer. vehicleAccessOutboxSweepJob claims a batch through the
 * SECURITY DEFINER vehicle_access.claim_outbox_events (the schema revokes
 * table access from PUBLIC), notifies operators when a dispute is opened and
 * the renter when it is decided, fail-open per send, and skips unknown event
 * types so newer events stay forward-compatible.
 */

const dbMocks = vi.hoisted(() => ({
  getPool: vi.fn(),
  closeLeaderboardPeriod: vi.fn(),
  createEmailDigest: vi.fn(),
  generateWeeklyDigest: vi.fn(),
  markDigestAsSent: vi.fn(),
  selectWinningVariant: vi.fn(),
}));

const gatewayMocks = vi.hoisted(() => ({
  sendEmail: vi.fn(async () => ({ accepted: true })),
  sendSMS: vi.fn(async () => ({ accepted: true })),
}));

const dispatcherMocks = vi.hoisted(() => ({
  dispatchDeveloperWebhooks: vi.fn(async () => ({
    published: 0,
    claimed: 0,
    delivered: 0,
    retried: 0,
  })),
}));

vi.mock("../server/db", () => dbMocks);
vi.mock("../server/_core/notificationGateway", () => gatewayMocks);
vi.mock("../server/_core/developerWebhookDispatcher", () => dispatcherMocks);

import { jobs, vehicleAccessOutboxSweepJob } from "../server/_core/scheduledJobs";

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

const CONTRACT_ID = "11111111-1111-1111-1111-111111111111";

const openedEvent = {
  id: "evt-open-1",
  aggregate_id: CONTRACT_ID,
  event_type: "vehicle_access.contract.settlement_dispute_opened",
  payload: { contract_id: CONTRACT_ID, worker_user_id: 42 },
  idempotency_key: "open-key-1",
  created_at: new Date(),
};

const decidedEvent = {
  id: "evt-decided-1",
  aggregate_id: CONTRACT_ID,
  event_type: "vehicle_access.contract.settlement_dispute_decided",
  payload: { contract_id: CONTRACT_ID, worker_user_id: 42 },
  idempotency_key: "decide-key-1",
  created_at: new Date(),
};

function sweepPool(events: unknown[], detail: unknown = null) {
  return createPool([
    {
      match: /FROM vehicle_access\.claim_outbox_events/,
      result: { rows: events, rowCount: events.length },
    },
    {
      match: /SELECT email FROM public\.users\s+WHERE role = 'admin'/,
      result: { rows: [{ email: "ops@example.com" }, { email: null }] },
    },
    {
      match: /SELECT id, email, phone FROM public\.users WHERE id = ANY/,
      result: { rows: [{ id: 42, email: "renter@example.com", phone: "+27112233445" }] },
    },
    {
      match: /vehicle_access\.get_contract_event_detail/,
      result: { rows: [{ get_contract_event_detail: detail }] },
    },
  ]);
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("vehicleAccessOutboxSweepJob", () => {
  it("claims a batch through vehicle_access.claim_outbox_events with the bounded limit", async () => {
    const pool = sweepPool([]);
    dbMocks.getPool.mockResolvedValue(pool);

    const result = await vehicleAccessOutboxSweepJob(25);

    expect(result.success).toBe(true);
    expect(result.published).toBe(0);
    const claim = pool.calls.find((call) =>
      /FROM vehicle_access\.claim_outbox_events/.test(call.text),
    );
    expect(claim).toBeDefined();
    expect(claim?.values).toEqual([25]);
  });

  it("clamps the limit into 1..500 before claiming", async () => {
    const pool = sweepPool([]);
    dbMocks.getPool.mockResolvedValue(pool);

    await vehicleAccessOutboxSweepJob(100000);
    const claim = pool.calls.find((call) =>
      /FROM vehicle_access\.claim_outbox_events/.test(call.text),
    );
    expect(claim?.values).toEqual([500]);
  });

  it("notifies operators when a settlement dispute is opened", async () => {
    const pool = sweepPool([openedEvent]);
    dbMocks.getPool.mockResolvedValue(pool);

    const result = await vehicleAccessOutboxSweepJob();

    expect(result.success).toBe(true);
    expect(result.published).toBe(1);
    expect(result.notified).toBe(1);
    expect(gatewayMocks.sendEmail).toHaveBeenCalledWith(
      "ops@example.com",
      expect.any(String),
      `Settlement dispute opened for rental contract ${CONTRACT_ID}. Review in the Vehicle Access console.`,
      expect.objectContaining({
        notificationType: "vehicle_access.contract.settlement_dispute_opened",
        contractId: CONTRACT_ID,
      }),
    );
    expect(gatewayMocks.sendSMS).not.toHaveBeenCalled();
  });

  it("notifies the renter by email with status and adjustment in major units with the contract currency", async () => {
    const pool = sweepPool([decidedEvent], {
      dispute_id: "d-1",
      status: "adjusted",
      adjustment_minor: 125050,
      currency: "ZAR",
    });
    dbMocks.getPool.mockResolvedValue(pool);

    const result = await vehicleAccessOutboxSweepJob();

    expect(result.success).toBe(true);
    expect(result.notified).toBe(1);
    expect(gatewayMocks.sendEmail).toHaveBeenCalledWith(
      "renter@example.com",
      expect.any(String),
      expect.stringContaining("was adjusted."),
      expect.objectContaining({
        notificationType: "vehicle_access.contract.settlement_dispute_decided",
        contractId: CONTRACT_ID,
      }),
    );
    const firstEmailCall = gatewayMocks.sendEmail.mock.calls[0] as unknown as
      | [string, string, string, Record<string, string>]
      | undefined;
    const message = firstEmailCall?.[2] ?? "";
    expect(message).toContain("1250.50 ZAR");
    expect(gatewayMocks.sendSMS).not.toHaveBeenCalled();
    const detailCall = pool.calls.find((call) =>
      /vehicle_access\.get_contract_event_detail/.test(call.text),
    );
    expect(detailCall?.values).toEqual([CONTRACT_ID, "decide-key-1"]);
  });

  it("falls back to SMS when the renter has no email, labeling minor units when no currency is available", async () => {
    const pool = createPool([
      {
        match: /FROM vehicle_access\.claim_outbox_events/,
        result: { rows: [decidedEvent], rowCount: 1 },
      },
      {
        match: /SELECT id, email, phone FROM public\.users WHERE id = ANY/,
        result: { rows: [{ id: 42, email: null, phone: "+27112233445" }] },
      },
      {
        match: /vehicle_access\.get_contract_event_detail/,
        result: {
          rows: [
            {
              get_contract_event_detail: { status: "adjusted", adjustment_minor: 9000 },
            },
          ],
        },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const result = await vehicleAccessOutboxSweepJob();

    expect(result.success).toBe(true);
    expect(gatewayMocks.sendEmail).not.toHaveBeenCalled();
    expect(gatewayMocks.sendSMS).toHaveBeenCalledWith(
      "+27112233445",
      expect.stringContaining("9000 minor units"),
      expect.objectContaining({ contractId: CONTRACT_ID }),
    );
  });

  it("is fail-open per send: a notification outage never loses the published marker", async () => {
    gatewayMocks.sendEmail.mockRejectedValueOnce(new Error("dispatcher down"));
    const pool = sweepPool([openedEvent]);
    dbMocks.getPool.mockResolvedValue(pool);

    const result = await vehicleAccessOutboxSweepJob();

    expect(result.success).toBe(true);
    expect(result.published).toBe(1);
    expect(result.notified).toBe(0);
  });

  it("skips unknown event types silently (forward-compatible)", async () => {
    const pool = sweepPool([
      {
        ...openedEvent,
        id: "evt-future",
        event_type: "vehicle_access.contract.some_future_event",
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const result = await vehicleAccessOutboxSweepJob();

    expect(result.success).toBe(true);
    expect(result.published).toBe(1);
    expect(result.skipped).toBe(1);
    expect(gatewayMocks.sendEmail).not.toHaveBeenCalled();
    expect(gatewayMocks.sendSMS).not.toHaveBeenCalled();
    expect(
      pool.calls.some((call) => /role = 'admin'/.test(call.text)),
    ).toBe(false);
  });

  it("returns a failure summary when the database is unavailable", async () => {
    dbMocks.getPool.mockRejectedValue(new Error("no database"));

    const result = await vehicleAccessOutboxSweepJob();

    expect(result.success).toBe(false);
    expect(gatewayMocks.sendEmail).not.toHaveBeenCalled();
  });
});

describe("jobs export", () => {
  it("registers the vehicle access outbox sweep", () => {
    expect(jobs.vehicleAccessOutboxSweep).toBe(vehicleAccessOutboxSweepJob);
  });
});

// ---------------------------------------------------------------------------
// Migration static pin (drizzle/0100): the claim function must only claim the
// event types this sweep handles, so unknown events stay unpublished for
// future consumers instead of being silently marked published and dropped.
// ---------------------------------------------------------------------------
const migration0100 = readFileSync(
  resolve(resolve(import.meta.dirname, ".."), "drizzle/0100_outbox_claim_event_filter.sql"),
  "utf8",
);

describe("drizzle/0100_outbox_claim_event_filter.sql", () => {
  it("replaces claim_outbox_events with the identical signature", () => {
    expect(migration0100).toContain(
      "CREATE OR REPLACE FUNCTION vehicle_access.claim_outbox_events(p_limit integer)",
    );
    expect(migration0100).toContain(
      "RETURNS TABLE(id uuid, aggregate_id uuid, event_type text, payload jsonb, idempotency_key text, created_at timestamptz)",
    );
    expect(migration0100).toContain("SECURITY DEFINER");
  });

  it("filters the claim subquery to the handled dispute event types", () => {
    expect(migration0100).toContain(
      "AND p.event_type IN ('vehicle_access.contract.settlement_dispute_opened','vehicle_access.contract.settlement_dispute_decided')",
    );
  });

  it("keeps the guarded grant to vehicle_access_service", () => {
    expect(migration0100).toContain("IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='vehicle_access_service')");
    expect(migration0100).toContain(
      "GRANT EXECUTE ON FUNCTION vehicle_access.claim_outbox_events(integer) TO vehicle_access_service;",
    );
  });
});
