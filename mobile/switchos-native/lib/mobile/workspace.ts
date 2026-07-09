import type {
  DispatchZone,
  FilterState,
  InventoryNode,
  LoyaltySignal,
  MerchantSignal,
  ProcurementProposal,
  QueuePriority,
  QuickActionPreset,
  RecordDomain,
  RiskLevel,
  SortOption,
} from "@/lib/mobile/types";

type FilterableRecord = {
  id: string;
  pinned?: boolean;
  region?: string;
  risk?: RiskLevel;
  pressure?: RiskLevel;
  urgency?: RiskLevel;
  benchmarkStatus?: RiskLevel;
  status?: RiskLevel;
  freshnessMinutes?: number;
  recordUpdatedAt?: string;
};

export function normalizeQuery(value: string) {
  return value.trim().toLowerCase();
}

export function riskWeight(level: RiskLevel | undefined) {
  switch (level) {
    case "critical":
      return 3;
    case "watch":
      return 2;
    default:
      return 1;
  }
}

export function priorityWeight(priority: QueuePriority | undefined) {
  switch (priority) {
    case "urgent":
      return 4;
    case "high":
      return 3;
    case "normal":
      return 2;
    default:
      return 1;
  }
}

export function formatFreshness(minutes?: number) {
  if (minutes === undefined || !Number.isFinite(minutes)) {
    return "Freshness unknown";
  }
  if (minutes < 1) {
    return "Synced just now";
  }
  if (minutes < 60) {
    return `${Math.round(minutes)}m old`;
  }
  if (minutes < 1440) {
    return `${Math.round(minutes / 60)}h old`;
  }
  return `${Math.round(minutes / 1440)}d old`;
}

export function isFreshnessStale(minutes?: number) {
  return minutes !== undefined && minutes >= 120;
}

export function compareWithSort<T extends FilterableRecord>(a: T, b: T, sortBy: SortOption, getName: (item: T) => string, getPriority?: (item: T) => QueuePriority | undefined) {
  const pinnedDelta = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
  if (pinnedDelta !== 0) {
    return pinnedDelta;
  }

  if (sortBy === "name_asc") {
    return getName(a).localeCompare(getName(b));
  }

  if (sortBy === "region_asc") {
    return (a.region ?? "").localeCompare(b.region ?? "") || getName(a).localeCompare(getName(b));
  }

  if (sortBy === "freshness_desc") {
    return (a.freshnessMinutes ?? Number.MAX_SAFE_INTEGER) - (b.freshnessMinutes ?? Number.MAX_SAFE_INTEGER);
  }

  if (sortBy === "priority_desc" && getPriority) {
    return priorityWeight(getPriority(b)) - priorityWeight(getPriority(a));
  }

  const aRisk = riskWeight(a.risk ?? a.pressure ?? a.urgency ?? a.benchmarkStatus ?? a.status);
  const bRisk = riskWeight(b.risk ?? b.pressure ?? b.urgency ?? b.benchmarkStatus ?? b.status);
  return bRisk - aRisk || getName(a).localeCompare(getName(b));
}

export function applyInventoryFilters(items: InventoryNode[], filters: FilterState) {
  const query = normalizeQuery(filters.query);
  return items
    .filter((item) => {
      const matchesQuery = !query || [item.name, item.region, item.note, item.restockUrgency].some((value) => String(value ?? "").toLowerCase().includes(query));
      const matchesRegion = filters.region === "all" || item.region.toLowerCase() === filters.region.toLowerCase();
      const matchesRisk = filters.risk === "all" || item.risk === filters.risk;
      const matchesPinned = !filters.pinnedOnly || Boolean(item.pinned);
      return matchesQuery && matchesRegion && matchesRisk && matchesPinned;
    })
    .sort((a, b) => compareWithSort(a, b, filters.sortBy, (item) => item.name));
}

export function applyProcurementFilters(items: ProcurementProposal[], filters: FilterState) {
  const query = normalizeQuery(filters.query);
  return items
    .filter((item) => {
      const matchesQuery = !query || [item.sku, item.nodeName, item.note, item.supplier, item.action].some((value) => String(value ?? "").toLowerCase().includes(query));
      const matchesRegion = filters.region === "all" || item.nodeName.toLowerCase().includes(filters.region.toLowerCase());
      const matchesRisk = filters.risk === "all" || item.urgency === filters.risk;
      const matchesPinned = !filters.pinnedOnly || Boolean(item.pinned);
      return matchesQuery && matchesRegion && matchesRisk && matchesPinned;
    })
    .sort((a, b) => compareWithSort(a, b, filters.sortBy, (item) => item.sku, (item) => item.urgency === "critical" ? "urgent" : item.urgency === "watch" ? "high" : "normal"));
}

export function applyDispatchFilters(items: DispatchZone[], filters: FilterState) {
  const query = normalizeQuery(filters.query);
  return items
    .filter((item) => {
      const matchesQuery = !query || [item.name, item.note, item.suggestedAction, item.driverBalance].some((value) => String(value ?? "").toLowerCase().includes(query));
      const matchesRegion = filters.region === "all" || item.name.toLowerCase().includes(filters.region.toLowerCase());
      const matchesRisk = filters.risk === "all" || item.pressure === filters.risk;
      const matchesPinned = !filters.pinnedOnly || Boolean(item.pinned);
      return matchesQuery && matchesRegion && matchesRisk && matchesPinned;
    })
    .sort((a, b) => compareWithSort(a, b, filters.sortBy, (item) => item.name));
}

export function applyMerchantFilters(items: MerchantSignal[], filters: FilterState) {
  const query = normalizeQuery(filters.query);
  return items
    .filter((item) => {
      const matchesQuery = !query || [item.merchantName, item.campaignReadiness, item.nextAction].some((value) => String(value ?? "").toLowerCase().includes(query));
      const matchesRegion = filters.region === "all" || item.merchantName.toLowerCase().includes(filters.region.toLowerCase());
      const matchesRisk = filters.risk === "all" || item.benchmarkStatus === filters.risk;
      const matchesPinned = !filters.pinnedOnly || Boolean(item.pinned);
      return matchesQuery && matchesRegion && matchesRisk && matchesPinned;
    })
    .sort((a, b) => compareWithSort(a, b, filters.sortBy, (item) => item.merchantName));
}

export function applyLoyaltyFilters(items: LoyaltySignal[], filters: FilterState) {
  const query = normalizeQuery(filters.query);
  return items
    .filter((item) => {
      const matchesQuery = !query || [item.customerLabel, item.recommendedAction, item.lastTouchpoint].some((value) => String(value ?? "").toLowerCase().includes(query));
      const matchesRegion = filters.region === "all" || item.customerLabel.toLowerCase().includes(filters.region.toLowerCase());
      const matchesRisk = filters.risk === "all" || item.status === filters.risk;
      const matchesPinned = !filters.pinnedOnly || Boolean(item.pinned);
      return matchesQuery && matchesRegion && matchesRisk && matchesPinned;
    })
    .sort((a, b) => compareWithSort(a, b, filters.sortBy, (item) => item.customerLabel));
}

export function renderQuickActionText(preset: QuickActionPreset, name: string) {
  return {
    title: preset.titleTemplate.replace(/{{name}}/g, name),
    note: preset.noteTemplate.replace(/{{name}}/g, name),
  };
}

export function availableRegionsForDomain(domain: RecordDomain, items: Array<FilterableRecord & { name?: string; nodeName?: string; merchantName?: string; customerLabel?: string }>) {
  const rawRegions = items.flatMap((item) => {
    if (item.region) {
      return [item.region];
    }
    if (item.nodeName) {
      return [item.nodeName];
    }
    return [];
  });
  return ["all", ...Array.from(new Set(rawRegions.filter(Boolean))).sort((a, b) => a.localeCompare(b))];
}
