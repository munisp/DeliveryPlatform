/**
 * Settlement dispute tRPC router (drizzle/0097 wave).
 *
 *   - rentalDispute.open   (authenticated) → renter opens a dispute against the
 *     computed return settlement (SQL verifies the caller is the contract's renter)
 *   - rentalDispute.decide (operator)      → upheld / rejected / adjusted decision
 *   - rentalDispute.list   (authenticated) → SQL enforces visibility (operators see
 *     all, renters only their own rows)
 *   - rentalDispute.get    (authenticated) → renter (own) or operator
 *
 * All writes flow through the SECURITY DEFINER functions in
 * server/_core/vehicleDispute.ts; this router only validates input shape.
 * Money movement for an 'adjusted' decision is OUT OF SCOPE here — the operator
 * applies it through the existing financial operations after the decision.
 */
import { z } from "zod";

import {
  authenticatedProcedure,
  protectedProcedure,
  router,
} from "../_core/trpc";
import {
  decideSettlementDispute,
  getSettlementDispute,
  listSettlementDisputes,
  openSettlementDispute,
} from "../_core/vehicleDispute";

const idempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);

const minorUnitsSchema = z.number().int().min(0).safe();

const disputeReasonSchema = z.enum([
  "damage_charge",
  "excess_km_charge",
  "fuel_charge",
  "odometer_dispute",
  "other",
]);

const disputeStatusSchema = z.enum([
  "open",
  "upheld",
  "rejected",
  "adjusted",
]);

const disputeDecisionSchema = z.enum(["upheld", "rejected", "adjusted"]);

// ---------------------------------------------------------------------------
// Pure decision helpers (no DB) — mirrored by the SQL authority function
// vehicle_access.decide_settlement_dispute; unit-tested directly.
// ---------------------------------------------------------------------------

/** 'adjusted' is the only decision that carries an adjustment amount. */
export function decisionRequiresAdjustment(
  status: "upheld" | "rejected" | "adjusted",
): boolean {
  return status === "adjusted";
}

/**
 * Disputable ceiling: renter_damage_liability_minor + excess_km_charge_minor.
 * Mirrors the SQL cap; throws RangeError when the sum is not a safe integer
 * (the SQL side is overflow-proof because both terms are bounded by
 * total_charge_minor via the settlement CHECK).
 */
export function maxDisputeAdjustmentMinor(
  renterDamageLiabilityMinor: number,
  excessKmChargeMinor: number,
): number {
  const total = renterDamageLiabilityMinor + excessKmChargeMinor;
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new RangeError("disputable charge total exceeds bigint range");
  }
  return total;
}

export const rentalDisputeRouter = router({
  open: authenticatedProcedure
    .input(
      z.object({
        contractId: z.string().uuid(),
        reason: disputeReasonSchema,
        detail: z.string().trim().min(10).max(2000),
        idempotencyKey: idempotencyKeySchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const disputeId = await openSettlementDispute({
        actorUserId: ctx.user!.id,
        contractId: input.contractId,
        reason: input.reason,
        detail: input.detail,
        idempotencyKey: input.idempotencyKey,
      });
      return { disputeId };
    }),

  decide: protectedProcedure
    .input(
      z.object({
        disputeId: z.string().uuid(),
        status: disputeDecisionSchema,
        adjustmentMinor: minorUnitsSchema.optional(),
        operatorNote: z.string().trim().min(1).max(2000).optional(),
        idempotencyKey: idempotencyKeySchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const disputeId = await decideSettlementDispute({
        actorUserId: ctx.user!.id,
        disputeId: input.disputeId,
        status: input.status,
        adjustmentMinor: input.adjustmentMinor ?? null,
        operatorNote: input.operatorNote ?? null,
        idempotencyKey: input.idempotencyKey,
      });
      return { disputeId };
    }),

  list: authenticatedProcedure
    .input(
      z.object({
        contractId: z.string().uuid().optional(),
        status: disputeStatusSchema.optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const disputes = await listSettlementDisputes({
        actorUserId: ctx.user!.id,
        contractId: input.contractId ?? null,
        status: input.status ?? null,
        limit: input.limit ?? 50,
      });
      return { disputes };
    }),

  get: authenticatedProcedure
    .input(z.object({ disputeId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return getSettlementDispute({
        actorUserId: ctx.user!.id,
        disputeId: input.disputeId,
      });
    }),
});
