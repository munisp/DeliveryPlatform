import { z } from "zod";

import {
  authenticatedProcedure,
  operatorMutationProcedure,
  router,
} from "./trpc";
import { resolvePublicUser } from "./publicUsers";
import {
  advanceEnrollment,
  createProgram,
  enroll,
  getMyEnrollments,
  listPrograms,
  withdraw,
} from "./workerTransition";

/**
 * Worker transition surface (R13). Program browsing, enrollment and
 * withdrawal are self-serve; program creation and enrollment advancement
 * are operator-only, with a worker-council consultation (kind 'transition')
 * auto-posted whenever a program is created.
 */
export const transitionRouter = router({
  listPrograms: authenticatedProcedure
    .input(
      z
        .object({ includeClosed: z.boolean().optional() })
        .optional(),
    )
    .query(({ input }) => listPrograms(input)),

  getMyEnrollments: authenticatedProcedure.query(async ({ ctx }) => {
    const publicUser = await resolvePublicUser(ctx.user);
    return getMyEnrollments(publicUser.id);
  }),

  enroll: authenticatedProcedure
    .input(z.object({ programId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const publicUser = await resolvePublicUser(ctx.user);
      return enroll(publicUser.id, input);
    }),

  withdraw: authenticatedProcedure
    .input(z.object({ enrollmentId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const publicUser = await resolvePublicUser(ctx.user);
      return withdraw(publicUser.id, input);
    }),

  createProgram: operatorMutationProcedure("write_platform")
    .input(
      z.object({
        title: z.string().trim().min(1).max(200),
        kind: z.enum([
          "voluntary_exit",
          "role_change",
          "vehicle_ownership",
          "severance",
        ]),
        terms: z
          .object({
            gratuity_minor: z.number().int().min(0).optional(),
            deficit_forgiveness: z.boolean().optional(),
          })
          .catchall(z.unknown())
          .optional(),
        open: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actor = await resolvePublicUser(ctx.user);
      return createProgram(actor.id, input);
    }),

  advanceEnrollment: operatorMutationProcedure("write_platform")
    .input(
      z.object({
        enrollmentId: z.string().uuid(),
        status: z.enum(["in_progress", "completed", "withdrawn"]),
        exitGratuityMinor: z.number().int().min(0).optional(),
        deficitsWaivedMinor: z.number().int().min(0).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actor = await resolvePublicUser(ctx.user);
      return advanceEnrollment(actor.id, input);
    }),
});
