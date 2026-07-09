import { createTRPCClient } from "@/lib/trpc";
import type {
  DispatchZone,
  InventoryNode,
  LoyaltySignal,
  MerchantSignal,
  MobileAlert,
  OperatorSettings,
  ProcurementProposal,
  RiskLevel,
  ServiceHealth,
  SmartSearchResult,
  SnapshotData,
  WorkflowActionType,
  WorkflowPayload,
} from "@/lib/mobile/types";

type SnapshotLoadResult = {
  services: ServiceHealth[];
  inventory: InventoryNode[];
  procurement: ProcurementProposal[];
  dispatch: DispatchZone[];
  merchants: MerchantSignal[];
  loyalty: LoyaltySignal[];
  alerts: MobileAlert[];
  logisticsHeadline: string;
};

type ServiceTarget = {
  key: string;
  label: string;
  url: string;
};

type FetchEnvelope = {
  target: ServiceTarget;
  ok: boolean;
  status: number;
  latencyMs: number;
  detail: string;
  payload: any;
};

function createTraceId() {
  return `switchos-mobile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeUrl(value: string) {
  return value.trim().replace(/\/$/, "");
}

function resolveServiceTargets(settings: OperatorSettings): ServiceTarget[] {
  return [
    { key: "platform", label: "Platform API", url: normalizeUrl(settings.platformBaseUrl) },
    { key: "commerce", label: "Local Commerce Gateway", url: normalizeUrl(settings.localCommerceGatewayUrl) },
    { key: "inventory", label: "Inventory Control", url: normalizeUrl(settings.inventoryControlUrl) },
    { key: "procurement", label: "Procurement Planner", url: normalizeUrl(settings.procurementPlannerUrl) },
    { key: "dispatch", label: "Dispatch Optimizer", url: normalizeUrl(settings.dispatchOptimizerUrl) },
  ].filter((entry) => entry.url.length > 0);
}

function mapRiskLevel(value: unknown): RiskLevel {
  const normalized = String(value ?? "").toLowerCase();
  if (["critical", "severe", "high", "offline", "red"].includes(normalized)) {
    return "critical";
  }
  if (["watch", "warning", "medium", "amber", "degraded", "elevated"].includes(normalized)) {
    return "watch";
  }
  return "stable";
}

function formatHours(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? `${Math.round(numeric)}h` : "Unknown";
}

function formatPercent(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${Math.round(numeric * (numeric <= 1 ? 100 : 1))}%` : "Unknown";
}

let trpcClient: ReturnType<typeof createTRPCClient> | null = null;

function getTrpcClient() {
  trpcClient ??= createTRPCClient();
  return trpcClient;
}

function tokenizeQuery(value: string) {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function localMatchScore(query: string, candidate: string) {
  const normalizedCandidate = candidate.toLowerCase();
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) {
    return 0;
  }

  let score = 0;
  for (const token of tokens) {
    if (normalizedCandidate.includes(token)) {
      score += token.length > 5 ? 22 : 14;
    }
  }

  if (normalizedCandidate.includes(query.toLowerCase())) {
    score += 30;
  }

  return score;
}

function severityWeight(level: RiskLevel) {
  return level === "critical" ? 18 : level === "watch" ? 8 : 0;
}

async function fetchJson(target: ServiceTarget, traceId: string): Promise<FetchEnvelope> {
  const startedAt = Date.now();

  try {
    const response = await fetch(target.url, {
      headers: {
        accept: "application/json",
        "x-trace-id": traceId,
      },
    });
    const latencyMs = Date.now() - startedAt;
    const text = await response.text();
    const payload = text.length > 0 ? safeJsonParse(text) : null;

    return {
      target,
      ok: response.ok,
      status: response.status,
      latencyMs,
      detail: response.ok ? "Snapshot payload received" : `HTTP ${response.status}`,
      payload,
    };
  } catch (error) {
    return {
      target,
      ok: false,
      status: 0,
      latencyMs: Date.now() - startedAt,
      detail: error instanceof Error ? error.message : "Unknown error",
      payload: null,
    };
  }
}

function safeJsonParse(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function probeResultToServiceHealth(result: FetchEnvelope): ServiceHealth {
  return {
    key: result.target.key,
    label: result.target.label,
    status: result.ok ? "healthy" : result.status > 0 ? "degraded" : "offline",
    latencyMs: result.latencyMs,
    detail: result.detail,
    updatedAt: new Date().toISOString(),
  };
}

function mapLogisticsPayload(payload: any): Pick<SnapshotLoadResult, "inventory" | "procurement" | "alerts" | "logisticsHeadline"> {
  const networkNodes = Array.isArray(payload?.network?.nodes) ? payload.network.nodes : [];
  const procurementActions = Array.isArray(payload?.procurementPlan?.procurement_actions)
    ? payload.procurementPlan.procurement_actions
    : Array.isArray(payload?.procurement?.procurement_actions)
      ? payload.procurement.procurement_actions
      : [];
  const alerts = Array.isArray(payload?.alerts) ? payload.alerts : [];

  return {
    inventory: networkNodes.map((node: any, index: number) => ({
      id: String(node.warehouse_id ?? index),
      name: String(node.label ?? `Warehouse ${index + 1}`),
      region: String(node.zone_key ?? payload?.city ?? "Unknown region"),
      risk: mapRiskLevel(node.risk_band),
      confidence: Number(node.stock_accuracy ?? 0) >= 0.9 ? "high" : Number(node.stock_accuracy ?? 0) >= 0.75 ? "medium" : "low",
      stockCoverageHours: Number(node.stock_cover_hours ?? 0),
      restockUrgency: String(node.recommended_restock_units ?? 0) === "0" ? "Monitor" : `${Math.round(Number(node.recommended_restock_units ?? 0))} units recommended`,
      note: String(node.narrative ?? payload?.summary ?? "Inventory pressure requires review."),
    })),
    procurement: procurementActions.map((action: any, index: number) => ({
      id: String(action.sku ?? index),
      sku: String(action.label ?? action.sku ?? `SKU ${index + 1}`),
      nodeName: String(action.warehouse_label ?? payload?.city ?? "Unknown node"),
      action: action.action_mode === "transfer" ? "transfer" : "purchase",
      urgency: mapRiskLevel(action.risk_band),
      recommendedUnits: Number(action.recommended_units ?? 0),
      supplier: String(action.supplier_name ?? "Assigned supplier"),
      etaWindow: Number(action.lead_time_hours ?? 0) > 0 ? `${Math.round(Number(action.lead_time_hours))}h lead time` : undefined,
      note: String(action.narrative ?? payload?.summary ?? "Procurement action requires operator confirmation."),
    })),
    alerts: alerts.map((alert: any, index: number) => ({
      id: `logistics-${index}`,
      severity: mapRiskLevel(alert),
      title: `Logistics alert ${index + 1}`,
      body: String(alert),
      createdAt: new Date().toISOString(),
      source: "Local Commerce Gateway",
    })),
    logisticsHeadline: String(payload?.summary ?? payload?.gateway?.status ?? "Logistics snapshot synced."),
  };
}

function mapDispatchPayload(payload: any): Pick<SnapshotLoadResult, "dispatch" | "alerts"> {
  const hotspots = Array.isArray(payload?.telemetry?.hotspots) ? payload.telemetry.hotspots : [];

  return {
    dispatch: hotspots.map((hotspot: any, index: number) => ({
      id: String(hotspot.zone_key ?? index),
      name: String(hotspot.zone_key ?? `Zone ${index + 1}`),
      pressure: mapRiskLevel(hotspot.pressure_band),
      driverBalance: hotspot.available_drivers !== undefined
        ? `${Number(hotspot.available_drivers)} drivers available`
        : "Unknown",
      suggestedAction: hotspot.avg_wait_minutes !== undefined
        ? `Rebalance toward ${hotspot.zone_key} to reduce waits from ${Math.round(Number(hotspot.avg_wait_minutes))} minutes.`
        : String(payload?.summary?.recommended_action ?? "Review zone posture."),
      note: String(payload?.telemetry?.summary ?? payload?.summary?.recommended_action ?? "Dispatch telemetry synced."),
    })),
    alerts: hotspots
      .filter((hotspot: any) => mapRiskLevel(hotspot.pressure_band) !== "stable")
      .slice(0, 3)
      .map((hotspot: any, index: number) => ({
        id: `dispatch-${index}`,
        severity: mapRiskLevel(hotspot.pressure_band),
        title: `${String(hotspot.zone_key ?? "Dispatch zone")} pressure alert`,
        body: hotspot.avg_wait_minutes !== undefined
          ? `${Math.round(Number(hotspot.avg_wait_minutes))} minute wait with ${Number(hotspot.available_drivers ?? 0)} drivers visible.`
          : "Zone requires review.",
        createdAt: new Date().toISOString(),
        source: "Dispatch Optimizer",
      })),
  };
}

function mapPlatformPayload(payload: any): Pick<SnapshotLoadResult, "merchants" | "loyalty" | "alerts"> {
  const benchmarkEntries = Array.isArray(payload?.benchmarks?.external_domains)
    ? payload.benchmarks.external_domains
    : Array.isArray(payload?.campaigns?.active_campaigns)
      ? payload.campaigns.active_campaigns
      : [];
  const rewardEntries = Array.isArray(payload?.loyalty?.active_rewards) ? payload.loyalty.active_rewards : [];

  return {
    merchants: benchmarkEntries.slice(0, 6).map((entry: any, index: number) => ({
      id: String(entry.domain ?? entry.id ?? index),
      merchantName: String(entry.label ?? entry.campaign_name ?? entry.domain ?? `Merchant ${index + 1}`),
      benchmarkStatus: mapRiskLevel(entry.change ?? entry.status ?? index === 0 ? "watch" : "stable"),
      campaignReadiness: entry.visits_total_latest !== undefined
        ? `${Math.round(Number(entry.visits_total_latest)).toLocaleString()} visits latest period`
        : String(entry.campaign_type ?? "Campaign ready for review"),
      nextAction: String(payload?.summary?.recommended_action ?? payload?.benchmarks?.benchmark_summary ?? "Review growth posture and launch the next best action."),
    })),
    loyalty: rewardEntries.slice(0, 6).map((entry: any, index: number) => ({
      id: String(entry.id ?? index),
      customerLabel: String(entry.name ?? entry.reward_name ?? `Loyalty account ${index + 1}`),
      status: mapRiskLevel(entry.points_cost ? "watch" : "stable"),
      recommendedAction: entry.description
        ? String(entry.description)
        : `Offer ${String(entry.name ?? entry.reward_name ?? "reward")} as a retention nudge.`,
      lastTouchpoint: entry.updated_at ? String(entry.updated_at) : "Awaiting live touchpoint", 
    })),
    alerts: rewardEntries.slice(0, 2).map((entry: any, index: number) => ({
      id: `loyalty-${index}`,
      severity: "watch",
      title: `${String(entry.name ?? entry.reward_name ?? "Loyalty reward")} ready`,
      body: entry.description
        ? String(entry.description)
        : "A loyalty action is available for operator review.",
      createdAt: new Date().toISOString(),
      source: "Platform API",
    })),
  };
}

export async function probeServices(settings: OperatorSettings): Promise<ServiceHealth[]> {
  const traceId = createTraceId();
  const targets = resolveServiceTargets(settings);
  const results = await Promise.all(targets.map((target) => fetchJson(target, traceId)));
  return results.map(probeResultToServiceHealth);
}

export async function loadOperationalSnapshot(settings: OperatorSettings, previousSnapshot: SnapshotData): Promise<SnapshotLoadResult> {
  const traceId = createTraceId();
  const targets = resolveServiceTargets(settings);
  const results = await Promise.all(targets.map((target) => fetchJson(target, traceId)));
  const resultMap = new Map(results.map((result) => [result.target.key, result]));

  const logisticsPayload = resultMap.get("commerce")?.payload;
  const dispatchPayload = resultMap.get("dispatch")?.payload;
  const platformPayload = resultMap.get("platform")?.payload;

  const logisticsMapped = logisticsPayload ? mapLogisticsPayload(logisticsPayload) : {
    inventory: previousSnapshot.inventory,
    procurement: previousSnapshot.procurement,
    alerts: [] as MobileAlert[],
    logisticsHeadline: previousSnapshot.summary.logisticsHeadline,
  };
  const dispatchMapped = dispatchPayload ? mapDispatchPayload(dispatchPayload) : {
    dispatch: previousSnapshot.dispatch,
    alerts: [] as MobileAlert[],
  };
  const platformMapped = platformPayload ? mapPlatformPayload(platformPayload) : {
    merchants: previousSnapshot.merchants,
    loyalty: previousSnapshot.loyalty,
    alerts: [] as MobileAlert[],
  };

  const services = results.map(probeResultToServiceHealth);
  const connectivityAlerts = services
    .filter((service) => service.status !== "healthy")
    .map((service) => ({
      id: `${service.key}-${Date.now()}`,
      severity: service.status === "offline" ? "critical" : "watch",
      title: `${service.label} needs attention`,
      body: service.detail || "Service did not return a healthy payload.",
      createdAt: new Date().toISOString(),
      source: service.label,
    } satisfies MobileAlert));

  return {
    services,
    inventory: logisticsMapped.inventory,
    procurement: logisticsMapped.procurement,
    dispatch: dispatchMapped.dispatch,
    merchants: platformMapped.merchants,
    loyalty: platformMapped.loyalty,
    alerts: [...connectivityAlerts, ...logisticsMapped.alerts, ...dispatchMapped.alerts, ...platformMapped.alerts].slice(0, 12),
    logisticsHeadline: logisticsMapped.logisticsHeadline,
  };
}

export function buildQueuedActionDescriptor(actionType: WorkflowActionType, payload: WorkflowPayload) {
  const routeMap: Record<WorkflowActionType, string> = {
    replenishment: "/supply-chain/replenishment",
    inventory_audit: "/inventory/audit",
    dispatch_rebalance: "/dispatch/rebalance",
    loyalty_intervention: "/loyalty/intervention",
    merchant_campaign: "/merchant-growth/campaign",
  };

  return {
    route: routeMap[actionType],
    actionType,
    payload,
  };
}

export function buildFreshnessLabel(services: ServiceHealth[]) {
  if (services.length === 0) {
    return "No endpoints configured";
  }
  if (services.every((service) => service.status === "healthy")) {
    return "Fresh live snapshot";
  }
  if (services.some((service) => service.status === "healthy")) {
    return "Partial live snapshot with fallbacks";
  }
  return "Cached snapshot only";
}

export function buildOperationalMetrics(snapshot: SnapshotData) {
  return {
    criticalInventory: snapshot.inventory.filter((item) => item.risk === "critical").length,
    criticalDispatch: snapshot.dispatch.filter((item) => item.pressure === "critical").length,
    criticalMerchantSignals: snapshot.merchants.filter((item) => item.benchmarkStatus === "critical").length,
    loyaltyAttention: snapshot.loyalty.filter((item) => item.status !== "stable").length,
  };
}

export function buildOfflineSmartSearch(snapshot: SnapshotData, query: string, region?: string): SmartSearchResult[] {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return [];
  }

  const regionFilter = region?.trim().toLowerCase();

  const inventoryMatches: SmartSearchResult[] = snapshot.inventory
    .map((item) => {
      const haystack = [item.name, item.region, item.note, item.restockUrgency, item.stockCoverageHours ? `${item.stockCoverageHours} hours` : ""]
        .filter(Boolean)
        .join(" | ");
      const score = localMatchScore(trimmedQuery, haystack) + severityWeight(item.risk) + (item.pinned ? 4 : 0);
      return {
        domain: "inventory" as const,
        recordId: item.id,
        title: item.name,
        subtitle: `${item.region} · ${item.restockUrgency ?? formatHours(item.stockCoverageHours)}`,
        severity: item.risk,
        reason: item.note || "Matched from local inventory snapshot while live AI search was unavailable.",
        score,
        explanationChips: [item.region, item.risk, item.restockUrgency ?? "coverage review"].filter(Boolean).slice(0, 3),
      };
    })
    .filter((item) => item.score > 0 && (!regionFilter || item.subtitle.toLowerCase().includes(regionFilter)));

  const dispatchMatches: SmartSearchResult[] = snapshot.dispatch
    .map((item) => {
      const haystack = [item.name, item.note, item.suggestedAction, item.driverBalance].filter(Boolean).join(" | ");
      const score = localMatchScore(trimmedQuery, haystack) + severityWeight(item.pressure) + (item.pinned ? 4 : 0);
      return {
        domain: "dispatch" as const,
        recordId: item.id,
        title: item.name,
        subtitle: `${item.driverBalance ?? "Unknown balance"} · ${item.suggestedAction ?? "manual review"}`,
        severity: item.pressure,
        reason: item.note || "Matched from local dispatch snapshot while live AI search was unavailable.",
        score,
        explanationChips: [item.pressure, item.driverBalance ?? "balance unknown", item.suggestedAction ?? "manual review"].filter(Boolean).slice(0, 3),
      };
    })
    .filter((item) => item.score > 0 && (!regionFilter || item.title.toLowerCase().includes(regionFilter) || item.subtitle.toLowerCase().includes(regionFilter)));

  return [...inventoryMatches, ...dispatchMatches]
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, 6)
    .map((item) => ({ ...item, score: Math.max(1, Math.min(100, item.score)) }));
}

export async function runSmartSearch(settings: OperatorSettings, snapshot: SnapshotData, query: string, region?: string) {
  const liveInventory = snapshot.inventory.slice(0, 50).map((item) => ({
    id: item.id,
    title: item.name,
    subtitle: `${item.region} · ${item.restockUrgency ?? formatHours(item.stockCoverageHours)}`,
    severity: item.risk,
    region: item.region,
    note: item.note,
    actionHint: item.restockUrgency,
  }));

  const liveDispatch = snapshot.dispatch.slice(0, 50).map((item) => ({
    id: item.id,
    title: item.name,
    subtitle: item.driverBalance ?? "Unknown balance",
    severity: item.pressure,
    note: item.note,
    actionHint: item.suggestedAction,
  }));

  try {
    const response = await getTrpcClient().smartSearch.query.mutate({
      query,
      region,
      limit: 6,
      inventory: liveInventory,
      dispatch: liveDispatch,
    });

    return {
      mode: "live" as const,
      results: response.results,
      fallbackReason: undefined,
    };
  } catch (error) {
    return {
      mode: "offline" as const,
      results: buildOfflineSmartSearch(snapshot, query, region),
      fallbackReason: error instanceof Error ? error.message : "Live AI smart search is unavailable.",
    };
  }
}
