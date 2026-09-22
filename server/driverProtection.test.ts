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
  acceptRemittanceChange,
  canEnforceRemittance,
  decideClaim,
  enroll,
  fileClaim,
  getMyRemittanceSchedule,
  getPolicy,
  invalidateProtectionPolicyCache,
  listMaintenanceProviders,
  notifyRemittanceChange,
  optOut,
  requestMediation,
  upsertPolicy,
} from "./_core/driverProtection";

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

const POLICY = {
  id: "policy-1",
  market_id: "lagos",
  micro_premium_minor: 2500,
  downtime_daily_stipend_minor: 1500000,
  protection_levy_minor: 1000,
  opt_out_allowed: true,
  active: true,
  consultation_id: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const ENROLLMENT = {
  id: "enroll-1",
  driver_id: 42,
  policy_id: "policy-1",
  status: "enrolled",
  enrolled_at: new Date().toISOString(),
  opt_out_at: null,
};

const SCHEDULE = {
  id: "sched-1",
  driver_id: 42,
  vehicle_contract_ref: "va-abc123",
  amount_minor: 5000000,
  currency: "NGN",
  frequency: "weekly",
  next_due_at: new Date().toISOString(),
  status: "current",
  version: 1,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const NOTICE = {
  id: "notice-1",
  schedule_id: "sched-1",
  old_amount_minor: 5000000,
  new_amount_minor: 5500000,
  effective_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  requires_reacceptance: true,
  accepted_at: null,
  mediation_window_ends_at: new Date(
    Date.now() + 21 * 86_400_000,
  ).toISOString(),
  created_at: new Date().toISOString(),
};

beforeEach(() => {
  vi.resetAllMocks();
  invalidateProtectionPolicyCache(); // hot-read cache must not leak between tests
});

describe("canEnforceRemittance (pure gate)", () => {
  it("is enforceable when there is no pending change notice", () => {
    expect(canEnforceRemittance({ status: "current" }, null)).toBe(true);
  });

  it("blocks enforcement after notice before acceptance and before window expiry", () => {
    const now = new Date();
    expect(
      canEnforceRemittance(
        { status: "renegotiating" },
        {
          requires_reacceptance: true,
          accepted_at: null,
          mediation_window_ends_at: new Date(
            now.getTime() + 86_400_000,
          ).toISOString(),
        },
        now,
      ),
    ).toBe(false);
  });

  it("allows enforcement once the driver accepted", () => {
    expect(
      canEnforceRemittance(
        { status: "current" },
        {
          requires_reacceptance: true,
          accepted_at: new Date().toISOString(),
          mediation_window_ends_at: new Date(
            Date.now() + 86_400_000,
          ).toISOString(),
        },
      ),
    ).toBe(true);
  });

  it("allows enforcement after the mediation window expired", () => {
    const now = new Date();
    expect(
      canEnforceRemittance(
        { status: "mediation" },
        {
          requires_reacceptance: true,
          accepted_at: null,
          mediation_window_ends_at: new Date(
            now.getTime() - 1_000,
          ).toISOString(),
        },
        now,
      ),
    ).toBe(true);
  });

  it("is enforceable when the notice does not require re-acceptance", () => {
    expect(
      canEnforceRemittance(
        { status: "current" },
        {
          requires_reacceptance: false,
          accepted_at: null,
          mediation_window_ends_at: null,
        },
      ),
    ).toBe(true);
  });

  it("blocks enforcement when no mediation window exists and nothing was accepted", () => {
    expect(
      canEnforceRemittance(
        { status: "renegotiating" },
        {
          requires_reacceptance: true,
          accepted_at: null,
          mediation_window_ends_at: null,
        },
      ),
    ).toBe(false);
  });
});

describe("enroll / optOut", () => {
  it("enrolls a driver into the market policy", async () => {
    const pool = createPool([
      {
        match: /FROM public\.protection_policies WHERE market_id/,
        result: { rows: [POLICY] },
      },
      {
        match: /INSERT INTO public\.protection_enrollments/,
        result: { rows: [ENROLLMENT] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const result = await enroll(42, { marketId: "lagos" });
    expect(result.enrollment.status).toBe("enrolled");
    expect(result.policy.market_id).toBe("lagos");
  });

  it("rejects enrollment when the market has no active policy", async () => {
    const pool = createPool([
      {
        match: /FROM public\.protection_policies WHERE market_id/,
        result: { rows: [] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    await expect(enroll(42, { marketId: "kano" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("blocks opt-out when the policy does not allow it", async () => {
    const pool = createPool([
      {
        match: /FROM public\.protection_enrollments e/,
        result: { rows: [{ ...ENROLLMENT, policy_id_ref: POLICY.id }] },
      },
      {
        match: /FROM public\.protection_policies WHERE id/,
        result: { rows: [{ ...POLICY, opt_out_allowed: false }] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    await expect(optOut(42)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("opts out when the policy allows it", async () => {
    const pool = createPool([
      {
        match: /FROM public\.protection_enrollments e/,
        result: { rows: [{ ...ENROLLMENT, policy_id_ref: POLICY.id }] },
      },
      {
        match: /FROM public\.protection_policies WHERE id/,
        result: { rows: [POLICY] },
      },
      {
        match: /UPDATE public\.protection_enrollments/,
        result: {
          rows: [
            {
              ...ENROLLMENT,
              status: "opted_out",
              opt_out_at: new Date().toISOString(),
            },
          ],
        },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const row = await optOut(42);
    expect(row.status).toBe("opted_out");
    expect(row.opt_out_at).not.toBeNull();
  });
});

describe("claims lifecycle", () => {
  const enrollmentHandlers = () => [
    {
      match: /FROM public\.protection_enrollments e/,
      result: { rows: [{ ...ENROLLMENT, policy_id_ref: POLICY.id }] },
    },
    {
      match: /FROM public\.protection_policies WHERE id/,
      result: { rows: [POLICY] },
    },
  ];

  it("requires an active enrollment to file a claim", async () => {
    const pool = createPool([
      {
        match: /FROM public\.protection_enrollments e/,
        result: {
          rows: [
            { ...ENROLLMENT, status: "opted_out", policy_id_ref: POLICY.id },
          ],
        },
      },
      {
        match: /FROM public\.protection_policies WHERE id/,
        result: { rows: [POLICY] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    await expect(
      fileClaim(42, { kind: "accident_downtime" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("files a claim as filed", async () => {
    const pool = createPool([
      ...enrollmentHandlers(),
      {
        match: /INSERT INTO public\.protection_claims/,
        result: {
          rows: [
            {
              id: "claim-1",
              enrollment_id: ENROLLMENT.id,
              kind: "accident_downtime",
              status: "filed",
              amount_minor: 3000000,
              currency: "NGN",
            },
          ],
        },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const claim = await fileClaim(42, {
      kind: "accident_downtime",
      amountMinor: 3000000,
      evidence: { police_report: "obj-key-1" },
    });
    expect(claim.status).toBe("filed");
  });

  it("walks filed -> approved -> paid", async () => {
    const filedClaim = {
      id: "claim-1",
      enrollment_id: ENROLLMENT.id,
      kind: "accident_downtime",
      status: "filed",
      amount_minor: null,
      currency: "NGN",
    };
    const pool = createPool([
      { match: /FROM public\.protection_claims WHERE id/, result: { rows: [filedClaim] } },
      {
        match: /UPDATE public\.protection_claims/,
        result: { rows: [{ ...filedClaim, status: "approved", amount_minor: 3000000 }] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const approved = await decideClaim(7, {
      claimId: "claim-1",
      decision: "approved",
      amountMinor: 3000000,
    });
    expect(approved.status).toBe("approved");

    // Now the stored claim is approved; pay it out.
    pool.calls.length = 0;
    const pool2 = createPool([
      {
        match: /FROM public\.protection_claims WHERE id/,
        result: { rows: [{ ...filedClaim, status: "approved", amount_minor: 3000000 }] },
      },
      {
        match: /UPDATE public\.protection_claims/,
        result: { rows: [{ ...filedClaim, status: "paid", amount_minor: 3000000 }] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool2);

    const paid = await decideClaim(7, { claimId: "claim-1", decision: "paid" });
    expect(paid.status).toBe("paid");
    const updateCall = pool2.calls.find((call) =>
      /UPDATE public\.protection_claims/.test(call.text),
    );
    expect(updateCall!.values[2]).toBe(7); // decided_by
  });

  it("rejects an invalid transition (filed -> paid)", async () => {
    const pool = createPool([
      {
        match: /FROM public\.protection_claims WHERE id/,
        result: {
          rows: [
            {
              id: "claim-1",
              enrollment_id: ENROLLMENT.id,
              kind: "other",
              status: "filed",
            },
          ],
        },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    await expect(
      decideClaim(7, { claimId: "claim-1", decision: "paid" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      pool.calls.some((call) => /UPDATE public\.protection_claims/.test(call.text)),
    ).toBe(false);
  });
});

describe("upsertPolicy", () => {
  it("upserts the market policy and auto-posts an advisory council consultation", async () => {
    const pool = createPool([
      {
        match: /INSERT INTO public\.protection_policies/,
        result: { rows: [POLICY] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    councilMocks.postConsultation.mockResolvedValue({ id: "cons-9" });

    const result = await upsertPolicy(7, {
      marketId: "lagos",
      microPremiumMinor: 2500,
      downtimeDailyStipendMinor: 1500000,
      protectionLevyMinor: 1000,
    });
    expect(result.policy.id).toBe("policy-1");
    expect(result.consultationId).toBe("cons-9");
    expect(councilMocks.postConsultation).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        kind: "other",
        payload: expect.objectContaining({ market_id: "lagos" }),
      }),
    );
  });

  it("never blocks when the council auto-post fails", async () => {
    const pool = createPool([
      {
        match: /INSERT INTO public\.protection_policies/,
        result: { rows: [POLICY] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    councilMocks.postConsultation.mockRejectedValue(new Error("db down"));

    const result = await upsertPolicy(7, { marketId: "lagos" });
    expect(result.policy.id).toBe("policy-1");
    expect(result.consultationId).toBeNull();
  });
});

describe("listMaintenanceProviders", () => {
  it("filters by city and orders vetted-first then by name", async () => {
    const pool = createPool([
      {
        match: /FROM public\.maintenance_providers\s+WHERE lower\(city\)/,
        result: { rows: [] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    await listMaintenanceProviders({ city: "Lagos" });
    const call = pool.calls[0];
    expect(call.values).toEqual(["Lagos"]);
    expect(call.text).toContain("ORDER BY vetted DESC, name ASC");
  });
});

describe("remittance notices", () => {
  it("notifyRemittanceChange opens a 14-day mediation window from effective_at and marks the schedule renegotiating", async () => {
    const effectiveAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const pool = createPool([
      {
        match: /FROM public\.remittance_schedules WHERE id/,
        result: { rows: [SCHEDULE] },
      },
      { match: /INSERT INTO public\.remittance_change_notices/, result: { rows: [NOTICE] } },
      {
        match: /UPDATE public\.remittance_schedules/,
        result: { rows: [{ ...SCHEDULE, status: "renegotiating" }] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const result = await notifyRemittanceChange(7, {
      scheduleId: "sched-1",
      newAmountMinor: 5500000,
      effectiveAt,
    });
    expect(result.schedule.status).toBe("renegotiating");

    const insertCall = pool.calls.find((call) =>
      /INSERT INTO public\.remittance_change_notices/.test(call.text),
    );
    // mediation_window_ends_at = effective_at + 14 days
    expect(insertCall!.text).toContain("$4::timestamptz + interval '14 days'");
    expect(insertCall!.values).toEqual([
      "sched-1",
      5000000, // old amount from the schedule
      5500000,
      effectiveAt,
    ]);
  });

  it("acceptRemittanceChange stamps the notice and writes the version+1 schedule row", async () => {
    const pool = createPool([
      {
        match: /FROM public\.remittance_change_notices n/,
        result: { rows: [NOTICE] },
      },
      {
        match: /FROM public\.remittance_schedules WHERE id/,
        result: { rows: [{ ...SCHEDULE, status: "renegotiating" }] },
      },
      {
        match: /UPDATE public\.remittance_change_notices/,
        result: { rows: [{ ...NOTICE, accepted_at: new Date().toISOString() }] },
      },
      {
        match: /INSERT INTO public\.remittance_schedules/,
        result: {
          rows: [
            {
              ...SCHEDULE,
              id: "sched-2",
              amount_minor: 5500000,
              status: "current",
              version: 2,
            },
          ],
        },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const result = await acceptRemittanceChange(42, { noticeId: "notice-1" });
    expect(result.notice.accepted_at).not.toBeNull();
    expect(result.schedule.version).toBe(2);
    expect(result.schedule.status).toBe("current");

    const versionCall = pool.calls.find((call) =>
      /INSERT INTO public\.remittance_schedules/.test(call.text),
    );
    expect(versionCall!.values[2]).toBe(5500000); // new amount
    expect(versionCall!.values[6]).toBe(2); // version + 1
  });

  it("rejects accepting a notice twice", async () => {
    const pool = createPool([
      {
        match: /FROM public\.remittance_change_notices n/,
        result: { rows: [{ ...NOTICE, accepted_at: new Date().toISOString() }] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    await expect(
      acceptRemittanceChange(42, { noticeId: "notice-1" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects accepting another driver's notice", async () => {
    const pool = createPool([
      { match: /FROM public\.remittance_change_notices n/, result: { rows: [] } },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    await expect(
      acceptRemittanceChange(43, { noticeId: "notice-1" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("requestMediation moves the schedule to mediation and extends the window by 14 days from now", async () => {
    const pool = createPool([
      {
        match: /FROM public\.remittance_schedules\s+WHERE id = \$1 AND driver_id = \$2/,
        result: { rows: [{ ...SCHEDULE, status: "renegotiating" }] },
      },
      {
        match: /UPDATE public\.remittance_schedules/,
        result: { rows: [{ ...SCHEDULE, status: "mediation" }] },
      },
      {
        match: /UPDATE public\.remittance_change_notices/,
        result: {
          rows: [
            {
              ...NOTICE,
              mediation_window_ends_at: new Date(
                Date.now() + 14 * 86_400_000,
              ).toISOString(),
            },
          ],
        },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const result = await requestMediation(42, { scheduleId: "sched-1" });
    expect(result.schedule.status).toBe("mediation");
    const noticeCall = pool.calls.find((call) =>
      /UPDATE public\.remittance_change_notices/.test(call.text),
    );
    expect(noticeCall!.text).toContain("now() + interval '14 days'");
    expect(result.notice?.mediation_window_ends_at).not.toBeNull();
  });

  it("requestMediation requires a schedule under renegotiation", async () => {
    const pool = createPool([
      {
        match: /FROM public\.remittance_schedules\s+WHERE id = \$1 AND driver_id = \$2/,
        result: { rows: [SCHEDULE] }, // status 'current'
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    await expect(
      requestMediation(42, { scheduleId: "sched-1" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("getMyRemittanceSchedule returns the latest version with its latest notice", async () => {
    const pool = createPool([
      {
        match: /FROM public\.remittance_schedules\s+WHERE driver_id/,
        result: { rows: [SCHEDULE] },
      },
      {
        match: /FROM public\.remittance_change_notices\s+WHERE schedule_id/,
        result: { rows: [NOTICE] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const result = await getMyRemittanceSchedule(42);
    expect(result?.schedule.id).toBe("sched-1");
    expect(result?.latestNotice?.id).toBe("notice-1");
    const scheduleCall = pool.calls.find((call) =>
      /FROM public\.remittance_schedules\s+WHERE driver_id/.test(call.text),
    );
    expect(scheduleCall!.text).toContain("ORDER BY version DESC");
  });
});

describe("protection policy hot-read cache", () => {
  it("serves repeated getPolicy reads from cache (one DB query)", async () => {
    const pool = createPool([
      {
        match: /FROM public\.protection_policies WHERE market_id/,
        result: { rows: [POLICY] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const first = await getPolicy("lagos");
    const second = await getPolicy("lagos");
    expect(first?.id).toBe("policy-1");
    expect(second).toEqual(first);
    expect(
      pool.calls.filter((call) =>
        /FROM public\.protection_policies WHERE market_id/.test(call.text),
      ),
    ).toHaveLength(1);
  });

  it("caches the null (no policy) result", async () => {
    const pool = createPool([
      {
        match: /FROM public\.protection_policies WHERE market_id/,
        result: { rows: [] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    expect(await getPolicy("kano")).toBeNull();
    expect(await getPolicy("kano")).toBeNull();
    expect(
      pool.calls.filter((call) =>
        /FROM public\.protection_policies WHERE market_id/.test(call.text),
      ),
    ).toHaveLength(1);
  });

  it("upsertPolicy invalidates the cached policy for the market", async () => {
    const pool = createPool([
      {
        match: /SELECT \* FROM public\.protection_policies WHERE market_id/,
        result: { rows: [POLICY] },
      },
      {
        match: /INSERT INTO public\.protection_policies/,
        result: { rows: [{ ...POLICY, micro_premium_minor: 3000 }] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    councilMocks.postConsultation.mockResolvedValue({ id: "cons-1" });

    await getPolicy("lagos"); // prime cache
    await upsertPolicy(7, { marketId: "lagos", microPremiumMinor: 3000 });
    await getPolicy("lagos"); // must re-read after invalidation
    expect(
      pool.calls.filter((call) =>
        /SELECT \* FROM public\.protection_policies WHERE market_id/.test(call.text),
      ),
    ).toHaveLength(2);
  });

  it("invalidation is scoped per market", async () => {
    const pool = createPool([
      {
        match: /FROM public\.protection_policies WHERE market_id/,
        result: { rows: [POLICY] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    await getPolicy("lagos");
    await getPolicy("kano"); // cached null
    invalidateProtectionPolicyCache("lagos");
    await getPolicy("lagos"); // re-reads
    await getPolicy("kano"); // still cached
    expect(
      pool.calls.filter((call) =>
        /FROM public\.protection_policies WHERE market_id/.test(call.text),
      ),
    ).toHaveLength(3);
  });
});
