import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getPool: vi.fn(),
}));
const councilMocks = vi.hoisted(() => ({
  postConsultation: vi.fn(),
}));

vi.mock("../server/db", () => dbMocks);
vi.mock("../server/_core/workerCouncil", () => councilMocks);

import {
  advanceEnrollment,
  assertEnrollmentTransition,
  createProgram,
  enroll,
  withdraw,
} from "./_core/workerTransition";

type QueryResult = { rows: unknown[]; rowCount?: number };

function createPool(
  handlers: Array<{ match: RegExp; result: QueryResult | (() => QueryResult) }>,
) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  return {
    calls,
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      const handler = handlers.find((candidate) => candidate.match.test(text));
      if (!handler) return { rows: [], rowCount: 0 };
      return typeof handler.result === "function"
        ? handler.result()
        : handler.result;
    }),
  };
}

const PROGRAM = {
  id: "prog-1",
  title: "Voluntary exit Q3",
  kind: "voluntary_exit",
  terms: { gratuity_minor: 4_000_000, deficit_forgiveness: true },
  open: true,
  consultation_id: null,
  created_at: new Date().toISOString(),
};

const ENROLLMENT = {
  id: "enr-1",
  program_id: "prog-1",
  worker_id: 42,
  status: "enrolled",
  exit_gratuity_minor: 0,
  deficits_waived_minor: 0,
  completed_at: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe("assertEnrollmentTransition (pure)", () => {
  it("allows enrolled -> in_progress and in_progress -> completed", () => {
    expect(() =>
      assertEnrollmentTransition("enrolled", "in_progress"),
    ).not.toThrow();
    expect(() =>
      assertEnrollmentTransition("in_progress", "completed"),
    ).not.toThrow();
  });

  it("rejects enrolled -> completed (must pass through in_progress)", () => {
    expect(() =>
      assertEnrollmentTransition("enrolled", "completed"),
    ).toThrowError(/invalid_enrollment_transition/);
  });

  it("terminal states never move again", () => {
    expect(() =>
      assertEnrollmentTransition("completed", "withdrawn"),
    ).toThrowError(/invalid_enrollment_transition/);
    expect(() =>
      assertEnrollmentTransition("withdrawn", "enrolled"),
    ).toThrowError(/invalid_enrollment_transition/);
  });
});

describe("enroll", () => {
  it("inserts a new enrollment for an open program", async () => {
    const pool = createPool([
      {
        match: /FROM public\.transition_programs WHERE id/,
        result: { rows: [PROGRAM] },
      },
      {
        match: /FROM public\.transition_enrollments\s+WHERE program_id/,
        result: { rows: [] },
      },
      {
        match: /INSERT INTO public\.transition_enrollments/,
        result: { rows: [ENROLLMENT] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const row = await enroll(42, { programId: "prog-1" });
    expect(row.status).toBe("enrolled");
    const insert = pool.calls.find((call) =>
      /INSERT INTO public\.transition_enrollments/.test(call.text),
    );
    expect(insert!.text).toContain("ON CONFLICT (program_id, worker_id)");
    expect(insert!.values).toEqual(["prog-1", 42]);
  });

  it("rejects a second live enrollment (unique per program+worker)", async () => {
    const pool = createPool([
      {
        match: /FROM public\.transition_programs WHERE id/,
        result: { rows: [PROGRAM] },
      },
      {
        match: /FROM public\.transition_enrollments\s+WHERE program_id/,
        result: { rows: [ENROLLMENT] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    await expect(enroll(42, { programId: "prog-1" })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "already_enrolled",
    });
    expect(
      pool.calls.some((call) =>
        /INSERT INTO public\.transition_enrollments/.test(call.text),
      ),
    ).toBe(false);
  });

  it("re-enrolls in place after a withdrawal", async () => {
    const pool = createPool([
      {
        match: /FROM public\.transition_programs WHERE id/,
        result: { rows: [PROGRAM] },
      },
      {
        match: /FROM public\.transition_enrollments\s+WHERE program_id/,
        result: { rows: [{ ...ENROLLMENT, status: "withdrawn" }] },
      },
      {
        match: /UPDATE public\.transition_enrollments/,
        result: { rows: [ENROLLMENT] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    const row = await enroll(42, { programId: "prog-1" });
    expect(row.status).toBe("enrolled");
  });

  it("rejects enrollment into a closed program", async () => {
    const pool = createPool([
      {
        match: /FROM public\.transition_programs WHERE id/,
        result: { rows: [{ ...PROGRAM, open: false }] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    await expect(enroll(42, { programId: "prog-1" })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "transition_program_closed",
    });
  });
});

describe("createProgram", () => {
  it("creates the program and auto-posts a 'transition' council consultation", async () => {
    const pool = createPool([
      {
        match: /INSERT INTO public\.transition_programs/,
        result: { rows: [PROGRAM] },
      },
      {
        match: /UPDATE public\.transition_programs/,
        result: { rows: [{ ...PROGRAM, consultation_id: "cons-1" }] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    councilMocks.postConsultation.mockResolvedValue({ id: "cons-1" });

    const result = await createProgram(7, {
      title: "Voluntary exit Q3",
      kind: "voluntary_exit",
      terms: { gratuity_minor: 4_000_000, deficit_forgiveness: true },
    });
    expect(result.consultationId).toBe("cons-1");
    expect(result.program.consultation_id).toBe("cons-1");
    expect(councilMocks.postConsultation).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        kind: "transition",
        payload: expect.objectContaining({ program_id: "prog-1" }),
      }),
    );
  });

  it("never blocks program creation when the council auto-post fails", async () => {
    const pool = createPool([
      {
        match: /INSERT INTO public\.transition_programs/,
        result: { rows: [PROGRAM] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    councilMocks.postConsultation.mockRejectedValue(new Error("db down"));

    const result = await createProgram(7, {
      title: "Voluntary exit Q3",
      kind: "voluntary_exit",
    });
    expect(result.program.id).toBe("prog-1");
    expect(result.consultationId).toBeNull();
  });

  it("rejects a negative gratuity in terms", async () => {
    dbMocks.getPool.mockResolvedValue(createPool([]));
    await expect(
      createProgram(7, {
        title: "Bad",
        kind: "severance",
        terms: { gratuity_minor: -5 },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("advanceEnrollment", () => {
  const inProgress = {
    ...ENROLLMENT,
    status: "in_progress",
    terms: PROGRAM.terms,
  };

  it("records gratuity and waived deficits explicitly on completion", async () => {
    const completed = {
      ...ENROLLMENT,
      status: "completed",
      exit_gratuity_minor: 4_000_000,
      deficits_waived_minor: 1_250_000,
      completed_at: new Date().toISOString(),
    };
    const pool = createPool([
      {
        match: /FROM public\.transition_enrollments e/,
        result: { rows: [inProgress] },
      },
      {
        match: /UPDATE public\.transition_enrollments/,
        result: { rows: [completed] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const row = await advanceEnrollment(7, {
      enrollmentId: "enr-1",
      status: "completed",
      exitGratuityMinor: 4_000_000,
      deficitsWaivedMinor: 1_250_000,
    });
    expect(row.status).toBe("completed");
    expect(Number(row.exit_gratuity_minor)).toBe(4_000_000);
    expect(Number(row.deficits_waived_minor)).toBe(1_250_000);

    const update = pool.calls.find((call) =>
      /UPDATE public\.transition_enrollments/.test(call.text),
    );
    expect(update!.text).toContain("completed_at = now()");
    expect(update!.values).toEqual(["enr-1", 4_000_000, 1_250_000]);
  });

  it("requires an explicit deficitsWaivedMinor when terms carry deficit_forgiveness", async () => {
    const pool = createPool([
      {
        match: /FROM public\.transition_enrollments e/,
        result: { rows: [inProgress] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    await expect(
      advanceEnrollment(7, { enrollmentId: "enr-1", status: "completed" }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "deficits_waived_minor_required_when_deficit_forgiveness",
    });
    expect(
      pool.calls.some((call) =>
        /UPDATE public\.transition_enrollments/.test(call.text),
      ),
    ).toBe(false);
  });

  it("defaults the gratuity from the program terms on completion", async () => {
    const completed = {
      ...ENROLLMENT,
      status: "completed",
      exit_gratuity_minor: 4_000_000,
      deficits_waived_minor: 0,
      completed_at: new Date().toISOString(),
    };
    const pool = createPool([
      {
        match: /FROM public\.transition_enrollments e/,
        result: { rows: [inProgress] },
      },
      {
        match: /UPDATE public\.transition_enrollments/,
        result: { rows: [completed] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const row = await advanceEnrollment(7, {
      enrollmentId: "enr-1",
      status: "completed",
      deficitsWaivedMinor: 0, // explicit zero is a valid answer
    });
    expect(Number(row.exit_gratuity_minor)).toBe(4_000_000);
    const update = pool.calls.find((call) =>
      /UPDATE public\.transition_enrollments/.test(call.text),
    );
    expect(update!.values[1]).toBe(4_000_000);
  });

  it("rejects an invalid transition without writing", async () => {
    const pool = createPool([
      {
        match: /FROM public\.transition_enrollments e/,
        result: { rows: [{ ...ENROLLMENT, terms: PROGRAM.terms }] }, // still 'enrolled'
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    await expect(
      advanceEnrollment(7, {
        enrollmentId: "enr-1",
        status: "completed",
        deficitsWaivedMinor: 0,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      pool.calls.some((call) =>
        /UPDATE public\.transition_enrollments/.test(call.text),
      ),
    ).toBe(false);
  });
});

describe("withdraw", () => {
  it("withdraws the caller's own enrollment", async () => {
    const pool = createPool([
      {
        match: /FROM public\.transition_enrollments\s+WHERE id = \$1 AND worker_id = \$2/,
        result: { rows: [ENROLLMENT] },
      },
      {
        match: /UPDATE public\.transition_enrollments/,
        result: { rows: [{ ...ENROLLMENT, status: "withdrawn" }] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    const row = await withdraw(42, { enrollmentId: "enr-1" });
    expect(row.status).toBe("withdrawn");
  });

  it("cannot withdraw another worker's enrollment (own rows only)", async () => {
    const pool = createPool([
      {
        match: /FROM public\.transition_enrollments\s+WHERE id = \$1 AND worker_id = \$2/,
        result: { rows: [] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    await expect(
      withdraw(43, { enrollmentId: "enr-1" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
