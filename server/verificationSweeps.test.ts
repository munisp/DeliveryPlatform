import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Audit A cross-cutting 2 + P1-9: the verification outbox now has a consumer
 * sweep (idempotent consumed_at marking + subject notifications + developer
 * webhook flush) and manual_review cases age into SLA escalations.
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
    published: 1,
    claimed: 1,
    delivered: 1,
    retried: 0,
  })),
}));

vi.mock("../server/db", () => dbMocks);
vi.mock("./_core/notificationGateway", () => gatewayMocks);
vi.mock("./_core/developerWebhookDispatcher", () => dispatcherMocks);

import {
  verificationOutboxSweepJob,
  verificationSlaSweepJob,
} from "./_core/scheduledJobs";

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

const CASE_ID = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  vi.resetAllMocks();
  dispatcherMocks.dispatchDeveloperWebhooks.mockResolvedValue({
    published: 1,
    claimed: 1,
    delivered: 1,
    retried: 0,
  } as never);
});

describe("verificationOutboxSweepJob", () => {
  const claimedEvent = {
    id: "evt-1",
    case_id: CASE_ID,
    event_type: "verification.case.verified",
    payload: {},
    created_at: new Date(),
  };

  function sweepPool(events: unknown[] = [claimedEvent]) {
    return createPool([
      {
        match: /UPDATE verification\.outbox_event/,
        result: { rows: events, rowCount: events.length },
      },
      {
        match: /FROM verification\.verification_case WHERE id = ANY/,
        result: {
          rows: [
            {
              id: CASE_ID,
              subject_user_id: 42,
              subject_type: "driver",
              subject_key: "k",
            },
          ],
        },
      },
      {
        match: /SELECT id, email, phone FROM public\.users WHERE id = ANY/,
        result: { rows: [{ id: 42, email: "subject@example.com", phone: null }] },
      },
    ]);
  }

  it("claims a batch with the consumed_at marker (SKIP LOCKED), notifies subjects, flushes webhooks", async () => {
    const pool = sweepPool();
    dbMocks.getPool.mockResolvedValue(pool);

    const result = await verificationOutboxSweepJob(25);

    expect(result.success).toBe(true);
    expect(result.consumed).toBe(1);
    expect(result.notified).toBe(1);
    const claim = pool.calls.find((call) =>
      /UPDATE verification\.outbox_event/.test(call.text),
    );
    expect(claim?.text).toContain("consumed_at = now()");
    expect(claim?.text).toContain("FOR UPDATE SKIP LOCKED");
    expect(claim?.values).toEqual([25]);
    expect(gatewayMocks.sendEmail).toHaveBeenCalledWith(
      "subject@example.com",
      "SwitchOS verification update",
      expect.stringContaining("verification.case.verified"),
      expect.objectContaining({ notificationType: "verification.case.verified" }),
    );
    expect(dispatcherMocks.dispatchDeveloperWebhooks).toHaveBeenCalledWith(25);
  });

  it("is idempotent: a sweep with no unconsumed events dispatches nothing", async () => {
    const pool = sweepPool([]);
    dbMocks.getPool.mockResolvedValue(pool);

    const result = await verificationOutboxSweepJob();

    expect(result.success).toBe(true);
    expect(result.consumed).toBe(0);
    expect(result.notified).toBe(0);
    expect(gatewayMocks.sendEmail).not.toHaveBeenCalled();
    expect(gatewayMocks.sendSMS).not.toHaveBeenCalled();
  });

  it("is fail-open per event: a notification outage never loses the consumed marker", async () => {
    gatewayMocks.sendEmail.mockRejectedValueOnce(new Error("dispatcher down"));
    const pool = sweepPool();
    dbMocks.getPool.mockResolvedValue(pool);

    const result = await verificationOutboxSweepJob();
    expect(result.success).toBe(true);
    expect(result.consumed).toBe(1);
    expect(result.notified).toBe(0);
  });

  it("batch-fetches subjects and contacts with WHERE id = ANY($1) (no per-event N+1)", async () => {
    const caseId2 = "22222222-2222-2222-2222-222222222222";
    const events = [
      claimedEvent,
      { id: "evt-2", case_id: caseId2, event_type: "verification.case.rejected", payload: {}, created_at: new Date() },
      // Same case again: subject lookup must be deduped.
      { id: "evt-3", case_id: CASE_ID, event_type: "verification.case.verified", payload: {}, created_at: new Date() },
    ];
    const pool = createPool([
      {
        match: /UPDATE verification\.outbox_event/,
        result: { rows: events, rowCount: events.length },
      },
      {
        match: /FROM verification\.verification_case WHERE id = ANY/,
        result: {
          rows: [
            { id: CASE_ID, subject_user_id: 42, subject_type: "driver", subject_key: "k" },
            { id: caseId2, subject_user_id: 43, subject_type: "merchant", subject_key: "m" },
          ],
        },
      },
      {
        match: /SELECT id, email, phone FROM public\.users WHERE id = ANY/,
        result: {
          rows: [
            { id: 42, email: "subject@example.com", phone: null },
            { id: 43, email: null, phone: "+27112233445" },
          ],
        },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const result = await verificationOutboxSweepJob();

    expect(result.success).toBe(true);
    expect(result.consumed).toBe(3);
    expect(result.notified).toBe(3);

    const subjectCalls = pool.calls.filter((call) =>
      /FROM verification\.verification_case WHERE id = ANY/.test(call.text),
    );
    expect(subjectCalls).toHaveLength(1);
    expect(subjectCalls[0]?.text).toContain("ANY($1)");
    expect(subjectCalls[0]?.values?.[0]).toEqual([CASE_ID, caseId2]);

    const contactCalls = pool.calls.filter((call) =>
      /SELECT id, email, phone FROM public\.users/.test(call.text),
    );
    expect(contactCalls).toHaveLength(1);
    expect(contactCalls[0]?.text).toContain("ANY($1)");
    expect(contactCalls[0]?.values?.[0]).toEqual([42, 43]);

    expect(gatewayMocks.sendEmail).toHaveBeenCalledTimes(2);
    expect(gatewayMocks.sendSMS).toHaveBeenCalledTimes(1);
    expect(gatewayMocks.sendSMS).toHaveBeenCalledWith(
      "+27112233445",
      expect.stringContaining("verification.case.rejected"),
      expect.objectContaining({ caseId: caseId2 }),
    );
  });

  it("reports database unavailability without throwing", async () => {
    dbMocks.getPool.mockRejectedValue(new Error("db down"));
    const result = await verificationOutboxSweepJob();
    expect(result.success).toBe(false);
    expect(result.message).toContain("Database unavailable");
  });
});

describe("verificationSlaSweepJob", () => {
  const agingCase = {
    id: CASE_ID,
    subject_type: "driver",
    subject_key: "driver-application-9",
    subject_user_id: 42,
    updated_at: new Date(Date.now() - 96 * 3600 * 1000),
  };

  function slaPool(aging: unknown[], inserted: unknown[]) {
    return createPool([
      {
        match: /FROM verification\.verification_case\n     WHERE state = 'manual_review'/,
        result: { rows: aging },
      },
      {
        match: /INSERT INTO verification\.outbox_event/,
        result: { rows: inserted, rowCount: inserted.length },
      },
      {
        match: /SELECT email FROM public\.users/,
        result: { rows: [{ email: "ops@example.com" }] },
      },
    ]);
  }

  it("escalates cases older than 72h with an outbox event + operator notification", async () => {
    const pool = slaPool([agingCase], [{ id: "evt-esc-1" }]);
    dbMocks.getPool.mockResolvedValue(pool);

    const result = await verificationSlaSweepJob();

    expect(result.success).toBe(true);
    expect(result.aged).toBe(1);
    expect(result.escalated).toBe(1);
    expect(result.operatorsNotified).toBe(1);
    const escalation = pool.calls.find((call) =>
      /INSERT INTO verification\.outbox_event/.test(call.text),
    );
    expect(escalation?.text).toContain("'verification.case.sla_escalated'");
    expect(escalation?.values?.[2]).toBe(`verification-sla-${CASE_ID}`);
    expect(gatewayMocks.sendEmail).toHaveBeenCalledWith(
      "ops@example.com",
      "SwitchOS verification SLA escalation",
      expect.stringContaining("manual_review"),
      expect.objectContaining({
        notificationType: "verification.case.sla_escalated",
        caseId: CASE_ID,
      }),
    );
  });

  it("is idempotent: an already-escalated case is not re-escalated or re-notified", async () => {
    const pool = slaPool([agingCase], []); // ON CONFLICT DO NOTHING -> no row
    dbMocks.getPool.mockResolvedValue(pool);

    const result = await verificationSlaSweepJob();

    expect(result.success).toBe(true);
    expect(result.aged).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.operatorsNotified).toBe(0);
    expect(gatewayMocks.sendEmail).not.toHaveBeenCalled();
  });

  it("does nothing when no case breaches the SLA", async () => {
    const pool = slaPool([], []);
    dbMocks.getPool.mockResolvedValue(pool);
    const result = await verificationSlaSweepJob();
    expect(result.success).toBe(true);
    expect(result.escalated).toBe(0);
    expect(result.message).toContain("No verification cases breached");
  });

  it("is fail-open when the operator notification fails", async () => {
    gatewayMocks.sendEmail.mockRejectedValueOnce(new Error("dispatcher down"));
    const pool = slaPool([agingCase], [{ id: "evt-esc-1" }]);
    dbMocks.getPool.mockResolvedValue(pool);
    const result = await verificationSlaSweepJob();
    expect(result.success).toBe(true);
    expect(result.escalated).toBe(1);
    expect(result.operatorsNotified).toBe(0);
  });

  it("hoists the operator recipient lookup out of the per-case loop", async () => {
    const secondCase = {
      id: "22222222-2222-2222-2222-222222222222",
      subject_type: "merchant",
      subject_key: "merchant-7",
      subject_user_id: 77,
      updated_at: new Date(Date.now() - 120 * 3600 * 1000),
    };
    const pool = slaPool([agingCase, secondCase], [{ id: "evt-1" }, { id: "evt-2" }]);
    dbMocks.getPool.mockResolvedValue(pool);

    const result = await verificationSlaSweepJob();

    expect(result.success).toBe(true);
    expect(result.escalated).toBe(2);
    expect(result.operatorsNotified).toBe(2);
    const operatorLookups = pool.calls.filter((call) =>
      /SELECT email FROM public\.users/.test(call.text),
    );
    expect(operatorLookups).toHaveLength(1);
    expect(gatewayMocks.sendEmail).toHaveBeenCalledTimes(2);
  });

  it("reports database unavailability without throwing", async () => {
    dbMocks.getPool.mockRejectedValue(new Error("db down"));
    const result = await verificationSlaSweepJob();
    expect(result.success).toBe(false);
    expect(result.message).toContain("Database unavailable");
  });
});
