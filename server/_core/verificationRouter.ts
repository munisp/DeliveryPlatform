import { z } from "zod";

import {
  authenticatedProcedure,
  operatorMutationProcedure,
  router,
} from "./trpc";
import { resolvePublicUser } from "./publicUsers";
import {
  decideVerificationAppeal,
  fileVerificationAppeal,
  listMyVerificationAppeals,
  listVerificationAppeals,
  VERIFICATION_APPEAL_DECISIONS,
} from "./verificationAppeals";

/**
 * Verification appeal surface (Audit A P1-10). Self-serve procedures are
 * scoped to the caller's own public.users identity (same convention as
 * driverOnboardingRouter); operator procedures run under
 * operatorMutationProcedure("write_platform"). Separation of duties
 * (reviewer != original case decider) is enforced in verificationAppeals.
 */
export const verificationRouter = router({
  fileAppeal: authenticatedProcedure
    .input(
      z.object({
        caseId: z.string().uuid(),
        statement: z.string().trim().min(3).max(4000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const publicUser = await resolvePublicUser(ctx.user);
      return fileVerificationAppeal(publicUser.id, input);
    }),

  listMyAppeals: authenticatedProcedure.query(async ({ ctx }) => {
    const publicUser = await resolvePublicUser(ctx.user);
    return listMyVerificationAppeals(publicUser.id);
  }),

  listAppeals: operatorMutationProcedure("write_platform")
    .input(
      z
        .object({
          status: z.enum(["filed", "in_review", "decided"]).optional(),
        })
        .optional(),
    )
    .query(({ input }) => listVerificationAppeals(input ?? undefined)),

  decideAppeal: operatorMutationProcedure("write_platform")
    .input(
      z.object({
        appealId: z.string().uuid(),
        decision: z.enum(VERIFICATION_APPEAL_DECISIONS),
        rationale: z.string().trim().min(3).max(4000),
      }),
    )
    // ctx.user.id is the public.users id used by decideVerificationCase
    // (decided_by_user_id) — the reviewer!=decider check compares like ids.
    .mutation(({ ctx, input }) =>
      decideVerificationAppeal(ctx.user!.id, input),
    ),
});
