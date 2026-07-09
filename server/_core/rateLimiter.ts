import { createClient, type RedisClientType } from "redis";
import { ENV } from "./env";

type Bucket = {
  count: number;
  resetAt: number;
};

const rateWindowMs = 60_000;
const localBuckets = new Map<string, Bucket>();
let redisClientPromise: Promise<RedisClientType | null> | null = null;

async function getRedisClient(): Promise<RedisClientType | null> {
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
