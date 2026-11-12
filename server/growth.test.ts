import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P5-PILOT growth surface tests. The DB is mocked at the module boundary
 * (merchant-selfserve.test.ts pattern): the db.ts growth engine functions
 * (applyReferralCode, campaign CRUD, leaderboard reads, loyalty account) and
 * getPool are vi.fn()s, resolvePublicUser is mocked at the publicUsers
 * boundary, and checkPolicy is mocked at the policy boundary so operator
 * authz can be exercised deterministically.
 *
 * The idempotency replay / double-apply cases simulate the engine's
 * customer_referrals FOR UPDATE + ledger semantics (db.ts:1672-1768) at the
 * mock boundary: same-key replays return the stored response, a second
 * apply with a different code rejects.
 */

const dbMocks = vi.hoisted(() => ({
  applyReferralCode: vi.fn(),
  createCampaign: vi.fn(),
  getCampaigns: vi.fn(),
  getCurrentLeaderboardPeriod: vi.fn(),
  getLoyaltyAccount: vi.fn(),
  getLoyaltyRewards: vi.fn(),
  getLoyaltyStats: vi.fn(),
  getPool: vi.fn(),
  getReferralLeaderboard: vi.fn(),
  updateCampaign: vi.fn(),
}));

const publicUserMocks = vi.hoisted(() => ({
  resolvePublicUser: vi.fn(),
}));

const policyMocks = vi.hoisted(() => ({
  checkPolicy: vi.fn(),
}));

vi.mock("../server/db", () => dbMocks);
vi.mock("../server/_core/publicUsers", () => publicUserMocks);
vi.mock("../server/_core/policy", () => policyMocks);

import { growthRouter } from "./_core/growthRouter";

type QueryResult = { rows: unknown[]; rowCount?: number };
type Handler = {
  match: RegExp;
  result?: QueryResult | ((text: string, values: unknown[]) => QueryResult);
  error?: { code: string; message: string };
};

function createPool(handlers: Handler[]) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const dispatch = async (text: string, values: unknown[] = []) => {
    calls.push({ text, values });
    const handler = handlers.find((candidate) => candidate.match.test(text));
    if (!handler) return { rows: [], rowCount: 0 };
    if (handler.error) {
      const err = new Error(handler.error.message) as Error & { code: string };
      err.code = handler.error.code;
      throw err;
    }
    return (
      (typeof handler.result === "function"
        ? handler.result(text, values)
        : handler.result) ?? { rows: [], rowCount: 0 }
    );
  };
  return { calls, query: vi.fn(dispatch) };
}

const CONSUMER_CTX = {
  req: { headers: {} },
  res: {},
  user: { id: 7, name: "Pilot Consumer", email: "consumer@pilot.ng", role: "user" },
} as never;

const OPERATOR_CTX = {
  req: { headers: {} },
  res: {},
  user: {
    id: 9,
    name: "Pilot Operator",
    email: "ops@pilot.ng",
    role: "admin",
    mfaAuthenticated: true,
  },
} as never;

const ANON_CTX = { req: { headers: {} }, res: {}, user: null } as never;

const IDEMPOTENCY_KEY = "growth-key-0001";

beforeEach(() => {
  vi.resetAllMocks();
  publicUserMocks.resolvePublicUser.mockImplementation(async (user: any) => ({
    id: user.id,
    openId: `pilot-open-${user.id}`,
    name: user.name,
    email: user.email,
  }));
  policyMocks.checkPolicy.mockResolvedValue(true);
});

describe("myReferralCode", () => {
  it("returns the caller's existing referral code without writing", async () => {
    const pool = createPool([
      {
        match: /SELECT referral_code FROM public\.users/,
        result: { rows: [{ referral_code: "PILOT001" }] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const caller = growthRouter.createCaller(CONSUMER_CTX);
    const result = await caller.myReferralCode();

    expect(result).toEqual({ referralCode: "PILOT001" });
    expect(pool.calls.some((c) => /UPDATE public\.users/.test(c.text))).toBe(false);
  });

  it("provisions a Crockford-ish code when the caller has none", async () => {
    let generatedCandidate: string | null = null;
    const pool = createPool([
      {
        match: /SELECT referral_code FROM public\.users WHERE id/,
        result: () => ({ rows: [{ referral_code: generatedCandidate }] }),
      },
      { match: /SELECT 1 FROM public\.users WHERE referral_code/, result: { rows: [] } },
      {
        match: /UPDATE public\.users/,
        // Claim whatever candidate the router generated so the assertion
        // below verifies the real generator output.
        result: (_text, values) => {
          generatedCandidate = String(values[1]);
          return { rows: [{ referral_code: generatedCandidate }] };
        },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const caller = growthRouter.createCaller(CONSUMER_CTX);
    const result = await caller.myReferralCode();

    expect(result.referralCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{8,}$/);
    const update = pool.calls.find((c) => /UPDATE public\.users/.test(c.text));
    expect(update?.values[0]).toBe(7);
  });

  it("requires authentication", async () => {
    const caller = growthRouter.createCaller(ANON_CTX);
    await expect(caller.myReferralCode()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("myReferrals", () => {
  it("lists only the caller's referrals with integer point fields", async () => {
    const pool = createPool([
      {
        match: /FROM public\.customer_referrals cr/,
        result: {
          rows: [
            {
              id: 11,
              referral_code: "PILOT001",
              status: "rewarded",
              referrer_bonus_points: 500,
              referred_bonus_points: 200,
              created_at: "2026-11-01T00:00:00.000Z",
              completed_at: "2026-11-02T00:00:00.000Z",
              referred_name: "Referred Friend",
            },
          ],
        },
      },
      {
        match: /COUNT\(\*\)::int AS total/,
        result: { rows: [{ total: 1, pending: 0, successful: 1 }] },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const caller = growthRouter.createCaller(CONSUMER_CTX);
    const result = await caller.myReferrals({ limit: 10 });

    expect(result.summary).toEqual({ total: 1, pending: 0, successful: 1 });
    expect(result.referrals).toHaveLength(1);
    expect(result.referrals[0]).toMatchObject({
      referralCode: "PILOT001",
      status: "rewarded",
      referrerBonusPoints: 500,
      referredName: "Referred Friend",
    });
    for (const call of pool.calls) {
      expect(call.values[0]).toBe(7);
    }
  });
});

describe("applyReferralCode", () => {
  it("passes the resolved public user id, code and idempotency key to the engine", async () => {
    dbMocks.applyReferralCode.mockResolvedValue({
      id: 21,
      referral_code: "FRIEND01",
      status: "pending",
      referrer_bonus_points: 500,
      referred_bonus_points: 200,
      created_at: "2026-11-12T00:00:00.000Z",
      completed_at: null,
    });

    const caller = growthRouter.createCaller(CONSUMER_CTX);
    const result = await caller.applyReferralCode({
      referralCode: "friend01",
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(dbMocks.applyReferralCode).toHaveBeenCalledWith(7, "friend01", IDEMPOTENCY_KEY);
    expect(result).toMatchObject({ id: 21, referralCode: "FRIEND01", status: "pending" });
  });

  it("replays the same idempotency key to the stored engine response", async () => {
    // Simulate the db.ts ledger: first claim stores the response, replay
    // returns it without re-executing the FOR UPDATE/INSERT path.
    const stored = {
      id: 21,
      referral_code: "FRIEND01",
      status: "pending",
      referrer_bonus_points: 500,
      referred_bonus_points: 200,
      created_at: "2026-11-12T00:00:00.000Z",
      completed_at: null,
    };
    let executions = 0;
    dbMocks.applyReferralCode.mockImplementation(async () => {
      executions += 1;
      return stored;
    });

    const caller = growthRouter.createCaller(CONSUMER_CTX);
    const first = await caller.applyReferralCode({
      referralCode: "FRIEND01",
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    const replay = await caller.applyReferralCode({
      referralCode: "FRIEND01",
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(replay).toEqual(first);
    expect(dbMocks.applyReferralCode).toHaveBeenCalledTimes(2);
    expect(executions).toBe(2); // engine owns replay suppression; router is a pure pass-through
  });

  it("rejects a double apply with CONFLICT", async () => {
    dbMocks.applyReferralCode.mockRejectedValue(
      new Error("User has already used a referral code"),
    );

    const caller = growthRouter.createCaller(CONSUMER_CTX);
    await expect(
      caller.applyReferralCode({ referralCode: "OTHER999", idempotencyKey: IDEMPOTENCY_KEY }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("maps invalid and self-referral codes to BAD_REQUEST", async () => {
    dbMocks.applyReferralCode.mockRejectedValueOnce(new Error("Invalid referral code"));
    const caller = growthRouter.createCaller(CONSUMER_CTX);
    await expect(
      caller.applyReferralCode({ referralCode: "NOPE0000", idempotencyKey: IDEMPOTENCY_KEY }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    dbMocks.applyReferralCode.mockRejectedValueOnce(
      new Error("Users cannot apply their own referral code"),
    );
    await expect(
      caller.applyReferralCode({ referralCode: "PILOT001", idempotencyKey: IDEMPOTENCY_KEY }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects malformed idempotency keys at the schema boundary", async () => {
    const caller = growthRouter.createCaller(CONSUMER_CTX);
    await expect(
      caller.applyReferralCode({ referralCode: "FRIEND01", idempotencyKey: "bad key!" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(dbMocks.applyReferralCode).not.toHaveBeenCalled();
  });
});

describe("loyalty reads", () => {
  it("myLoyaltyBalance returns integer minor-unit points with tier fields", async () => {
    dbMocks.getLoyaltyAccount.mockResolvedValue({
      user_id: 7,
      points_balance: 1250,
      lifetime_points: 3400,
      tier: "silver",
      tier_progress: "400.00",
      next_tier_threshold: 5000,
    });

    const caller = growthRouter.createCaller(CONSUMER_CTX);
    const result = await caller.myLoyaltyBalance();

    expect(dbMocks.getLoyaltyAccount).toHaveBeenCalledWith(7);
    expect(result).toEqual({
      pointsBalance: 1250,
      lifetimePoints: 3400,
      tier: "silver",
      tierProgress: 400,
      nextTierThreshold: 5000,
    });
    expect(Number.isInteger(result.pointsBalance)).toBe(true);
  });

  it("myLoyaltyTransactions is pinned to the caller and passes the limit through", async () => {
    const pool = createPool([
      {
        match: /FROM public\.loyalty_transactions/,
        result: {
          rows: [
            {
              id: 5,
              transaction_type: "referral",
              points: 200,
              order_id: null,
              description: "Welcome bonus",
              created_at: "2026-11-10T00:00:00.000Z",
            },
            {
              id: 4,
              transaction_type: "redeem",
              points: -300,
              order_id: 42,
              description: "Redeemed: Free Delivery",
              created_at: "2026-11-09T00:00:00.000Z",
            },
          ],
        },
      },
    ]);
    dbMocks.getPool.mockResolvedValue(pool);

    const caller = growthRouter.createCaller(CONSUMER_CTX);
    const result = await caller.myLoyaltyTransactions({ limit: 100 });

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ transactionType: "referral", points: 200, orderId: null });
    expect(result[1]).toMatchObject({ transactionType: "redeem", points: -300, orderId: 42 });
    const query = pool.calls.find((c) => /loyalty_transactions/.test(c.text));
    expect(query?.values).toEqual([7, 100]);
  });

  it("myLoyaltyTransactions rejects limits above 100 at the schema boundary", async () => {
    const pool = createPool([]);
    dbMocks.getPool.mockResolvedValue(pool);

    const caller = growthRouter.createCaller(CONSUMER_CTX);
    await expect(
      caller.myLoyaltyTransactions({ limit: 5000 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(pool.calls).toHaveLength(0);
  });

  it("listRewardsCatalog exposes only consumer-safe active reward fields", async () => {
    dbMocks.getLoyaltyRewards.mockResolvedValue([
      {
        id: 1,
        reward_name: "Free Delivery",
        description: "Free delivery voucher",
        points_cost: 300,
        points_required: 300,
        reward_type: "voucher",
        reward_value: "Free delivery",
        min_tier: "bronze",
        is_active: true,
        status: "active",
        expires_at: "2027-02-10T00:00:00.000Z",
      },
    ]);

    const caller = growthRouter.createCaller(ANON_CTX); // public read
    const result = await caller.listRewardsCatalog();

    expect(dbMocks.getLoyaltyRewards).toHaveBeenCalledWith({ activeOnly: true });
    expect(result).toEqual([
      {
        id: 1,
        rewardName: "Free Delivery",
        description: "Free delivery voucher",
        pointsCost: 300,
        rewardType: "voucher",
        rewardValue: "Free delivery",
        minTier: "bronze",
        expiresAt: "2027-02-10T00:00:00.000Z",
      },
    ]);
  });
});

describe("listActiveCampaigns", () => {
  it("is a public read limited to in-window active campaigns, stripped of operator fields", async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    dbMocks.getCampaigns.mockResolvedValue([
      {
        id: 1,
        campaign_name: "Unilag Launch",
        campaign_type: "referral",
        channel: "whatsapp",
        target_audience: "all",
        status: "active",
        is_active: true,
        starts_at: past,
        ends_at: future,
        budget: "500000.00",
        email_template: "secret-template",
      },
      { id: 2, campaign_name: "Draft", status: "draft", is_active: true },
      { id: 3, campaign_name: "Future", status: "active", is_active: true, starts_at: future },
      { id: 4, campaign_name: "Expired", status: "active", is_active: true, ends_at: past },
    ]);

    const caller = growthRouter.createCaller(ANON_CTX);
    const result = await caller.listActiveCampaigns();

    expect(dbMocks.getCampaigns).toHaveBeenCalledWith(true);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: 1,
      campaignName: "Unilag Launch",
      campaignType: "referral",
      channel: "whatsapp",
      targetAudience: "all",
      startsAt: past,
      endsAt: future,
    });
    expect(JSON.stringify(result)).not.toContain("budget");
    expect(JSON.stringify(result)).not.toContain("template");
  });
});

describe("operator campaign procedures", () => {
  const campaignInput = {
    campaignName: "Unilag Launch",
    campaignType: "referral",
    targetAudience: "all",
    smsTemplate: "Join with code {{code}}",
  };

  it("createCampaign rejects anonymous callers", async () => {
    const caller = growthRouter.createCaller(ANON_CTX);
    await expect(caller.createCampaign(campaignInput)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(dbMocks.createCampaign).not.toHaveBeenCalled();
  });

  it("createCampaign rejects non-operator roles", async () => {
    const caller = growthRouter.createCaller(CONSUMER_CTX);
    await expect(caller.createCampaign(campaignInput)).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "OPERATOR_ROLE_REQUIRED",
    });
    expect(dbMocks.createCampaign).not.toHaveBeenCalled();
  });

  it("createCampaign rejects operators denied by policy", async () => {
    policyMocks.checkPolicy.mockResolvedValue(false);
    const caller = growthRouter.createCaller(OPERATOR_CTX);
    await expect(caller.createCampaign(campaignInput)).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "POLICY_DENIED:operate",
    });
    expect(dbMocks.createCampaign).not.toHaveBeenCalled();
  });

  it("createCampaign maps camelCase input onto the engine contract", async () => {
    dbMocks.createCampaign.mockResolvedValue({ id: 3, campaign_name: "Unilag Launch" });
    const caller = growthRouter.createCaller(OPERATOR_CTX);
    const result = await caller.createCampaign(campaignInput);

    expect(dbMocks.createCampaign).toHaveBeenCalledWith({
      campaign_name: "Unilag Launch",
      campaign_type: "referral",
      target_audience: "all",
      sms_template: "Join with code {{code}}",
      email_template: undefined,
      trigger_condition: undefined,
    });
    expect(result).toMatchObject({ id: 3 });
  });

  it("updateCampaign enforces policy and returns NOT_FOUND for unknown campaigns", async () => {
    policyMocks.checkPolicy.mockResolvedValue(false);
    const denied = growthRouter.createCaller(OPERATOR_CTX);
    await expect(
      denied.updateCampaign({ campaignId: 99, updates: { is_active: false } }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    policyMocks.checkPolicy.mockResolvedValue(true);
    dbMocks.updateCampaign.mockResolvedValue(null);
    const caller = growthRouter.createCaller(OPERATOR_CTX);
    await expect(
      caller.updateCampaign({ campaignId: 99, updates: { is_active: false } }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "campaign_not_found" });
    expect(dbMocks.updateCampaign).toHaveBeenCalledWith(99, { is_active: false });
  });

  it("leaderboardSummary composes period, entries and loyalty stats for operators", async () => {
    dbMocks.getCurrentLeaderboardPeriod.mockResolvedValue({
      id: 2,
      period_name: "2026-11",
      period_start: "2026-11-01T00:00:00.000Z",
      period_end: "2026-11-30T23:59:59.000Z",
      status: "active",
    });
    dbMocks.getReferralLeaderboard.mockResolvedValue([
      {
        user_id: 7,
        user_name: "Pilot Consumer",
        referral_count: 4,
        successful_referrals: 3,
        points_earned: 1500,
        rank: 1,
        reward_tier: "gold",
        reward_points: 2000,
      },
    ]);
    dbMocks.getLoyaltyStats.mockResolvedValue({
      total_members: "50",
      total_points_outstanding: "12500",
      total_points_awarded: "20000",
    });

    const caller = growthRouter.createCaller(OPERATOR_CTX);
    const result = await caller.leaderboardSummary({ limit: 10 });

    expect(result.period).toMatchObject({ id: 2, periodName: "2026-11", status: "active" });
    expect(result.entries[0]).toMatchObject({ userId: 7, rank: 1, rewardTier: "gold" });
    expect(result.loyalty).toEqual({
      totalMembers: 50,
      totalPointsOutstanding: 12500,
      totalPointsAwarded: 20000,
    });
  });
});

describe("drizzle/0105_growth_tables_promotion.sql (parse-level idempotency)", () => {
  const migration = readFileSync(
    join(__dirname, "..", "drizzle", "0105_growth_tables_promotion.sql"),
    "utf-8",
  );
  const bootstrap = readFileSync(
    join(__dirname, "..", "scripts", "init-local-postgres.sql"),
    "utf-8",
  );

  const GROWTH_TABLES = [
    "loyalty_points",
    "loyalty_transactions",
    "loyalty_rewards",
    "loyalty_redemptions",
    "customer_referrals",
    "referral_leaderboard_periods",
    "referral_leaderboard_entries",
    "marketing_campaigns",
    "campaign_variants",
  ];

  it("creates all nine growth tables with IF NOT EXISTS guards", () => {
    for (const table of GROWTH_TABLES) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${table} (`);
    }
    expect(migration.match(/CREATE TABLE IF NOT EXISTS/g)).toHaveLength(9);
  });

  it("copies the column definitions verbatim from init-local-postgres.sql", () => {
    const extract = (source: string, table: string) => {
      const match = source.match(
        new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\((.*?)\\);`, "s"),
      );
      return match?.[1] ?? null;
    };
    for (const table of GROWTH_TABLES) {
      expect(extract(migration, table)).toBe(extract(bootstrap, table));
    }
  });

  it("guards every CREATE INDEX with IF NOT EXISTS and re-issues the 0093 pair", () => {
    const indexStatements = migration.match(/CREATE INDEX(?! IF NOT EXISTS)[^\n]*/g) ?? [];
    expect(indexStatements).toEqual([]);
    expect(migration).toContain(
      "CREATE INDEX IF NOT EXISTS idx_loyalty_transactions_user_created",
    );
    expect(migration).toContain(
      "CREATE INDEX IF NOT EXISTS idx_marketing_campaigns_activity",
    );
  });

  it("wraps every ALTER PUBLICATION in a pg_publication_tables NOT EXISTS guard", () => {
    const publicationAdds =
      migration.match(/ALTER PUBLICATION powersync ADD TABLE public\.(\w+)/g) ?? [];
    expect(publicationAdds).toHaveLength(9);
    for (const table of GROWTH_TABLES) {
      const block = migration.match(
        new RegExp(
          `DO \\$\\$[\\s\\S]*?pg_publication_tables WHERE pubname = 'powersync' AND schemaname = 'public' AND tablename = '${table}'[\\s\\S]*?ALTER PUBLICATION powersync ADD TABLE public\\.${table};[\\s\\S]*?END \\$\\$;`,
        ),
      );
      expect(block, `guarded publication add for ${table}`).not.toBeNull();
    }
  });

  it("promotes the users referral identity columns with guarded ALTERs", () => {
    expect(migration).toContain(
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code VARCHAR(50);",
    );
    expect(migration).toContain(
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by_code VARCHAR(50);",
    );
    expect(migration).not.toContain("users ADD COLUMN phone");
  });

  it("documents the promotion rationale in the header", () => {
    expect(migration).toMatch(/promotion rationale/i);
    expect(migration).toContain("init-local-postgres.sql");
    expect(migration).toMatch(/idempotent/i);
  });
});
