import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getPool: vi.fn(),
}));
const councilMocks = vi.hoisted(() => ({
  postConsultation: vi.fn(),
}));
const fetchMocks = vi.hoisted(() => ({
  resilientFetch: vi.fn(),
  // Mirrors the FAIL_OPEN_FAST preset shape (merged to main with PR #46);
  // the mocked resilientFetch ignores the options either way.
  FAIL_OPEN_FAST: { timeoutMs: 1_500 },
}));

vi.mock("../server/db", () => dbMocks);
vi.mock("../server/_core/workerCouncil", () => councilMocks);
vi.mock("../server/_core/resilientFetch", () => fetchMocks);

import {
  getMyStanding,
  grantReward,
  listRewardRules,
  nextStreakState,
  recordIntegrityEvent,
  revokeReward,
  upsertRewardRule,
} from "./_core/integrityIncentives";

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

const EVENT = {
  id: "evt-1",
  user_id: 42,
  role: "driver",
  event_type: "verified_completion",
  trip_id: 9001,
  detail: {},
  created_at: new Date().toISOString(),
};

const STREAK = {
  id: "streak-1",
  user_id: 42,
  role: "driver",
  current_streak: 3,
  longest_streak: 5,
  last_event_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const RULE = {
  id: "rule-1",
  role: "driver",
  rule_key: "streak-3-credit",
  threshold_streak: 3,
  reward_type: "credit",
  amount_minor: 50000,
  currency: "NGN",
  active: true,
  published_at: new Date().toISOString(),
};

beforeEach(() => {
  vi.resetAllMocks();
  fetchMocks.resilientFetch.mockRejectedValue(new Error("connection refused"));
});

describe("nextStreakState (pure)", () => {
  it("increments current streak and raises longest when exceeded", () => {
    expect(
      nextStreakState({ currentStreak: 2, longestStreak: 2 }, "verified_completion"),
    ).toEqual({ currentStreak: 3, longestStreak: 3, streakReset: false });
  });

  it("keeps longest streak when current stays below it", () => {
    expect(
      nextStreakState({ currentStreak: 1, longestStreak: 9 }, "verified_manifest"),
    ).toEqual({ currentStreak: 2, longestStreak: 9, streakReset: false });
  });

  it("resets current streak on violation while preserving longest", () => {
    expect(
      nextStreakState({ currentStreak: 7, longestStreak: 7 }, "violation"),
    ).toEqual({ currentStreak: 0, longestStreak: 7, streakReset: true });
  });

  it("leaves the streak unchanged for non-streak events", () => {
    expect(
      nextStreakState({ currentStreak: 4, longestStreak: 4 }, "reward_granted"),
    ).toEqual({ currentStreak: 4, longestStreak: 4, streakReset: false });
  });
});

describe("listRewardRules (published transparency)", () => {
  it("returns the published rules without any user scoping", async () => {
    const pool = createPool([
      {
        match: /FROM public\.integrity_reward_rules\s+ORDER BY role/,
        result: { rows: [RULE] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const rules = await listRewardRules();
    expect(rules).toEqual([RULE]);
    expect(pool.calls[0].values).toEqual([]);
  });
});

describe("recordIntegrityEvent", () => {
  it("increments the streak and grants a reward exactly at threshold", async () => {
    const pool = createPool([
      { match: /detail ->> 'idempotency_key'/, result: { rows: [] } },
      { match: /INSERT INTO public\.integrity_events/, result: { rows: [EVENT] } },
      { match: /INSERT INTO public\.integrity_streaks/, result: { rows: [STREAK] } },
      {
        match: /FROM public\.integrity_reward_rules\s+WHERE role/,
        result: { rows: [RULE] },
      },
      {
        match: /INSERT INTO public\.integrity_rewards/,
        result: {
          rows: [
            {
              id: "reward-1",
              user_id: 42,
              rule_id: "rule-1",
              amount_minor: 50000,
              currency: "NGN",
              status: "pending",
              idempotency_key: "evt-1:rule-1",
            },
          ],
        },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const result = await recordIntegrityEvent(7, {
      userId: 42,
      role: "driver",
      eventType: "verified_completion",
      tripId: 9001,
      idempotencyKey: "trip-9001-completion",
    });

    expect(result.duplicate).toBe(false);
    expect(result.streak?.current_streak).toBe(3);
    expect(result.rewardsGranted).toHaveLength(1);
    expect(result.rewardsGranted[0].status).toBe("pending");

    // Rule evaluation targets the NEW current streak (3).
    const rulesCall = pool.calls.find((call) =>
      /FROM public\.integrity_reward_rules\s+WHERE role/.test(call.text),
    );
    expect(rulesCall!.values).toEqual(["driver", 3]);

    // Reward idempotency key is `${eventId}:${ruleId}` — no double grants.
    const rewardCall = pool.calls.find((call) =>
      /INSERT INTO public\.integrity_rewards/.test(call.text),
    );
    expect(rewardCall!.values[4]).toBe("evt-1:rule-1");
    expect(rewardCall!.text).toContain("ON CONFLICT (idempotency_key) DO NOTHING");
  });

  it("grants nothing when no active rule matches the new streak", async () => {
    const pool = createPool([
      { match: /INSERT INTO public\.integrity_events/, result: { rows: [EVENT] } },
      { match: /INSERT INTO public\.integrity_streaks/, result: { rows: [STREAK] } },
      {
        match: /FROM public\.integrity_reward_rules\s+WHERE role/,
        result: { rows: [] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const result = await recordIntegrityEvent(7, {
      userId: 42,
      role: "driver",
      eventType: "verified_completion",
    });
    expect(result.rewardsGranted).toEqual([]);
    expect(
      pool.calls.some((call) => /INSERT INTO public\.integrity_rewards/.test(call.text)),
    ).toBe(false);
  });

  it("resets the streak on violation and logs a streak_reset audit event", async () => {
    const pool = createPool([
      {
        match: /INSERT INTO public\.integrity_events/,
        result: { rows: [{ ...EVENT, event_type: "violation" }] },
      },
      {
        match: /INSERT INTO public\.integrity_streaks/,
        result: { rows: [{ ...STREAK, current_streak: 0 }] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const result = await recordIntegrityEvent(7, {
      userId: 42,
      role: "driver",
      eventType: "violation",
      detail: { reason: "offline_deal_solicited" },
    });
    expect(result.streak?.current_streak).toBe(0);
    expect(result.rewardsGranted).toEqual([]);

    const eventInserts = pool.calls.filter((call) =>
      /INSERT INTO public\.integrity_events/.test(call.text),
    );
    expect(eventInserts).toHaveLength(2); // violation + streak_reset
    expect(eventInserts[1].text).toContain("'streak_reset'");
  });

  it("deduplicates by idempotencyKey: a replayed event grants once", async () => {
    const pool = createPool([
      { match: /detail ->> 'idempotency_key'/, result: { rows: [EVENT] } },
      { match: /FROM public\.integrity_streaks WHERE user_id/, result: { rows: [STREAK] } },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const result = await recordIntegrityEvent(7, {
      userId: 42,
      role: "driver",
      eventType: "verified_completion",
      idempotencyKey: "trip-9001-completion",
    });
    expect(result.duplicate).toBe(true);
    expect(result.event.id).toBe("evt-1");
    expect(result.rewardsGranted).toEqual([]);
    expect(
      pool.calls.some((call) => /INSERT INTO public\.integrity_events/.test(call.text)),
    ).toBe(false);
    expect(
      pool.calls.some((call) => /INSERT INTO public\.integrity_rewards/.test(call.text)),
    ).toBe(false);
  });

  it("fails open when the incentives worker is unreachable", async () => {
    const pool = createPool([
      { match: /INSERT INTO public\.integrity_events/, result: { rows: [EVENT] } },
      { match: /INSERT INTO public\.integrity_streaks/, result: { rows: [STREAK] } },
      {
        match: /FROM public\.integrity_reward_rules\s+WHERE role/,
        result: { rows: [] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    fetchMocks.resilientFetch.mockRejectedValue(new Error("connection refused"));

    const result = await recordIntegrityEvent(7, {
      userId: 42,
      role: "driver",
      eventType: "verified_completion",
    });
    expect(result.workerEvaluated).toBe(false);
    expect(result.event.id).toBe("evt-1");
  });

  it("notifies the incentives worker when it is reachable", async () => {
    const pool = createPool([
      { match: /INSERT INTO public\.integrity_events/, result: { rows: [EVENT] } },
      { match: /INSERT INTO public\.integrity_streaks/, result: { rows: [STREAK] } },
      {
        match: /FROM public\.integrity_reward_rules\s+WHERE role/,
        result: { rows: [] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    fetchMocks.resilientFetch.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    const result = await recordIntegrityEvent(7, {
      userId: 42,
      role: "driver",
      eventType: "verified_completion",
    });
    expect(result.workerEvaluated).toBe(true);
    const [url, init] = fetchMocks.resilientFetch.mock.calls[0];
    expect(url).toContain("/incentives/evaluate");
    const body = JSON.parse((init as { body: string }).body);
    expect(body.streak_state).toMatchObject({
      user_id: 42,
      role: "driver",
      current_streak: 3,
    });
  });
});

describe("upsertRewardRule", () => {
  it("requires amount_minor for credit rules", async () => {
    dbMocks.getPool.mockResolvedValue(createPool([]));
    await expect(
      upsertRewardRule(7, {
        role: "driver",
        ruleKey: "streak-3-credit",
        thresholdStreak: 3,
        rewardType: "credit",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("upserts the rule and auto-posts an advisory council consultation", async () => {
    const pool = createPool([
      {
        match: /INSERT INTO public\.integrity_reward_rules/,
        result: { rows: [RULE] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    councilMocks.postConsultation.mockResolvedValue({ id: "cons-1" });

    const result = await upsertRewardRule(7, {
      role: "driver",
      ruleKey: "streak-3-credit",
      thresholdStreak: 3,
      rewardType: "credit",
      amountMinor: 50000,
    });
    expect(result.rule.id).toBe("rule-1");
    expect(result.consultationId).toBe("cons-1");
    expect(councilMocks.postConsultation).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ kind: "other" }),
    );
  });

  it("never blocks when the council auto-post fails", async () => {
    const pool = createPool([
      {
        match: /INSERT INTO public\.integrity_reward_rules/,
        result: { rows: [RULE] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    councilMocks.postConsultation.mockRejectedValue(new Error("db down"));

    const result = await upsertRewardRule(7, {
      role: "driver",
      ruleKey: "streak-3-credit",
      thresholdStreak: 3,
      rewardType: "credit",
      amountMinor: 50000,
    });
    expect(result.rule.id).toBe("rule-1");
    expect(result.consultationId).toBeNull();
  });
});

describe("grantReward / revokeReward", () => {
  const PENDING_REWARD = {
    id: "reward-1",
    user_id: 42,
    rule_id: "rule-1",
    amount_minor: 50000,
    currency: "NGN",
    status: "granted",
    granted_at: new Date().toISOString(),
  };

  it("grants a pending reward and logs a reward_granted event", async () => {
    const pool = createPool([
      {
        match: /UPDATE public\.integrity_rewards/,
        result: { rows: [PENDING_REWARD] },
      },
      { match: /INSERT INTO public\.integrity_events/, result: { rows: [] } },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const row = await grantReward(7, { rewardId: "reward-1" });
    expect(row.status).toBe("granted");
    const updateCall = pool.calls.find((call) =>
      /UPDATE public\.integrity_rewards/.test(call.text),
    );
    expect(updateCall!.text).toContain("status = 'granted'");
    expect(updateCall!.text).toContain("WHERE id = $1 AND status = 'pending'");
    expect(
      pool.calls.some((call) => /INSERT INTO public\.integrity_events/.test(call.text)),
    ).toBe(true);
  });

  it("rejects granting a reward that is not pending", async () => {
    const pool = createPool([
      {
        match: /UPDATE public\.integrity_rewards/, result: { rows: [] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    await expect(grantReward(7, { rewardId: "reward-1" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("revokes a granted reward", async () => {
    const pool = createPool([
      {
        match: /UPDATE public\.integrity_rewards\s+SET status = 'revoked'/,
        result: { rows: [{ ...PENDING_REWARD, status: "revoked" }] },
      },
      { match: /UPDATE public\.integrity_events/, result: { rows: [] } },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const row = await revokeReward(7, { rewardId: "reward-1", reason: "fraud" });
    expect(row.status).toBe("revoked");
  });

  it("rejects revoking an already-revoked reward", async () => {
    const pool = createPool([
      {
        match: /UPDATE public\.integrity_rewards\s+SET status = 'revoked'/,
        result: { rows: [] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);
    await expect(revokeReward(7, { rewardId: "reward-1" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});

describe("getMyStanding", () => {
  it("returns streaks, rewards and recent events scoped to the user", async () => {
    const pool = createPool([
      { match: /FROM public\.integrity_streaks\s+WHERE user_id/, result: { rows: [STREAK] } },
      { match: /FROM public\.integrity_rewards\s+WHERE user_id/, result: { rows: [] } },
      { match: /FROM public\.integrity_events\s+WHERE user_id/, result: { rows: [EVENT] } },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const standing = await getMyStanding(42);
    expect(standing.streaks).toEqual([STREAK]);
    expect(standing.recentEvents).toEqual([EVENT]);
    for (const call of pool.calls) {
      expect(call.values[0]).toBe(42);
    }
  });
});
