/**
 * Rental condition & insurance tRPC routers (drizzle/0096 wave).
 *
 *   - rentalInsurance.listForOffer  (public)        → active tiers for an offer
 *   - rentalInsurance.createTier    (operator)      → vehicle_access.create_insurance_tier
 *   - rentalInsurance.retireTier    (operator)      → vehicle_access.retire_insurance_tier
 *   - rentalInsurance.selectTier    (authenticated) → worker locks a tier onto the contract
 *   - rentalCondition.recordReport  (authenticated) → check-out / check-in evidence
 *   - rentalCondition.deltaReport   (authenticated) → side-by-side delta + settlement
 *   - rentalCondition.computeSettlement (operator)  → final return settlement
 *
 * All writes flow through the SECURITY DEFINER functions in
 * server/_core/vehicleCondition.ts; this router only validates input shape.
 */
import { z } from "zod";

import {
  authenticatedProcedure,
  protectedProcedure,
  publicProcedure,
  router,
} from "../_core/trpc";
import {
  computeReturnSettlement,
  createInsuranceTier,
  getConditionDeltaReport,
  listInsuranceTiersForOffer,
  recordConditionReport,
  retireInsuranceTier,
  selectContractInsurance,
} from "../_core/vehicleCondition";

const idempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);

const tierCodeSchema = z.string().regex(/^[a-z][a-z0-9_-]{1,62}$/);

const currencySchema = z.string().trim().length(3);

const minorUnitsSchema = z.number().int().min(0).safe();

const photoZoneSchema = z.enum([
  "front",
  "rear",
  "left",
  "right",
  "interior_front",
  "interior_rear",
  "dashboard_odometer",
  "wheels",
  "roof",
  "other",
]);

const conditionPhotoSchema = z.object({
  zone: photoZoneSchema,
  objectKey: z
    .string()
    .min(3)
    .max(512)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]+$/),
  contentType: z.enum(["image/jpeg", "image/png", "image/heic"]),
  sha256Hex: z.string().regex(/^[a-f0-9]{64}$/),
  damageFlag: z.boolean(),
  note: z.string().trim().min(3).max(500).optional(),
});

export const rentalInsuranceRouter = router({
  listForOffer: publicProcedure
    .input(
      z.object({
        offerId: z.string().uuid(),
        limit: z.number().int().min(1).max(24).optional(),
      }),
    )
    .query(async ({ input }) => {
      const tiers = await listInsuranceTiersForOffer({
        offerId: input.offerId,
        limit: input.limit ?? 24,
      });
      return { tiers };
    }),

  createTier: protectedProcedure
    .input(
      z.object({
        providerId: z.string().uuid(),
        tierCode: tierCodeSchema,
        displayName: z.string().trim().min(2).max(120),
        currency: currencySchema,
        dailyRateMinor: minorUnitsSchema,
        excessMinor: minorUnitsSchema,
        liabilityCapMinor: minorUnitsSchema,
        damageCapMinor: minorUnitsSchema,
        theftCovered: z.boolean(),
        depositMultiplierBp: z.number().int().min(0).max(100_000),
        idempotencyKey: idempotencyKeySchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const tierId = await createInsuranceTier({
        actorUserId: ctx.user!.id,
        providerId: input.providerId,
        tierCode: input.tierCode,
        displayName: input.displayName,
        currency: input.currency,
        dailyRateMinor: input.dailyRateMinor,
        excessMinor: input.excessMinor,
        liabilityCapMinor: input.liabilityCapMinor,
        damageCapMinor: input.damageCapMinor,
        theftCovered: input.theftCovered,
        depositMultiplierBp: input.depositMultiplierBp,
        idempotencyKey: input.idempotencyKey,
      });
      return { tierId };
    }),

  retireTier: protectedProcedure
    .input(
      z.object({
        tierId: z.string().uuid(),
        idempotencyKey: idempotencyKeySchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const retired = await retireInsuranceTier({
        actorUserId: ctx.user!.id,
        tierId: input.tierId,
        idempotencyKey: input.idempotencyKey,
      });
      return { retired };
    }),

  selectTier: authenticatedProcedure
    .input(
      z.object({
        contractId: z.string().uuid(),
        tierId: z.string().uuid(),
        idempotencyKey: idempotencyKeySchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const selectionId = await selectContractInsurance({
        workerUserId: ctx.user!.id,
        contractId: input.contractId,
        tierId: input.tierId,
        idempotencyKey: input.idempotencyKey,
      });
      return { selectionId };
    }),
});

export const rentalConditionRouter = router({
  recordReport: authenticatedProcedure
    .input(
      z.object({
        contractId: z.string().uuid(),
        phase: z.enum(["check_out", "check_in"]),
        odometerKm: z.number().int().min(0),
        fuelPct: z.number().int().min(0).max(100),
        overallCondition: z.enum([
          "excellent",
          "good",
          "fair",
          "poor",
          "damaged",
        ]),
        notes: z.string().trim().min(3).max(1000).optional(),
        photos: z.array(conditionPhotoSchema).min(1).max(24),
        idempotencyKey: idempotencyKeySchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const reportId = await recordConditionReport({
        actorUserId: ctx.user!.id,
        contractId: input.contractId,
        phase: input.phase,
        odometerKm: input.odometerKm,
        fuelPct: input.fuelPct,
        overallCondition: input.overallCondition,
        notes: input.notes ?? null,
        photos: input.photos,
        idempotencyKey: input.idempotencyKey,
      });
      return { reportId };
    }),

  deltaReport: authenticatedProcedure
    .input(z.object({ contractId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return getConditionDeltaReport({
        actorUserId: ctx.user!.id,
        contractId: input.contractId,
      });
    }),

  computeSettlement: protectedProcedure
    .input(
      z.object({
        contractId: z.string().uuid(),
        damageChargeMinor: minorUnitsSchema,
        fuelChargeMinor: minorUnitsSchema,
        idempotencyKey: idempotencyKeySchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const settlementId = await computeReturnSettlement({
        actorUserId: ctx.user!.id,
        contractId: input.contractId,
        damageChargeMinor: input.damageChargeMinor,
        fuelChargeMinor: input.fuelChargeMinor,
        idempotencyKey: input.idempotencyKey,
      });
      return { settlementId };
    }),
});
