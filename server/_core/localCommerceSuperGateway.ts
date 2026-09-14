import { randomUUID } from "node:crypto";
import { ENV } from "./env";
import { resilientFetch } from "./resilientFetch";
import {
  getCheckoutSummary,
  getConsumerMarketplaceSummary,
} from "../db";
import {
  getBusinessTravelSummary,
  getRiderAppSummary,
} from "./mobilityQueries";
import { getMerchantChannelsSummary } from "./commerceSummaries";

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

type GatewayControlTowerResponse = {
  service?: string;
  status?: string;
  recent_plan_count?: number;
  middleware?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
  recommendations?: string[];
};

type NetworkHealthResponse = {
  service?: string;
  city?: string | null;
  planning_horizon_hours?: number;
  resilience_band?: string;
  constrained_nodes?: number;
  critical_nodes?: number;
  summary?: string;
  nodes?: Array<{
    warehouse_id: number;
    label: string;
    zone_key?: string | null;
    stock_cover_hours: number;
    recommended_restock_units: number;
    risk_band: string;
    cold_chain_ready: boolean;
    stock_accuracy: number;
    critical_skus: number;
    narrative: string;
  }>;
  metrics?: Record<string, unknown>;
};

type ProcurementPlanResponse = {
  service?: string;
  city?: string;
  approval_mode?: string;
  critical_items?: number;
  summary?: string;
  procurement_actions?: Array<{
    sku: string;
    label?: string | null;
    warehouse_id: number;
    warehouse_label: string;
    supplier_id: string;
    supplier_name: string;
    recommended_units: number;
    safety_stock_units: number;
    lead_time_hours: number;
    service_level: number;
    risk_band: string;
    action_mode: string;
    narrative: string;
    target_transfer_node_id?: number | null;
    target_transfer_node_name?: string | null;
  }>;
  metrics?: Record<string, unknown>;
};

type SupplierHealthResponse = {
  service?: string;
  city?: string;
  resilience_band?: string;
  summary?: string;
  suppliers?: Array<{
    supplier_id: string;
    supplier_name: string;
    lead_time_hours: number;
    fill_rate: number;
    spoilage_risk: number;
    reliability_band: string;
    urgency: string;
    narrative: string;
  }>;
  metrics?: Record<string, unknown>;
};

type InventoryMiddlewareStatusResponse = {
  dapr?: { configured?: boolean };
  kafka?: { configured?: boolean };
  fluvio?: { configured?: boolean };
  temporal?: { configured?: boolean };
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

export async function buildLocalCommerceLogisticsControlTower(options?: { city?: string | null; traceId?: string | null; forceRefresh?: boolean }) {
  const traceId = options?.traceId ?? generateTraceId("lct");
  const city = options?.city ?? "Lagos";
  const workspaceTimed = await timeAsync(
    () => buildLocalCommerceSuperGatewayWorkspace({ forceRefresh: options?.forceRefresh, traceId }),
    traceId,
    "control_tower.workspace",
  );

  const [gatewayTimed, networkTimed, inventoryTimed, supplierTimed] = await Promise.all([
    timeAsync(() => loadGatewayControlTower(traceId), traceId, "control_tower.gateway"),
    timeAsync(() => loadNetworkHealth(city, workspaceTimed.result, traceId), traceId, "control_tower.network"),
    timeAsync(() => loadInventoryMiddlewareStatus(traceId), traceId, "control_tower.inventory"),
    timeAsync(() => loadSupplierHealth(city, workspaceTimed.result, traceId), traceId, "control_tower.suppliers"),
  ]);

  const summaryParts = [
    gatewayTimed.result?.status ? `Gateway status is ${gatewayTimed.result.status}.` : null,
    networkTimed.result?.summary ?? null,
    supplierTimed.result?.summary ?? null,
    workspaceTimed.result.summary.recommended_action,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  const middlewareReadiness = inventoryTimed.result
    ? Object.entries(inventoryTimed.result).map(([key, value]) => `${key}:${value?.configured ? "ready" : "off"}`)
    : [];

  return {
    workspace: workspaceTimed.result,
    gateway: gatewayTimed.result,
    network: networkTimed.result,
    inventory_control: inventoryTimed.result,
    supplier_health: supplierTimed.result,
    summary: summaryParts.join(" "),
    alerts: [
      ...(gatewayTimed.result?.recommendations ?? []),
      ...middlewareReadiness,
      ...((networkTimed.result?.nodes ?? []).filter((node) => node.risk_band !== "healthy").map((node) => node.narrative)),
      ...((supplierTimed.result?.suppliers ?? []).filter((supplier) => supplier.urgency !== "watch").map((supplier) => supplier.narrative)),
    ].slice(0, 10),
    metrics: {
      trace_id: traceId,
      timings_ms: {
        workspace: workspaceTimed.duration_ms,
        gateway: gatewayTimed.duration_ms,
        network: networkTimed.duration_ms,
        inventory: inventoryTimed.duration_ms,
        suppliers: supplierTimed.duration_ms,
      },
    },
    mobile_shortcuts: [
      { label: "Run fast logistics plan", route: "/logistics-control-tower", action: "plan-fast" },
      { label: "Review supply risk", route: "/merchant-channels", action: "supply-risk" },
      { label: "Check driver readiness", route: "/driver-mobility", action: "driver-readiness" },
      { label: "Queue replenishment", route: "/logistics-control-tower", action: "replenishment" },
    ],
  };
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
  let procurementTimed: TimedResult<ProcurementPlanResponse | null> = { result: null, duration_ms: 0 };
  if (includeEnrichment) {
    [forecastTimed, allocationTimed] = await Promise.all([
      timeAsync(() => maybeForecastRetailDemand(input, traceId), traceId, "forecast.load"),
      timeAsync(() => maybeAllocateInstantRetail(input, traceId), traceId, "allocation.load"),
    ]);
    procurementTimed = await timeAsync(
      () => maybePlanProcurement(input, forecastTimed.result, allocationTimed.result, traceId),
      traceId,
      "procurement.plan",
    );
  }

  const gatewayTimed = await timeAsync(
    () => maybePlanThroughGateway(input, workspaceTimed.result, forecastTimed.result, allocationTimed.result, traceId),
    traceId,
    "gateway.plan",
  );

  const prioritySignals = [
    forecastTimed.result?.summary,
    allocationTimed.result?.rationale,
    procurementTimed.result?.summary,
    gatewayTimed.result?.strategy,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  const payloadMetrics = summarizePayloadShape(input);
  const response = {
    workspace: workspaceTimed.result,
    forecast: forecastTimed.result,
    allocation: allocationTimed.result,
    procurementPlan: procurementTimed.result,
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
        procurement: procurementTimed.duration_ms,
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

  const response = await resilientFetch(`${ENV.retailForecastServiceUrl.replace(/\/$/, "")}/forecast`, {
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

  const response = await resilientFetch(`${ENV.dispatchOptimizerUrl.replace(/\/$/, "")}/instant-retail-allocation`, {
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

  const response = await resilientFetch(`${ENV.localCommerceGatewayUrl.replace(/\/$/, "")}/plan`, {
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

async function loadGatewayControlTower(traceId: string): Promise<GatewayControlTowerResponse | null> {
  if (!ENV.localCommerceGatewayUrl) {
    return null;
  }

  const response = await resilientFetch(`${ENV.localCommerceGatewayUrl.replace(/\/$/, "")}/logistics-control-tower`, {
    method: "GET",
    headers: baseHeaders(traceId),
  }).catch(() => null);

  if (!response?.ok) {
    return null;
  }

  return response.json() as Promise<GatewayControlTowerResponse>;
}

async function loadNetworkHealth(city: string, workspace: Workspace, traceId: string): Promise<NetworkHealthResponse | null> {
  if (!ENV.retailForecastServiceUrl) {
    return null;
  }

  const payload = {
    city,
    planning_horizon_hours: 24,
    nodes: defaultNetworkNodesFromWorkspace(workspace),
  };

  const response = await resilientFetch(`${ENV.retailForecastServiceUrl.replace(/\/$/, "")}/network-health`, {
    method: "POST",
    headers: baseHeaders(traceId),
    body: JSON.stringify(payload),
  }).catch(() => null);

  if (!response?.ok) {
    return null;
  }

  return response.json() as Promise<NetworkHealthResponse>;
}

async function loadInventoryMiddlewareStatus(traceId: string): Promise<InventoryMiddlewareStatusResponse | null> {
  if (!ENV.inventoryControlServiceUrl) {
    return null;
  }
  const response = await resilientFetch(`${ENV.inventoryControlServiceUrl.replace(/\/$/, "")}/middleware-status`, {
    method: "GET",
    headers: baseHeaders(traceId),
  }).catch(() => null);
  if (!response?.ok) {
    return null;
  }
  return response.json() as Promise<InventoryMiddlewareStatusResponse>;
}

async function loadSupplierHealth(city: string, workspace: Workspace, traceId: string): Promise<SupplierHealthResponse | null> {
  if (!ENV.procurementPlannerServiceUrl) {
    return null;
  }
  const payload = {
    city,
    suppliers: defaultSuppliersFromWorkspace(workspace),
  };
  const response = await resilientFetch(`${ENV.procurementPlannerServiceUrl.replace(/\/$/, "")}/procurement/supplier-health`, {
    method: "POST",
    headers: baseHeaders(traceId),
    body: JSON.stringify(payload),
  }).catch(() => null);
  if (!response?.ok) {
    return null;
  }
  return response.json() as Promise<SupplierHealthResponse>;
}

async function maybePlanProcurement(
  input: ConciergeIntent,
  forecast: ForecastResponse | null,
  allocation: AllocationResponse | null,
  traceId: string,
): Promise<ProcurementPlanResponse | null> {
  if (!ENV.procurementPlannerServiceUrl || !forecast?.recommendations?.length || !input.warehouseCandidates?.length) {
    return null;
  }

  const primaryWarehouse = input.warehouseCandidates[0];
  const rankedFallback = allocation?.ranked_warehouses?.find((warehouse) => warehouse.warehouse_id !== primaryWarehouse.warehouseId);
  const payload = {
    city: input.city ?? "unknown",
    planning_horizon_hours: 24,
    trigger: "concierge_plan",
    requested_by: "local_commerce_super_gateway",
    workflow_reason: "Protect local fulfillment fill rate and replenish high-risk SKUs before stockout.",
    skus: forecast.recommendations.map((recommendation, index) => ({
      sku: recommendation.sku,
      label: recommendation.label,
      category: input.basket?.[index]?.category ?? null,
      warehouse_id: primaryWarehouse.warehouseId,
      warehouse_label: primaryWarehouse.label,
      zone_key: primaryWarehouse.zoneKey,
      current_available_units: input.basket?.[index]?.onHandUnits ?? 0,
      current_reserved_units: input.basket?.[index]?.reservedUnits ?? 0,
      current_inbound_units: input.basket?.[index]?.inboundUnits ?? 0,
      forecast_units: recommendation.forecast_units,
      recommended_restock_units: recommendation.recommended_restock_units,
      safety_stock_units: Math.max(recommendation.recommended_restock_units * 0.7, 4),
      stockout_risk: recommendation.stockout_risk,
      supplier: {
        supplier_id: `${(input.city ?? "city").toLowerCase().replace(/\s+/g, "-")}-${recommendation.sku}-supplier`,
        supplier_name: `${recommendation.label ?? recommendation.sku} supplier lane`,
        lead_time_hours: input.basket?.[index]?.leadTimeHours ?? 8,
        fill_rate: allocation?.fill_rate ? Math.min(0.99, Math.max(0.75, allocation.fill_rate)) : 0.9,
        spoilage_risk: input.basket?.[index]?.coldChainRequired ? 0.15 : 0.05,
        reliability_band: recommendation.stockout_risk === "critical" ? "watch" : "stable",
      },
      target_transfer_node_id: rankedFallback?.warehouse_id ?? null,
      target_transfer_node_name: rankedFallback?.label ?? null,
    })),
  };

  const response = await resilientFetch(`${ENV.procurementPlannerServiceUrl.replace(/\/$/, "")}/procurement/plan`, {
    method: "POST",
    headers: baseHeaders(traceId),
    body: JSON.stringify(payload),
  }).catch(() => null);

  if (!response?.ok) {
    return null;
  }

  return response.json() as Promise<ProcurementPlanResponse>;
}

function defaultSuppliersFromWorkspace(workspace: Workspace) {
  const benefits = Number(workspace.summary.cross_category_benefits ?? 0);
  const promotions = Number(workspace.summary.active_promotions ?? 0);
  return [
    {
      supplier_id: "lagos-fresh-chain",
      supplier_name: "Lagos Fresh Chain",
      lead_time_hours: 12,
      fill_rate: 0.93,
      spoilage_risk: 0.08,
      reliability_band: benefits > 10 ? "stable" : "watch",
    },
    {
      supplier_id: "mainland-grocery-wholesale",
      supplier_name: "Mainland Grocery Wholesale",
      lead_time_hours: 18,
      fill_rate: 0.88,
      spoilage_risk: 0.05,
      reliability_band: promotions > 5 ? "watch" : "stable",
    },
    {
      supplier_id: "airport-cold-chain",
      supplier_name: "Airport Cold Chain Relay",
      lead_time_hours: 10,
      fill_rate: 0.9,
      spoilage_risk: 0.12,
      reliability_band: "stable",
    },
  ];
}

function defaultNetworkNodesFromWorkspace(workspace: Workspace) {
  const activePromotions = Number(workspace.summary.active_promotions ?? 0);
  const benefits = Number(workspace.summary.cross_category_benefits ?? 0);
  return [
    {
      warehouse_id: 701,
      label: "VI Dark Store",
      zone_key: "lagos-island",
      cold_chain_ready: true,
      stock_accuracy: 0.94,
      on_hand_units: 54,
      reserved_units: Math.max(4, Math.round(activePromotions / 2)),
      inbound_units: 24,
      hourly_demand: 3.2,
      lead_time_hours: 6,
      freshness_hours: 28,
      critical_skus: 1,
    },
    {
      warehouse_id: 702,
      label: "Yaba Rapid Hub",
      zone_key: "lagos-mainland",
      cold_chain_ready: false,
      stock_accuracy: 0.83,
      on_hand_units: 28,
      reserved_units: 11,
      inbound_units: 8,
      hourly_demand: 2.8,
      lead_time_hours: 8,
      freshness_hours: 20,
      critical_skus: Math.max(2, Math.round(benefits / 3)),
    },
    {
      warehouse_id: 703,
      label: "Airport Relay Node",
      zone_key: "airport-corridor",
      cold_chain_ready: true,
      stock_accuracy: 0.9,
      on_hand_units: 18,
      reserved_units: 6,
      inbound_units: 20,
      hourly_demand: 1.6,
      lead_time_hours: 10,
      freshness_hours: 18,
      critical_skus: 0,
    },
  ];
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
  return `${prefix}-${randomUUID()}`;
}
