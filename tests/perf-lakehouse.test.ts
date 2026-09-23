import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

describe("W2b perf gates: lakehouse sync decoupling", () => {
  const lakeState = vi.hoisted(() => ({
    poolConfig: null as Record<string, unknown> | null,
    syncSelects: 0,
  }));

  vi.mock("pg", () => {
    class MockPool {
      constructor(config: Record<string, unknown>) {
        lakeState.poolConfig = config;
      }
      async query(text: string) {
        if (text.includes("FROM orders")) lakeState.syncSelects += 1;
        return { rows: [], rowCount: 0 };
      }
      async connect() {
        return { query: this.query.bind(this), release: () => undefined };
      }
    }
    return { default: { Pool: MockPool }, Pool: MockPool };
  });

  // Controllable clock: the lakehouse circuit breaker and hot cache capture
  // the Date.now reference at module construction, so patch it before each
  // test's dynamic import (resetModules gives every test a fresh module).
  let nowOffsetMs = 0;
  let realDateNow: typeof Date.now;

  beforeEach(() => {
    lakeState.poolConfig = null;
    lakeState.syncSelects = 0;
    realDateNow = Date.now;
    nowOffsetMs = 0;
    Date.now = () => realDateNow() + nowOffsetMs;
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    Date.now = realDateNow;
  });

  it("fetchLakehouse goes through resilientFetch with a 2s timeout and abort signal", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ source: "lakehouse" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { getLakehouseAnalyticsSummary } = await import(
      "../server/lib/lakehouse"
    );
    await expect(getLakehouseAnalyticsSummary()).resolves.toMatchObject({
      source: "lakehouse",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("fail-opens fast: two consecutive failures open the dedicated lakehouse breaker", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("lakehouse down"));
    vi.stubGlobal("fetch", fetchMock);
    const { getLakehouseOrderStats } = await import("../server/lib/lakehouse");
    await expect(getLakehouseOrderStats()).rejects.toThrow();
    await expect(getLakehouseOrderStats()).rejects.toThrow();
    const callsBefore = fetchMock.mock.calls.length;
    await expect(getLakehouseOrderStats()).rejects.toMatchObject({
      name: "CircuitOpenError",
    });
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });

  it("bounds the lakehouse pool and sets a statement_timeout", async () => {
    const { startLakehouseSyncer } = await import("../server/lib/lakehouse");
    const stop = startLakehouseSyncer(60_000);
    stop();
    expect(lakeState.poolConfig).toMatchObject({
      max: 5,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 30000,
    });
    expect(`${lakeState.poolConfig?.options}`).toContain("statement_timeout");
  });

  it("interval syncer is overlap-guarded and tracks last-sync freshness", async () => {
    const pending: Array<() => void> = [];
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(() =>
            resolve({ ok: true, json: async () => ({}), text: async () => "" }),
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const lakehouse = await import("../server/lib/lakehouse");
    expect(lakehouse.getLakehouseDataFreshnessSeconds()).toBeNull();
    expect(lakehouse.getLakehouseLastSyncAt()).toBeNull();

    const stop = lakehouse.startLakehouseSyncer(5);
    try {
      // Let several interval ticks fire while the first sync is still in
      // flight: the overlap guard must keep exactly one sync running.
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(lakeState.syncSelects).toBe(1);
      // Release every queued lakehouse ingest POST and let the sync settle.
      pending.splice(0).forEach((release) => release());
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(lakehouse.getLakehouseLastSyncAt()).not.toBeNull();
      expect(lakehouse.getLakehouseDataFreshnessSeconds()).toBe(0);
    } finally {
      stop();
      pending.splice(0).forEach((release) => release());
    }
  });

  it("serves repeat analytics reads from the TTL cache (W7)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ source: "lakehouse", total: 42 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { getLakehouseAnalyticsSummary } = await import(
      "../server/lib/lakehouse"
    );
    const first = await getLakehouseAnalyticsSummary();
    const second = await getLakehouseAnalyticsSummary();
    expect(first).toMatchObject({ total: 42 });
    expect(second).toMatchObject({ total: 42 });
    // The python-side analytics queries cost ~260ms p50; the second read
    // within the TTL must not hit the lakehouse again.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("invalidateLakehouseReadCache forces a refetch; failures are never cached", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ source: "lakehouse", total: 1 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ source: "lakehouse", total: 2 }),
      })
      // fetchLakehouse retries idempotent GETs (maxAttempts: 2): both
      // attempts of the failing read must reject for the error to surface.
      .mockRejectedValueOnce(new Error("lakehouse down"))
      .mockRejectedValueOnce(new Error("lakehouse down"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ source: "lakehouse", total: 3 }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const lakehouse = await import("../server/lib/lakehouse");
    await expect(lakehouse.getLakehouseOrderStats()).resolves.toMatchObject({
      total: 1,
    });
    lakehouse.invalidateLakehouseReadCache();
    await expect(lakehouse.getLakehouseOrderStats()).resolves.toMatchObject({
      total: 2,
    });
    // The refetched success is itself cached; invalidate again so the next
    // read actually reaches the (failing) lakehouse.
    lakehouse.invalidateLakehouseReadCache();
    await expect(lakehouse.getLakehouseOrderStats()).rejects.toThrow(
      "lakehouse down",
    );
    // The failure must not be cached: the next read fetches again.
    // (Two consecutive failures trip the lakehouse circuit breaker; advance
    // past its 15s resetTimeoutMs so the next read half-opens.)
    nowOffsetMs += 16_000;
    await expect(lakehouse.getLakehouseOrderStats()).resolves.toMatchObject({
      total: 3,
    });
    // Fetches: read1 + refetch + 2 attempts of the failing read (idempotent
    // GET retries once) + the post-failure refetch = 5 total.
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("declares a read-cache TTL below the sync interval", async () => {
    const { ENV } = await import("../server/_core/env");
    expect(ENV.lakehouseReadCacheTtlMs).toBe(30_000);
    expect(ENV.lakehouseReadCacheTtlMs).toBeLessThan(
      ENV.lakehouseSyncIntervalMs,
    );
  });
});

