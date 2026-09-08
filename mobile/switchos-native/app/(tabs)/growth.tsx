import { useMemo, useState } from "react";
import {
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";

import {
  ConfirmationModal,
  DetailSheet,
  EmptyState,
  LoadingSkeleton,
  MetricPill,
  RiskBadge,
  SectionCard,
} from "@/components/mobile/operations-ui";
import { NativeAdminRouteGuard } from "@/components/mobile/native-admin-route-guard";
import { PhotoAnnotationSheet } from "@/components/mobile/photo-annotation-sheet";
import { ScreenContainer } from "@/components/screen-container";
import { useMobileApp } from "@/lib/mobile/provider";
import type {
  AttachmentDraft,
  LoyaltySignal,
  MerchantSignal,
  RiskLevel,
} from "@/lib/mobile/types";
import { pickPhotoAttachment } from "@/lib/mobile/attachments";
import {
  applyLoyaltyFilters,
  applyMerchantFilters,
  formatFreshness,
  isFreshnessStale,
  renderQuickActionText,
} from "@/lib/mobile/workspace";

type GrowthActionTarget =
  | { type: "merchant_campaign"; merchant: MerchantSignal }
  | { type: "loyalty_intervention"; loyalty: LoyaltySignal };

const riskOptions: (RiskLevel | "all")[] = [
  "all",
  "critical",
  "watch",
  "stable",
];
const sortOptions = [
  { value: "risk_desc", label: "Risk" },
  { value: "freshness_desc", label: "Freshness" },
  { value: "name_asc", label: "Name" },
] as const;

export default function GrowthScreen() {
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
  const [selectedMerchant, setSelectedMerchant] =
    useState<MerchantSignal | null>(null);
  const [selectedLoyalty, setSelectedLoyalty] = useState<LoyaltySignal | null>(
    null,
  );
  const [pendingAction, setPendingAction] = useState<GrowthActionTarget | null>(
    null,
  );
  const [selectedMerchantIds, setSelectedMerchantIds] = useState<string[]>([]);
  const [noteText, setNoteText] = useState("");
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);
  const [annotationAttachment, setAnnotationAttachment] =
    useState<AttachmentDraft | null>(null);

  const merchantFilters = activeFilters.merchant;
  const loyaltyFilters = activeFilters.loyalty;
  const filteredMerchants = useMemo(
    () => applyMerchantFilters(snapshot.merchants, merchantFilters),
    [snapshot.merchants, merchantFilters],
  );
  const filteredLoyalty = useMemo(
    () => applyLoyaltyFilters(snapshot.loyalty, loyaltyFilters),
    [snapshot.loyalty, loyaltyFilters],
  );
  const criticalMerchantSignals = useMemo(
    () =>
      snapshot.merchants.filter((item) => item.benchmarkStatus === "critical")
        .length,
    [snapshot.merchants],
  );
  const pinnedMerchants = useMemo(
    () => snapshot.merchants.filter((item) => item.pinned).length,
    [snapshot.merchants],
  );
  const latestDraft = useMemo(
    () =>
      noteDrafts.find(
        (draft) => draft.domain === "merchant" || draft.domain === "loyalty",
      ) ?? null,
    [noteDrafts],
  );
  const linkedLoyaltySignal = useMemo(
    () =>
      filteredLoyalty.find(
        (item) => item.status === selectedMerchant?.benchmarkStatus,
      ) ??
      filteredLoyalty[0] ??
      snapshot.loyalty[0] ??
      null,
    [filteredLoyalty, selectedMerchant, snapshot.loyalty],
  );
  const merchantPreset = quickActionPresets.find(
    (preset) => preset.id === "merchant-campaign",
  );
  const loyaltyPreset = quickActionPresets.find(
    (preset) => preset.id === "loyalty-intervention",
  );

  const queueConfirmedGrowthAction = async () => {
    if (!pendingAction) {
      return;
    }

    if (pendingAction.type === "merchant_campaign") {
      await queueAction("merchant_campaign", {
        title: `Campaign action for ${pendingAction.merchant.merchantName}`,
        targetId: pendingAction.merchant.id,
        note:
          noteText ||
          pendingAction.merchant.nextAction ||
          "Merchant campaign review from growth console.",
        metadata: {
          readiness: pendingAction.merchant.campaignReadiness ?? "unknown",
          benchmarkStatus: pendingAction.merchant.benchmarkStatus,
        },
        priority:
          pendingAction.merchant.benchmarkStatus === "critical"
            ? "high"
            : "normal",
        attachments,
      });
    } else {
      await queueAction("loyalty_intervention", {
        title: `Loyalty intervention for ${pendingAction.loyalty.customerLabel}`,
        targetId: pendingAction.loyalty.id,
        note:
          noteText ||
          pendingAction.loyalty.recommendedAction ||
          "Retention safeguard from growth console.",
        metadata: {
          status: pendingAction.loyalty.status,
          lastTouchpoint: pendingAction.loyalty.lastTouchpoint ?? "unknown",
        },
        priority:
          pendingAction.loyalty.status === "critical" ? "high" : "normal",
        attachments,
      });
    }

    setPendingAction(null);
    setSelectedMerchant(null);
    setSelectedLoyalty(null);
    setNoteText("");
    setAttachments([]);
  };

  const saveDraft = async () => {
    await saveNoteDraft({
      id: selectedMerchant?.id ?? selectedLoyalty?.id ?? "growth-general-draft",
      title: selectedMerchant
        ? `Draft for ${selectedMerchant.merchantName}`
        : selectedLoyalty
          ? `Draft for ${selectedLoyalty.customerLabel}`
          : "Growth draft",
      body: noteText,
      targetId: selectedMerchant?.id ?? selectedLoyalty?.id,
      domain: selectedLoyalty ? "loyalty" : "merchant",
      updatedAt: new Date().toISOString(),
      attachments,
    });
  };

  const toggleMerchantSelection = (merchantId: string) => {
    setSelectedMerchantIds((current) =>
      current.includes(merchantId)
        ? current.filter((id) => id !== merchantId)
        : [...current, merchantId],
    );
  };

  const queueBulkMerchantCampaign = async () => {
    const targets = filteredMerchants.filter((merchant) =>
      selectedMerchantIds.includes(merchant.id),
    );
    for (const merchant of targets) {
      await queueAction("merchant_campaign", {
        title: `Campaign action for ${merchant.merchantName}`,
        targetId: merchant.id,
        note:
          noteText ||
          merchant.nextAction ||
          "Bulk campaign action from growth console.",
        metadata: {
          readiness: merchant.campaignReadiness ?? "unknown",
          benchmarkStatus: merchant.benchmarkStatus,
        },
        priority: merchant.benchmarkStatus === "critical" ? "high" : "normal",
        attachments,
      });
    }
    setSelectedMerchantIds([]);
    setNoteText("");
    setAttachments([]);
  };

  return (
    <NativeAdminRouteGuard>
      <ScreenContainer className="px-4 pb-6">
        <FlatList
          data={filteredMerchants}
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
                  Growth Console
                </Text>
                <Text className="mt-2 text-sm leading-6 text-muted">
                  Coordinate merchant growth actions and loyalty safeguards with
                  faster search, pinning, quick actions, and reusable operator
                  notes.
                </Text>
              </View>

              <SectionCard
                title="Merchant and loyalty posture"
                subtitle="Campaign readiness, retention risk, and pinned follow-ups are grouped into one mobile-friendly command layer."
              >
                <View className="flex-row flex-wrap gap-3">
                  <MetricPill
                    label="Merchant signals"
                    value={snapshot.merchants.length}
                  />
                  <MetricPill
                    label="Critical merchants"
                    value={criticalMerchantSignals}
                  />
                  <MetricPill
                    label="Pinned merchants"
                    value={pinnedMerchants}
                  />
                </View>
              </SectionCard>

              <SectionCard
                title="Search and filter"
                subtitle="Refine merchant visibility by query, risk level, pinned state, and sort order."
              >
                <TextInput
                  value={merchantFilters.query}
                  onChangeText={(value) =>
                    void updateFilter("merchant", { query: value })
                  }
                  placeholder="Search merchant, readiness, or next action"
                  placeholderTextColor="#6B7F97"
                  className="rounded-[20px] border border-border bg-background px-4 py-3 text-sm text-foreground"
                />
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ gap: 8 }}
                >
                  {riskOptions.map((risk) => (
                    <Pressable
                      key={risk}
                      onPress={() => void updateFilter("merchant", { risk })}
                      className={
                        merchantFilters.risk === risk
                          ? "rounded-full bg-accent2 px-4 py-2"
                          : "rounded-full bg-background px-4 py-2"
                      }
                    >
                      <Text
                        className={
                          merchantFilters.risk === risk
                            ? "text-xs font-semibold text-white"
                            : "text-xs font-semibold text-foreground"
                        }
                      >
                        {risk}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ gap: 8 }}
                >
                  {sortOptions.map((option) => (
                    <Pressable
                      key={option.value}
                      onPress={() =>
                        void updateFilter("merchant", { sortBy: option.value })
                      }
                      className={
                        merchantFilters.sortBy === option.value
                          ? "rounded-full bg-primary px-4 py-2"
                          : "rounded-full bg-background px-4 py-2"
                      }
                    >
                      <Text
                        className={
                          merchantFilters.sortBy === option.value
                            ? "text-xs font-semibold text-white"
                            : "text-xs font-semibold text-foreground"
                        }
                      >
                        {option.label}
                      </Text>
                    </Pressable>
                  ))}
                  <Pressable
                    onPress={() =>
                      void updateFilter("merchant", {
                        pinnedOnly: !merchantFilters.pinnedOnly,
                      })
                    }
                    className={
                      merchantFilters.pinnedOnly
                        ? "rounded-full bg-warning px-4 py-2"
                        : "rounded-full bg-background px-4 py-2"
                    }
                  >
                    <Text
                      className={
                        merchantFilters.pinnedOnly
                          ? "text-xs font-semibold text-white"
                          : "text-xs font-semibold text-foreground"
                      }
                    >
                      Pinned only
                    </Text>
                  </Pressable>
                </ScrollView>
              </SectionCard>

              <SectionCard
                title="Quick growth actions"
                subtitle="Use context-aware defaults to queue campaign or loyalty work with less typing."
              >
                {latestDraft ? (
                  <View className="rounded-[20px] border border-border bg-background/70 px-4 py-3">
                    <Text className="text-xs uppercase tracking-[1px] text-muted">
                      Latest saved draft
                    </Text>
                    <Text className="mt-2 text-sm font-semibold text-foreground">
                      {latestDraft.title}
                    </Text>
                    <Text className="mt-1 text-sm leading-6 text-muted">
                      {latestDraft.body || "Draft is empty."}
                    </Text>
                  </View>
                ) : null}
                <TextInput
                  value={noteText}
                  onChangeText={setNoteText}
                  placeholder="Add an operator note for campaign or loyalty follow-up"
                  placeholderTextColor="#6B7F97"
                  multiline
                  className="min-h-[96px] rounded-[20px] border border-border bg-background px-4 py-3 text-sm text-foreground"
                />
                <View className="flex-row flex-wrap gap-3">
                  <Pressable
                    onPress={() => {
                      const merchant =
                        filteredMerchants[0] ?? snapshot.merchants[0];
                      if (merchant && merchantPreset) {
                        const rendered = renderQuickActionText(
                          merchantPreset,
                          merchant.merchantName,
                        );
                        setNoteText((current) => current || rendered.note);
                        setPendingAction({
                          type: "merchant_campaign",
                          merchant,
                        });
                      }
                    }}
                    className="rounded-full bg-primary px-4 py-3"
                  >
                    <Text className="text-xs font-semibold text-white">
                      Quick campaign
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => {
                      const loyalty = filteredLoyalty[0] ?? snapshot.loyalty[0];
                      if (loyalty && loyaltyPreset) {
                        const rendered = renderQuickActionText(
                          loyaltyPreset,
                          loyalty.customerLabel,
                        );
                        setNoteText((current) => current || rendered.note);
                        setPendingAction({
                          type: "loyalty_intervention",
                          loyalty,
                        });
                      }
                    }}
                    className="rounded-full bg-accent2 px-4 py-3"
                  >
                    <Text className="text-xs font-semibold text-white">
                      Quick loyalty
                    </Text>
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
                    <Text className="text-xs font-semibold text-foreground">
                      Attach photo
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => void saveDraft()}
                    className="rounded-full bg-background px-4 py-3"
                  >
                    <Text className="text-xs font-semibold text-foreground">
                      Save draft
                    </Text>
                  </Pressable>
                </View>
                {attachments.length > 0 ? (
                  <View className="rounded-[20px] border border-border bg-background/70 px-4 py-3">
                    <Text className="text-xs uppercase tracking-[1px] text-muted">
                      Attached photos
                    </Text>
                    {attachments.map((attachment) => (
                      <Pressable
                        key={attachment.id}
                        onPress={() => setAnnotationAttachment(attachment)}
                        className="mt-2 rounded-[16px] bg-surface px-3 py-2"
                      >
                        <Text className="text-sm font-semibold text-foreground">
                          {attachment.name}
                        </Text>
                        <Text className="mt-1 text-xs text-muted">
                          {attachment.annotations?.annotatedAt
                            ? "Annotated evidence saved"
                            : "Tap to add drawing or text notes"}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                ) : null}
              </SectionCard>

              {selectedMerchantIds.length > 0 ? (
                <SectionCard
                  title="Bulk merchant actions"
                  subtitle="Apply the same campaign intent to several selected merchants in one operator pass."
                >
                  <Text className="text-sm leading-6 text-muted">
                    {selectedMerchantIds.length} merchant records selected for
                    batch action.
                  </Text>
                  <View className="flex-row flex-wrap gap-3">
                    <Pressable
                      onPress={() => void queueBulkMerchantCampaign()}
                      className="rounded-full bg-primary px-4 py-3"
                    >
                      <Text className="text-xs font-semibold text-white">
                        Queue bulk campaign
                      </Text>
                    </Pressable>
                    <Pressable
                      onPress={() => setSelectedMerchantIds([])}
                      className="rounded-full bg-background px-4 py-3"
                    >
                      <Text className="text-xs font-semibold text-foreground">
                        Clear selection
                      </Text>
                    </Pressable>
                  </View>
                </SectionCard>
              ) : null}
            </View>
          }
          renderItem={({ item }) => (
            <View className="rounded-[28px] border border-border bg-surface px-4 py-4">
              <View className="flex-row items-start justify-between gap-3">
                <Pressable
                  onPress={() => setSelectedMerchant(item)}
                  className="flex-1"
                >
                  <Text className="text-[11px] font-semibold uppercase tracking-[1.2px] text-accent2">
                    Merchant signal
                  </Text>
                  <Text className="mt-2 text-lg font-semibold leading-6 text-foreground">
                    {item.merchantName}
                  </Text>
                  <Text className="mt-2 text-sm leading-6 text-muted">
                    {item.campaignReadiness ||
                      "Campaign readiness unavailable until the next sync."}
                  </Text>
                </Pressable>
                <View className="items-end gap-2">
                  <RiskBadge level={item.benchmarkStatus} />
                  <Pressable
                    onPress={() => void togglePinnedRecord("merchant", item.id)}
                    className={
                      item.pinned
                        ? "rounded-full bg-warning px-3 py-1.5"
                        : "rounded-full bg-background px-3 py-1.5"
                    }
                  >
                    <Text
                      className={
                        item.pinned
                          ? "text-[11px] font-semibold text-white"
                          : "text-[11px] font-semibold text-foreground"
                      }
                    >
                      {item.pinned ? "Pinned" : "Pin"}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => toggleMerchantSelection(item.id)}
                    className={
                      selectedMerchantIds.includes(item.id)
                        ? "rounded-full bg-primary px-3 py-1.5"
                        : "rounded-full bg-background px-3 py-1.5"
                    }
                  >
                    <Text
                      className={
                        selectedMerchantIds.includes(item.id)
                          ? "text-[11px] font-semibold text-white"
                          : "text-[11px] font-semibold text-foreground"
                      }
                    >
                      {selectedMerchantIds.includes(item.id)
                        ? "Selected"
                        : "Select"}
                    </Text>
                  </Pressable>
                </View>
              </View>
              <View className="mt-4 rounded-[18px] border border-border bg-background/60 px-4 py-3">
                <Text className="text-xs uppercase tracking-[1px] text-muted">
                  Recommended action
                </Text>
                <Text className="mt-2 text-sm font-semibold text-foreground">
                  {item.nextAction || "Awaiting sync"}
                </Text>
              </View>
              <View
                className={
                  isFreshnessStale(item.freshnessMinutes)
                    ? "mt-4 rounded-[18px] border border-warning/40 bg-warning/10 px-4 py-3"
                    : "mt-4 rounded-[18px] border border-border bg-background/60 px-4 py-3"
                }
              >
                <Text className="text-xs uppercase tracking-[1px] text-muted">
                  Freshness
                </Text>
                <Text className="mt-2 text-sm font-semibold text-foreground">
                  {formatFreshness(item.freshnessMinutes)}
                </Text>
              </View>
            </View>
          )}
          ListEmptyComponent={
            syncing &&
            !snapshot.merchants.length &&
            !snapshot.loyalty.length ? (
              <LoadingSkeleton rows={5} />
            ) : (
              <EmptyState
                title="No merchant signals match the current filter"
                body="Widen the search or risk filter, or sync a fresh platform snapshot to repopulate growth data."
              />
            )
          }
          ListFooterComponent={
            filteredLoyalty.length > 0 ? (
              <View className="mt-4 gap-3">
                <Text className="text-lg font-semibold text-foreground">
                  Loyalty interventions
                </Text>
                <SectionCard
                  title="Loyalty list filters"
                  subtitle="Review retention entries with their own search and pinned controls."
                >
                  <TextInput
                    value={loyaltyFilters.query}
                    onChangeText={(value) =>
                      void updateFilter("loyalty", { query: value })
                    }
                    placeholder="Search customer or recommended action"
                    placeholderTextColor="#6B7F97"
                    className="rounded-[20px] border border-border bg-background px-4 py-3 text-sm text-foreground"
                  />
                  <View className="flex-row flex-wrap gap-3">
                    <Pressable
                      onPress={() =>
                        void updateFilter("loyalty", {
                          pinnedOnly: !loyaltyFilters.pinnedOnly,
                        })
                      }
                      className={
                        loyaltyFilters.pinnedOnly
                          ? "rounded-full bg-warning px-4 py-2"
                          : "rounded-full bg-background px-4 py-2"
                      }
                    >
                      <Text
                        className={
                          loyaltyFilters.pinnedOnly
                            ? "text-xs font-semibold text-white"
                            : "text-xs font-semibold text-foreground"
                        }
                      >
                        Pinned only
                      </Text>
                    </Pressable>
                    <Pressable
                      onPress={() =>
                        void updateFilter("loyalty", {
                          sortBy:
                            loyaltyFilters.sortBy === "freshness_desc"
                              ? "risk_desc"
                              : "freshness_desc",
                        })
                      }
                      className="rounded-full bg-background px-4 py-2"
                    >
                      <Text className="text-xs font-semibold text-foreground">
                        {loyaltyFilters.sortBy === "freshness_desc"
                          ? "Sort: freshness"
                          : "Sort: risk"}
                      </Text>
                    </Pressable>
                  </View>
                </SectionCard>
                {filteredLoyalty.map((entry) => (
                  <Pressable
                    key={entry.id}
                    onPress={() => setSelectedLoyalty(entry)}
                    className="rounded-[24px] border border-border bg-surface px-4 py-4"
                  >
                    <View className="flex-row items-start justify-between gap-3">
                      <View className="flex-1">
                        <Text className="text-sm font-semibold text-foreground">
                          {entry.customerLabel}
                        </Text>
                        <Text className="mt-1 text-xs leading-5 text-muted">
                          {entry.lastTouchpoint ||
                            "No recent touchpoint recorded."}
                        </Text>
                      </View>
                      <View className="items-end gap-2">
                        <RiskBadge level={entry.status} />
                        <Pressable
                          onPress={() =>
                            void togglePinnedRecord("loyalty", entry.id)
                          }
                          className={
                            entry.pinned
                              ? "rounded-full bg-warning px-3 py-1.5"
                              : "rounded-full bg-background px-3 py-1.5"
                          }
                        >
                          <Text
                            className={
                              entry.pinned
                                ? "text-[11px] font-semibold text-white"
                                : "text-[11px] font-semibold text-foreground"
                            }
                          >
                            {entry.pinned ? "Pinned" : "Pin"}
                          </Text>
                        </Pressable>
                      </View>
                    </View>
                    <Text className="mt-3 text-sm leading-6 text-muted">
                      {entry.recommendedAction ||
                        "Awaiting live loyalty guidance."}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null
          }
        />

        <DetailSheet
          visible={Boolean(selectedMerchant)}
          title={selectedMerchant?.merchantName ?? "Merchant detail"}
          subtitle="Merchant growth detail"
          risk={selectedMerchant?.benchmarkStatus ?? "watch"}
          stateLabel={
            connectivityMode === "online"
              ? "Ready for live merchant sync"
              : "Action can be queued locally"
          }
          summary={
            selectedMerchant?.nextAction ||
            "Review readiness, benchmark status, and retention posture before launching a merchant campaign or loyalty response."
          }
          metrics={[
            {
              label: "Benchmark",
              value: selectedMerchant?.benchmarkStatus ?? "Unknown",
              tone:
                selectedMerchant?.benchmarkStatus === "critical"
                  ? "error"
                  : selectedMerchant?.benchmarkStatus === "watch"
                    ? "warning"
                    : "success",
            },
            {
              label: "Readiness",
              value: selectedMerchant?.campaignReadiness ?? "Awaiting sync",
              tone: "accent",
            },
            {
              label: "Freshness",
              value: formatFreshness(selectedMerchant?.freshnessMinutes),
              tone: isFreshnessStale(selectedMerchant?.freshnessMinutes)
                ? "warning"
                : "accent",
            },
          ]}
          notes={
            selectedMerchant
              ? [
                  selectedMerchant.nextAction ||
                    "No operator guidance has been synced yet.",
                  linkedLoyaltySignal
                    ? `Related loyalty signal: ${linkedLoyaltySignal.customerLabel} — ${linkedLoyaltySignal.recommendedAction ?? "review retention posture"}.`
                    : "No loyalty linkage has been cached yet.",
                  `Offline behavior: ${connectivityMode === "online" ? "campaign or intervention can sync immediately" : "campaign or intervention will remain queued on device"}.`,
                ]
              : []
          }
          actions={[
            {
              label: "Confirm merchant campaign",
              tone: "primary",
              onPress: () => {
                if (selectedMerchant) {
                  setPendingAction({
                    type: "merchant_campaign",
                    merchant: selectedMerchant,
                  });
                }
              },
            },
            linkedLoyaltySignal
              ? {
                  label: "Queue loyalty safeguard",
                  tone: "secondary" as const,
                  onPress: () =>
                    setPendingAction({
                      type: "loyalty_intervention",
                      loyalty: linkedLoyaltySignal,
                    }),
                }
              : {
                  label: "Close sheet",
                  tone: "secondary" as const,
                  onPress: () => setSelectedMerchant(null),
                },
            {
              label: selectedMerchant?.pinned
                ? "Unpin merchant"
                : "Pin merchant",
              tone: "secondary",
              onPress: () => {
                if (selectedMerchant) {
                  void togglePinnedRecord("merchant", selectedMerchant.id);
                  setSelectedMerchant({
                    ...selectedMerchant,
                    pinned: !selectedMerchant.pinned,
                  });
                }
              },
            },
          ]}
          onClose={() => setSelectedMerchant(null)}
        />

        <DetailSheet
          visible={Boolean(selectedLoyalty)}
          title={selectedLoyalty?.customerLabel ?? "Loyalty detail"}
          subtitle="Retention safeguard detail"
          risk={selectedLoyalty?.status ?? "watch"}
          stateLabel={
            connectivityMode === "online"
              ? "Ready for live loyalty sync"
              : "Intervention can be queued locally"
          }
          summary={
            selectedLoyalty?.recommendedAction ||
            "Review the retention posture and last touchpoint before confirming a loyalty intervention."
          }
          metrics={[
            {
              label: "Status",
              value: selectedLoyalty?.status ?? "Unknown",
              tone:
                selectedLoyalty?.status === "critical"
                  ? "error"
                  : selectedLoyalty?.status === "watch"
                    ? "warning"
                    : "success",
            },
            {
              label: "Last touchpoint",
              value: selectedLoyalty?.lastTouchpoint ?? "Unknown",
              tone: "accent",
            },
            {
              label: "Freshness",
              value: formatFreshness(selectedLoyalty?.freshnessMinutes),
              tone: isFreshnessStale(selectedLoyalty?.freshnessMinutes)
                ? "warning"
                : "accent",
            },
          ]}
          notes={
            selectedLoyalty
              ? [
                  selectedLoyalty.recommendedAction ||
                    "No intervention guidance has been synced yet.",
                  `Customer state can be queued safely while offline and replayed after reconnection.`,
                ]
              : []
          }
          actions={[
            {
              label: "Confirm loyalty intervention",
              tone: "primary",
              onPress: () => {
                if (selectedLoyalty) {
                  setPendingAction({
                    type: "loyalty_intervention",
                    loyalty: selectedLoyalty,
                  });
                }
              },
            },
            {
              label: selectedLoyalty?.pinned ? "Unpin loyalty" : "Pin loyalty",
              tone: "secondary",
              onPress: () => {
                if (selectedLoyalty) {
                  void togglePinnedRecord("loyalty", selectedLoyalty.id);
                  setSelectedLoyalty({
                    ...selectedLoyalty,
                    pinned: !selectedLoyalty.pinned,
                  });
                }
              },
            },
            {
              label: "Close sheet",
              tone: "secondary",
              onPress: () => setSelectedLoyalty(null),
            },
          ]}
          onClose={() => setSelectedLoyalty(null)}
        />

        <PhotoAnnotationSheet
          visible={Boolean(annotationAttachment)}
          attachment={annotationAttachment}
          onClose={() => setAnnotationAttachment(null)}
          onSave={(attachment) => {
            setAttachments((current) =>
              current.map((item) =>
                item.id === attachment.id ? attachment : item,
              ),
            );
            setAnnotationAttachment(null);
          }}
        />

        <ConfirmationModal
          visible={Boolean(pendingAction)}
          title={
            pendingAction?.type === "merchant_campaign"
              ? "Confirm merchant campaign"
              : "Confirm loyalty intervention"
          }
          body={
            pendingAction?.type === "merchant_campaign"
              ? `Queue a merchant growth action for ${pendingAction.merchant.merchantName}. The app will preserve the action locally if connectivity drops before the backend acknowledges it.`
              : `Queue a loyalty safeguard for ${pendingAction?.loyalty.customerLabel ?? "this customer"}. This keeps retention intent durable even when field connectivity is unstable.`
          }
          confirmLabel={
            pendingAction?.type === "merchant_campaign"
              ? "Queue campaign"
              : "Queue intervention"
          }
          onConfirm={() => void queueConfirmedGrowthAction()}
          onCancel={() => setPendingAction(null)}
        />
      </ScreenContainer>
    </NativeAdminRouteGuard>
  );
}
