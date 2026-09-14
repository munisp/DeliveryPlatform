import { createHash } from "node:crypto";

import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  getDriverIncentives,
  getDriverMarketplaceProfile,
  getDriverPerformanceScore,
  getDriverSettlements,
  getPool,
} from "../db";
import {
  declineTransparentDriverOffer,
  listTransparentDriverOffers,
} from "./driverDispatchFairness";
import { resolvePublicUser } from "./publicUsers";
import { authenticatedProcedure, router, type SessionUser } from "./trpc";

// resolvePublicUser now lives in ./publicUsers (shared with the session
// unification path); re-exported here so existing imports keep working.
export { resolvePublicUser } from "./publicUsers";
export type { LinkedPublicUser } from "./publicUsers";
import {
  listVehicleAccessContracts,
  listVehicleAccessOffers,
  listVehicleRentalAddOns,
  requestVehicleAccessWithAddOns,
  transitionVehicleAccessContract,
} from "./vehicleAccess";

/**
 * Courier / gig-worker self-serve router.
 *
 * Every procedure is an authenticatedProcedure and is scoped to the caller's
 * own identity. Sessions carry an `operator_credentials` identity, but the
 * courier domain tables are keyed by `public.users.id`, so vehicle-rental and
 * dispatch-fairness wrappers first resolve the caller's `public.users` row
 * via resolvePublicUser (open_id, then email, provisioning the row on first
 * use) and only ever pass THAT id to the underlying modules. The
 * earnings/settlement/performance wrappers resolve the caller's row in the
 * `drivers` table and only ever query with that driver id.
 *
 * Driver <-> user linkage: the `drivers` table has no user_id column. It does
 * carry a UNIQUE `open_id` (matching users.open_id for accounts provisioned
 * through the same identity flow) and an `email`. We resolve the caller's
 * driver row by open_id first and fall back to a case-insensitive email
 * match, preferring the open_id row when both match.
 */

export type LinkedDriver = {
  id: number;
  name: string;
  status: string;
  link: "open_id" | "email";
};

export async function resolveDriverForUser(
  user: Pick<SessionUser, "openId" | "email">,
): Promise<LinkedDriver | null> {
  const pool = await getPool();
  const result = await pool.query<{
    id: number;
    name: string;
    status: string;
    link: "open_id" | "email";
  }>(
    `SELECT id, name, status::text AS status, link
     FROM (
       SELECT d.id, d.name, d.status, 'open_id'::text AS link, 0 AS rank
       FROM drivers d
       WHERE $1::text IS NOT NULL AND d.open_id = $1
       UNION ALL
       SELECT d.id, d.name, d.status, 'email'::text AS link, 1 AS rank
       FROM drivers d
       WHERE $2::text IS NOT NULL AND d.email IS NOT NULL
         AND lower(d.email) = lower($2)
     ) matches
     ORDER BY rank, id
     LIMIT 1`,
    [user.openId ?? null, user.email ?? null],
  );
  return result.rows[0] ?? null;
}

async function requireLinkedDriver(user: SessionUser): Promise<LinkedDriver> {
  const driver = await resolveDriverForUser(user);
  if (!driver) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message:
        "no_driver_profile_linked: this account is not linked to a courier profile yet",
    });
  }
  return driver;
}

export type RentalCharge = {
  id: string;
  contractId: string;
  driverUserId: number;
  chargeType: string;
  amountMinor: number;
  currency: string;
  status: "pending" | "posted" | "paid" | "void";
  ledgerReference: string;
  createdAt: string;
  updatedAt: string;
  postedAt: string | null;
  paidAt: string | null;
};

/**
 * Post a pending rental charge for a contract, idempotently.
 *
 * The charge amount is read from the contract's own offer (activation uses
 * the weekly rent; deposit uses the deposit) so it can never disagree with
 * what the courier accepted. The UNIQUE (contract_id, charge_type)
 * constraint from migration 0074 makes re-posting a no-op; the function
 * returns the pre-existing row in that case. The WHERE clause pins the
 * contract to the owning driver so one courier can never post (or see) a
 * charge against another courier's contract.
 */
export async function recordRentalCharge(input: {
  contractId: string;
  driverUserId: number;
  chargeType:
    | "activation"
    | "weekly"
    | "addon"
    | "deposit"
    | "excess_km"
    | "adjustment";
  idempotencyKey: string;
}): Promise<RentalCharge | null> {
  const pool = await getPool();
  const ledgerReference = `vrc-${createHash("sha256")
    .update(`${input.contractId}:${input.chargeType}`)
    .digest("hex")
    .slice(0, 24)}`;
  const amountSource =
    input.chargeType === "deposit" ? "o.deposit_minor" : "o.weekly_price_minor";
  const result = await pool.query<{
    id: string;
    contract_id: string;
    driver_user_id: number;
    charge_type: string;
    amount_minor: string | number;
    currency: string;
    status: RentalCharge["status"];
    ledger_reference: string;
    created_at: Date;
    updated_at: Date;
    posted_at: Date | null;
    paid_at: Date | null;
  }>(
    `INSERT INTO public.vehicle_rental_charges (
       contract_id, driver_user_id, charge_type, amount_minor, currency,
       status, ledger_reference, idempotency_key
     )
     SELECT c.id, c.worker_user_id, $2, ${amountSource}, o.currency,
            'pending', $3, $4
     FROM vehicle_access.access_contract c
     JOIN vehicle_access.vehicle_offer o ON o.id = c.offer_id
     WHERE c.id = $1::uuid AND c.worker_user_id = $5
     ON CONFLICT (contract_id, charge_type) DO NOTHING
     RETURNING *`,
    [
      input.contractId,
      input.chargeType,
      ledgerReference,
      input.idempotencyKey,
      input.driverUserId,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    // Either the charge already exists (idempotent replay) or the contract
    // does not belong to this driver; return the existing row if any.
    const existing = await pool.query<{
      id: string;
      contract_id: string;
      driver_user_id: number;
      charge_type: string;
      amount_minor: string | number;
      currency: string;
      status: RentalCharge["status"];
      ledger_reference: string;
      created_at: Date;
      updated_at: Date;
      posted_at: Date | null;
      paid_at: Date | null;
    }>(
      `SELECT * FROM public.vehicle_rental_charges
       WHERE contract_id = $1::uuid AND charge_type = $2 AND driver_user_id = $3`,
      [input.contractId, input.chargeType, input.driverUserId],
    );
    const existingRow = existing.rows[0];
    return existingRow ? toRentalCharge(existingRow) : null;
  }
  return toRentalCharge(row);
}

function toRentalCharge(row: {
  id: string;
  contract_id: string;
  driver_user_id: number;
  charge_type: string;
  amount_minor: string | number;
  currency: string;
  status: RentalCharge["status"];
  ledger_reference: string;
  created_at: Date;
  updated_at: Date;
  posted_at: Date | null;
  paid_at: Date | null;
}): RentalCharge {
  return {
    id: row.id,
    contractId: row.contract_id,
    driverUserId: Number(row.driver_user_id),
    chargeType: row.charge_type,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    status: row.status,
    ledgerReference: row.ledger_reference,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    postedAt: row.posted_at ? new Date(row.posted_at).toISOString() : null,
    paidAt: row.paid_at ? new Date(row.paid_at).toISOString() : null,
  };
}

const limitInput = z
  .object({ limit: z.number().int().min(1).max(100).default(25) })
  .optional();

const idempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);

const contractActionSchema = z.enum([
  "approve",
  "handover",
  "begin_return",
  "close",
  "cancel",
  "suspend",
  "begin_safe_return",
]);

type ContractAction = Parameters<
  typeof transitionVehicleAccessContract
>[0]["action"];

export const selfserveRouter = router({
  myDriverProfile: authenticatedProcedure.query(async ({ ctx }) => {
    const driver = await resolveDriverForUser(ctx.user);
    return driver;
  }),

  myIncentives: authenticatedProcedure
    .input(
      z
        .object({ status: z.string().trim().min(1).max(32).optional() })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const driver = await requireLinkedDriver(ctx.user);
      return getDriverIncentives(driver.id, input?.status);
    }),

  mySettlements: authenticatedProcedure.query(async ({ ctx }) => {
    const driver = await requireLinkedDriver(ctx.user);
    return getDriverSettlements(driver.id);
  }),

  myPerformance: authenticatedProcedure.query(async ({ ctx }) => {
    const driver = await requireLinkedDriver(ctx.user);
    return getDriverPerformanceScore(driver.id);
  }),

  myMarketplaceProfile: authenticatedProcedure.query(async ({ ctx }) => {
    const driver = await requireLinkedDriver(ctx.user);
    return getDriverMarketplaceProfile(driver.id);
  }),

  myVehicleOffers: authenticatedProcedure
    .input(limitInput)
    .query(async ({ input }) => {
      return listVehicleAccessOffers(input?.limit ?? 25);
    }),

  myVehicleContracts: authenticatedProcedure
    .input(limitInput)
    .query(async ({ ctx, input }) => {
      const publicUser = await resolvePublicUser(ctx.user);
      return listVehicleAccessContracts({
        actorUserId: publicUser.id,
        limit: input?.limit ?? 25,
      });
    }),

  myRentalAddOns: authenticatedProcedure
    .input(
      z.object({
        offerId: z.string().uuid(),
        limit: z.number().int().min(1).max(100).default(50),
      }),
    )
    .query(async ({ input }) => {
      return listVehicleRentalAddOns({
        offerId: input.offerId,
        limit: input.limit,
      });
    }),

  myRentalCharges: authenticatedProcedure
    .input(limitInput)
    .query(async ({ ctx, input }) => {
      const publicUser = await resolvePublicUser(ctx.user);
      const pool = await getPool();
      const result = await pool.query(
        `SELECT * FROM public.vehicle_rental_charges
         WHERE driver_user_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [publicUser.id, input?.limit ?? 25],
      );
      return result.rows.map((row) => toRentalCharge(row));
    }),

  requestRental: authenticatedProcedure
    .input(
      z.object({
        offerId: z.string().uuid(),
        startsAt: z.string().datetime({ offset: true }),
        endsAt: z.string().datetime({ offset: true }),
        addOns: z
          .array(
            z.object({
              addOnVersionId: z.string().uuid(),
              quantity: z.number().int().min(1).max(10),
            }),
          )
          .max(20)
          .default([]),
        idempotencyKey: idempotencyKeySchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const publicUser = await resolvePublicUser(ctx.user);
      const contractId = await requestVehicleAccessWithAddOns({
        workerUserId: publicUser.id,
        offerId: input.offerId,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        addOns: input.addOns,
        idempotencyKey: input.idempotencyKey,
      });
      return { contractId };
    }),

  transitionRentalContract: authenticatedProcedure
    .input(
      z.object({
        contractId: z.string().uuid(),
        action: contractActionSchema,
        reason: z.string().trim().min(1).max(500).optional(),
        idempotencyKey: idempotencyKeySchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Resolve into the public.users ID space first: the contract worker /
      // operator authorization inside vehicle_access.transition_contract
      // (drizzle/0058) compares against public.users.id, never against the
      // operator_credential id carried by the session.
      const publicUser = await resolvePublicUser(ctx.user);
      const state = await transitionVehicleAccessContract({
        actorUserId: publicUser.id,
        contractId: input.contractId,
        action: input.action as ContractAction,
        reason: input.reason ?? null,
        idempotencyKey: input.idempotencyKey,
      });
      let activationCharge: RentalCharge | null = null;
      if (state === "active") {
        activationCharge = await recordRentalCharge({
          contractId: input.contractId,
          driverUserId: publicUser.id,
          chargeType: "activation",
          idempotencyKey: `${input.idempotencyKey}:charge`,
        });
      }
      return { state, activationCharge };
    }),

  myFairnessOffers: authenticatedProcedure.query(async ({ ctx }) => {
    const publicUser = await resolvePublicUser(ctx.user);
    return listTransparentDriverOffers(publicUser.id);
  }),

  declineOffer: authenticatedProcedure
    .input(
      z.object({
        offerId: z.string().uuid(),
        reason: z.enum([
          "pickup_distance_unprofitable",
          "pickup_time_unprofitable",
          "fare_insufficient",
          "destination_unsuitable",
          "safety_preference",
          "vehicle_constraint",
          "other",
        ]),
        idempotencyKey: idempotencyKeySchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const publicUser = await resolvePublicUser(ctx.user);
      return declineTransparentDriverOffer({
        driverUserId: publicUser.id,
        offerId: input.offerId,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      });
    }),
});
