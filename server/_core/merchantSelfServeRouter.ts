import { z } from "zod";

import {
  createMerchantProductWithProjection,
  getMyEarnings,
  listMyFulfillmentRequests,
  merchantSignup,
  merchantSignupInputSchema,
  myEarningsInputSchema,
  myFulfillmentRequestsInputSchema,
  projectProviderCatalog,
  publishCatalogProjectionInputSchema,
  syncCatalogInputSchema,
  syncProviderCatalog,
  transitionMyFulfillment,
  transitionMyFulfillmentInputSchema,
  updateStorefrontProfile,
  updateStorefrontProfileInputSchema,
} from "./merchantSelfServe";
import { resolvePublicUser } from "./publicUsers";
import { authenticatedProcedure, router } from "./trpc";

/**
 * Merchant self-serve router (WS-MERCHANT, P3-M).
 *
 * Every procedure is an authenticatedProcedure; the caller is resolved into
 * the public.users ID space via resolvePublicUser (consumerRouter precedent)
 * and provider-scoped authorization happens inside the module through
 * commerce.authorize_merchant_portal (0064 role model). Mounted by the lead
 * as `merchantSelfServe` in server/routers.ts — see the P3-M report for the
 * exact mount line.
 */
export const merchantSelfServeRouter = router({
  /**
   * Greenfield merchant intake: creates the service_providers row +
   * merchant portal (verification_pending) transactionally; idempotent per
   * actor (replay returns the existing provider+portal).
   */
  merchantSignup: authenticatedProcedure
    .input(merchantSignupInputSchema)
    .mutation(async ({ ctx, input }) => {
      const actor = await resolvePublicUser(ctx.user);
      return merchantSignup({ actorUserId: actor.id, ...input });
    }),

  /**
   * Create a Medusa product (via the existing merchantCommerce module) and
   * immediately project it into public.provider_catalog_items so it becomes
   * consumer-visible in /shop. Projection failure does not fail the
   * mutation (reported as projectionError; syncCatalog is the repair path).
   */
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
        idempotencyKey: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actor = await resolvePublicUser(ctx.user);
      return createMerchantProductWithProjection({ actorUserId: actor.id, ...input });
    }),

  /** Project one (or all, when medusaProductId omitted) mapped products. */
  publishCatalogProjection: authenticatedProcedure
    .input(publishCatalogProjectionInputSchema)
    .mutation(async ({ ctx, input }) => {
      const actor = await resolvePublicUser(ctx.user);
      return projectProviderCatalog({
        actorUserId: actor.id,
        providerId: input.providerId,
        medusaProductId: input.medusaProductId,
      });
    }),

  /** Repair path: re-project every mapped product for the provider. */
  syncCatalog: authenticatedProcedure
    .input(syncCatalogInputSchema)
    .mutation(async ({ ctx, input }) => {
      const actor = await resolvePublicUser(ctx.user);
      return syncProviderCatalog({ actorUserId: actor.id, ...input });
    }),

  /** Merchant-scoped fulfillment inbox (commerce.fulfillment_request). */
  myFulfillmentRequests: authenticatedProcedure
    .input(myFulfillmentRequestsInputSchema)
    .query(async ({ ctx, input }) => {
      const actor = await resolvePublicUser(ctx.user);
      return listMyFulfillmentRequests({ actorUserId: actor.id, ...input });
    }),

  /** Merchant-legal fulfillment edges: accept / reject / ready. */
  transitionMyFulfillment: authenticatedProcedure
    .input(transitionMyFulfillmentInputSchema)
    .mutation(async ({ ctx, input }) => {
      const actor = await resolvePublicUser(ctx.user);
      return transitionMyFulfillment({ actorUserId: actor.id, ...input });
    }),

  /** Read-only earnings aggregates (orders, fulfillments, payout boolean). */
  myEarnings: authenticatedProcedure
    .input(myEarningsInputSchema)
    .query(async ({ ctx, input }) => {
      const actor = await resolvePublicUser(ctx.user);
      return getMyEarnings({ actorUserId: actor.id, ...input });
    }),

  /** Owner-only storefront display-field update (never status/verification). */
  updateStorefrontProfile: authenticatedProcedure
    .input(updateStorefrontProfileInputSchema)
    .mutation(async ({ ctx, input }) => {
      const actor = await resolvePublicUser(ctx.user);
      return updateStorefrontProfile({ actorUserId: actor.id, ...input });
    }),
});
