export type ConnectivityMode = "online" | "limited" | "offline";

export type SyncStatus = "idle" | "syncing" | "queued" | "failed" | "completed";

export type RiskLevel = "stable" | "watch" | "critical";

export type ServiceStatus = "healthy" | "degraded" | "offline" | "unknown";

export type WorkflowActionType =
  | "replenishment"
  | "inventory_audit"
  | "dispatch_rebalance"
  | "loyalty_intervention"
  | "merchant_campaign";

export type RecordDomain = "inventory" | "procurement" | "dispatch" | "merchant" | "loyalty";

export type SortOption =
  | "risk_desc"
  | "freshness_desc"
  | "name_asc"
  | "region_asc"
  | "priority_desc";

export type ThemePreference = "system" | "light" | "dark";

export type QueuePriority = "low" | "normal" | "high" | "urgent";

export type FilterState = {
  query: string;
  region: string;
  risk: RiskLevel | "all";
  pinnedOnly: boolean;
  sortBy: SortOption;
};

export type EndpointProfile = {
  id: string;
  label: string;
  platformBaseUrl: string;
  localCommerceGatewayUrl: string;
  inventoryControlUrl: string;
  procurementPlannerUrl: string;
  dispatchOptimizerUrl: string;
};

export type QuickActionPreset = {
  id: string;
  label: string;
  actionType: WorkflowActionType;
  domain: RecordDomain;
  titleTemplate: string;
  noteTemplate: string;
  defaultPriority: QueuePriority;
};

export type AnnotationStroke = {
  id: string;
  color: string;
  width: number;
  points: Array<{ x: number; y: number }>;
};

export type AnnotationText = {
  id: string;
  text: string;
  color: string;
  x: number;
  y: number;
};

export type AttachmentDraft = {
  id: string;
  uri: string;
  name: string;
  mimeType?: string;
  annotations?: {
    strokes: AnnotationStroke[];
    texts: AnnotationText[];
    width?: number;
    height?: number;
    annotatedAt?: string;
  };
};

export type NoteDraft = {
  id: string;
  title: string;
  body: string;
  targetId?: string;
  domain?: RecordDomain;
  updatedAt: string;
  attachments: AttachmentDraft[];
};

export type SavedNoteTemplate = {
  id: string;
  label: string;
  body: string;
  domain: RecordDomain | "shared";
};

export type RegionWorkspace = {
  id: string;
  label: string;
  freshnessLabel: string;
  cachedAt?: string;
};

export type OnboardingState = {
  completed: boolean;
  currentStep: number;
  dismissedAt?: string;
};

export type OperatorSettings = {
  operatorName: string;
  region: string;
  platformBaseUrl: string;
  localCommerceGatewayUrl: string;
  inventoryControlUrl: string;
  procurementPlannerUrl: string;
  dispatchOptimizerUrl: string;
  enableNotifications: boolean;
  autoSyncOnCellular: boolean;
  lastEnvironmentLabel: string;
  activeEndpointProfileId?: string;
};

export type ServiceHealth = {
  key: string;
  label: string;
  status: ServiceStatus;
  latencyMs?: number;
  detail?: string;
  updatedAt?: string;
  cacheAgeMinutes?: number;
  lastSuccessfulAt?: string;
};

export type InventoryNode = {
  id: string;
  name: string;
  region: string;
  risk: RiskLevel;
  confidence: "high" | "medium" | "low";
  stockCoverageHours?: number;
  restockUrgency?: string;
  note?: string;
  pinned?: boolean;
  freshnessMinutes?: number;
  recordUpdatedAt?: string;
  bookmarkedAt?: string;
};

export type ProcurementProposal = {
  id: string;
  sku: string;
  nodeName: string;
  action: "purchase" | "transfer";
  urgency: RiskLevel;
  recommendedUnits?: number;
  supplier?: string;
  etaWindow?: string;
  note?: string;
  pinned?: boolean;
  freshnessMinutes?: number;
  recordUpdatedAt?: string;
};

export type DispatchZone = {
  id: string;
  name: string;
  pressure: RiskLevel;
  driverBalance?: string;
  suggestedAction?: string;
  note?: string;
  pinned?: boolean;
  freshnessMinutes?: number;
  recordUpdatedAt?: string;
};

export type MerchantSignal = {
  id: string;
  merchantName: string;
  benchmarkStatus: RiskLevel;
  campaignReadiness?: string;
  nextAction?: string;
  pinned?: boolean;
  freshnessMinutes?: number;
  recordUpdatedAt?: string;
};

export type LoyaltySignal = {
  id: string;
  customerLabel: string;
  status: RiskLevel;
  recommendedAction?: string;
  lastTouchpoint?: string;
  pinned?: boolean;
  freshnessMinutes?: number;
  recordUpdatedAt?: string;
};

export type SnapshotSummary = {
  generatedAt: string;
  freshnessLabel: string;
  logisticsHeadline: string;
  queueCount: number;
  failedCount: number;
  serviceCount: number;
  criticalInventory?: number;
  criticalDispatch?: number;
  criticalMerchantSignals?: number;
  loyaltyAttention?: number;
};

export type SnapshotData = {
  summary: SnapshotSummary;
  services: ServiceHealth[];
  inventory: InventoryNode[];
  procurement: ProcurementProposal[];
  dispatch: DispatchZone[];
  merchants: MerchantSignal[];
  loyalty: LoyaltySignal[];
  alerts: MobileAlert[];
  availableRegions?: RegionWorkspace[];
};

export type SmartSearchResult = {
  domain: "inventory" | "dispatch";
  recordId: string;
  title: string;
  subtitle: string;
  severity: RiskLevel;
  reason: string;
  score: number;
  explanationChips: string[];
};

export type WorkflowPayload = {
  title: string;
  targetId?: string;
  note?: string;
  metadata?: Record<string, string>;
  priority?: QueuePriority;
  attachments?: AttachmentDraft[];
  scheduledFor?: string;
};

export type OutboxItem = {
  id: string;
  actionType: WorkflowActionType;
  payload: WorkflowPayload;
  createdAt: string;
  lastAttemptAt?: string;
  status: SyncStatus;
  errorMessage?: string;
  priority?: QueuePriority;
  retryCount?: number;
  nextRetryAt?: string;
  conflictDetected?: boolean;
  liveVersionLabel?: string;
};

export type MobileAlert = {
  id: string;
  severity: RiskLevel;
  title: string;
  body: string;
  createdAt: string;
  source: string;
  actionLabel?: string;
  actionTarget?: string;
};

export type MobileAppState = {
  hydrationComplete: boolean;
  connectivityMode: ConnectivityMode;
  isInternetReachable: boolean;
  settings: OperatorSettings;
  snapshot: SnapshotData;
  outbox: OutboxItem[];
  syncing: boolean;
  lastSyncedAt?: string;
  onboarding: OnboardingState;
  noteDrafts: NoteDraft[];
  savedNoteTemplates: SavedNoteTemplate[];
  endpointProfiles: EndpointProfile[];
  activeFilters: Record<RecordDomain, FilterState>;
  quickActionPresets: QuickActionPreset[];
};
