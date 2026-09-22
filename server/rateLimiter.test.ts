import { afterEach, describe, expect, it, vi } from "vitest";

import {
  consumeRateLimit,
  getLocalRateLimitBucketCount,
  sweepLocalRateLimitBuckets,
} from "./_core/rateLimiter";

/**
 * Local-fallback bucket sweep (perf wave W2): expired buckets must not
 * accumulate. REDIS_URL is unset here, so consumeRateLimit exercises the
 * local Map path directly.
 */

afterEach(() => {
  vi.useRealTimers();
});

describe("rate limiter local-bucket sweep", () => {
  it("drops expired local buckets and keeps live ones", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);

    await consumeRateLimit("ip:old", 5);
    vi.setSystemTime(1_000_000 + 30_000);
    await consumeRateLimit("ip:live", 5);
    expect(getLocalRateLimitBucketCount()).toBe(2);

    // Advance past the first bucket's 60s window but not the second's.
    vi.setSystemTime(1_000_000 + 61_000);
    const removed = sweepLocalRateLimitBuckets();
    expect(removed).toBe(1);
    expect(getLocalRateLimitBucketCount()).toBe(1);

    // The surviving bucket still rate-limits on its original window.
    const third = await consumeRateLimit("ip:live", 1);
    expect(third.allowed).toBe(false); // second consume on the live bucket exceeded limit 1
    expect(third.mode).toBe("local");

    // Everything is gone once all windows expire.
    vi.setSystemTime(1_000_000 + 130_000);
    expect(sweepLocalRateLimitBuckets()).toBe(1);
    expect(getLocalRateLimitBucketCount()).toBe(0);
  });

  it("the periodic timer sweeps without explicit calls (5-minute interval, unref'd)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000_000);
    // Re-import so the module-level sweep timer is created under fake timers.
    vi.resetModules();
    const fresh = await import("./_core/rateLimiter");

    await fresh.consumeRateLimit("ip:timer", 5);
    expect(fresh.getLocalRateLimitBucketCount()).toBe(1);

    // Past the 60s window; the next 5-minute sweep tick removes the bucket.
    vi.advanceTimersByTime(61_000);
    expect(fresh.getLocalRateLimitBucketCount()).toBe(1); // lazy path not hit
    vi.advanceTimersByTime(5 * 60_000);
    expect(fresh.getLocalRateLimitBucketCount()).toBe(0);
  });
});
