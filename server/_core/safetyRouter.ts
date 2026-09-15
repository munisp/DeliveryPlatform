import { z } from "zod";

import {
  authenticatedProcedure,
  operatorMutationProcedure,
  protectedProcedure,
  router,
} from "./trpc";
import { resolvePublicUser } from "./publicUsers";
import {
  attachManifest,
  cancelSOS,
  getManifest,
  listActiveSOS,
  resolveSOS,
  triggerSOS,
} from "./tripSafety";

/**
 * Trip safety surface (R2 passenger manifest, R8 SOS).
 * Manifest attach/SOS trigger are self-serve; manifest reads are restricted
 * to the booker or the assigned driver; SOS resolution/listing is operator.
 */
export const safetyRouter = router({
  attachManifest: authenticatedProcedure
    .input(
      z.object({
        tripId: z.string().trim().min(1).max(64),
        passengers: z
          .array(
            z.object({
              name: z.string().trim().min(1).max(200),
              nin: z.string().trim().min(1).max(32).optional(),
            }),
          )
          .min(1)
          .max(50),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const publicUser = await resolvePublicUser(ctx.user);
      return attachManifest(publicUser.id, input);
    }),

  getManifest: authenticatedProcedure
    .input(z.object({ tripId: z.string().trim().min(1).max(64) }))
    .query(async ({ ctx, input }) => {
      const publicUser = await resolvePublicUser(ctx.user);
      return getManifest(input.tripId, publicUser.id);
    }),

  triggerSOS: authenticatedProcedure
    .input(
      z.object({
        tripId: z.string().trim().min(1).max(64).optional(),
        role: z.enum(["driver", "rider"]),
        lat: z.number().min(-90).max(90).optional(),
        lng: z.number().min(-180).max(180).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const publicUser = await resolvePublicUser(ctx.user);
      return triggerSOS(publicUser.id, input);
    }),

  cancelSOS: authenticatedProcedure
    .input(z.object({ sosId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const publicUser = await resolvePublicUser(ctx.user);
      return cancelSOS(publicUser.id, input);
    }),

  resolveSOS: operatorMutationProcedure("write_platform")
    .input(z.object({ sosId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const operator = await resolvePublicUser(ctx.user);
      return resolveSOS(operator.id, input);
    }),

  listActiveSOS: protectedProcedure.query(() => listActiveSOS()),
});
