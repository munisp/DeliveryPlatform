import { ENV } from "./env";
import {
  getBusinessTravelSummary,
  getCheckoutSummary,
  getConsumerMarketplaceSummary,
  getMerchantChannelsSummary,
  getRiderAppSummary,
} from "../db";

type ConciergeIntent = {
  city?: string | null;
  customerSegment?: string | null;
  categories?: string[];
  request: string;
  basket?: Array<{
    sku: string;
    quantity: number;
    label?: string;
    category?: string;
    onHandUnits?: number;
    reservedUnits?: number;
    inboundUnits?: number;
    leadTimeHours?: number;
    eventMultiplier?: number;
    weatherMultiplier?: number;
    substitutionGroup?: string;
    coldChainRequired?: boolean;
  }>;
  warehouseCandidates?: Array<{
    warehouseId: number;
    label: string;
    zoneKey?: string;
    distanceKm: number;
    pickPackMinutes?: number;
    coldChainReady?: boolean;
    stockAccuracy?: number;
    inventory: Array<{
      sku: string;
      availableUnits: number;
      freshnessHours?: number;
    }>;
  }>;
  fastMode?: boolean;
  includeEnrichment?: boolean;
  traceId?: string | null;
};

type ForecastResponse = {
  service?: string;
  summary?: string;
  recommendations?: Array<{
    sku: string;
    label?: string | null;
    forecast_units: number;
    recommended_restock_units: number;
    stockout_risk: string;
    narrative: string;
  }>;
  metrics?: Record<string, unknown>;
};

type AllocationResponse = {
  strategy?: string;
  selected_warehouse_id?: number | null;
  selected_warehouse_label?: string | null;
  fill_rate?: number;
  estimated_ready_minutes?: number;
  split_shipment_required?: boolean;
  suggested_substitutions?: string[];
  rationale?: string;
  ranked_warehouses?: Array<{
    warehouse_id: number;
    label: string;
    zone_key: string;
    score: number;
    fill_rate: number;
    estimated_ready_minutes: number;
    cold_chain_ready: boolean;
    reason: string;
  }>;
  metrics?: Record<string, unknown>;
};

type GatewayPlanResponse = {
  service?: string;
  strategy?: string;
  event_id?: string;
  action_plan?: Array<{
    step: string;
    action: string;
    target: string;
    urgency: string;
  }>;
  middleware?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
};

type Workspace = Awaited<ReturnType<typeof assembleWorkspace>>;

type TimedResult<T> = {
  result: T;
  duration_ms: number;
};

type CacheEntry<T> = {
  expiresAt: number;
  value: T;
};

const workspaceCache = new Map<string, CacheEntry<Workspace>>();
const planCache = new Map<string, CacheEntry<Awaited<ReturnType<typeof planLocalCommerceConciergeIntent>>>>();

export async function buildLocalCommerceSuperGatewayWorkspace(options?: { forceRefresh?: boolean; traceId?: string | null }) {
  const cacheKey = "default";
  const traceId = options?.traceId ?? generateTraceId("lcw");
  if (!options?.forceRefresh) {
    const cached = getCacheValue(workspaceCache, cacheKey);
    if (cached) {
      trace("workspace.cache_hit", traceId, { cache_key: cacheKey, categories: cached.category_map.length });
      return cached;
    }
  }

  const timed = await timeAsync(() => assembleWorkspace(), traceId, "workspace.assemble");
  setCacheValue(workspaceCache, cacheKey, timed.result, ENV.localCommerceWorkspaceCacheTtlMs);
  return timed.result;
}

export async function planLocalCommerceConciergeIntent(input: ConciergeIntent) {
  const traceId = input.traceId ?? generateTraceId("lcc");
  const fastMode = input.fastMode ?? false;
  const includeEnrichment = input.includeEnrichment ?? !fastMode;
  const cacheKey = buildPlanCacheKey({
    city: input.city,
    customerSegment: input.customerSegment,
    categories: input.categories,
    request: input.request,
    basket: input.basket,
    warehouseCandidates: input.warehouseCandidates,
    fastMode,
    includeEnrichment,
  });

  if (!fastMode) {
    const cached = getCacheValue(planCache, cacheKey);
    if (cached) {
      trace("concierge.cache_hit", traceId, { cache_key: cacheKey, summary: cached.decision_summary });
      return cached;
    }
  }

  const overallStartedAt = Date.now();
  const workspaceTimed = await timeAsync(
    () => buildLocalCommerceSuperGatewayWorkspace({ traceId }),
    traceId,
    "workspace.load",
  );

  let forecastTimed: TimedResult<ForecastResponse | null> = { result: null, duration_ms: 0 };
  let allocationTimed: TimedResult<AllocationResponse | null> = { result: null, duration_ms: 0 };
  if (includeEnrichment) {
    [forecastTimed, allocationTimed] = await Promise.all([
      timeAsync(() => maybeForecastRetailDemand(input, traceId), traceId, "forecast.load"),
      timeAsync(() => maybeAllocateInstantRetail(input, traceId), traceId, "allocation.load"),
    ]);
  }

  const gatewayTimed = await timeAsync(
    () => maybePlanThroughGateway(input, workspaceTimed.result, forecastTimed.result, allocationTimed.result, traceId),
    traceId,
    "gateway.plan",
  );

  const prioritySignals = [
    forecastTimed.result?.summary,
    allocationTimed.result?.rationale,
    gatewayTimed.result?.strategy,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  const payloadMetrics = summarizePayloadShape(input);
  const response = {
    workspace: workspaceTimed.result,
    forecast: forecastTimed.result,
    allocation: allocationTimed.result,
    gatewayPlan: gatewayTimed.result,
    decision_summary:
      prioritySignals.length > 0
        ? prioritySignals.join(" ")
        : "Concierge planning completed using internal cross-category workspace signals.",
    metrics: {
      trace_id: traceId,
      fast_mode: fastMode,
      enrichment_included: includeEnrichment,
      payload: payloadMetrics,
      timings_ms: {
        workspace: workspaceTimed.duration_ms,
        forecast: forecastTimed.duration_ms,
        allocation: allocationTimed.duration_ms,
        gateway: gatewayTimed.duration_ms,
        total: Date.now() - overallStartedAt,
      },
    },
    enrichment_job: !includeEnrichment && ENV.localCommerceEnableAsyncEnrichment ? buildDeferredEnrichmentHint(input) : null,
  };

  if (!fastMode) {
    setCacheValue(planCache, cacheKey, response, ENV.localCommercePlanCacheTtlMs);
  }
  trace("concierge.complete", traceId, response.metrics);
  return response;
}

async function assembleWorkspace() {
  const [marketplace, checkout, rider, travel, merchantChannels] = await Promise.all([
    getConsumerMarketplaceSummary(6),
    getCheckoutSummary(6),
    getRiderAppSummary(6),
    getBusinessTravelSummary(6),
    getMerchantChannelsSummary(6),
  ]);

  const activeMemberships = Number(checkout?.summary?.active_memberships ?? marketplace?.summary?.active_memberships ?? 0);
  const benefitsVisible = Number(rider?.summary?.membership_benefits ?? 0);
  const supportThreads = Number(rider?.summary?.support_threads ?? 0);
  const travelPrograms = Array.isArray(travel?.travel_programs) ? travel.travel_programs.length : 0;
  const ownedChannels = Array.isArray(merchantChannels?.owned_channels) ? merchantChannels.owned_channels.length : 0;
  const activePromotions = Number(rider?.summary?.active_promotions ?? 0);
  const suggestedCategories = new Set<string>([
    ...(Array.isArray(rider?.booking_modes) ? rider.booking_modes.map((entry: any) => entry.key) : []),
    ...(Array.isArray(marketplace?.categories) ? marketplace.categories.map((entry: any) => String(entry.name || "")) : []),
  ]);

  return {
    summary: {
      unified_memberships: activeMemberships,
      cross_category_benefits: benefitsVisible,
      travel_programs: travelPrograms,
      merchant_channels: ownedChannels,
      active_promotions: activePromotions,
      support_threads: supportThreads,
      recommended_action: "Operate one all-category membership and concierge layer spanning delivery, mobility, retail, and travel instead of separate feature silos.",
    },
    category_map: Array.from(suggestedCategories).filter(Boolean).slice(0, 12),
    loyalty_engine: {
      membership_summary: checkout?.summary ?? null,
      featured_memberships: checkout?.memberships ?? [],
      rewards: checkout?.rewards ?? [],
      rider_context: rider?.summary ?? null,
      cross_sell_prompts: [
        "Convert high-frequency delivery members into airport, travel, and regulated-retail users through one shared benefits wallet.",
        "Use support recovery and reorder signals to trigger retention offers across categories instead of isolated credits.",
        "Elevate merchant CRM offers when the same customer shows repeat mobility, delivery, and travel behavior.",
      ],
    },
    concierge_surfaces: {
      rider_booking_modes: rider?.booking_modes ?? [],
      travel_programs: travel?.travel_programs ?? [],
      merchant_channels: merchantChannels?.owned_channels ?? [],
      marketplace_categories: marketplace?.categories ?? [],
    },
  };
}

async function maybeForecastRetailDemand(input: ConciergeIntent, traceId: string): Promise<ForecastResponse | null> {
  if (!input.basket?.length || !ENV.retailForecastServiceUrl) {
    return null;
  }

  const payload = {
    merchant_name: input.customerSegment ?? "switchos-merchant-cluster",
    city: input.city ?? "unknown",
    planning_horizon_hours: 24,
    skus: input.basket.map((item) => ({
      sku: item.sku,
      label: item.label,
      category: item.category,
      on_hand_units: item.onHandUnits ?? 0,
      reserved_units: item.reservedUnits ?? 0,
      inbound_units: item.inboundUnits ?? 0,
      lead_time_hours: item.leadTimeHours ?? 8,
      demand_history: [
        { timestamp: new Date(Date.now() - 6 * 3600 * 1000).toISOString(), units: Math.max(1, item.quantity * 0.7) },
        { timestamp: new Date(Date.now() - 3 * 3600 * 1000).toISOString(), units: Math.max(1, item.quantity * 0.9) },
        { timestamp: new Date().toISOString(), units: Math.max(1, item.quantity * 1.1) },
      ],
      event_multiplier: item.eventMultiplier ?? 1,
      weather_multiplier: item.weatherMultiplier ?? 1,
      substitution_group: item.substitutionGroup,
      cold_chain_required: item.coldChainRequired ?? false,
    })),
  };

  const response = await fetch(`${ENV.retailForecastServiceUrl.replace(/\/$/, "")}/forecast`, {
    method: "POST",
    headers: baseHeaders(traceId),
    body: JSON.stringify(payload),
  }).catch(() => null);

  if (!response?.ok) {
    return null;
  }

  return response.json() as Promise<ForecastResponse>;
}

async function maybeAllocateInstantRetail(input: ConciergeIntent, traceId: string): Promise<AllocationResponse | null> {
  if (!input.basket?.length || !input.warehouseCandidates?.length || !ENV.dispatchOptimizerUrl) {
    return null;
  }

  const payload = {
    city: input.city ?? null,
    customer_zone: input.city ?? null,
    cold_chain_required: input.basket.some((item) => item.coldChainRequired),
    priority_level: input.categories?.includes("healthcare") ? "urgent" : "standard",
    items: input.basket.map((item) => ({
      sku: item.sku,
      quantity: item.quantity,
      substitution_group: item.substitutionGroup ?? null,
    })),
    warehouses: input.warehouseCandidates.map((warehouse) => ({
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
  };

  const response = await fetch(`${ENV.dispatchOptimizerUrl.replace(/\/$/, "")}/instant-retail-allocation`, {
    method: "POST",
    headers: baseHeaders(traceId),
    body: JSON.stringify(payload),
  }).catch(() => null);

  if (!response?.ok) {
    return null;
  }

  return response.json() as Promise<AllocationResponse>;
}

async function maybePlanThroughGateway(
  input: ConciergeIntent,
  workspace: Workspace,
  forecast: ForecastResponse | null,
  allocation: AllocationResponse | null,
  traceId: string,
): Promise<GatewayPlanResponse | null> {
  if (!ENV.localCommerceGatewayUrl) {
    return null;
  }

  const payload = {
    city: input.city ?? null,
    customer_segment: input.customerSegment ?? "general",
    categories: input.categories ?? workspace.category_map.slice(0, 4),
    request: input.request,
    membership_summary: workspace.loyalty_engine.membership_summary,
    allocation,
    forecast,
    payload_metrics: summarizePayloadShape(input),
  };

  const response = await fetch(`${ENV.localCommerceGatewayUrl.replace(/\/$/, "")}/plan`, {
    method: "POST",
    headers: baseHeaders(traceId),
    body: JSON.stringify(payload),
  }).catch(() => null);

  if (!response?.ok) {
    return null;
  }

  return response.json() as Promise<GatewayPlanResponse>;
}

function baseHeaders(traceId: string) {
  return {
    "content-type": "application/json",
    "x-internal-service-token": ENV.internalServiceToken,
    "x-trace-id": traceId,
  };
}

function buildPlanCacheKey(input: Partial<ConciergeIntent>) {
  return JSON.stringify({
    city: input.city ?? null,
    customerSegment: input.customerSegment ?? null,
    categories: (input.categories ?? []).map((value) => String(value).trim().toLowerCase()).sort(),
    request: (input.request ?? "").trim(),
    basket: (input.basket ?? []).map((item) => [item.sku, item.quantity, item.onHandUnits ?? 0, item.inboundUnits ?? 0, item.coldChainRequired ?? false]),
    warehouses: (input.warehouseCandidates ?? []).map((item) => [item.warehouseId, item.distanceKm, item.inventory.length]),
    fastMode: input.fastMode ?? false,
    includeEnrichment: input.includeEnrichment ?? null,
  });
}

function summarizePayloadShape(input: Partial<ConciergeIntent>) {
  const basketCount = input.basket?.length ?? 0;
  const warehouseCount = input.warehouseCandidates?.length ?? 0;
  const categoryCount = input.categories?.length ?? 0;
  const inventoryRows = (input.warehouseCandidates ?? []).reduce((sum, warehouse) => sum + warehouse.inventory.length, 0);
  return {
    basket_count: basketCount,
    warehouse_count: warehouseCount,
    category_count: categoryCount,
    inventory_rows: inventoryRows,
    request_chars: (input.request ?? "").length,
  };
}

function buildDeferredEnrichmentHint(input: ConciergeIntent) {
  return {
    status: "deferred",
    recommendation: "Re-run this request with includeEnrichment=true to attach retail forecast and warehouse allocation details.",
    trace_seed: generateTraceId("lce"),
    payload: summarizePayloadShape(input),
  };
}

function getCacheValue<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
  const entry = cache.get(key);
  if (!entry) {
    return null;
  }
  if (Date.now() >= entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function setCacheValue<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number) {
  cache.set(key, { value, expiresAt: Date.now() + Math.max(ttlMs, 250) });
}

async function timeAsync<T>(fn: () => Promise<T>, traceId: string, spanName: string): Promise<TimedResult<T>> {
  const started = Date.now();
  const result = await fn();
  const duration_ms = Date.now() - started;
  trace(spanName, traceId, { duration_ms });
  return { result, duration_ms };
}

function trace(spanName: string, traceId: string, payload: Record<string, unknown>) {
  if (!ENV.localCommerceEnableTracing) {
    return;
  }
  if (!shouldSampleTrace(traceId)) {
    return;
  }
  console.info(`[local-commerce-trace] ${spanName}`, JSON.stringify({ trace_id: traceId, ...payload }));
}

function shouldSampleTrace(traceId: string) {
  const sampleRate = Math.max(1, Math.min(100, ENV.localCommerceTraceSampleRate));
  if (sampleRate >= 100) {
    return true;
  }
  let score = 0;
  for (const character of traceId) {
    score = (score + character.charCodeAt(0)) % 100;
  }
  return score < sampleRate;
}

function generateTraceId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
