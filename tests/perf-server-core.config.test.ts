import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it, vi, beforeEach } from "vitest";

const root = resolve(import.meta.dirname, "..");
const source = (rel: string) =>
  readFileSync(resolve(root, rel), "utf8");

describe("W2b perf gates: compression + fast health (source contract)", () => {
  it("compression is zero-dependency (Node zlib, no package.json entry)", () => {
    const pkg = JSON.parse(source("package.json")) as {
      dependencies?: Record<string, string>;
    };
    // The middleware is implemented on Node's built-in zlib so the change
    // requires no dependency or lockfile update.
    expect(pkg.dependencies?.compression).toBeFalsy();
    const index = source("server/_core/index.ts");
    expect(index).not.toContain('from "compression"');
    expect(index).toContain('import zlib from "zlib";');
  });

  it("wires the zlib compression middleware immediately after httpMetricsMiddleware with an SSE exclusion", () => {
    const index = source("server/_core/index.ts");
    const metricsAt = index.indexOf("app.use(httpMetricsMiddleware);");
    const negotiateAt = index.indexOf("negotiateCompressibleEncoding");
    expect(metricsAt).toBeGreaterThan(-1);
    expect(negotiateAt).toBeGreaterThan(metricsAt);
    // The realtime tracking SSE stream must be excluded from compression.
    expect(index).toContain("/api/tracking/live/");
    // Compressed responses must advertise the encoding and vary on negotiation.
    expect(index).toContain('res.setHeader("Content-Encoding", encoding)');
    expect(index).toContain('res.setHeader("Vary", "Accept-Encoding")');
    // Chunks stream through with a partial flush (no full buffering).
    expect(index).toContain("Z_PARTIAL_FLUSH");
  });

  it("/api/health performs no event write, no Redis status read, no OIDC discovery", () => {
    const index = source("server/_core/index.ts");
    const start = index.indexOf('app.get("/api/health"');
    expect(start).toBeGreaterThan(-1);
    const block = index.slice(start, index.indexOf("});", start) + 3);
    expect(block).not.toContain("recordOperationalEvent");
    expect(block).not.toContain("getRateLimiterStatus");
    expect(block).not.toContain("getOidcDiscoveryDocument");
    expect(block).not.toContain("await ");
  });

  it("request-path operational events are fire-and-forget", () => {
    const index = source("server/_core/index.ts");
    const awaited = index.match(/await recordOperationalEvent/g) ?? [];
    // The only awaited site left is /api/telemetry/client-errors, where the
    // event write IS the operation (it reports 503 when the write fails).
    expect(awaited.length).toBe(1);
    expect(index.indexOf("await recordOperationalEvent")).toBeGreaterThan(
      index.indexOf('app.post("/api/telemetry/client-errors"'),
    );
    const fireAndForget = index.match(/void recordOperationalEvent/g) ?? [];
    expect(fireAndForget.length).toBeGreaterThanOrEqual(60);
  });
});

describe("W2b perf gates: non-blocking operational event publish legs", () => {
  const kafkaState = vi.hoisted(() => ({
    send: vi.fn(),
  }));

  vi.mock("kafkajs", () => ({
    Kafka: vi.fn(() => ({
      producer: () => ({
        connect: vi.fn().mockResolvedValue(undefined),
        send: kafkaState.send,
      }),
    })),
    logLevel: { NOTHING: 0 },
  }));

  beforeEach(() => {
    kafkaState.send.mockReset();
    vi.resetModules();
  });

  it("recordOperationalEvent resolves without waiting for a stalled broker publish", async () => {
    process.env.DATABASE_URL = "";
    process.env.KAFKA_BROKERS = "broker-a:9092";
    process.env.KAFKA_OPERATIONAL_EVENTS_TOPIC = "ops-events";
    process.env.DAPR_HTTP_PORT = "";
    process.env.OPENSEARCH_URL = "";

    let resolveSend: (() => void) | null = null;
    kafkaState.send.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
    );

    const { recordOperationalEvent, drainOperationalEventPublishes } =
      await import("../server/_core/operationalEvents");

    const result = await recordOperationalEvent({
      eventType: "auth.local.login",
      route: "/api/auth/login",
      outcome: "success",
    });
    // Resolved even though the Kafka send is still pending.
    expect(result.kafkaPublished).toBe(true);
    // Let the queued leg reach the (still-pending) broker send.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(kafkaState.send).toHaveBeenCalledTimes(1);
    resolveSend?.();
    await expect(drainOperationalEventPublishes()).resolves.toBeUndefined();

    process.env.KAFKA_BROKERS = "";
  });

  it("operational events pool sets a server-side statement_timeout", () => {
    const sourceText = source("server/_core/operationalEvents.ts");
    expect(sourceText).toContain('options: "-c statement_timeout=15000"');
  });
});

describe("W2b perf gates: FAIL_OPEN_FAST preset on fail-open callers", () => {
  it.each([
    ["server/_core/tripSafety.ts", 2],
    ["server/_core/integrityIncentives.ts", 1],
    ["server/_core/dataPortability.ts", 2],
  ])(
    "%s routes its fail-open resilientFetch calls through FAIL_OPEN_FAST",
    (file, sites) => {
      const text = source(file);
      const spreads = text.match(/\.\.\.FAIL_OPEN_FAST,/g) ?? [];
      expect(spreads.length).toBe(sites);
      // The old unbounded fail-open timeout (5s x 5 failures before the
      // shared breaker opened) must be gone from these call sites.
      expect(text).not.toContain("timeoutMs: 5_000");
      // The shared preset is imported directly from resilientFetch (merged
      // to main with perf/w2a-cache, PR #46).
      expect(text).toContain(
        'import { FAIL_OPEN_FAST, resilientFetch } from "./resilientFetch";',
      );
    },
  );
});

describe("W2b perf gates: rider verification cache invalidation on operator decisions", () => {
  it("decideCase invalidates the verification status cache", () => {
    const router = source("server/routers.ts");
    expect(router).toContain(
      'import { invalidateVerificationStatusCache } from "./_core/riderVerification";',
    );
    const decideAt = router.indexOf("decideVerificationCase({ actorUserId");
    expect(decideAt).toBeGreaterThan(-1);
    const block = router.slice(decideAt, decideAt + 900);
    expect(block).toContain("invalidateVerificationStatusCache();");
  });
});

describe("W2b perf gates: satellite pool hardening", () => {
  it.each([
    "server/_core/vehicleAccess.ts",
    "server/_core/fieldService.ts",
    "server/_core/merchantCommerce.ts",
    "server/_core/developerApi.ts",
    "server/_core/operatorAuthStore.ts",
    "server/_core/stakeholderVerification.ts",
    "server/_core/commerceFulfillment.ts",
    "server/_core/deliveryTrackingStore.ts",
    "server/_core/longcatActions.ts",
    "server/_core/longcatVoice.ts",
    "server/_core/realtimeTracking.ts",
    "server/_core/medusaCommerce.ts",
    "server/_core/financialAdminStore.ts",
    "server/lib/platformWorkspaces.ts",
    "server/_core/driverDispatchFairness.ts",
    "server/lib/lakehouse.ts",
  ])("%s caps its pool and sets timeouts + statement_timeout", (file) => {
    const text = source(file);
    const pools = text.split("new Pool({").slice(1);
    expect(pools.length).toBeGreaterThan(0);
    for (const pool of pools) {
      const block = pool.slice(0, pool.indexOf("});"));
      const maxMatch = block.match(/max:\s*(?:Math\.min\([^,]+,\s*)?(\d+)/);
      expect(maxMatch, `${file} pool must declare max`).toBeTruthy();
      expect(Number(maxMatch?.[1])).toBeLessThanOrEqual(5);
      expect(block).toContain("connectionTimeoutMillis: 3000");
      expect(block).toContain("idleTimeoutMillis: 30000");
      expect(block).toContain("statement_timeout");
    }
  });
});
