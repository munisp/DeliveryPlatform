import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import * as Network from "expo-network";
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Platform } from "react-native";

import { buildFreshnessLabel, buildOperationalMetrics, loadOperationalSnapshot } from "@/lib/mobile/api";
import type {
  ConnectivityMode,
  EndpointProfile,
  FilterState,
  MobileAlert,
  MobileAppState,
  NoteDraft,
  OperatorSettings,
  OutboxItem,
  QueuePriority,
  RecordDomain,
  SavedNoteTemplate,
  SnapshotData,
  WorkflowActionType,
  WorkflowPayload,
} from "@/lib/mobile/types";

const SETTINGS_KEY = "switchos-mobile:settings";
const SNAPSHOT_KEY = "switchos-mobile:snapshot";
const OUTBOX_KEY = "switchos-mobile:outbox";
const LAST_SYNC_KEY = "switchos-mobile:last-sync";
const NOTE_DRAFTS_KEY = "switchos-mobile:note-drafts";
const ENDPOINT_PROFILES_KEY = "switchos-mobile:endpoint-profiles";
const FILTERS_KEY = "switchos-mobile:filters";
const ONBOARDING_KEY = "switchos-mobile:onboarding";
const NOTE_TEMPLATES_KEY = "switchos-mobile:note-templates";

const defaultSettings: OperatorSettings = {
  operatorName: "",
  region: "Lagos",
  platformBaseUrl: "",
  localCommerceGatewayUrl: "",
  inventoryControlUrl: "",
  procurementPlannerUrl: "",
  dispatchOptimizerUrl: "",
  enableNotifications: true,
  autoSyncOnCellular: true,
  lastEnvironmentLabel: "Local sandbox",
  activeEndpointProfileId: "local",
};

const defaultEndpointProfiles: EndpointProfile[] = [
  {
    id: "local",
    label: "Local sandbox",
    platformBaseUrl: "",
    localCommerceGatewayUrl: "",
    inventoryControlUrl: "",
    procurementPlannerUrl: "",
    dispatchOptimizerUrl: "",
  },
  {
    id: "staging",
    label: "Staging",
    platformBaseUrl: "",
    localCommerceGatewayUrl: "",
    inventoryControlUrl: "",
    procurementPlannerUrl: "",
    dispatchOptimizerUrl: "",
  },
  {
    id: "production",
    label: "Production",
    platformBaseUrl: "",
    localCommerceGatewayUrl: "",
    inventoryControlUrl: "",
    procurementPlannerUrl: "",
    dispatchOptimizerUrl: "",
  },
];

const defaultFilters: Record<RecordDomain, FilterState> = {
  inventory: { query: "", region: "all", risk: "all", pinnedOnly: false, sortBy: "risk_desc" },
  procurement: { query: "", region: "all", risk: "all", pinnedOnly: false, sortBy: "priority_desc" },
  dispatch: { query: "", region: "all", risk: "all", pinnedOnly: false, sortBy: "risk_desc" },
  merchant: { query: "", region: "all", risk: "all", pinnedOnly: false, sortBy: "freshness_desc" },
  loyalty: { query: "", region: "all", risk: "all", pinnedOnly: false, sortBy: "freshness_desc" },
};

const defaultNoteTemplates: SavedNoteTemplate[] = [
  { id: "tmpl-audit", label: "Audit variance", body: "Investigate stock variance and confirm physical count before close.", domain: "inventory" },
  { id: "tmpl-replenishment", label: "Replenishment escalation", body: "Escalate replenishment due to low coverage and peak-hour exposure.", domain: "procurement" },
  { id: "tmpl-dispatch", label: "Dispatch congestion", body: "Rebalance riders toward the constrained zone and monitor wait-time recovery.", domain: "dispatch" },
  { id: "tmpl-merchant", label: "Merchant recovery", body: "Recover campaign momentum with targeted merchant outreach and offer revision.", domain: "merchant" },
  { id: "tmpl-loyalty", label: "Retention safeguard", body: "Apply a loyalty safeguard to preserve customer conversion and reduce churn risk.", domain: "loyalty" },
];

const defaultSnapshot = (): SnapshotData => ({
  summary: {
    generatedAt: new Date(0).toISOString(),
    freshnessLabel: "No synced snapshot yet",
    logisticsHeadline: "Connect the app to live services to load operational data.",
    queueCount: 0,
    failedCount: 0,
    serviceCount: 0,
    criticalInventory: 0,
    criticalDispatch: 0,
    criticalMerchantSignals: 0,
    loyaltyAttention: 0,
  },
  services: [],
  inventory: [],
  procurement: [],
  dispatch: [],
  merchants: [],
  loyalty: [],
  alerts: [],
  availableRegions: [],
});

const defaultState: MobileAppState = {
  hydrationComplete: false,
  connectivityMode: "offline",
  isInternetReachable: false,
  settings: defaultSettings,
  snapshot: defaultSnapshot(),
  outbox: [],
  syncing: false,
  lastSyncedAt: undefined,
  onboarding: { completed: false, currentStep: 0 },
  noteDrafts: [],
  savedNoteTemplates: defaultNoteTemplates,
  endpointProfiles: defaultEndpointProfiles,
  activeFilters: defaultFilters,
  quickActionPresets: [
    {
      id: "inventory-audit",
      label: "Inventory audit",
      actionType: "inventory_audit",
      domain: "inventory",
      titleTemplate: "Inventory audit for {{name}}",
      noteTemplate: "Verify shelf stock and cold-chain posture.",
      defaultPriority: "high",
    },
    {
      id: "replenishment",
      label: "Replenishment",
      actionType: "replenishment",
      domain: "procurement",
      titleTemplate: "Replenishment for {{name}}",
      noteTemplate: "Escalate replenishment based on live stock pressure.",
      defaultPriority: "urgent",
    },
    {
      id: "dispatch-rebalance",
      label: "Dispatch rebalance",
      actionType: "dispatch_rebalance",
      domain: "dispatch",
      titleTemplate: "Dispatch rebalance for {{name}}",
      noteTemplate: "Rebalance riders toward the highest-pressure zone.",
      defaultPriority: "high",
    },
    {
      id: "merchant-campaign",
      label: "Merchant campaign",
      actionType: "merchant_campaign",
      domain: "merchant",
      titleTemplate: "Merchant campaign for {{name}}",
      noteTemplate: "Launch or recover campaign momentum for this merchant.",
      defaultPriority: "normal",
    },
    {
      id: "loyalty-intervention",
      label: "Loyalty intervention",
      actionType: "loyalty_intervention",
      domain: "loyalty",
      titleTemplate: "Loyalty intervention for {{name}}",
      noteTemplate: "Protect at-risk customer engagement.",
      defaultPriority: "normal",
    },
  ],
};

type MobileAppContextValue = MobileAppState & {
  saveSettings: (settings: Partial<OperatorSettings>) => Promise<void>;
  refreshSnapshot: () => Promise<void>;
  queueAction: (actionType: WorkflowActionType, payload: WorkflowPayload) => Promise<void>;
  retryOutbox: () => Promise<void>;
  clearCompletedOutbox: () => Promise<void>;
  updateFilter: (domain: RecordDomain, patch: Partial<FilterState>) => Promise<void>;
  togglePinnedRecord: (domain: RecordDomain, recordId: string) => Promise<void>;
  saveNoteDraft: (draft: NoteDraft) => Promise<void>;
  removeNoteDraft: (draftId: string) => Promise<void>;
  setOutboxPriority: (itemId: string, priority: QueuePriority) => Promise<void>;
  applyEndpointProfile: (profileId: string) => Promise<void>;
  advanceOnboarding: (step: number, completed?: boolean) => Promise<void>;
};

const MobileAppContext = createContext<MobileAppContextValue | null>(null);

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: false,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

function createTraceId() {
  return `mobile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function deriveConnectivityMode(isConnected?: boolean | null, isInternetReachable?: boolean | null): ConnectivityMode {
  if (!isConnected) {
    return "offline";
  }
  if (!isInternetReachable) {
    return "limited";
  }
  return "online";
}

function mergeFilters(saved?: Partial<Record<RecordDomain, Partial<FilterState>>>) {
  return {
    inventory: { ...defaultFilters.inventory, ...(saved?.inventory ?? {}) },
    procurement: { ...defaultFilters.procurement, ...(saved?.procurement ?? {}) },
    dispatch: { ...defaultFilters.dispatch, ...(saved?.dispatch ?? {}) },
    merchant: { ...defaultFilters.merchant, ...(saved?.merchant ?? {}) },
    loyalty: { ...defaultFilters.loyalty, ...(saved?.loyalty ?? {}) },
  } satisfies Record<RecordDomain, FilterState>;
}

function togglePinned<T extends { id: string; pinned?: boolean }>(items: T[], recordId: string) {
  return items.map((item) => item.id === recordId ? { ...item, pinned: !item.pinned } : item);
}

async function scheduleAlertNotification(alert: MobileAlert, enabled: boolean) {
  if (!enabled || Platform.OS === "web") {
    return;
  }

  const permission = await Notifications.getPermissionsAsync();
  let status = permission.status;
  if (status !== "granted") {
    status = (await Notifications.requestPermissionsAsync()).status;
  }
  if (status !== "granted") {
    return;
  }

  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("operations", {
      name: "Operations",
      importance: Notifications.AndroidImportance.HIGH,
    });
  }

  await Notifications.scheduleNotificationAsync({
    content: {
      title: alert.title,
      body: alert.body,
      data: { alertId: alert.id, source: alert.source },
    },
    trigger: null,
  });
}

export function MobileAppProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<MobileAppState>(defaultState);

  useEffect(() => {
    const initialize = async () => {
      const [
        savedSettings,
        savedSnapshot,
        savedOutbox,
        lastSyncedAt,
        savedNoteDrafts,
        savedEndpointProfiles,
        savedFilters,
        savedOnboarding,
        savedNoteTemplates,
      ] = await Promise.all([
        AsyncStorage.getItem(SETTINGS_KEY),
        AsyncStorage.getItem(SNAPSHOT_KEY),
        AsyncStorage.getItem(OUTBOX_KEY),
        AsyncStorage.getItem(LAST_SYNC_KEY),
        AsyncStorage.getItem(NOTE_DRAFTS_KEY),
        AsyncStorage.getItem(ENDPOINT_PROFILES_KEY),
        AsyncStorage.getItem(FILTERS_KEY),
        AsyncStorage.getItem(ONBOARDING_KEY),
        AsyncStorage.getItem(NOTE_TEMPLATES_KEY),
      ]);

      const networkState = await Network.getNetworkStateAsync();
      setState((current) => ({
        ...current,
        hydrationComplete: true,
        connectivityMode: deriveConnectivityMode(networkState.isConnected, networkState.isInternetReachable),
        isInternetReachable: Boolean(networkState.isInternetReachable),
        settings: savedSettings ? { ...defaultSettings, ...JSON.parse(savedSettings) } : defaultSettings,
        snapshot: savedSnapshot ? { ...defaultSnapshot(), ...JSON.parse(savedSnapshot) } : defaultSnapshot(),
        outbox: savedOutbox ? JSON.parse(savedOutbox) : [],
        lastSyncedAt: lastSyncedAt ?? undefined,
        noteDrafts: savedNoteDrafts ? JSON.parse(savedNoteDrafts) : [],
        endpointProfiles: savedEndpointProfiles ? JSON.parse(savedEndpointProfiles) : defaultEndpointProfiles,
        activeFilters: savedFilters ? mergeFilters(JSON.parse(savedFilters)) : defaultFilters,
        onboarding: savedOnboarding ? { ...defaultState.onboarding, ...JSON.parse(savedOnboarding) } : defaultState.onboarding,
        savedNoteTemplates: savedNoteTemplates ? JSON.parse(savedNoteTemplates) : defaultNoteTemplates,
      }));
    };

    void initialize();

    const subscription = Network.addNetworkStateListener((networkState: Network.NetworkState) => {
      setState((current) => ({
        ...current,
        connectivityMode: deriveConnectivityMode(networkState.isConnected, networkState.isInternetReachable),
        isInternetReachable: Boolean(networkState.isInternetReachable),
      }));
    });

    return () => subscription.remove();
  }, []);

  const persistOutbox = useCallback(async (outbox: OutboxItem[]) => {
    await AsyncStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox));
    setState((current) => ({ ...current, outbox }));
  }, []);

  const persistSnapshot = useCallback(async (snapshot: SnapshotData) => {
    await AsyncStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
    setState((current) => ({ ...current, snapshot }));
  }, []);

  const saveSettings = useCallback(async (patch: Partial<OperatorSettings>) => {
    const nextSettings = { ...state.settings, ...patch };
    await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(nextSettings));
    setState((current) => ({ ...current, settings: nextSettings }));
  }, [state.settings]);

  const updateFilter = useCallback(async (domain: RecordDomain, patch: Partial<FilterState>) => {
    const nextFilters = {
      ...state.activeFilters,
      [domain]: {
        ...state.activeFilters[domain],
        ...patch,
      },
    };
    await AsyncStorage.setItem(FILTERS_KEY, JSON.stringify(nextFilters));
    setState((current) => ({ ...current, activeFilters: nextFilters }));
  }, [state.activeFilters]);

  const saveNoteDraft = useCallback(async (draft: NoteDraft) => {
    const nextDrafts = [draft, ...state.noteDrafts.filter((entry) => entry.id !== draft.id)].slice(0, 25);
    await AsyncStorage.setItem(NOTE_DRAFTS_KEY, JSON.stringify(nextDrafts));
    setState((current) => ({ ...current, noteDrafts: nextDrafts }));
  }, [state.noteDrafts]);

  const removeNoteDraft = useCallback(async (draftId: string) => {
    const nextDrafts = state.noteDrafts.filter((entry) => entry.id !== draftId);
    await AsyncStorage.setItem(NOTE_DRAFTS_KEY, JSON.stringify(nextDrafts));
    setState((current) => ({ ...current, noteDrafts: nextDrafts }));
  }, [state.noteDrafts]);

  const applyEndpointProfile = useCallback(async (profileId: string) => {
    const profile = state.endpointProfiles.find((entry) => entry.id === profileId);
    if (!profile) {
      return;
    }

    const nextSettings: OperatorSettings = {
      ...state.settings,
      platformBaseUrl: profile.platformBaseUrl,
      localCommerceGatewayUrl: profile.localCommerceGatewayUrl,
      inventoryControlUrl: profile.inventoryControlUrl,
      procurementPlannerUrl: profile.procurementPlannerUrl,
      dispatchOptimizerUrl: profile.dispatchOptimizerUrl,
      activeEndpointProfileId: profile.id,
      lastEnvironmentLabel: profile.label,
    };

    await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(nextSettings));
    setState((current) => ({ ...current, settings: nextSettings }));
  }, [state.endpointProfiles, state.settings]);

  const advanceOnboarding = useCallback(async (step: number, completed?: boolean) => {
    const nextOnboarding = {
      ...state.onboarding,
      currentStep: step,
      completed: completed ?? state.onboarding.completed,
      dismissedAt: completed ? new Date().toISOString() : state.onboarding.dismissedAt,
    };
    await AsyncStorage.setItem(ONBOARDING_KEY, JSON.stringify(nextOnboarding));
    setState((current) => ({ ...current, onboarding: nextOnboarding }));
  }, [state.onboarding]);

  const refreshSnapshot = useCallback(async () => {
    setState((current) => ({ ...current, syncing: true }));

    const hydrated = await loadOperationalSnapshot(state.settings, state.snapshot);
    const operationalMetrics = buildOperationalMetrics({
      ...state.snapshot,
      inventory: hydrated.inventory,
      procurement: hydrated.procurement,
      dispatch: hydrated.dispatch,
      merchants: hydrated.merchants,
      loyalty: hydrated.loyalty,
      alerts: hydrated.alerts,
      services: hydrated.services,
    });

    const nextSnapshot: SnapshotData = {
      summary: {
        generatedAt: new Date().toISOString(),
        freshnessLabel: buildFreshnessLabel(hydrated.services),
        logisticsHeadline: hydrated.logisticsHeadline || (hydrated.services.some((service) => service.status === "offline")
          ? "One or more logistics services are unreachable; queued execution remains available."
          : "Core services are reachable; mobile operations can proceed."),
        queueCount: state.outbox.length,
        failedCount: state.outbox.filter((item) => item.status === "failed").length,
        serviceCount: hydrated.services.length,
        criticalInventory: operationalMetrics.criticalInventory,
        criticalDispatch: operationalMetrics.criticalDispatch,
        criticalMerchantSignals: operationalMetrics.criticalMerchantSignals,
        loyaltyAttention: operationalMetrics.loyaltyAttention,
      },
      services: hydrated.services,
      inventory: hydrated.inventory,
      procurement: hydrated.procurement,
      dispatch: hydrated.dispatch,
      merchants: hydrated.merchants,
      loyalty: hydrated.loyalty,
      alerts: hydrated.alerts.length > 0
        ? hydrated.alerts
        : operationalMetrics.criticalInventory + operationalMetrics.criticalDispatch + operationalMetrics.criticalMerchantSignals > 0
          ? [{
              id: `ops-summary-${Date.now()}`,
              severity: "watch",
              title: "Operational attention required",
              body: `Inventory ${operationalMetrics.criticalInventory}, dispatch ${operationalMetrics.criticalDispatch}, merchant ${operationalMetrics.criticalMerchantSignals}, loyalty ${operationalMetrics.loyaltyAttention}.`,
              createdAt: new Date().toISOString(),
              source: "SwitchOS mobile",
            }]
          : [],
      availableRegions: [
        {
          id: state.settings.region.toLowerCase(),
          label: state.settings.region,
          freshnessLabel: buildFreshnessLabel(hydrated.services),
          cachedAt: new Date().toISOString(),
        },
      ],
    };

    await AsyncStorage.setItem(LAST_SYNC_KEY, nextSnapshot.summary.generatedAt);
    await persistSnapshot(nextSnapshot);

    if (nextSnapshot.alerts.length > 0) {
      await scheduleAlertNotification(nextSnapshot.alerts[0], state.settings.enableNotifications);
    }

    setState((current) => ({
      ...current,
      lastSyncedAt: nextSnapshot.summary.generatedAt,
      syncing: false,
    }));
  }, [persistSnapshot, state.outbox, state.settings, state.snapshot]);

  const queueAction = useCallback(async (actionType: WorkflowActionType, payload: WorkflowPayload) => {
    const item: OutboxItem = {
      id: createTraceId(),
      actionType,
      payload,
      createdAt: new Date().toISOString(),
      status: state.connectivityMode === "online" ? "syncing" : "queued",
      priority: payload.priority ?? "normal",
      retryCount: 0,
      nextRetryAt: state.connectivityMode === "online" ? undefined : new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    };

    const nextOutbox = [item, ...state.outbox];
    await persistOutbox(nextOutbox);

    if (state.connectivityMode !== "online") {
      const alert: MobileAlert = {
        id: `${item.id}-queued`,
        severity: "watch",
        title: "Action queued locally",
        body: `${payload.title} will sync when connectivity improves.`,
        createdAt: new Date().toISOString(),
        source: "Offline outbox",
      };
      await scheduleAlertNotification(alert, state.settings.enableNotifications);
      const nextSnapshot = {
        ...state.snapshot,
        alerts: [alert, ...state.snapshot.alerts],
        summary: {
          ...state.snapshot.summary,
          queueCount: nextOutbox.length,
        },
      };
      await persistSnapshot(nextSnapshot);
    }
  }, [persistOutbox, persistSnapshot, state.connectivityMode, state.outbox, state.settings.enableNotifications, state.snapshot]);

  const retryOutbox = useCallback(async () => {
    if (state.outbox.length === 0) {
      return;
    }

    const now = Date.now();
    const retried: OutboxItem[] = state.outbox.map((item) => {
      const nextRetryCount = (item.retryCount ?? 0) + 1;
      return {
        ...item,
        status: state.connectivityMode === "online" ? "completed" : "queued",
        lastAttemptAt: new Date().toISOString(),
        errorMessage: state.connectivityMode === "online" ? undefined : item.errorMessage,
        retryCount: nextRetryCount,
        nextRetryAt: state.connectivityMode === "online"
          ? undefined
          : new Date(now + Math.min(60, 2 ** nextRetryCount) * 60 * 1000).toISOString(),
      };
    });

    await persistOutbox(retried);
  }, [persistOutbox, state.connectivityMode, state.outbox]);

  const setOutboxPriority = useCallback(async (itemId: string, priority: QueuePriority) => {
    const nextOutbox = state.outbox.map((item) => item.id === itemId ? { ...item, priority, payload: { ...item.payload, priority } } : item);
    await persistOutbox(nextOutbox);
  }, [persistOutbox, state.outbox]);

  const clearCompletedOutbox = useCallback(async () => {
    const filtered = state.outbox.filter((item) => item.status !== "completed");
    await persistOutbox(filtered);
  }, [persistOutbox, state.outbox]);

  const togglePinnedRecord = useCallback(async (domain: RecordDomain, recordId: string) => {
    const nextSnapshot: SnapshotData = {
      ...state.snapshot,
      inventory: domain === "inventory" ? togglePinned(state.snapshot.inventory, recordId) : state.snapshot.inventory,
      procurement: domain === "procurement" ? togglePinned(state.snapshot.procurement, recordId) : state.snapshot.procurement,
      dispatch: domain === "dispatch" ? togglePinned(state.snapshot.dispatch, recordId) : state.snapshot.dispatch,
      merchants: domain === "merchant" ? togglePinned(state.snapshot.merchants, recordId) : state.snapshot.merchants,
      loyalty: domain === "loyalty" ? togglePinned(state.snapshot.loyalty, recordId) : state.snapshot.loyalty,
    };
    await persistSnapshot(nextSnapshot);
  }, [persistSnapshot, state.snapshot]);

  const value = useMemo<MobileAppContextValue>(() => ({
    ...state,
    saveSettings,
    refreshSnapshot,
    queueAction,
    retryOutbox,
    clearCompletedOutbox,
    updateFilter,
    togglePinnedRecord,
    saveNoteDraft,
    removeNoteDraft,
    setOutboxPriority,
    applyEndpointProfile,
    advanceOnboarding,
  }), [
    advanceOnboarding,
    applyEndpointProfile,
    clearCompletedOutbox,
    queueAction,
    refreshSnapshot,
    removeNoteDraft,
    retryOutbox,
    saveNoteDraft,
    saveSettings,
    setOutboxPriority,
    state,
    togglePinnedRecord,
    updateFilter,
  ]);

  return <MobileAppContext.Provider value={value}>{children}</MobileAppContext.Provider>;
}

export function useMobileApp() {
  const context = useContext(MobileAppContext);
  if (!context) {
    throw new Error("useMobileApp must be used within MobileAppProvider");
  }
  return context;
}
