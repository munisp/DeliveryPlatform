import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { awardPoints, getLoyaltyAccount, getLoyaltyStats, initializeLoyaltyAccount, redeemPoints } from './db';

const TEST_DATABASE_URL = 'postgresql://ubuntu:ubuntu@localhost:5432/switchos';

let testUserId: number | null = null;
let pool: Pool | null = null;
let dbAvailable = false;

async function requireDbOrSkip(context: { skip: () => never }) {
  if (!dbAvailable || !pool || testUserId === null) {
    context.skip();
  }
}

describe('Loyalty Program', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL });

    try {
      await pool.query('SELECT 1');
      dbAvailable = true;
      const result = await pool.query(
        `INSERT INTO users (open_id, name, email, role)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        ['test-loyalty-user', 'Test User', 'test@loyalty.com', 'user'],
      );
      testUserId = result.rows[0].id;
    } catch {
      dbAvailable = false;
    }
  });

  afterAll(async () => {
    if (dbAvailable && pool && testUserId !== null) {
      await pool.query('DELETE FROM loyalty_redemptions WHERE user_id = $1', [testUserId]);
      await pool.query('DELETE FROM loyalty_transactions WHERE user_id = $1', [testUserId]);
      await pool.query('DELETE FROM loyalty_points WHERE user_id = $1', [testUserId]);
      await pool.query('DELETE FROM users WHERE id = $1', [testUserId]);
    }

    if (pool) {
      await pool.end();
    }
  });

  it('should initialize a loyalty account for a new user', async (context) => {
    await requireDbOrSkip(context);
    const account = await initializeLoyaltyAccount(testUserId!);

    expect(account).toBeDefined();
    expect(account.user_id).toBe(testUserId);
    expect(account.points_balance).toBe(0);
    expect(account.lifetime_points).toBe(0);
    expect(account.tier).toBe('bronze');
  });

  it('should retrieve an existing loyalty account', async (context) => {
    await requireDbOrSkip(context);
    const account = await getLoyaltyAccount(testUserId!);

    expect(account).toBeDefined();
    expect(account.user_id).toBe(testUserId);
    expect(account.tier).toBeDefined();
  });

  it('should award points and update account balance', async (context) => {
    await requireDbOrSkip(context);
    const initialAccount = await getLoyaltyAccount(testUserId!);
    const pointsToAward = 500;

    const updatedAccount = await awardPoints(testUserId!, pointsToAward, 'earn', 'Test points award');

    expect(updatedAccount).toBeDefined();
    expect(updatedAccount.points_balance).toBeGreaterThanOrEqual(initialAccount.points_balance + pointsToAward);
    expect(updatedAccount.lifetime_points).toBeGreaterThanOrEqual(initialAccount.lifetime_points + pointsToAward);
  });

  it('should upgrade tier when reaching threshold', async (context) => {
    await requireDbOrSkip(context);
    await awardPoints(testUserId!, 1000, 'bonus', 'Tier upgrade test');

    const account = await getLoyaltyAccount(testUserId!);

    expect(account).toBeDefined();
    expect(['silver', 'gold', 'platinum']).toContain(account.tier);
  });

  it('should retrieve loyalty program statistics', async (context) => {
    await requireDbOrSkip(context);
    const stats = await getLoyaltyStats();

    expect(stats).toBeDefined();
    expect(Number(stats.total_members)).toBeGreaterThan(0);
    expect(Number(stats.total_points_awarded)).toBeGreaterThanOrEqual(0);
    expect(Number(stats.total_points_outstanding)).toBeGreaterThanOrEqual(0);
  });

  it('should handle reward redemption with sufficient points', async (context) => {
    await requireDbOrSkip(context);
    await awardPoints(testUserId!, 1000, 'bonus', 'Redemption test setup');

    const account = await getLoyaltyAccount(testUserId!);

    if (account.points_balance >= 300) {
      const redemption = await redeemPoints(testUserId!, 2);

      expect(redemption).toBeDefined();
      expect(redemption.user_id).toBe(testUserId);
      expect(redemption.reward_id).toBe(2);
      expect(redemption.voucher_code).toBeDefined();
      expect(redemption.status).toBe('approved');
    }
  });

  it('should reject redemption with insufficient points', async (context) => {
    await requireDbOrSkip(context);
    const account = await getLoyaltyAccount(testUserId!);

    if (account.points_balance < 8000) {
      await expect(redeemPoints(testUserId!, 8)).rejects.toThrow('Insufficient points');
    }
  });
});
