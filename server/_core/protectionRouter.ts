import { z } from "zod";

import {
  authenticatedProcedure,
  operatorMutationProcedure,
  router,
} from "./trpc";
import { resolvePublicUser } from "./publicUsers";
import {
  acceptRemittanceChange,
  decideClaim,
  enroll,
  fileClaim,
  getMyEnrollment,
  getMyRemittanceSchedule,
  getPolicy,
  listMaintenanceProviders,
  listMyClaims,
  notifyRemittanceChange,
  optOut,
  requestMediation,
  upsertPolicy,
} from "./driverProtection";

/**
 * Driver protection surface (R11 insurance/downtime, R12 remittance-aware
 * floor). Enrollment, claims and remittance re-acceptance are self-serve;
 * policy and claim decisions are operator-only with advisory worker-council
 * auto-posts on policy changes.
 */
export const protectionRouter = router({
  getPolicy: authenticatedProcedure
    .input(z.object({ marketId: z.string().trim().min(1).max(128) }))
    .query(({ input }) => getPolicy(input.marketId)),

  getMyEnrollment: authenticatedProcedure.query(async ({ ctx }) => {
    const publicUser = await resolvePublicUser(ctx.user);
    return getMyEnrollment(publicUser.id);
  }),

  enroll: authenticatedProcedure
    .input(z.object({ marketId: z.string().trim().min(1).max(128) }))
    .mutation(async ({ ctx, input }) => {
      const publicUser = await resolvePublicUser(ctx.user);
      return enroll(publicUser.id, input);
    }),

  optOut: authenticatedProcedure.mutation(async ({ ctx }) => {
    const publicUser = await resolvePublicUser(ctx.user);
    return optOut(publicUser.id);
  }),

  fileClaim: authenticatedProcedure
    .input(
      z.object({
        kind: z.enum(["accident_downtime", "maintenance", "other"]),
        amountMinor: z.number().int().min(0).optional(),
        evidence: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const publicUser = await resolvePublicUser(ctx.user);
      return fileClaim(publicUser.id, input);
    }),

  listMyClaims: authenticatedProcedure.query(async ({ ctx }) => {
    const publicUser = await resolvePublicUser(ctx.user);
    return listMyClaims(publicUser.id);
  }),

  decideClaim: operatorMutationProcedure("write_platform")
    .input(
      z.object({
        claimId: z.string().uuid(),
        decision: z.enum(["approved", "rejected", "paid"]),
        amountMinor: z.number().int().min(0).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actor = await resolvePublicUser(ctx.user);
      return decideClaim(actor.id, input);
    }),

  upsertPolicy: operatorMutationProcedure("write_platform")
    .input(
      z.object({
        marketId: z.string().trim().min(1).max(128),
        microPremiumMinor: z.number().int().min(0).optional(),
        downtimeDailyStipendMinor: z.number().int().min(0).optional(),
        protectionLevyMinor: z.number().int().min(0).optional(),
        optOutAllowed: z.boolean().optional(),
        active: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actor = await resolvePublicUser(ctx.user);
      return upsertPolicy(actor.id, input);
    }),

  listMaintenanceProviders: authenticatedProcedure
    .input(
      z
        .object({ city: z.string().trim().min(1).max(128).optional() })
        .optional(),
    )
    .query(({ input }) => listMaintenanceProviders({ city: input?.city })),

  getMyRemittanceSchedule: authenticatedProcedure.query(async ({ ctx }) => {
    const publicUser = await resolvePublicUser(ctx.user);
    return getMyRemittanceSchedule(publicUser.id);
  }),

  notifyRemittanceChange: operatorMutationProcedure("write_platform")
    .input(
      z.object({
        scheduleId: z.string().uuid(),
        newAmountMinor: z.number().int().positive(),
        effectiveAt: z.string().datetime(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actor = await resolvePublicUser(ctx.user);
      return notifyRemittanceChange(actor.id, input);
    }),

  acceptRemittanceChange: authenticatedProcedure
    .input(z.object({ noticeId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const publicUser = await resolvePublicUser(ctx.user);
      return acceptRemittanceChange(publicUser.id, input);
    }),

  requestMediation: authenticatedProcedure
    .input(z.object({ scheduleId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const publicUser = await resolvePublicUser(ctx.user);
      return requestMediation(publicUser.id, input);
    }),
});
