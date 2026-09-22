import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getPool: vi.fn(),
}));

vi.mock("../server/db", () => dbMocks);

import {
  activateConsultation,
  addCouncilMember,
  listConsultations,
  postConsultation,
  requireConsultationGate,
  respondToConsultation,
} from "./_core/workerCouncil";

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

const member = {
  id: "member-1",
  user_id: 42,
  constituency: "drivers",
  role: "representative",
  active: true,
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe("respondToConsultation", () => {
  const openConsultation = {
    id: "cons-1",
    kind: "pricing",
    status: "open",
  };

  function respondPool() {
    return createPool([
      {
        match: /FROM public\.council_members\s+WHERE user_id/,
        result: { rows: [member] },
      },
      {
        match: /SELECT \* FROM public\.consultation_objects WHERE id/,
        result: { rows: [openConsultation] },
      },
      {
        match: /INSERT INTO public\.consultation_responses/,
        result: {
          rows: [{ id: "resp-1", consultation_id: "cons-1", member_id: "member-1" }],
          rowCount: 1,
        },
      },
    ]);
  }

  it("upserts one response per member per consultation", async () => {
    const pool = respondPool();
    dbMocks.getPool.mockResolvedValue(pool);

    await respondToConsultation(42, {
      id: "cons-1",
      stance: "object",
      body: "The commission rise was never tabled.",
    });

    const insert = pool.calls.find((call) =>
      /INSERT INTO public\.consultation_responses/.test(call.text),
    );
    expect(insert?.text).toContain("ON CONFLICT (consultation_id, member_id)");
    expect(insert?.values).toEqual([
      "cons-1",
      "member-1",
      "object",
      "The commission rise was never tabled.",
    ]);
  });

  it("rejects responses from non-members", async () => {
    const pool = createPool([
      {
        match: /FROM public\.council_members\s+WHERE user_id/,
        result: { rows: [] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    await expect(
      respondToConsultation(99, { id: "cons-1", stance: "support", body: "ok" }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "active_council_membership_required",
    });
  });
});

describe("activateConsultation gate", () => {
  function gatePool(gate: {
    status: string;
    response_sla_at: Date;
    active_members: number;
    responded_members: number;
  }) {
    return createPool([
      {
        match: /SELECT c\.status,\s*c\.response_sla_at/,
        result: { rows: [gate] },
      },
      {
        match: /UPDATE public\.consultation_objects/,
        result: {
          rows: [{ id: "cons-1", status: "activated" }],
          rowCount: 1,
        },
      },
    ]);
  }

  it("rejects activation before the SLA when members have not all responded", async () => {
    const pool = gatePool({
      status: "open",
      response_sla_at: new Date(Date.now() + 48 * 3600 * 1000),
      active_members: 3,
      responded_members: 1,
    });
    dbMocks.getPool.mockResolvedValue(pool);

    await expect(activateConsultation({ id: "cons-1" })).rejects.toMatchObject({
      code: "CONFLICT",
      message:
        "consultation_gate_unmet:response_sla_open_and_members_outstanding",
    });
  });

  it("allows activation once the SLA has elapsed even without full response", async () => {
    const pool = gatePool({
      status: "open",
      response_sla_at: new Date(Date.now() - 1000),
      active_members: 3,
      responded_members: 1,
    });
    dbMocks.getPool.mockResolvedValue(pool);

    const result = await activateConsultation({ id: "cons-1" });
    expect(result.status).toBe("activated");
  });

  it("allows activation before the SLA when every active member responded", async () => {
    const pool = gatePool({
      status: "open",
      response_sla_at: new Date(Date.now() + 48 * 3600 * 1000),
      active_members: 2,
      responded_members: 2,
    });
    dbMocks.getPool.mockResolvedValue(pool);

    const result = await activateConsultation({ id: "cons-1" });
    expect(result.status).toBe("activated");
  });

  it("rejects activation of a non-open consultation", async () => {
    const pool = gatePool({
      status: "closed",
      response_sla_at: new Date(Date.now() - 1000),
      active_members: 0,
      responded_members: 0,
    });
    dbMocks.getPool.mockResolvedValue(pool);

    await expect(activateConsultation({ id: "cons-1" })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "consultation_not_open",
    });
  });
});

describe("postConsultation / addCouncilMember / requireConsultationGate", () => {
  it("posts a consultation with a bounded response SLA", async () => {
    const pool = createPool([
      {
        match: /INSERT INTO public\.consultation_objects/,
        result: { rows: [{ id: "cons-1", kind: "commission", status: "open" }] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const result = await postConsultation(7, {
      kind: "commission",
      title: "Commission change 2026-Q3",
      payload: { commissionBp: 2000 },
      responseSlaHours: 336,
    });
    expect(result.status).toBe("open");
    const insert = pool.calls[0];
    expect(insert?.values[0]).toBe("commission");
    expect(insert?.values[3]).toBe(7);
    expect(insert?.values[4]).toBe(336);
  });

  it("adds (or reactivates) a council member idempotently", async () => {
    const pool = createPool([
      {
        match: /INSERT INTO public\.council_members/,
        result: { rows: [member] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const result = await addCouncilMember({ userId: 42, constituency: "drivers" });
    expect(result.user_id).toBe(42);
    expect(pool.calls[0]?.text).toContain("ON CONFLICT (user_id)");
  });

  it("requireConsultationGate returns the latest open consultation of a kind or null", async () => {
    const pool = createPool([
      {
        match: /FROM public\.consultation_objects\s+WHERE kind/,
        result: { rows: [{ id: "cons-9" }] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    await expect(requireConsultationGate("pricing")).resolves.toEqual({
      consultationId: "cons-9",
    });
    expect(pool.calls[0]?.values).toEqual(["pricing"]);

    const emptyPool = createPool([
      {
        match: /FROM public\.consultation_objects\s+WHERE kind/,
        result: { rows: [] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(emptyPool);
    await expect(requireConsultationGate("commission")).resolves.toBeNull();
  });
});

describe("listConsultations", () => {
  it("uses a single LEFT JOIN + GROUP BY instead of a per-row count subquery", async () => {
    const rows = [
      { id: "cons-1", kind: "pricing", status: "open", response_count: 3 },
      { id: "cons-2", kind: "safety_policy", status: "open", response_count: 0 },
    ];
    const pool = createPool([
      { match: /FROM public\.consultation_objects/, result: { rows } },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const result = await listConsultations();

    expect(result).toEqual(rows);
    expect(pool.calls).toHaveLength(1);
    const sql = pool.calls[0]?.text ?? "";
    expect(sql).toContain("LEFT JOIN public.consultation_responses");
    expect(sql).toContain("GROUP BY c.id");
    expect(sql).toContain("ORDER BY c.created_at DESC");
    expect(sql).toContain("LIMIT 200");
    expect(sql).not.toContain("(SELECT count(*)");
  });

  it("keeps the status filter parameterized", async () => {
    const pool = createPool([
      { match: /FROM public\.consultation_objects/, result: { rows: [] } },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    await listConsultations({ status: "closed" });

    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0]?.text).toContain("WHERE c.status = $1");
    expect(pool.calls[0]?.text).toContain("GROUP BY c.id");
    expect(pool.calls[0]?.values).toEqual(["closed"]);
  });
});
