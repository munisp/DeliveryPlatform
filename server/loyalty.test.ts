import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initializeLoyaltyAccount, getLoyaltyAccount, awardPoints, redeemPoints, getLoyaltyStats } from './db';
import { Pool } from 'pg';

describe('Loyalty Program', () => {
  let testUserId: number;
  let pool: Pool;

  beforeAll(async () => {
    // Create a test database connection
    pool = new Pool({
      connectionString: 'postgresql://ubuntu:ubuntu@localhost:5432/switchos'
    });

    // Create a test user
    const result = await pool.query(
      `INSERT INTO users (open_id, name, email, role) 
       VALUES ($1, $2, $3, $4) 
       RETURNING id`,
      ['test-loyalty-user', 'Test User', 'test@loyalty.com', 'user']
    );
    testUserId = result.rows[0].id;
  });

  afterAll(async () => {
    // Clean up test data
    await pool.query('DELETE FROM loyalty_redemptions WHERE user_id = $1', [testUserId]);
    await pool.query('DELETE FROM loyalty_transactions WHERE user_id = $1', [testUserId]);
    await pool.query('DELETE FROM loyalty_points WHERE user_id = $1', [testUserId]);
    await pool.query('DELETE FROM users WHERE id = $1', [testUserId]);
    await pool.end();
  });

  it('should initialize a loyalty account for a new user', async () => {
    const account = await initializeLoyaltyAccount(testUserId);
    
    expect(account).toBeDefined();
    expect(account.user_id).toBe(testUserId);
    expect(account.points_balance).toBe(0);
    expect(account.lifetime_points).toBe(0);
    expect(account.tier).toBe('bronze');
  });

  it('should retrieve an existing loyalty account', async () => {
    const account = await getLoyaltyAccount(testUserId);
    
    expect(account).toBeDefined();
    expect(account.user_id).toBe(testUserId);
    expect(account.tier).toBeDefined();
  });

  it('should award points and update account balance', async () => {
    const initialAccount = await getLoyaltyAccount(testUserId);
    const pointsToAward = 500;
    
    const updatedAccount = await awardPoints(
      testUserId,
      pointsToAward,
      'earn',
      'Test points award'
    );
    
    expect(updatedAccount).toBeDefined();
    expect(updatedAccount.points_balance).toBeGreaterThanOrEqual(initialAccount.points_balance + pointsToAward);
    expect(updatedAccount.lifetime_points).toBeGreaterThanOrEqual(initialAccount.lifetime_points + pointsToAward);
  });

  it('should upgrade tier when reaching threshold', async () => {
    // Award enough points to reach silver tier (1000 points)
    await awardPoints(testUserId, 1000, 'bonus', 'Tier upgrade test');
    
    const account = await getLoyaltyAccount(testUserId);
    
    expect(account).toBeDefined();
    // Tier should be at least silver or higher
    expect(['silver', 'gold', 'platinum']).toContain(account.tier);
  });

  it('should retrieve loyalty program statistics', async () => {
    const stats = await getLoyaltyStats();
    
    expect(stats).toBeDefined();
    // PostgreSQL COUNT returns string, convert to number
    expect(Number(stats.total_members)).toBeGreaterThan(0);
    expect(Number(stats.total_points_awarded)).toBeGreaterThanOrEqual(0);
    expect(Number(stats.total_points_outstanding)).toBeGreaterThanOrEqual(0);
  });

  it('should handle reward redemption with sufficient points', async () => {
    // First ensure user has enough points
    await awardPoints(testUserId, 1000, 'bonus', 'Redemption test setup');
    
    const account = await getLoyaltyAccount(testUserId);
    
    // Try to redeem a reward (assuming reward ID 2 exists - Free Delivery for 300 points)
    if (account.points_balance >= 300) {
      const redemption = await redeemPoints(testUserId, 2);
      
      expect(redemption).toBeDefined();
      expect(redemption.user_id).toBe(testUserId);
      expect(redemption.reward_id).toBe(2);
      expect(redemption.voucher_code).toBeDefined();
      expect(redemption.status).toBe('approved');
    }
  });

  it('should reject redemption with insufficient points', async () => {
    // Try to redeem an expensive reward (assuming reward ID 8 exists - VIP Membership for 8000 points)
    const account = await getLoyaltyAccount(testUserId);
    
    if (account.points_balance < 8000) {
      await expect(redeemPoints(testUserId, 8)).rejects.toThrow('Insufficient points');
    }
  });
});
