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
  MAX_TAKE_RATE_BPS,
  MIN_TAKE_RATE_BPS,
  previewPricingImpact,
  publishPricingModel,
  publishTakeRate,
  recordFloorOverride,
  resolvePricingModel,
  updateCostIndex,
} from "./economicsPolicy";

/**
 * Economics policy surface (R6 fare floor, R7 published take-rate, P7
 * flexible pricing modes). Read endpoints require authentication (drivers
 * and riders both see the floor/take-rate that applies to them); mutations
 * are operator-only and the take-rate / pricing-model paths are
 * worker-council gated.
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
        // P7: negative down to -2000 bps = bounded driver subsidy (0106).
        rateBps: z.number().int().min(MIN_TAKE_RATE_BPS).max(MAX_TAKE_RATE_BPS),
        basis: z.enum(["gross", "net_of_tolls", "net_of_costs"]),
        effectiveFrom: z.string().datetime(),
        consultationId: z.string().uuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actor = await resolvePublicUser(ctx.user);
      return publishTakeRate(actor.id, input);
    }),

  // P7: zone pricing-model publish (commission / flat_fee / zero_commission /
  // subsidized). Versioned on mobility.fare_rule_version; worker-council
  // gated through the same 'commission' consultation kind as take rates.
  publishPricingModel: operatorMutationProcedure("write_platform")
    .input(
      z.object({
        zoneId: z.string().uuid(),
        model: z.enum([
          "commission",
          "flat_fee",
          "zero_commission",
          "subsidized",
        ]),
        flatFeeKobo: z.number().int().min(0).nullish(),
        feePayer: z.enum(["rider", "driver"]),
        consultationId: z.string().uuid(),
        version: z.string().trim().min(1).max(64).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actor = await resolvePublicUser(ctx.user);
      return publishPricingModel(actor.id, input);
    }),

  // P7: authenticated read of a zone's active pricing block (model, flat
  // fee, payer, take rate). marketId is optional; when supplied the block
  // carries that market's published take rate.
  getActivePricingModel: authenticatedProcedure
    .input(
      z.object({
        zoneId: z.string().uuid(),
        marketId: z.string().trim().min(1).max(128).optional(),
      }),
    )
    .query(({ input }) => resolvePricingModel(input.zoneId, input.marketId)),

  // P7: pure what-if preview (no writes) — example settlement splits at
  // three fare levels for a candidate pricing block.
  previewPricingImpact: operatorMutationProcedure("write_platform")
    .input(
      z.object({
        model: z.enum([
          "commission",
          "flat_fee",
          "zero_commission",
          "subsidized",
        ]),
        feePayer: z.enum(["rider", "driver"]),
        flatFeeKobo: z.number().int().min(0).nullish(),
        takeRateBps: z
          .number()
          .int()
          .min(MIN_TAKE_RATE_BPS)
          .max(MAX_TAKE_RATE_BPS)
          .optional(),
        fareLevelsKobo: z
          .array(z.number().int().min(1))
          .min(1)
          .max(3)
          .optional(),
      }),
    )
    .mutation(({ input }) => previewPricingImpact(input)),

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
