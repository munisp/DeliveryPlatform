import { describe, expect, it, vi, beforeEach } from "vitest";

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

  beforeEach(() => {
    lakeState.poolConfig = null;
    lakeState.syncSelects = 0;
    vi.resetModules();
    vi.unstubAllGlobals();
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
});

