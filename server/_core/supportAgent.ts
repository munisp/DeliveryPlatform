import { TRPCError } from "@trpc/server";

import { getPool } from "../db";
import {
  notifySupportEvent,
  notifyUnnotifiedOpenTickets,
} from "./supportNotifications";

/**
 * supportAgent.ts — operator support/CRM engine (P3-S / WS-SUPPORT).
 *
 * Recon evidence: public.support_tickets has ZERO writers for assign and
 * resolve on main — tickets could be created but never worked. This module
 * adds the missing operator surface:
 *
 *   - ticket queue + detail reads (pool SQL; all DDL-read per the wave spec),
 *   - assign / update writers with the spec status edges
 *       open → in_progress → resolved → closed, plus reopen resolved →
 *       in_progress, and resolve-requires-resolution,
 *   - trip_support_case engine resurrection (0043 SQL fns were dead code),
 *   - customer360 defensive aggregate.
 *
 * Idempotency (0102/0072 conventions): every mutating call takes an
 * idempotencyKey claimed INSERT-first on public.consumer_processed_events
 * INSIDE the same transaction as the write — same key + same params replays
 * the stored outcome (replayed: true), and a crash between claim and write
 * cannot happen (single transaction, rolled back together).
 *
 * Notifications are fail-open hooks (supportNotifications.ts) fired AFTER
 * the commit; they never fail the mutation.
 *
 * Error codes map the P1 contract onto TRPCError: 22023 → BAD_REQUEST,
 * P0002 → NOT_FOUND, 42501 → FORBIDDEN, 23505/23514/55000 → CONFLICT.
 */

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type PoolLike = Awaited<ReturnType<typeof getPool>>;
type ClientLike = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
};

function toIso(value: unknown): string | null {
  if (!value) return null;
  const d = new Date(value as string | Date);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Map PG error codes per the P1 contract (0102 pattern). */
function mapSupportError(error: unknown, fallback: string): never {
  if (error instanceof TRPCError) throw error;
  const pgCode = (error as { code?: string })?.code;
  const message = (error as Error)?.message ?? fallback;
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
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: fallback, cause: error });
  }
}

/**
 * INSERT-first claim on consumer_processed_events INSIDE the caller's
 * write transaction: the claim row and the write commit or roll back
 * atomically, so a replayed key observes the stored outcome and a crashed
 * write never leaves a claimed-but-unapplied wedge.
 */
async function inClaimedTransaction<T>(
  pool: PoolLike,
  topic: string,
  idempotencyKey: string,
  write: (client: ClientLike) => Promise<T>,
): Promise<{ value: T | null; replayed: boolean }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const claim = await client.query(
      `INSERT INTO public.consumer_processed_events (consumer_name, topic, event_id)
       VALUES ('support-agent', $1, $2)
       ON CONFLICT (consumer_name, topic, event_id) DO NOTHING
       RETURNING event_id`,
      [topic, idempotencyKey],
    );
    if (claim.rows.length === 0) {
      await client.query("COMMIT");
      return { value: null, replayed: true };
    }
    const value = await write(client);
    await client.query("COMMIT");
    return { value, replayed: false };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Ticket queue + detail (reads)
// ---------------------------------------------------------------------------

export type SupportTicketRow = {
  id: number;
  ticketNumber: string;
  customerId: number | null;
  customerName: string | null;
  customerEmail: string | null;
  orderId: number | null;
  orderNumber: string | null;
  assignedTo: number | null;
  assigneeName: string | null;
  type: string;
  priority: string;
  status: string;
  subject: string;
  description: string;
  resolution: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
};

function mapTicketRow(row: any): SupportTicketRow {
  return {
    id: Number(row.id),
    ticketNumber: String(row.ticket_number),
    customerId: row.customer_id == null ? null : Number(row.customer_id),
    customerName: row.customer_name ?? null,
    customerEmail: row.customer_email ?? null,
    orderId: row.order_id == null ? null : Number(row.order_id),
    orderNumber: row.order_number ?? null,
    assignedTo: row.assigned_to == null ? null : Number(row.assigned_to),
    assigneeName: row.assignee_name ?? null,
    type: String(row.type),
    priority: String(row.priority),
    status: String(row.status),
    subject: String(row.subject),
    description: String(row.description),
    resolution: row.resolution ?? null,
    createdAt: toIso(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: toIso(row.updated_at) ?? new Date(0).toISOString(),
    resolvedAt: toIso(row.resolved_at),
  };
}

const TICKET_SELECT = `
  SELECT st.*,
         cu.name AS customer_name,
         cu.email AS customer_email,
         au.name AS assignee_name,
         o.order_number
  FROM public.support_tickets st
  LEFT JOIN public.users cu ON cu.id = st.customer_id
  LEFT JOIN public.users au ON au.id = st.assigned_to
  LEFT JOIN public.orders o ON o.id = st.order_id
`;

export const TICKET_STATUSES = ["open", "in_progress", "resolved", "closed"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** Spec status edges: open→in_progress→resolved→closed; reopen resolved→in_progress. */
const STATUS_EDGES: Record<TicketStatus, readonly TicketStatus[]> = {
  open: ["in_progress"],
  in_progress: ["resolved"],
  resolved: ["closed", "in_progress"],
  closed: [],
};

export async function listTicketQueue(input: {
  status?: TicketStatus;
  type?: string;
  priority?: string;
  assignedTo?: number;
  limit: number;
  offset: number;
}): Promise<{ tickets: SupportTicketRow[]; total: number }> {
  const pool = await getPool();
  const where: string[] = [];
  const params: unknown[] = [];
  const addParam = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  if (input.status) where.push(`st.status = ${addParam(input.status)}`);
  if (input.type) where.push(`st.type = ${addParam(input.type)}`);
  if (input.priority) where.push(`st.priority = ${addParam(input.priority)}`);
  if (input.assignedTo != null) where.push(`st.assigned_to = ${addParam(input.assignedTo)}`);
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const limitParam = addParam(input.limit);
  const offsetParam = addParam(input.offset);
  const [rows, count] = await Promise.all([
    pool.query(
      `${TICKET_SELECT}
       ${whereSql}
       ORDER BY st.created_at DESC
       LIMIT ${limitParam} OFFSET ${offsetParam}`,
      params,
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total FROM public.support_tickets st ${whereSql}`,
      params.slice(0, params.length - 2),
    ),
  ]);

  const tickets: SupportTicketRow[] = rows.rows.map(mapTicketRow);
  // DESIGN NOTE (see supportNotifications.ts): lazily backfill 'opened'
  // notifications for consumer-opened tickets the queue is surfacing.
  // Fail-open; never blocks the read result.
  await notifyUnnotifiedOpenTickets(
    tickets.filter((t) => t.status === "open").map((t) => t.id),
  );
  return { tickets, total: Number(count.rows[0]?.total ?? 0) };
}

export async function getTicketDetail(ticketId: number): Promise<SupportTicketRow> {
  const pool = await getPool();
  const result = await pool.query(`${TICKET_SELECT} WHERE st.id = $1 LIMIT 1`, [ticketId]);
  const row = result.rows[0];
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "support_ticket_not_found" });
  }
  return mapTicketRow(row);
}

// ---------------------------------------------------------------------------
// Ticket writers (assign / update) — idempotent, transactional claim+write
// ---------------------------------------------------------------------------

export async function assignTicket(input: {
  ticketId: number;
  assigneeUserId: number;
  operatorUserId: number;
  idempotencyKey: string;
}): Promise<{ ticket: SupportTicketRow; replayed: boolean }> {
  const pool = await getPool();
  try {
    const { replayed } = await inClaimedTransaction(
      pool,
      "ticket-assign",
      input.idempotencyKey,
      async (client) => {
        const current = await client.query(
          `SELECT * FROM public.support_tickets WHERE id = $1 FOR UPDATE`,
          [input.ticketId],
        );
        if (!current.rows[0]) {
          throw new TRPCError({ code: "NOT_FOUND", message: "support_ticket_not_found" });
        }
        const assignee = await client.query(
          `SELECT id, role FROM public.users WHERE id = $1 LIMIT 1`,
          [input.assigneeUserId],
        );
        if (!assignee.rows[0]) {
          throw new TRPCError({ code: "NOT_FOUND", message: "assignee_not_found" });
        }
        if (assignee.rows[0].role !== "admin") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "assignee_not_operator",
          });
        }
        const updated = await client.query(
          `UPDATE public.support_tickets
           SET assigned_to = $2, updated_at = now()
           WHERE id = $1
           RETURNING *`,
          [input.ticketId, input.assigneeUserId],
        );
        return updated.rows[0];
      },
    );
    const ticket = await getTicketDetail(input.ticketId);
    if (!replayed) {
      // Fail-open hook AFTER commit; never fails the mutation.
      await notifySupportEvent({ kind: "assigned", ticketId: input.ticketId });
    }
    return { ticket, replayed };
  } catch (error) {
    mapSupportError(error, "ticket_assign_failed");
  }
}

export async function updateTicket(input: {
  ticketId: number;
  status?: TicketStatus;
  priority?: string;
  resolution?: string | null;
  operatorUserId: number;
  idempotencyKey: string;
}): Promise<{ ticket: SupportTicketRow; replayed: boolean }> {
  if (!input.status && !input.priority && input.resolution == null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "no_update_fields",
    });
  }
  const pool = await getPool();
  try {
    let becameResolved = false;
    let becameClosed = false;
    const { replayed } = await inClaimedTransaction(
      pool,
      "ticket-update",
      input.idempotencyKey,
      async (client) => {
        const current = await client.query(
          `SELECT * FROM public.support_tickets WHERE id = $1 FOR UPDATE`,
          [input.ticketId],
        );
        const row = current.rows[0];
        if (!row) {
          throw new TRPCError({ code: "NOT_FOUND", message: "support_ticket_not_found" });
        }
        const currentStatus = String(row.status) as TicketStatus;

        let nextStatus = currentStatus;
        if (input.status && input.status !== currentStatus) {
          if (!STATUS_EDGES[currentStatus].includes(input.status)) {
            // 55000-equivalent: transition not permitted by the spec edges.
            throw new TRPCError({
              code: "CONFLICT",
              message: `invalid_status_transition:${currentStatus}->${input.status}`,
            });
          }
          nextStatus = input.status;
        }

        const nextResolution =
          input.resolution != null ? input.resolution.trim() : (row.resolution ?? null);
        if (nextStatus === "resolved" && (!nextResolution || nextResolution.length === 0)) {
          // 23514-equivalent: resolve requires a resolution text.
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "resolution_required",
          });
        }

        becameResolved = nextStatus === "resolved" && currentStatus !== "resolved";
        becameClosed = nextStatus === "closed" && currentStatus !== "closed";
        const reopening = currentStatus === "resolved" && nextStatus === "in_progress";

        const sets: string[] = ["status = $2", "updated_at = now()"];
        const params: unknown[] = [input.ticketId, nextStatus];
        if (input.priority) {
          params.push(input.priority);
          sets.push(`priority = $${params.length}`);
        }
        if (input.resolution != null) {
          params.push(nextResolution);
          sets.push(`resolution = $${params.length}`);
        }
        if (becameResolved) {
          sets.push("resolved_at = now()");
        } else if (reopening) {
          // Reopen clears the resolution timestamp; the text is retained.
          sets.push("resolved_at = NULL");
        }
        const updated = await client.query(
          `UPDATE public.support_tickets SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
          params,
        );
        return updated.rows[0];
      },
    );
    const ticket = await getTicketDetail(input.ticketId);
    if (!replayed && (becameResolved || becameClosed)) {
      await notifySupportEvent({
        kind: becameClosed ? "closed" : "resolved",
        ticketId: input.ticketId,
      });
    }
    return { ticket, replayed };
  } catch (error) {
    mapSupportError(error, "ticket_update_failed");
  }
}

// ---------------------------------------------------------------------------
// Trip support case engine (mobility.*, resurrected from dead 0043 SQL)
// ---------------------------------------------------------------------------

export type TripSupportCase = {
  caseId: string;
  state: string;
  caseType: string;
  subject: string;
  description: string;
  tripId: string;
  riderUserId: number | null;
  requesterName: string | null;
  assignedOperatorUserId: number | null;
  openedAt: string;
  resolvedAt: string | null;
  closedAt: string | null;
};

function mapTripCaseRow(row: any): TripSupportCase {
  return {
    caseId: String(row.case_id),
    state: String(row.state),
    caseType: String(row.case_type),
    subject: String(row.subject),
    description: String(row.description),
    tripId: String(row.trip_id),
    riderUserId: row.rider_user_id == null ? null : Number(row.rider_user_id),
    requesterName: row.requester_name ?? null,
    assignedOperatorUserId:
      row.assigned_operator_user_id == null ? null : Number(row.assigned_operator_user_id),
    openedAt: toIso(row.opened_at) ?? new Date(0).toISOString(),
    resolvedAt: toIso(row.resolved_at),
    closedAt: toIso(row.closed_at),
  };
}

export const TRIP_CASE_ACTIONS = [
  "assign",
  "request_information",
  "resolve",
  "reopen",
  "close",
] as const;
export type TripCaseAction = (typeof TRIP_CASE_ACTIONS)[number];

/** p_case_type is TEXT validated inside the SQL fn (0043:293+). */
export const TRIP_CASE_TYPES = [
  "fare_question",
  "trip_quality",
  "lost_item",
  "safety_follow_up",
  "accessibility",
  "other",
] as const;
export type TripCaseType = (typeof TRIP_CASE_TYPES)[number];

/**
 * Consumer-opened trip support case (rider ownership is enforced inside
 * mobility.create_trip_support_case: rider OR assigned driver only, per
 * 0043). The SQL function itself is idempotent on p_idempotency_key.
 */
export async function openTripSupportCase(input: {
  consumerUserId: number;
  tripId: string;
  caseType: TripCaseType;
  subject: string;
  description: string;
  idempotencyKey: string;
}): Promise<{ caseId: string }> {
  const pool = await getPool();
  try {
    const result = await pool.query(
      `SELECT mobility.create_trip_support_case($1::uuid, $2, $3, $4, $5, $6) AS case_id`,
      [
        input.tripId,
        input.consumerUserId,
        input.caseType,
        input.subject,
        input.description,
        input.idempotencyKey,
      ],
    );
    const caseId = result.rows[0]?.case_id;
    if (!caseId) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "trip_support_case_empty_result",
      });
    }
    return { caseId: String(caseId) };
  } catch (error) {
    mapSupportError(error, "trip_support_case_create_failed");
  }
}

/** Operator action on a trip case (claim/review/resolve/close/release). */
export async function actOnTripSupportCase(input: {
  caseId: string;
  operatorUserId: number;
  action: TripCaseAction;
  note?: string | null;
  idempotencyKey: string;
}): Promise<{
  caseId: string;
  previousState: string;
  nextState: string;
  assignedOperatorUserId: number | null;
  resolvedAt: string | null;
  closedAt: string | null;
}> {
  const pool = await getPool();
  try {
    const result = await pool.query(
      `SELECT * FROM mobility.apply_trip_support_case_action($1::uuid, $2, $3::mobility.support_case_action, $4, $5)`,
      [
        input.caseId,
        input.operatorUserId,
        input.action,
        input.idempotencyKey, // p_idempotency_key precedes p_note (0043:406)
        input.note ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "trip_support_case_action_empty_result",
      });
    }
    return {
      caseId: String(row.case_id),
      previousState: String(row.previous_state),
      nextState: String(row.next_state),
      assignedOperatorUserId:
        row.assigned_operator_user_id == null ? null : Number(row.assigned_operator_user_id),
      resolvedAt: toIso(row.resolved_at),
      closedAt: toIso(row.closed_at),
    };
  } catch (error) {
    mapSupportError(error, "trip_support_case_action_failed");
  }
}

/** Operator queue over trip cases (DDL-read raw SQL). */
export async function listTripSupportCases(input: {
  state?: string;
  limit: number;
  offset: number;
}): Promise<{ cases: TripSupportCase[]; total: number }> {
  const pool = await getPool();
  const params: unknown[] = [];
  let whereSql = "";
  if (input.state) {
    params.push(input.state);
    whereSql = `WHERE c.state = $1`;
  }
  params.push(input.limit, input.offset);
  const [rows, count] = await Promise.all([
    pool.query(
      `SELECT c.*, u.name AS requester_name
       FROM mobility.trip_support_case c
       LEFT JOIN public.users u ON u.id = c.rider_user_id
       ${whereSql}
       ORDER BY c.opened_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total FROM mobility.trip_support_case c ${whereSql}`,
      params.slice(0, input.state ? 1 : 0),
    ),
  ]);
  return { cases: rows.rows.map(mapTripCaseRow), total: Number(count.rows[0]?.total ?? 0) };
}

// ---------------------------------------------------------------------------
// Customer 360 (defensive aggregate — every section independently tolerated)
// ---------------------------------------------------------------------------

export type Customer360 = {
  user: { id: number; name: string; email: string | null; phone: string | null; role: string; createdAt: string };
  orders: { total: number; recent: Array<{ id: number; orderNumber: string; status: string; totalAmount: string; createdAt: string }> } | null;
  riderTrips: { total: number } | null;
  tickets: { open: number; inProgress: number; recent: SupportTicketRow[] } | null;
  membership: { status: string; planName: string | null } | null;
  wallet: { balance: string; currency: string } | null;
  longcatMemory: {
    lifetimeOrders: number;
    averageOrderValue: string;
    lastOrderedAt: string | null;
    memorySummary: string;
  } | null;
};

/**
 * Aggregate a customer's public-safe profile for operators. Each section
 * is independently defensive (try/catch → null): riderTrips/membership/
 * wallet tolerate DDL drift, and longcatMemory tolerates the RUNTIME-created
 * longcat_customer_memory_profiles table being absent entirely (42P01).
 * Only the base users row is mandatory (NOT_FOUND when absent).
 */
export async function getCustomer360(userId: number): Promise<Customer360> {
  const pool = await getPool();

  const userResult = await pool.query(
    `SELECT id, name, email, phone, role::text AS role, created_at
     FROM public.users WHERE id = $1 LIMIT 1`,
    [userId],
  );
  const userRow = userResult.rows[0];
  if (!userRow) {
    throw new TRPCError({ code: "NOT_FOUND", message: "user_not_found" });
  }
  const user = {
    id: Number(userRow.id),
    name: String(userRow.name),
    email: userRow.email ?? null,
    phone: userRow.phone ?? null,
    role: String(userRow.role),
    createdAt: toIso(userRow.created_at) ?? new Date(0).toISOString(),
  };

  const orders = await (async () => {
    try {
      const [countRes, recentRes] = await Promise.all([
        pool.query(
          `SELECT COUNT(*)::int AS total FROM public.orders WHERE customer_id = $1`,
          [userId],
        ),
        pool.query(
          `SELECT id, order_number, status::text AS status, total_amount::text AS total_amount, created_at
           FROM public.orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 5`,
          [userId],
        ),
      ]);
      return {
        total: Number(countRes.rows[0]?.total ?? 0),
        recent: recentRes.rows.map((row: any) => ({
          id: Number(row.id),
          orderNumber: String(row.order_number),
          status: String(row.status),
          totalAmount: String(row.total_amount),
          createdAt: toIso(row.created_at) ?? new Date(0).toISOString(),
        })),
      };
    } catch {
      return null;
    }
  })();

  const riderTrips = await (async () => {
    try {
      const res = await pool.query(
        `SELECT COUNT(*)::int AS total FROM public.rider_trips WHERE rider_user_id = $1`,
        [userId],
      );
      return { total: Number(res.rows[0]?.total ?? 0) };
    } catch {
      return null; // defensive: DDL drift tolerated
    }
  })();

  const tickets = await (async () => {
    try {
      const [countRes, recentRes] = await Promise.all([
        pool.query(
          `SELECT
             COUNT(*) FILTER (WHERE status = 'open')::int AS open,
             COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress
           FROM public.support_tickets WHERE customer_id = $1`,
          [userId],
        ),
        pool.query(
          `${TICKET_SELECT} WHERE st.customer_id = $1 ORDER BY st.created_at DESC LIMIT 5`,
          [userId],
        ),
      ]);
      return {
        open: Number(countRes.rows[0]?.open ?? 0),
        inProgress: Number(countRes.rows[0]?.in_progress ?? 0),
        recent: recentRes.rows.map(mapTicketRow),
      };
    } catch {
      return null;
    }
  })();

  const membership = await (async () => {
    try {
      const res = await pool.query(
        `SELECT m.status::text AS status, mp.plan_name
         FROM public.consumer_memberships m
         LEFT JOIN public.membership_plans mp ON mp.id = m.plan_id
         WHERE m.user_id = $1
         ORDER BY m.id DESC
         LIMIT 1`,
        [userId],
      );
      const row = res.rows[0];
      return row ? { status: String(row.status), planName: row.plan_name ?? null } : null;
    } catch {
      return null; // defensive: DDL drift tolerated
    }
  })();

  const wallet = await (async () => {
    try {
      const res = await pool.query(
        `SELECT balance::text AS balance, currency FROM public.wallets WHERE user_id = $1 LIMIT 1`,
        [userId],
      );
      const row = res.rows[0];
      return row ? { balance: String(row.balance), currency: String(row.currency ?? "EUR") } : null;
    } catch {
      return null;
    }
  })();

  const longcatMemory = await (async () => {
    try {
      const res = await pool.query(
        `SELECT lifetime_orders, average_order_value::text AS average_order_value,
                last_ordered_at, memory_summary
         FROM public.longcat_customer_memory_profiles WHERE user_id = $1 LIMIT 1`,
        [userId],
      );
      const row = res.rows[0];
      return row
        ? {
            lifetimeOrders: Number(row.lifetime_orders ?? 0),
            averageOrderValue: String(row.average_order_value),
            lastOrderedAt: toIso(row.last_ordered_at),
            memorySummary: String(row.memory_summary ?? ""),
          }
        : null;
    } catch {
      // 42P01: table is RUNTIME-created (recon) — tolerate its absence.
      return null;
    }
  })();

  return { user, orders, riderTrips, tickets, membership, wallet, longcatMemory };
}
