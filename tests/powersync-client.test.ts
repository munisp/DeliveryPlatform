import { describe, expect, it, vi } from "vitest";

import {
  CREDENTIAL_PREFETCH_WINDOW_MS,
  DeliveryPlatformPowerSyncConnector,
  POWERSYNC_TOKEN_PATH,
  POWERSYNC_UPLOAD_PATH,
  detectPowerSyncSupport,
  resolvePowerSyncUrl,
  serializeCrudTransaction,
  shouldRefreshCredentials,
} from "../client/src/lib/powersync";

type RecordedCall = { url: string; init: Record<string, unknown> };

function makeFetchStub(
  responses: Array<{ ok: boolean; status: number; body?: unknown }>,
) {
  const calls: RecordedCall[] = [];
  const queue = [...responses];
  const fetchImpl = vi.fn(async (url: string, init: Record<string, unknown>) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error("unexpected fetch call");
    return {
      ok: next.ok,
      status: next.status,
      json: async () => next.body,
    };
  });
  return { calls, fetchImpl };
}

const tokenPayload = {
  token: "ps-token-1",
  endpoint: "https://powersync.example.test",
  expiresAt: "2026-11-11T12:00:00.000Z",
};

describe("powersync connector URL construction", () => {
  it("uses same-origin contract paths by default", () => {
    expect(POWERSYNC_TOKEN_PATH).toBe("/api/powersync/token");
    expect(POWERSYNC_UPLOAD_PATH).toBe("/api/powersync/upload");
    expect(resolvePowerSyncUrl("", POWERSYNC_TOKEN_PATH)).toBe(
      "/api/powersync/token",
    );
    expect(resolvePowerSyncUrl("", POWERSYNC_UPLOAD_PATH)).toBe(
      "/api/powersync/upload",
    );
  });

  it("joins a configured base URL without double slashes", () => {
    expect(
      resolvePowerSyncUrl("https://api.example.test/", "/api/powersync/token"),
    ).toBe("https://api.example.test/api/powersync/token");
    expect(
      resolvePowerSyncUrl("https://api.example.test", "api/powersync/upload"),
    ).toBe("https://api.example.test/api/powersync/upload");
  });

  it("requests the token with session cookies and JSON accept headers", async () => {
    const { calls, fetchImpl } = makeFetchStub([
      { ok: true, status: 200, body: tokenPayload },
    ]);
    const connector = new DeliveryPlatformPowerSyncConnector({ fetchImpl });

    const credentials = await connector.fetchCredentials();

    expect(credentials?.token).toBe("ps-token-1");
    expect(credentials?.endpoint).toBe("https://powersync.example.test");
    expect(credentials?.expiresAt?.toISOString()).toBe(tokenPayload.expiresAt);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/powersync/token");
    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].init.credentials).toBe("include");
    expect(calls[0].init.cache).toBe("no-store");
    expect(calls[0].init.headers).toEqual({ accept: "application/json" });
  });
});

describe("powersync credential prefetch TTL math", () => {
  it("refreshes when expiry is missing, invalid, or inside the prefetch window", () => {
    const now = Date.parse("2026-11-11T11:00:00.000Z");
    expect(shouldRefreshCredentials(null, now)).toBe(true);
    expect(shouldRefreshCredentials(undefined, now)).toBe(true);
    expect(shouldRefreshCredentials(new Date("not-a-date"), now)).toBe(true);
    // Exactly at the window boundary (<= 30s) the SDK refetches, so must we.
    expect(
      shouldRefreshCredentials(new Date(now + CREDENTIAL_PREFETCH_WINDOW_MS), now),
    ).toBe(true);
    expect(
      shouldRefreshCredentials(new Date(now + CREDENTIAL_PREFETCH_WINDOW_MS + 1), now),
    ).toBe(false);
    expect(shouldRefreshCredentials(new Date(now + 5 * 60_000), now)).toBe(false);
    expect(shouldRefreshCredentials(new Date(now - 1_000), now)).toBe(true);
  });

  it("serves cached credentials while fresh and refetches inside the prefetch window", async () => {
    const now = Date.parse("2026-11-11T11:00:00.000Z");
    let clock = now;
    const { calls, fetchImpl } = makeFetchStub([
      { ok: true, status: 200, body: tokenPayload },
      {
        ok: true,
        status: 200,
        body: { ...tokenPayload, token: "ps-token-2" },
      },
    ]);
    const connector = new DeliveryPlatformPowerSyncConnector({
      fetchImpl,
      now: () => clock,
    });

    // First call fetches (no cache).
    const first = await connector.fetchCredentials();
    expect(first?.token).toBe("ps-token-1");
    expect(calls).toHaveLength(1);

    // Token expires at 12:00, still ~60 minutes out: cached value is served.
    const cached = await connector.fetchCredentials();
    expect(cached?.token).toBe("ps-token-1");
    expect(calls).toHaveLength(1);

    // 20s before expiry (inside the <=30s prefetch window): refetch.
    clock = Date.parse("2026-11-11T11:59:40.000Z");
    const refreshed = await connector.fetchCredentials();
    expect(refreshed?.token).toBe("ps-token-2");
    expect(calls).toHaveLength(2);
  });

  it("returns null on 401 so the SDK parks instead of retrying", async () => {
    const { fetchImpl } = makeFetchStub([{ ok: false, status: 401 }]);
    const connector = new DeliveryPlatformPowerSyncConnector({ fetchImpl });
    await expect(connector.fetchCredentials()).resolves.toBeNull();
  });

  it("throws on transient token-endpoint failures so the SDK retries", async () => {
    const { fetchImpl } = makeFetchStub([{ ok: false, status: 503 }]);
    const connector = new DeliveryPlatformPowerSyncConnector({ fetchImpl });
    await expect(connector.fetchCredentials()).rejects.toThrow(
      "powersync_token_fetch_failed:503",
    );
  });
});

describe("powersync upload contract", () => {
  const crud = [
    { op: "PUT", table: "orders", id: "42", opData: { status: "confirmed" } },
    { op: "PATCH", table: "orders", id: "42", opData: { notes: "leave at door" } },
    { op: "DELETE", table: "order_tracking_events", id: "7" },
  ];

  function makeDatabase(complete: () => Promise<void>) {
    return {
      getNextCrudTransaction: vi.fn(async () => ({
        crud,
        transactionId: 3,
        complete,
      })),
    };
  }

  it("serializes queued operations FIFO into the fixed batch contract", () => {
    const batch = serializeCrudTransaction({ crud });
    expect(batch.operations.map((entry) => entry.op)).toEqual([
      "PUT",
      "PATCH",
      "DELETE",
    ]);
    expect(batch.operations[0]).toEqual({
      op: "PUT",
      table: "orders",
      id: "42",
      data: { status: "confirmed" },
    });
    expect(batch.operations[1].data).toEqual({ notes: "leave at door" });
    expect(batch.operations[2].table).toBe("order_tracking_events");
  });

  it("posts the batch with session cookies and completes only on success", async () => {
    const { calls, fetchImpl } = makeFetchStub([{ ok: true, status: 200, body: {} }]);
    const complete = vi.fn(async () => undefined);
    const connector = new DeliveryPlatformPowerSyncConnector({ fetchImpl });

    await connector.uploadData(makeDatabase(complete));

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/powersync/upload");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.credentials).toBe("include");
    expect(calls[0].init.headers).toEqual({
      accept: "application/json",
      "content-type": "application/json",
    });
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.operations).toHaveLength(3);
    expect(body.operations[0]).toMatchObject({
      op: "PUT",
      table: "orders",
      id: "42",
    });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("throws on non-2xx so the SDK retries, and never completes the transaction", async () => {
    const { fetchImpl } = makeFetchStub([
      { ok: false, status: 500 },
      { ok: false, status: 502 },
    ]);
    const complete = vi.fn(async () => undefined);
    const connector = new DeliveryPlatformPowerSyncConnector({ fetchImpl });

    await expect(connector.uploadData(makeDatabase(complete))).rejects.toThrow(
      "powersync_upload_failed:500",
    );
    await expect(connector.uploadData(makeDatabase(complete))).rejects.toThrow(
      "powersync_upload_failed:502",
    );
    expect(complete).not.toHaveBeenCalled();
  });

  it("does nothing when the upload queue is empty", async () => {
    const { calls, fetchImpl } = makeFetchStub([]);
    const connector = new DeliveryPlatformPowerSyncConnector({ fetchImpl });
    await connector.uploadData({
      getNextCrudTransaction: vi.fn(async () => null),
    });
    expect(calls).toHaveLength(0);
  });
});

describe("powersync OPFS feature detection degradation", () => {
  const supportedEnv = {
    secureContext: true,
    hasWorker: true,
    hasOpfs: true,
    crossOriginIsolated: true,
  };

  it("supports cross-origin-isolated secure contexts with OPFS", () => {
    expect(detectPowerSyncSupport(supportedEnv)).toEqual({
      supported: true,
      reason: null,
    });
  });

  it("degrades with a clear reason when OPFS is unavailable (e.g. Safari incognito)", () => {
    const result = detectPowerSyncSupport({ ...supportedEnv, hasOpfs: false });
    expect(result.supported).toBe(false);
    expect(result.reason).toContain("OPFS");
  });

  it("degrades when COOP/COEP cross-origin isolation headers are missing", () => {
    const result = detectPowerSyncSupport({
      ...supportedEnv,
      crossOriginIsolated: false,
    });
    expect(result.supported).toBe(false);
    expect(result.reason).toContain("COOP/COEP");
  });

  it("degrades on insecure contexts and missing web workers", () => {
    expect(
      detectPowerSyncSupport({ ...supportedEnv, secureContext: false }).reason,
    ).toContain("secure context");
    expect(
      detectPowerSyncSupport({ ...supportedEnv, hasWorker: false }).reason,
    ).toContain("web workers");
  });
});
