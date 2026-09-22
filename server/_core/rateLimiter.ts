import { createClient } from "redis";
import { ENV } from "./env";

type Bucket = {
  count: number;
  resetAt: number;
};

const rateWindowMs = 60_000;
const localBuckets = new Map<string, Bucket>();
type RedisClient = ReturnType<typeof createClient>;

/**
 * Local-fallback bucket hygiene (perf wave W2, audit finding 15): expired
 * buckets were only dropped lazily when the same key was hit again, so
 * one-shot keys (IPs, subjects) accumulated for the life of the process.
 * Sweep expired buckets every 5 minutes; the timer is unref'd so it never
 * keeps the process alive. The Redis path is untouched (TTLs there).
 */
const LOCAL_BUCKET_SWEEP_INTERVAL_MS = 5 * 60_000;

/** Drop expired local-fallback buckets; returns how many were removed. */
export function sweepLocalRateLimitBuckets(now: number = Date.now()): number {
  let removed = 0;
  for (const [key, bucket] of localBuckets) {
    if (bucket.resetAt <= now) {
      localBuckets.delete(key);
      removed += 1;
    }
  }
  return removed;
}

const localBucketSweepTimer = setInterval(() => {
  sweepLocalRateLimitBuckets();
}, LOCAL_BUCKET_SWEEP_INTERVAL_MS);
localBucketSweepTimer.unref?.();

/** Current local-fallback bucket count (test/observability support). */
export function getLocalRateLimitBucketCount(): number {
  return localBuckets.size;
}

let redisClientPromise: Promise<RedisClient | null> | null = null;

async function getRedisClient(): Promise<RedisClient | null> {
  if (!ENV.redisUrl) return null;
  if (!redisClientPromise) {
    redisClientPromise = (async () => {
      try {
        const client = createClient({ url: ENV.redisUrl });
        client.on("error", (error) => {
          console.warn("[SwitchOS] Redis rate limiter client error", error);
        });
        await client.connect();
        return client;
      } catch (error) {
        console.warn("[SwitchOS] Failed to connect Redis rate limiter client, falling back to local limiter", error);
        return null;
      }
    })();
  }
  return redisClientPromise;
}

function consumeLocalBucket(key: string, limit: number) {
  const now = Date.now();
  const existing = localBuckets.get(key);
  if (!existing || existing.resetAt <= now) {
    const bucket = { count: 1, resetAt: now + rateWindowMs };
    localBuckets.set(key, bucket);
    return { allowed: true, remaining: limit - 1, resetAt: bucket.resetAt, mode: "local" as const };
  }

  existing.count += 1;
  localBuckets.set(key, existing);
  return {
    allowed: existing.count <= limit,
    remaining: Math.max(0, limit - existing.count),
    resetAt: existing.resetAt,
    mode: "local" as const,
  };
}

async function consumeRedisBucket(key: string, limit: number) {
  const client = await getRedisClient();
  if (!client) {
    return consumeLocalBucket(key, limit);
  }

  const now = Date.now();
  const bucketKey = `switchos:ratelimit:${key}`;
  const multi = client.multi();
  multi.incr(bucketKey);
  multi.pTTL(bucketKey);
  const result = await multi.exec();
  const count = Number(result?.[0] ?? 0);
  let ttl = Number(result?.[1] ?? -1);

  if (ttl < 0) {
    await client.pExpire(bucketKey, rateWindowMs);
    ttl = rateWindowMs;
  }

  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    resetAt: now + ttl,
    mode: "redis" as const,
  };
}

export async function consumeRateLimit(key: string, limit: number) {
  try {
    return await consumeRedisBucket(key, limit);
  } catch (error) {
    console.warn("[SwitchOS] Falling back to local rate limiter after Redis bucket failure", error);
    redisClientPromise = null;
    return consumeLocalBucket(key, limit);
  }
}

export async function getRateLimiterStatus() {
  try {
    const client = await getRedisClient();
    return {
      redisConfigured: Boolean(ENV.redisUrl),
      redisConnected: Boolean(client?.isOpen),
      mode: client?.isOpen ? "redis" : "local-fallback",
    };
  } catch {
    redisClientPromise = null;
    return {
      redisConfigured: Boolean(ENV.redisUrl),
      redisConnected: false,
      mode: "local-fallback",
    };
  }
}
