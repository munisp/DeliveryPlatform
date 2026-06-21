import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from './db';

let dbAvailable = false;

async function requireDbOrSkip(context: { skip: () => never }) {
  if (!dbAvailable) {
    context.skip();
  }
}

describe('Driver marketplace intelligence', () => {
  beforeAll(async () => {
    const db = await getDb();
    dbAvailable = Boolean(db);
  });

  it('should return a marketplace profile for a seeded driver', async (context) => {
    await requireDbOrSkip(context);
    const { getDriverMarketplaceProfile } = await import('./db');
    const profile = await getDriverMarketplaceProfile(1);

    expect(profile).toBeDefined();
    expect(profile?.driver_id).toBe(1);
    expect(profile).toHaveProperty('utilization_rate');
    expect(profile).toHaveProperty('margin_per_active_hour');
    expect(profile).toHaveProperty('dispatch_priority_band');
  });

  it('should return a dispatch recommendation payload for a seeded driver', async (context) => {
    await requireDbOrSkip(context);
    const { getDriverDispatchRecommendation } = await import('./db');
    const recommendation = await getDriverDispatchRecommendation(1);

    expect(recommendation).toBeDefined();
    expect(recommendation?.marketplace_profile.driver_id).toBe(1);
    expect(recommendation?.optimization).toHaveProperty('strategy');
    expect(recommendation?.optimization).toHaveProperty('ranked_candidates');
    expect(Array.isArray(recommendation?.optimization.ranked_candidates)).toBe(true);
  });

  it('should rank dispatch candidates with compensation guidance', async (context) => {
    await requireDbOrSkip(context);
    const { getDriverDispatchRecommendation } = await import('./db');
    const recommendation = await getDriverDispatchRecommendation(1);
    const bestCandidate = recommendation?.optimization.ranked_candidates[0];

    expect(bestCandidate).toBeDefined();
    expect(bestCandidate).toHaveProperty('compensation_multiplier');
    expect(bestCandidate).toHaveProperty('cherry_pick_risk');
    expect(bestCandidate?.score).toBeGreaterThanOrEqual(0);
  });
});
