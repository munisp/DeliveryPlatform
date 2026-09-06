import { z } from "zod";

import { TRPCError } from "@trpc/server";
import {
  analyticsReadProcedure,
  authenticatedProcedure,
  protectedProcedure,
  publicProcedure,
  router,
  workspaceReadProcedure,
} from "./_core/trpc";
import { systemRouter } from "./_core/systemRouter";
import {
  getDriverMobilityWorkspace,
  getMerchantChannelWorkspace,
  getPhoneOrderingWorkspace,
  getServiceRecoveryWorkspace,
  getTablesideWorkspace,
  getWhiteLabelAppsWorkspace,
} from "./lib/platformWorkspaces";
import {
  getLakehouseAnalyticsSummary,
  getLakehouseDriverStats,
  getLakehouseMarketplaceOverview,
  getLakehouseOrderStats,
  syncLakehouseFromPostgres,
} from "./lib/lakehouse";
import { getFundsReconciliationSnapshot } from "./db";
import {
  appendLongCatMessagingTurn,
  appendLongCatVoiceTurn,
  getLongCatCustomerMemory,
  startLongCatMessagingSession,
  startLongCatVoiceSession,
} from "./_core/longcatVoice";
import { executeLongCatAction } from "./_core/longcatActions";
import {
  buildLocalCommerceLogisticsControlTower,
  buildLocalCommerceSuperGatewayWorkspace,
  planLocalCommerceConciergeIntent,
} from "./_core/localCommerceSuperGateway";
import {
  applyLoyaltyIntervention,
  executeMerchantGrowthCampaign,
  getSupplyChainGrowthControl,
  queueReplenishmentWorkflow,
} from "./_core/supplyChainCommandCenter";
import {
  advanceWorkOrder,
  assignWorkOrder,
  cancelWorkOrder,
  completeWorkOrder,
  createWorkOrder,
  getWorkOrderDetail,
  listWorkOrders,
  recordWorkOrderProof,
  scheduleWorkOrder,
  setTechnicianServiceArea,
  upsertServiceArea,
  upsertTechnician,
} from "./_core/fieldService";
import {
  createDeveloperApiClient,
  createDeveloperApiKey,
  createDeveloperWebhookEndpoint,
  listDeveloperApiClients,
  listDeveloperApiKeys,
  listDeveloperWebhookEndpoints,
  revokeDeveloperApiKey,
} from "./_core/developerApi";
import {
  listCommerceFulfillmentRequests,
  transitionCommerceFulfillment,
  upsertMedusaStoreConnection,
} from "./_core/commerceFulfillment";

const listInput = z
  .object({ limit: z.number().min(1).max(25).optional() })
  .optional();

async function requireLakehouseAnalytics<T>(loader: () => Promise<T>) {
  try {
    await syncLakehouseFromPostgres();
    return await loader();
  } catch (error) {
    console.warn("[SwitchOS] Lakehouse analytics unavailable:", error);
    throw new TRPCError({
      code: "SERVICE_UNAVAILABLE",
      message: "LAKEHOUSE_ANALYTICS_UNAVAILABLE",
      cause: error,
    });
  }
}

async function requireWorkspaceData<T>(
  workspace: string,
  loader: () => Promise<T>,
) {
  try {
    return await loader();
  } catch (error) {
    console.warn(`[SwitchOS] ${workspace} workspace unavailable:`, error);
    throw new TRPCError({
      code: "SERVICE_UNAVAILABLE",
      message: `${workspace.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_DATA_UNAVAILABLE`,
      cause: error,
    });
  }
}

export const appRouter = router({
  system: systemRouter,

  auth: router({
    me: publicProcedure.query(({ ctx }) => ctx.user),
  }),

  analytics: router({
    summary: analyticsReadProcedure.query(() =>
      requireLakehouseAnalytics(() => getLakehouseAnalyticsSummary()),
    ),
    orderStats: analyticsReadProcedure.query(() =>
      requireLakehouseAnalytics(() => getLakehouseOrderStats()),
    ),
    driverStats: analyticsReadProcedure.query(() =>
      requireLakehouseAnalytics(() => getLakehouseDriverStats()),
    ),
    marketplaceOverview: analyticsReadProcedure.query(() =>
      requireLakehouseAnalytics(() => getLakehouseMarketplaceOverview()),
    ),
    fundsReconciliation: analyticsReadProcedure.query(async () =>
      getFundsReconciliationSnapshot(),
    ),
  }),

  driverMobility: router({
    summary: workspaceReadProcedure
      .input(listInput)
      .query(({ input }) =>
        requireWorkspaceData("driver_mobility", () =>
          getDriverMobilityWorkspace(input?.limit),
        ),
      ),
  }),

  tablesideOrdering: router({
    summary: workspaceReadProcedure
      .input(listInput)
      .query(() =>
        requireWorkspaceData("tableside_ordering", () =>
          getTablesideWorkspace(),
        ),
      ),
  }),

  whiteLabelApps: router({
    summary: workspaceReadProcedure
      .input(listInput)
      .query(() =>
        requireWorkspaceData("white_label_apps", () =>
          getWhiteLabelAppsWorkspace(),
        ),
      ),
  }),

  merchantChannels: router({
    workspace: workspaceReadProcedure.query(() =>
      requireWorkspaceData("merchant_channels", () =>
        getMerchantChannelWorkspace(),
      ),
    ),
  }),

  serviceRecovery: router({
    workspace: workspaceReadProcedure.query(() =>
      requireWorkspaceData("service_recovery", () =>
        getServiceRecoveryWorkspace(),
      ),
    ),
  }),

  localCommerceSuperGateway: router({
    workspace: workspaceReadProcedure.query(() =>
      buildLocalCommerceSuperGatewayWorkspace(),
    ),
    logisticsControlTower: workspaceReadProcedure
      .input(
        z
          .object({
            city: z.string().trim().min(2).max(128).optional(),
            forceRefresh: z.boolean().optional(),
          })
          .optional(),
      )
      .query(({ input }) =>
        buildLocalCommerceLogisticsControlTower({
          city: input?.city,
          forceRefresh: input?.forceRefresh,
        }),
      ),
    supplyChainGrowthControl: workspaceReadProcedure
      .input(
        z
          .object({
            city: z.string().trim().min(2).max(128).optional(),
            forceRefresh: z.boolean().optional(),
          })
          .optional(),
      )
      .query(({ input }) =>
        getSupplyChainGrowthControl({
          city: input?.city,
          forceRefresh: input?.forceRefresh,
        }),
      ),
    queueReplenishment: protectedProcedure
      .input(
        z.object({
          city: z.string().trim().min(2).max(128),
          planningHorizonHours: z.number().int().min(4).max(720).optional(),
          trigger: z.string().trim().min(2).max(128).optional(),
          requestedBy: z.string().trim().min(2).max(255).optional(),
          workflowReason: z.string().trim().min(3).max(500).optional(),
          traceId: z.string().trim().min(3).max(128).optional(),
          skus: z
            .array(
              z.object({
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
                targetTransferNodeName: z
                  .string()
                  .trim()
                  .min(1)
                  .max(255)
                  .optional(),
              }),
            )
            .min(1)
            .max(200),
        }),
      )
      .mutation(({ input }) => queueReplenishmentWorkflow(input)),
    loyaltyIntervention: protectedProcedure
      .input(
        z.object({
          userId: z.number().int().positive(),
          points: z.number().int().optional(),
          transactionType: z.string().trim().min(2).max(128).optional(),
          description: z.string().trim().min(3).max(500).optional(),
          orderId: z.number().int().positive().optional(),
          rewardId: z.number().int().positive().optional(),
          idempotencyKey: z.string().trim().min(3).max(255).optional(),
        }),
      )
      .mutation(({ input }) => applyLoyaltyIntervention(input)),
    merchantGrowthCampaign: protectedProcedure
      .input(
        z.object({
          campaignId: z.number().int().positive().optional(),
          campaignName: z.string().trim().min(2).max(255).optional(),
          campaignType: z.string().trim().min(2).max(128).optional(),
          emailTemplate: z.string().trim().min(3).max(5000).optional(),
          smsTemplate: z.string().trim().min(3).max(1000).optional(),
          targetAudience: z.string().trim().min(2).max(128).optional(),
          triggerCondition: z.record(z.string(), z.any()).optional(),
          activate: z.boolean().optional(),
          audienceMode: z.enum(["single_user", "full_audience"]).optional(),
          userId: z.number().int().positive().optional(),
          channel: z.enum(["email", "sms"]).optional(),
          idempotencyKey: z.string().trim().min(3).max(255).optional(),
        }),
      )
      .mutation(({ input }) => executeMerchantGrowthCampaign(input)),
    plan: protectedProcedure
      .input(
        z.object({
          city: z.string().trim().min(2).max(128).optional(),
          customerSegment: z.string().trim().min(2).max(128).optional(),
          categories: z
            .array(z.string().trim().min(2).max(64))
            .max(8)
            .optional(),
          request: z.string().trim().min(3).max(1_000),
          basket: z
            .array(
              z.object({
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
              }),
            )
            .max(20)
            .optional(),
          warehouseCandidates: z
            .array(
              z.object({
                warehouseId: z.number().int().positive(),
                label: z.string().trim().min(1).max(255),
                zoneKey: z.string().trim().min(1).max(128).optional(),
                distanceKm: z.number().min(0).max(200),
                pickPackMinutes: z.number().min(0).max(240).optional(),
                coldChainReady: z.boolean().optional(),
                stockAccuracy: z.number().min(0).max(1).optional(),
                inventory: z
                  .array(
                    z.object({
                      sku: z.string().trim().min(1).max(128),
                      availableUnits: z.number().min(0),
                      freshnessHours: z.number().min(0).max(720).optional(),
                    }),
                  )
                  .max(50),
              }),
            )
            .max(12)
            .optional(),
        }),
      )
      .mutation(({ input }) => planLocalCommerceConciergeIntent(input)),
  }),

  fieldService: router({
    listWorkOrders: authenticatedProcedure
      .input(
        z
          .object({
            state: z
              .enum([
                "requested",
                "scheduled",
                "assigned",
                "en_route",
                "on_site",
                "completed",
                "cancelled",
              ])
              .optional(),
            limit: z.number().int().min(1).max(100).optional(),
          })
          .optional(),
      )
      .query(({ ctx, input }) =>
        listWorkOrders({
          actorUserId: ctx.user!.id,
          state: input?.state,
          limit: input?.limit ?? 50,
        }),
      ),
    workOrderDetail: authenticatedProcedure
      .input(z.object({ workOrderId: z.string().uuid() }))
      .query(({ ctx, input }) =>
        getWorkOrderDetail({
          actorUserId: ctx.user!.id,
          workOrderId: input.workOrderId,
        }),
      ),
    upsertServiceArea: protectedProcedure
      .input(
        z.object({
          providerId: z.number().int().positive(),
          code: z
            .string()
            .trim()
            .regex(/^[a-z][a-z0-9_-]{2,63}$/),
          displayName: z.string().trim().min(2).max(160),
          boundaryGeoJson: z.object({
            type: z.literal("Polygon"),
            coordinates: z.array(z.array(z.array(z.number()))).min(1),
          }),
          timezone: z
            .string()
            .trim()
            .regex(/^[A-Za-z_]+\/[A-Za-z_]+$/),
          active: z.boolean().default(true),
        }),
      )
      .mutation(({ ctx, input }) =>
        upsertServiceArea({ actorUserId: ctx.user!.id, ...input }),
      ),
    upsertTechnician: protectedProcedure
      .input(
        z.object({
          userId: z.number().int().positive(),
          providerId: z.number().int().positive(),
          displayName: z.string().trim().min(2).max(160),
          employeeReference: z.string().trim().min(1).max(128).nullable(),
          skills: z.array(z.string().trim().min(1).max(96)).max(48),
          state: z.enum(["active", "suspended", "inactive"]),
        }),
      )
      .mutation(({ ctx, input }) =>
        upsertTechnician({ actorUserId: ctx.user!.id, ...input }),
      ),
    setTechnicianServiceArea: protectedProcedure
      .input(
        z.object({
          technicianUserId: z.number().int().positive(),
          serviceAreaId: z.string().uuid(),
          active: z.boolean(),
        }),
      )
      .mutation(({ ctx, input }) =>
        setTechnicianServiceArea({ actorUserId: ctx.user!.id, ...input }),
      ),
    createWorkOrder: protectedProcedure
      .input(
        z.object({
          customerId: z.number().int().positive(),
          providerId: z.number().int().positive(),
          serviceAreaId: z.string().uuid(),
          title: z.string().trim().min(3).max(180),
          description: z.string().trim().min(3).max(5000),
          serviceAddress: z.string().trim().min(3).max(500),
          latitude: z.number().min(-90).max(90).nullable(),
          longitude: z.number().min(-180).max(180).nullable(),
          priority: z
            .enum(["low", "normal", "high", "urgent"])
            .default("normal"),
          scheduledStartAt: z.string().datetime().nullable(),
          scheduledEndAt: z.string().datetime().nullable(),
          sourceOrderId: z.number().int().positive().nullable(),
          idempotencyKey: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        createWorkOrder({ actorUserId: ctx.user!.id, ...input }),
      ),
    scheduleWorkOrder: protectedProcedure
      .input(
        z.object({
          workOrderId: z.string().uuid(),
          scheduledStartAt: z.string().datetime(),
          scheduledEndAt: z.string().datetime(),
          idempotencyKey: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        scheduleWorkOrder({ actorUserId: ctx.user!.id, ...input }),
      ),
    assignWorkOrder: protectedProcedure
      .input(
        z.object({
          workOrderId: z.string().uuid(),
          technicianUserId: z.number().int().positive(),
          idempotencyKey: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        assignWorkOrder({ actorUserId: ctx.user!.id, ...input }),
      ),
    advanceWorkOrder: authenticatedProcedure
      .input(
        z.object({
          workOrderId: z.string().uuid(),
          action: z.enum(["depart", "arrive"]),
          note: z.string().trim().min(1).max(2000).nullable(),
          idempotencyKey: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        advanceWorkOrder({ technicianUserId: ctx.user!.id, ...input }),
      ),
    recordWorkOrderProof: authenticatedProcedure
      .input(
        z.object({
          workOrderId: z.string().uuid(),
          kind: z.enum(["arrival", "customer_signature", "equipment_serial"]),
          objectKey: z.string().trim().min(3).max(512),
          contentType: z.enum([
            "image/jpeg",
            "image/png",
            "image/heic",
            "application/pdf",
          ]),
          sha256Hex: z.string().regex(/^[a-f0-9]{64}$/),
          idempotencyKey: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        recordWorkOrderProof({ technicianUserId: ctx.user!.id, ...input }),
      ),
    completeWorkOrder: authenticatedProcedure
      .input(
        z.object({
          workOrderId: z.string().uuid(),
          completionSummary: z.string().trim().min(3).max(4000),
          objectKey: z.string().trim().min(3).max(512),
          contentType: z.enum([
            "image/jpeg",
            "image/png",
            "image/heic",
            "application/pdf",
          ]),
          sha256Hex: z.string().regex(/^[a-f0-9]{64}$/),
          idempotencyKey: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        completeWorkOrder({ technicianUserId: ctx.user!.id, ...input }),
      ),
    cancelWorkOrder: protectedProcedure
      .input(
        z.object({
          workOrderId: z.string().uuid(),
          reason: z.string().trim().min(3).max(1000),
          idempotencyKey: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        cancelWorkOrder({ actorUserId: ctx.user!.id, ...input }),
      ),
  }),

  commerceFulfillment: router({
    list: protectedProcedure
      .input(
        z
          .object({ limit: z.number().int().min(1).max(100).optional() })
          .optional(),
      )
      .query(({ ctx, input }) =>
        listCommerceFulfillmentRequests({
          actorUserId: ctx.user!.id,
          limit: input?.limit,
        }),
      ),
    transition: protectedProcedure
      .input(
        z.object({
          fulfillmentId: z.string().uuid(),
          action: z.enum([
            "accept",
            "assign",
            "dispatch",
            "deliver",
            "cancel",
            "fail",
          ]),
          detail: z.record(z.string(), z.unknown()).optional(),
          idempotencyKey: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        transitionCommerceFulfillment({ actorUserId: ctx.user!.id, ...input }),
      ),
    upsertMedusaStore: protectedProcedure
      .input(
        z.object({
          providerId: z.number().int().positive(),
          medusaStoreId: z.string().trim().min(3).max(160),
          baseUrl: z.string().url().max(1908),
          webhookSecretRef: z.string().trim().min(3).max(256),
          active: z.boolean(),
        }),
      )
      .mutation(({ ctx, input }) =>
        upsertMedusaStoreConnection({ actorUserId: ctx.user!.id, ...input }),
      ),
  }),

  developerPlatform: router({
    listClients: protectedProcedure.query(({ ctx }) =>
      listDeveloperApiClients({ actorUserId: ctx.user!.id }),
    ),
    listKeys: protectedProcedure
      .input(z.object({ apiClientId: z.string().uuid() }))
      .query(({ ctx, input }) =>
        listDeveloperApiKeys({ actorUserId: ctx.user!.id, ...input }),
      ),
    listWebhookEndpoints: protectedProcedure
      .input(z.object({ apiClientId: z.string().uuid() }))
      .query(({ ctx, input }) =>
        listDeveloperWebhookEndpoints({ actorUserId: ctx.user!.id, ...input }),
      ),
    createClient: protectedProcedure
      .input(
        z.object({
          providerId: z.number().int().positive(),
          displayName: z.string().trim().min(2).max(160),
        }),
      )
      .mutation(({ ctx, input }) =>
        createDeveloperApiClient({ actorUserId: ctx.user!.id, ...input }),
      ),
    createKey: protectedProcedure
      .input(
        z.object({
          apiClientId: z.string().uuid(),
          scopes: z
            .array(
              z.enum([
                "field_service:read",
                "field_service:write",
                "webhook:manage",
              ]),
            )
            .min(1)
            .max(8),
          expiresAt: z.string().datetime().nullable(),
        }),
      )
      .mutation(({ ctx, input }) =>
        createDeveloperApiKey({
          actorUserId: ctx.user!.id,
          ...input,
          expiresAt: input.expiresAt ?? null,
        }),
      ),
    revokeKey: protectedProcedure
      .input(z.object({ apiKeyId: z.string().uuid() }))
      .mutation(({ ctx, input }) =>
        revokeDeveloperApiKey({ actorUserId: ctx.user!.id, ...input }),
      ),
    createWebhookEndpoint: protectedProcedure
      .input(
        z.object({
          apiClientId: z.string().uuid(),
          url: z
            .string()
            .url()
            .max(1908)
            .refine((value) => value.startsWith("https://")),
          eventTypes: z
            .array(
              z.enum([
                "field_service.work_order.created",
                "field_service.work_order.scheduled",
                "field_service.work_order.assigned",
                "field_service.work_order.en_route",
                "field_service.work_order.arrived",
                "field_service.work_order.completed",
                "field_service.work_order.cancelled",
                "commerce.order.placed",
                "commerce.order.cancelled",
                "commerce.fulfillment.ready",
                "commerce.fulfillment.delivered",
              ]),
            )
            .min(1)
            .max(24),
          signingSecretRef: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        createDeveloperWebhookEndpoint({ actorUserId: ctx.user!.id, ...input }),
      ),
  }),

  phoneOrdering: router({
    workspace: workspaceReadProcedure.query(() =>
      requireWorkspaceData("phone_ordering", () => getPhoneOrderingWorkspace()),
    ),
    customerMemory: workspaceReadProcedure
      .input(
        z
          .object({
            userId: z.number().int().positive().optional(),
            customerPhone: z.string().trim().min(5).max(64).optional(),
            customerName: z.string().trim().min(1).max(255).optional(),
            accessibilityFlags: z
              .array(z.string().trim().min(1).max(64))
              .max(8)
              .optional(),
          })
          .optional(),
      )
      .query(({ input }) =>
        getLongCatCustomerMemory({
          userId: input?.userId ?? null,
          customerPhone: input?.customerPhone ?? null,
          customerName: input?.customerName ?? null,
          accessibilityFlags: input?.accessibilityFlags ?? [],
        }),
      ),
    startVoiceSession: protectedProcedure
      .input(
        z.object({
          userId: z.number().int().positive().optional(),
          customerPhone: z.string().trim().min(5).max(64).optional(),
          customerName: z.string().trim().min(1).max(255).optional(),
          voiceChannel: z.string().trim().min(2).max(64).optional(),
          accessibilityFlags: z
            .array(z.string().trim().min(1).max(64))
            .max(8)
            .optional(),
          idempotencyKey: z.string().trim().min(4).max(255).optional(),
          triggerReason: z.string().trim().min(2).max(255).optional(),
        }),
      )
      .mutation(({ input }) =>
        startLongCatVoiceSession({
          userId: input.userId ?? null,
          customerPhone: input.customerPhone ?? null,
          customerName: input.customerName ?? null,
          voiceChannel: input.voiceChannel ?? null,
          accessibilityFlags: input.accessibilityFlags ?? [],
          idempotencyKey: input.idempotencyKey ?? null,
          triggerReason: input.triggerReason ?? null,
        }),
      ),
    startMessagingSession: protectedProcedure
      .input(
        z.object({
          userId: z.number().int().positive().optional(),
          customerPhone: z.string().trim().min(5).max(64).optional(),
          customerName: z.string().trim().min(1).max(255).optional(),
          messageChannel: z.string().trim().min(2).max(64).optional(),
          accessibilityFlags: z
            .array(z.string().trim().min(1).max(64))
            .max(8)
            .optional(),
          idempotencyKey: z.string().trim().min(4).max(255).optional(),
          triggerReason: z.string().trim().min(2).max(255).optional(),
        }),
      )
      .mutation(({ input }) =>
        startLongCatMessagingSession({
          userId: input.userId ?? null,
          customerPhone: input.customerPhone ?? null,
          customerName: input.customerName ?? null,
          voiceChannel: input.messageChannel ?? "sms_ordering",
          accessibilityFlags: input.accessibilityFlags ?? [],
          idempotencyKey: input.idempotencyKey ?? null,
          triggerReason: input.triggerReason ?? null,
        }),
      ),
    appendVoiceTurn: protectedProcedure
      .input(
        z.object({
          sessionId: z.string().uuid(),
          speaker: z.enum(["customer", "agent", "system"]),
          utterance: z.string().trim().min(1).max(4_000),
          channel: z.string().trim().min(2).max(64).optional(),
          metadata: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .mutation(({ input }) =>
        appendLongCatVoiceTurn({
          sessionId: input.sessionId,
          speaker: input.speaker,
          utterance: input.utterance,
          channel: input.channel,
          metadata: input.metadata,
        }),
      ),
    appendMessagingTurn: protectedProcedure
      .input(
        z.object({
          sessionId: z.string().uuid(),
          speaker: z.enum(["customer", "agent", "system"]),
          utterance: z.string().trim().min(1).max(4_000),
          channel: z.string().trim().min(2).max(64).optional(),
          metadata: z.record(z.string(), z.unknown()).optional(),
          dispatchReply: z.boolean().optional(),
        }),
      )
      .mutation(({ input }) =>
        appendLongCatMessagingTurn({
          sessionId: input.sessionId,
          speaker: input.speaker,
          utterance: input.utterance,
          channel: input.channel,
          metadata: input.metadata,
          dispatchReply: input.dispatchReply,
        }),
      ),
    executeAction: protectedProcedure
      .input(
        z.object({
          sessionId: z.string().uuid().optional(),
          customerPhone: z.string().trim().min(5).max(64).optional(),
          customerName: z.string().trim().min(1).max(255).optional(),
          merchantName: z.string().trim().min(1).max(255).optional(),
          kind: z.enum([
            "sms_followup",
            "merchant_callback",
            "service_recovery_credit",
            "reservation_booking",
          ]),
          reason: z.string().trim().min(3).max(500),
          notes: z.string().trim().min(1).max(2000).optional(),
          reservation: z
            .object({
              partySize: z.number().int().positive(),
              requestedAt: z.string().trim().min(5).max(128),
              location: z.string().trim().min(2).max(255),
            })
            .optional(),
          compensation: z
            .object({
              amount: z.number().positive(),
              currency: z.string().trim().min(3).max(12),
              incidentType: z.string().trim().min(2).max(255),
            })
            .optional(),
        }),
      )
      .mutation(({ input }) =>
        executeLongCatAction({
          sessionId: input.sessionId ?? null,
          customerPhone: input.customerPhone ?? null,
          customerName: input.customerName ?? null,
          merchantName: input.merchantName ?? null,
          kind: input.kind,
          reason: input.reason,
          notes: input.notes ?? null,
          reservation: input.reservation ?? null,
          compensation: input.compensation ?? null,
        }),
      ),
  }),
});

export type AppRouter = typeof appRouter;
