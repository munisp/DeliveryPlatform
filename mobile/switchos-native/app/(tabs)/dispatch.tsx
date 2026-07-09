import { useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, ScrollView, Text, TextInput, View } from "react-native";

import {
  ConfirmationModal,
  DetailSheet,
  EmptyState,
  LoadingSkeleton,
  MetricPill,
  RiskBadge,
  SectionCard,
} from "@/components/mobile/operations-ui";
import { PhotoAnnotationSheet } from "@/components/mobile/photo-annotation-sheet";
import { SmartSearchPanel } from "@/components/mobile/smart-search-panel";
import { ScreenContainer } from "@/components/screen-container";
import { pickPhotoAttachment } from "@/lib/mobile/attachments";
import { useMobileApp } from "@/lib/mobile/provider";
import type { AttachmentDraft, DispatchZone, RiskLevel, SmartSearchResult } from "@/lib/mobile/types";
import { applyDispatchFilters, formatFreshness, isFreshnessStale, renderQuickActionText } from "@/lib/mobile/workspace";

const riskOptions: Array<RiskLevel | "all"> = ["all", "critical", "watch", "stable"];
const sortOptions = [
  { value: "risk_desc", label: "Pressure" },
  { value: "freshness_desc", label: "Freshness" },
  { value: "name_asc", label: "Name" },
] as const;

export default function DispatchScreen() {
  const {
    snapshot,
    syncing,
    refreshSnapshot,
    queueAction,
    connectivityMode,
    activeFilters,
    updateFilter,
    togglePinnedRecord,
    saveNoteDraft,
    noteDrafts,
    quickActionPresets,
  } = useMobileApp();
  const [selectedZone, setSelectedZone] = useState<DispatchZone | null>(null);
  const [confirmVisible, setConfirmVisible] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);
  const [annotationAttachment, setAnnotationAttachment] = useState<AttachmentDraft | null>(null);

  const dispatchFilters = activeFilters.dispatch;
  const filteredZones = useMemo(() => applyDispatchFilters(snapshot.dispatch, dispatchFilters), [snapshot.dispatch, dispatchFilters]);
  const criticalZones = useMemo(() => snapshot.dispatch.filter((item) => item.pressure === "critical").length, [snapshot.dispatch]);
  const pinnedZones = useMemo(() => snapshot.dispatch.filter((item) => item.pinned).length, [snapshot.dispatch]);
  const latestDraft = useMemo(() => noteDrafts.find((draft) => draft.domain === "dispatch") ?? null, [noteDrafts]);
  const rebalancePreset = quickActionPresets.find((preset) => preset.id === "dispatch-rebalance");

  const confirmDispatchAction = async () => {
    if (!selectedZone) {
      return;
    }

    await queueAction("dispatch_rebalance", {
      title: `Dispatch rebalance for ${selectedZone.name}`,
      targetId: selectedZone.id,
      note: noteText || selectedZone.suggestedAction || "Manual rebalance from field operator.",
      metadata: {
        pressure: selectedZone.pressure,
        driverBalance: selectedZone.driverBalance ?? "unknown",
      },
      priority: selectedZone.pressure === "critical" ? "urgent" : "high",
      attachments,
    });

    setConfirmVisible(false);
    setSelectedZone(null);
    setNoteText("");
  };

  const saveDraft = async () => {
    await saveNoteDraft({
      id: selectedZone?.id ?? "dispatch-general-draft",
      title: selectedZone ? `Draft for ${selectedZone.name}` : "Dispatch draft",
      body: noteText,
      targetId: selectedZone?.id,
      domain: "dispatch",
      updatedAt: new Date().toISOString(),
      attachments,
    });
  };

  const handleSmartSearchSelection = (result: SmartSearchResult) => {
    const matchedZone = snapshot.dispatch.find((item) => item.id === result.recordId);
    if (matchedZone) {
      setSelectedZone(matchedZone);
    }
  };

  return (
    <ScreenContainer className="px-4 pb-6">
      <FlatList
        data={filteredZones}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={syncing} onRefresh={() => void refreshSnapshot()} />}
        contentContainerStyle={{ gap: 16, paddingTop: 20, paddingBottom: 24 }}
        ListHeaderComponent={
          <View className="gap-4">
            <View>
              <Text className="text-3xl font-bold text-foreground">Dispatch Resilience</Text>
              <Text className="mt-2 text-sm leading-6 text-muted">
                Review zone pressure, pin critical territories, and queue rebalancing instructions that survive connectivity gaps.
              </Text>
            </View>

            <SectionCard
              title="Field posture"
              subtitle="Priority pressure zones, queue exposure, and pinned dispatch watchlists are tuned for quick roadside review."
            >
              <View className="flex-row flex-wrap gap-3">
                <MetricPill label="Critical zones" value={criticalZones} />
                <MetricPill label="Pinned zones" value={pinnedZones} />
                <MetricPill label="Open alerts" value={snapshot.alerts.length} />
              </View>
            </SectionCard>

            <SectionCard
              title="Search and filter"
              subtitle="Refine the dispatch list by search term, pressure level, pinned state, and sort order."
            >
              <TextInput
                value={dispatchFilters.query}
                onChangeText={(value) => void updateFilter("dispatch", { query: value })}
                placeholder="Search zone, note, or suggested action"
                placeholderTextColor="#6B7F97"
                className="rounded-[20px] border border-border bg-background px-4 py-3 text-sm text-foreground"
              />
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
                {riskOptions.map((risk) => (
                  <Pressable
                    key={risk}
                    onPress={() => void updateFilter("dispatch", { risk })}
                    className={dispatchFilters.risk === risk ? "rounded-full bg-accent2 px-4 py-2" : "rounded-full bg-background px-4 py-2"}
                  >
                    <Text className={dispatchFilters.risk === risk ? "text-xs font-semibold text-white" : "text-xs font-semibold text-foreground"}>{risk}</Text>
                  </Pressable>
                ))}
              </ScrollView>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
                {sortOptions.map((option) => (
                  <Pressable
                    key={option.value}
                    onPress={() => void updateFilter("dispatch", { sortBy: option.value })}
                    className={dispatchFilters.sortBy === option.value ? "rounded-full bg-primary px-4 py-2" : "rounded-full bg-background px-4 py-2"}
                  >
                    <Text className={dispatchFilters.sortBy === option.value ? "text-xs font-semibold text-white" : "text-xs font-semibold text-foreground"}>{option.label}</Text>
                  </Pressable>
                ))}
                <Pressable
                  onPress={() => void updateFilter("dispatch", { pinnedOnly: !dispatchFilters.pinnedOnly })}
                  className={dispatchFilters.pinnedOnly ? "rounded-full bg-warning px-4 py-2" : "rounded-full bg-background px-4 py-2"}
                >
                  <Text className={dispatchFilters.pinnedOnly ? "text-xs font-semibold text-white" : "text-xs font-semibold text-foreground"}>Pinned only</Text>
                </Pressable>
              </ScrollView>
            </SectionCard>

            <SmartSearchPanel
              domain="dispatch"
              region={dispatchFilters.region === "all" ? undefined : dispatchFilters.region}
              onSelectResult={handleSmartSearchSelection}
            />

            <SectionCard
              title="Quick dispatch actions"
              subtitle="Use saved notes and context-aware defaults to queue field instructions faster."
            >
              {latestDraft ? (
                <View className="rounded-[20px] border border-border bg-background/70 px-4 py-3">
                  <Text className="text-xs uppercase tracking-[1px] text-muted">Latest saved draft</Text>
                  <Text className="mt-2 text-sm font-semibold text-foreground">{latestDraft.title}</Text>
                  <Text className="mt-1 text-sm leading-6 text-muted">{latestDraft.body || "Draft is empty."}</Text>
                </View>
              ) : null}
              <TextInput
                value={noteText}
                onChangeText={setNoteText}
                placeholder="Add roadside instruction or escalation note"
                placeholderTextColor="#6B7F97"
                multiline
                className="min-h-[96px] rounded-[20px] border border-border bg-background px-4 py-3 text-sm text-foreground"
              />
              <View className="flex-row flex-wrap gap-3">
                <Pressable
                  onPress={() => {
                    const fallbackZone = filteredZones[0] ?? snapshot.dispatch[0];
                    if (fallbackZone && rebalancePreset) {
                      const rendered = renderQuickActionText(rebalancePreset, fallbackZone.name);
                      setNoteText((current) => current || rendered.note);
                      setSelectedZone(fallbackZone);
                      setConfirmVisible(true);
                    }
                  }}
                  className="rounded-full bg-primary px-4 py-3"
                >
                  <Text className="text-xs font-semibold text-white">Quick rebalance</Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    const fallbackZone = filteredZones[0] ?? snapshot.dispatch[0];
                    if (fallbackZone) {
                      setSelectedZone({
                        ...fallbackZone,
                        suggestedAction: `Escalate ${fallbackZone.name} to senior dispatch coverage review.`,
                      });
                      setConfirmVisible(true);
                    }
                  }}
                  className="rounded-full bg-accent2 px-4 py-3"
                >
                  <Text className="text-xs font-semibold text-white">Quick escalation</Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    void (async () => {
                      const attachment = await pickPhotoAttachment();
                      if (attachment) {
                        setAttachments((current) => [...current, attachment]);
                        setAnnotationAttachment(attachment);
                      }
                    })();
                  }}
                  className="rounded-full bg-surface px-4 py-3"
                >
                  <Text className="text-xs font-semibold text-foreground">Attach photo</Text>
                </Pressable>
                <Pressable onPress={() => void saveDraft()} className="rounded-full bg-background px-4 py-3">
                  <Text className="text-xs font-semibold text-foreground">Save draft</Text>
                </Pressable>
              </View>
              {attachments.length > 0 ? (
                <View className="rounded-[20px] border border-border bg-background/70 px-4 py-3">
                  <Text className="text-xs uppercase tracking-[1px] text-muted">Attached photos</Text>
                  {attachments.map((attachment) => (
                    <Pressable key={attachment.id} onPress={() => setAnnotationAttachment(attachment)} className="mt-2 rounded-[16px] bg-surface px-3 py-2">
                      <Text className="text-sm font-semibold text-foreground">{attachment.name}</Text>
                      <Text className="mt-1 text-xs text-muted">{attachment.annotations?.annotatedAt ? "Annotated evidence saved" : "Tap to add drawing or text notes"}</Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}
            </SectionCard>
          </View>
        }
        renderItem={({ item }) => (
          <View className="rounded-[28px] border border-border bg-surface px-4 py-4">
            <View className="flex-row items-start justify-between gap-3">
              <Pressable onPress={() => setSelectedZone(item)} className="flex-1">
                <Text className="text-[11px] font-semibold uppercase tracking-[1.2px] text-accent2">Dispatch zone</Text>
                <Text className="mt-2 text-lg font-semibold leading-6 text-foreground">{item.name}</Text>
                <Text className="mt-2 text-sm leading-6 text-muted">{item.note || "Awaiting live zone telemetry from the dispatch optimizer."}</Text>
              </Pressable>
              <View className="items-end gap-2">
                <RiskBadge level={item.pressure} />
                <Pressable onPress={() => void togglePinnedRecord("dispatch", item.id)} className={item.pinned ? "rounded-full bg-warning px-3 py-1.5" : "rounded-full bg-background px-3 py-1.5"}>
                  <Text className={item.pinned ? "text-[11px] font-semibold text-white" : "text-[11px] font-semibold text-foreground"}>{item.pinned ? "Pinned" : "Pin"}</Text>
                </Pressable>
              </View>
            </View>
            <View className="mt-4 flex-row flex-wrap gap-3">
              <MetricPill label="Driver balance" value={item.driverBalance || "Unknown"} />
              <MetricPill label="Pressure" value={item.pressure} />
            </View>
            <View className={isFreshnessStale(item.freshnessMinutes) ? "mt-4 rounded-[18px] border border-warning/40 bg-warning/10 px-4 py-3" : "mt-4 rounded-[18px] border border-border bg-background/60 px-4 py-3"}>
              <Text className="text-xs uppercase tracking-[1px] text-muted">Freshness</Text>
              <Text className="mt-2 text-sm font-semibold text-foreground">{formatFreshness(item.freshnessMinutes)}</Text>
            </View>
            <View className="mt-4 flex-row flex-wrap gap-2">
              <Pressable
                onPress={() => {
                  setSelectedZone(item);
                  setConfirmVisible(true);
                }}
                className="rounded-full bg-primary px-3 py-2"
              >
                <Text className="text-[11px] font-semibold text-white">Queue</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  setSelectedZone({
                    ...item,
                    suggestedAction: `Escalate ${item.name} to senior dispatch coverage review.`,
                  });
                  setConfirmVisible(true);
                }}
                className="rounded-full bg-accent2 px-3 py-2"
              >
                <Text className="text-[11px] font-semibold text-white">Escalate</Text>
              </Pressable>
              <Pressable
                onPress={() => void togglePinnedRecord("dispatch", item.id)}
                className="rounded-full bg-background px-3 py-2"
              >
                <Text className="text-[11px] font-semibold text-foreground">{item.pinned ? "Unpin" : "Pin"}</Text>
              </Pressable>
            </View>
          </View>
        )}
        ListEmptyComponent={
          syncing && !snapshot.dispatch.length ? (
            <LoadingSkeleton rows={5} />
          ) : (
            <EmptyState
              title="No dispatch zones match the current filter"
              body="Once the dispatch optimizer endpoint is configured and refreshed, live zone pressure will appear here."
            />
          )
        }
      />

      <DetailSheet
        visible={Boolean(selectedZone) && !confirmVisible}
        title={selectedZone?.name ?? "Dispatch zone"}
        subtitle="Zone detail"
        risk={selectedZone?.pressure ?? "watch"}
        stateLabel={connectivityMode === "online" ? "Ready for live dispatch sync" : "Rebalance can be queued locally"}
        summary={selectedZone?.note || "Review the pressure profile, freshness, and suggested action before confirming a rebalance instruction."}
        metrics={[
          { label: "Pressure", value: selectedZone?.pressure ?? "Unknown", tone: selectedZone?.pressure === "critical" ? "error" : selectedZone?.pressure === "watch" ? "warning" : "success" },
          { label: "Driver balance", value: selectedZone?.driverBalance ?? "Unknown", tone: "accent" },
          { label: "Freshness", value: formatFreshness(selectedZone?.freshnessMinutes), tone: isFreshnessStale(selectedZone?.freshnessMinutes) ? "warning" : "accent" },
          { label: "Queue state", value: `${snapshot.summary.queueCount} pending`, tone: snapshot.summary.queueCount > 0 ? "warning" : "success" },
        ]}
        notes={selectedZone ? [
          selectedZone.suggestedAction || "No recommendation has been synced yet.",
          `Offline behavior: ${connectivityMode === "online" ? "send immediately when confirmed" : "store locally until the network is healthy"}.`,
        ] : []}
        actions={[
          {
            label: "Confirm zone rebalance",
            tone: "primary",
            onPress: () => setConfirmVisible(true),
          },
          {
            label: selectedZone?.pinned ? "Unpin zone" : "Pin zone",
            tone: "secondary",
            onPress: () => {
              if (selectedZone) {
                void togglePinnedRecord("dispatch", selectedZone.id);
                setSelectedZone({ ...selectedZone, pinned: !selectedZone.pinned });
              }
            },
          },
          {
            label: "Close sheet",
            tone: "secondary",
            onPress: () => setSelectedZone(null),
          },
        ]}
        onClose={() => setSelectedZone(null)}
      />

      <PhotoAnnotationSheet
        visible={Boolean(annotationAttachment)}
        attachment={annotationAttachment}
        onClose={() => setAnnotationAttachment(null)}
        onSave={(attachment) => {
          setAttachments((current) => current.map((item) => (item.id === attachment.id ? attachment : item)));
          setAnnotationAttachment(null);
        }}
      />

      <ConfirmationModal
        visible={confirmVisible}
        title="Confirm dispatch action"
        body={`Queue the current rebalance instruction for ${selectedZone?.name ?? "this zone"}. The app will keep the action durable on device if the optimizer cannot be reached.`}
        confirmLabel="Queue dispatch action"
        onConfirm={() => void confirmDispatchAction()}
        onCancel={() => setConfirmVisible(false)}
      />
    </ScreenContainer>
  );
}
