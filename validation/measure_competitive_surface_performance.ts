import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { ENV } from "../server/_core/env";
import { buildLocalCommerceSuperGatewayWorkspace, planLocalCommerceConciergeIntent } from "../server/_core/localCommerceSuperGateway";

type Sample = {
  iteration: number;
  duration_ms: number;
  ok: boolean;
  status?: number;
  error?: string;
};

type Summary = {
  count: number;
  ok_count: number;
  min_ms: number;
  median_ms: number;
  p95_ms: number;
  max_ms: number;
  avg_ms: number;
};

const scenario = {
  city: "Lagos",
  customerSegment: "switchos_one_member",
  categories: ["delivery", "retail", "travel", "mobility"],
  request: "Plan a same-day grocery and pharmacy basket, preserve my membership benefits, and keep the option to add an airport transfer for later tonight.",
  basket: [
    {
      sku: "milk-1l",
      label: "Milk 1L",
      category: "grocery",
      quantity: 6,
      onHandUnits: 4,
      reservedUnits: 1,
      inboundUnits: 2,
      leadTimeHours: 6,
      eventMultiplier: 1.2,
      weatherMultiplier: 1.0,
      substitutionGroup: "dairy_alt",
      coldChainRequired: true,
    },
    {
      sku: "pain-relief-24",
      label: "Pain Relief 24ct",
      category: "pharmacy",
      quantity: 3,
      onHandUnits: 1,
      reservedUnits: 0,
      inboundUnits: 4,
      leadTimeHours: 4,
      eventMultiplier: 1.1,
      weatherMultiplier: 1.0,
      substitutionGroup: "analgesic_alt",
      coldChainRequired: false,
    },
  ],
  warehouseCandidates: [
    {
      warehouseId: 701,
      label: "VI Dark Store",
      zoneKey: "Victoria Island",
      distanceKm: 3.2,
      pickPackMinutes: 9,
      coldChainReady: true,
      stockAccuracy: 0.97,
      inventory: [
        { sku: "milk-1l", availableUnits: 5, freshnessHours: 18 },
        { sku: "pain-relief-24", availableUnits: 2, freshnessHours: 240 },
      ],
    },
    {
      warehouseId: 702,
      label: "Lekki Retail Hub",
      zoneKey: "Lekki",
      distanceKm: 7.6,
      pickPackMinutes: 6,
      coldChainReady: false,
      stockAccuracy: 0.95,
      inventory: [
        { sku: "milk-1l", availableUnits: 8, freshnessHours: 30 },
        { sku: "pain-relief-24", availableUnits: 5, freshnessHours: 400 },
      ],
    },
    {
      warehouseId: 703,
      label: "Yaba Pharmacy Node",
      zoneKey: "Yaba",
      distanceKm: 5.1,
      pickPackMinutes: 8,
      coldChainReady: true,
      stockAccuracy: 0.91,
      inventory: [
        { sku: "milk-1l", availableUnits: 2, freshnessHours: 16 },
        { sku: "pain-relief-24", availableUnits: 8, freshnessHours: 320 },
      ],
    },
  ],
};

async function main() {
  const output: Record<string, unknown> = {
    generated_at: new Date().toISOString(),
    targets: {
      dispatch_optimizer_url: ENV.dispatchOptimizerUrl,
      local_commerce_gateway_url: ENV.localCommerceGatewayUrl,
      retail_forecast_service_url: ENV.retailForecastServiceUrl,
    },
  };

  await buildLocalCommerceSuperGatewayWorkspace();
  await planLocalCommerceConciergeIntent({ ...scenario, includeEnrichment: true });
  await fetchForecast();
  await fetchBatchForecast();
  await fetchAllocation();
  await fetchGatewayPlan();

  output.typescript_workspace = summarize(await benchmarkFunction(12, () => buildLocalCommerceSuperGatewayWorkspace()));
  output.typescript_fast_path = summarize(await benchmarkFunction(12, () => planLocalCommerceConciergeIntent({ ...scenario, fastMode: true, includeEnrichment: false })));
  output.typescript_concierge = summarize(await benchmarkFunction(12, () => planLocalCommerceConciergeIntent({ ...scenario, includeEnrichment: true })));
  output.python_forecast = summarize(await benchmarkHttp(12, () => fetchForecast()));
  output.python_batch_forecast = summarize(await benchmarkHttp(10, () => fetchBatchForecast()));
  output.rust_allocation = summarize(await benchmarkHttp(12, () => fetchAllocation()));
  output.go_gateway = summarize(await benchmarkHttp(12, () => fetchGatewayPlan()));
  output.end_to_end_concierge = summarize(await benchmarkFunction(10, () => planLocalCommerceConciergeIntent({ ...scenario, includeEnrichment: true })));
  output.concurrent_end_to_end = await benchmarkConcurrentConcierge();

  const outputPath = path.join(process.cwd(), "validation", "competitive_surface_performance_metrics.json");
  await fs.writeFile(outputPath, JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ ok: true, outputPath }, null, 2));
}

async function benchmarkFunction(iterations: number, fn: () => Promise<unknown>): Promise<Sample[]> {
  const samples: Sample[] = [];
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    const started = performance.now();
    try {
      await fn();
      samples.push({ iteration, duration_ms: round2(performance.now() - started), ok: true });
    } catch (error) {
      samples.push({ iteration, duration_ms: round2(performance.now() - started), ok: false, error: String(error) });
    }
  }
  return samples;
}

async function benchmarkHttp(iterations: number, fn: () => Promise<Response>): Promise<Sample[]> {
  const samples: Sample[] = [];
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    const started = performance.now();
    try {
      const response = await fn();
      await response.text();
      samples.push({ iteration, duration_ms: round2(performance.now() - started), ok: response.ok, status: response.status });
    } catch (error) {
      samples.push({ iteration, duration_ms: round2(performance.now() - started), ok: false, error: String(error) });
    }
  }
  return samples;
}

async function benchmarkConcurrentConcierge() {
  const concurrency = 6;
  const rounds = 4;
  const samples: Sample[] = [];
  for (let round = 1; round <= rounds; round += 1) {
    const started = performance.now();
    try {
      await Promise.all(
        Array.from({ length: concurrency }, (_, index) =>
          planLocalCommerceConciergeIntent({
            ...scenario,
            includeEnrichment: true,
            traceId: `concurrent-${round}-${index + 1}`,
          }),
        ),
      );
      samples.push({ iteration: round, duration_ms: round2(performance.now() - started), ok: true });
    } catch (error) {
      samples.push({ iteration: round, duration_ms: round2(performance.now() - started), ok: false, error: String(error) });
    }
  }
  return {
    concurrency,
    rounds,
    ...summarize(samples),
  };
}

function summarize(samples: Sample[]): Summary & { samples: Sample[] } {
  const durations = samples.map((sample) => sample.duration_ms).sort((left, right) => left - right);
  const okCount = samples.filter((sample) => sample.ok).length;
  return {
    count: samples.length,
    ok_count: okCount,
    min_ms: percentile(durations, 0),
    median_ms: percentile(durations, 0.5),
    p95_ms: percentile(durations, 0.95),
    max_ms: percentile(durations, 1),
    avg_ms: round2(durations.reduce((sum, value) => sum + value, 0) / Math.max(durations.length, 1)),
    samples,
  };
}

function percentile(values: number[], pct: number): number {
  if (values.length === 0) return 0;
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * pct) - 1));
  return round2(values[index]);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function baseHeaders(traceId: string) {
  return {
    "content-type": "application/json",
    "x-internal-service-token": ENV.internalServiceToken,
    "x-trace-id": traceId,
  };
}

function fetchForecast() {
  const traceId = `forecast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return fetch(`${ENV.retailForecastServiceUrl.replace(/\/$/, "")}/forecast`, {
    method: "POST",
    headers: baseHeaders(traceId),
    body: JSON.stringify(singleForecastPayload()),
  });
}

function fetchBatchForecast() {
  const traceId = `forecast-batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return fetch(`${ENV.retailForecastServiceUrl.replace(/\/$/, "")}/forecast/batch`, {
    method: "POST",
    headers: baseHeaders(traceId),
    body: JSON.stringify({
      requests: [singleForecastPayload(), singleForecastPayload("switchos_priority_member")],
    }),
  });
}

function singleForecastPayload(merchantName = scenario.customerSegment) {
  return {
    merchant_name: merchantName,
    city: scenario.city,
    planning_horizon_hours: 24,
    skus: scenario.basket.map((item) => ({
      sku: item.sku,
      label: item.label,
      category: item.category,
      on_hand_units: item.onHandUnits,
      reserved_units: item.reservedUnits,
      inbound_units: item.inboundUnits,
      lead_time_hours: item.leadTimeHours,
      demand_history: [
        { timestamp: new Date(Date.now() - 6 * 3600 * 1000).toISOString(), units: Math.max(1, item.quantity * 0.7) },
        { timestamp: new Date(Date.now() - 3 * 3600 * 1000).toISOString(), units: Math.max(1, item.quantity * 0.9) },
        { timestamp: new Date().toISOString(), units: Math.max(1, item.quantity * 1.1) },
      ],
      event_multiplier: item.eventMultiplier,
      weather_multiplier: item.weatherMultiplier,
      substitution_group: item.substitutionGroup,
      cold_chain_required: item.coldChainRequired,
    })),
  };
}

function fetchAllocation() {
  const traceId = `alloc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return fetch(`${ENV.dispatchOptimizerUrl.replace(/\/$/, "")}/instant-retail-allocation`, {
    method: "POST",
    headers: baseHeaders(traceId),
    body: JSON.stringify({
      city: scenario.city,
      customer_zone: scenario.city,
      cold_chain_required: scenario.basket.some((item) => item.coldChainRequired),
      priority_level: "standard",
      items: scenario.basket.map((item) => ({ sku: item.sku, quantity: item.quantity, substitution_group: item.substitutionGroup })),
      warehouses: scenario.warehouseCandidates.map((warehouse) => ({
        warehouse_id: warehouse.warehouseId,
        label: warehouse.label,
        zone_key: warehouse.zoneKey,
        distance_km: warehouse.distanceKm,
        pick_pack_minutes: warehouse.pickPackMinutes,
        cold_chain_ready: warehouse.coldChainReady,
        stock_accuracy: warehouse.stockAccuracy,
        available_inventory: warehouse.inventory.map((inventory) => ({
          sku: inventory.sku,
          available_units: inventory.availableUnits,
          freshness_hours: inventory.freshnessHours,
        })),
      })),
    }),
  });
}

function fetchGatewayPlan() {
  const traceId = `gateway-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return fetch(`${ENV.localCommerceGatewayUrl.replace(/\/$/, "")}/plan`, {
    method: "POST",
    headers: baseHeaders(traceId),
    body: JSON.stringify({
      city: scenario.city,
      customer_segment: scenario.customerSegment,
      categories: scenario.categories,
      request: scenario.request,
      membership_summary: { active_memberships: 0, available_rewards: 6, avg_recommended_eta: 22 },
      allocation: { desired_mode: "instant_retail" },
      forecast: { desired_mode: "restock_plan" },
      payload_metrics: {
        basket_count: scenario.basket.length,
        warehouse_count: scenario.warehouseCandidates.length,
        category_count: scenario.categories.length,
      },
    }),
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
