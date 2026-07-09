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
  ServiceHealthCard,
} from "@/components/mobile/operations-ui";
import { PhotoAnnotationSheet } from "@/components/mobile/photo-annotation-sheet";
import { SmartSearchPanel } from "@/components/mobile/smart-search-panel";
import { ScreenContainer } from "@/components/screen-container";
import { pickPhotoAttachment } from "@/lib/mobile/attachments";
import { useColors } from "@/hooks/use-colors";
import { useMobileApp } from "@/lib/mobile/provider";
import type { AttachmentDraft, InventoryNode, ProcurementProposal, RiskLevel, SmartSearchResult, WorkflowActionType } from "@/lib/mobile/types";
import {
  applyInventoryFilters,
  applyProcurementFilters,
  availableRegionsForDomain,
  formatFreshness,
  isFreshnessStale,
  renderQuickActionText,
} from "@/lib/mobile/workspace";

type LogisticsActionTarget =
  | { type: "inventory_audit"; node: InventoryNode }
  | { type: "replenishment"; proposal?: ProcurementProposal; node?: InventoryNode };

const riskOptions: Array<RiskLevel | "all"> = ["all", "critical", "watch", "stable"];
const sortOptions = [
  { value: "risk_desc", label: "Risk" },
  { value: "freshness_desc", label: "Freshness" },
  { value: "name_asc", label: "Name" },
  { value: "region_asc", label: "Region" },
] as const;

export default function LogisticsScreen() {
  const colors = useColors();
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

  const [selectedNode, setSelectedNode] = useState<InventoryNode | null>(null);
  const [selectedProposal, setSelectedProposal] = useState<ProcurementProposal | null>(null);
  const [pendingAction, setPendingAction] = useState<LogisticsActionTarget | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [noteText, setNoteText] = useState("");
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);
  const [annotationAttachment, setAnnotationAttachment] = useState<AttachmentDraft | null>(null);

  const inventoryFilters = activeFilters.inventory;
  const procurementFilters = activeFilters.procurement;
  const inventoryRegions = useMemo(() => availableRegionsForDomain("inventory", snapshot.inventory), [snapshot.inventory]);
  const filteredInventory = useMemo(() => applyInventoryFilters(snapshot.inventory, inventoryFilters), [snapshot.inventory, inventoryFilters]);
  const filteredProcurement = useMemo(() => applyProcurementFilters(snapshot.procurement, procurementFilters), [snapshot.procurement, procurementFilters]);
  const criticalNodes = useMemo(() => snapshot.inventory.filter((item) => item.risk === "critical").length, [snapshot.inventory]);
  const pinnedNodes = useMemo(() => snapshot.inventory.filter((item) => item.pinned).length, [snapshot.inventory]);
  const selectedProposalForNode = useMemo(
    () => snapshot.procurement.find((proposal) => proposal.nodeName === selectedNode?.name) ?? null,
    [selectedNode, snapshot.procurement],
  );
  const latestDraft = useMemo(() => noteDrafts.find((draft) => draft.domain === "inventory") ?? null, [noteDrafts]);
  const inventoryAuditPreset = quickActionPresets.find((preset) => preset.id === "inventory-audit");
  const replenishmentPreset = quickActionPresets.find((preset) => preset.id === "replenishment");

  const queueConfirmedAction = async () => {
    if (!pendingAction) {
      return;
    }

    if (pendingAction.type === "inventory_audit") {
      await queueAction("inventory_audit", {
        title: `Inventory audit for ${pendingAction.node.name}`,
        targetId: pendingAction.node.id,
        note: noteText || `Coverage ${pendingAction.node.stockCoverageHours ?? "unknown"}h. Confidence ${pendingAction.node.confidence}.`,
        metadata: {
          region: pendingAction.node.region,
          risk: pendingAction.node.risk,
        },
        priority: pendingAction.node.risk === "critical" ? "urgent" : "high",
        attachments,
      });
    } else {
      const proposal = pendingAction.proposal;
      const node = pendingAction.node;
      await queueAction("replenishment", {
        title: proposal ? `Replenishment for ${proposal.sku}` : `Replenishment for ${node?.name ?? "selected node"}`,
        targetId: proposal?.id ?? node?.id,
        note: noteText || (proposal
          ? `${proposal.action} ${proposal.recommendedUnits ?? 0} units via ${proposal.supplier ?? "assigned supplier"}.`
          : `Queue replenishment for ${node?.name ?? "selected node"} from logistics control.`),
        metadata: {
          urgency: proposal?.urgency ?? node?.risk ?? "watch",
          nodeName: proposal?.nodeName ?? node?.name ?? "unknown",
        },
        priority: proposal?.urgency === "critical" || node?.risk === "critical" ? "urgent" : "high",
        attachments,
      });
    }

    setPendingAction(null);
    setSelectedNode(null);
    setSelectedProposal(null);
    setNoteText("");
    setAttachments([]);
  };

  const queueBulkAudit = async () => {
    const targets = filteredInventory.filter((item) => selectedIds.includes(item.id));
    for (const node of targets) {
      await queueAction("inventory_audit", {
        title: `Inventory audit for ${node.name}`,
        targetId: node.id,
        note: noteText || `Bulk audit requested for ${node.region}.`,
        metadata: { region: node.region, risk: node.risk },
        priority: node.risk === "critical" ? "urgent" : "high",
        attachments,
      });
    }
    setSelectedIds([]);
    setNoteText("");
    setAttachments([]);
  };

  const persistDraft = async () => {
    await saveNoteDraft({
      id: selectedNode?.id ?? selectedProposal?.id ?? "inventory-general-draft",
      title: selectedNode ? `Draft for ${selectedNode.name}` : selectedProposal ? `Draft for ${selectedProposal.sku}` : "Inventory draft",
      body: noteText,
      targetId: selectedNode?.id ?? selectedProposal?.id,
      domain: selectedProposal ? "procurement" : "inventory",
      updatedAt: new Date().toISOString(),
      attachments,
    });
  };

  const toggleBulkSelection = (recordId: string) => {
    setSelectedIds((current) => current.includes(recordId) ? current.filter((id) => id !== recordId) : [...current, recordId]);
  };

  const selectedRecordCount = selectedIds.length;

  const handleSmartSearchSelection = (result: SmartSearchResult) => {
    const matchedNode = snapshot.inventory.find((item) => item.id === result.recordId);
    if (matchedNode) {
      setSelectedNode(matchedNode);
      setSelectedProposal(snapshot.procurement.find((proposal) => proposal.nodeName === matchedNode.name) ?? null);
    }
  };

  return (
    <ScreenContainer className="px-4 pb-6">
      <FlatList
        data={filteredInventory}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={syncing} onRefresh={() => void refreshSnapshot()} />}
        contentContainerStyle={{ gap: 16, paddingTop: 20, paddingBottom: 24 }}
        ListHeaderComponent={
          <View className="gap-4">
            <View>
              <Text className="text-3xl font-bold text-foreground">Logistics Control</Text>
              <Text className="mt-2 text-sm leading-6 text-muted">
                Search, pin, filter, and queue logistics work faster while keeping procurement and inventory actions safe under unstable connectivity.
              </Text>
            </View>

            <SectionCard
              title="Warehouse network"
              subtitle="Critical nodes, pinned watchlists, and live warehouse telemetry are grouped here for one-handed field review."
            >
              <View className="flex-row flex-wrap gap-3">
                <MetricPill label="Critical nodes" value={criticalNodes} />
                <MetricPill label="Pinned nodes" value={pinnedNodes} />
                <MetricPill label="Selected" value={selectedRecordCount} />
              </View>
              {snapshot.services.length > 0 ? (
                snapshot.services.slice(0, 2).map((service) => <ServiceHealthCard key={service.key} service={service} />)
              ) : (
                <EmptyState
                  title="No warehouse telemetry loaded"
                  body="Connect inventory and gateway endpoints in settings to surface live operational health here."
                />
              )}
            </SectionCard>

            <SectionCard
              title="Search and filter"
              subtitle="Refine the inventory list by search term, region, risk state, pinned status, and sort order."
            >
              <TextInput
                value={inventoryFilters.query}
                onChangeText={(value) => void updateFilter("inventory", { query: value })}
                placeholder="Search warehouse, note, or urgency"
                placeholderTextColor="#6B7F97"
                className="rounded-[20px] border border-border bg-background px-4 py-3 text-sm text-foreground"
              />
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
                {inventoryRegions.map((region) => (
                  <Pressable
                    key={region}
                    onPress={() => void updateFilter("inventory", { region })}
                    className={inventoryFilters.region === region ? "rounded-full bg-primary px-4 py-2" : "rounded-full bg-background px-4 py-2"}
                  >
                    <Text className={inventoryFilters.region === region ? "text-xs font-semibold text-white" : "text-xs font-semibold text-foreground"}>{region === "all" ? "All regions" : region}</Text>
                  </Pressable>
                ))}
              </ScrollView>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
                {riskOptions.map((risk) => (
                  <Pressable
                    key={risk}
                    onPress={() => void updateFilter("inventory", { risk })}
                    className={inventoryFilters.risk === risk ? "rounded-full bg-accent2 px-4 py-2" : "rounded-full bg-background px-4 py-2"}
                  >
                    <Text className={inventoryFilters.risk === risk ? "text-xs font-semibold text-white" : "text-xs font-semibold text-foreground"}>{risk}</Text>
                  </Pressable>
                ))}
              </ScrollView>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
                {sortOptions.map((option) => (
                  <Pressable
                    key={option.value}
                    onPress={() => void updateFilter("inventory", { sortBy: option.value })}
                    className={inventoryFilters.sortBy === option.value ? "rounded-full bg-primary px-4 py-2" : "rounded-full bg-background px-4 py-2"}
                  >
                    <Text className={inventoryFilters.sortBy === option.value ? "text-xs font-semibold text-white" : "text-xs font-semibold text-foreground"}>{option.label}</Text>
                  </Pressable>
                ))}
                <Pressable
                  onPress={() => void updateFilter("inventory", { pinnedOnly: !inventoryFilters.pinnedOnly })}
                  className={inventoryFilters.pinnedOnly ? "rounded-full bg-warning px-4 py-2" : "rounded-full bg-background px-4 py-2"}
                >
                  <Text className={inventoryFilters.pinnedOnly ? "text-xs font-semibold text-white" : "text-xs font-semibold text-foreground"}>Pinned only</Text>
                </Pressable>
              </ScrollView>
            </SectionCard>

            <SmartSearchPanel
              domain="inventory"
              region={inventoryFilters.region === "all" ? undefined : inventoryFilters.region}
              onSelectResult={handleSmartSearchSelection}
            />

            <SectionCard
              title="Quick action composer"
              subtitle="Use context-aware defaults to queue urgent audits or replenishment actions with less typing."
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
                placeholder="Add an operator note or reuse a saved draft"
                placeholderTextColor="#6B7F97"
                multiline
                className="min-h-[96px] rounded-[20px] border border-border bg-background px-4 py-3 text-sm text-foreground"
              />
              <View className="flex-row flex-wrap gap-3">
                <Pressable
                  onPress={() => {
                    const fallbackNode = filteredInventory[0] ?? snapshot.inventory[0];
                    if (fallbackNode && inventoryAuditPreset) {
                      const rendered = renderQuickActionText(inventoryAuditPreset, fallbackNode.name);
                      setNoteText((current) => current || rendered.note);
                      setPendingAction({ type: "inventory_audit", node: fallbackNode });
                    }
                  }}
                  className="rounded-full bg-primary px-4 py-3"
                >
                  <Text className="text-xs font-semibold text-white">Quick audit</Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    const proposal = filteredProcurement[0] ?? snapshot.procurement[0];
                    const fallbackNode = filteredInventory[0] ?? snapshot.inventory[0];
                    if ((proposal || fallbackNode) && replenishmentPreset) {
                      const rendered = renderQuickActionText(replenishmentPreset, proposal?.sku ?? fallbackNode?.name ?? "record");
                      setNoteText((current) => current || rendered.note);
                      setPendingAction({ type: "replenishment", proposal, node: fallbackNode });
                    }
                  }}
                  className="rounded-full bg-accent2 px-4 py-3"
                >
                  <Text className="text-xs font-semibold text-white">Quick replenishment</Text>
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
                <Pressable onPress={() => void persistDraft()} className="rounded-full bg-background px-4 py-3">
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

            {selectedRecordCount > 0 ? (
              <SectionCard
                title="Bulk audit actions"
                subtitle="Apply the same audit intent to multiple selected inventory nodes in one pass."
              >
                <Text className="text-sm leading-6 text-muted">{selectedRecordCount} inventory records selected for bulk action.</Text>
                <View className="flex-row flex-wrap gap-3">
                  <Pressable onPress={() => void queueBulkAudit()} className="rounded-full bg-primary px-4 py-3">
                    <Text className="text-xs font-semibold text-white">Queue bulk audit</Text>
                  </Pressable>
                  <Pressable onPress={() => setSelectedIds([])} className="rounded-full bg-background px-4 py-3">
                    <Text className="text-xs font-semibold text-foreground">Clear selection</Text>
                  </Pressable>
                </View>
              </SectionCard>
            ) : null}
          </View>
        }
        renderItem={({ item }) => (
          <View className="rounded-[28px] border border-border bg-surface px-4 py-4">
            <View className="flex-row items-start justify-between gap-3">
              <Pressable onPress={() => setSelectedNode(item)} className="flex-1">
                <Text className="text-[11px] font-semibold uppercase tracking-[1.2px] text-accent2">{item.region}</Text>
                <Text className="mt-2 text-lg font-semibold leading-6 text-foreground">{item.name}</Text>
                <Text className="mt-2 text-sm leading-6 text-muted">{item.note || "Awaiting a live inventory snapshot from the configured backend environment."}</Text>
              </Pressable>
              <View className="items-end gap-2">
                <RiskBadge level={item.risk} />
                <Pressable onPress={() => void togglePinnedRecord("inventory", item.id)} className={item.pinned ? "rounded-full bg-warning px-3 py-1.5" : "rounded-full bg-background px-3 py-1.5"}>
                  <Text className={item.pinned ? "text-[11px] font-semibold text-white" : "text-[11px] font-semibold text-foreground"}>{item.pinned ? "Pinned" : "Pin"}</Text>
                </Pressable>
                <Pressable onPress={() => toggleBulkSelection(item.id)} className={selectedIds.includes(item.id) ? "rounded-full bg-primary px-3 py-1.5" : "rounded-full bg-background px-3 py-1.5"}>
                  <Text className={selectedIds.includes(item.id) ? "text-[11px] font-semibold text-white" : "text-[11px] font-semibold text-foreground"}>{selectedIds.includes(item.id) ? "Selected" : "Select"}</Text>
                </Pressable>
              </View>
            </View>
            <View className="mt-4 flex-row flex-wrap gap-3">
              <MetricPill label="Coverage" value={item.stockCoverageHours ? `${item.stockCoverageHours}h` : "Unknown"} />
              <MetricPill label="Confidence" value={item.confidence} />
            </View>
            <View className={isFreshnessStale(item.freshnessMinutes) ? "mt-4 rounded-[18px] border border-warning/40 bg-warning/10 px-4 py-3" : "mt-4 rounded-[18px] border border-border bg-background/60 px-4 py-3"}>
              <Text className="text-xs font-semibold uppercase tracking-[1px] text-muted">Freshness</Text>
              <Text className="mt-1 text-sm font-semibold text-foreground">{formatFreshness(item.freshnessMinutes)}</Text>
              <Text className="mt-1 text-xs text-muted">{item.recordUpdatedAt ? `Updated ${new Date(item.recordUpdatedAt).toLocaleString()}` : "No record update time available."}</Text>
            </View>
          </View>
        )}
        ListEmptyComponent={
          syncing && !snapshot.inventory.length && !snapshot.procurement.length ? (
            <LoadingSkeleton rows={6} />
          ) : (
            <EmptyState
              title="No inventory nodes match the current filter"
              body="Try widening the region or risk filters, or connect a live snapshot source if no data has been cached yet."
            />
          )
        }
        ListFooterComponent={
          filteredProcurement.length > 0 ? (
            <View className="mt-4 gap-3">
              <Text className="text-lg font-semibold text-foreground">Procurement proposals</Text>
              {filteredProcurement.map((proposal) => (
                <Pressable key={proposal.id} onPress={() => setSelectedProposal(proposal)} className="rounded-[24px] border border-border bg-surface px-4 py-4">
                  <View className="flex-row items-start justify-between gap-3">
                    <View className="flex-1">
                      <Text className="text-sm font-semibold text-foreground">{proposal.sku}</Text>
                      <Text className="mt-1 text-xs leading-5 text-muted">{proposal.nodeName}</Text>
                    </View>
                    <View className="items-end gap-2">
                      <RiskBadge level={proposal.urgency} />
                      <Pressable onPress={() => void togglePinnedRecord("procurement", proposal.id)} className={proposal.pinned ? "rounded-full bg-warning px-3 py-1.5" : "rounded-full bg-background px-3 py-1.5"}>
                        <Text className={proposal.pinned ? "text-[11px] font-semibold text-white" : "text-[11px] font-semibold text-foreground"}>{proposal.pinned ? "Pinned" : "Pin"}</Text>
                      </Pressable>
                    </View>
                  </View>
                  <Text className="mt-3 text-sm leading-6 text-muted">{proposal.note || proposal.action}</Text>
                  <View className="mt-4 flex-row flex-wrap gap-3">
                    <MetricPill label="Units" value={proposal.recommendedUnits ?? "Pending"} />
                    <MetricPill label="Mode" value={proposal.action} />
                  </View>
                </Pressable>
              ))}
            </View>
          ) : null
        }
      />

      <DetailSheet
        visible={Boolean(selectedNode)}
        title={selectedNode?.name ?? "Inventory node"}
        subtitle={selectedNode?.region}
        risk={selectedNode?.risk ?? "watch"}
        stateLabel={connectivityMode === "online" ? "Live or ready to sync" : "Action queued locally if needed"}
        summary={selectedNode?.note || "Review stock cover, freshness, and recommended next action before deciding whether to audit or replenish."}
        metrics={[
          { label: "Coverage", value: selectedNode?.stockCoverageHours ? `${selectedNode.stockCoverageHours} hours` : "Unknown", tone: selectedNode?.risk === "critical" ? "error" : "default" },
          { label: "Confidence", value: selectedNode?.confidence ?? "Unknown", tone: selectedNode?.confidence === "high" ? "success" : selectedNode?.confidence === "low" ? "warning" : "default" },
          { label: "Urgency", value: selectedNode?.restockUrgency ?? "Awaiting sync", tone: selectedNode?.risk === "critical" ? "error" : selectedNode?.risk === "watch" ? "warning" : "success" },
          { label: "Freshness", value: formatFreshness(selectedNode?.freshnessMinutes), tone: isFreshnessStale(selectedNode?.freshnessMinutes) ? "warning" : "accent" },
        ]}
        notes={selectedNode ? [
          `Region: ${selectedNode.region}`,
          `Queue posture: ${snapshot.summary.queueCount} local actions pending across the mobile outbox.`,
          selectedProposalForNode?.supplier ? `Preferred supplier: ${selectedProposalForNode.supplier}.` : "No supplier recommendation has been cached yet.",
        ] : []}
        actions={[
          {
            label: "Queue audit confirmation",
            tone: "secondary",
            onPress: () => {
              if (selectedNode) {
                setPendingAction({ type: "inventory_audit", node: selectedNode });
              }
            },
          },
          {
            label: "Queue replenishment confirmation",
            tone: "primary",
            onPress: () => {
              if (selectedNode) {
                setPendingAction({ type: "replenishment", proposal: selectedProposalForNode ?? undefined, node: selectedNode });
              }
            },
          },
          {
            label: selectedNode?.pinned ? "Unpin record" : "Pin record",
            tone: "secondary",
            onPress: () => {
              if (selectedNode) {
                void togglePinnedRecord("inventory", selectedNode.id);
                setSelectedNode({ ...selectedNode, pinned: !selectedNode.pinned });
              }
            },
          },
        ]}
        onClose={() => setSelectedNode(null)}
      />

      <DetailSheet
        visible={Boolean(selectedProposal)}
        title={selectedProposal?.sku ?? "Procurement proposal"}
        subtitle={selectedProposal?.nodeName}
        risk={selectedProposal?.urgency ?? "watch"}
        stateLabel={connectivityMode === "online" ? "Ready for live procurement sync" : "Proposal can be queued locally"}
        summary={selectedProposal?.note || "Review units, supplier, and transfer mode before confirming the procurement action."}
        metrics={[
          { label: "Units", value: selectedProposal?.recommendedUnits ? `${selectedProposal.recommendedUnits}` : "Unknown", tone: "accent" },
          { label: "Mode", value: selectedProposal?.action ?? "Unknown", tone: "default" },
          { label: "Supplier", value: selectedProposal?.supplier ?? "Unassigned", tone: "success" },
          { label: "ETA", value: selectedProposal?.etaWindow ?? "Unknown", tone: "warning" },
        ]}
        notes={selectedProposal ? [
          `Node: ${selectedProposal.nodeName}`,
          `Priority posture: ${selectedProposal.urgency}.`,
          `Freshness: ${formatFreshness(selectedProposal.freshnessMinutes)}.`,
        ] : []}
        actions={[
          {
            label: "Queue procurement confirmation",
            tone: "primary",
            onPress: () => {
              if (selectedProposal) {
                setPendingAction({ type: "replenishment", proposal: selectedProposal });
              }
            },
          },
          {
            label: selectedProposal?.pinned ? "Unpin proposal" : "Pin proposal",
            tone: "secondary",
            onPress: () => {
              if (selectedProposal) {
                void togglePinnedRecord("procurement", selectedProposal.id);
                setSelectedProposal({ ...selectedProposal, pinned: !selectedProposal.pinned });
              }
            },
          },
          {
            label: "Close sheet",
            tone: "secondary",
            onPress: () => setSelectedProposal(null),
          },
        ]}
        onClose={() => setSelectedProposal(null)}
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
        visible={Boolean(pendingAction)}
        title={pendingAction?.type === "inventory_audit" ? "Confirm inventory audit" : "Confirm replenishment action"}
        body={pendingAction?.type === "inventory_audit"
          ? `Create an offline-safe audit task for ${pendingAction.node.name}. It will sync immediately when the network is healthy or remain safely queued on device.`
          : `Queue a replenishment action for ${pendingAction?.proposal?.sku ?? pendingAction?.node?.name ?? "the selected record"}. This preserves operator intent even under intermittent connectivity.`}
        confirmLabel={pendingAction?.type === "inventory_audit" ? "Queue audit" : "Queue replenishment"}
        onConfirm={() => void queueConfirmedAction()}
        onCancel={() => setPendingAction(null)}
      />
    </ScreenContainer>
  );
}
