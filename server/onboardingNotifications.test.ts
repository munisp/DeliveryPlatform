import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Audit A P1-8 / cross-cutting 1: onboarding, verification and governance
 * decisions now dispatch notifications through the notification gateway —
 * always fail-open so an outage never blocks the mutation.
 */

const dbMocks = vi.hoisted(() => ({
  getPool: vi.fn(),
}));

const gatewayMocks = vi.hoisted(() => ({
  sendEmail: vi.fn(async () => ({ accepted: true })),
  sendSMS: vi.fn(async () => ({ accepted: true })),
}));

const pgState = vi.hoisted(() => ({
  handlers: [] as Array<{ match: RegExp; result: unknown }>,
  calls: [] as Array<{ text: string; values: unknown[] }>,
}));

vi.mock("../server/db", () => dbMocks);
vi.mock("./_core/notificationGateway", () => gatewayMocks);
vi.mock("pg", () => ({
  Pool: class {
    async query(text: string, values: unknown[] = []) {
      pgState.calls.push({ text, values });
      const handler = pgState.handlers.find((candidate) =>
        candidate.match.test(text),
      );
      if (!handler) return { rows: [], rowCount: 0 };
      return handler.result;
    }
  },
}));

import { postConsultation } from "./_core/workerCouncil";
import { decideDriverApplication } from "./_core/driverOnboarding";
import { decideMerchantOnboarding } from "./_core/merchantCommerce";
import { decideVerificationCase } from "./_core/stakeholderVerification";

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

/** Pool whose handlers are consumed in order (for repeated SQL shapes). */
function createSequentialPool(
  steps: Array<{ match: RegExp; result: QueryResult }>,
) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const queue = [...steps];
  return {
    calls,
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      const index = queue.findIndex((step) => step.match.test(text));
      if (index === -1) return { rows: [], rowCount: 0 };
      const [step] = queue.splice(index, 1);
      return step!.result;
    }),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  pgState.handlers = [];
  pgState.calls = [];
  gatewayMocks.sendEmail.mockResolvedValue({ accepted: true } as never);
  gatewayMocks.sendSMS.mockResolvedValue({ accepted: true } as never);
});

describe("workerCouncil.postConsultation notifications", () => {
  const consultationRow = {
    id: "cons-1",
    kind: "pricing",
    title: "Fare floor change",
    payload: {},
    status: "open",
    posted_by: 1,
    response_sla_at: new Date(Date.now() + 72 * 3600 * 1000),
    activated_at: null,
    created_at: new Date(),
  };

  function councilPool(members: unknown[]) {
    return createPool([
      {
        match: /INSERT INTO public\.consultation_objects/,
        result: { rows: [consultationRow], rowCount: 1 },
      },
      {
        match: /FROM public\.council_members m/,
        result: { rows: members },
      },
    ]);
  }

  it("notifies every active member (email preferred, SMS fallback) with the consultation payload", async () => {
    const pool = councilPool([
      { user_id: 11, email: "m1@example.com", phone: "+2341" },
      { user_id: 12, email: null, phone: "+2342" },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    await postConsultation(1, {
      kind: "pricing",
      title: "Fare floor change",
      payload: {},
      responseSlaHours: 72,
    });

    expect(gatewayMocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(gatewayMocks.sendEmail).toHaveBeenCalledWith(
      "m1@example.com",
      "SwitchOS worker council consultation",
      expect.stringContaining("Fare floor change"),
      expect.objectContaining({
        notificationType: "council.consultation.posted",
        consultationId: "cons-1",
      }),
    );
    expect(gatewayMocks.sendSMS).toHaveBeenCalledTimes(1);
    expect(gatewayMocks.sendSMS).toHaveBeenCalledWith(
      "+2342",
      expect.stringContaining("Fare floor change"),
      expect.objectContaining({ consultationId: "cons-1" }),
    );
  });

  it("is fail-open: a member notification failure never blocks posting", async () => {
    gatewayMocks.sendEmail.mockRejectedValue(new Error("dispatcher down"));
    const pool = councilPool([{ user_id: 11, email: "m1@example.com", phone: null }]);
    dbMocks.getPool.mockResolvedValue(pool);

    await expect(
      postConsultation(1, {
        kind: "pricing",
        title: "Fare floor change",
        payload: {},
        responseSlaHours: 72,
      }),
    ).resolves.toMatchObject({ id: "cons-1" });
  });
});

describe("driverOnboarding.decideApplication notifications", () => {
  const baseRow = {
    id: "app-1",
    user_id: 42,
    status: "in_review",
    verification_case_id: "case-1",
    verification_case_state: "verified",
    full_name: "Adaeze Okafor",
    phone: null,
    city: "Lagos",
    vehicle: { type: "sedan" },
    rejection_reason: null,
    created_at: new Date(),
    updated_at: new Date(),
  };

  it("notifies the applicant on rejection including the reason", async () => {
    const pool = createSequentialPool([
      { match: /FROM public\.driver_applications a/, result: { rows: [baseRow] } },
      {
        match: /SET status = 'rejected'/,
        result: { rows: [{ id: "app-1" }], rowCount: 1 },
      },
      {
        match: /FROM public\.driver_applications a/,
        result: {
          rows: [
            { ...baseRow, status: "rejected", rejection_reason: "Vehicle too old" },
          ],
        },
      },
      {
        match: /SELECT email, phone FROM public\.users/,
        result: { rows: [{ email: "ada@example.com", phone: null }] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const decided = await decideDriverApplication({
      applicationId: "app-1",
      decision: "rejected",
      rejectionReason: "Vehicle too old",
    });

    expect(decided.status).toBe("rejected");
    expect(gatewayMocks.sendEmail).toHaveBeenCalledWith(
      "ada@example.com",
      "SwitchOS driver application decision",
      expect.stringContaining("Vehicle too old"),
      expect.objectContaining({
        notificationType: "driver.application.decided",
        applicationId: "app-1",
        status: "rejected",
      }),
    );
  });

  it("notifies the applicant on approval and is fail-open", async () => {
    gatewayMocks.sendEmail.mockRejectedValue(new Error("dispatcher down"));
    const pool = createSequentialPool([
      { match: /FROM public\.driver_applications a/, result: { rows: [baseRow] } },
      {
        match: /SELECT open_id, name, email FROM public\.users/,
        result: { rows: [{ open_id: "oid-42", name: "Adaeze", email: "ada@example.com" }] },
      },
      { match: /INSERT INTO public\.drivers/, result: { rows: [], rowCount: 1 } },
      {
        match: /SET status = 'approved'/,
        result: { rows: [{ id: "app-1" }], rowCount: 1 },
      },
      {
        match: /FROM public\.driver_applications a/,
        result: { rows: [{ ...baseRow, status: "approved" }] },
      },
      {
        match: /SELECT email, phone FROM public\.users/,
        result: { rows: [{ email: "ada@example.com", phone: null }] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    await expect(
      decideDriverApplication({ applicationId: "app-1", decision: "approved" }),
    ).resolves.toMatchObject({ status: "approved" });
    expect(gatewayMocks.sendEmail).toHaveBeenCalledWith(
      "ada@example.com",
      "SwitchOS driver application decision",
      expect.stringContaining("approved"),
      expect.objectContaining({ status: "approved" }),
    );
  });
});

describe("merchantCommerce.decideMerchantOnboarding notifications", () => {
  it("persists the rejection reason and notifies the owner", async () => {
    pgState.handlers = [
      {
        match: /commerce\.decide_merchant_onboarding/,
        result: { rows: [{ state: "rejected" }], rowCount: 1 },
      },
      {
        match: /SET rejection_reason/,
        result: { rows: [], rowCount: 1 },
      },
      {
        match: /SELECT owner_user_id FROM commerce\.merchant_portal/,
        result: { rows: [{ owner_user_id: 77 }] },
      },
      {
        match: /SELECT email, phone FROM public\.users/,
        result: { rows: [{ email: "owner@example.com", phone: null }] },
      },
    ];

    const result = await decideMerchantOnboarding({
      actorUserId: 1,
      providerId: 5,
      decision: "reject",
      verificationCaseId: null,
      rejectionReason: "Beneficial owner check failed",
      idempotencyKey: "merchant-decide-0001",
    });

    expect(result.state).toBe("rejected");
    const reasonUpdate = pgState.calls.find((call) =>
      /SET rejection_reason/.test(call.text),
    );
    expect(reasonUpdate?.values).toEqual([5, "Beneficial owner check failed"]);
    expect(gatewayMocks.sendEmail).toHaveBeenCalledWith(
      "owner@example.com",
      "SwitchOS merchant onboarding decision",
      expect.stringContaining("Beneficial owner check failed"),
      expect.objectContaining({
        notificationType: "merchant.onboarding.decided",
        decision: "reject",
      }),
    );
  });

  it("is fail-open: a gateway outage never blocks the decision", async () => {
    gatewayMocks.sendEmail.mockRejectedValue(new Error("dispatcher down"));
    gatewayMocks.sendSMS.mockRejectedValue(new Error("dispatcher down"));
    pgState.handlers = [
      {
        match: /commerce\.decide_merchant_onboarding/,
        result: { rows: [{ state: "active" }], rowCount: 1 },
      },
      {
        match: /SELECT owner_user_id FROM commerce\.merchant_portal/,
        result: { rows: [{ owner_user_id: 77 }] },
      },
      {
        match: /SELECT email, phone FROM public\.users/,
        result: { rows: [{ email: "owner@example.com", phone: null }] },
      },
    ];

    await expect(
      decideMerchantOnboarding({
        actorUserId: 1,
        providerId: 5,
        decision: "activate",
        verificationCaseId: "11111111-1111-1111-1111-111111111111",
        idempotencyKey: "merchant-decide-0002",
      }),
    ).resolves.toEqual({ state: "active" });
  });
});

describe("stakeholderVerification.decideVerificationCase notifications", () => {
  it("notifies the case subject of the decision", async () => {
    pgState.handlers = [
      {
        match: /verification\.decide_case/,
        result: { rows: [{ state: "rejected" }], rowCount: 1 },
      },
      {
        match: /FROM verification\.verification_case WHERE id/,
        result: {
          rows: [
            { subject_user_id: 42, subject_type: "driver", subject_key: "driver-application-1" },
          ],
        },
      },
      {
        match: /SELECT email, phone FROM public\.users/,
        result: { rows: [{ email: "subject@example.com", phone: null }] },
      },
    ];

    const state = await decideVerificationCase({
      actorUserId: 1,
      caseId: "11111111-1111-1111-1111-111111111111",
      decision: "reject",
      reason: "Document mismatch",
      idempotencyKey: "verification-decide-01",
    });

    expect(state).toBe("rejected");
    expect(gatewayMocks.sendEmail).toHaveBeenCalledWith(
      "subject@example.com",
      "SwitchOS verification decision",
      expect.stringContaining("rejected"),
      expect.objectContaining({
        notificationType: "verification.case.decided",
        caseId: "11111111-1111-1111-1111-111111111111",
      }),
    );
  });

  it("is fail-open: a gateway outage never blocks the decision", async () => {
    gatewayMocks.sendEmail.mockRejectedValue(new Error("dispatcher down"));
    pgState.handlers = [
      {
        match: /verification\.decide_case/,
        result: { rows: [{ state: "verified" }], rowCount: 1 },
      },
      {
        match: /FROM verification\.verification_case WHERE id/,
        result: {
          rows: [{ subject_user_id: 42, subject_type: "driver", subject_key: "k" }],
        },
      },
      {
        match: /SELECT email, phone FROM public\.users/,
        result: { rows: [{ email: "subject@example.com", phone: null }] },
      },
    ];

    await expect(
      decideVerificationCase({
        actorUserId: 1,
        caseId: "11111111-1111-1111-1111-111111111111",
        decision: "verify",
        reason: "All checks passed",
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        idempotencyKey: "verification-decide-02",
      }),
    ).resolves.toBe("verified");
  });
});
