import { z } from "zod";

import {
  authenticatedProcedure,
  operatorMutationProcedure,
  router,
} from "./trpc";
import { resolvePublicUser } from "./publicUsers";
import {
  getMyStanding,
  grantReward,
  listRewardRules,
  recordIntegrityEvent,
  revokeReward,
  upsertRewardRule,
} from "./integrityIncentives";

/**
 * Two-sided integrity incentives surface (R10). Rules are publicly listable
 * by any authenticated user (published-rules transparency); standings are
 * self-serve; event recording and reward administration are operator-only.
 */
export const incentivesRouter = router({
  listRewardRules: authenticatedProcedure.query(() => listRewardRules()),

  getMyStanding: authenticatedProcedure.query(async ({ ctx }) => {
    const publicUser = await resolvePublicUser(ctx.user);
    return getMyStanding(publicUser.id);
  }),

  recordIntegrityEvent: operatorMutationProcedure("write_platform")
    .input(
      z.object({
        userId: z.number().int().positive(),
        role: z.enum(["rider", "driver"]),
        eventType: z.enum([
          "verified_manifest",
          "verified_completion",
          "violation",
          "streak_reset",
          "reward_granted",
        ]),
        tripId: z.number().int().positive().optional(),
        detail: z.record(z.string(), z.unknown()).optional(),
        idempotencyKey: z.string().trim().min(1).max(200).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actor = await resolvePublicUser(ctx.user);
      return recordIntegrityEvent(actor.id, input);
    }),

  upsertRewardRule: operatorMutationProcedure("write_platform")
    .input(
      z.object({
        role: z.enum(["rider", "driver"]),
        ruleKey: z.string().trim().min(1).max(128),
        thresholdStreak: z.number().int().min(1),
        rewardType: z.enum(["credit", "badge", "priority"]),
        amountMinor: z.number().int().min(0).optional(),
        currency: z.string().trim().min(3).max(8).optional(),
        active: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actor = await resolvePublicUser(ctx.user);
      return upsertRewardRule(actor.id, input);
    }),

  grantReward: operatorMutationProcedure("write_platform")
    .input(z.object({ rewardId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const actor = await resolvePublicUser(ctx.user);
      return grantReward(actor.id, input);
    }),

  revokeReward: operatorMutationProcedure("write_platform")
    .input(
      z.object({
        rewardId: z.string().uuid(),
        reason: z.string().trim().max(1000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actor = await resolvePublicUser(ctx.user);
      return revokeReward(actor.id, input);
    }),
});
