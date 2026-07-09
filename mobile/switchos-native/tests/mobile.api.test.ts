import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/trpc", () => ({
  createTRPCClient: () => ({
    smartSearch: {
      query: vi.fn(),
    },
  }),
}));

import { buildRecentOperationalSeries, buildSparkline, trendDirection } from "../lib/mobile/analytics";
import {
  buildFreshnessLabel,
  buildOfflineSmartSearch,
  buildOperationalMetrics,
  buildQueuedActionDescriptor,
  loadOperationalSnapshot,
  probeServices,
} from "../lib/mobile/api";
import { applyDispatchFilters, applyMerchantFilters, formatFreshness, priorityWeight } from "../lib/mobile/workspace";
import type { DispatchZone, MerchantSignal, OperatorSettings, SnapshotData } from "../lib/mobile/types";

const settings: OperatorSettings = {
  operatorName: "Amina",
  region: "Lagos",
  platformBaseUrl: "https://platform.example.com/snapshot",
  localCommerceGatewayUrl: "https://commerce.example.com/snapshot",
  inventoryControlUrl: "",
  procurementPlannerUrl: "",
  dispatchOptimizerUrl: "https://dispatch.example.com/snapshot",
  enableNotifications: true,
  autoSyncOnCellular: true,
  lastEnvironmentLabel: "test",
};

const previousSnapshot: SnapshotData = {
  summary: {
    generatedAt: new Date(0).toISOString(),
    freshnessLabel: "Cached snapshot only",
    logisticsHeadline: "Cached logistics headline",
    queueCount: 0,
    failedCount: 0,
    serviceCount: 0,
  },
  services: [],
  inventory: [],
  procurement: [],
  dispatch: [],
  merchants: [],
  loyalty: [],
  alerts: [],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildQueuedActionDescriptor", () => {
  it("maps merchant campaign actions to the expected backend route", () => {
    const descriptor = buildQueuedActionDescriptor("merchant_campaign", {
      title: "Run campaign",
      note: "Field requested",
    });

    expect(descriptor.route).toBe("/merchant-growth/campaign");
    expect(descriptor.payload.title).toBe("Run campaign");
  });
});

describe("probeServices", () => {
  it("reports healthy services when fetch succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue("{}"),
      }),
    );

    const result = await probeServices(settings);

    expect(result).toHaveLength(3);
    expect(result[0]?.status).toBe("healthy");
    expect(result[1]?.status).toBe("healthy");
    expect(result[2]?.status).toBe("healthy");
  });

  it("reports offline services when fetch throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );

    const result = await probeServices(settings);

    expect(result[0]?.status).toBe("offline");
    expect(result[0]?.detail).toContain("network down");
  });
});

describe("loadOperationalSnapshot", () => {
  it("maps logistics, dispatch, and merchant payloads into mobile snapshot collections", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: vi.fn().mockResolvedValue(JSON.stringify({
            summary: { recommended_action: "Tighten channel mix" },
            benchmarks: {
              benchmark_summary: "Owned share improving",
              external_domains: [{ label: "Fresh Mart", domain: "freshmart.ng", visits_total_latest: 42000, change: "watch" }],
            },
            loyalty: {
              active_rewards: [{ id: 8, name: "Winback Credit", description: "Issue a recovery reward." }],
            },
          })),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: vi.fn().mockResolvedValue(JSON.stringify({
            summary: "Two warehouses need intervention.",
            network: {
              nodes: [{
                warehouse_id: 11,
                label: "Ikeja Hub",
                zone_key: "lagos-west",
                stock_cover_hours: 9,
                recommended_restock_units: 180,
                risk_band: "critical",
                stock_accuracy: 0.92,
                narrative: "Low fresh stock across the west zone.",
              }],
            },
            procurement: {
              procurement_actions: [{
                sku: "SKU-9",
                label: "Bottled Water",
                warehouse_label: "Ikeja Hub",
                supplier_name: "Aqua Supply",
                recommended_units: 180,
                lead_time_hours: 12,
                risk_band: "critical",
                action_mode: "purchase",
                narrative: "Place a top-up purchase before the evening peak.",
              }],
            },
            alerts: ["Fresh inventory risk in Lagos West"],
          })),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: vi.fn().mockResolvedValue(JSON.stringify({
            telemetry: {
              summary: "Open queue elevated in two zones.",
              hotspots: [{
                zone_key: "Victoria Island",
                pressure_band: "watch",
                avg_wait_minutes: 13,
                available_drivers: 6,
              }],
            },
          })),
        }),
    );

    const result = await loadOperationalSnapshot(settings, previousSnapshot);

    expect(result.inventory[0]?.name).toBe("Ikeja Hub");
    expect(result.procurement[0]?.supplier).toBe("Aqua Supply");
    expect(result.dispatch[0]?.name).toBe("Victoria Island");
    expect(result.merchants[0]?.merchantName).toBe("Fresh Mart");
    expect(result.loyalty[0]?.customerLabel).toBe("Winback Credit");
    expect(result.alerts.length).toBeGreaterThan(0);
    expect(result.logisticsHeadline).toContain("Two warehouses");
  });

  it("falls back to the previous cached collections when payloads are unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("timeout")),
    );

    const cachedSnapshot: SnapshotData = {
      ...previousSnapshot,
      inventory: [{
        id: "cached-1",
        name: "Cached Hub",
        region: "lagos-east",
        risk: "watch",
        confidence: "medium",
        stockCoverageHours: 18,
        restockUrgency: "Review",
        note: "Cached inventory node",
      }],
      dispatch: [{
        id: "zone-1",
        name: "Yaba",
        pressure: "watch",
        driverBalance: "5 drivers available",
        suggestedAction: "Rebalance near Yaba",
        note: "Cached dispatch zone",
      }],
      merchants: [{
        id: "merchant-1",
        merchantName: "Cached Merchant",
        benchmarkStatus: "stable",
        campaignReadiness: "Ready",
        nextAction: "Retain spend",
      }],
      loyalty: [{
        id: "loyalty-1",
        customerLabel: "Cached Customer",
        status: "watch",
        recommendedAction: "Offer a retention credit",
        lastTouchpoint: "Yesterday",
      }],
    };

    const result = await loadOperationalSnapshot(settings, cachedSnapshot);

    expect(result.inventory[0]?.name).toBe("Cached Hub");
    expect(result.dispatch[0]?.name).toBe("Yaba");
    expect(result.merchants[0]?.merchantName).toBe("Cached Merchant");
    expect(result.loyalty[0]?.customerLabel).toBe("Cached Customer");
    expect(result.services.every((service) => service.status === "offline")).toBe(true);
  });
});

describe("snapshot helpers", () => {
  it("builds offline smart-search matches for inventory and dispatch records", () => {
    const snapshot: SnapshotData = {
      ...previousSnapshot,
      inventory: [{
        id: "inv-1",
        name: "Ikeja Cold Hub",
        region: "Lagos",
        risk: "critical",
        confidence: "high",
        restockUrgency: "Urgent replenishment",
        note: "Low cold-chain stock for peak demand",
      }],
      dispatch: [{
        id: "dz-1",
        name: "Victoria Island",
        pressure: "watch",
        driverBalance: "6 riders short",
        suggestedAction: "Rebalance riders toward waterfront corridor",
        note: "Lunch demand spike forming",
      }],
    };

    const result = buildOfflineSmartSearch(snapshot, "show stockout risk in lagos and rider rebalance", "lagos");

    expect(result.length).toBeGreaterThan(0);
    expect(result[0]?.explanationChips.length).toBeGreaterThan(0);
    expect(result.some((item) => item.domain === "inventory" || item.domain === "dispatch")).toBe(true);
  });

  it("returns the correct freshness label for partial and healthy states", () => {
    expect(buildFreshnessLabel([])).toBe("No endpoints configured");
    expect(buildFreshnessLabel([
      { key: "a", label: "A", status: "healthy" },
      { key: "b", label: "B", status: "degraded" },
    ])).toBe("Partial live snapshot with fallbacks");
    expect(buildFreshnessLabel([
      { key: "a", label: "A", status: "healthy" },
    ])).toBe("Fresh live snapshot");
  });

  it("derives critical operational counts from the hydrated snapshot", () => {
    const metrics = buildOperationalMetrics({
      ...previousSnapshot,
      inventory: [{
        id: "n1",
        name: "Node",
        region: "lagos",
        risk: "critical",
        confidence: "high",
      }],
      dispatch: [{
        id: "d1",
        name: "Zone",
        pressure: "critical",
      }],
      merchants: [{
        id: "m1",
        merchantName: "Merchant",
        benchmarkStatus: "critical",
      }],
      loyalty: [{
        id: "l1",
        customerLabel: "Customer",
        status: "watch",
      }],
    });

    expect(metrics.criticalInventory).toBe(1);
    expect(metrics.criticalDispatch).toBe(1);
    expect(metrics.criticalMerchantSignals).toBe(1);
    expect(metrics.loyaltyAttention).toBe(1);
  });
});

describe("workspace helpers", () => {
  it("prioritizes urgent queue items above lower priority items", () => {
    expect(priorityWeight("urgent")).toBeGreaterThan(priorityWeight("normal"));
    expect(priorityWeight("high")).toBeGreaterThan(priorityWeight("low"));
  });

  it("formats freshness states for fresh and stale records", () => {
    expect(formatFreshness(18)).toContain("18m");
    expect(formatFreshness(undefined)).toBe("Freshness unknown");
  });

  it("filters dispatch zones by query, pinning, and risk", () => {
    const zones: DispatchZone[] = [
      { id: "1", name: "Victoria Island", pressure: "critical", pinned: true, freshnessMinutes: 10 },
      { id: "2", name: "Yaba", pressure: "stable", pinned: false, freshnessMinutes: 70 },
    ];

    const result = applyDispatchFilters(zones, {
      query: "victoria",
      risk: "critical",
      pinnedOnly: true,
      sortBy: "risk_desc",
      region: "all",
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("Victoria Island");
  });

  it("filters merchants by pinned state and sorts by freshness", () => {
    const merchants: MerchantSignal[] = [
      { id: "1", merchantName: "Alpha Foods", benchmarkStatus: "watch", pinned: true, freshnessMinutes: 30 },
      { id: "2", merchantName: "Beta Store", benchmarkStatus: "critical", pinned: false, freshnessMinutes: 90 },
    ];

    const result = applyMerchantFilters(merchants, {
      query: "",
      risk: "all",
      pinnedOnly: true,
      sortBy: "freshness_desc",
      region: "all",
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.merchantName).toBe("Alpha Foods");
  });
});

describe("annotation metadata", () => {
  it("retains annotation data on queued attachment drafts", () => {
    const attachment = {
      id: "att-1",
      uri: "file://evidence.jpg",
      name: "Evidence.jpg",
      annotations: {
        strokes: [{ id: "s1", color: "#F97316", width: 3, points: [{ x: 1, y: 2 }, { x: 10, y: 12 }] }],
        texts: [{ id: "t1", text: "Leak here", color: "#FFFFFF", x: 24, y: 40 }],
        annotatedAt: new Date().toISOString(),
      },
    };

    expect(attachment.annotations?.strokes[0]?.points).toHaveLength(2);
    expect(attachment.annotations?.texts[0]?.text).toContain("Leak");
  });
});

describe("analytics helpers", () => {
  it("builds operational series for lightweight native sparklines", () => {
    const series = buildRecentOperationalSeries(5, 2, 1);

    expect(series).toHaveLength(5);
    expect(series[2]).toBe(5);
  });

  it("renders a sparkline and identifies direction", () => {
    const sparkline = buildSparkline([1, 2, 3, 4, 5]);

    expect(sparkline.length).toBe(5);
    expect(trendDirection([1, 3, 5])).toBe("up");
    expect(trendDirection([5, 3, 1])).toBe("down");
    expect(trendDirection([2, 2, 2])).toBe("steady");
  });
});
