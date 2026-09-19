import { z } from "zod";

import {
  authenticatedProcedure,
  operatorMutationProcedure,
  router,
} from "./trpc";
import { resolvePublicUser } from "./publicUsers";
import {
  checkFareAgainstFloor,
  generateMarketEconomicsReport,
  getFareFloorPolicy,
  getLatestTakeRate,
  publishTakeRate,
  recordFloorOverride,
  updateCostIndex,
} from "./economicsPolicy";

/**
 * Economics policy surface (R6 fare floor, R7 published take-rate).
 * Read endpoints require authentication (drivers and riders both see the
 * floor/take-rate that applies to them); mutations are operator-only and the
 * take-rate path is worker-council gated.
 */
export const economicsRouter = router({
  getFareFloor: authenticatedProcedure
    .input(z.object({ marketId: z.string().trim().min(1).max(128) }))
    .query(({ input }) => getFareFloorPolicy(input.marketId)),

  getTakeRate: authenticatedProcedure
    .input(z.object({ marketId: z.string().trim().min(1).max(128) }))
    .query(({ input }) => getLatestTakeRate(input.marketId)),

  updateCostIndex: operatorMutationProcedure("write_platform")
    .input(
      z.object({
        marketId: z.string().trim().min(1).max(128),
        fuelPriceMinor: z.number().int().min(0),
        cpiBp: z.number().int().min(0).max(100000),
        maintenanceIndexBp: z.number().int().min(0).max(100000),
        source: z.string().trim().min(1).max(200),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actor = await resolvePublicUser(ctx.user);
      return updateCostIndex(actor.id, input);
    }),

  publishTakeRate: operatorMutationProcedure("write_platform")
    .input(
      z.object({
        marketId: z.string().trim().min(1).max(128),
        rateBps: z.number().int().min(0).max(5000),
        basis: z.enum(["gross", "net_of_tolls", "net_of_costs"]),
        effectiveFrom: z.string().datetime(),
        consultationId: z.string().uuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actor = await resolvePublicUser(ctx.user);
      return publishTakeRate(actor.id, input);
    }),

  checkFareAgainstFloor: authenticatedProcedure
    .input(
      z.object({
        marketId: z.string().trim().min(1).max(128),
        fareMinor: z.number().int().min(0),
      }),
    )
    .query(({ input }) => checkFareAgainstFloor(input)),

  recordFloorOverride: operatorMutationProcedure("write_platform")
    .input(
      z.object({
        marketId: z.string().trim().min(1).max(128),
        fareMinor: z.number().int().min(0),
        justification: z.string().trim().min(3).max(4000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actor = await resolvePublicUser(ctx.user);
      return recordFloorOverride(actor.id, input);
    }),

  // Publishes a market economics report via the market-economics service
  // and persists it (Audit B orphan-service wiring, 8110). Fail-open: an
  // outage returns { persisted: false, unavailable: true }.
  generateMarketReport: operatorMutationProcedure("write_platform")
    .input(
      z.object({
        marketId: z.string().trim().min(1).max(64),
        periodStart: z.string().trim().min(4).max(40),
        periodEnd: z.string().trim().min(4).max(40),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actor = await resolvePublicUser(ctx.user);
      return generateMarketEconomicsReport(actor.id, input);
    }),
});
