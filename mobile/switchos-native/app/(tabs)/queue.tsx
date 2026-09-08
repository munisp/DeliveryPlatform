import { useEffect, useMemo, useState } from "react";
import {
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";

import { NativeAdminRouteGuard } from "@/components/mobile/native-admin-route-guard";
import {
  AlertRow,
  EmptyState,
  OutboxItemRow,
  SectionCard,
} from "@/components/mobile/operations-ui";
import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import { useMobileApp } from "@/lib/mobile/provider";
import { useThemeContext } from "@/lib/theme-provider";
import type { QueuePriority } from "@/lib/mobile/types";
import { formatFreshness, priorityWeight } from "@/lib/mobile/workspace";

const priorityOptions: QueuePriority[] = ["urgent", "high", "normal", "low"];

export default function QueueScreen() {
  const { preference, setThemePreference } = useThemeContext();
  const {
    snapshot,
    outbox,
    syncing,
    refreshSnapshot,
    retryOutbox,
    clearCompletedOutbox,
    settings,
    saveSettings,
    endpointProfiles,
    applyEndpointProfile,
    setOutboxPriority,
    onboarding,
    advanceOnboarding,
  } = useMobileApp();

  const [operatorName, setOperatorName] = useState(settings.operatorName);
  const [region, setRegion] = useState(settings.region);
  const [platformBaseUrl, setPlatformBaseUrl] = useState(
    settings.platformBaseUrl,
  );
  const [localCommerceGatewayUrl, setLocalCommerceGatewayUrl] = useState(
    settings.localCommerceGatewayUrl,
  );
  const [inventoryControlUrl, setInventoryControlUrl] = useState(
    settings.inventoryControlUrl,
  );
  const [procurementPlannerUrl, setProcurementPlannerUrl] = useState(
    settings.procurementPlannerUrl,
  );
  const [dispatchOptimizerUrl, setDispatchOptimizerUrl] = useState(
    settings.dispatchOptimizerUrl,
  );

  useEffect(() => {
    setOperatorName(settings.operatorName);
    setRegion(settings.region);
    setPlatformBaseUrl(settings.platformBaseUrl);
    setLocalCommerceGatewayUrl(settings.localCommerceGatewayUrl);
    setInventoryControlUrl(settings.inventoryControlUrl);
    setProcurementPlannerUrl(settings.procurementPlannerUrl);
    setDispatchOptimizerUrl(settings.dispatchOptimizerUrl);
  }, [settings]);

  const sortedOutbox = useMemo(
    () =>
      [...outbox].sort(
        (a, b) =>
          priorityWeight(b.priority) - priorityWeight(a.priority) ||
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      ),
    [outbox],
  );
  const staleServices = useMemo(
    () =>
      snapshot.services.filter(
        (service) => (service.cacheAgeMinutes ?? 0) >= 120,
      ),
    [snapshot.services],
  );
  const failedOutbox = useMemo(
    () => outbox.filter((item) => item.status === "failed"),
    [outbox],
  );
  const activeProfileId =
    settings.activeEndpointProfileId ??
    settings.lastEnvironmentLabel.toLowerCase();

  return (
    <NativeAdminRouteGuard>
      <ScreenContainer className="px-4 pb-6">
        <FlatList
          data={sortedOutbox}
          keyExtractor={(item) => item.id}
          refreshControl={
            <RefreshControl
              refreshing={syncing}
              onRefresh={() => void refreshSnapshot()}
            />
          }
          contentContainerStyle={{ gap: 16, paddingTop: 20, paddingBottom: 24 }}
          ListHeaderComponent={
            <View className="gap-4">
              <View>
                <Text className="text-3xl font-bold text-foreground">
                  Queue and Settings
                </Text>
                <Text className="mt-2 text-sm leading-6 text-muted">
                  Control cached snapshots, tune retry behavior, override queue
                  priority, and manage field endpoint profiles from one
                  offline-resilient control layer.
                </Text>
              </View>

              {staleServices.length > 0 ? (
                <View className="rounded-[24px] border border-warning/40 bg-warning/10 px-4 py-4">
                  <Text className="text-sm font-semibold text-warning">
                    Stale data detected
                  </Text>
                  <Text className="mt-2 text-sm leading-6 text-muted">
                    {staleServices.length} service snapshots are older than two
                    hours. The app is still showing last-known-good data while
                    waiting for a successful refresh.
                  </Text>
                </View>
              ) : null}

              <SectionCard
                title="Outbox controls"
                subtitle="Review queue pressure, retry posture, failed actions, and manual priority overrides before the next sync pass."
              >
                <View className="flex-row flex-wrap gap-3">
                  <View className="min-w-[150px] flex-1 rounded-2xl bg-background/70 px-4 py-3">
                    <Text className="text-xs uppercase tracking-wide text-muted">
                      Queued items
                    </Text>
                    <Text className="mt-2 text-2xl font-semibold text-foreground">
                      {outbox.length}
                    </Text>
                  </View>
                  <View className="min-w-[150px] flex-1 rounded-2xl bg-background/70 px-4 py-3">
                    <Text className="text-xs uppercase tracking-wide text-muted">
                      Failed actions
                    </Text>
                    <Text className="mt-2 text-2xl font-semibold text-foreground">
                      {failedOutbox.length}
                    </Text>
                  </View>
                </View>

                <View className="flex-row flex-wrap gap-3">
                  <Pressable
                    onPress={() => void retryOutbox()}
                    className="rounded-full bg-primary px-4 py-3"
                  >
                    <Text className="text-xs font-semibold text-white">
                      Retry outbox
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => void clearCompletedOutbox()}
                    className="rounded-full bg-background px-4 py-3"
                  >
                    <Text className="text-xs font-semibold text-foreground">
                      Clear completed
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => void refreshSnapshot()}
                    className="rounded-full bg-accent2 px-4 py-3"
                  >
                    <Text className="text-xs font-semibold text-white">
                      Restore last known good
                    </Text>
                  </Pressable>
                </View>
              </SectionCard>

              <SectionCard
                title="Regional workspace"
                subtitle="Switch the active field region and recover cached workspace context when operators move between territories."
              >
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ gap: 8 }}
                >
                  {(snapshot.availableRegions ?? []).map((workspace) => (
                    <Pressable
                      key={workspace.id}
                      onPress={() => {
                        setRegion(workspace.label);
                        void saveSettings({ region: workspace.label });
                      }}
                      className={
                        settings.region === workspace.label
                          ? "rounded-full bg-primary px-4 py-2"
                          : "rounded-full bg-background px-4 py-2"
                      }
                    >
                      <Text
                        className={
                          settings.region === workspace.label
                            ? "text-xs font-semibold text-white"
                            : "text-xs font-semibold text-foreground"
                        }
                      >
                        {workspace.label}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
              </SectionCard>

              <SectionCard
                title="Endpoint presets"
                subtitle="Switch quickly between local, staging, and production endpoint profiles without retyping every field."
              >
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ gap: 8 }}
                >
                  {endpointProfiles.map((profile) => (
                    <Pressable
                      key={profile.id}
                      onPress={() => void applyEndpointProfile(profile.id)}
                      className={
                        activeProfileId === profile.id
                          ? "rounded-full bg-primary px-4 py-2"
                          : "rounded-full bg-background px-4 py-2"
                      }
                    >
                      <Text
                        className={
                          activeProfileId === profile.id
                            ? "text-xs font-semibold text-white"
                            : "text-xs font-semibold text-foreground"
                        }
                      >
                        {profile.label}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
              </SectionCard>

              {!onboarding.completed ? (
                <SectionCard
                  title="First-run operator onboarding"
                  subtitle="Guide the device through the essential setup steps needed before field work begins."
                >
                  <View className="rounded-[20px] border border-border bg-background/70 px-4 py-3">
                    <Text className="text-xs uppercase tracking-wide text-muted">
                      Current step
                    </Text>
                    <Text className="mt-2 text-sm font-semibold text-foreground">
                      Step {onboarding.currentStep + 1}: configure operator,
                      region, and endpoint profile
                    </Text>
                  </View>
                  <View className="flex-row flex-wrap gap-3">
                    <Pressable
                      onPress={() => void advanceOnboarding(1, false)}
                      className="rounded-full bg-background px-4 py-3"
                    >
                      <Text className="text-xs font-semibold text-foreground">
                        Mark profile ready
                      </Text>
                    </Pressable>
                    <Pressable
                      onPress={() => void advanceOnboarding(2, false)}
                      className="rounded-full bg-background px-4 py-3"
                    >
                      <Text className="text-xs font-semibold text-foreground">
                        Mark endpoints ready
                      </Text>
                    </Pressable>
                    <Pressable
                      onPress={() => void advanceOnboarding(3, true)}
                      className="rounded-full bg-primary px-4 py-3"
                    >
                      <Text className="text-xs font-semibold text-white">
                        Complete onboarding
                      </Text>
                    </Pressable>
                  </View>
                </SectionCard>
              ) : null}

              <SectionCard
                title="Connectivity setup wizard"
                subtitle="Validate endpoint readiness and then trigger a sync without leaving the device."
              >
                <View className="gap-3 rounded-[20px] border border-border bg-background/70 px-4 py-3">
                  <WizardRow
                    label="Operator profile"
                    value={operatorName ? "Ready" : "Missing"}
                  />
                  <WizardRow
                    label="Region"
                    value={region ? "Ready" : "Missing"}
                  />
                  <WizardRow
                    label="Platform endpoint"
                    value={platformBaseUrl ? "Ready" : "Missing"}
                  />
                  <WizardRow
                    label="Dispatch endpoint"
                    value={dispatchOptimizerUrl ? "Ready" : "Missing"}
                  />
                </View>
                <View className="flex-row flex-wrap gap-3">
                  <Pressable
                    onPress={() =>
                      void saveSettings({
                        operatorName,
                        region,
                        platformBaseUrl,
                        localCommerceGatewayUrl,
                        inventoryControlUrl,
                        procurementPlannerUrl,
                        dispatchOptimizerUrl,
                      })
                    }
                    className="rounded-full bg-background px-4 py-3"
                  >
                    <Text className="text-xs font-semibold text-foreground">
                      Validate locally
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => void refreshSnapshot()}
                    className="rounded-full bg-primary px-4 py-3"
                  >
                    <Text className="text-xs font-semibold text-white">
                      Run sync test
                    </Text>
                  </Pressable>
                </View>
              </SectionCard>

              <SectionCard
                title="Manual sync controls"
                subtitle="Refresh the entire workspace or inspect cached freshness per service before connectivity improves further."
              >
                {snapshot.services.length > 0 ? (
                  snapshot.services.map((service) => (
                    <View
                      key={service.key}
                      className="rounded-[20px] border border-border bg-background/70 px-4 py-3"
                    >
                      <View className="flex-row items-start justify-between gap-3">
                        <View className="flex-1">
                          <Text className="text-sm font-semibold text-foreground">
                            {service.label}
                          </Text>
                          <Text className="mt-1 text-xs leading-5 text-muted">
                            {service.detail || "No diagnostic detail provided."}
                          </Text>
                        </View>
                        <Pressable
                          onPress={() => void refreshSnapshot()}
                          className="rounded-full bg-surface px-3 py-2"
                        >
                          <Text className="text-[11px] font-semibold text-foreground">
                            Sync
                          </Text>
                        </Pressable>
                      </View>
                      <Text className="mt-3 text-xs text-muted">
                        {service.cacheAgeMinutes !== undefined
                          ? `${formatFreshness(service.cacheAgeMinutes)} · ${service.status}`
                          : service.status}
                      </Text>
                    </View>
                  ))
                ) : (
                  <EmptyState
                    title="No service telemetry yet"
                    body="Refresh the app after setting endpoints to populate service-level freshness and diagnostics here."
                  />
                )}
              </SectionCard>

              <SectionCard
                title="Theme mode"
                subtitle="Choose whether the device follows the system appearance or stays pinned to a dedicated light or dark operating theme."
              >
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ gap: 8 }}
                >
                  {[
                    { id: "system", label: "Follow system" },
                    { id: "light", label: "Light" },
                    { id: "dark", label: "Dark" },
                  ].map((option) => (
                    <Pressable
                      key={option.id}
                      onPress={() =>
                        void setThemePreference(
                          option.id as "system" | "light" | "dark",
                        )
                      }
                      className={
                        preference === option.id
                          ? "rounded-full bg-primary px-4 py-2"
                          : "rounded-full bg-background px-4 py-2"
                      }
                    >
                      <Text
                        className={
                          preference === option.id
                            ? "text-xs font-semibold text-white"
                            : "text-xs font-semibold text-foreground"
                        }
                      >
                        {option.label}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
                <View className="rounded-[20px] border border-border bg-background/70 px-4 py-3">
                  <Text className="text-xs uppercase tracking-wide text-muted">
                    Active appearance
                  </Text>
                  <Text className="mt-2 text-sm font-semibold text-foreground">
                    {preference === "system"
                      ? "Following device theme"
                      : preference === "dark"
                        ? "Dark mode pinned"
                        : "Light mode pinned"}
                  </Text>
                </View>
              </SectionCard>

              <SectionCard
                title="Operator settings"
                subtitle="Store endpoint configuration locally so the app can continue operating offline and reconnect automatically later."
              >
                <View className="gap-3">
                  <Field
                    label="Operator name"
                    value={operatorName}
                    onChangeText={setOperatorName}
                  />
                  <Field
                    label="Region"
                    value={region}
                    onChangeText={setRegion}
                  />
                  <Field
                    label="Platform API URL"
                    value={platformBaseUrl}
                    onChangeText={setPlatformBaseUrl}
                  />
                  <Field
                    label="Local Commerce Gateway URL"
                    value={localCommerceGatewayUrl}
                    onChangeText={setLocalCommerceGatewayUrl}
                  />
                  <Field
                    label="Inventory Control URL"
                    value={inventoryControlUrl}
                    onChangeText={setInventoryControlUrl}
                  />
                  <Field
                    label="Procurement Planner URL"
                    value={procurementPlannerUrl}
                    onChangeText={setProcurementPlannerUrl}
                  />
                  <Field
                    label="Dispatch Optimizer URL"
                    value={dispatchOptimizerUrl}
                    onChangeText={setDispatchOptimizerUrl}
                  />
                </View>

                <ToggleRow
                  label="Local notifications"
                  value={settings.enableNotifications}
                  onValueChange={(value) =>
                    void saveSettings({ enableNotifications: value })
                  }
                />
                <ToggleRow
                  label="Auto-sync on cellular"
                  value={settings.autoSyncOnCellular}
                  onValueChange={(value) =>
                    void saveSettings({ autoSyncOnCellular: value })
                  }
                />

                <Pressable
                  onPress={() =>
                    void saveSettings({
                      operatorName,
                      region,
                      platformBaseUrl,
                      localCommerceGatewayUrl,
                      inventoryControlUrl,
                      procurementPlannerUrl,
                      dispatchOptimizerUrl,
                    })
                  }
                  className="rounded-full bg-primary px-4 py-3"
                >
                  <Text className="text-center text-xs font-semibold text-white">
                    Save local settings
                  </Text>
                </Pressable>
              </SectionCard>

              <View>
                <Text className="text-lg font-semibold text-foreground">
                  Operational outbox
                </Text>
                <Text className="mt-1 text-sm text-muted">
                  These actions are stored locally first, then replayed in
                  priority order when sync conditions improve.
                </Text>
              </View>
            </View>
          }
          renderItem={({ item }) => (
            <View className="gap-3 rounded-[24px] border border-border bg-surface px-4 py-4">
              <OutboxItemRow item={item} />
              <View className="flex-row flex-wrap gap-2">
                {priorityOptions.map((priority) => (
                  <Pressable
                    key={priority}
                    onPress={() => void setOutboxPriority(item.id, priority)}
                    className={
                      item.priority === priority
                        ? "rounded-full bg-primary px-3 py-2"
                        : "rounded-full bg-background px-3 py-2"
                    }
                  >
                    <Text
                      className={
                        item.priority === priority
                          ? "text-[11px] font-semibold text-white"
                          : "text-[11px] font-semibold text-foreground"
                      }
                    >
                      {priority}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <View className="rounded-[18px] border border-border bg-background/70 px-4 py-3">
                <Text className="text-xs uppercase tracking-wide text-muted">
                  Retry metadata
                </Text>
                <Text className="mt-2 text-sm text-foreground">
                  Attempts: {item.retryCount ?? 0}
                </Text>
                <Text className="mt-1 text-sm text-muted">
                  Next retry:{" "}
                  {item.nextRetryAt
                    ? new Date(item.nextRetryAt).toLocaleString()
                    : "Not scheduled"}
                </Text>
                <Text className="mt-1 text-sm text-muted">
                  Priority: {item.priority ?? "normal"}
                </Text>
                {item.conflictDetected ? (
                  <Text className="mt-1 text-sm font-semibold text-warning">
                    Conflict detected — review before retrying.
                  </Text>
                ) : null}
              </View>
              {item.conflictDetected ? (
                <View className="rounded-[18px] border border-warning/40 bg-warning/10 px-4 py-3">
                  <Text className="text-sm font-semibold text-warning">
                    Conflict resolution
                  </Text>
                  <Text className="mt-2 text-sm leading-6 text-muted">
                    This queued action no longer matches the latest live record.
                    Choose whether to retry urgently, downgrade and defer, or
                    keep it parked until the operator reviews the target record
                    again.
                  </Text>
                  <View className="mt-3 flex-row flex-wrap gap-2">
                    <Pressable
                      onPress={() => void setOutboxPriority(item.id, "urgent")}
                      className="rounded-full bg-primary px-3 py-2"
                    >
                      <Text className="text-[11px] font-semibold text-white">
                        Retry urgently
                      </Text>
                    </Pressable>
                    <Pressable
                      onPress={() => void setOutboxPriority(item.id, "low")}
                      className="rounded-full bg-background px-3 py-2"
                    >
                      <Text className="text-[11px] font-semibold text-foreground">
                        Defer conflict
                      </Text>
                    </Pressable>
                  </View>
                </View>
              ) : null}
            </View>
          )}
          ListEmptyComponent={
            <EmptyState
              title="Outbox is clear"
              body="Once you queue an action from any workflow, it will appear here until the device successfully syncs it."
            />
          }
          ListFooterComponent={
            <View className="mt-4 gap-3">
              <Text className="text-lg font-semibold text-foreground">
                Alerts
              </Text>
              {snapshot.alerts.length > 0 ? (
                snapshot.alerts.map((alert) => (
                  <AlertRow key={alert.id} alert={alert} />
                ))
              ) : (
                <EmptyState
                  title="No active alerts"
                  body="Service issues, offline queue notices, and other operational warnings will appear here automatically."
                />
              )}
            </View>
          }
        />
      </ScreenContainer>
    </NativeAdminRouteGuard>
  );
}

function Field({
  label,
  value,
  onChangeText,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
}) {
  return (
    <View>
      <Text className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
        {label}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        autoCapitalize="none"
        placeholder={label}
        placeholderTextColor="#6B7F97"
        className="rounded-2xl border border-border bg-background px-4 py-3 text-sm text-foreground"
      />
    </View>
  );
}

function WizardRow({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row items-center justify-between gap-3">
      <Text className="text-sm font-semibold text-foreground">{label}</Text>
      <Text className="text-sm text-muted">{value}</Text>
    </View>
  );
}

function ToggleRow({
  label,
  value,
  onValueChange,
}: {
  label: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
}) {
  const colors = useColors();

  return (
    <View className="flex-row items-center justify-between rounded-2xl bg-background/70 px-4 py-3">
      <Text className="text-sm font-semibold text-foreground">{label}</Text>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: colors.border, true: colors.primary }}
        thumbColor="#FFFFFF"
      />
    </View>
  );
}
