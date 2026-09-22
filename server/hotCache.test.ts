import { afterEach, describe, expect, it, vi } from "vitest";

import { createHotCache, type HotCache } from "./_core/hotCache";

let caches: Array<HotCache<unknown>> = [];

function makeCache<V>(options: Parameters<typeof createHotCache<V>>[0]): HotCache<V> {
  const cache = createHotCache<V>(options);
  caches.push(cache as HotCache<unknown>);
  return cache;
}

afterEach(() => {
  for (const cache of caches) cache.stop();
  caches = [];
  vi.useRealTimers();
});

describe("hotCache", () => {
  it("returns undefined for missing keys and the stored value after set", () => {
    const cache = makeCache<string>({ ttlMs: 1_000 });
    expect(cache.get("a")).toBeUndefined();
    cache.set("a", "alpha");
    expect(cache.get("a")).toBe("alpha");
    expect(cache.stats().hits).toBe(1);
    expect(cache.stats().misses).toBe(1);
  });

  it("expires entries after the TTL", () => {
    let now = 1_000;
    const cache = makeCache<string>({ ttlMs: 500, now: () => now });
    cache.set("k", "v");
    expect(cache.get("k")).toBe("v");
    now += 499;
    expect(cache.get("k")).toBe("v");
    now += 2; // 501ms elapsed
    expect(cache.get("k")).toBeUndefined();
    expect(cache.stats().size).toBe(0);
  });

  it("invalidates an exact key", () => {
    const cache = makeCache<number>({ ttlMs: 10_000 });
    cache.set("market:lagos", 1);
    cache.set("market:abuja", 2);
    expect(cache.invalidate("market:lagos")).toBe(1);
    expect(cache.get("market:lagos")).toBeUndefined();
    expect(cache.get("market:abuja")).toBe(2);
    expect(cache.invalidate("market:lagos")).toBe(0); // already gone
  });

  it("invalidates a key family by prefix*", () => {
    const cache = makeCache<number>({ ttlMs: 10_000 });
    cache.set("rv:1", 1);
    cache.set("rv:2", 2);
    cache.set("policy:lagos", 3);
    expect(cache.invalidate("rv:*")).toBe(2);
    expect(cache.get("rv:1")).toBeUndefined();
    expect(cache.get("rv:2")).toBeUndefined();
    expect(cache.get("policy:lagos")).toBe(3);
  });

  it("invalidate('*') clears the whole cache", () => {
    const cache = makeCache<number>({ ttlMs: 10_000 });
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.invalidate("*")).toBe(2);
    expect(cache.stats().size).toBe(0);
  });

  it("evicts the oldest entry when the max-entries cap is exceeded", () => {
    let now = 0;
    const cache = makeCache<string>({ ttlMs: 60_000, maxEntries: 2, now: () => now });
    cache.set("first", "1");
    now += 1;
    cache.set("second", "2");
    now += 1;
    cache.set("third", "3"); // exceeds cap -> evicts "first"
    expect(cache.get("first")).toBeUndefined();
    expect(cache.get("second")).toBe("2");
    expect(cache.get("third")).toBe("3");
    expect(cache.stats().evictions).toBe(1);
    expect(cache.stats().size).toBe(2);
  });

  it("re-setting an existing key refreshes its eviction position", () => {
    let now = 0;
    const cache = makeCache<string>({ ttlMs: 60_000, maxEntries: 2, now: () => now });
    cache.set("a", "1");
    now += 1;
    cache.set("b", "2");
    now += 1;
    cache.set("a", "1b"); // a becomes newest
    now += 1;
    cache.set("c", "3"); // evicts b
    expect(cache.get("a")).toBe("1b");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe("3");
  });

  it("the periodic sweep removes expired entries without reads", () => {
    vi.useFakeTimers();
    const cache = makeCache<string>({ ttlMs: 100, sweepIntervalMs: 50 });
    cache.set("x", "1");
    expect(cache.stats().size).toBe(1);
    vi.advanceTimersByTime(200);
    expect(cache.stats().size).toBe(0);
    expect(cache.stats().sweeps).toBeGreaterThan(0);
  });

  it("tracks hit/miss/set/invalidation stats", () => {
    const cache = makeCache<string>({ ttlMs: 10_000 });
    cache.set("k", "v");
    cache.get("k"); // hit
    cache.get("nope"); // miss
    cache.invalidate("k");
    const stats = cache.stats();
    expect(stats.sets).toBe(1);
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.invalidations).toBe(1);
    expect(stats.size).toBe(0);
  });
});
