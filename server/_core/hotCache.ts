/**
 * Tiny in-process TTL cache for hot, near-static reads (perf wave W2).
 *
 * Pattern proven in sessionRevocationStore.ts: single-process Map with
 * lazy expiry on read plus a periodic sweep so expired entries cannot
 * accumulate between accesses. Each consumer (economicsPolicy,
 * driverProtection, contractDefaults, riderVerification, policy) creates
 * its own cache instance with its own TTL and invalidates on the matching
 * mutation, so a stale read never survives the write that supersedes it on
 * the serving process.
 *
 * Invalidation contract: `invalidate(key)` removes exactly `key`;
 * `invalidate("prefix:*")` (trailing asterisk) removes every key starting
 * with `prefix:`. `invalidate("*")` clears the whole cache.
 */

export type HotCacheOptions = {
  /** Time-to-live per entry in milliseconds. */
  ttlMs: number;
  /** Hard cap on live entries; oldest entries are evicted beyond it. Default 1024. */
  maxEntries?: number;
  /** Periodic sweep interval for expired entries. Default 60000ms. Timer is unref'd. */
  sweepIntervalMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
};

export type HotCacheStats = {
  size: number;
  hits: number;
  misses: number;
  sets: number;
  invalidations: number;
  evictions: number;
  sweeps: number;
};

export type HotCache<V> = {
  /** Return the cached value, or undefined when absent/expired. */
  get(key: string): V | undefined;
  /** Store a value under key with the cache TTL. */
  set(key: string, value: V): void;
  /**
   * Invalidate one key, a `prefix:*` family, or everything (`*`).
   * Returns the number of entries removed.
   */
  invalidate(keyOrPrefix: string): number;
  /** Drop all entries. */
  clear(): void;
  /** Remove expired entries; returns how many were removed. */
  sweep(): number;
  stats(): HotCacheStats;
  /** Stop the periodic sweep timer (tests / shutdown). */
  stop(): void;
};

type Entry<V> = {
  value: V;
  expiresAt: number;
};

const DEFAULT_MAX_ENTRIES = 1024;
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

export function createHotCache<V>(options: HotCacheOptions): HotCache<V> {
  const ttlMs = Math.max(1, options.ttlMs);
  const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry<V>>();
  const stats: HotCacheStats = {
    size: 0,
    hits: 0,
    misses: 0,
    sets: 0,
    invalidations: 0,
    evictions: 0,
    sweeps: 0,
  };

  function sweep(): number {
    const cutoff = now();
    let removed = 0;
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= cutoff) {
        entries.delete(key);
        removed += 1;
      }
    }
    if (removed > 0) stats.size = entries.size;
    stats.sweeps += 1;
    return removed;
  }

  function evictOldest(): void {
    // Map iteration order is insertion order; a `set` on an existing key is
    // re-inserted at the tail, so the head is the least-recently-written.
    const oldestKey = entries.keys().next().value as string | undefined;
    if (oldestKey !== undefined) {
      entries.delete(oldestKey);
      stats.evictions += 1;
    }
  }

  const timer = setInterval(sweep, Math.max(1, options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS));
  // Never keep the process alive for cache hygiene.
  timer.unref?.();

  return {
    get(key: string): V | undefined {
      const entry = entries.get(key);
      if (!entry) {
        stats.misses += 1;
        return undefined;
      }
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        stats.size = entries.size;
        stats.misses += 1;
        return undefined;
      }
      stats.hits += 1;
      return entry.value;
    },

    set(key: string, value: V): void {
      entries.delete(key); // refresh insertion order
      entries.set(key, { value, expiresAt: now() + ttlMs });
      stats.sets += 1;
      while (entries.size > maxEntries) {
        evictOldest();
      }
      stats.size = entries.size;
    },

    invalidate(keyOrPrefix: string): number {
      let removed = 0;
      if (keyOrPrefix === "*") {
        removed = entries.size;
        entries.clear();
      } else if (keyOrPrefix.endsWith("*")) {
        const prefix = keyOrPrefix.slice(0, -1);
        for (const key of [...entries.keys()]) {
          if (key.startsWith(prefix)) {
            entries.delete(key);
            removed += 1;
          }
        }
      } else if (entries.delete(keyOrPrefix)) {
        removed = 1;
      }
      if (removed > 0) {
        stats.invalidations += removed;
        stats.size = entries.size;
      }
      return removed;
    },

    clear(): void {
      stats.invalidations += entries.size;
      entries.clear();
      stats.size = 0;
    },

    sweep,

    stats(): HotCacheStats {
      return { ...stats, size: entries.size };
    },

    stop(): void {
      clearInterval(timer);
    },
  };
}
