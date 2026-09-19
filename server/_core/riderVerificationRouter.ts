import { z } from "zod";

import { authenticatedProcedure, protectedProcedure, router } from "./trpc";
import { resolvePublicUser } from "./publicUsers";
import {
  getMyVerificationStatus,
  getOfferRiderBadge,
  screenName,
  submitVerification,
} from "./riderVerification";

export const riderVerificationRouter = router({
  getMyVerificationStatus: authenticatedProcedure.query(async ({ ctx }) => {
    const publicUser = await resolvePublicUser(ctx.user);
    return getMyVerificationStatus(publicUser.id);
  }),

  submitVerification: authenticatedProcedure
    .input(
      z.object({
        idType: z.string().trim().min(2).max(64),
        idRef: z.string().trim().min(1).max(128),
        // Optional at the wire level so older clients degrade to 'pending'
        // instead of erroring — but auto-verification REQUIRES it (fail-closed).
        consentVersion: z.string().trim().min(1).max(64).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const publicUser = await resolvePublicUser(ctx.user);
      return submitVerification(publicUser.id, {
        idType: input.idType,
        idRef: input.idRef,
        name: ctx.user.name ?? "",
        consentVersion: input.consentVersion ?? null,
      });
    }),

  screenName: authenticatedProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(200),
      }),
    )
    .query(({ input }) => screenName(input.name)),

  getOfferRiderBadge: protectedProcedure
    .input(
      z.object({
        offerId: z.string().uuid(),
      }),
    )
    .query(({ input }) => getOfferRiderBadge(input.offerId)),
});
