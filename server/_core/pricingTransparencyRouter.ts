import { z } from "zod";

import { authenticatedProcedure, router } from "./trpc";
import { resolvePublicUser } from "./publicUsers";
import {
  getMyNetEarningsSummary,
  getOfferBreakdown,
} from "./offerEconomics";

/**
 * Pricing transparency surface (R3 per-offer breakdown, R9 deadhead).
 * Self-serve: drivers read their own offer breakdowns and earnings rollup.
 */
export const pricingTransparencyRouter = router({
  getOfferBreakdown: authenticatedProcedure
    .input(z.object({ offerId: z.string().trim().min(1).max(64) }))
    .query(({ input }) => getOfferBreakdown(input.offerId)),

  getMyNetEarningsSummary: authenticatedProcedure.query(async ({ ctx }) => {
    const publicUser = await resolvePublicUser(ctx.user);
    return getMyNetEarningsSummary(publicUser.id);
  }),
});
