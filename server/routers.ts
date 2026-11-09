import { z } from "zod";

import { TRPCError } from "@trpc/server";
import {
  analyticsReadProcedure,
  authenticatedProcedure,
  operatorMutationProcedure,
  protectedProcedure,
  publicProcedure,
  router,
  workspaceReadProcedure,
} from "./_core/trpc";
import { systemRouter } from "./_core/systemRouter";
import { mobilityRouter } from "./_core/mobilityRouter";
import { consolesRouter } from "./_core/consolesRouter";
import { compliancePacksRouter } from "./_core/compliancePacksRouter";
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
  getLakehouseDataFreshnessSeconds,
  getLakehouseDriverStats,
  getLakehouseMarketplaceOverview,
  getLakehouseOrderStats,
  invalidateLakehouseReadCache,
  syncLakehouseFromPostgres,
} from "./lib/lakehouse";
import { getFundsReconciliationSnapshot, getOrderRevenueTrend, getOrdersByVertical } from "./db";
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
  declineTransparentDriverOffer,
  listTransparentDriverOffers,
  setDriverDispatchFairnessPolicy,
  setDriverOfferEconomicsPolicy,
} from "./_core/driverDispatchFairness";
import {
  activateVehicleAsset,
  assignVehicleAssetLocation,
  cancelVehicleAvailabilityBlock,
  createFleetProvider,
  createVehicleAvailabilityBlock,
  createVehicleProviderLocation,
  createVehicleRentalAddOn,
  createVehicleOffer,
  createVehicleRentalGeofence,
  createVehicleTrackerProvider,
  decideVehicleContractExtension,
  getVehicleRentalOperationsSnapshot,
  getVehicleTrackerOperationsSnapshot,
  listVehicleAccessContracts,
  listVehicleAccessOffers,
  listVehicleRentalAddOns,
  recordAssetEvidence,
  recordVehicleAgreementAcceptance,
  recordVehicleInspection,
  recordVehicleRentalPaymentTrackingSignal,
  recordVehicleTrackerControlConsent,
  registerVehicleAsset,
  requestVehicleAccess,
  requestVehiclePreventNextStart,
  requestVehicleAccessWithAddOns,
  requestVehicleContractExtension,
  transitionVehicleAccessContract,
  authorizeVehiclePreventNextStart,
  cancelVehiclePreventNextStart,
  registerVehicleAssetTracker,
  upsertWorkerVehicleEligibility,
} from "./_core/vehicleAccess";
import {
  decideVerificationCase,
  enqueueVerificationProcessing,
  getVerificationChecks,
  listVerificationCases,
  recordVerificationConsent,
  recordVerificationEvidence,
  recordVerificationProviderCheck,
  startVerificationCase,
  withdrawVerificationConsent,
} from "./_core/stakeholderVerification";
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
  assignCommerceFulfillmentDriver,
  listCommerceFulfillmentRequests,
  registerExternalCommerceConnection,
  transitionCommerceFulfillment,
  upsertMedusaStoreConnection,
} from "./_core/commerceFulfillment";
import {
  beginMerchantOnboarding,
  createMerchantProduct,
  decideMerchantOnboarding,
  getMerchantCommerceProfile,
  setMerchantPaymentConfiguration,
  updateMerchantInventoryLevel,
  issueMerchantApiCredential,
  rotateMerchantApiCredential,
  revokeMerchantApiCredential,
} from "./_core/merchantCommerce";
import { getMerchantOnboardingProgress } from "./_core/merchantOnboarding";
import { selfserveRouter } from "./_core/selfserveRouter";
import { driverOnboardingRouter } from "./_core/driverOnboardingRouter";
import { approveExternalOperator } from "./_core/operatorAuthStore";
import { consumerRouter } from "./_core/consumerRouter";
import { riderVerificationRouter } from "./_core/riderVerificationRouter";
import { invalidateVerificationStatusCache } from "./_core/riderVerification";
import { verificationRouter } from "./_core/verificationRouter";
import { deactivationRouter } from "./_core/deactivationRouter";
import { councilRouter } from "./_core/councilRouter";
import { economicsRouter } from "./_core/economicsRouter";
import { pricingTransparencyRouter } from "./_core/pricingTransparencyRouter";
import { safetyRouter } from "./_core/safetyRouter";
import { incentivesRouter } from "./_core/incentivesRouter";
import { protectionRouter } from "./_core/protectionRouter";
import { transitionRouter } from "./_core/transitionRouter";
import { portabilityRouter } from "./_core/portabilityRouter";
import { contractDefaultsRouter } from "./_core/contractDefaultsRouter";
import { postConsultation } from "./_core/workerCouncil";

/**
 * Wave B1 (R5): worker-affecting economics mutations auto-post a worker
 * council consultation object before proceeding. Advisory and additive —
 * a consultation-post failure is logged and never blocks the mutation.
 */
async function autoPostEconomicsConsultation(input: {
  actorUserId: number;
  kind: "pricing" | "commission";
  title: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  try {
    await postConsultation(input.actorUserId, {
      kind: input.kind,
      title: input.title,
      payload: input.payload,
      responseSlaHours: 72,
    });
  } catch (error) {
    console.warn(
      "[economics] worker-council consultation auto-post failed; proceeding",
      error,
    );
  }
}

const listInput = z
  .object({ limit: z.number().min(1).max(25).optional() })
  .optional();

/**
 * Lakehouse analytics reads are decoupled from the Postgres→lakehouse sync
 * (perf finding 1): a background interval syncer started at server boot
 * (startLakehouseSyncer in server/lib/lakehouse.ts) keeps the lakehouse warm,
 * so these procedures read the lakehouse directly and report
 * `dataFreshnessSeconds` (seconds since the last completed sync, null when
 * the first sync has not finished yet). Only an explicit operator
 * `forceRefresh: true` runs the sync inline.
 */
async function requireLakehouseAnalytics<T extends Record<string, unknown>>(
  loader: () => Promise<T>,
  options: { forceRefresh?: boolean } = {},
) {
  try {
    if (options.forceRefresh) {
      await syncLakehouseFromPostgres();
      // syncLakehouseFromPostgres already drops the read cache on success;
      // invalidate defensively so a forced read never serves pre-refresh data.
      invalidateLakehouseReadCache();
    }
    const data = await loader();
    return {
      ...data,
      dataFreshnessSeconds: getLakehouseDataFreshnessSeconds(),
    };
  } catch (error) {
    console.warn("[SwitchOS] Lakehouse analytics unavailable:", error);
    throw new TRPCError({
      code: "SERVICE_UNAVAILABLE",
      message: "LAKEHOUSE_ANALYTICS_UNAVAILABLE",
      cause: error,
    });
  }
}

const lakehouseAnalyticsInput = z
  .object({ forceRefresh: z.boolean().optional() })
  .optional();

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
  compliancePacks: compliancePacksRouter,

  mobility: mobilityRouter,
  consoles: consolesRouter,

  auth: router({
    me: publicProcedure.query(({ ctx }) => ctx.user),
  }),

  // External OIDC operator provisioning is fail-closed (Audit A P0-3): new
  // external identities are inactive until an existing operator approves
  // them here.
  operatorOnboarding: router({
    approveExternalOperator: operatorMutationProcedure("write_platform")
      .input(z.object({ operatorId: z.number().int().positive() }))
      .mutation(async ({ input }) => {
        const approved = await approveExternalOperator(input.operatorId);
        if (!approved) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "operator_not_found",
          });
        }
        return approved;
      }),
  }),

  analytics: router({
    summary: analyticsReadProcedure
      .input(lakehouseAnalyticsInput)
      .query(({ input }) =>
        requireLakehouseAnalytics(() => getLakehouseAnalyticsSummary(), {
          forceRefresh: input?.forceRefresh,
        }),
      ),
    orderStats: analyticsReadProcedure
      .input(lakehouseAnalyticsInput)
      .query(({ input }) =>
        requireLakehouseAnalytics(() => getLakehouseOrderStats(), {
          forceRefresh: input?.forceRefresh,
        }),
      ),
    driverStats: analyticsReadProcedure
      .input(lakehouseAnalyticsInput)
      .query(({ input }) =>
        requireLakehouseAnalytics(() => getLakehouseDriverStats(), {
          forceRefresh: input?.forceRefresh,
        }),
      ),
    marketplaceOverview: analyticsReadProcedure
      .input(lakehouseAnalyticsInput)
      .query(({ input }) =>
        requireLakehouseAnalytics(() => getLakehouseMarketplaceOverview(), {
          forceRefresh: input?.forceRefresh,
        }),
      ),
    fundsReconciliation: analyticsReadProcedure.query(async () =>
      getFundsReconciliationSnapshot(),
    ),
    revenueTrend: analyticsReadProcedure.query(async () =>
      getOrderRevenueTrend(),
    ),
    ordersByVertical: analyticsReadProcedure.query(async () =>
      getOrdersByVertical(),
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
    queueReplenishment: operatorMutationProcedure("operate")
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
    loyaltyIntervention: operatorMutationProcedure("write_platform")
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
    merchantGrowthCampaign: operatorMutationProcedure("write_platform")
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
    upsertServiceArea: operatorMutationProcedure("operate")
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
    upsertTechnician: operatorMutationProcedure("operate")
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
    setTechnicianServiceArea: operatorMutationProcedure("operate")
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
    createWorkOrder: operatorMutationProcedure("operate")
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
    scheduleWorkOrder: operatorMutationProcedure("operate")
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
    assignWorkOrder: operatorMutationProcedure("operate")
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
    cancelWorkOrder: operatorMutationProcedure("operate")
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

  driverDispatchFairness: router({
    listMyOffers: authenticatedProcedure.query(({ ctx }) =>
      listTransparentDriverOffers(ctx.user!.id),
    ),
    declineOffer: authenticatedProcedure
      .input(
        z.object({
          offerId: z.string().uuid(),
          reason: z.enum([
            "pickup_distance_unprofitable",
            "pickup_time_unprofitable",
            "fare_insufficient",
            "destination_unsuitable",
            "safety_preference",
            "vehicle_constraint",
            "other",
          ]),
          idempotencyKey: z
            .string()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        declineTransparentDriverOffer({ driverUserId: ctx.user!.id, ...input }),
      ),
    setEconomicsPolicy: operatorMutationProcedure("write_platform")
      .input(
        z.object({
          zoneId: z.string().uuid(),
          version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/),
          driverTimeFloorKoboPerMin: z.number().int().min(1).max(1000000),
          driverDistanceFloorKoboPerKm: z.number().int().min(1).max(10000000),
          fuelCostIndexBp: z.number().int().min(5000).max(30000),
          maintenanceCostIndexBp: z.number().int().min(5000).max(30000),
          pickupSubsidyKoboPerKm: z.number().int().min(0).max(10000000),
          maxPickupSubsidyKobo: z.number().int().min(0).max(1000000000),
          platformVariableCostKobo: z.number().int().min(0).max(1000000000),
          platformContributionTargetKobo: z
            .number()
            .int()
            .min(0)
            .max(1000000000),
          effectiveFrom: z.string().datetime(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        await autoPostEconomicsConsultation({
          actorUserId: ctx.user!.id,
          kind: "pricing",
          title: `Driver offer economics policy ${input.version} (zone ${input.zoneId})`,
          payload: { ...input },
        });
        return setDriverOfferEconomicsPolicy({
          actorUserId: ctx.user!.id,
          ...input,
        });
      }),
    setPolicy: operatorMutationProcedure("write_platform")
      .input(
        z.object({
          zoneId: z.string().uuid(),
          version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/),
          platformCommissionBp: z.number().int().min(0).max(1500),
          maxPickupDistanceM: z.number().int().min(250).max(5000),
          maxPickupEtaS: z.number().int().min(60).max(1200),
          effectiveFrom: z.string().datetime(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        await autoPostEconomicsConsultation({
          actorUserId: ctx.user!.id,
          kind: "commission",
          title: `Dispatch fairness/commission policy ${input.version} (zone ${input.zoneId})`,
          payload: { ...input },
        });
        return setDriverDispatchFairnessPolicy({
          actorUserId: ctx.user!.id,
          ...input,
        });
      }),
  }),
  stakeholderVerification: router({
    listCases: authenticatedProcedure
      .input(
        z
          .object({ limit: z.number().int().min(1).max(100).optional() })
          .optional(),
      )
      .query(({ ctx, input }) =>
        listVerificationCases(ctx.user!.id, input?.limit ?? 50),
      ),
    getChecks: authenticatedProcedure
      .input(z.object({ caseId: z.string().uuid() }))
      .query(({ ctx, input }) =>
        getVerificationChecks(ctx.user!.id, input.caseId),
      ),
    startCase: authenticatedProcedure
      .input(
        z.object({
          subjectType: z.enum([
            "driver",
            "vehicle_asset",
            "field_technician",
            "merchant",
            "fleet_provider",
            "operator",
          ]),
          subjectKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/),
          jurisdiction: z.string().regex(/^[A-Z]{2}(-[A-Z0-9]{1,12})?$/),
          purpose: z.string().regex(/^[a-z][a-z0-9_.-]{2,63}$/),
          idempotencyKey: z
            .string()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        startVerificationCase({
          actorUserId: ctx.user!.id,
          subjectUserId: ctx.user!.id,
          ...input,
        }),
      ),
    recordConsent: authenticatedProcedure
      .input(
        z.object({
          caseId: z.string().uuid(),
          consentVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
          disclosureDigestHex: z.string().regex(/^[a-f0-9]{64}$/),
          expiresAt: z.string().datetime(),
          idempotencyKey: z
            .string()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        recordVerificationConsent({ actorUserId: ctx.user!.id, ...input }),
      ),
    withdrawConsent: authenticatedProcedure
      .input(
        z.object({
          caseId: z.string().uuid(),
          idempotencyKey: z
            .string()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        withdrawVerificationConsent({ actorUserId: ctx.user!.id, ...input }),
      ),
    recordEvidence: authenticatedProcedure
      .input(
        z.object({
          caseId: z.string().uuid(),
          evidenceKind: z.string().regex(/^[a-z][a-z0-9_.-]{2,63}$/),
          objectKey: z
            .string()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]+$/)
            .max(512),
          contentType: z.enum([
            "application/pdf",
            "image/jpeg",
            "image/png",
            "image/heic",
            "video/mp4",
          ]),
          sha256Hex: z.string().regex(/^[a-f0-9]{64}$/),
          captureMetadata: z.record(z.string(), z.unknown()),
          idempotencyKey: z
            .string()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        recordVerificationEvidence({ actorUserId: ctx.user!.id, ...input }),
      ),
    enqueueProcessing: authenticatedProcedure
      .input(
        z.object({
          caseId: z.string().uuid(),
          evidenceId: z.string().uuid(),
          processor: z.enum([
            "paddleocr",
            "docling",
            "vlm_document",
            "liveness",
            "document_forensics",
          ]),
          idempotencyKey: z
            .string()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        enqueueVerificationProcessing({ actorUserId: ctx.user!.id, ...input }),
      ),
    recordProviderCheck: operatorMutationProcedure("operate")
      .input(
        z.object({
          caseId: z.string().uuid(),
          checkType: z.enum([
            "identity_document",
            "liveness",
            "driving_licence",
            "criminal_record",
            "sanctions",
            "vehicle_registry",
            "commercial_insurance",
            "technician_credential",
            "beneficial_owner",
            "operator_recertification",
          ]),
          providerKey: z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/),
          state: z.enum([
            "passed",
            "failed",
            "manual_review",
            "unavailable",
            "expired",
          ]),
          providerReference: z.string().min(3).max(200).nullable().optional(),
          responseDigestHex: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .nullable()
            .optional(),
          expiresAt: z.string().datetime().nullable().optional(),
          detailCode: z
            .string()
            .regex(/^[a-z][a-z0-9_.-]{2,95}$/)
            .nullable()
            .optional(),
          idempotencyKey: z
            .string()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        recordVerificationProviderCheck({
          actorUserId: ctx.user!.id,
          ...input,
        }),
      ),
    decideCase: operatorMutationProcedure("operate")
      .input(
        z.object({
          caseId: z.string().uuid(),
          decision: z.enum(["verify", "reject", "suspend", "expire"]),
          reason: z.string().trim().min(3).max(1000),
          expiresAt: z.string().datetime().nullable().optional(),
          idempotencyKey: z
            .string()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const state = await decideVerificationCase({ actorUserId: ctx.user!.id, ...input });
        // Perf W2 (cross-branch): an operator decision can change a rider's
        // verification status; drop the cached status views (W2a hot cache,
        // 30s TTL) so riders see the decision immediately. No argument clears
        // the whole (small, TTL-bounded) cache; decisions are rare.
        invalidateVerificationStatusCache();
        return state;
      }),
  }),
  vehicleAccess: router({
    listOffers: authenticatedProcedure
      .input(
        z
          .object({ limit: z.number().int().min(1).max(100).optional() })
          .optional(),
      )
      .query(({ input }) => listVehicleAccessOffers(input?.limit ?? 50)),
    listContracts: authenticatedProcedure
      .input(
        z
          .object({ limit: z.number().int().min(1).max(100).optional() })
          .optional(),
      )
      .query(({ ctx, input }) =>
        listVehicleAccessContracts({
          actorUserId: ctx.user!.id,
          limit: input?.limit ?? 50,
        }),
      ),
    requestContract: authenticatedProcedure
      .input(
        z.object({
          offerId: z.string().uuid(),
          startsAt: z.string().datetime(),
          endsAt: z.string().datetime(),
          idempotencyKey: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        requestVehicleAccess({ workerUserId: ctx.user!.id, ...input }),
      ),
    listRentalAddOns: authenticatedProcedure
      .input(
        z.object({
          offerId: z.string().uuid(),
          limit: z.number().int().min(1).max(24).optional(),
        }),
      )
      .query(({ input }) =>
        listVehicleRentalAddOns({
          offerId: input.offerId,
          limit: input.limit ?? 24,
        }),
      ),
    rentalOperationsSnapshot: authenticatedProcedure.query(({ ctx }) =>
      getVehicleRentalOperationsSnapshot(ctx.user!.id),
    ),
    requestContractWithAddOns: authenticatedProcedure
      .input(
        z.object({
          offerId: z.string().uuid(),
          startsAt: z.string().datetime(),
          endsAt: z.string().datetime(),
          addOns: z
            .array(
              z.object({
                addOnVersionId: z.string().uuid(),
                quantity: z.number().int().min(1).max(8),
              }),
            )
            .max(8),
          idempotencyKey: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        requestVehicleAccessWithAddOns({
          workerUserId: ctx.user!.id,
          ...input,
        }),
      ),
    acceptAgreement: authenticatedProcedure
      .input(
        z.object({
          contractId: z.string().uuid(),
          agreementVersion: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/),
          agreementSha256Hex: z.string().regex(/^[a-f0-9]{64}$/),
          acceptanceSha256Hex: z.string().regex(/^[a-f0-9]{64}$/),
          idempotencyKey: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        recordVehicleAgreementAcceptance({
          workerUserId: ctx.user!.id,
          ...input,
        }),
      ),
    requestExtension: authenticatedProcedure
      .input(
        z.object({
          contractId: z.string().uuid(),
          requestedEndsAt: z.string().datetime(),
          idempotencyKey: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        requestVehicleContractExtension({
          workerUserId: ctx.user!.id,
          ...input,
        }),
      ),
    recordInspection: authenticatedProcedure
      .input(
        z.object({
          contractId: z.string().uuid(),
          kind: z.enum(["handover", "return"]),
          objectKey: z.string().trim().min(3).max(512),
          contentType: z.enum([
            "image/jpeg",
            "image/png",
            "image/heic",
            "application/pdf",
          ]),
          sha256Hex: z.string().regex(/^[a-f0-9]{64}$/),
          odometerKm: z.number().int().min(0).max(5000000),
          idempotencyKey: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        recordVehicleInspection({ actorUserId: ctx.user!.id, ...input }),
      ),
    transition: authenticatedProcedure
      .input(
        z.object({
          contractId: z.string().uuid(),
          action: z.enum(["begin_return", "cancel"]),
          reason: z.string().trim().min(3).max(1000).nullable(),
          idempotencyKey: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        transitionVehicleAccessContract({
          actorUserId: ctx.user!.id,
          ...input,
        }),
      ),
    createProvider: operatorMutationProcedure("operate")
      .input(
        z.object({
          displayName: z.string().trim().min(2).max(160),
          legalName: z.string().trim().min(2).max(255),
        }),
      )
      .mutation(({ ctx, input }) =>
        createFleetProvider({ actorUserId: ctx.user!.id, ...input }),
      ),
    verifyWorkerEligibility: operatorMutationProcedure("operate")
      .input(
        z.object({
          workerUserId: z.number().int().positive(),
          allowedWorkCategories: z
            .array(
              z.enum(["ride_hailing", "delivery", "courier", "field_service"]),
            )
            .min(1)
            .max(4),
          expiresAt: z.string().datetime(),
        }),
      )
      .mutation(({ ctx, input }) =>
        upsertWorkerVehicleEligibility({ actorUserId: ctx.user!.id, ...input }),
      ),
    registerAsset: operatorMutationProcedure("operate")
      .input(
        z.object({
          providerId: z.string().uuid(),
          registrationNumber: z.string().trim().min(3).max(32),
          vinSha256: z.string().regex(/^[a-f0-9]{64}$/),
          make: z.string().trim().min(1).max(80),
          model: z.string().trim().min(1).max(120),
          manufactureYear: z.number().int().min(1990).max(2100),
          odometerKm: z.number().int().min(0).max(5000000),
          passengerCapacity: z.number().int().min(1).max(8),
          allowedWorkCategories: z
            .array(
              z.enum(["ride_hailing", "delivery", "courier", "field_service"]),
            )
            .min(1)
            .max(4),
        }),
      )
      .mutation(({ ctx, input }) =>
        registerVehicleAsset({ actorUserId: ctx.user!.id, ...input }),
      ),
    recordAssetEvidence: operatorMutationProcedure("operate")
      .input(
        z.object({
          assetId: z.string().uuid(),
          kind: z.enum([
            "registration",
            "roadworthiness",
            "commercial_cover",
            "ownership_authority",
            "inspection",
          ]),
          objectKey: z.string().trim().min(3).max(512),
          sha256Hex: z.string().regex(/^[a-f0-9]{64}$/),
          expiresAt: z.string().datetime().nullable(),
          idempotencyKey: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        recordAssetEvidence({ actorUserId: ctx.user!.id, ...input }),
      ),
    activateAsset: operatorMutationProcedure("operate")
      .input(
        z.object({
          assetId: z.string().uuid(),
          idempotencyKey: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        activateVehicleAsset({ actorUserId: ctx.user!.id, ...input }),
      ),
    createOffer: operatorMutationProcedure("operate")
      .input(
        z.object({
          providerId: z.string().uuid(),
          assetId: z.string().uuid(),
          currency: z.string().regex(/^[A-Z]{3}$/),
          weeklyPriceMinor: z.number().int().positive().max(1000000000),
          depositMinor: z.number().int().min(0).max(1000000000),
          includedKmPerWeek: z.number().int().min(0).max(100000),
          excessKmPriceMinor: z.number().int().min(0).max(100000000),
          minimumDays: z.number().int().min(1).max(365),
        }),
      )
      .mutation(({ ctx, input }) =>
        createVehicleOffer({ actorUserId: ctx.user!.id, ...input }),
      ),
    createProviderLocation: operatorMutationProcedure("operate")
      .input(
        z.object({
          providerId: z.string().uuid(),
          locationCode: z
            .string()
            .trim()
            .regex(/^[A-Z0-9][A-Z0-9_-]{1,31}$/),
          displayName: z.string().trim().min(2).max(160),
          addressSummary: z.string().trim().min(3).max(400),
          timezoneName: z
            .string()
            .trim()
            .regex(/^[A-Za-z_]+\/[A-Za-z_]+$/),
          idempotencyKey: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        createVehicleProviderLocation({ actorUserId: ctx.user!.id, ...input }),
      ),
    assignAssetLocation: operatorMutationProcedure("operate")
      .input(
        z.object({
          assetId: z.string().uuid(),
          locationId: z.string().uuid(),
          idempotencyKey: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        assignVehicleAssetLocation({ actorUserId: ctx.user!.id, ...input }),
      ),
    createAvailabilityBlock: operatorMutationProcedure("operate")
      .input(
        z.object({
          assetId: z.string().uuid(),
          reason: z.enum([
            "maintenance",
            "inspection",
            "operator_hold",
            "seasonal_unavailable",
            "repair",
          ]),
          note: z.string().trim().min(3).max(1000),
          startsAt: z.string().datetime(),
          endsAt: z.string().datetime(),
          idempotencyKey: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        createVehicleAvailabilityBlock({ actorUserId: ctx.user!.id, ...input }),
      ),
    cancelAvailabilityBlock: operatorMutationProcedure("operate")
      .input(
        z.object({
          availabilityBlockId: z.string().uuid(),
          reason: z.string().trim().min(3).max(1000),
          idempotencyKey: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        cancelVehicleAvailabilityBlock({ actorUserId: ctx.user!.id, ...input }),
      ),
    createRentalAddOn: operatorMutationProcedure("operate")
      .input(
        z.object({
          providerId: z.string().uuid(),
          addOnCode: z
            .string()
            .trim()
            .regex(/^[a-z][a-z0-9_-]{1,62}$/),
          displayName: z.string().trim().min(2).max(120),
          category: z.enum([
            "protection",
            "equipment",
            "fuel_plan",
            "additional_driver",
            "assistance",
            "other",
          ]),
          currency: z.string().regex(/^[A-Z]{3}$/),
          chargeUnit: z.enum(["flat", "per_day", "per_week"]),
          unitPriceMinor: z.number().int().min(0).max(1000000000),
          maxQuantity: z.number().int().min(1).max(8),
          idempotencyKey: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        createVehicleRentalAddOn({ actorUserId: ctx.user!.id, ...input }),
      ),
    decideExtension: operatorMutationProcedure("operate")
      .input(
        z.object({
          extensionRequestId: z.string().uuid(),
          action: z.enum(["approve", "reject"]),
          reason: z.string().trim().min(3).max(1000).nullable(),
          idempotencyKey: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        decideVehicleContractExtension({ actorUserId: ctx.user!.id, ...input }),
      ),
    trackerOperationsSnapshot: authenticatedProcedure.query(({ ctx }) =>
      getVehicleTrackerOperationsSnapshot(ctx.user!.id),
    ),
    recordTrackerControlConsent: authenticatedProcedure
      .input(
        z.object({
          contractId: z.string().uuid(),
          consentVersion: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/),
          consentSha256Hex: z.string().regex(/^[a-f0-9]{64}$/),
          idempotencyKey: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        recordVehicleTrackerControlConsent({
          workerUserId: ctx.user!.id,
          ...input,
        }),
      ),
    createTrackerProvider: operatorMutationProcedure("operate")
      .input(
        z.object({
          fleetProviderId: z.string().uuid(),
          providerKind: z.enum([
            "generic_webhook",
            "samsara_webhook",
            "geotab_feed",
            "traccar_rest",
            "oem_gateway",
            "aftermarket_gateway",
          ]),
          integrationKey: z
            .string()
            .trim()
            .regex(/^[a-z][a-z0-9_.-]{2,80}$/),
          displayName: z.string().trim().min(2).max(160),
          credentialRef: z.string().trim().min(8).max(160),
          idempotencyKey: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        createVehicleTrackerProvider({ actorUserId: ctx.user!.id, ...input }),
      ),
    registerAssetTracker: operatorMutationProcedure("operate")
      .input(
        z.object({
          assetId: z.string().uuid(),
          trackerProviderId: z.string().uuid(),
          externalDeviceId: z.string().trim().min(3).max(160),
          deviceIdentifierSha256: z.string().regex(/^[a-f0-9]{64}$/),
          supportsPreventNextStart: z.boolean(),
          idempotencyKey: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        registerVehicleAssetTracker({ actorUserId: ctx.user!.id, ...input }),
      ),
    createRentalAssetGeofence: operatorMutationProcedure("operate")
      .input(
        z.object({
          assetId: z.string().uuid(),
          geofenceKind: z.enum(["restricted", "return_zone", "service_zone"]),
          code: z
            .string()
            .trim()
            .regex(/^[A-Z0-9][A-Z0-9_-]{1,62}$/),
          displayName: z.string().trim().min(2).max(160),
          geojson: z.object({
            type: z.literal("MultiPolygon"),
            coordinates: z
              .array(
                z
                  .array(
                    z
                      .array(
                        z
                          .array(z.number())
                          .length(2)
                          .refine(
                            ([longitude, latitude]) =>
                              longitude >= -180 &&
                              longitude <= 180 &&
                              latitude >= -90 &&
                              latitude <= 90,
                            "invalid longitude or latitude",
                          ),
                      )
                      .min(4)
                      .max(200),
                  )
                  .min(1)
                  .max(32),
              )
              .min(1)
              .max(16),
          }),
          idempotencyKey: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        createVehicleRentalGeofence({ actorUserId: ctx.user!.id, ...input }),
      ),
    recordRentalPaymentTrackingSignal: operatorMutationProcedure("operate")
      .input(
        z.object({
          contractId: z.string().uuid(),
          paymentReferenceSha256Hex: z.string().regex(/^[a-f0-9]{64}$/),
          state: z.enum(["past_due", "cured", "disputed", "unknown"]),
          effectiveAt: z.string().datetime(),
          graceEndsAt: z.string().datetime().nullable(),
          evidenceSha256Hex: z.string().regex(/^[a-f0-9]{64}$/),
          source: z
            .string()
            .trim()
            .regex(/^[a-z][a-z0-9_.-]{2,80}$/),
          idempotencyKey: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        recordVehicleRentalPaymentTrackingSignal({
          actorUserId: ctx.user!.id,
          ...input,
        }),
      ),
    requestPreventNextStart: operatorMutationProcedure("operate")
      .input(
        z.object({
          contractId: z.string().uuid(),
          paymentTrackingSignalId: z.string().uuid(),
          reasonCode: z
            .string()
            .trim()
            .regex(/^[a-z][a-z0-9_.-]{2,95}$/),
          idempotencyKey: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        requestVehiclePreventNextStart({ actorUserId: ctx.user!.id, ...input }),
      ),
    authorizePreventNextStart: operatorMutationProcedure("operate")
      .input(
        z.object({
          controlCaseId: z.string().uuid(),
          idempotencyKey: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        authorizeVehiclePreventNextStart({
          actorUserId: ctx.user!.id,
          ...input,
        }),
      ),
    cancelPreventNextStart: operatorMutationProcedure("operate")
      .input(
        z.object({
          controlCaseId: z.string().uuid(),
          reason: z.string().trim().min(3).max(1000),
          idempotencyKey: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        cancelVehiclePreventNextStart({ actorUserId: ctx.user!.id, ...input }),
      ),
    operateTransition: operatorMutationProcedure("operate")
      .input(
        z.object({
          contractId: z.string().uuid(),
          action: z.enum([
            "approve",
            "handover",
            "close",
            "suspend",
            "begin_safe_return",
          ]),
          reason: z.string().trim().min(3).max(1000).nullable(),
          idempotencyKey: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        transitionVehicleAccessContract({
          actorUserId: ctx.user!.id,
          ...input,
        }),
      ),
  }),

  merchantCommerce: router({
    beginOnboarding: authenticatedProcedure
      .input(
        z.object({
          providerId: z.number().int().positive(),
          legalName: z.string().trim().min(2).max(255),
          displayName: z.string().trim().min(2).max(160),
          medusaStoreId: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/),
          idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        beginMerchantOnboarding({ actorUserId: ctx.user!.id, ...input }),
      ),
    profile: authenticatedProcedure
      .input(z.object({ providerId: z.number().int().positive() }))
      .query(({ ctx, input }) =>
        getMerchantCommerceProfile({ actorUserId: ctx.user!.id, ...input }),
      ),
    onboardingProgress: authenticatedProcedure
      .input(z.object({ providerId: z.number().int().positive() }))
      .query(({ ctx, input }) =>
        getMerchantOnboardingProgress({ actorUserId: ctx.user!.id, ...input }),
      ),
    decideOnboarding: operatorMutationProcedure("operate")
      .input(
        z.object({
          providerId: z.number().int().positive(),
          decision: z.enum(["activate", "suspend", "reject"]),
          verificationCaseId: z.string().uuid().nullable(),
          rejectionReason: z.string().trim().min(3).max(1000).optional(),
          idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        decideMerchantOnboarding({ actorUserId: ctx.user!.id, ...input }),
      ),
    createProduct: authenticatedProcedure
      .input(
        z.object({
          providerId: z.number().int().positive(),
          title: z.string().trim().min(2).max(255),
          handle: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{1,158}$/),
          description: z.string().trim().min(1).max(10_000),
          status: z.enum(["draft", "published"]),
          currencyCode: z.string().regex(/^[A-Z]{3}$/),
          priceMinor: z.number().int().positive().max(1_000_000_000),
          sku: z.string().trim().min(1).max(160),
          imageUrls: z.array(z.string().url().max(2048)).max(12),
          idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        createMerchantProduct({ actorUserId: ctx.user!.id, ...input }),
      ),
    configurePayments: authenticatedProcedure
      .input(
        z.object({
          providerId: z.number().int().positive(),
          settlementFspAlias: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/),
          payoutReference: z.string().trim().min(8).max(512),
          currencyCode: z.string().regex(/^[A-Z]{3}$/),
          enabled: z.boolean(),
          idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        setMerchantPaymentConfiguration({ actorUserId: ctx.user!.id, ...input }),
      ),
    issueApiCredential: authenticatedProcedure.input(z.object({ providerId:z.number().int().positive(), scopes:z.array(z.enum(["catalog:write","inventory:write","fulfillment:read","tracking:read"])).min(1).max(4), expiresAt:z.string().datetime() })).mutation(({ctx,input})=>issueMerchantApiCredential({actorUserId:ctx.user!.id,...input})),
    rotateApiCredential: authenticatedProcedure.input(z.object({ providerId:z.number().int().positive(), previousKeyId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/), scopes:z.array(z.enum(["catalog:write","inventory:write","fulfillment:read","tracking:read"])).min(1).max(4), expiresAt:z.string().datetime() })).mutation(({ctx,input})=>rotateMerchantApiCredential({actorUserId:ctx.user!.id,...input})),
    revokeApiCredential: authenticatedProcedure.input(z.object({ providerId:z.number().int().positive(), keyId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/) })).mutation(({ctx,input})=>revokeMerchantApiCredential({actorUserId:ctx.user!.id,...input})),
    updateInventory: authenticatedProcedure
      .input(
        z.object({
          providerId: z.number().int().positive(),
          inventoryItemId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/),
          locationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/),
          inventoryLevelId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/).optional(),
          stockedQuantity: z.number().int().min(0).max(1_000_000_000),
          incomingQuantity: z.number().int().min(0).max(1_000_000_000),
          idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        updateMerchantInventoryLevel({ actorUserId: ctx.user!.id, ...input }),
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
    transition: operatorMutationProcedure("operate")
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
    assignDriver: operatorMutationProcedure("operate")
      .input(
        z.object({
          fulfillmentId: z.string().uuid(),
          deliveryOrderId: z.number().int().positive(),
          driverId: z.number().int().positive(),
          idempotencyKey: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        assignCommerceFulfillmentDriver({ actorUserId: ctx.user!.id, ...input }),
      ),
    registerExternalPlatform: operatorMutationProcedure("operate")
      .input(
        z.object({
          providerId: z.number().int().positive(),
          connectionKey: z.string().trim().regex(/^[a-z][a-z0-9-]{2,63}$/),
          platformName: z.string().trim().min(3).max(120),
          inboundEnabled: z.boolean(),
          outboundEnabled: z.boolean(),
          inboundSigningSecretRef: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/),
        }).refine((value) => value.inboundEnabled || value.outboundEnabled, { message: "at least one sync direction is required" }),
      )
      .mutation(({ ctx, input }) =>
        registerExternalCommerceConnection({ actorUserId: ctx.user!.id, ...input }),
      ),
    upsertMedusaStore: operatorMutationProcedure("operate")
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
    createClient: operatorMutationProcedure("write_platform")
      .input(
        z.object({
          providerId: z.number().int().positive(),
          displayName: z.string().trim().min(2).max(160),
        }),
      )
      .mutation(({ ctx, input }) =>
        createDeveloperApiClient({ actorUserId: ctx.user!.id, ...input }),
      ),
    createKey: operatorMutationProcedure("write_platform")
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
    revokeKey: operatorMutationProcedure("write_platform")
      .input(z.object({ apiKeyId: z.string().uuid() }))
      .mutation(({ ctx, input }) =>
        revokeDeveloperApiKey({ actorUserId: ctx.user!.id, ...input }),
      ),
    createWebhookEndpoint: operatorMutationProcedure("write_platform")
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
    executeAction: operatorMutationProcedure("write_platform")
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

  selfserve: selfserveRouter,

  driverOnboarding: driverOnboardingRouter,

  consumer: consumerRouter,

  riderVerification: riderVerificationRouter,

  verification: verificationRouter,

  deactivation: deactivationRouter,

  council: councilRouter,

  economics: economicsRouter,

  pricingTransparency: pricingTransparencyRouter,

  safety: safetyRouter,

  incentives: incentivesRouter,

  protection: protectionRouter,

  transition: transitionRouter,

  portability: portabilityRouter,

  contractDefaults: contractDefaultsRouter,
});

export type AppRouter = typeof appRouter;
