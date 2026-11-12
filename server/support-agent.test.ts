/**
 * P3-S support agent tests (vitest): operator gating via the REAL trpc.ts
 * middleware chain (policy stubbed allow-all, MFA off outside production),
 * assign/update writers with spec status edges and transactional
 * idempotency, fail-open notification hooks, consumer-opened trip support
 * cases (ownership-scoped via the 0043 SQL fn), and the defensive
 * customer360 aggregate tolerating a missing longcat memory table.
 *
 * The Postgres boundary is a stateful fake pool emulating exactly the SQL
 * shapes issued by supportAgent.ts / supportNotifications.ts.
 */

import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./_core/notificationGateway", () => ({
  sendEmail: vi.fn(async () => ({ delivered: true })),
}));

// ---------------------------------------------------------------------------
// Stateful fake pool
// ---------------------------------------------------------------------------

function pgError(code: string, message: string) {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

interface FakeTicket {
  id: number;
  ticket_number: string;
  customer_id: number | null;
  order_id: number | null;
  assigned_to: number | null;
  type: string;
  priority: string;
  status: string;
  subject: string;
  description: string;
  resolution: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

const NOW = "2030-01-01T00:00:00.000Z";

function buildFakePool(options: { longcatPresent?: boolean } = {}) {
  const users = [
    { id: 1, name: "Operator Ada", role: "admin", email: "ada@switchos.dev", phone: null, open_id: "op-1", created_at: NOW },
    { id: 2, name: "Regular Uche", role: "user", email: "uche@example.com", phone: null, open_id: "user-2", created_at: NOW },
    { id: 7, name: "Consumer Chi", role: "user", email: "chi@example.com", phone: "08012345678", open_id: "consumer-openid-1", created_at: NOW },
  ];
  const tickets: FakeTicket[] = [
    {
      id: 100,
      ticket_number: "CS-100",
      customer_id: 7,
      order_id: null,
      assigned_to: null,
      type: "general",
      priority: "medium",
      status: "open",
      subject: "Where is my order",
      description: "It has been three hours.",
      resolution: null,
      created_at: NOW,
      updated_at: NOW,
      resolved_at: null,
    },
    {
      id: 101,
      ticket_number: "CS-101",
      customer_id: 7,
      order_id: null,
      assigned_to: 1,
      type: "payment",
      priority: "high",
      status: "in_progress",
      subject: "Double charge",
      description: "Charged twice for order 55.",
      resolution: null,
      created_at: NOW,
      updated_at: NOW,
      resolved_at: null,
    },
  ];
  const claims = new Set<string>();
  const notifications: Array<{
    user_id: number;
    title: string;
    message: string;
    metadata: Record<string, string>;
  }> = [];
  const tripCases = new Map<string, {
    case_id: string;
    state: string;
    assigned_operator_user_id: number | null;
    resolved_at: string | null;
    closed_at: string | null;
  }>();
  const tripCaseKeys = new Map<string, string>();
  let tripCaseSeq = 0;
  const OWNED_TRIP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // rider = user 7
  const OTHER_TRIP_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  const withContact = (t: FakeTicket) => ({
    ...t,
    customer_name: users.find((u) => u.id === t.customer_id)?.name ?? null,
    customer_email: users.find((u) => u.id === t.customer_id)?.email ?? null,
    assignee_name: users.find((u) => u.id === t.assigned_to)?.name ?? null,
    order_number: null,
  });

  async function query(rawSql: string, params: unknown[] = []): Promise<{ rows: any[] }> {
    const sql = rawSql.replace(/\s+/g, " ").trim();

    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };

    // Idempotency ledger claim (INSERT-first)
    if (sql.includes("INSERT INTO public.consumer_processed_events")) {
      const key = `${params[0]}|${params[1]}`;
      if (claims.has(key)) return { rows: [] };
      claims.add(key);
      return { rows: [{ event_id: params[1] }] };
    }

    // Ticket row for update
    if (sql.includes("FROM public.support_tickets WHERE id = $1 FOR UPDATE")) {
      const ticket = tickets.find((t) => t.id === params[0]);
      return { rows: ticket ? [{ ...ticket }] : [] };
    }

    // Assignee lookup
    if (/SELECT id, role FROM public\.users WHERE id = \$1/.test(sql)) {
      const user = users.find((u) => u.id === params[0]);
      return { rows: user ? [{ id: user.id, role: user.role }] : [] };
    }

    // Assignment write
    if (sql.includes("UPDATE public.support_tickets SET assigned_to")) {
      const ticket = tickets.find((t) => t.id === params[0])!;
      ticket.assigned_to = Number(params[1]);
      ticket.updated_at = NOW;
      return { rows: [{ ...ticket }] };
    }

    // Status/priority/resolution write
    if (sql.includes("UPDATE public.support_tickets SET status = $2")) {
      const ticket = tickets.find((t) => t.id === params[0])!;
      ticket.status = String(params[1]);
      if (/priority = \$(\d+)/.test(sql)) {
        const n = Number(/priority = \$(\d+)/.exec(sql)![1]);
        ticket.priority = String(params[n - 1]);
      }
      if (/resolution = \$(\d+)/.test(sql)) {
        const n = Number(/resolution = \$(\d+)/.exec(sql)![1]);
        ticket.resolution = params[n - 1] as string | null;
      }
      if (sql.includes("resolved_at = now()")) ticket.resolved_at = NOW;
      if (sql.includes("resolved_at = NULL")) ticket.resolved_at = null;
      ticket.updated_at = NOW;
      return { rows: [{ ...ticket }] };
    }

    // Queue count
    if (sql.includes("COUNT(*)::int AS total FROM public.support_tickets st")) {
      let filtered = tickets;
      let paramIndex = 0;
      const nextParam = () => params[paramIndex++];
      if (sql.includes("st.status =")) { const v = nextParam(); filtered = filtered.filter((t) => t.status === v); }
      if (sql.includes("st.type =")) { const v = nextParam(); filtered = filtered.filter((t) => t.type === v); }
      if (sql.includes("st.priority =")) { const v = nextParam(); filtered = filtered.filter((t) => t.priority === v); }
      if (sql.includes("st.assigned_to =")) { const v = nextParam(); filtered = filtered.filter((t) => t.assigned_to === v); }
      return { rows: [{ total: filtered.length }] };
    }

    // Ticket detail (joined) — must precede the queue branch
    if (sql.includes("cu.name AS customer_name") && sql.includes("WHERE st.id = $1")) {
      const ticket = tickets.find((t) => t.id === params[0]);
      return { rows: ticket ? [withContact(ticket)] : [] };
    }

    // Customer360 recent tickets
    if (sql.includes("cu.name AS customer_name") && sql.includes("WHERE st.customer_id = $1")) {
      return {
        rows: tickets.filter((t) => t.customer_id === params[0]).map(withContact),
      };
    }

    // Queue page (joined)
    if (sql.includes("cu.name AS customer_name") && sql.includes("ORDER BY st.created_at DESC")) {
      let filtered = [...tickets];
      let paramIndex = 0;
      const nextParam = () => params[paramIndex++];
      if (sql.includes("st.status =")) { const v = nextParam(); filtered = filtered.filter((t) => t.status === v); }
      if (sql.includes("st.type =")) { const v = nextParam(); filtered = filtered.filter((t) => t.type === v); }
      if (sql.includes("st.priority =")) { const v = nextParam(); filtered = filtered.filter((t) => t.priority === v); }
      if (sql.includes("st.assigned_to =")) { const v = nextParam(); filtered = filtered.filter((t) => t.assigned_to === v); }
      const limit = Number(nextParam());
      const offset = Number(nextParam());
      return { rows: filtered.slice(offset, offset + limit).map(withContact) };
    }

    // Notification insert
    if (sql.includes("INSERT INTO public.notifications")) {
      notifications.push({
        user_id: Number(params[0]),
        title: String(params[1]),
        message: String(params[2]),
        metadata: JSON.parse(String(params[3])),
      });
      return { rows: [] };
    }

    // Lazy 'opened' sweep
    if (sql.includes("metadata->>'kind' = 'opened'")) {
      const ids = (params[0] as string[]).map(String);
      const seen = notifications
        .filter((n) => n.metadata.kind === "opened" && ids.includes(String(n.metadata.supportTicketId)))
        .map((n) => ({ ticket_id: String(n.metadata.supportTicketId) }));
      return { rows: seen };
    }

    // Notification read surface
    if (sql.includes("FROM public.notifications WHERE user_id = $1")) {
      return {
        rows: notifications
          .filter((n) => n.user_id === params[0])
          .map((n, i) => ({
            id: i + 1,
            type: "system",
            title: n.title,
            message: n.message,
            priority: "medium",
            is_read: false,
            metadata: n.metadata,
            created_at: NOW,
          })),
      };
    }

    // Ticket contact lookup for notifications
    if (sql.includes("st.ticket_number") && sql.includes("customer_email")) {
      const ticket = tickets.find((t) => t.id === params[0]);
      return {
        rows: ticket
          ? [{
              id: ticket.id,
              ticket_number: ticket.ticket_number,
              subject: ticket.subject,
              customer_id: ticket.customer_id,
              customer_email: users.find((u) => u.id === ticket.customer_id)?.email ?? null,
            }]
          : [],
      };
    }

    // resolvePublicUser union
    if (sql.includes("'open_id'::text AS link") && sql.includes("UNION ALL")) {
      const user = users.find((u) => u.open_id === params[0]);
      return { rows: user ? [{ id: user.id, link: "open_id" }] : [] };
    }

    // Trip support case engine (0043 SQL fns)
    if (sql.includes("mobility.create_trip_support_case")) {
      const [tripId, requester, caseType, subject, description, key] = params as string[];
      if (tripId !== OWNED_TRIP_ID || Number(requester) !== 7) {
        throw pgError("P0002", "trip not found for requester");
      }
      const existingKey = [...tripCaseKeys.entries()].find(([, k]) => k === key);
      if (existingKey) return { rows: [{ case_id: existingKey[0] }] };
      tripCaseSeq += 1;
      const caseId = `cccccccc-0000-4000-8000-${String(tripCaseSeq).padStart(12, "0")}`;
      tripCases.set(caseId, {
        case_id: caseId,
        state: "open",
        assigned_operator_user_id: null,
        resolved_at: null,
        closed_at: null,
      });
      tripCaseKeys.set(caseId, key);
      return { rows: [{ case_id: caseId }] };
    }

    if (sql.includes("mobility.apply_trip_support_case_action")) {
      const [caseId, operatorId, action, key, note] = params as [string, number, string, string, string | null];
      const current = tripCases.get(caseId);
      if (!current) throw pgError("P0002", "support case not found");
      const edges: Record<string, Record<string, string>> = {
        open: { assign: "assigned" },
        assigned: { request_information: "awaiting_requester", resolve: "resolved" },
        awaiting_requester: { resolve: "resolved" },
        resolved: { reopen: "assigned", close: "closed" },
        closed: {},
      };
      const next = edges[current.state]?.[action];
      if (!next) {
        throw pgError("55000", `invalid support case transition: ${current.state} + ${action}`);
      }
      if (action === "resolve" && (!note || !note.trim())) {
        throw pgError("22023", "resolution note required");
      }
      const previous = current.state;
      current.state = next;
      if (action === "assign") current.assigned_operator_user_id = Number(operatorId);
      current.resolved_at = next === "resolved" ? NOW : current.resolved_at;
      current.closed_at = next === "closed" ? NOW : current.closed_at;
      return {
        rows: [{
          case_id: caseId,
          previous_state: previous,
          next_state: next,
          assigned_operator_user_id: current.assigned_operator_user_id,
          resolved_at: current.resolved_at,
          closed_at: current.closed_at,
        }],
      };
    }

    // Trip case queue
    if (sql.includes("FROM mobility.trip_support_case c") && sql.includes("COUNT")) {
      return { rows: [{ total: tripCases.size }] };
    }
    if (sql.includes("FROM mobility.trip_support_case c")) {
      return {
        rows: [...tripCases.values()].map((c) => ({
          ...c,
          case_type: "fare_question",
          subject: "s",
          description: "d",
          trip_id: OWNED_TRIP_ID,
          rider_user_id: 7,
          requester_name: "Consumer Chi",
          opened_at: NOW,
        })),
      };
    }

    // customer360 sections
    if (sql.includes("FROM public.users WHERE id = $1") && sql.includes("email, phone")) {
      const user = users.find((u) => u.id === params[0]);
      return { rows: user ? [user] : [] };
    }
    if (sql.includes("COUNT(*)::int AS total FROM public.orders WHERE customer_id = $1")) {
      return { rows: [{ total: 4 }] };
    }
    if (sql.includes("FROM public.orders WHERE customer_id = $1 ORDER BY")) {
      return {
        rows: [
          { id: 55, order_number: "ORD-55", status: "delivered", total_amount: "66.00", created_at: NOW },
        ],
      };
    }
    if (sql.includes("FROM public.rider_trips WHERE rider_user_id = $1")) {
      return { rows: [{ total: 3 }] };
    }
    if (sql.includes("FROM public.support_tickets WHERE customer_id = $1")) {
      const mine = tickets.filter((t) => t.customer_id === params[0]);
      return {
        rows: [{
          open: mine.filter((t) => t.status === "open").length,
          in_progress: mine.filter((t) => t.status === "in_progress").length,
        }],
      };
    }
    if (sql.includes("FROM public.consumer_memberships")) {
      return { rows: [{ status: "active", plan_name: "Gold" }] };
    }
    if (sql.includes("FROM public.wallets WHERE user_id = $1")) {
      return { rows: [{ balance: "125.00", currency: "EUR" }] };
    }
    if (sql.includes("longcat_customer_memory_profiles")) {
      if (!options.longcatPresent) {
        throw pgError("42P01", 'relation "longcat_customer_memory_profiles" does not exist');
      }
      return {
        rows: [{
          lifetime_orders: 9,
          average_order_value: "42.50",
          last_ordered_at: NOW,
          memory_summary: "Prefers jollof on Fridays",
        }],
      };
    }

    throw new Error(`fake pool: unrouted SQL: ${sql}`);
  }

  return {
    query,
    connect: async () => ({ query, release: () => undefined }),
    // test introspection
    _state: { users, tickets, claims, notifications, tripCases },
  };
}

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

const OPERATOR = { id: 1, name: "Operator Ada", role: "admin", openId: "op-1" };
const NON_OPERATOR = { id: 2, name: "Regular Uche", role: "user", openId: "user-2" };
const CONSUMER = { id: 7, name: "Consumer Chi", role: "user", openId: "consumer-openid-1", email: "chi@example.com" };

let pool: ReturnType<typeof buildFakePool>;

vi.mock("./db", () => ({
  getPool: async () => pool,
  getDb: async () => pool,
  DatabaseUnavailableError: class extends Error {},
}));

async function loadModules() {
  vi.resetModules();
  // Sequential imports: avoids the vi.mock/importOriginal race documented in
  // the P2 whatsapp tests.
  const router = await import("./_core/supportAgentRouter");
  const agent = await import("./_core/supportAgent");
  const notifications = await import("./_core/supportNotifications");
  const gateway = await import("./_core/notificationGateway");
  return { router, agent, notifications, gateway };
}

function callerFor(mods: Awaited<ReturnType<typeof loadModules>>, user: unknown) {
  return mods.router.supportAgentRouter.createCaller({ user } as any);
}

beforeEach(() => {
  pool = buildFakePool();
});

// ---------------------------------------------------------------------------
// Operator gating
// ---------------------------------------------------------------------------

describe("operator gating", () => {
  it("rejects non-operators on queue reads and writers (FORBIDDEN)", async () => {
    const mods = await loadModules();
    const caller = callerFor(mods, NON_OPERATOR);
    await expect(caller.ticketQueue({ limit: 25, offset: 0 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      caller.assignTicket({ ticketId: 100, assigneeUserId: 1, idempotencyKey: "wa-assign-100-a" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects unauthenticated callers (UNAUTHORIZED)", async () => {
    const mods = await loadModules();
    const caller = callerFor(mods, null);
    await expect(caller.ticketQueue({ limit: 25, offset: 0 })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});

// ---------------------------------------------------------------------------
// Assign writer + fail-open notification
// ---------------------------------------------------------------------------

describe("assignTicket", () => {
  it("assigns, notifies (row + fail-open email), and replays idempotently", async () => {
    const mods = await loadModules();
    const caller = callerFor(mods, OPERATOR);

    const first = await caller.assignTicket({
      ticketId: 100,
      assigneeUserId: 1,
      idempotencyKey: "wa-assign-100-a",
    });
    expect(first.replayed).toBe(false);
    expect(first.ticket.assignedTo).toBe(1);
    expect(first.ticket.assigneeName).toBe("Operator Ada");

    // Notification row inserted; email attempted (never blocks the mutation).
    expect(pool._state.notifications).toHaveLength(1);
    expect(pool._state.notifications[0].metadata.kind).toBe("assigned");
    expect(pool._state.notifications[0].user_id).toBe(7);
    expect(vi.mocked(mods.gateway.sendEmail)).toHaveBeenCalledWith(
      "chi@example.com",
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ supportTicketId: "100" }),
    );

    // Replay: same key → replayed, no duplicate notification.
    const second = await caller.assignTicket({
      ticketId: 100,
      assigneeUserId: 1,
      idempotencyKey: "wa-assign-100-a",
    });
    expect(second.replayed).toBe(true);
    expect(pool._state.notifications).toHaveLength(1);
  });

  it("refuses to assign to a non-operator (BAD_REQUEST)", async () => {
    const mods = await loadModules();
    const caller = callerFor(mods, OPERATOR);
    await expect(
      caller.assignTicket({ ticketId: 100, assigneeUserId: 2, idempotencyKey: "wa-assign-100-b" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "assignee_not_operator" });
  });
});

// ---------------------------------------------------------------------------
// Status edges + resolve-requires-resolution
// ---------------------------------------------------------------------------

describe("updateTicket status edges", () => {
  it("enforces open→in_progress→resolved→closed (+reopen) edges", async () => {
    const mods = await loadModules();
    const caller = callerFor(mods, OPERATOR);
    const key = (s: string) => `wa-update-100-${s}`;

    // open → resolved skips in_progress: rejected (55000 → CONFLICT)
    await expect(
      caller.updateTicket({ ticketId: 100, status: "resolved", resolution: "x", idempotencyKey: key("skip") }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // open → in_progress: allowed
    const progressed = await caller.updateTicket({
      ticketId: 100,
      status: "in_progress",
      idempotencyKey: key("progress"),
    });
    expect(progressed.ticket.status).toBe("in_progress");

    // in_progress → resolved without resolution text: rejected (23514 → BAD_REQUEST)
    await expect(
      caller.updateTicket({ ticketId: 100, status: "resolved", idempotencyKey: key("nores") }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "resolution_required" });

    // in_progress → resolved with resolution: allowed, resolved_at set, hook fired
    const resolved = await caller.updateTicket({
      ticketId: 100,
      status: "resolved",
      resolution: "Courier dispatched a replacement.",
      idempotencyKey: key("resolve"),
    });
    expect(resolved.ticket.status).toBe("resolved");
    expect(resolved.ticket.resolvedAt).toBe(NOW);
    expect(pool._state.notifications.some((n) => n.metadata.kind === "resolved")).toBe(true);

    // resolved → in_progress reopen: allowed, resolved_at cleared
    const reopened = await caller.updateTicket({
      ticketId: 100,
      status: "in_progress",
      idempotencyKey: key("reopen"),
    });
    expect(reopened.ticket.status).toBe("in_progress");
    expect(reopened.ticket.resolvedAt).toBeNull();

    // Drive to closed and prove it is terminal.
    await caller.updateTicket({
      ticketId: 100,
      status: "resolved",
      resolution: "Replacement delivered.",
      idempotencyKey: key("resolve2"),
    });
    const closed = await caller.updateTicket({
      ticketId: 100,
      status: "closed",
      idempotencyKey: key("close"),
    });
    expect(closed.ticket.status).toBe("closed");
    await expect(
      caller.updateTicket({ ticketId: 100, status: "open", idempotencyKey: key("reopen2") }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("is idempotent under key replay", async () => {
    const mods = await loadModules();
    const caller = callerFor(mods, OPERATOR);
    const input = {
      ticketId: 100,
      status: "in_progress" as const,
      idempotencyKey: "wa-update-100-replay",
    };
    const first = await caller.updateTicket(input);
    const second = await caller.updateTicket(input);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.ticket.status).toBe("in_progress");
  });
});

// ---------------------------------------------------------------------------
// Queue read + DESIGN NOTE lazy opened-notification
// ---------------------------------------------------------------------------

describe("ticketQueue", () => {
  it("filters by status and lazily backfills consumer-opened notifications once", async () => {
    const mods = await loadModules();
    const caller = callerFor(mods, OPERATOR);

    const open = await caller.ticketQueue({ status: "open", limit: 25, offset: 0 });
    expect(open.total).toBe(1);
    expect(open.tickets[0].ticketNumber).toBe("CS-100");

    // DESIGN NOTE: the consumer-open writer fires no hook, so the queue
    // read generated the 'opened' notification for the open ticket.
    expect(
      pool._state.notifications.filter((n) => n.metadata.kind === "opened"),
    ).toHaveLength(1);

    // Second listing does not duplicate it.
    await caller.ticketQueue({ status: "open", limit: 25, offset: 0 });
    expect(
      pool._state.notifications.filter((n) => n.metadata.kind === "opened"),
    ).toHaveLength(1);
  });

  it("assignedToMe scopes to the calling operator", async () => {
    const mods = await loadModules();
    const caller = callerFor(mods, OPERATOR);
    const mine = await caller.ticketQueue({ assignedToMe: true, limit: 25, offset: 0 });
    expect(mine.total).toBe(1);
    expect(mine.tickets[0].ticketNumber).toBe("CS-101");
  });
});

// ---------------------------------------------------------------------------
// Trip support case engine (consumer-open + operator action)
// ---------------------------------------------------------------------------

describe("trip support cases", () => {
  it("lets a consumer open a case on their own trip (ownership via SQL fn)", async () => {
    const mods = await loadModules();
    const consumer = callerFor(mods, CONSUMER);
    const result = await consumer.openTripSupportCase({
      tripId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      caseType: "fare_question",
      subject: "Charged twice for this trip",
      description: "My card shows two identical charges.",
      idempotencyKey: "wa-tripcase-open-1",
    });
    expect(result.caseId).toMatch(/^cccccccc-/);
  });

  it("maps ownership failures to NOT_FOUND (P0002)", async () => {
    const mods = await loadModules();
    const consumer = callerFor(mods, CONSUMER);
    await expect(
      consumer.openTripSupportCase({
        tripId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        caseType: "other",
        subject: "Not my trip",
        description: "Should be refused by the engine.",
        idempotencyKey: "wa-tripcase-open-2",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("applies operator actions with engine edges (55000 → CONFLICT)", async () => {
    const mods = await loadModules();
    const consumer = callerFor(mods, CONSUMER);
    const { caseId } = await consumer.openTripSupportCase({
      tripId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      caseType: "other",
      subject: "Need help with trip",
      description: "Details for the operator.",
      idempotencyKey: "wa-tripcase-open-3",
    });

    const operator = callerFor(mods, OPERATOR);
    const assigned = await operator.actOnTripSupportCase({
      caseId,
      action: "assign",
      idempotencyKey: "wa-tripcase-act-1",
    });
    expect(assigned.previousState).toBe("open");
    expect(assigned.nextState).toBe("assigned");
    expect(assigned.assignedOperatorUserId).toBe(1);

    // close straight from 'assigned' is not an engine edge → CONFLICT
    await expect(
      operator.actOnTripSupportCase({ caseId, action: "close", idempotencyKey: "wa-tripcase-act-2" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const resolved = await operator.actOnTripSupportCase({
      caseId,
      action: "resolve",
      note: "Refunded the duplicate charge.",
      idempotencyKey: "wa-tripcase-act-3",
    });
    expect(resolved.nextState).toBe("resolved");
    expect(resolved.resolvedAt).toBe(NOW);
  });
});

// ---------------------------------------------------------------------------
// customer360 defensive aggregate
// ---------------------------------------------------------------------------

describe("customer360", () => {
  it("aggregates sections and tolerates the runtime longcat table being absent", async () => {
    pool = buildFakePool({ longcatPresent: false });
    const mods = await loadModules();
    const caller = callerFor(mods, OPERATOR);
    const view = await caller.customer360({ userId: 7 });

    expect(view.user).toMatchObject({ id: 7, name: "Consumer Chi", email: "chi@example.com" });
    expect(view.orders).toMatchObject({ total: 4 });
    expect(view.orders?.recent[0]).toMatchObject({ orderNumber: "ORD-55" });
    expect(view.riderTrips).toEqual({ total: 3 });
    expect(view.tickets).toMatchObject({ open: 1, inProgress: 1 });
    expect(view.membership).toEqual({ status: "active", planName: "Gold" });
    expect(view.wallet).toEqual({ balance: "125.00", currency: "EUR" });
    // 42P01 tolerated: section is null, the aggregate still succeeds.
    expect(view.longcatMemory).toBeNull();
  });

  it("includes the longcat memory section when the table exists", async () => {
    pool = buildFakePool({ longcatPresent: true });
    const mods = await loadModules();
    const caller = callerFor(mods, OPERATOR);
    const view = await caller.customer360({ userId: 7 });
    expect(view.longcatMemory).toMatchObject({
      lifetimeOrders: 9,
      memorySummary: "Prefers jollof on Fridays",
    });
  });

  it("fails NOT_FOUND for an unknown user", async () => {
    const mods = await loadModules();
    const caller = callerFor(mods, OPERATOR);
    await expect(caller.customer360({ userId: 999 })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

// ---------------------------------------------------------------------------
// Consumer notification read surface
// ---------------------------------------------------------------------------

describe("mySupportNotifications", () => {
  it("returns the caller's support notifications after an assignment", async () => {
    const mods = await loadModules();
    const operator = callerFor(mods, OPERATOR);
    await operator.assignTicket({
      ticketId: 100,
      assigneeUserId: 1,
      idempotencyKey: "wa-assign-100-notif",
    });

    const consumer = callerFor(mods, CONSUMER);
    const list = await consumer.mySupportNotifications({ limit: 20 });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      title: "Support case assigned",
      ticketNumber: "CS-100",
    });
  });

  it("scopes to the caller (a different consumer sees nothing)", async () => {
    const mods = await loadModules();
    const operator = callerFor(mods, OPERATOR);
    await operator.assignTicket({
      ticketId: 100,
      assigneeUserId: 1,
      idempotencyKey: "wa-assign-100-scope",
    });
    const other = callerFor(mods, { id: 2, name: "Regular Uche", role: "user", openId: "user-2" });
    expect(await other.mySupportNotifications({ limit: 20 })).toHaveLength(0);
  });
});
