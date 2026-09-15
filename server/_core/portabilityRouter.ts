import { z } from "zod";

import {
  authenticatedProcedure,
  operatorMutationProcedure,
  publicProcedure,
  router,
} from "./trpc";
import { resolvePublicUser } from "./publicUsers";
import {
  getExport,
  getMyDataDisclosure,
  listMyExports,
  recordDisclosure,
  requestExport,
  verifyExport,
} from "./dataPortability";

/**
 * Data transparency + portability surface (R14). Export requests, listing
 * and disclosure summaries are self-serve and strictly own-rows-only;
 * verifyExport is public (fail-open against the signer); disclosure
 * recording is operator-only.
 */
export const portabilityRouter = router({
  requestExport: authenticatedProcedure
    .input(
      z.object({
        periodStart: z.coerce.date(),
        periodEnd: z.coerce.date(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const publicUser = await resolvePublicUser(ctx.user);
      return requestExport(publicUser.id, input);
    }),

  listMyExports: authenticatedProcedure.query(async ({ ctx }) => {
    const publicUser = await resolvePublicUser(ctx.user);
    return listMyExports(publicUser.id);
  }),

  getExport: authenticatedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const publicUser = await resolvePublicUser(ctx.user);
      return getExport(publicUser.id, input);
    }),

  verifyExport: publicProcedure
    .input(
      z.object({
        payload: z.string().min(1),
        signature: z.string().min(1),
        publicKey: z.string().min(1),
      }),
    )
    .query(({ input }) => verifyExport(input)),

  getMyDataDisclosure: authenticatedProcedure.query(async ({ ctx }) => {
    const publicUser = await resolvePublicUser(ctx.user);
    return getMyDataDisclosure(publicUser.id);
  }),

  recordDisclosure: operatorMutationProcedure("write_platform")
    .input(
      z.object({
        userId: z.number().int().positive(),
        category: z.enum([
          "profile",
          "trips",
          "earnings",
          "ratings",
          "safety",
          "device",
          "other",
        ]),
        detail: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actor = await resolvePublicUser(ctx.user);
      return recordDisclosure(actor.id, input);
    }),
});
