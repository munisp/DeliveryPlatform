import { useMemo, useState } from "react";
import { Link } from "wouter";
import { Gift, PackageCheck, RefreshCw, Rocket, SendHorizonal, ShieldAlert, Sparkles } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";

type ReplenishmentDraft = {
  city: string;
  requestedBy: string;
  workflowReason: string;
};

type LoyaltyDraft = {
  userId: string;
  points: string;
  description: string;
  rewardId: string;
};

type CampaignDraft = {
  campaignName: string;
  campaignType: string;
  targetAudience: string;
  emailTemplate: string;
  userId: string;
};

type ControlTowerPayload = {
  summary?: string;
  gateway?: {
    status?: string;
    recent_plan_count?: number;
  };
  inventory_control?: Record<string, { configured?: boolean }>;
  mobile_shortcuts?: Array<{
    route: string;
    action: string;
    label: string;
  }>;
  network?: {
    resilience_band?: string;
    critical_nodes?: number;
    constrained_nodes?: number;
    nodes?: Array<{
      warehouse_id: number;
      label: string;
      zone_key?: string | null;
      stock_cover_hours: number;
      critical_skus: number;
      recommended_restock_units: number;
      risk_band: string;
      narrative?: string;
    }>;
  };
  supplier_health?: {
    suppliers?: Array<{
      supplier_id?: string;
      supplier_name?: string;
      lead_time_hours?: number;
      fill_rate?: number;
      spoilage_risk?: number;
      reliability_band?: string;
      urgency?: string;
      narrative?: string;
    }>;
  };
};

type GrowthControlPayload = {
  summary?: string;
  control_tower?: ControlTowerPayload;
  campaigns?: {
    active_campaigns?: string[];
  };
  loyalty?: {
    active_rewards?: unknown[];
    stats?: {
      total_accounts?: number;
    };
  };
};

const DEFAULT_DRAFT: ReplenishmentDraft = {
  city: "Lagos",
  requestedBy: "operator-control-tower",
  workflowReason: "Protect fill rate, ETA honesty, and campaign-driven demand coverage.",
};

const DEFAULT_LOYALTY_DRAFT: LoyaltyDraft = {
  userId: "1",
  points: "250",
  description: "Dispatch recovery goodwill points",
  rewardId: "",
};

const DEFAULT_CAMPAIGN_DRAFT: CampaignDraft = {
  campaignName: "Supply Recovery Boost",
  campaignType: "retention",
  targetAudience: "gold",
  emailTemplate: "Hello {{name}}, demand is back online in your zone. Enjoy priority availability and curated offers this week.",
  userId: "1",
};

export default function LogisticsControlTower() {
  const [draft, setDraft] = useState<ReplenishmentDraft>(DEFAULT_DRAFT);
  const [loyaltyDraft, setLoyaltyDraft] = useState<LoyaltyDraft>(DEFAULT_LOYALTY_DRAFT);
  const [campaignDraft, setCampaignDraft] = useState<CampaignDraft>(DEFAULT_CAMPAIGN_DRAFT);
  const growthControl = trpc.localCommerceSuperGateway.supplyChainGrowthControl.useQuery({ city: draft.city });
  const queryClient = trpc.useUtils();

  const queueReplenishment = trpc.localCommerceSuperGateway.queueReplenishment.useMutation({
    onSuccess: async () => {
      await Promise.all([
        queryClient.localCommerceSuperGateway.logisticsControlTower.invalidate(),
        queryClient.localCommerceSuperGateway.supplyChainGrowthControl.invalidate(),
      ]);
    },
  });

  const loyaltyIntervention = trpc.localCommerceSuperGateway.loyaltyIntervention.useMutation({
    onSuccess: async () => {
      await queryClient.localCommerceSuperGateway.supplyChainGrowthControl.invalidate();
    },
  });

  const merchantGrowthCampaign = trpc.localCommerceSuperGateway.merchantGrowthCampaign.useMutation({
    onSuccess: async () => {
      await queryClient.localCommerceSuperGateway.supplyChainGrowthControl.invalidate();
    },
  });

  const data = growthControl.data as GrowthControlPayload | undefined;
  const tower = data?.control_tower;
  const networkNodes = tower?.network?.nodes ?? [];
  const supplierSignals = tower?.supplier_health?.suppliers ?? [];
  const activeCampaigns = data?.campaigns?.active_campaigns ?? [];
  const activeRewards = data?.loyalty?.active_rewards ?? [];

  const replenishmentCandidates = useMemo(() => {
    const fallbackSupplier = supplierSignals[0];
    return networkNodes
      .filter((node) => node.risk_band !== "healthy")
      .slice(0, 3)
      .map((node, index) => ({
        sku: `sku-${node.warehouse_id}-${index + 1}`,
        label: `${node.label} priority SKU ${index + 1}`,
        category: index === 0 ? "grocery" : "retail",
        warehouseId: node.warehouse_id,
        warehouseLabel: node.label,
        zoneKey: node.zone_key ?? `${draft.city.toLowerCase()}-zone-${index + 1}`,
        currentAvailableUnits: Math.max(0, Math.round(node.stock_cover_hours / 2)),
        currentReservedUnits: Math.max(1, node.critical_skus),
        currentInboundUnits: Math.max(0, Math.round(node.recommended_restock_units / 4)),
        forecastUnits: Math.max(6, Math.round(node.recommended_restock_units * 1.2)),
        recommendedRestockUnits: Math.max(4, Math.round(node.recommended_restock_units)),
        safetyStockUnits: Math.max(6, Math.round(node.recommended_restock_units * 0.8)),
        stockoutRisk: node.risk_band,
        supplier: {
          supplierId: fallbackSupplier?.supplier_id ?? `supplier-${index + 1}`,
          supplierName: fallbackSupplier?.supplier_name ?? `Regional supplier ${index + 1}`,
          leadTimeHours: fallbackSupplier?.lead_time_hours ?? 12,
          fillRate: fallbackSupplier?.fill_rate ?? 0.91,
          spoilageRisk: fallbackSupplier?.spoilage_risk ?? 0.08,
          reliabilityBand: fallbackSupplier?.reliability_band ?? "watch",
        },
        targetTransferNodeId: undefined as number | undefined,
        targetTransferNodeName: undefined as string | undefined,
      }));
  }, [draft.city, networkNodes, supplierSignals]);

  const metrics = [
    {
      label: "Gateway status",
      value: tower?.gateway?.status ?? "unknown",
      supporting: `${tower?.gateway?.recent_plan_count ?? 0} recent middleware-backed plans recorded.`,
    },
    {
      label: "Network resilience",
      value: tower?.network?.resilience_band ?? "unknown",
      supporting: `${tower?.network?.critical_nodes ?? 0} critical nodes and ${tower?.network?.constrained_nodes ?? 0} constrained nodes.`,
    },
    {
      label: "Loyalty members",
      value: Number((data?.loyalty?.stats as any)?.total_accounts ?? 0),
      supporting: `${activeRewards.length} active rewards currently shaping cross-category demand.`,
    },
    {
      label: "Active campaigns",
      value: activeCampaigns.length,
      supporting: "Merchant growth pressure that can change replenishment urgency and zone-level allocation decisions.",
    },
  ];

  const handleQueueReplenishment = () => {
    queueReplenishment.mutate({
      city: draft.city,
      requestedBy: draft.requestedBy,
      workflowReason: draft.workflowReason,
      trigger: "logistics_control_tower",
      planningHorizonHours: 48,
      skus: replenishmentCandidates,
    });
  };

  const handleLoyaltyIntervention = () => {
    loyaltyIntervention.mutate({
      userId: Number(loyaltyDraft.userId),
      points: loyaltyDraft.points ? Number(loyaltyDraft.points) : undefined,
      description: loyaltyDraft.description,
      transactionType: "supply_chain_recovery",
      rewardId: loyaltyDraft.rewardId ? Number(loyaltyDraft.rewardId) : undefined,
    });
  };

  const handleMerchantGrowthCampaign = () => {
    merchantGrowthCampaign.mutate({
      campaignName: campaignDraft.campaignName,
      campaignType: campaignDraft.campaignType,
      targetAudience: campaignDraft.targetAudience,
      emailTemplate: campaignDraft.emailTemplate,
      audienceMode: "single_user",
      userId: Number(campaignDraft.userId),
      channel: "email",
      activate: true,
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-2">
          <div className="inline-flex items-center gap-2 rounded-full border border-cyan-400/30 bg-cyan-500/10 px-3 py-1 text-xs font-medium uppercase tracking-[0.2em] text-cyan-100">
            <PackageCheck className="h-3.5 w-3.5" />
            Supply-chain execution
          </div>
          <h1 className="text-3xl font-semibold tracking-tight text-white">Logistics Control Tower</h1>
          <p className="max-w-4xl text-sm leading-7 text-slate-300 lg:text-base">
            This operator workspace now combines logistics resilience, middleware readiness, loyalty demand pressure,
            merchant campaign activity, and direct replenishment workflow execution in one mobile-friendly control surface.
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => growthControl.refetch()}
            className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900 px-4 py-2 text-sm font-medium text-slate-100 transition hover:border-slate-500"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh control surface
          </button>
          <button
            type="button"
            onClick={handleQueueReplenishment}
            disabled={queueReplenishment.isPending || replenishmentCandidates.length === 0}
            className="inline-flex items-center gap-2 rounded-full bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <SendHorizonal className="h-4 w-4" />
            {queueReplenishment.isPending ? "Queueing..." : "Queue replenishment workflow"}
          </button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {metrics.map((metric) => (
          <Card key={metric.label}>
            <CardHeader>
              <CardDescription>{metric.label}</CardDescription>
              <CardTitle className="text-2xl text-white">{metric.value}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm leading-6 text-slate-300">{metric.supporting}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.3fr_0.9fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-white">Control summary</CardTitle>
            <CardDescription>Live logistics synthesis with growth and demand context.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm text-slate-300">
            <p>{data?.summary ?? tower?.summary ?? "No logistics synthesis is available yet."}</p>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
                <div className="text-xs uppercase tracking-[0.2em] text-slate-500">Middleware readiness</div>
                <div className="mt-2 space-y-2">
                  {Object.entries(tower?.inventory_control ?? {}).map(([key, value]) => (
                    <div key={key} className="flex items-center justify-between gap-4 text-sm">
                      <span className="capitalize text-slate-300">{key}</span>
                      <span className={value?.configured ? "text-emerald-300" : "text-amber-300"}>
                        {value?.configured ? "ready" : "disabled"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
                <div className="text-xs uppercase tracking-[0.2em] text-slate-500">Operator shortcuts</div>
                <div className="mt-2 space-y-2">
                  {(tower?.mobile_shortcuts ?? []).map((shortcut) => (
                    <div key={`${shortcut.route}-${shortcut.action}`} className="rounded-xl border border-slate-800 px-3 py-2">
                      <div className="font-medium text-slate-100">{shortcut.label}</div>
                      <div className="text-xs text-slate-400">{shortcut.route} · {shortcut.action}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            {queueReplenishment.data ? (
              <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4 text-emerald-100">
                <div className="font-medium">Workflow queued</div>
                <p className="mt-2 text-sm leading-6">
                  {queueReplenishment.data.replenishment_workflow?.summary ?? "Replenishment workflow created."}
                </p>
              </div>
            ) : null}
            {queueReplenishment.isError ? (
              <div className="rounded-2xl border border-rose-500/20 bg-rose-500/10 p-4 text-rose-100">
                <div className="font-medium">Workflow failed</div>
                <p className="mt-2 text-sm leading-6">{queueReplenishment.error.message}</p>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-white">Replenishment draft</CardTitle>
            <CardDescription>Queue explicit operator-reviewed replenishment from the live control surface.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <label className="block space-y-2 text-sm text-slate-300">
              <span>City</span>
              <input
                value={draft.city}
                onChange={(event) => setDraft((current) => ({ ...current, city: event.target.value }))}
                className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-slate-100 outline-none transition focus:border-cyan-400"
              />
            </label>
            <label className="block space-y-2 text-sm text-slate-300">
              <span>Requested by</span>
              <input
                value={draft.requestedBy}
                onChange={(event) => setDraft((current) => ({ ...current, requestedBy: event.target.value }))}
                className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-slate-100 outline-none transition focus:border-cyan-400"
              />
            </label>
            <label className="block space-y-2 text-sm text-slate-300">
              <span>Workflow reason</span>
              <textarea
                value={draft.workflowReason}
                onChange={(event) => setDraft((current) => ({ ...current, workflowReason: event.target.value }))}
                rows={4}
                className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-slate-100 outline-none transition focus:border-cyan-400"
              />
            </label>
            <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4 text-sm text-slate-300">
              <div className="mb-2 flex items-center gap-2 font-medium text-slate-100">
                <Sparkles className="h-4 w-4 text-cyan-300" />
                Candidate SKUs prepared from live risk nodes
              </div>
              <div className="space-y-2">
                {replenishmentCandidates.length === 0 ? (
                  <div className="text-slate-400">No elevated or critical nodes are currently available for a replenishment draft.</div>
                ) : replenishmentCandidates.map((candidate) => (
                  <div key={candidate.sku} className="rounded-xl border border-slate-800 px-3 py-2">
                    <div className="font-medium text-slate-100">{candidate.label}</div>
                    <div className="text-xs text-slate-400">
                      {candidate.warehouseLabel} · restock {candidate.recommendedRestockUnits} · supplier {candidate.supplier.supplierName}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-white">Supply network risk</CardTitle>
            <CardDescription>Multi-node resilience signals from the retail forecasting layer.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {networkNodes.map((node) => (
              <div key={node.warehouse_id} className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <div className="font-medium text-slate-100">{node.label}</div>
                    <div className="text-xs text-slate-400">{node.zone_key ?? "unknown zone"}</div>
                  </div>
                  <span className={node.risk_band === "healthy" ? "text-emerald-300" : "text-amber-300"}>{node.risk_band}</span>
                </div>
                <p className="mt-2 text-sm leading-6 text-slate-300">{node.narrative}</p>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-white">Supplier resilience</CardTitle>
            <CardDescription>Supplier-side risk shaping replenishment timing and transfer decisions.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {supplierSignals.map((supplier) => (
              <div key={supplier.supplier_id} className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <div className="font-medium text-slate-100">{supplier.supplier_name}</div>
                    <div className="text-xs text-slate-400">Lead time {supplier.lead_time_hours}h · fill rate {(supplier.fill_rate * 100).toFixed(0)}%</div>
                  </div>
                  <span className={supplier.urgency === "critical" ? "text-rose-300" : supplier.urgency === "elevated" ? "text-amber-300" : "text-emerald-300"}>
                    {supplier.urgency}
                  </span>
                </div>
                <p className="mt-2 text-sm leading-6 text-slate-300">{supplier.narrative}</p>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-white">Growth pressure</CardTitle>
            <CardDescription>Loyalty and campaign signals that should influence supply execution.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
              <div className="mb-2 flex items-center gap-2 font-medium text-slate-100">
                <ShieldAlert className="h-4 w-4 text-cyan-300" />
                Active campaigns
              </div>
              <div className="space-y-2 text-sm text-slate-300">
                {activeCampaigns.length === 0 ? (
                  <div className="text-slate-400">No active campaigns are currently loaded.</div>
                ) : activeCampaigns.map((campaign: any) => (
                  <div key={campaign.id} className="rounded-xl border border-slate-800 px-3 py-2">
                    <div className="font-medium text-slate-100">{campaign.campaign_name}</div>
                    <div className="text-xs text-slate-400">{campaign.campaign_type} · audience {campaign.target_audience}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
              <div className="mb-2 font-medium text-slate-100">Loyalty rewards</div>
              <div className="space-y-2 text-sm text-slate-300">
                {activeRewards.length === 0 ? (
                  <div className="text-slate-400">No active loyalty rewards are currently loaded.</div>
                ) : activeRewards.map((reward: any) => (
                  <div key={reward.id} className="rounded-xl border border-slate-800 px-3 py-2">
                    <div className="font-medium text-slate-100">{reward.reward_name}</div>
                    <div className="text-xs text-slate-400">{reward.points_cost} points · {reward.reward_type}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="pt-1 text-sm text-cyan-100">
              <Link href="/merchant-channels" className="underline decoration-cyan-400/40 underline-offset-4 hover:text-cyan-50">
                Open Merchant Channels to align campaign strategy with supply execution
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-white"><Gift className="h-4 w-4 text-cyan-300" /> Loyalty intervention</CardTitle>
            <CardDescription>Issue recovery points or redeem a reward from the same operator workspace.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <label className="block space-y-2 text-sm text-slate-300">
                <span>User ID</span>
                <input value={loyaltyDraft.userId} onChange={(event) => setLoyaltyDraft((current) => ({ ...current, userId: event.target.value }))} className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-slate-100 outline-none transition focus:border-cyan-400" />
              </label>
              <label className="block space-y-2 text-sm text-slate-300">
                <span>Points</span>
                <input value={loyaltyDraft.points} onChange={(event) => setLoyaltyDraft((current) => ({ ...current, points: event.target.value }))} className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-slate-100 outline-none transition focus:border-cyan-400" />
              </label>
            </div>
            <label className="block space-y-2 text-sm text-slate-300">
              <span>Description</span>
              <input value={loyaltyDraft.description} onChange={(event) => setLoyaltyDraft((current) => ({ ...current, description: event.target.value }))} className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-slate-100 outline-none transition focus:border-cyan-400" />
            </label>
            <label className="block space-y-2 text-sm text-slate-300">
              <span>Optional reward ID</span>
              <input value={loyaltyDraft.rewardId} onChange={(event) => setLoyaltyDraft((current) => ({ ...current, rewardId: event.target.value }))} className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-slate-100 outline-none transition focus:border-cyan-400" />
            </label>
            <button type="button" onClick={handleLoyaltyIntervention} disabled={loyaltyIntervention.isPending} className="inline-flex items-center gap-2 rounded-full bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-60">
              <Gift className="h-4 w-4" />
              {loyaltyIntervention.isPending ? "Applying..." : "Apply loyalty intervention"}
            </button>
            {loyaltyIntervention.data ? <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4 text-sm text-emerald-100">Loyalty intervention completed for user {loyaltyIntervention.data.user_id}.</div> : null}
            {loyaltyIntervention.isError ? <div className="rounded-2xl border border-rose-500/20 bg-rose-500/10 p-4 text-sm text-rose-100">{loyaltyIntervention.error.message}</div> : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-white"><Rocket className="h-4 w-4 text-cyan-300" /> Merchant growth campaign</CardTitle>
            <CardDescription>Create and dispatch a recovery campaign without leaving the supply-chain workspace.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <label className="block space-y-2 text-sm text-slate-300">
                <span>Campaign name</span>
                <input value={campaignDraft.campaignName} onChange={(event) => setCampaignDraft((current) => ({ ...current, campaignName: event.target.value }))} className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-slate-100 outline-none transition focus:border-cyan-400" />
              </label>
              <label className="block space-y-2 text-sm text-slate-300">
                <span>Campaign type</span>
                <input value={campaignDraft.campaignType} onChange={(event) => setCampaignDraft((current) => ({ ...current, campaignType: event.target.value }))} className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-slate-100 outline-none transition focus:border-cyan-400" />
              </label>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <label className="block space-y-2 text-sm text-slate-300">
                <span>Target audience</span>
                <input value={campaignDraft.targetAudience} onChange={(event) => setCampaignDraft((current) => ({ ...current, targetAudience: event.target.value }))} className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-slate-100 outline-none transition focus:border-cyan-400" />
              </label>
              <label className="block space-y-2 text-sm text-slate-300">
                <span>Seed user ID</span>
                <input value={campaignDraft.userId} onChange={(event) => setCampaignDraft((current) => ({ ...current, userId: event.target.value }))} className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-slate-100 outline-none transition focus:border-cyan-400" />
              </label>
            </div>
            <label className="block space-y-2 text-sm text-slate-300">
              <span>Email template</span>
              <textarea value={campaignDraft.emailTemplate} onChange={(event) => setCampaignDraft((current) => ({ ...current, emailTemplate: event.target.value }))} rows={4} className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-slate-100 outline-none transition focus:border-cyan-400" />
            </label>
            <button type="button" onClick={handleMerchantGrowthCampaign} disabled={merchantGrowthCampaign.isPending} className="inline-flex items-center gap-2 rounded-full bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-60">
              <Rocket className="h-4 w-4" />
              {merchantGrowthCampaign.isPending ? "Dispatching..." : "Launch recovery campaign"}
            </button>
            {merchantGrowthCampaign.data ? <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4 text-sm text-emerald-100">Campaign <span className="font-medium">{merchantGrowthCampaign.data.campaign?.campaign_name}</span> dispatched in {merchantGrowthCampaign.data.audience_mode} mode.</div> : null}
            {merchantGrowthCampaign.isError ? <div className="rounded-2xl border border-rose-500/20 bg-rose-500/10 p-4 text-sm text-rose-100">{merchantGrowthCampaign.error.message}</div> : null}
          </CardContent>
        </Card>
      </div>

      {growthControl.isLoading ? <div className="text-sm text-slate-400">Loading logistics control data...</div> : null}
      {growthControl.isError ? <div className="text-sm text-rose-300">Unable to load the supply-chain control surface.</div> : null}
    </div>
  );
}
