import { z } from "zod";

import {
  addConsumerCartItem,
  cancelConsumerSubscription,
  checkoutConsumerCart,
  checkoutInputSchema,
  createConsumerCart,
  createConsumerGroupOrder,
  createCartInputSchema,
  createGroupOrderInputSchema,
  addCartItemInputSchema,
  getConsumerCart,
  getConsumerCheckoutSession,
  joinConsumerGroupOrder,
  joinGroupOrderInputSchema,
  myCartInputSchema,
  myCheckoutSessionInputSchema,
  cancelSubscriptionInputSchema,
  rateConsumerOrder,
  rateOrderInputSchema,
  removeCartItemInputSchema,
  removeConsumerCartItem,
  subscribeConsumerPlan,
  subscribePlanInputSchema,
  updateCartItemInputSchema,
  updateConsumerCartItem,
} from "./consumerCommerce";
import {
  getConsumerOrderDetail,
  getConsumerWalletView,
  listConsumerOrders,
  listConsumerSupportCases,
  openConsumerSupportCase,
} from "./consumerQueries";
import { resolvePublicUser } from "./publicUsers";
import { authenticatedProcedure, router } from "./trpc";

/**
 * Consumer account surface router (/account).
 *
 * Every procedure is an authenticatedProcedure scoped to the caller's own
 * identity. The caller is resolved into the `public.users` ID space via
 * resolvePublicUser (the unified domain subject, PR #23) and only THAT id is
 * ever passed to the query layer — order, support-case, transaction and
 * wallet reads are all pinned with `customer_id`/`user_id = $1` so one
 * consumer can never read or reference another consumer's records.
 *
 * Data is read live from public.orders, public.transactions,
 * mojaloop_transfers/mojaloop_refunds, public.support_tickets,
 * public.wallets and the loyalty tables (see consumerQueries.ts). Errors
 * propagate; the client renders QueryErrorState instead of fabricated zeros.
 */

const limitInput = z
  .object({ limit: z.number().int().min(1).max(100).default(25) })
  .optional();

const idempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);

export const consumerRouter = router({
  myOrders: authenticatedProcedure
    .input(limitInput)
    .query(async ({ ctx, input }) => {
      const publicUser = await resolvePublicUser(ctx.user);
      return listConsumerOrders(publicUser.id, input?.limit ?? 25);
    }),

  myOrderDetail: authenticatedProcedure
    .input(z.object({ orderId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const publicUser = await resolvePublicUser(ctx.user);
      return getConsumerOrderDetail(publicUser.id, input.orderId);
    }),

  mySupportCases: authenticatedProcedure
    .input(limitInput)
    .query(async ({ ctx, input }) => {
      const publicUser = await resolvePublicUser(ctx.user);
      return listConsumerSupportCases(publicUser.id, input?.limit ?? 25);
    }),

  openSupportCase: authenticatedProcedure
    .input(
      z.object({
        orderId: z.number().int().positive().nullable().default(null),
        type: z.enum([
          "order_issue",
          "payment",
          "driver",
          "general",
          "claim",
          "refund",
        ]),
        subject: z.string().trim().min(3).max(255),
        description: z.string().trim().min(3).max(4000),
        idempotencyKey: idempotencyKeySchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const publicUser = await resolvePublicUser(ctx.user);
      return openConsumerSupportCase({
        consumerUserId: publicUser.id,
        orderId: input.orderId,
        type: input.type,
        subject: input.subject,
        description: input.description,
        idempotencyKey: input.idempotencyKey,
      });
    }),

  myWallet: authenticatedProcedure
    .input(limitInput)
    .query(async ({ ctx, input }) => {
      const publicUser = await resolvePublicUser(ctx.user);
      return getConsumerWalletView(publicUser.id, input?.limit ?? 50);
    }),

  // -------------------------------------------------------------------
  // Consumer commerce (P1): carts, checkout, group orders, subscriptions,
  // ratings. All caller-scoped via resolvePublicUser; mutations take an
  // idempotency key. See server/_core/consumerCommerce.ts.
  // -------------------------------------------------------------------

  createCart: authenticatedProcedure
    .input(createCartInputSchema)
    .mutation(async ({ ctx, input }) => {
      const publicUser = await resolvePublicUser(ctx.user);
      return createConsumerCart({
        consumerUserId: publicUser.id,
        serviceProviderId: input.serviceProviderId ?? null,
        verticalId: input.verticalId ?? null,
        idempotencyKey: input.idempotencyKey,
      });
    }),

  addCartItem: authenticatedProcedure
    .input(addCartItemInputSchema)
    .mutation(async ({ ctx, input }) => {
      const publicUser = await resolvePublicUser(ctx.user);
      return addConsumerCartItem({
        consumerUserId: publicUser.id,
        cartId: input.cartId,
        catalogItemId: input.catalogItemId ?? null,
        name: input.name,
        unitPriceMinor: input.unitPriceMinor,
        quantity: input.quantity,
        modifiers: input.modifiers,
      });
    }),

  updateCartItem: authenticatedProcedure
    .input(updateCartItemInputSchema)
    .mutation(async ({ ctx, input }) => {
      const publicUser = await resolvePublicUser(ctx.user);
      return updateConsumerCartItem({
        consumerUserId: publicUser.id,
        cartId: input.cartId,
        itemId: input.itemId,
        quantity: input.quantity,
      });
    }),

  removeCartItem: authenticatedProcedure
    .input(removeCartItemInputSchema)
    .mutation(async ({ ctx, input }) => {
      const publicUser = await resolvePublicUser(ctx.user);
      return removeConsumerCartItem({
        consumerUserId: publicUser.id,
        cartId: input.cartId,
        itemId: input.itemId,
      });
    }),

  myCart: authenticatedProcedure
    .input(myCartInputSchema)
    .query(async ({ ctx, input }) => {
      const publicUser = await resolvePublicUser(ctx.user);
      return getConsumerCart({
        consumerUserId: publicUser.id,
        cartId: input?.cartId,
      });
    }),

  checkout: authenticatedProcedure
    .input(checkoutInputSchema)
    .mutation(async ({ ctx, input }) => {
      const publicUser = await resolvePublicUser(ctx.user);
      return checkoutConsumerCart({
        consumerUserId: publicUser.id,
        cartId: input.cartId,
        idempotencyKey: input.idempotencyKey,
        deliveryAddress: input.deliveryAddress,
        deliveryLat: input.deliveryLat,
        deliveryLng: input.deliveryLng,
        notes: input.notes ?? null,
      });
    }),

  myCheckoutSession: authenticatedProcedure
    .input(myCheckoutSessionInputSchema)
    .query(async ({ ctx, input }) => {
      const publicUser = await resolvePublicUser(ctx.user);
      return getConsumerCheckoutSession({
        consumerUserId: publicUser.id,
        checkoutSessionId: input.checkoutSessionId,
      });
    }),

  createGroupOrder: authenticatedProcedure
    .input(createGroupOrderInputSchema)
    .mutation(async ({ ctx, input }) => {
      const publicUser = await resolvePublicUser(ctx.user);
      return createConsumerGroupOrder({
        consumerUserId: publicUser.id,
        maxParticipants: input.maxParticipants,
      });
    }),

  joinGroupOrder: authenticatedProcedure
    .input(joinGroupOrderInputSchema)
    .mutation(async ({ ctx, input }) => {
      const publicUser = await resolvePublicUser(ctx.user);
      return joinConsumerGroupOrder({
        consumerUserId: publicUser.id,
        shareCode: input.shareCode,
      });
    }),

  subscribePlan: authenticatedProcedure
    .input(subscribePlanInputSchema)
    .mutation(async ({ ctx, input }) => {
      const publicUser = await resolvePublicUser(ctx.user);
      return subscribeConsumerPlan({
        consumerUserId: publicUser.id,
        planId: input.planId,
        idempotencyKey: input.idempotencyKey,
      });
    }),

  cancelSubscription: authenticatedProcedure
    .input(cancelSubscriptionInputSchema)
    .mutation(async ({ ctx, input }) => {
      const publicUser = await resolvePublicUser(ctx.user);
      return cancelConsumerSubscription({
        consumerUserId: publicUser.id,
        subscriptionId: input.subscriptionId,
      });
    }),

  rateOrder: authenticatedProcedure
    .input(rateOrderInputSchema)
    .mutation(async ({ ctx, input }) => {
      const publicUser = await resolvePublicUser(ctx.user);
      return rateConsumerOrder({
        consumerUserId: publicUser.id,
        orderId: input.orderId,
        overallRating: input.overallRating,
        punctualityRating: input.punctualityRating,
        professionalismRating: input.professionalismRating,
        vehicleConditionRating: input.vehicleConditionRating,
        communicationRating: input.communicationRating,
        feedback: input.feedback ?? null,
      });
    }),
});
