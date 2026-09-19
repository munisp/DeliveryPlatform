import { z } from "zod";

import {
  authenticatedProcedure,
  operatorMutationProcedure,
  router,
} from "./trpc";
import { resolvePublicUser } from "./publicUsers";
import {
  applyDriver,
  decideDriverApplication,
  DRIVER_APPLICATION_STATUSES,
  getMyDriverApplication,
  listDriverApplications,
  withdrawMyDriverApplication,
} from "./driverOnboarding";

/**
 * Driver onboarding router (Audit A P0-1).
 *
 * Self-serve procedures are scoped to the caller's own public.users identity
 * (resolvePublicUser, same convention as selfserveRouter). Operator
 * procedures run under operatorMutationProcedure("write_platform") — MFA +
 * policy gated, same tier as council membership and platform config writes.
 */
export const driverOnboardingRouter = router({
  // Named submitApplication because `apply` is a reserved word in tRPC
  // routers (Function.prototype.apply collision).
  submitApplication: authenticatedProcedure
    .input(
      z.object({
        fullName: z.string().trim().min(2).max(255),
        phone: z.string().trim().min(3).max(32).optional(),
        city: z.string().trim().min(2).max(120).optional(),
        vehicle: z
          .object({
            type: z.string().trim().min(1).max(50).optional(),
            number: z.string().trim().min(1).max(50).optional(),
            licenseNumber: z.string().trim().min(1).max(100).optional(),
          })
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const publicUser = await resolvePublicUser(ctx.user);
      return applyDriver({
        userId: publicUser.id,
        fullName: input.fullName,
        phone: input.phone ?? null,
        city: input.city ?? null,
        vehicle: input.vehicle ?? null,
      });
    }),

  getMyApplication: authenticatedProcedure.query(async ({ ctx }) => {
    const publicUser = await resolvePublicUser(ctx.user);
    return getMyDriverApplication(publicUser.id);
  }),

  withdraw: authenticatedProcedure.mutation(async ({ ctx }) => {
    const publicUser = await resolvePublicUser(ctx.user);
    return withdrawMyDriverApplication(publicUser.id);
  }),

  listApplications: operatorMutationProcedure("write_platform")
    .input(
      z
        .object({
          status: z.enum(DRIVER_APPLICATION_STATUSES).optional(),
          limit: z.number().int().min(1).max(200).optional(),
        })
        .optional(),
    )
    .query(({ input }) => listDriverApplications(input ?? undefined)),

  decideApplication: operatorMutationProcedure("write_platform")
    .input(
      z.object({
        applicationId: z.string().uuid(),
        decision: z.enum(["approved", "rejected"]),
        rejectionReason: z.string().trim().min(2).max(1000).optional(),
      }),
    )
    .mutation(({ input }) =>
      decideDriverApplication({
        applicationId: input.applicationId,
        decision: input.decision,
        rejectionReason: input.rejectionReason ?? null,
      }),
    ),
});
