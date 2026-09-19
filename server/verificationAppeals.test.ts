import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Audit A P1-10: verification appeal lifecycle — self-serve filing with a
 * 14-day SLA and operator decision with reviewer != original decider.
 */

const dbMocks = vi.hoisted(() => ({
  getPool: vi.fn(),
}));

const gatewayMocks = vi.hoisted(() => ({
  sendEmail: vi.fn(async () => ({ accepted: true })),
  sendSMS: vi.fn(async () => ({ accepted: true })),
}));

vi.mock("../server/db", () => dbMocks);
vi.mock("./_core/notificationGateway", () => gatewayMocks);

import {
  decideVerificationAppeal,
  fileVerificationAppeal,
  listMyVerificationAppeals,
  VERIFICATION_APPEAL_SLA_DAYS,
} from "./_core/verificationAppeals";

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

const DAY_MS = 24 * 60 * 60 * 1000;
const CASE_ID = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("fileVerificationAppeal", () => {
  function filingPool(caseRow: unknown, openAppeals: unknown[] = []) {
    return createPool([
      {
        match: /FROM verification\.verification_case WHERE id/,
        result: { rows: caseRow ? [caseRow] : [] },
      },
      {
        match: /FROM public\.verification_appeals\n     WHERE case_id/,
        result: { rows: openAppeals },
      },
      {
        match: /INSERT INTO public\.verification_appeals/,
        result: {
          rows: [
            {
              id: "appeal-1",
              case_id: CASE_ID,
              appellant_user_id: 10,
              status: "filed",
              sla_due_at: new Date(),
              created_at: new Date(),
            },
          ],
          rowCount: 1,
        },
      },
      {
        match: /UPDATE verification\.verification_case/,
        result: { rows: [], rowCount: 1 },
      },
    ]);
  }

  it("files an appeal with a 14-day SLA and moves the case to 'appealed'", async () => {
    const pool = filingPool({ id: CASE_ID, subject_user_id: 10, state: "rejected" });
    dbMocks.getPool.mockResolvedValue(pool);

    const before = Date.now();
    const appeal = await fileVerificationAppeal(10, {
      caseId: CASE_ID,
      statement: "My documents were valid; please re-review.",
    });
    const after = Date.now();

    expect(appeal.id).toBe("appeal-1");
    const insert = pool.calls.find((call) =>
      /INSERT INTO public\.verification_appeals/.test(call.text),
    );
    const slaDueAt = (insert!.values[3] as Date).getTime();
    expect(slaDueAt).toBeGreaterThanOrEqual(
      before + VERIFICATION_APPEAL_SLA_DAYS * DAY_MS,
    );
    expect(slaDueAt).toBeLessThanOrEqual(
      after + VERIFICATION_APPEAL_SLA_DAYS * DAY_MS,
    );
    const caseUpdate = pool.calls.find((call) =>
      /UPDATE verification\.verification_case/.test(call.text),
    );
    expect(caseUpdate?.text).toContain("state = 'appealed'");
  });

  it("allows appealing suspended cases too", async () => {
    const pool = filingPool({ id: CASE_ID, subject_user_id: 10, state: "suspended" });
    dbMocks.getPool.mockResolvedValue(pool);
    await expect(
      fileVerificationAppeal(10, { caseId: CASE_ID, statement: "Consent restored." }),
    ).resolves.toMatchObject({ id: "appeal-1" });
  });

  it("rejects appeals against someone else's case", async () => {
    const pool = filingPool({ id: CASE_ID, subject_user_id: 10, state: "rejected" });
    dbMocks.getPool.mockResolvedValue(pool);
    await expect(
      fileVerificationAppeal(99, { caseId: CASE_ID, statement: "not mine but still" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects appeals for non-appealable case states", async () => {
    const pool = filingPool({ id: CASE_ID, subject_user_id: 10, state: "verified" });
    dbMocks.getPool.mockResolvedValue(pool);
    await expect(
      fileVerificationAppeal(10, { caseId: CASE_ID, statement: "why appeal verified" }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "case_state_not_appealable:verified",
    });
  });

  it("rejects a second open appeal for the same case", async () => {
    const pool = filingPool(
      { id: CASE_ID, subject_user_id: 10, state: "rejected" },
      [{ id: "appeal-0" }],
    );
    dbMocks.getPool.mockResolvedValue(pool);
    await expect(
      fileVerificationAppeal(10, { caseId: CASE_ID, statement: "duplicate appeal here" }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "open_appeal_already_exists",
    });
  });

  it("rejects unknown cases and invalid statements", async () => {
    dbMocks.getPool.mockResolvedValue(filingPool(null));
    await expect(
      fileVerificationAppeal(10, { caseId: CASE_ID, statement: "missing case appeal" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      fileVerificationAppeal(10, { caseId: CASE_ID, statement: "ab" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("decideVerificationAppeal", () => {
  const appealWithCase = {
    id: "appeal-1",
    case_id: CASE_ID,
    appellant_user_id: 10,
    statement: "please re-review",
    status: "filed",
    decision: null,
    rationale: null,
    reviewer_id: null,
    sla_due_at: new Date(),
    created_at: new Date(),
    case_state: "appealed",
    case_decided_by: 7,
  };

  function decisionPool(appeal: typeof appealWithCase) {
    return createPool([
      {
        match: /FROM public\.verification_appeals a/,
        result: { rows: [appeal] },
      },
      {
        match: /UPDATE public\.verification_appeals/,
        result: {
          rows: [{ ...appeal, status: "decided", reviewer_id: 88 }],
          rowCount: 1,
        },
      },
      {
        match: /UPDATE verification\.verification_case/,
        result: { rows: [], rowCount: 1 },
      },
      {
        match: /SELECT email, phone FROM public\.users/,
        result: { rows: [{ email: "appellant@example.com", phone: null }] },
      },
    ]);
  }

  it("blocks the original case decider from reviewing the appeal", async () => {
    dbMocks.getPool.mockResolvedValue(decisionPool(appealWithCase));
    await expect(
      decideVerificationAppeal(7, {
        appealId: "appeal-1",
        decision: "upheld",
        rationale: "I decided it before and I stand by it",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "reviewer_must_differ_from_decider",
    });
  });

  it("upheld decisions return the case to 'rejected' and notify the appellant", async () => {
    const pool = decisionPool(appealWithCase);
    dbMocks.getPool.mockResolvedValue(pool);

    await decideVerificationAppeal(88, {
      appealId: "appeal-1",
      decision: "upheld",
      rationale: "Evidence supports the rejection",
    });

    const caseUpdate = pool.calls.find((call) =>
      /UPDATE verification\.verification_case/.test(call.text),
    );
    expect(caseUpdate?.values).toEqual([CASE_ID, "rejected"]);
    expect(gatewayMocks.sendEmail).toHaveBeenCalledWith(
      "appellant@example.com",
      "SwitchOS verification appeal decision",
      expect.stringContaining("upheld"),
      expect.objectContaining({
        notificationType: "verification.appeal.decided",
        appealId: "appeal-1",
      }),
    );
  });

  it("overturned decisions re-queue the case to 'manual_review'", async () => {
    const pool = decisionPool(appealWithCase);
    dbMocks.getPool.mockResolvedValue(pool);

    await decideVerificationAppeal(88, {
      appealId: "appeal-1",
      decision: "overturned",
      rationale: "Documents were in fact valid",
    });

    const caseUpdate = pool.calls.find((call) =>
      /UPDATE verification\.verification_case/.test(call.text),
    );
    expect(caseUpdate?.values).toEqual([CASE_ID, "manual_review"]);
  });

  it("is fail-open when the appellant notification fails", async () => {
    gatewayMocks.sendEmail.mockRejectedValueOnce(new Error("dispatcher down"));
    dbMocks.getPool.mockResolvedValue(decisionPool(appealWithCase));
    await expect(
      decideVerificationAppeal(88, {
        appealId: "appeal-1",
        decision: "upheld",
        rationale: "Evidence supports the rejection",
      }),
    ).resolves.toMatchObject({ status: "decided" });
  });

  it("rejects double decisions and invalid input", async () => {
    dbMocks.getPool.mockResolvedValue(
      decisionPool({ ...appealWithCase, status: "decided" }),
    );
    await expect(
      decideVerificationAppeal(88, {
        appealId: "appeal-1",
        decision: "upheld",
        rationale: "second decision attempt",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "appeal_already_decided" });

    await expect(
      decideVerificationAppeal(88, {
        appealId: "appeal-1",
        decision: "maybe" as never,
        rationale: "invalid decision value",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("listMyVerificationAppeals", () => {
  it("returns only the caller's appeals", async () => {
    const pool = createPool([
      {
        match: /FROM public\.verification_appeals\n     WHERE appellant_user_id/,
        result: { rows: [{ id: "appeal-1" }] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    const rows = await listMyVerificationAppeals(10);
    expect(rows).toHaveLength(1);
    expect(pool.calls[0]?.values).toEqual([10]);
  });
});
