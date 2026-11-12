import { z } from "zod";

import { resolvePublicUser } from "./publicUsers";
import {
  actOnTripSupportCase,
  assignTicket,
  getCustomer360,
  getTicketDetail,
  listTicketQueue,
  listTripSupportCases,
  openTripSupportCase,
  TICKET_STATUSES,
  TRIP_CASE_ACTIONS,
  TRIP_CASE_TYPES,
  updateTicket,
} from "./supportAgent";
import { getPool } from "../db";
import {
  authenticatedProcedure,
  operatorMutationProcedure,
  router,
  workspaceReadProcedure,
} from "./trpc";

/**
 * supportAgentRouter — operator support/CRM surface (P3-S / WS-SUPPORT).
 *
 * Mounted by the lead as `supportAgent` in server/routers.ts appRouter
 * (see final report for the exact mount line). Procedure gates:
 *   - workspaceReadProcedure         queue/detail/360 reads (serviceRecovery
 *                                    precedent: operator workspace reads),
 *   - operatorMutationProcedure("operate")  ticket + trip-case writers,
 *   - authenticatedProcedure + resolvePublicUser  consumer-opened trip
 *     support cases and the consumer notification read surface.
 *
 * All mutating procedures REQUIRE an idempotencyKey (P1 contract regex);
 * the underlying writers claim it transactionally on
 * public.consumer_processed_events (0102/0072 pattern).
 */

const idempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);

const ticketQueueInput = z.object({
  status: z.enum(TICKET_STATUSES).optional(),
  type: z
    .enum(["order_issue", "payment", "driver", "general", "claim", "refund"])
    .optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  assignedToMe: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).default(25),
  offset: z.number().int().min(0).default(0),
});

const assignTicketInput = z.object({
  ticketId: z.number().int().positive(),
  assigneeUserId: z.number().int().positive(),
  idempotencyKey: idempotencyKeySchema,
});

const updateTicketInput = z.object({
  ticketId: z.number().int().positive(),
  status: z.enum(TICKET_STATUSES).optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  resolution: z.string().trim().min(1).max(4000).nullish(),
  idempotencyKey: idempotencyKeySchema,
});

const openTripSupportCaseInput = z.object({
  tripId: z.string().uuid(),
  caseType: z.enum(TRIP_CASE_TYPES),
  // Bounds mirror mobility.create_trip_support_case (subject 3..160, desc 3..4000).
  subject: z.string().trim().min(3).max(160),
  description: z.string().trim().min(3).max(4000),
  idempotencyKey: idempotencyKeySchema,
});

const tripCaseActionInput = z.object({
  caseId: z.string().uuid(),
  action: z.enum(TRIP_CASE_ACTIONS),
  note: z.string().trim().min(1).max(2000).nullish(),
  idempotencyKey: idempotencyKeySchema,
});

export const supportAgentRouter = router({
  // --- operator ticket queue (workspace read, serviceRecovery precedent) ---
  ticketQueue: workspaceReadProcedure
    .input(ticketQueueInput)
    .query(({ ctx, input }) =>
      listTicketQueue({
        ...input,
        assignedTo: input.assignedToMe ? ctx.user.id : undefined,
      }),
    ),

  ticketDetail: workspaceReadProcedure
    .input(z.object({ ticketId: z.number().int().positive() }))
    .query(({ input }) => getTicketDetail(input.ticketId)),

  // --- operator ticket writers ---
  assignTicket: operatorMutationProcedure("operate")
    .input(assignTicketInput)
    .mutation(({ ctx, input }) =>
      assignTicket({ ...input, operatorUserId: ctx.user.id }),
    ),

  updateTicket: operatorMutationProcedure("operate")
    .input(updateTicketInput)
    .mutation(({ ctx, input }) =>
      updateTicket({ ...input, operatorUserId: ctx.user.id }),
    ),

  // --- trip_support_case engine (dead 0043 SQL, resurrected) ---
  tripCaseQueue: workspaceReadProcedure
    .input(
      z.object({
        state: z.string().trim().min(1).max(32).optional(),
        limit: z.number().int().min(1).max(100).default(25),
        offset: z.number().int().min(0).default(0),
      }),
    )
    .query(({ input }) => listTripSupportCases(input)),

  actOnTripSupportCase: operatorMutationProcedure("operate")
    .input(tripCaseActionInput)
    .mutation(({ ctx, input }) =>
      actOnTripSupportCase({ ...input, operatorUserId: ctx.user.id }),
    ),

  // Consumer-opened trip support case: authenticated consumer, rider
  // ownership enforced inside mobility.create_trip_support_case.
  openTripSupportCase: authenticatedProcedure
    .input(openTripSupportCaseInput)
    .mutation(async ({ ctx, input }) => {
      const publicUser = await resolvePublicUser(ctx.user);
      return openTripSupportCase({ ...input, consumerUserId: publicUser.id });
    }),

  // --- customer 360 (operator workspace read, defensive aggregate) ---
  customer360: workspaceReadProcedure
    .input(z.object({ userId: z.number().int().positive() }))
    .query(({ input }) => getCustomer360(input.userId)),

  // --- consumer notification read surface (public.notifications had zero
  // readers; the ConsumerSupport page lists support events for the caller) ---
  mySupportNotifications: authenticatedProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(50).default(20),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const publicUser = await resolvePublicUser(ctx.user);
      const pool = await getPool();
      const result = await pool.query(
        `SELECT id, type, title, message, priority, is_read, metadata, created_at
         FROM public.notifications
         WHERE user_id = $1
           AND type = 'system'
           AND metadata->>'supportTicketId' IS NOT NULL
         ORDER BY created_at DESC
         LIMIT $2`,
        [publicUser.id, input?.limit ?? 20],
      );
      return result.rows.map((row: any) => ({
        id: Number(row.id),
        title: String(row.title),
        message: String(row.message),
        ticketNumber: row.metadata?.ticketNumber ?? null,
        isRead: Boolean(row.is_read),
        createdAt:
          row.created_at == null
            ? new Date(0).toISOString()
            : new Date(row.created_at).toISOString(),
      }));
    }),
});
