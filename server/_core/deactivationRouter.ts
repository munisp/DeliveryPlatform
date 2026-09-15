import { z } from "zod";

import {
  authenticatedProcedure,
  operatorMutationProcedure,
  platformReadProcedure,
  router,
} from "./trpc";
import { resolvePublicUser } from "./publicUsers";
import {
  assignReviewer,
  fileAppeal,
  getMyCase,
  initiateCase,
  listCases,
  reviewAppeal,
  setProtectedActivity,
  DEACTIVATION_CAUSES,
  DEACTIVATION_SUBJECT_ROLES,
  APPEAL_DECISIONS,
} from "./deactivationDueProcess";

export const deactivationRouter = router({
  initiateCase: operatorMutationProcedure("write_platform")
    .input(
      z.object({
        subjectUserId: z.number().int().positive(),
        subjectRole: z.enum(DEACTIVATION_SUBJECT_ROLES),
        causeCode: z.enum(DEACTIVATION_CAUSES),
        egregious: z.boolean().optional(),
        evidence: z.array(z.unknown()).optional(),
        protectedActivity: z.boolean().optional(),
        elevatedJustification: z.string().max(4000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actor = await resolvePublicUser(ctx.user);
      return initiateCase(actor.id, input);
    }),

  getMyCase: authenticatedProcedure.query(async ({ ctx }) => {
    const publicUser = await resolvePublicUser(ctx.user);
    return getMyCase(publicUser.id);
  }),

  fileAppeal: authenticatedProcedure
    .input(
      z.object({
        caseId: z.string().uuid(),
        statement: z.string().trim().min(10).max(10000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const publicUser = await resolvePublicUser(ctx.user);
      return fileAppeal(publicUser.id, input);
    }),

  listCases: platformReadProcedure
    .input(
      z
        .object({
          status: z
            .enum([
              "notice",
              "active",
              "appealed",
              "reinstated",
              "upheld",
              "closed",
            ])
            .optional(),
        })
        .optional(),
    )
    .query(({ input }) => listCases(input)),

  assignReviewer: operatorMutationProcedure("write_platform")
    .input(
      z.object({
        appealId: z.string().uuid(),
        reviewerId: z.number().int().positive(),
      }),
    )
    .mutation(({ input }) => assignReviewer(input)),

  reviewAppeal: operatorMutationProcedure("write_platform")
    .input(
      z.object({
        appealId: z.string().uuid(),
        decision: z.enum(APPEAL_DECISIONS),
        rationale: z.string().trim().min(10).max(10000),
        backpayAmountMinor: z.number().int().min(0).optional(),
      }),
    )
    .mutation(({ input }) => reviewAppeal(input)),

  setProtectedActivity: operatorMutationProcedure("write_platform")
    .input(
      z.object({
        userId: z.number().int().positive(),
        protected: z.boolean(),
      }),
    )
    .mutation(({ input }) => setProtectedActivity(input)),
});
