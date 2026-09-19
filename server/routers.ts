import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { getSessionFromRequest, signSessionToken } from "./_core/auth";
import { getDb } from "./db";
import {
  authenticatedProcedure,
  operatorMutationProcedure,
  protectedProcedure,
  publicProcedure,
  router,
  workspaceReadProcedure,
} from "./_core/trpc";
import { createReferral, getUserReferrals } from "./db-referrals";
import { getUserPoints } from "./db-loyalty";
import { getCampaigns, trackMarketingEvent } from "./db-marketing";
import {
  createLocalCommerceOrder,
  createLocalCommerceVendor,
  getLocalCommerceWorkspace,
} from "./_core/localCommerce";
import {
  createVoiceAgentCall,
  escalateVoiceAgentCall,
  getVoiceAgentWorkspace,
  handoffVoiceAgentCall,
  startVoiceAgentCall,
} from "./_core/voiceAgent";
import { getPhoneOrderingWorkspace } from "./_core/phoneOrdering";
import {
  appendLongCatMessagingTurn,
  appendLongCatVoiceTurn,
  executeLongCatAction,
  getLongCatCustomerMemory,
  startLongCatMessagingSession,
  startLongCatVoiceSession,
} from "./_core/longcatVoice";
import { ENV } from "./_core/env";
import {
  cancelLocalCommerceOrder,
  confirmLocalCommerceOrderDelivery,
  createGuestOrderQuote,
  placeLocalCommerceOrder,
} from "./_core/localCommerceCheckout";
import {
  archiveLocalCommerceCustomer,
  mergeLocalCommerceCustomers,
  restoreLocalCommerceCustomer,
} from "./_core/localCommerceCustomers";
import {
  approveLocalCommerceVendorPayout,
  processLocalCommerceVendorPayout,
  rejectLocalCommerceVendorPayout,
  requestLocalCommerceVendorPayout,
} from "./_core/localCommercePayouts";
import {
  decideLocalCommercePlanApproval,
  requestLocalCommercePlanApproval,
} from "./_core/localCommerceApprovals";
import {
  acknowledgeDeliveryPartnerTrackingAlert,
  claimDeliveryPartnerOrder,
  getDeliveryPartnerWorkspace,
  refreshDeliveryPartnerTrackingAlertSnapshot,
  registerDeliveryPartnerTrackingDevice,
  reportDeliveryPartnerStatus,
  reportDeliveryPartnerTrackingPosition,
  resolveDeliveryPartnerTrackingAlert,
} from "./_core/deliveryPartner";
import {
  listCommerceFulfillmentRequests,
  transitionCommerceFulfillment,
  assignCommerceFulfillmentDriver,
  registerExternalCommerceConnection,
  upsertMedusaStoreConnection,
} from "./_core/commerceFulfillment";
import {
  beginMerchantOnboarding,
  createMerchantProduct,
  decideMerchantOnboarding,
  getMerchantCommerceProfile,
  getMerchantOnboardingProgress,
  issueMerchantApiCredential,
  revokeMerchantApiCredential,
  rotateMerchantApiCredential,
  setMerchantPaymentConfiguration,
  updateMerchantInventoryLevel,
} from "./_core/merchantCommerce";
import {
  createDeveloperApiClient,
  createDeveloperApiKey,
  createDeveloperWebhookEndpoint,
  listDeveloperApiClients,
  listDeveloperApiKeys,
  listDeveloperWebhookEndpoints,
  revokeDeveloperApiKey,
} from "./_core/developerPlatform";
import {
  activateVehicleAsset,
  assignVehicleAssetLocation,
  cancelVehicleAvailabilityBlock,
  createFleetProvider,
  createVehicleAvailabilityBlock,
  createVehicleOffer,
  createVehicleProviderLocation,
  createVehicleRentalAddOn,
  decideVehicleContractExtension,
  getVehicleRentalOperationsSnapshot,
  getVehicleTrackerOperationsSnapshot,
  listAvailableVehicleOffers,
  listVehicleRentalAddOns,
  recordAssetEvidence,
  recordVehicleAgreementAcceptance,
  recordVehicleInspection,
  recordVehicleRentalPaymentTrackingSignal,
  recordVehicleTrackerControlConsent,
  registerVehicleAsset,
  registerVehicleAssetTracker,
  requestVehicleAccessWithAddOns,
  requestVehicleContractExtension,
  requestVehiclePreventNextStart,
  authorizeVehiclePreventNextStart,
  cancelVehiclePreventNextStart,
  createVehicleRentalGeofence,
  createVehicleTrackerProvider,
  transitionVehicleAccessContract,
  upsertWorkerVehicleEligibility,
} from "./_core/vehicleAccess";
import {
  activateFieldServiceAgreement,
  assignFieldServiceWorkOrder,
  completeFieldServiceWorkOrder,
  createFieldServiceProvider,
  createFieldServiceWorkOrder,
  getFieldServiceOperationsSnapshot,
  recordFieldServiceWorkOrderStatus,
  recordFieldServiceSlaEvent,
  scheduleFieldServiceWorkOrder,
  upsertFieldServiceTechnician,
} from "./_core/fieldService";
import {
  applyPromoCodeToShipment,
  createShipmentQuote,
  createShipmentTrackingEvent,
  getPublicTrackingSnapshot,
  listActiveShipmentRules,
  purchaseShipmentLabel,
  resolveShipmentProofOfDelivery,
  scheduleShipmentPickup,
  updateShipmentStatus,
  upsertShipmentRule,
} from "./_core/commerceShipping";
import {
  decideVerificationCase,
  getVerificationChecks,
  listVerificationCases,
  recordVerificationConsent,
  recordVerificationEvidence,
  recordVerificationProviderCheck,
  startVerificationCase,
  withdrawVerificationConsent,
} from "./_core/stakeholderVerification";
import { driverOnboardingRouter } from "./_core/driverOnboardingRouter";
import { selfserveRouter } from "./_core/selfserveRouter";
import { consumerRouter } from "./_core/consumerRouter";
import { riderVerificationRouter } from "./_core/riderVerificationRouter";
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

export const appRouter = router({
  system: router({
    health: publicProcedure.query(() => ({ ok: true })),
  }),

  auth: router({
    me: publicProcedure.query(({ ctx }) => ctx.user ?? null),
    legacySession: publicProcedure
      .input(z.object({ email: z.string().email() }))
      .mutation(async ({ input }) => {
        const db = await getDb();
        const [user] = await db.query.users.findMany({
          where: (users, { eq }) => eq(users.email, input.email),
          limit: 1,
        });
        if (!user) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "User not found",
          });
        }
        const session = await signSessionToken({
          userId: user.id,
          openId: user.openId,
          name: user.name ?? undefined,
        });
        return { session, user };
      }),
    sessionFromRequest: publicProcedure.query(async ({ ctx }) => {
      const session = await getSessionFromRequest(ctx.req);
      return session;
    }),
  }),

  growth: router({
    createReferral: protectedProcedure
      .input(
        z.object({
          referredEmail: z.string().email(),
          campaignId: z.number().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        return await createReferral({
          referrerUserId: ctx.user.id,
          referredEmail: input.referredEmail,
          campaignId: input.campaignId,
        });
      }),

    getUserReferrals: protectedProcedure.query(async ({ ctx }) => {
      return await getUserReferrals(ctx.user.id);
    }),

    getUserPoints: protectedProcedure.query(async ({ ctx }) => {
      return await getUserPoints(ctx.user.id);
    }),

    getCampaigns: protectedProcedure.query(async () => {
      return await getCampaigns();
    }),

    trackEvent: protectedProcedure
      .input(
        z.object({
          eventType: z.string(),
          campaignId: z.number().optional(),
          variantId: z.number().optional(),
          metadata: z.record(z.string(), z.any()).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        await trackMarketingEvent({
          userId: ctx.user.id,
          eventType: input.eventType,
          campaignId: input.campaignId,
          variantId: input.variantId,
          metadata: input.metadata,
        });
        return { success: true };
      }),
  }),

  localCommerce: router({
    workspace: workspaceReadProcedure.query(() =>
      requireWorkspaceData("local_commerce", () => getLocalCommerceWorkspace()),
    ),

    createVendor: operatorMutationProcedure("write_platform")
      .input(
        z.object({
          businessName: z.string().trim().min(2).max(160),
          ownerName: z.string().trim().min(2).max(160),
          ownerPhone: z.string().trim().min(5).max(32),
          ownerEmail: z.string().trim().email().max(320).optional(),
          addressSummary: z.string().trim().min(3).max(400),
          latitude: z.number().min(-90).max(90).optional(),
          longitude: z.number().min(-180).max(180).optional(),
          category: z
            .enum([
              "restaurant",
              "grocery",
              "pharmacy",
              "retail",
              "services",
              "other",
            ])
            .default("other"),
          commissionBps: z.number().int().min(0).max(5000).default(1500),
          settlementFspAlias: z.string().trim().min(3).max(120).optional(),
          settlementAccountRef: z.string().trim().min(3).max(120).optional(),
          metadata: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .mutation(({ input }) => createLocalCommerceVendor(input)),

    createOrder: operatorMutationProcedure("operate")
      .input(
        z.object({
          vendorId: z.number().int().positive(),
          customerName: z.string().trim().min(2).max(160),
          customerPhone: z.string().trim().min(5).max(32),
          deliveryAddress: z.string().trim().min(3).max(400),
          deliveryLatitude: z.number().min(-90).max(90).optional(),
          deliveryLongitude: z.number().min(-180).max(180).optional(),
          items: z
            .array(
              z.object({
                productName: z.string().trim().min(1).max(200),
                quantity: z.number().int().min(1).max(999),
                unitPriceKobo: z.number().int().min(0),
                notes: z.string().trim().max(500).optional(),
              }),
            )
            .min(1)
            .max(64),
          deliveryFeeKobo: z.number().int().min(0).default(0),
          paymentMethod: z
            .enum(["cash", "transfer", "card", "wallet"])
            .default("cash"),
          notes: z.string().trim().max(1000).optional(),
          idempotencyKey: z.string().trim().min(8).max(128).optional(),
        }),
      )
      .mutation(({ input }) => createLocalCommerceOrder(input)),
  }),

  localCommerceCheckout: router({
    quoteGuestOrder: publicProcedure
      .input(
        z.object({
          vendorId: z.number().int().positive(),
          items: z
            .array(
              z.object({
                productName: z.string().trim().min(1).max(200),
                quantity: z.number().int().min(1).max(999),
                unitPriceKobo: z.number().int().min(0),
              }),
            )
            .min(1)
            .max(64),
          deliveryFeeKobo: z.number().int().min(0).default(0),
          promoCode: z.string().trim().min(3).max(64).optional(),
        }),
      )
      .mutation(({ input }) => createGuestOrderQuote(input)),

    placeOrder: protectedProcedure
      .input(
        z.object({
          vendorId: z.number().int().positive(),
          customerName: z.string().trim().min(2).max(160),
          customerPhone: z.string().trim().min(5).max(32),
          deliveryAddress: z.string().trim().min(3).max(400),
          deliveryLatitude: z.number().min(-90).max(90).optional(),
          deliveryLongitude: z.number().min(-180).max(180).optional(),
          items: z
            .array(
              z.object({
                productName: z.string().trim().min(1).max(200),
                quantity: z.number().int().min(1).max(999),
                unitPriceKobo: z.number().int().min(0),
                notes: z.string().trim().max(500).optional(),
              }),
            )
            .min(1)
            .max(64),
          deliveryFeeKobo: z.number().int().min(0).default(0),
          paymentMethod: z
            .enum(["cash", "transfer", "card", "wallet"])
            .default("cash"),
          promoCode: z.string().trim().min(3).max(64).optional(),
          notes: z.string().trim().max(1000).optional(),
          idempotencyKey: z.string().trim().min(8).max(128),
        }),
      )
      .mutation(({ ctx, input }) =>
        placeLocalCommerceOrder(ctx.user.id, input),
      ),

    cancelOrder: operatorMutationProcedure("operate")
      .input(
        z.object({
          orderId: z.number().int().positive(),
          reason: z.string().trim().min(3).max(500),
        }),
      )
      .mutation(({ input }) => cancelLocalCommerceOrder(input)),

    confirmDelivery: operatorMutationProcedure("operate")
      .input(
        z.object({
          orderId: z.number().int().positive(),
          proofPhotoUrl: z.string().url().max(2048).optional(),
          recipientName: z.string().trim().min(2).max(160).optional(),
        }),
      )
      .mutation(({ input }) => confirmLocalCommerceOrderDelivery(input)),
  }),

  localCommerceCustomers: router({
    merge: operatorMutationProcedure("write_platform")
      .input(
        z.object({
          primaryCustomerId: z.number().int().positive(),
          duplicateCustomerId: z.number().int().positive(),
          reason: z.string().trim().min(3).max(500),
        }),
      )
      .mutation(({ input }) => mergeLocalCommerceCustomers(input)),

    archive: operatorMutationProcedure("write_platform")
      .input(
        z.object({
          customerId: z.number().int().positive(),
          reason: z.string().trim().min(3).max(500),
        }),
      )
      .mutation(({ input }) => archiveLocalCommerceCustomer(input)),

    restore: operatorMutationProcedure("write_platform")
      .input(
        z.object({
          customerId: z.number().int().positive(),
        }),
      )
      .mutation(({ input }) => restoreLocalCommerceCustomer(input)),
  }),

  localCommercePayouts: router({
    request: operatorMutationProcedure("operate")
      .input(
        z.object({
          vendorId: z.number().int().positive(),
          amountKobo: z.number().int().positive(),
          settlementFspAlias: z.string().trim().min(3).max(120).optional(),
          settlementAccountRef: z.string().trim().min(3).max(120).optional(),
          notes: z.string().trim().max(1000).optional(),
          idempotencyKey: z.string().trim().min(8).max(128),
        }),
      )
      .mutation(({ input }) => requestLocalCommerceVendorPayout(input)),

    approve: operatorMutationProcedure("write_platform")
      .input(
        z.object({
          payoutId: z.number().int().positive(),
        }),
      )
      .mutation(({ input }) => approveLocalCommerceVendorPayout(input)),

    reject: operatorMutationProcedure("write_platform")
      .input(
        z.object({
          payoutId: z.number().int().positive(),
          reason: z.string().trim().min(3).max(500),
        }),
      )
      .mutation(({ input }) => rejectLocalCommerceVendorPayout(input)),

    process: operatorMutationProcedure("write_platform")
      .input(
        z.object({
          payoutId: z.number().int().positive(),
          settlementReference: z.string().trim().min(3).max(120),
        }),
      )
      .mutation(({ input }) => processLocalCommerceVendorPayout(input)),
  }),

  localCommerceApprovals: router({
    request: operatorMutationProcedure("operate")
      .input(
        z.object({
          planId: z.number().int().positive(),
          reason: z.string().trim().min(3).max(500),
        }),
      )
      .mutation(({ input }) => requestLocalCommercePlanApproval(input)),

    decide: operatorMutationProcedure("write_platform")
      .input(
        z.object({
          approvalId: z.number().int().positive(),
          decision: z.enum(["approved", "rejected"]),
          reason: z.string().trim().min(3).max(500).optional(),
        }),
      )
      .mutation(({ input }) => decideLocalCommercePlanApproval(input)),
  }),

  voiceAgent: router({
    workspace: workspaceReadProcedure.query(() =>
      requireWorkspaceData("voice_agent", () => getVoiceAgentWorkspace()),
    ),

    createCall: operatorMutationProcedure("operate")
      .input(
        z.object({
          customerPhone: z.string().trim().min(5).max(32),
          customerName: z.string().trim().min(1).max(255).optional(),
          direction: z.enum(["inbound", "outbound"]).default("inbound"),
          voiceChannel: z.string().trim().min(2).max(64).optional(),
          metadata: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .mutation(({ input }) => createVoiceAgentCall(input)),

    startCall: operatorMutationProcedure("operate")
      .input(
        z.object({
          callId: z.string().uuid(),
        }),
      )
      .mutation(({ input }) => startVoiceAgentCall(input)),

    escalate: operatorMutationProcedure("operate")
      .input(
        z.object({
          callId: z.string().uuid(),
          reason: z.string().trim().min(3).max(500),
        }),
      )
      .mutation(({ input }) => escalateVoiceAgentCall(input)),

    handoff: operatorMutationProcedure("operate")
      .input(
        z.object({
          callId: z.string().uuid(),
          targetQueue: z.string().trim().min(2).max(120),
          reason: z.string().trim().min(3).max(500),
        }),
      )
      .mutation(({ input }) => handoffVoiceAgentCall(input)),
  }),

  deliveryPartner: router({
    workspace: workspaceReadProcedure.query(() =>
      requireWorkspaceData("delivery_partner", () =>
        getDeliveryPartnerWorkspace(),
      ),
    ),

    claimOrder: operatorMutationProcedure("operate")
      .input(
        z.object({
          orderId: z.number().int().positive(),
          partnerCode: z.string().trim().min(2).max(64),
          driverName: z.string().trim().min(2).max(160),
          driverPhone: z.string().trim().min(5).max(32),
        }),
      )
      .mutation(({ input }) => claimDeliveryPartnerOrder(input)),

    reportStatus: operatorMutationProcedure("operate")
      .input(
        z.object({
          orderId: z.number().int().positive(),
          partnerCode: z.string().trim().min(2).max(64),
          status: z.enum([
            "picked_up",
            "in_transit",
            "arrived",
            "delivered",
            "failed",
          ]),
          note: z.string().trim().max(500).optional(),
        }),
      )
      .mutation(({ input }) => reportDeliveryPartnerStatus(input)),

    registerTrackingDevice: operatorMutationProcedure("operate")
      .input(
        z.object({
          partnerCode: z.string().trim().min(2).max(64),
          deviceIdentifier: z.string().trim().min(3).max(160),
          platform: z.enum(["ios", "android", "hardware"]),
          label: z.string().trim().max(160).optional(),
        }),
      )
      .mutation(({ input }) => registerDeliveryPartnerTrackingDevice(input)),

    reportTrackingPosition: publicProcedure
      .input(
        z.object({
          deviceToken: z.string().trim().min(8).max(255),
          latitude: z.number().min(-90).max(90),
          longitude: z.number().min(-180).max(180),
          accuracyMeters: z.number().min(0).max(100000).optional(),
          batteryPercent: z.number().min(0).max(100).optional(),
          recordedAt: z.string().datetime().optional(),
        }),
      )
      .mutation(({ input }) => reportDeliveryPartnerTrackingPosition(input)),

    refreshTrackingAlerts: operatorMutationProcedure("operate")
      .input(z.object({}).optional())
      .mutation(() => refreshDeliveryPartnerTrackingAlertSnapshot()),

    acknowledgeTrackingAlert: operatorMutationProcedure("operate")
      .input(
        z.object({
          alertId: z.number().int().positive(),
        }),
      )
      .mutation(({ input }) => acknowledgeDeliveryPartnerTrackingAlert(input)),

    resolveTrackingAlert: operatorMutationProcedure("operate")
      .input(
        z.object({
          alertId: z.number().int().positive(),
          resolution: z.string().trim().min(3).max(500),
        }),
      )
      .mutation(({ input }) => resolveDeliveryPartnerTrackingAlert(input)),
  }),

  commerceShipping: router({
    quote: authenticatedProcedure
      .input(
        z.object({
          orderId: z.number().int().positive(),
          carrierCode: z.string().trim().min(2).max(64).optional(),
          serviceCode: z.string().trim().min(2).max(64).optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        createShipmentQuote({ actorUserId: ctx.user!.id, ...input }),
      ),
    purchaseLabel: operatorMutationProcedure("operate")
      .input(
        z.object({
          quoteId: z.string().uuid(),
          idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        purchaseShipmentLabel({ actorUserId: ctx.user!.id, ...input }),
      ),
    schedulePickup: operatorMutationProcedure("operate")
      .input(
        z.object({
          shipmentId: z.string().uuid(),
          pickupWindowStart: z.string().datetime(),
          pickupWindowEnd: z.string().datetime(),
          idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        scheduleShipmentPickup({ actorUserId: ctx.user!.id, ...input }),
      ),
    updateStatus: operatorMutationProcedure("operate")
      .input(
        z.object({
          shipmentId: z.string().uuid(),
          status: z.enum([
            "label_purchased",
            "pickup_scheduled",
            "picked_up",
            "in_transit",
            "out_for_delivery",
            "delivered",
            "failed",
            "returned",
          ]),
          detail: z.string().trim().max(500).optional(),
          idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        updateShipmentStatus({ actorUserId: ctx.user!.id, ...input }),
      ),
    recordTrackingEvent: operatorMutationProcedure("operate")
      .input(
        z.object({
          shipmentId: z.string().uuid(),
          eventCode: z.string().trim().min(2).max(64),
          description: z.string().trim().max(500).optional(),
          locationSummary: z.string().trim().max(255).optional(),
          occurredAt: z.string().datetime().optional(),
          idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        createShipmentTrackingEvent({ actorUserId: ctx.user!.id, ...input }),
      ),
    resolveProofOfDelivery: publicProcedure
      .input(z.object({ shipmentId: z.string().uuid() }))
      .query(({ input }) => resolveShipmentProofOfDelivery(input)),
    trackingSnapshot: publicProcedure
      .input(
        z.object({
          trackingNumber: z.string().trim().min(4).max(128),
        }),
      )
      .query(({ input }) => getPublicTrackingSnapshot(input)),
    applyPromoCode: operatorMutationProcedure("operate")
      .input(
        z.object({
          shipmentId: z.string().uuid(),
          promoCode: z.string().trim().min(3).max(64),
          idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        applyPromoCodeToShipment({ actorUserId: ctx.user!.id, ...input }),
      ),
    listRules: operatorMutationProcedure("operate")
      .input(
        z
          .object({
            activeOnly: z.boolean().default(true),
          })
          .optional(),
      )
      .query(({ input }) =>
        listActiveShipmentRules({ activeOnly: input?.activeOnly ?? true }),
      ),
    upsertRule: operatorMutationProcedure("write_platform")
      .input(
        z.object({
          ruleCode: z.string().trim().min(2).max(64),
          displayName: z.string().trim().min(2).max(160),
          carrierCode: z.string().trim().min(2).max(64),
          serviceCode: z.string().trim().min(2).max(64),
          baseRateKobo: z.number().int().min(0),
          perKgRateKobo: z.number().int().min(0),
          maxWeightKg: z.number().min(0).max(10000).optional(),
          active: z.boolean(),
          idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        upsertShipmentRule({ actorUserId: ctx.user!.id, ...input }),
      ),
  }),

  fieldService: router({
    operationsSnapshot: authenticatedProcedure.query(({ ctx }) =>
      getFieldServiceOperationsSnapshot(ctx.user!.id),
    ),
    createProvider: operatorMutationProcedure("operate")
      .input(
        z.object({
          displayName: z.string().trim().min(2).max(160),
          legalName: z.string().trim().min(2).max(255),
          dispatchEmail: z.string().trim().email().max(320).optional(),
          dispatchPhone: z.string().trim().min(5).max(32).optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        createFieldServiceProvider({ actorUserId: ctx.user!.id, ...input }),
      ),
    upsertTechnician: operatorMutationProcedure("operate")
      .input(
        z.object({
          userId: z.number().int().positive(),
          providerId: z.number().int().positive(),
          displayName: z.string().trim().min(2).max(160),
          employeeReference: z.string().trim().max(128).nullable(),
          skills: z.array(z.string().trim().min(1).max(64)).max(48),
          state: z.enum(["onboarding", "active", "suspended"]),
        }),
      )
      .mutation(({ ctx, input }) =>
        upsertFieldServiceTechnician({ actorUserId: ctx.user!.id, ...input }),
      ),
    createWorkOrder: operatorMutationProcedure("operate")
      .input(
        z.object({
          providerId: z.number().int().positive(),
          customerName: z.string().trim().min(2).max(160),
          customerPhone: z.string().trim().min(5).max(32),
          serviceAddress: z.string().trim().min(3).max(400),
          serviceLatitude: z.number().min(-90).max(90).optional(),
          serviceLongitude: z.number().min(-180).max(180).optional(),
          description: z.string().trim().min(3).max(2000),
          priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
          slaDueAt: z.string().datetime().optional(),
          idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        createFieldServiceWorkOrder({ actorUserId: ctx.user!.id, ...input }),
      ),
    scheduleWorkOrder: operatorMutationProcedure("operate")
      .input(
        z.object({
          workOrderId: z.string().uuid(),
          scheduledStart: z.string().datetime(),
          scheduledEnd: z.string().datetime(),
          idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        scheduleFieldServiceWorkOrder({ actorUserId: ctx.user!.id, ...input }),
      ),
    assignWorkOrder: operatorMutationProcedure("operate")
      .input(
        z.object({
          workOrderId: z.string().uuid(),
          technicianUserId: z.number().int().positive(),
          idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        assignFieldServiceWorkOrder({ actorUserId: ctx.user!.id, ...input }),
      ),
    recordStatus: authenticatedProcedure
      .input(
        z.object({
          workOrderId: z.string().uuid(),
          status: z.enum([
            "en_route",
            "arrived",
            "in_progress",
            "completed",
            "cancelled",
          ]),
          note: z.string().trim().max(1000).optional(),
          idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        recordFieldServiceWorkOrderStatus({
          actorUserId: ctx.user!.id,
          ...input,
        }),
      ),
    recordSlaEvent: operatorMutationProcedure("operate")
      .input(
        z.object({
          workOrderId: z.string().uuid(),
          eventType: z.enum(["breach_warning", "breached", "met"]),
          detail: z.string().trim().max(500).optional(),
          idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        recordFieldServiceSlaEvent({ actorUserId: ctx.user!.id, ...input }),
      ),
    completeWorkOrder: authenticatedProcedure
      .input(
        z.object({
          workOrderId: z.string().uuid(),
          completionNotes: z.string().trim().min(3).max(2000),
          partsUsed: z
            .array(
              z.object({
                name: z.string().trim().min(1).max(160),
                quantity: z.number().int().min(1).max(999),
                unitCostKobo: z.number().int().min(0),
              }),
            )
            .max(64)
            .optional(),
          laborMinutes: z.number().int().min(0).max(100000).optional(),
          idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        completeFieldServiceWorkOrder({ actorUserId: ctx.user!.id, ...input }),
      ),
    activateAgreement: operatorMutationProcedure("operate")
      .input(
        z.object({
          agreementId: z.string().uuid(),
          idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(({ ctx, input }) =>
        activateFieldServiceAgreement({ actorUserId: ctx.user!.id, ...input }),
      ),
  }),

  verification: router({
    startCase: operatorMutationProcedure("operate")
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
          subjectKey: z.string().trim().min(1).max(160),
          subjectUserId: z.number().int().positive().nullable(),
          jurisdiction: z.string().trim().min(2).max(8),
          purpose: z.string().trim().min(2).max(64),
          idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(async ({ ctx, input }) => ({
        caseId: await startVerificationCase({
          actorUserId: ctx.user!.id,
          ...input,
        }),
      })),
    recordConsent: operatorMutationProcedure("operate")
      .input(
        z.object({
          caseId: z.string().uuid(),
          consentVersion: z.string().trim().min(1).max(64),
          disclosureDigestHex: z.string().regex(/^[a-f0-9]{64}$/),
          expiresAt: z.string().datetime(),
          idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(async ({ ctx, input }) => ({
        consentId: await recordVerificationConsent({
          actorUserId: ctx.user!.id,
          ...input,
        }),
      })),
    withdrawConsent: authenticatedProcedure
      .input(
        z.object({
          caseId: z.string().uuid(),
          idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(async ({ ctx, input }) => ({
        state: await withdrawVerificationConsent({
          actorUserId: ctx.user!.id,
          ...input,
        }),
      })),
    recordEvidence: operatorMutationProcedure("operate")
      .input(
        z.object({
          caseId: z.string().uuid(),
          evidenceKind: z.string().trim().min(2).max(64),
          objectKey: z.string().trim().min(3).max(512),
          contentType: z.enum([
            "application/pdf",
            "image/jpeg",
            "image/png",
            "image/heic",
            "video/mp4",
          ]),
          sha256Hex: z.string().regex(/^[a-f0-9]{64}$/),
          captureMetadata: z.record(z.string(), z.unknown()),
          idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(async ({ ctx, input }) => ({
        evidenceId: await recordVerificationEvidence({
          actorUserId: ctx.user!.id,
          ...input,
        }),
      })),
    listCases: operatorMutationProcedure("operate")
      .input(
        z.object({
          limit: z.number().int().min(1).max(200).default(50),
        }),
      )
      .query(async ({ ctx, input }) =>
        listVerificationCases(ctx.user!.id, input.limit),
      ),
    getChecks: authenticatedProcedure
      .input(z.object({ caseId: z.string().uuid() }))
      .query(async ({ ctx, input }) =>
        getVerificationChecks(ctx.user!.id, input.caseId),
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
          providerKey: z.string().trim().min(2).max(64),
          state: z.enum([
            "passed",
            "failed",
            "manual_review",
            "unavailable",
            "expired",
          ]),
          providerReference: z.string().trim().max(255).nullable(),
          responseDigestHex: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
          expiresAt: z.string().datetime().nullable(),
          detailCode: z.string().trim().max(64).nullable(),
          idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(async ({ ctx, input }) => ({
        state: await recordVerificationProviderCheck({
          actorUserId: ctx.user!.id,
          ...input,
        }),
      })),
    decideCase: operatorMutationProcedure("write_platform")
      .input(
        z.object({
          caseId: z.string().uuid(),
          decision: z.enum(["verify", "reject", "suspend", "expire"]),
          reason: z.string().trim().min(3).max(4000),
          expiresAt: z.string().datetime().nullable(),
          idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
        }),
      )
      .mutation(async ({ ctx, input }) => ({
        state: await decideVerificationCase({
          actorUserId: ctx.user!.id,
          ...input,
        }),
      })),
  }),

  vehicleAccess: router({
    availableOffers: authenticatedProcedure
      .input(
        z.object({
          limit: z.number().int().min(1).max(24).optional(),
        }),
      )
      .query(({ input }) =>
        listAvailableVehicleOffers({ limit: input.limit ?? 24 }),
      ),
    rentalAddOns: authenticatedProcedure
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
