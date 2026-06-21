import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";

vi.mock("../server/_core/notificationGateway", () => ({
  sendEmail: vi.fn().mockResolvedValue({ ok: true }),
  sendSMS: vi.fn().mockResolvedValue({ ok: true }),
}));

import {
  applyReferralCode,
  awardPoints,
  completeReferral,
  createCampaign,
  redeemPoints,
  sendCampaignToAudience,
} from "../server/db";
import { sendEmail } from "../server/_core/notificationGateway";

const TEST_DATABASE_URL = "postgresql://switchos:switchos@127.0.0.1:5432/switchos?sslmode=disable";

let pool: Pool | null = null;
let dbAvailable = false;
const createdUserIds: number[] = [];
const createdRewardIds: number[] = [];
const createdCampaignIds: number[] = [];

async function requireDbOrSkip(context: { skip: () => never }) {
  if (!dbAvailable || !pool) {
    context.skip();
  }
}

async function createUser(name: string, email: string, extras: Record<string, unknown> = {}) {
  const result = await pool!.query(
    `INSERT INTO users (open_id, name, email, role, referral_code, referred_by_code, phone)
     VALUES ($1, $2, $3, 'user', $4, $5, $6)
     RETURNING id`,
    [
      `test-${name.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      email,
      extras.referral_code ?? null,
      extras.referred_by_code ?? null,
      extras.phone ?? null,
    ],
  );

  createdUserIds.push(result.rows[0].id);
  return result.rows[0].id as number;
}

describe("Non-Mojaloop durable idempotency hardening", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL });

    try {
      await pool.query("SELECT 1");
      const schemaCheck = await pool.query(
        `SELECT COUNT(*)::int AS count
         FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name = ANY($1::text[])`,
        [[
          "users",
          "loyalty_points",
          "loyalty_transactions",
          "loyalty_rewards",
          "loyalty_redemptions",
          "customer_referrals",
          "campaign_sends",
          "marketing_campaigns",
          "platform_idempotency_keys",
        ]],
      );
      dbAvailable = schemaCheck.rows[0].count === 9;
    } catch {
      dbAvailable = false;
    }
  });

  beforeEach(async () => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    if (dbAvailable && pool) {
      if (createdCampaignIds.length > 0) {
        await pool.query("DELETE FROM campaign_sends WHERE campaign_id = ANY($1::int[])", [createdCampaignIds]);
        await pool.query("DELETE FROM marketing_campaigns WHERE id = ANY($1::int[])", [createdCampaignIds]);
      }

      if (createdRewardIds.length > 0) {
        await pool.query("DELETE FROM loyalty_redemptions WHERE reward_id = ANY($1::int[])", [createdRewardIds]);
        await pool.query("DELETE FROM loyalty_rewards WHERE id = ANY($1::int[])", [createdRewardIds]);
      }

      if (createdUserIds.length > 0) {
        await pool.query("DELETE FROM customer_referrals WHERE referrer_id = ANY($1::int[]) OR referred_id = ANY($1::int[])", [createdUserIds]);
        await pool.query("DELETE FROM loyalty_transactions WHERE user_id = ANY($1::int[])", [createdUserIds]);
        await pool.query("DELETE FROM loyalty_points WHERE user_id = ANY($1::int[])", [createdUserIds]);
        await pool.query("DELETE FROM users WHERE id = ANY($1::int[])", [createdUserIds]);
      }

      await pool.query(
        "DELETE FROM platform_idempotency_keys WHERE scope LIKE 'loyalty.%' OR scope LIKE 'referral.%' OR scope = 'campaign.send'",
      );
    }

    if (pool) {
      await pool.end();
    }
  });

  it("replays loyalty redemption safely with a durable idempotency key", async (context) => {
    await requireDbOrSkip(context);

    const userId = await createUser("Redeem User", `redeem-${Date.now()}@switchos.test`);
    const rewardResult = await pool!.query(
      `INSERT INTO loyalty_rewards (reward_name, description, points_cost, reward_type, reward_value, is_active)
       VALUES ($1, $2, $3, $4, $5, true)
       RETURNING id`,
      ["Idempotent Reward", "test reward", 300, "voucher", "NGN 300"],
    );
    const rewardId = rewardResult.rows[0].id as number;
    createdRewardIds.push(rewardId);

    await awardPoints(userId, 1000, "bonus", "redemption setup");

    const first = await redeemPoints(userId, rewardId, "redeem-wave7-key");
    const second = await redeemPoints(userId, rewardId, "redeem-wave7-key");

    expect(second.id).toBe(first.id);

    const redemptionCount = await pool!.query(
      "SELECT COUNT(*)::int AS count FROM loyalty_redemptions WHERE user_id = $1 AND reward_id = $2",
      [userId, rewardId],
    );
    expect(redemptionCount.rows[0].count).toBe(1);

    const balance = await pool!.query(
      "SELECT points_balance FROM loyalty_points WHERE user_id = $1",
      [userId],
    );
    expect(Number(balance.rows[0].points_balance)).toBe(700);
  });

  it("replays referral apply and completion safely with durable idempotency keys", async (context) => {
    await requireDbOrSkip(context);

    const referrerId = await createUser("Referrer User", `referrer-${Date.now()}@switchos.test`, { referral_code: "REFWAVE7" });
    const referredId = await createUser("Referred User", `referred-${Date.now()}@switchos.test`);

    const firstApply = await applyReferralCode(referredId, "REFWAVE7", "referral-apply-wave7-key");
    const secondApply = await applyReferralCode(referredId, "REFWAVE7", "referral-apply-wave7-key");
    expect(secondApply.id).toBe(firstApply.id);

    const applyCount = await pool!.query(
      "SELECT COUNT(*)::int AS count FROM customer_referrals WHERE referred_id = $1",
      [referredId],
    );
    expect(applyCount.rows[0].count).toBe(1);

    const referredBalance = await pool!.query(
      "SELECT points_balance FROM loyalty_points WHERE user_id = $1",
      [referredId],
    );
    expect(Number(referredBalance.rows[0].points_balance)).toBe(200);

    const firstComplete = await completeReferral(firstApply.id, "referral-complete-wave7-key");
    const secondComplete = await completeReferral(firstApply.id, "referral-complete-wave7-key");
    expect(secondComplete.id).toBe(firstComplete.id);
    expect(secondComplete.status).toBe("rewarded");

    const referrerBalance = await pool!.query(
      "SELECT points_balance FROM loyalty_points WHERE user_id = $1",
      [referrerId],
    );
    expect(Number(referrerBalance.rows[0].points_balance)).toBe(500);
  });

  it("deduplicates audience campaign delivery across retried scheduler runs", async (context) => {
    await requireDbOrSkip(context);

    const firstUserId = await createUser("Campaign User One", `campaign-one-${Date.now()}@switchos.test`);
    const secondUserId = await createUser("Campaign User Two", `campaign-two-${Date.now()}@switchos.test`);

    const campaign = await createCampaign({
      campaign_name: "Wave 7 Hardening Campaign",
      campaign_type: "email",
      email_template: "Hello {{name}}, you have {{points}} points.",
      sms_template: null as unknown as string,
      target_audience: "all",
      trigger_condition: { source: "test" },
    });
    createdCampaignIds.push(campaign.id);

    const firstRun = await sendCampaignToAudience(campaign.id, "campaign-audience-wave7-key");
    const secondRun = await sendCampaignToAudience(campaign.id, "campaign-audience-wave7-key");

    expect(firstRun.total).toBeGreaterThanOrEqual(2);
    expect(secondRun.total).toBe(firstRun.total);

    const sendCount = await pool!.query(
      "SELECT COUNT(*)::int AS count FROM campaign_sends WHERE campaign_id = $1 AND user_id = ANY($2::int[])",
      [campaign.id, [firstUserId, secondUserId]],
    );
    expect(sendCount.rows[0].count).toBe(2);

    expect(vi.mocked(sendEmail).mock.calls.length).toBe(2);
  });
});
