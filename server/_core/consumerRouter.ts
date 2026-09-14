import { z } from "zod";

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
});
