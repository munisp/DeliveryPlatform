import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { getPool } from "../db";
import { IDEMPOTENCY_KEY_REGEX } from "./merchantSelfServe";
import { resolvePublicUser } from "./publicUsers";
import {
  authenticatedProcedure,
  operatorMutationProcedure,
  router,
  type SessionUser,
} from "./trpc";

/**
 * P4-V verticals shared write layer (WS-VERTICALS) — freight, business
 * travel and healthcare transport writers over the 0073 mobility surfaces.
 *
 * Substrate contract (drizzle/0073_mobility_surfaces.sql — BINDING):
 *   - freight_loads.status:
 *       draft -> tendered -> assigned -> picked_up -> in_transit -> delivered
 *       (+ cancelled from any pre-delivered state, with reason)
 *   - business_travel_trips.status:
 *       requested -> approved -> in_progress -> completed (+rejected/cancelled)
 *     business_travel_trips.expense_state: open -> submitted -> reconciled
 *   - healthcare_transport_bookings.status:
 *       scheduled -> en_route -> arrived -> completed (+cancelled pre-completed)
 *     schedule_mode: scheduled / same_day / recurring
 *
 * Discipline (P4_SPEC "Shared discipline"):
 *   - NO migrations. The 0073 tables are not in drizzle/schema.ts, so all
 *     access is parameterized raw SQL via getPool() (openride/telemetry.ts
 *     DDL-only pattern). freight_loads has NO carrier column and DDL is
 *     forbidden, so assignFreightCarrier validates the carrier against
 *     public.service_providers and records carrier_provider_id in the
 *     idempotency-ledger result payload (deviation documented in the P4-V
 *     report; recon §A lists "carrier assignment FK" as a follow-up).
 *   - Money is integer MINOR units (kobo): every money input is
 *     z.number().int().nonnegative(); currency is CHAR(3) and this wave is
 *     NGN-only (z.literal("NGN"), default 'NGN').
 *   - Idempotency: every writer takes idempotencyKey matching
 *     IDEMPOTENCY_KEY_REGEX (merchantSelfServe.ts:68-70). Replay is served
 *     from the EXISTING public.consumer_processed_events ledger (0072) with
 *     consumer_name 'vertical-ops' and event_id `${actorUserId}:${key}` —
 *     actor-scoped so keys never collide across callers. The ledger insert
 *     rides the SAME transaction as the state mutation.
 *   - Illegal transitions raise P0002-style errors (Error with .code set,
 *     mirroring the SQL-function convention) and map via
 *     mapVerticalOpsSqlError: 22023->BAD_REQUEST, P0002->NOT_FOUND,
 *     42501->FORBIDDEN, 23505/23514/55000->CONFLICT
 *     (consumerCommerce/merchantSelfServe convention).
 *   - Authz: ops actions use operatorMutationProcedure("operate");
 *     the my-Star and actor-create surfaces use authenticatedProcedure +
 *     resolvePublicUser (publicUsers.ts:44) and are pinned to the caller's
 *     public.users id.
 */

const LEDGER_CONSUMER = "vertical-ops";

const idempotencyKeySchema = z.string().regex(IDEMPOTENCY_KEY_REGEX);
/** Integer minor units only — no floats, no negatives (0073 CHECK >= 0). */
const minorUnitsSchema = z.number().int().nonnegative();
/** 0073 currency CHAR(3) DEFAULT 'NGN'; this wave accepts NGN only. */
const currencySchema = z.literal("NGN").default("NGN");
const positiveId = z.number().int().positive();

type Queryable = {
  query: <T = unknown>(text: string, values?: unknown[]) => Promise<{ rows: T[] }>;
};

/** Raise a Postgres-style error (code carrier) from the JS write layer. */
function pgRaise(code: string, message: string): never {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  throw error;
}

export function mapVerticalOpsSqlError(error: unknown): never {
  if (error instanceof TRPCError) throw error;
  const pgCode = (error as { code?: string })?.code;
  const message = (error as Error)?.message ?? "vertical_ops_failed";
  switch (pgCode) {
    case "22023":
      throw new TRPCError({ code: "BAD_REQUEST", message, cause: error });
    case "P0002":
      throw new TRPCError({ code: "NOT_FOUND", message, cause: error });
    case "42501":
      throw new TRPCError({ code: "FORBIDDEN", message, cause: error });
    case "23505":
    case "23514":
    case "55000":
      throw new TRPCError({ code: "CONFLICT", message, cause: error });
    default:
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "vertical_ops_failed",
        cause: error,
      });
  }
}

async function recordLedger(
  db: Queryable,
  topic: string,
  eventId: string,
  result: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `INSERT INTO public.consumer_processed_events (consumer_name, topic, event_id, result_json)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (consumer_name, topic, event_id) DO NOTHING`,
    [LEDGER_CONSUMER, topic, eventId, JSON.stringify(result)],
  );
}

/**
 * Idempotent writer skeleton: ledger replay check, then BEGIN / execute /
 * ledger-insert / COMMIT with the merchantSelfServe rollback+map discipline.
 */
async function runWriter<TResult extends Record<string, unknown>>(args: {
  topic: string;
  actorUserId: number;
  idempotencyKey: string;
  execute: (client: Queryable) => Promise<TResult>;
}): Promise<TResult & { replayed: boolean }> {
  const pool = await getPool();
  const eventId = `${args.actorUserId}:${args.idempotencyKey}`;

  const stored = await pool.query<{ result_json: unknown }>(
    `SELECT result_json FROM public.consumer_processed_events
     WHERE consumer_name = $1 AND topic = $2 AND event_id = $3`,
    [LEDGER_CONSUMER, args.topic, eventId],
  );
  const storedResult = stored.rows[0]?.result_json as TResult | undefined;
  if (storedResult && typeof storedResult === "object") {
    return { ...storedResult, replayed: true };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await args.execute(client);
    await recordLedger(client, args.topic, eventId, result);
    await client.query("COMMIT");
    return { ...result, replayed: false };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    mapVerticalOpsSqlError(error);
  } finally {
    client.release();
  }
}

async function resolveActor(
  user: Pick<SessionUser, "openId" | "email" | "name"> & {
    id?: number | null;
    operatorCredentialId?: number | null;
  },
): Promise<number> {
  const linked = await resolvePublicUser(user);
  return Number(linked.id);
}

// ---------------------------------------------------------------------------
// Freight (freight_loads, 0073:78-96)
// ---------------------------------------------------------------------------

const FREIGHT_EQUIPMENT = ["box_truck", "sprinter", "reefer", "flatbed"] as const;

/** Legal forward edges; 'cancelled' is legal from any pre-delivered state. */
const FREIGHT_FORWARD: Record<string, string[]> = {
  assigned: ["picked_up"],
  picked_up: ["in_transit"],
  in_transit: ["delivered"],
};
const FREIGHT_CANCELLABLE = new Set([
  "draft",
  "tendered",
  "assigned",
  "picked_up",
  "in_transit",
]);

type FreightLoadRow = { id: number | string; status: string };

async function lockFreightLoad(client: Queryable, loadId: number): Promise<FreightLoadRow> {
  const result = await client.query<FreightLoadRow>(
    `SELECT id, status FROM freight_loads WHERE id = $1 FOR UPDATE`,
    [loadId],
  );
  const row = result.rows[0];
  if (!row) pgRaise("P0002", "freight_load_not_found");
  return row;
}

// ---------------------------------------------------------------------------
// Business travel (business_travel_accounts :39-53, business_travel_trips :56-75)
// ---------------------------------------------------------------------------

const TRAVEL_APPROVAL_MODES = ["auto-with-cap", "manager-review", "care-coordinator"] as const;

type TravelTripRow = {
  id: number | string;
  account_id: number | string;
  traveler_user_id: number;
  status: string;
  expense_state: string;
};

async function lockTravelTrip(client: Queryable, tripId: number): Promise<TravelTripRow> {
  const result = await client.query<TravelTripRow>(
    `SELECT id, account_id, traveler_user_id, status, expense_state
     FROM business_travel_trips WHERE id = $1 FOR UPDATE`,
    [tripId],
  );
  const row = result.rows[0];
  if (!row) pgRaise("P0002", "travel_trip_not_found");
  return row;
}

// ---------------------------------------------------------------------------
// Healthcare transport (healthcare_transport_bookings, 0073:99-119)
// ---------------------------------------------------------------------------

const HEALTHCARE_SERVICE_LINES = ["patient_trip", "regulated_delivery"] as const;
const HEALTHCARE_SCHEDULE_MODES = ["scheduled", "same_day", "recurring"] as const;

const HEALTHCARE_FORWARD: Record<string, string[]> = {
  scheduled: ["en_route"],
  en_route: ["arrived"],
  arrived: ["completed"],
};
const HEALTHCARE_CANCELLABLE = new Set(["scheduled", "en_route", "arrived"]);

type HealthcareBookingRow = { id: number | string; status: string };

async function lockHealthcareBooking(
  client: Queryable,
  bookingId: number,
): Promise<HealthcareBookingRow> {
  const result = await client.query<HealthcareBookingRow>(
    `SELECT id, status FROM healthcare_transport_bookings WHERE id = $1 FOR UPDATE`,
    [bookingId],
  );
  const row = result.rows[0];
  if (!row) pgRaise("P0002", "healthcare_booking_not_found");
  return row;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const listLimitInput = z
  .object({ limit: z.number().int().min(1).max(100).optional() })
  .optional();

export const verticalOpsRouter = router({
  // -------------------------------------------------------------------------
  // Freight
  // -------------------------------------------------------------------------

  /** Operator control-tower load intake; creates in 'draft'. */
  createFreightLoad: operatorMutationProcedure("operate")
    .input(
      z.object({
        shipperProviderId: positiveId.optional(),
        laneCode: z.string().trim().min(1).max(80).optional(),
        originLabel: z.string().trim().min(1).max(255).optional(),
        destinationLabel: z.string().trim().min(1).max(255).optional(),
        weightKg: z.number().nonnegative().max(1_000_000).optional(),
        equipment: z.enum(FREIGHT_EQUIPMENT).default("box_truck"),
        valueMinor: minorUnitsSchema.default(0),
        currency: currencySchema,
        idempotencyKey: idempotencyKeySchema,
      }),
    )
    .mutation(({ ctx, input }) =>
      runWriter({
        topic: "freight-create",
        actorUserId: ctx.user.id,
        idempotencyKey: input.idempotencyKey,
        execute: async (client) => {
          if (input.shipperProviderId !== undefined) {
            const shipper = await client.query<{ id: number }>(
              `SELECT id FROM service_providers WHERE id = $1`,
              [input.shipperProviderId],
            );
            if (!shipper.rows[0]) pgRaise("P0002", "freight_shipper_not_found");
          }
          const inserted = await client.query<{ id: number | string }>(
            `INSERT INTO freight_loads
               (shipper_provider_id, lane_code, origin_label, destination_label,
                status, weight_kg, equipment, value_minor, currency)
             VALUES ($1, $2, $3, $4, 'draft', $5, $6, $7, $8)
             RETURNING id`,
            [
              input.shipperProviderId ?? null,
              input.laneCode ?? null,
              input.originLabel ?? null,
              input.destinationLabel ?? null,
              input.weightKg ?? null,
              input.equipment,
              input.valueMinor,
              input.currency,
            ],
          );
          return { loadId: Number(inserted.rows[0].id), status: "draft" };
        },
      }),
    ),

  /** draft -> tendered. */
  tenderFreightLoad: operatorMutationProcedure("operate")
    .input(z.object({ loadId: positiveId, idempotencyKey: idempotencyKeySchema }))
    .mutation(({ ctx, input }) =>
      runWriter({
        topic: "freight-tender",
        actorUserId: ctx.user.id,
        idempotencyKey: input.idempotencyKey,
        execute: async (client) => {
          const load = await lockFreightLoad(client, input.loadId);
          if (load.status !== "draft") {
            pgRaise("P0002", `illegal_freight_transition:${load.status}->tendered`);
          }
          await client.query(
            `UPDATE freight_loads SET status = 'tendered', updated_at = now() WHERE id = $1`,
            [input.loadId],
          );
          return { loadId: input.loadId, status: "tendered", previousStatus: load.status };
        },
      }),
    ),

  /**
   * tendered -> assigned. Carrier compliance hook: carrier must be a
   * service_providers row with lower(status) = 'active'. freight_loads has
   * no carrier column and migrations are forbidden, so the carrier id is
   * persisted in the ledger result payload (see header deviation note).
   */
  assignFreightCarrier: operatorMutationProcedure("operate")
    .input(
      z.object({
        loadId: positiveId,
        carrierProviderId: positiveId,
        idempotencyKey: idempotencyKeySchema,
      }),
    )
    .mutation(({ ctx, input }) =>
      runWriter({
        topic: "freight-assign",
        actorUserId: ctx.user.id,
        idempotencyKey: input.idempotencyKey,
        execute: async (client) => {
          const load = await lockFreightLoad(client, input.loadId);
          if (load.status !== "tendered") {
            pgRaise("P0002", `illegal_freight_transition:${load.status}->assigned`);
          }
          const carrier = await client.query<{ id: number; status: string }>(
            `SELECT id, status::text AS status FROM service_providers WHERE id = $1`,
            [input.carrierProviderId],
          );
          const carrierRow = carrier.rows[0];
          if (!carrierRow) pgRaise("P0002", "freight_carrier_not_found");
          if (carrierRow.status.toLowerCase() !== "active") {
            pgRaise("42501", "freight_carrier_not_active");
          }
          await client.query(
            `UPDATE freight_loads SET status = 'assigned', updated_at = now() WHERE id = $1`,
            [input.loadId],
          );
          return {
            loadId: input.loadId,
            status: "assigned",
            previousStatus: load.status,
            carrierProviderId: input.carrierProviderId,
          };
        },
      }),
    ),

  /**
   * assigned -> picked_up -> in_transit -> delivered, plus cancel from any
   * pre-delivered state (reason required for cancel).
   */
  transitionFreightLoad: operatorMutationProcedure("operate")
    .input(
      z
        .object({
          loadId: positiveId,
          targetStatus: z.enum(["picked_up", "in_transit", "delivered", "cancelled"]),
          reason: z.string().trim().min(1).max(500).optional(),
          idempotencyKey: idempotencyKeySchema,
        })
        .refine((value) => value.targetStatus !== "cancelled" || value.reason !== undefined, {
          message: "cancel_reason_required",
        }),
    )
    .mutation(({ ctx, input }) =>
      runWriter({
        topic: "freight-transition",
        actorUserId: ctx.user.id,
        idempotencyKey: input.idempotencyKey,
        execute: async (client) => {
          const load = await lockFreightLoad(client, input.loadId);
          const legal =
            input.targetStatus === "cancelled"
              ? FREIGHT_CANCELLABLE.has(load.status)
              : (FREIGHT_FORWARD[load.status] ?? []).includes(input.targetStatus);
          if (!legal) {
            pgRaise(
              "P0002",
              `illegal_freight_transition:${load.status}->${input.targetStatus}`,
            );
          }
          await client.query(
            `UPDATE freight_loads SET status = $2, updated_at = now() WHERE id = $1`,
            [input.loadId, input.targetStatus],
          );
          return {
            loadId: input.loadId,
            status: input.targetStatus,
            previousStatus: load.status,
            ...(input.reason !== undefined ? { reason: input.reason } : {}),
          };
        },
      }),
    ),

  /** Shipper-scoped read: loads owned through the caller's merchant portal. */
  myFreightLoads: authenticatedProcedure
    .input(listLimitInput)
    .query(async ({ ctx, input }) => {
      const actorId = await resolveActor(ctx.user);
      const pool = await getPool();
      const result = await pool.query(
        `SELECT f.id, f.status, f.lane_code, f.origin_label, f.destination_label,
                f.equipment, f.value_minor, f.currency, f.created_at, f.updated_at
         FROM freight_loads f
         JOIN commerce.merchant_portal p ON p.provider_id = f.shipper_provider_id
         WHERE p.owner_user_id = $1
         ORDER BY f.created_at DESC
         LIMIT $2`,
        [actorId, input?.limit ?? 50],
      );
      return {
        loads: result.rows.map((row) => ({
          id: Number(row.id),
          status: String(row.status),
          laneCode: row.lane_code === null ? null : String(row.lane_code),
          originLabel: row.origin_label === null ? null : String(row.origin_label),
          destinationLabel:
            row.destination_label === null ? null : String(row.destination_label),
          equipment: String(row.equipment),
          valueMinor: Number(row.value_minor ?? 0),
          currency: String(row.currency ?? "NGN"),
          createdAt: String(row.created_at),
          updatedAt: String(row.updated_at),
        })),
      };
    }),

  // -------------------------------------------------------------------------
  // Business travel
  // -------------------------------------------------------------------------

  /** Traveler/admin self-serve account intake (actor = created_by). */
  createTravelAccount: authenticatedProcedure
    .input(
      z.object({
        companyName: z.string().trim().min(2).max(160),
        billingEmail: z.string().trim().email().max(320),
        approvalMode: z.enum(TRAVEL_APPROVAL_MODES).default("manager-review"),
        serviceMix: z.string().trim().min(1).max(120).default("business rides"),
        monthlyBudgetMinor: minorUnitsSchema.optional(),
        currency: currencySchema,
        idempotencyKey: idempotencyKeySchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actorId = await resolveActor(ctx.user);
      return runWriter({
        topic: "travel-account-create",
        actorUserId: actorId,
        idempotencyKey: input.idempotencyKey,
        execute: async (client) => {
          const inserted = await client.query<{ id: number | string }>(
            `INSERT INTO business_travel_accounts
               (company_name, billing_email, status, approval_mode, service_mix,
                monthly_budget_minor, created_by)
             VALUES ($1, $2, 'active', $3, $4, $5, $6)
             RETURNING id`,
            [
              input.companyName,
              input.billingEmail,
              input.approvalMode,
              input.serviceMix,
              input.monthlyBudgetMinor ?? null,
              actorId,
            ],
          );
          return { accountId: Number(inserted.rows[0].id), status: "active" };
        },
      });
    }),

  /**
   * Traveler trip intake + expense submission (dual mode, exactly one of
   * accountId/tripId):
   *   - accountId: book a new trip under an ACTIVE account (status
   *     'requested', expense_state 'open'); fareMinor required.
   *   - tripId: submit the caller's own trip expense
   *     (expense_state open -> submitted).
   */
  submitTravelTrip: authenticatedProcedure
    .input(
      z
        .object({
          accountId: positiveId.optional(),
          tripId: positiveId.optional(),
          fareMinor: minorUnitsSchema.optional(),
          currency: currencySchema,
          costCenter: z.string().trim().min(1).max(120).optional(),
          purpose: z.string().trim().min(1).max(280).optional(),
          idempotencyKey: idempotencyKeySchema,
        })
        .refine((value) => (value.accountId !== undefined) !== (value.tripId !== undefined), {
          message: "exactly_one_of_accountId_or_tripId",
        })
        .refine((value) => value.tripId !== undefined || value.fareMinor !== undefined, {
          message: "fare_minor_required_for_new_trip",
        }),
    )
    .mutation(async ({ ctx, input }) => {
      const actorId = await resolveActor(ctx.user);
      return runWriter({
        topic: "travel-trip-submit",
        actorUserId: actorId,
        idempotencyKey: input.idempotencyKey,
        execute: async (client) => {
          if (input.accountId !== undefined) {
            const account = await client.query<{ id: number | string; status: string }>(
              `SELECT id, status FROM business_travel_accounts WHERE id = $1`,
              [input.accountId],
            );
            const accountRow = account.rows[0];
            if (!accountRow) pgRaise("P0002", "travel_account_not_found");
            if (accountRow.status !== "active") {
              pgRaise("22023", "travel_account_not_active");
            }
            const inserted = await client.query<{ id: number | string }>(
              `INSERT INTO business_travel_trips
                 (account_id, traveler_user_id, status, expense_state,
                  fare_minor, currency, cost_center, purpose)
               VALUES ($1, $2, 'requested', 'open', $3, $4, $5, $6)
               RETURNING id`,
              [
                input.accountId,
                actorId,
                input.fareMinor ?? 0,
                input.currency,
                input.costCenter ?? null,
                input.purpose ?? null,
              ],
            );
            return {
              tripId: Number(inserted.rows[0].id),
              status: "requested",
              expenseState: "open",
            };
          }

          const trip = await lockTravelTrip(client, input.tripId as number);
          if (Number(trip.traveler_user_id) !== actorId) {
            pgRaise("42501", "travel_trip_forbidden");
          }
          if (trip.expense_state !== "open") {
            pgRaise(
              "P0002",
              `illegal_expense_transition:${trip.expense_state}->submitted`,
            );
          }
          await client.query(
            `UPDATE business_travel_trips SET expense_state = 'submitted' WHERE id = $1`,
            [input.tripId],
          );
          return { tripId: input.tripId as number, status: trip.status, expenseState: "submitted" };
        },
      });
    }),

  /** Operator approval: requested -> approved. */
  approveTravelTrip: operatorMutationProcedure("operate")
    .input(z.object({ tripId: positiveId, idempotencyKey: idempotencyKeySchema }))
    .mutation(({ ctx, input }) =>
      runWriter({
        topic: "travel-trip-approve",
        actorUserId: ctx.user.id,
        idempotencyKey: input.idempotencyKey,
        execute: async (client) => {
          const trip = await lockTravelTrip(client, input.tripId);
          if (trip.status !== "requested") {
            pgRaise("P0002", `illegal_travel_transition:${trip.status}->approved`);
          }
          await client.query(
            `UPDATE business_travel_trips SET status = 'approved' WHERE id = $1`,
            [input.tripId],
          );
          return { tripId: input.tripId, status: "approved", previousStatus: trip.status };
        },
      }),
    ),

  /** Operator rejection: requested -> rejected (reason required). */
  rejectTravelTrip: operatorMutationProcedure("operate")
    .input(
      z.object({
        tripId: positiveId,
        reason: z.string().trim().min(1).max(500),
        idempotencyKey: idempotencyKeySchema,
      }),
    )
    .mutation(({ ctx, input }) =>
      runWriter({
        topic: "travel-trip-reject",
        actorUserId: ctx.user.id,
        idempotencyKey: input.idempotencyKey,
        execute: async (client) => {
          const trip = await lockTravelTrip(client, input.tripId);
          if (trip.status !== "requested") {
            pgRaise("P0002", `illegal_travel_transition:${trip.status}->rejected`);
          }
          await client.query(
            `UPDATE business_travel_trips SET status = 'rejected' WHERE id = $1`,
            [input.tripId],
          );
          return {
            tripId: input.tripId,
            status: "rejected",
            previousStatus: trip.status,
            reason: input.reason,
          };
        },
      }),
    ),

  /** Operator expense reconciliation: submitted -> reconciled. */
  reconcileTravelExpense: operatorMutationProcedure("operate")
    .input(z.object({ tripId: positiveId, idempotencyKey: idempotencyKeySchema }))
    .mutation(({ ctx, input }) =>
      runWriter({
        topic: "travel-expense-reconcile",
        actorUserId: ctx.user.id,
        idempotencyKey: input.idempotencyKey,
        execute: async (client) => {
          const trip = await lockTravelTrip(client, input.tripId);
          if (trip.expense_state !== "submitted") {
            pgRaise(
              "P0002",
              `illegal_expense_transition:${trip.expense_state}->reconciled`,
            );
          }
          await client.query(
            `UPDATE business_travel_trips SET expense_state = 'reconciled' WHERE id = $1`,
            [input.tripId],
          );
          return { tripId: input.tripId, expenseState: "reconciled" };
        },
      }),
    ),

  /** Traveler-scoped read of own trips. */
  myTravelTrips: authenticatedProcedure
    .input(listLimitInput)
    .query(async ({ ctx, input }) => {
      const actorId = await resolveActor(ctx.user);
      const pool = await getPool();
      const result = await pool.query(
        `SELECT t.id, t.account_id, t.status, t.expense_state, t.fare_minor,
                t.currency, t.cost_center, t.purpose, t.requested_at,
                a.company_name
         FROM business_travel_trips t
         JOIN business_travel_accounts a ON a.id = t.account_id
         WHERE t.traveler_user_id = $1
         ORDER BY t.requested_at DESC
         LIMIT $2`,
        [actorId, input?.limit ?? 50],
      );
      return {
        trips: result.rows.map((row) => ({
          id: Number(row.id),
          accountId: Number(row.account_id),
          companyName: String(row.company_name ?? ""),
          status: String(row.status),
          expenseState: String(row.expense_state),
          fareMinor: Number(row.fare_minor ?? 0),
          currency: String(row.currency ?? "NGN"),
          costCenter: row.cost_center === null ? null : String(row.cost_center),
          purpose: row.purpose === null ? null : String(row.purpose),
          requestedAt: String(row.requested_at),
        })),
      };
    }),

  // -------------------------------------------------------------------------
  // Healthcare transport
  // -------------------------------------------------------------------------

  /** Patient/coordinator scheduling (actor = rider_user_id). */
  scheduleHealthcareBooking: authenticatedProcedure
    .input(
      z.object({
        patientRef: z.string().trim().min(1).max(128),
        serviceLine: z.enum(HEALTHCARE_SERVICE_LINES).default("patient_trip"),
        scheduleMode: z.enum(HEALTHCARE_SCHEDULE_MODES).default("scheduled"),
        mobilityNeeds: z.string().trim().min(1).max(500).optional(),
        appointmentAt: z.string().datetime({ offset: true }).optional(),
        program: z.string().trim().min(1).max(160).optional(),
        fareMinor: minorUnitsSchema.default(0),
        currency: currencySchema,
        idempotencyKey: idempotencyKeySchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actorId = await resolveActor(ctx.user);
      return runWriter({
        topic: "healthcare-booking-schedule",
        actorUserId: actorId,
        idempotencyKey: input.idempotencyKey,
        execute: async (client) => {
          const inserted = await client.query<{ id: number | string }>(
            `INSERT INTO healthcare_transport_bookings
               (patient_ref, rider_user_id, program, service_line, schedule_mode,
                mobility_needs, appointment_at, status, fare_minor, currency)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'scheduled', $8, $9)
             RETURNING id`,
            [
              input.patientRef,
              actorId,
              input.program ?? "Non-emergency medical transport",
              input.serviceLine,
              input.scheduleMode,
              input.mobilityNeeds ?? null,
              input.appointmentAt ?? null,
              input.fareMinor,
              input.currency,
            ],
          );
          return {
            bookingId: Number(inserted.rows[0].id),
            status: "scheduled",
            scheduleMode: input.scheduleMode,
          };
        },
      });
    }),

  /**
   * scheduled -> en_route -> arrived -> completed, plus cancel from any
   * pre-completed state (reason required for cancel).
   */
  transitionHealthcareBooking: operatorMutationProcedure("operate")
    .input(
      z
        .object({
          bookingId: positiveId,
          targetStatus: z.enum(["en_route", "arrived", "completed", "cancelled"]),
          reason: z.string().trim().min(1).max(500).optional(),
          idempotencyKey: idempotencyKeySchema,
        })
        .refine((value) => value.targetStatus !== "cancelled" || value.reason !== undefined, {
          message: "cancel_reason_required",
        }),
    )
    .mutation(({ ctx, input }) =>
      runWriter({
        topic: "healthcare-booking-transition",
        actorUserId: ctx.user.id,
        idempotencyKey: input.idempotencyKey,
        execute: async (client) => {
          const booking = await lockHealthcareBooking(client, input.bookingId);
          const legal =
            input.targetStatus === "cancelled"
              ? HEALTHCARE_CANCELLABLE.has(booking.status)
              : (HEALTHCARE_FORWARD[booking.status] ?? []).includes(input.targetStatus);
          if (!legal) {
            pgRaise(
              "P0002",
              `illegal_healthcare_transition:${booking.status}->${input.targetStatus}`,
            );
          }
          await client.query(
            `UPDATE healthcare_transport_bookings SET status = $2, updated_at = now() WHERE id = $1`,
            [input.bookingId, input.targetStatus],
          );
          return {
            bookingId: input.bookingId,
            status: input.targetStatus,
            previousStatus: booking.status,
            ...(input.reason !== undefined ? { reason: input.reason } : {}),
          };
        },
      }),
    ),

  /** Operator compliance-note capture: append-only onto compliance_notes. */
  recordComplianceNote: operatorMutationProcedure("operate")
    .input(
      z.object({
        bookingId: positiveId,
        note: z.string().trim().min(1).max(2000),
        idempotencyKey: idempotencyKeySchema,
      }),
    )
    .mutation(({ ctx, input }) =>
      runWriter({
        topic: "healthcare-compliance-note",
        actorUserId: ctx.user.id,
        idempotencyKey: input.idempotencyKey,
        execute: async (client) => {
          await lockHealthcareBooking(client, input.bookingId);
          const updated = await client.query<{ compliance_notes: string | null }>(
            `UPDATE healthcare_transport_bookings
             SET compliance_notes = CASE
                   WHEN compliance_notes IS NULL OR length(compliance_notes) = 0
                     THEN $2
                   ELSE compliance_notes || E'\n' || $2
                 END,
                 updated_at = now()
             WHERE id = $1
             RETURNING compliance_notes`,
            [input.bookingId, input.note],
          );
          return {
            bookingId: input.bookingId,
            complianceNotes: updated.rows[0]?.compliance_notes ?? input.note,
          };
        },
      }),
    ),

  /** Patient/coordinator-scoped read of own bookings. */
  myHealthcareBookings: authenticatedProcedure
    .input(listLimitInput)
    .query(async ({ ctx, input }) => {
      const actorId = await resolveActor(ctx.user);
      const pool = await getPool();
      const result = await pool.query(
        `SELECT id, patient_ref, program, service_line, schedule_mode,
                mobility_needs, compliance_notes, appointment_at, status,
                fare_minor, currency, created_at
         FROM healthcare_transport_bookings
         WHERE rider_user_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [actorId, input?.limit ?? 50],
      );
      return {
        bookings: result.rows.map((row) => ({
          id: Number(row.id),
          patientRef: String(row.patient_ref),
          program: String(row.program),
          serviceLine: String(row.service_line),
          scheduleMode: String(row.schedule_mode),
          mobilityNeeds: row.mobility_needs === null ? null : String(row.mobility_needs),
          complianceNotes:
            row.compliance_notes === null ? null : String(row.compliance_notes),
          appointmentAt: row.appointment_at === null ? null : String(row.appointment_at),
          status: String(row.status),
          fareMinor: Number(row.fare_minor ?? 0),
          currency: String(row.currency ?? "NGN"),
          createdAt: String(row.created_at),
        })),
      };
    }),
});

export type VerticalOpsRouter = typeof verticalOpsRouter;
