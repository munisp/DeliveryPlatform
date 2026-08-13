import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { writeFileSync } from 'node:fs';
import {
  awardPoints,
  createCampaign,
  createCampaignVariant,
  initializeLoyaltyAccount,
  redeemPoints,
  updateVariantAllocation,
} from '../server/db';

const databaseUrl = process.env.TEST_DATABASE_URL;
let pool: Pool | null = null;
const createdUsers: number[] = [];
const createdRewards: number[] = [];
const createdCampaigns: number[] = [];

async function requireDb(context: { skip: () => never }) {
  if (!databaseUrl || !pool) context.skip();
}

async function createUser(label: string) {
  const result = await pool!.query(
    `INSERT INTO users (open_id, name, email, role, phone)
     VALUES ($1, $2, $3, 'user', $4)
     RETURNING id`,
    [`concurrency-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`, label, `${label}-${Date.now()}@switchos.test`, '+10000000009'],
  );
  const id = result.rows[0].id as number;
  createdUsers.push(id);
  return id;
}

describe('loyalty redemption and campaign allocation concurrency', () => {
  beforeAll(async () => {
    if (!databaseUrl) return;
    pool = new Pool({ connectionString: databaseUrl });
    await pool.query('SELECT 1');
  });

  afterAll(async () => {
    if (!pool) return;
    if (createdCampaigns.length) {
      await pool.query('DELETE FROM campaign_variants WHERE campaign_id = ANY($1::int[])', [createdCampaigns]);
      await pool.query('DELETE FROM marketing_campaigns WHERE id = ANY($1::int[])', [createdCampaigns]);
    }
    if (createdRewards.length) {
      await pool.query('DELETE FROM loyalty_redemptions WHERE reward_id = ANY($1::int[])', [createdRewards]);
      await pool.query('DELETE FROM loyalty_rewards WHERE id = ANY($1::int[])', [createdRewards]);
    }
    if (createdUsers.length) {
      await pool.query(
        "DELETE FROM platform_idempotency_keys WHERE scope = $1 AND idempotency_key LIKE 'concurrency-redeem-%'",
        ['loyalty.redeem'],
      );
      await pool.query('DELETE FROM loyalty_transactions WHERE user_id = ANY($1::int[])', [createdUsers]);
      await pool.query('DELETE FROM loyalty_points WHERE user_id = ANY($1::int[])', [createdUsers]);
      await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [createdUsers]);
    }
    await pool.end();
  });

  it('serializes 100 concurrent unique loyalty redemption attempts without overdrawing points', async (context) => {
    await requireDb(context);
    const userId = await createUser('redemption-race');
    const reward = await pool!.query(
      `INSERT INTO loyalty_rewards (reward_name, description, points_cost, points_required, reward_type, reward_value, is_active)
       VALUES ('Concurrency Reward', 'isolated concurrency test', 100, 100, 'voucher', 'NGN 100', true)
       RETURNING id`,
    );
    const rewardId = reward.rows[0].id as number;
    createdRewards.push(rewardId);
    await initializeLoyaltyAccount(userId);
    await awardPoints(userId, 1000, 'bonus', 'concurrency budget');

    const attempts = await Promise.allSettled(
      Array.from({ length: 100 }, (_, index) => redeemPoints(userId, rewardId, `concurrency-redeem-${userId}-${index}`)),
    );
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(10);
    expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(90);

    const balance = await pool!.query('SELECT points_balance FROM loyalty_points WHERE user_id = $1', [userId]);
    const redemptions = await pool!.query('SELECT COUNT(*)::int AS count FROM loyalty_redemptions WHERE user_id = $1', [userId]);
    const debits = await pool!.query("SELECT COUNT(*)::int AS count FROM loyalty_transactions WHERE user_id = $1 AND transaction_type = 'redeem'", [userId]);
    const transactionRows = await pool!.query(
      `SELECT id, transaction_type, points, description, created_at
       FROM loyalty_transactions
       WHERE user_id = $1
       ORDER BY created_at ASC, id ASC`,
      [userId],
    );
    const redemptionRows = await pool!.query(
      `SELECT id, reward_id, points_spent, status, created_at
       FROM loyalty_redemptions
       WHERE user_id = $1
       ORDER BY created_at ASC, id ASC`,
      [userId],
    );
    if (process.env.LOYALTY_CONCURRENCY_LOG_FILE) {
      writeFileSync(process.env.LOYALTY_CONCURRENCY_LOG_FILE, JSON.stringify({
        scenario: '100-way unique loyalty redemption race',
        attemptedRedemptions: 100,
        fulfilledRedemptions: attempts.filter((result) => result.status === 'fulfilled').length,
        rejectedRedemptions: attempts.filter((result) => result.status === 'rejected').length,
        finalPointsBalance: Number(balance.rows[0].points_balance),
        redemptionCount: redemptions.rows[0].count,
        debitCount: debits.rows[0].count,
        transactions: transactionRows.rows,
        redemptions: redemptionRows.rows,
      }, null, 2));
    }
    expect(Number(balance.rows[0].points_balance)).toBe(0);
    expect(redemptions.rows[0].count).toBe(10);
    expect(debits.rows[0].count).toBe(10);
  });

  it('serializes concurrent variant allocation updates and rejects values that would exceed 100 percent', async (context) => {
    await requireDb(context);
    const campaign = await createCampaign({
      campaign_name: `Concurrency allocation ${Date.now()}`,
      campaign_type: 'email',
      email_template: 'Allocation test',
      sms_template: null as unknown as string,
      target_audience: 'all',
      trigger_condition: { source: 'concurrency-test' },
    });
    createdCampaigns.push(campaign.id);
    const first = await createCampaignVariant({ campaign_id: campaign.id, variant_name: 'A', traffic_allocation: 40 });
    const second = await createCampaignVariant({ campaign_id: campaign.id, variant_name: 'B', traffic_allocation: 40 });

    const attempts = await Promise.allSettled(
      Array.from({ length: 100 }, (_, index) => updateVariantAllocation(index % 2 === 0 ? first.id : second.id, 60)),
    );
    expect(attempts.some((result) => result.status === 'fulfilled')).toBe(true);
    expect(attempts.some((result) => result.status === 'rejected')).toBe(true);

    const rows = await pool!.query('SELECT traffic_allocation FROM campaign_variants WHERE campaign_id = $1', [campaign.id]);
    const total = rows.rows.reduce((sum: number, row: { traffic_allocation: string | number }) => sum + Number(row.traffic_allocation), 0);
    expect(total).toBeLessThanOrEqual(100);
  });
});
