import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getPool: vi.fn(),
}));

vi.mock("../server/db", () => dbMocks);

import {
  assignReviewer,
  fileAppeal,
  initiateCase,
  reviewAppeal,
  setProtectedActivity,
  APPEAL_SLA_DAYS,
  NOTICE_PERIOD_DAYS,
} from "./_core/deactivationDueProcess";

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

beforeEach(() => {
  vi.resetAllMocks();
});

describe("initiateCase", () => {
  it("rejects causes outside the taxonomy", async () => {
    dbMocks.getPool.mockResolvedValue(createPool([]));
    await expect(
      initiateCase(1, {
        subjectUserId: 10,
        subjectRole: "driver",
        causeCode: "VIBES",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      initiateCase(1, {
        subjectUserId: 10,
        subjectRole: "wizard",
        causeCode: "SAFETY",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("gives non-egregious cases a 14-day notice period", async () => {
    const pool = createPool([
      {
        match: /INSERT INTO public\.deactivation_cases/,
        result: { rows: [{ id: "case-1", status: "notice" }], rowCount: 1 },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const before = Date.now();
    await initiateCase(1, {
      subjectUserId: 10,
      subjectRole: "driver",
      causeCode: "DOCUMENTS",
      egregious: false,
    });
    const after = Date.now();

    const insert = pool.calls.find((call) =>
      /INSERT INTO public\.deactivation_cases/.test(call.text),
    );
    expect(insert).toBeDefined();
    const values = insert!.values;
    expect(values[5]).toBe("notice");
    const noticeSentAt = (values[6] as Date).getTime();
    const effectiveAt = (values[7] as Date).getTime();
    expect(effectiveAt - noticeSentAt).toBe(NOTICE_PERIOD_DAYS * DAY_MS);
    expect(effectiveAt).toBeGreaterThanOrEqual(before + NOTICE_PERIOD_DAYS * DAY_MS);
    expect(effectiveAt).toBeLessThanOrEqual(after + NOTICE_PERIOD_DAYS * DAY_MS);
  });

  it("takes egregious cases into effect immediately", async () => {
    const pool = createPool([
      {
        match: /INSERT INTO public\.deactivation_cases/,
        result: { rows: [{ id: "case-1", status: "active" }], rowCount: 1 },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    await initiateCase(1, {
      subjectUserId: 10,
      subjectRole: "courier",
      causeCode: "SAFETY",
      egregious: true,
    });
    const insert = pool.calls.find((call) =>
      /INSERT INTO public\.deactivation_cases/.test(call.text),
    );
    const values = insert!.values;
    expect(values[5]).toBe("active");
    expect(values[7]).toEqual(values[6]); // effective_at === notice_sent_at
  });

  it("requires elevated justification for protected-activity cases", async () => {
    dbMocks.getPool.mockResolvedValue(createPool([]));
    await expect(
      initiateCase(1, {
        subjectUserId: 10,
        subjectRole: "driver",
        causeCode: "CONDUCT",
        protectedActivity: true,
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "elevated_justification_required_for_protected_activity",
    });
    await expect(
      initiateCase(1, {
        subjectUserId: 10,
        subjectRole: "driver",
        causeCode: "CONDUCT",
        protectedActivity: true,
        elevatedJustification: "   ",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("fileAppeal", () => {
  const baseCase = {
    id: "case-1",
    subject_user_id: 10,
    status: "active",
  };

  it("sets the case to appealed and sla_due_at to now + 14 days", async () => {
    const pool = createPool([
      {
        match: /SELECT \* FROM public\.deactivation_cases WHERE id/,
        result: { rows: [baseCase] },
      },
      {
        match: /INSERT INTO public\.deactivation_appeals/,
        result: {
          rows: [{ id: "appeal-1", case_id: "case-1", status: "filed" }],
          rowCount: 1,
        },
      },
      {
        match: /UPDATE public\.deactivation_cases/,
        result: { rows: [], rowCount: 1 },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const before = Date.now();
    await fileAppeal(10, {
      caseId: "case-1",
      statement: "I was deactivated at home for protesting.",
    });
    const after = Date.now();

    const insert = pool.calls.find((call) =>
      /INSERT INTO public\.deactivation_appeals/.test(call.text),
    );
    const slaDueAt = (insert!.values[3] as Date).getTime();
    expect(slaDueAt).toBeGreaterThanOrEqual(before + APPEAL_SLA_DAYS * DAY_MS);
    expect(slaDueAt).toBeLessThanOrEqual(after + APPEAL_SLA_DAYS * DAY_MS);

    const update = pool.calls.find((call) =>
      /UPDATE public\.deactivation_cases/.test(call.text),
    );
    expect(update?.text).toContain("status = 'appealed'");
  });

  it("rejects appeals against someone else's case", async () => {
    const pool = createPool([
      {
        match: /SELECT \* FROM public\.deactivation_cases WHERE id/,
        result: { rows: [baseCase] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    await expect(
      fileAppeal(99, { caseId: "case-1", statement: "not my case but appealing" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("assignReviewer / reviewAppeal separation of duties", () => {
  const appealWithCase = {
    id: "appeal-1",
    case_id: "case-1",
    appellant_user_id: 10,
    statement: "statement",
    status: "filed",
    reviewer_id: 55,
    decided_at: null,
    decision: null,
    rationale: null,
    sla_due_at: new Date(),
    created_at: new Date(),
    case_decided_by: 7,
    case_subject_user_id: 10,
  };

  function appealPool(appeal: typeof appealWithCase) {
    return createPool([
      {
        match: /FROM public\.deactivation_appeals a/,
        result: { rows: [appeal] },
      },
      {
        match: /UPDATE public\.deactivation_appeals/,
        result: { rows: [{ ...appeal, status: "decided" }], rowCount: 1 },
      },
      { match: /UPDATE public\.deactivation_cases/, result: { rows: [], rowCount: 1 } },
      { match: /INSERT INTO public\.backpay_credits/, result: { rows: [], rowCount: 1 } },
    ]);
  }

  it("rejects assigning the original decider as reviewer (CONFLICT)", async () => {
    dbMocks.getPool.mockResolvedValue(appealPool(appealWithCase));
    await expect(
      assignReviewer({ appealId: "appeal-1", reviewerId: 7 }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "reviewer_must_differ_from_decider",
    });
  });

  it("allows a different reviewer", async () => {
    dbMocks.getPool.mockResolvedValue(appealPool(appealWithCase));
    await expect(
      assignReviewer({ appealId: "appeal-1", reviewerId: 88 }),
    ).resolves.toBeDefined();
  });

  it("reinstates the case and records a pending backpay credit on reinstated_with_backpay", async () => {
    const pool = appealPool(appealWithCase);
    dbMocks.getPool.mockResolvedValue(pool);

    await reviewAppeal({
      appealId: "appeal-1",
      decision: "reinstated_with_backpay",
      rationale: "retaliatory deactivation for union activity",
      backpayAmountMinor: 250000,
    });

    const caseUpdate = pool.calls.find((call) =>
      /UPDATE public\.deactivation_cases/.test(call.text),
    );
    expect(caseUpdate?.values).toContain("reinstated");
    const credit = pool.calls.find((call) =>
      /INSERT INTO public\.backpay_credits/.test(call.text),
    );
    expect(credit).toBeDefined();
    expect(credit?.values).toEqual(["appeal-1", 10, 250000]);
  });

  it("marks the case upheld on upheld decisions and writes no backpay credit", async () => {
    const pool = appealPool(appealWithCase);
    dbMocks.getPool.mockResolvedValue(pool);

    await reviewAppeal({
      appealId: "appeal-1",
      decision: "upheld",
      rationale: "evidence supports the safety cause",
    });

    const caseUpdate = pool.calls.find((call) =>
      /UPDATE public\.deactivation_cases/.test(call.text),
    );
    expect(caseUpdate?.values).toContain("upheld");
    expect(
      pool.calls.some((call) => /INSERT INTO public\.backpay_credits/.test(call.text)),
    ).toBe(false);
  });

  it("enforces reviewer != decided_by even if the assignment was bypassed", async () => {
    const pool = appealPool({ ...appealWithCase, reviewer_id: 7 });
    dbMocks.getPool.mockResolvedValue(pool);

    await expect(
      reviewAppeal({
        appealId: "appeal-1",
        decision: "upheld",
        rationale: "self review attempt blocked",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "reviewer_must_differ_from_decider",
    });
  });
});

describe("setProtectedActivity", () => {
  it("flags the subject's latest case", async () => {
    const pool = createPool([
      {
        match: /UPDATE public\.deactivation_cases/,
        result: { rows: [{ id: "case-1" }], rowCount: 1 },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const result = await setProtectedActivity({ userId: 10, protected: true });
    expect(result.updated).toBe(true);
    const update = pool.calls[0];
    expect(update?.values).toEqual([10, true]);
  });
});
