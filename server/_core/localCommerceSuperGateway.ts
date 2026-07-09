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
};

export async function buildLocalCommerceSuperGatewayWorkspace() {
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

export async function planLocalCommerceConciergeIntent(input: ConciergeIntent) {
  const workspace = await buildLocalCommerceSuperGatewayWorkspace();
  const forecast = await maybeForecastRetailDemand(input);
  const allocation = await maybeAllocateInstantRetail(input);
  const gatewayPlan = await maybePlanThroughGateway(input, workspace, forecast, allocation);

  const prioritySignals = [
    forecast?.summary,
    allocation?.rationale,
    gatewayPlan?.strategy,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  return {
    workspace,
    forecast,
    allocation,
    gatewayPlan,
    decision_summary: prioritySignals.length > 0
      ? prioritySignals.join(" ")
      : "Concierge planning completed using internal cross-category workspace signals.",
  };
}

async function maybeForecastRetailDemand(input: ConciergeIntent): Promise<ForecastResponse | null> {
  if (!input.basket?.length || !ENV.retailForecastServiceUrl) {
    return null;
  }

  const response = await fetch(`${ENV.retailForecastServiceUrl.replace(/\/$/, "")}/forecast`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-service-token": ENV.internalServiceToken,
    },
    body: JSON.stringify({
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
    }),
  }).catch(() => null);

  if (!response?.ok) {
    return null;
  }

  return response.json() as Promise<ForecastResponse>;
}

async function maybeAllocateInstantRetail(input: ConciergeIntent): Promise<AllocationResponse | null> {
  if (!input.basket?.length || !input.warehouseCandidates?.length || !ENV.dispatchOptimizerUrl) {
    return null;
  }

  const response = await fetch(`${ENV.dispatchOptimizerUrl.replace(/\/$/, "")}/instant-retail-allocation`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-service-token": ENV.internalServiceToken,
    },
    body: JSON.stringify({
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
    }),
  }).catch(() => null);

  if (!response?.ok) {
    return null;
  }

  return response.json() as Promise<AllocationResponse>;
}

async function maybePlanThroughGateway(
  input: ConciergeIntent,
  workspace: Awaited<ReturnType<typeof buildLocalCommerceSuperGatewayWorkspace>>,
  forecast: ForecastResponse | null,
  allocation: AllocationResponse | null,
): Promise<GatewayPlanResponse | null> {
  if (!ENV.localCommerceGatewayUrl) {
    return null;
  }

  const response = await fetch(`${ENV.localCommerceGatewayUrl.replace(/\/$/, "")}/plan`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-service-token": ENV.internalServiceToken,
    },
    body: JSON.stringify({
      city: input.city ?? null,
      customer_segment: input.customerSegment ?? "general",
      categories: input.categories ?? workspace.category_map.slice(0, 4),
      request: input.request,
      membership_summary: workspace.loyalty_engine.membership_summary,
      allocation,
      forecast,
    }),
  }).catch(() => null);

  if (!response?.ok) {
    return null;
  }

  return response.json() as Promise<GatewayPlanResponse>;
}
