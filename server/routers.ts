import { z } from "zod";

import { analyticsReadProcedure, protectedProcedure, publicProcedure, router, workspaceReadProcedure } from "./_core/trpc";
import { systemRouter } from "./_core/systemRouter";
import {
  getDriverMobilityWorkspace,
  getMerchantChannelWorkspace,
  getPhoneOrderingWorkspace,
  getServiceRecoveryWorkspace,
  getTablesideWorkspace,
  getWhiteLabelAppsWorkspace,
  getAnalyticsSummary as getWorkspaceAnalyticsSummary,
  getDriverStats as getWorkspaceDriverStats,
  getMarketplaceOverview as getWorkspaceMarketplaceOverview,
  getOrderStats as getWorkspaceOrderStats,
} from "./lib/platformWorkspaces";
import {
  getLakehouseAnalyticsSummary,
  getLakehouseDriverStats,
  getLakehouseMarketplaceOverview,
  getLakehouseOrderStats,
  syncLakehouseFromPostgres,
} from "./lib/lakehouse";
import { getFundsReconciliationSnapshot } from "./db";
import { appendLongCatMessagingTurn, appendLongCatVoiceTurn, getLongCatCustomerMemory, startLongCatMessagingSession, startLongCatVoiceSession } from "./_core/longcatVoice";
import { executeLongCatAction } from "./_core/longcatActions";
import { buildLocalCommerceLogisticsControlTower, buildLocalCommerceSuperGatewayWorkspace, planLocalCommerceConciergeIntent } from "./_core/localCommerceSuperGateway";
import { applyLoyaltyIntervention, executeMerchantGrowthCampaign, getSupplyChainGrowthControl, queueReplenishmentWorkflow } from "./_core/supplyChainCommandCenter";

const listInput = z.object({ limit: z.number().min(1).max(25).optional() }).optional();

async function withLakehouseFallback<T>(loader: () => Promise<T>, fallback: () => T | Promise<T>) {
  try {
    await syncLakehouseFromPostgres();
    return await loader();
  } catch (error) {
    console.warn("[SwitchOS] Falling back from lakehouse-backed analytics:", error);
    return fallback();
  }
}

export const appRouter = router({
  system: systemRouter,

  auth: router({
    me: publicProcedure.query(({ ctx }) => ctx.user),
  }),

  analytics: router({
    summary: analyticsReadProcedure.query(() => withLakehouseFallback(() => getLakehouseAnalyticsSummary(), () => getWorkspaceAnalyticsSummary())),
    orderStats: analyticsReadProcedure.query(() => withLakehouseFallback(() => getLakehouseOrderStats(), () => getWorkspaceOrderStats())),
    driverStats: analyticsReadProcedure.query(() => withLakehouseFallback(() => getLakehouseDriverStats(), () => getWorkspaceDriverStats())),
    marketplaceOverview: analyticsReadProcedure.query(() => withLakehouseFallback(() => getLakehouseMarketplaceOverview(), () => getWorkspaceMarketplaceOverview())),
    fundsReconciliation: analyticsReadProcedure.query(async () => getFundsReconciliationSnapshot()),
  }),

  driverMobility: router({
    summary: workspaceReadProcedure.input(listInput).query(({ input }) => getDriverMobilityWorkspace(input?.limit)),
  }),

  tablesideOrdering: router({
    summary: workspaceReadProcedure.input(listInput).query(({ input }) => getTablesideWorkspace(input?.limit)),
  }),

  whiteLabelApps: router({
    summary: workspaceReadProcedure.input(listInput).query(({ input }) => getWhiteLabelAppsWorkspace(input?.limit)),
  }),

  merchantChannels: router({
    workspace: workspaceReadProcedure.query(() => getMerchantChannelWorkspace()),
  }),

  serviceRecovery: router({
    workspace: workspaceReadProcedure.query(() => getServiceRecoveryWorkspace()),
  }),

  localCommerceSuperGateway: router({
    workspace: workspaceReadProcedure.query(() => buildLocalCommerceSuperGatewayWorkspace()),
    logisticsControlTower: workspaceReadProcedure
      .input(z.object({ city: z.string().trim().min(2).max(128).optional(), forceRefresh: z.boolean().optional() }).optional())
      .query(({ input }) => buildLocalCommerceLogisticsControlTower({ city: input?.city, forceRefresh: input?.forceRefresh })),
    supplyChainGrowthControl: workspaceReadProcedure
      .input(z.object({ city: z.string().trim().min(2).max(128).optional(), forceRefresh: z.boolean().optional() }).optional())
      .query(({ input }) => getSupplyChainGrowthControl({ city: input?.city, forceRefresh: input?.forceRefresh })),
    queueReplenishment: protectedProcedure
      .input(z.object({
        city: z.string().trim().min(2).max(128),
        planningHorizonHours: z.number().int().min(4).max(720).optional(),
        trigger: z.string().trim().min(2).max(128).optional(),
        requestedBy: z.string().trim().min(2).max(255).optional(),
        workflowReason: z.string().trim().min(3).max(500).optional(),
        traceId: z.string().trim().min(3).max(128).optional(),
        skus: z.array(z.object({
          sku: z.string().trim().min(1).max(128),
          label: z.string().trim().max(255).optional(),
          category: z.string().trim().max(128).optional(),
          warehouseId: z.number().int().positive(),
          warehouseLabel: z.string().trim().min(1).max(255),
          zoneKey: z.string().trim().max(128).optional(),
          currentAvailableUnits: z.number().nonnegative(),
          currentReservedUnits: z.number().nonnegative().optional(),
          currentInboundUnits: z.number().nonnegative().optional(),
          forecastUnits: z.number().nonnegative(),
          recommendedRestockUnits: z.number().nonnegative(),
          safetyStockUnits: z.number().nonnegative(),
          stockoutRisk: z.string().trim().min(1).max(64),
          supplier: z.object({
            supplierId: z.string().trim().min(1).max(128),
            supplierName: z.string().trim().min(1).max(255),
            leadTimeHours: z.number().nonnegative(),
            fillRate: z.number().min(0).max(1),
            spoilageRisk: z.number().min(0).max(1),
            reliabilityBand: z.string().trim().min(1).max(64),
          }),
          targetTransferNodeId: z.number().int().positive().optional(),
          targetTransferNodeName: z.string().trim().min(1).max(255).optional(),
        })).min(1).max(200),
      }))
      .mutation(({ input }) => queueReplenishmentWorkflow(input)),
    loyaltyIntervention: protectedProcedure
      .input(z.object({
        userId: z.number().int().positive(),
        points: z.number().int().optional(),
        transactionType: z.string().trim().min(2).max(128).optional(),
        description: z.string().trim().min(3).max(500).optional(),
        orderId: z.number().int().positive().optional(),
        rewardId: z.number().int().positive().optional(),
        idempotencyKey: z.string().trim().min(3).max(255).optional(),
      }))
      .mutation(({ input }) => applyLoyaltyIntervention(input)),
    merchantGrowthCampaign: protectedProcedure
      .input(z.object({
        campaignId: z.number().int().positive().optional(),
        campaignName: z.string().trim().min(2).max(255).optional(),
        campaignType: z.string().trim().min(2).max(128).optional(),
        emailTemplate: z.string().trim().min(3).max(5000).optional(),
        smsTemplate: z.string().trim().min(3).max(1000).optional(),
        targetAudience: z.string().trim().min(2).max(128).optional(),
        triggerCondition: z.record(z.any()).optional(),
        activate: z.boolean().optional(),
        audienceMode: z.enum(["single_user", "full_audience"]).optional(),
        userId: z.number().int().positive().optional(),
        channel: z.enum(["email", "sms"]).optional(),
        idempotencyKey: z.string().trim().min(3).max(255).optional(),
      }))
      .mutation(({ input }) => executeMerchantGrowthCampaign(input)),
    plan: protectedProcedure
      .input(z.object({
        city: z.string().trim().min(2).max(128).optional(),
        customerSegment: z.string().trim().min(2).max(128).optional(),
        categories: z.array(z.string().trim().min(2).max(64)).max(8).optional(),
        request: z.string().trim().min(3).max(1_000),
        basket: z.array(z.object({
          sku: z.string().trim().min(1).max(128),
          quantity: z.number().positive(),
          label: z.string().trim().min(1).max(255).optional(),
          category: z.string().trim().min(1).max(128).optional(),
          onHandUnits: z.number().min(0).optional(),
          reservedUnits: z.number().min(0).optional(),
          inboundUnits: z.number().min(0).optional(),
          leadTimeHours: z.number().min(1).max(240).optional(),
          eventMultiplier: z.number().min(0.5).max(3).optional(),
          weatherMultiplier: z.number().min(0.5).max(2).optional(),
          substitutionGroup: z.string().trim().min(1).max(128).optional(),
          coldChainRequired: z.boolean().optional(),
        })).max(20).optional(),
        warehouseCandidates: z.array(z.object({
          warehouseId: z.number().int().positive(),
          label: z.string().trim().min(1).max(255),
          zoneKey: z.string().trim().min(1).max(128).optional(),
          distanceKm: z.number().min(0).max(200),
          pickPackMinutes: z.number().min(0).max(240).optional(),
          coldChainReady: z.boolean().optional(),
          stockAccuracy: z.number().min(0).max(1).optional(),
          inventory: z.array(z.object({
            sku: z.string().trim().min(1).max(128),
            availableUnits: z.number().min(0),
            freshnessHours: z.number().min(0).max(720).optional(),
          })).max(50),
        })).max(12).optional(),
      }))
      .mutation(({ input }) => planLocalCommerceConciergeIntent(input)),
  }),

  phoneOrdering: router({
    workspace: workspaceReadProcedure.query(() => getPhoneOrderingWorkspace()),
    customerMemory: workspaceReadProcedure
      .input(z.object({
        userId: z.number().int().positive().optional(),
        customerPhone: z.string().trim().min(5).max(64).optional(),
        customerName: z.string().trim().min(1).max(255).optional(),
        accessibilityFlags: z.array(z.string().trim().min(1).max(64)).max(8).optional(),
      }).optional())
      .query(({ input }) => getLongCatCustomerMemory({
        userId: input?.userId ?? null,
        customerPhone: input?.customerPhone ?? null,
        customerName: input?.customerName ?? null,
        accessibilityFlags: input?.accessibilityFlags ?? [],
      })),
    startVoiceSession: protectedProcedure
      .input(z.object({
        userId: z.number().int().positive().optional(),
        customerPhone: z.string().trim().min(5).max(64).optional(),
        customerName: z.string().trim().min(1).max(255).optional(),
        voiceChannel: z.string().trim().min(2).max(64).optional(),
        accessibilityFlags: z.array(z.string().trim().min(1).max(64)).max(8).optional(),
        idempotencyKey: z.string().trim().min(4).max(255).optional(),
        triggerReason: z.string().trim().min(2).max(255).optional(),
      }))
      .mutation(({ input }) => startLongCatVoiceSession({
        userId: input.userId ?? null,
        customerPhone: input.customerPhone ?? null,
        customerName: input.customerName ?? null,
        voiceChannel: input.voiceChannel ?? null,
        accessibilityFlags: input.accessibilityFlags ?? [],
        idempotencyKey: input.idempotencyKey ?? null,
        triggerReason: input.triggerReason ?? null,
      })),
    startMessagingSession: protectedProcedure
      .input(z.object({
        userId: z.number().int().positive().optional(),
        customerPhone: z.string().trim().min(5).max(64).optional(),
        customerName: z.string().trim().min(1).max(255).optional(),
        messageChannel: z.string().trim().min(2).max(64).optional(),
        accessibilityFlags: z.array(z.string().trim().min(1).max(64)).max(8).optional(),
        idempotencyKey: z.string().trim().min(4).max(255).optional(),
        triggerReason: z.string().trim().min(2).max(255).optional(),
      }))
      .mutation(({ input }) => startLongCatMessagingSession({
        userId: input.userId ?? null,
        customerPhone: input.customerPhone ?? null,
        customerName: input.customerName ?? null,
        voiceChannel: input.messageChannel ?? "sms_ordering",
        accessibilityFlags: input.accessibilityFlags ?? [],
        idempotencyKey: input.idempotencyKey ?? null,
        triggerReason: input.triggerReason ?? null,
      })),
    appendVoiceTurn: protectedProcedure
      .input(z.object({
        sessionId: z.string().uuid(),
        speaker: z.enum(["customer", "agent", "system"]),
        utterance: z.string().trim().min(1).max(4_000),
        channel: z.string().trim().min(2).max(64).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }))
      .mutation(({ input }) => appendLongCatVoiceTurn({
        sessionId: input.sessionId,
        speaker: input.speaker,
        utterance: input.utterance,
        channel: input.channel,
        metadata: input.metadata,
      })),
    appendMessagingTurn: protectedProcedure
      .input(z.object({
        sessionId: z.string().uuid(),
        speaker: z.enum(["customer", "agent", "system"]),
        utterance: z.string().trim().min(1).max(4_000),
        channel: z.string().trim().min(2).max(64).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        dispatchReply: z.boolean().optional(),
      }))
      .mutation(({ input }) => appendLongCatMessagingTurn({
        sessionId: input.sessionId,
        speaker: input.speaker,
        utterance: input.utterance,
        channel: input.channel,
        metadata: input.metadata,
        dispatchReply: input.dispatchReply,
      })),
    executeAction: protectedProcedure
      .input(z.object({
        sessionId: z.string().uuid().optional(),
        customerPhone: z.string().trim().min(5).max(64).optional(),
        customerName: z.string().trim().min(1).max(255).optional(),
        merchantName: z.string().trim().min(1).max(255).optional(),
        kind: z.enum(["sms_followup", "merchant_callback", "service_recovery_credit", "reservation_booking"]),
        reason: z.string().trim().min(3).max(500),
        notes: z.string().trim().min(1).max(2000).optional(),
        reservation: z.object({
          partySize: z.number().int().positive(),
          requestedAt: z.string().trim().min(5).max(128),
          location: z.string().trim().min(2).max(255),
        }).optional(),
        compensation: z.object({
          amount: z.number().positive(),
          currency: z.string().trim().min(3).max(12),
          incidentType: z.string().trim().min(2).max(255),
        }).optional(),
      }))
      .mutation(({ input }) => executeLongCatAction({
        sessionId: input.sessionId ?? null,
        customerPhone: input.customerPhone ?? null,
        customerName: input.customerName ?? null,
        merchantName: input.merchantName ?? null,
        kind: input.kind,
        reason: input.reason,
        notes: input.notes ?? null,
        reservation: input.reservation ?? null,
        compensation: input.compensation ?? null,
      })),
  }),
});

export type AppRouter = typeof appRouter;
