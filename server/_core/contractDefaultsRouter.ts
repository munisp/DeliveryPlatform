import { z } from "zod";

import {
  authenticatedProcedure,
  operatorMutationProcedure,
  router,
} from "./trpc";
import { resolvePublicUser } from "./publicUsers";
import {
  getContractDefaults,
  publishContractDefaults,
  setContractDefaults,
} from "./contractDefaults";

/**
 * Local-law contract defaults surface (R15). Reading the effective defaults
 * is self-serve; setting and publishing them is operator-only, with a
 * worker-council consultation auto-posted on set and an activated/SLA-elapsed
 * consultation required before publish.
 */
export const contractDefaultsRouter = router({
  getContractDefaults: authenticatedProcedure
    .input(z.object({ marketId: z.string().trim().min(1).max(128) }))
    .query(({ input }) => getContractDefaults(input.marketId)),

  setContractDefaults: operatorMutationProcedure("write_platform")
    .input(
      z.object({
        marketId: z.string().trim().min(1).max(128),
        governingLaw: z.string().trim().min(1).max(200).optional(),
        disputeForum: z.string().trim().min(1).max(200).optional(),
        consumerProtectionOverrides: z
          .record(z.string(), z.unknown())
          .optional(),
        effectiveFrom: z.coerce.date().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actor = await resolvePublicUser(ctx.user);
      return setContractDefaults(actor.id, input);
    }),

  publishContractDefaults: operatorMutationProcedure("write_platform")
    .input(
      z.object({
        marketId: z.string().trim().min(1).max(128),
        consultationId: z.string().uuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actor = await resolvePublicUser(ctx.user);
      return publishContractDefaults(actor.id, input);
    }),
});
