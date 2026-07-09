import { ENV } from "./env";
import { buildLocalCommerceLogisticsControlTower } from "./localCommerceSuperGateway";
import {
  awardPoints,
  createCampaign,
  getCampaignById,
  getCampaigns,
  getCampaignStats,
  getLoyaltyRewards,
  getLoyaltyStats,
  redeemPoints,
  sendCampaign,
  sendCampaignToAudience,
  updateCampaign,
} from "../db";

type ReplenishmentSkuInput = {
  sku: string;
  label?: string | null;
  category?: string | null;
  warehouseId: number;
  warehouseLabel: string;
  zoneKey?: string | null;
  currentAvailableUnits: number;
  currentReservedUnits?: number;
  currentInboundUnits?: number;
  forecastUnits: number;
  recommendedRestockUnits: number;
  safetyStockUnits: number;
  stockoutRisk: string;
  supplier: {
    supplierId: string;
    supplierName: string;
    leadTimeHours: number;
    fillRate: number;
    spoilageRisk: number;
    reliabilityBand: string;
  };
  targetTransferNodeId?: number | null;
  targetTransferNodeName?: string | null;
};

type ReplenishmentWorkflowInput = {
  city: string;
  planningHorizonHours?: number;
  trigger?: string;
  requestedBy?: string;
  workflowReason?: string;
  traceId?: string | null;
  skus: ReplenishmentSkuInput[];
};

type LoyaltyInterventionInput = {
  userId: number;
  points?: number;
  transactionType?: string;
  description?: string;
  orderId?: number;
  rewardId?: number;
  idempotencyKey?: string;
};

type MerchantGrowthCampaignInput = {
  campaignId?: number;
  campaignName?: string;
  campaignType?: string;
  emailTemplate?: string | null;
  smsTemplate?: string | null;
  targetAudience?: string;
  triggerCondition?: Record<string, unknown> | null;
  activate?: boolean;
  audienceMode?: "single_user" | "full_audience";
  userId?: number;
  channel?: "email" | "sms";
  idempotencyKey?: string;
};

export async function getSupplyChainGrowthControl(options?: { city?: string | null; forceRefresh?: boolean; traceId?: string | null }) {
  const traceId = options?.traceId ?? generateTraceId("scg");
  const [tower, loyaltyStats, campaignStats, campaigns, rewards] = await Promise.all([
    buildLocalCommerceLogisticsControlTower({ city: options?.city, forceRefresh: options?.forceRefresh, traceId }),
    getLoyaltyStats(),
    getCampaignStats(),
    getCampaigns(true),
    getLoyaltyRewards({ activeOnly: true }),
  ]);

  return {
    city: options?.city ?? "Lagos",
    trace_id: traceId,
    control_tower: tower,
    loyalty: {
      stats: loyaltyStats,
      active_rewards: rewards.slice(0, 6),
    },
    campaigns: {
      stats: campaignStats,
      active_campaigns: campaigns.slice(0, 6),
    },
    summary: [
      tower.summary,
      `Loyalty members: ${Number((loyaltyStats as any)?.total_accounts ?? 0)}.`,
      `Active campaigns: ${campaigns.length}.`,
    ].join(" "),
  };
}

export async function queueReplenishmentWorkflow(input: ReplenishmentWorkflowInput) {
  const traceId = input.traceId ?? generateTraceId("repl");
  if (!ENV.procurementPlannerServiceUrl) {
    throw new Error("PROCUREMENT_PLANNER_SERVICE_URL is not configured");
  }
  if (!ENV.inventoryControlServiceUrl) {
    throw new Error("INVENTORY_CONTROL_SERVICE_URL is not configured");
  }

  const procurementPayload = {
    city: input.city,
    planning_horizon_hours: input.planningHorizonHours ?? 48,
    trigger: input.trigger ?? "operator_review",
    requested_by: input.requestedBy ?? "switchos-operator",
    workflow_reason: input.workflowReason ?? "Protect fill rate and ETA honesty",
    skus: input.skus.map((sku) => ({
      sku: sku.sku,
      label: sku.label,
      category: sku.category,
      warehouse_id: sku.warehouseId,
      warehouse_label: sku.warehouseLabel,
      zone_key: sku.zoneKey,
      current_available_units: sku.currentAvailableUnits,
      current_reserved_units: sku.currentReservedUnits ?? 0,
      current_inbound_units: sku.currentInboundUnits ?? 0,
      forecast_units: sku.forecastUnits,
      recommended_restock_units: sku.recommendedRestockUnits,
      safety_stock_units: sku.safetyStockUnits,
      stockout_risk: sku.stockoutRisk,
      supplier: {
        supplier_id: sku.supplier.supplierId,
        supplier_name: sku.supplier.supplierName,
        lead_time_hours: sku.supplier.leadTimeHours,
        fill_rate: sku.supplier.fillRate,
        spoilage_risk: sku.supplier.spoilageRisk,
        reliability_band: sku.supplier.reliabilityBand,
      },
      target_transfer_node_id: sku.targetTransferNodeId ?? null,
      target_transfer_node_name: sku.targetTransferNodeName ?? null,
    })),
  };

  const planResponse = await fetch(`${ENV.procurementPlannerServiceUrl.replace(/\/$/, "")}/procurement/plan`, {
    method: "POST",
    headers: baseHeaders(traceId),
    body: JSON.stringify(procurementPayload),
  });
  if (!planResponse.ok) {
    throw new Error(`Procurement planner returned status ${planResponse.status}`);
  }
  const plan = await planResponse.json();

  const workflowResponse = await fetch(`${ENV.inventoryControlServiceUrl.replace(/\/$/, "")}/inventory/replenishment-request`, {
    method: "POST",
    headers: baseHeaders(traceId),
    body: JSON.stringify({
      city: input.city,
      planning_horizon_hours: input.planningHorizonHours ?? 48,
      trigger: input.trigger ?? "operator_review",
      requested_by: input.requestedBy ?? "switchos-operator",
      workflow_reason: input.workflowReason ?? "Protect fill rate and ETA honesty",
      approval_mode: plan.approval_mode ?? "operator_review",
      trace_id: traceId,
      skus: (plan.procurement_actions ?? []).map((action: any) => ({
        sku: action.sku,
        label: action.label,
        warehouse_id: action.warehouse_id,
        warehouse_label: action.warehouse_label,
        supplier_id: action.supplier_id,
        supplier_name: action.supplier_name,
        recommended_units: action.recommended_units,
        safety_stock_units: action.safety_stock_units,
        current_available_units: input.skus.find((sku) => sku.sku === action.sku)?.currentAvailableUnits ?? 0,
        current_inbound_units: input.skus.find((sku) => sku.sku === action.sku)?.currentInboundUnits ?? 0,
        lead_time_hours: action.lead_time_hours,
        service_level: action.service_level,
        risk_band: action.risk_band,
        target_transfer_node_id: action.target_transfer_node_id ?? null,
        target_transfer_node_name: action.target_transfer_node_name ?? null,
      })),
    }),
  });
  if (!workflowResponse.ok) {
    throw new Error(`Inventory control returned status ${workflowResponse.status}`);
  }
  const workflow = await workflowResponse.json();

  return {
    trace_id: traceId,
    procurement_plan: plan,
    replenishment_workflow: workflow,
  };
}

export async function applyLoyaltyIntervention(input: LoyaltyInterventionInput) {
  const traceId = generateTraceId("loyalty");
  const actions: string[] = [];
  let pointsAward = null;
  let redemption = null;

  if (typeof input.points === "number" && input.points !== 0) {
    pointsAward = await awardPoints(
      input.userId,
      input.points,
      input.transactionType ?? "operator_adjustment",
      input.description ?? "Operator loyalty intervention",
      input.orderId,
    );
    actions.push(`awarded_${input.points}_points`);
  }

  if (typeof input.rewardId === "number") {
    redemption = await redeemPoints(input.userId, input.rewardId, input.idempotencyKey ?? `${traceId}:reward:${input.rewardId}`);
    actions.push(`redeemed_reward_${input.rewardId}`);
  }

  return {
    trace_id: traceId,
    user_id: input.userId,
    actions,
    loyalty_account: pointsAward,
    redemption,
  };
}

export async function executeMerchantGrowthCampaign(input: MerchantGrowthCampaignInput) {
  const traceId = generateTraceId("campaign");
  let campaign = input.campaignId ? await getCampaignById(input.campaignId) : null;

  if (!campaign) {
    if (!input.campaignName || !input.campaignType || !input.targetAudience) {
      throw new Error("campaignName, campaignType, and targetAudience are required when campaignId is not provided");
    }
    campaign = await createCampaign({
      campaign_name: input.campaignName,
      campaign_type: input.campaignType,
      email_template: input.emailTemplate ?? undefined,
      sms_template: input.smsTemplate ?? undefined,
      target_audience: input.targetAudience,
      trigger_condition: input.triggerCondition ?? undefined,
    });
  } else if (input.activate !== undefined || input.emailTemplate || input.smsTemplate || input.targetAudience || input.triggerCondition) {
    campaign = await updateCampaign(campaign.id, {
      is_active: input.activate ?? campaign.is_active,
      email_template: input.emailTemplate ?? campaign.email_template,
      sms_template: input.smsTemplate ?? campaign.sms_template,
      target_audience: input.targetAudience ?? campaign.target_audience,
      trigger_condition: input.triggerCondition ?? campaign.trigger_condition,
    });
  }

  if (!campaign) {
    throw new Error("Unable to resolve campaign");
  }

  const mode = input.audienceMode ?? (input.userId ? "single_user" : "full_audience");
  let dispatchResult: unknown = null;
  if (mode === "single_user") {
    if (!input.userId) {
      throw new Error("userId is required for single_user campaign dispatch");
    }
    dispatchResult = await sendCampaign(
      campaign.id,
      input.userId,
      input.channel ?? "email",
      input.idempotencyKey ?? `${traceId}:campaign:${campaign.id}:user:${input.userId}`,
    );
  } else {
    dispatchResult = await sendCampaignToAudience(campaign.id, input.idempotencyKey ?? `${traceId}:campaign:${campaign.id}:audience`);
  }

  return {
    trace_id: traceId,
    campaign,
    dispatch_result: dispatchResult,
    audience_mode: mode,
  };
}

function baseHeaders(traceId: string) {
  return {
    "content-type": "application/json",
    "x-internal-service-token": ENV.internalServiceToken,
    "x-trace-id": traceId,
  };
}

function generateTraceId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
