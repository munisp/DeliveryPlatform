import { describe, it, expect, beforeAll } from 'vitest';
import { getDb } from './db';

describe('Growth Features Tests', () => {
  // Use a test user ID (assuming user with ID 1 exists from previous tests)
  const testUserId = 1;

  beforeAll(async () => {
    // Ensure database connection
    await getDb();
  });

  describe('Referral Leaderboard', () => {
    it('should get current leaderboard period', async () => {
      const { getCurrentLeaderboardPeriod } = await import('./db');
      const period = await getCurrentLeaderboardPeriod();
      
      expect(period).toBeDefined();
      expect(period?.status).toBe('active');
    });

    it('should update leaderboard entry for user', async () => {
      const { updateLeaderboardEntry } = await import('./db');
      const entry = await updateLeaderboardEntry(testUserId);
      
      expect(entry).toBeDefined();
      expect(entry.user_id).toBe(testUserId);
      expect(entry.referral_count).toBeGreaterThanOrEqual(0);
    });

    it('should calculate leaderboard rankings', async () => {
      const { calculateLeaderboardRankings } = await import('./db');
      const result = await calculateLeaderboardRankings();
      
      expect(result).toBe(true);
    });

    it('should get referral leaderboard', async () => {
      const { getReferralLeaderboard } = await import('./db');
      const leaderboard = await getReferralLeaderboard(undefined, 10);
      
      expect(Array.isArray(leaderboard)).toBe(true);
    });

    it('should get user leaderboard position', async () => {
      const { getUserLeaderboardPosition } = await import('./db');
      const position = await getUserLeaderboardPosition(testUserId);
      
      if (position) {
        expect(position.user_id).toBe(testUserId);
        expect(position).toHaveProperty('rank');
        expect(position).toHaveProperty('referral_count');
      }
    });
  });

  describe('Push Notifications', () => {
    it('should register push token', async () => {
      const { registerPushToken } = await import('./db');
      const token = await registerPushToken(
        testUserId,
        'test-device-token-' + Date.now(),
        'web',
        'test-device-id'
      );
      
      expect(token).toBeDefined();
      expect(token.user_id).toBe(testUserId);
      expect(token.device_type).toBe('web');
      expect(token.is_active).toBe(true);
    });

    it('should get user push tokens', async () => {
      const { getUserPushTokens } = await import('./db');
      const tokens = await getUserPushTokens(testUserId);
      
      expect(Array.isArray(tokens)).toBe(true);
    });

    it('should deactivate push token', async () => {
      const { registerPushToken, deactivatePushToken } = await import('./db');
      
      // Register a token first
      const token = await registerPushToken(
        testUserId,
        'test-deactivate-token-' + Date.now(),
        'web'
      );
      
      // Deactivate it
      const result = await deactivatePushToken(testUserId, token.device_token);
      expect(result).toBe(true);
    });

    it('should get push notification logs', async () => {
      const { getPushNotificationLogs } = await import('./db');
      const logs = await getPushNotificationLogs(testUserId, 10);
      
      expect(Array.isArray(logs)).toBe(true);
    });
  });

  describe('A/B Testing', () => {
    let testCampaignId: number;
    let testVariantId: number;

    beforeAll(async () => {
      // Create a test campaign first
      const { createCampaign } = await import('./db');
      const campaign = await createCampaign({
        campaign_name: 'Test A/B Campaign',
        campaign_type: 'tier_upgrade',
        trigger_event: 'tier_upgrade',
        target_audience: 'all',
        status: 'draft',
      });
      testCampaignId = campaign.id;
    });

    it('should create campaign variant', async () => {
      const { createCampaignVariant } = await import('./db');
      const variant = await createCampaignVariant({
        campaign_id: testCampaignId,
        variant_name: 'Variant A',
        email_template: 'Test email template A',
        traffic_allocation: 50,
      });
      
      expect(variant).toBeDefined();
      expect(variant.campaign_id).toBe(testCampaignId);
      expect(variant.variant_name).toBe('Variant A');
      expect(variant.traffic_allocation).toBe('50.00');
      
      testVariantId = variant.id;
    });

    it('should get campaign variants', async () => {
      const { getCampaignVariants } = await import('./db');
      const variants = await getCampaignVariants(testCampaignId);
      
      expect(Array.isArray(variants)).toBe(true);
      expect(variants.length).toBeGreaterThan(0);
    });

    it('should track variant metrics', async () => {
      const { trackVariantSend, trackVariantOpen, trackVariantClick, trackVariantConversion } = await import('./db');
      
      // Track send
      const sendResult = await trackVariantSend(testVariantId);
      expect(sendResult).toBe(true);
      
      // Track open
      const openResult = await trackVariantOpen(testVariantId);
      expect(openResult).toBe(true);
      
      // Track click
      const clickResult = await trackVariantClick(testVariantId);
      expect(clickResult).toBe(true);
      
      // Track conversion
      const conversionResult = await trackVariantConversion(testVariantId);
      expect(conversionResult).toBe(true);
    });

    it('should get variant performance', async () => {
      const { getVariantPerformance } = await import('./db');
      const performance = await getVariantPerformance(testCampaignId);
      
      expect(Array.isArray(performance)).toBe(true);
      if (performance.length > 0) {
        expect(performance[0]).toHaveProperty('open_rate');
        expect(performance[0]).toHaveProperty('click_rate');
        expect(performance[0]).toHaveProperty('conversion_rate');
      }
    });

    it('should update variant allocation', async () => {
      const { updateVariantAllocation } = await import('./db');
      const updated = await updateVariantAllocation(testVariantId, 60);
      
      expect(updated).toBeDefined();
      expect(updated.traffic_allocation).toBe('60.00');
    });

    it('should calculate statistical significance', async () => {
      const { calculateStatisticalSignificance } = await import('./db');
      
      const variant1 = {
        send_count: 150,
        conversion_count: 30,
        variant_name: 'A',
      };
      
      const variant2 = {
        send_count: 150,
        conversion_count: 20,
        variant_name: 'B',
      };
      
      const result = await calculateStatisticalSignificance(variant1, variant2);
      
      expect(result).toHaveProperty('isSignificant');
      expect(result).toHaveProperty('confidenceLevel');
      expect(typeof result.isSignificant).toBe('boolean');
      expect(typeof result.confidenceLevel).toBe('number');
    });
  });
});
