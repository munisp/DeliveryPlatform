/**
 * P4-V vertical-ops tests (vitest): full status-machine matrices for
 * freight / business-travel / healthcare writers, idempotency replay via the
 * 0072 consumer_processed_events ledger, money guards (integer minor units,
 * NGN-only currency), and authz (operator gating via the REAL trpc.ts
 * middleware chain with the non-production scope fallback; actor scoping via
 * resolvePublicUser against the fake public.users table).
 *
 * The Postgres boundary is a stateful fake pool emulating exactly the SQL
 * shapes issued by verticalOpsRouter.ts (support-agent.test.ts pattern).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Stateful fake pool
// ---------------------------------------------------------------------------

interface FakeUser { id: number; open_id: string | null; email: string | null; name: string }
interface FakeProvider { id: number; status: string }
interface FakeFreightLoad {
  id: number; shipper_provider_id: number | null; status: string;
  lane_code: string | null; origin_label: string | null; destination_label: string | null;
  equipment: string; value_minor: number; currency: string;
  created_at: string; updated_at: string;
}
interface FakeTravelAccount {
  id: number; company_name: string; billing_email: string; status: string;
  approval_mode: string; service_mix: string; monthly_budget_minor: number | null;
  created_by: number;
}
interface FakeTravelTrip {
  id: number; account_id: number; traveler_user_id: number; status: string;
  expense_state: string; fare_minor: number; currency: string;
  cost_center: string | null; purpose: string | null; requested_at: string;
}
interface FakeBooking {
  id: number; patient_ref: string; rider_user_id: number; program: string;
  service_line: string; schedule_mode: string; mobility_needs: string | null;
  compliance_notes: string | null; appointment_at: string | null; status: string;
  fare_minor: number; currency: string; created_at: string;
}

const NOW = "2030-06-01T00:00:00.000Z";

function buildFakePool() {
  const state = {
    users: [
      { id: 11, open_id: "op-1", email: "ada@switchos.dev", name: "Operator Ada" },
      { id: 12, open_id: "user-7", email: "chi@example.com", name: "Consumer Chi" },
      { id: 13, open_id: "user-8", email: "obi@example.com", name: "Consumer Obi" },
    ] as FakeUser[],
    providers: [
      { id: 501, status: "active" },
      { id: 502, status: "pending" },
    ] as FakeProvider[],
    portals: [{ provider_id: 501, owner_user_id: 12 }],
    freightLoads: [] as FakeFreightLoad[],
    nextFreightId: 1,
    accounts: [] as FakeTravelAccount[],
    nextAccountId: 1,
    trips: [] as FakeTravelTrip[],
    nextTripId: 1,
    bookings: [] as FakeBooking[],
    nextBookingId: 1,
    ledger: new Map<string, unknown>(),
  };

  const dispatch = async (text: string, values: unknown[] = []): Promise<{ rows: any[] }> => {
    const sql = text.replace(/\s+/g, " ").trim();

    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };

    // -- idempotency ledger (0072) ------------------------------------------
    if (/SELECT result_json FROM public\.consumer_processed_events/.test(sql)) {
      const key = `${values[0]}|${values[1]}|${values[2]}`;
      const hit = state.ledger.get(key);
      return { rows: hit === undefined ? [] : [{ result_json: hit }] };
    }
    if (/INSERT INTO public\.consumer_processed_events/.test(sql)) {
      const key = `${values[0]}|${values[1]}|${values[2]}`;
      if (!state.ledger.has(key)) {
        state.ledger.set(key, JSON.parse(String(values[3])));
      }
      return { rows: [] };
    }

    // -- resolvePublicUser ---------------------------------------------------
    if (/SELECT u\.id, 'open_id'::text AS link/.test(sql)) {
      const [openId, email] = values as [string | null, string | null];
      const byOpenId = openId ? state.users.find((u) => u.open_id === openId) : undefined;
      if (byOpenId) return { rows: [{ id: byOpenId.id, link: "open_id" }] };
      const byEmail = email
        ? state.users.find((u) => u.email && u.email.toLowerCase() === email.toLowerCase())
        : undefined;
      if (byEmail) return { rows: [{ id: byEmail.id, link: "email" }] };
      return { rows: [] };
    }
    if (/INSERT INTO public\.users/.test(sql)) {
      const id = Math.max(...state.users.map((u) => u.id), 0) + 1;
      state.users.push({ id, open_id: values[0] as string, email: (values[2] as string) ?? null, name: (values[1] as string) ?? "User" });
      return { rows: [{ id }] };
    }
    if (/SELECT id FROM public\.users WHERE open_id/.test(sql)) {
      const row = state.users.find((u) => u.open_id === values[0]);
      return { rows: row ? [{ id: row.id }] : [] };
    }

    // -- freight_loads ---------------------------------------------------------
    if (/SELECT id, status FROM freight_loads WHERE id = \$1 FOR UPDATE/.test(sql)) {
      const row = state.freightLoads.find((l) => l.id === Number(values[0]));
      return { rows: row ? [{ id: row.id, status: row.status }] : [] };
    }
    if (/SELECT id FROM service_providers WHERE id = \$1/.test(sql) && !/status::text/.test(sql)) {
      const row = state.providers.find((p) => p.id === Number(values[0]));
      return { rows: row ? [{ id: row.id }] : [] };
    }
    if (/SELECT id, status::text AS status FROM service_providers WHERE id = \$1/.test(sql)) {
      const row = state.providers.find((p) => p.id === Number(values[0]));
      return { rows: row ? [{ id: row.id, status: row.status }] : [] };
    }
    if (/INSERT INTO freight_loads/.test(sql)) {
      const id = state.nextFreightId++;
      state.freightLoads.push({
        id,
        shipper_provider_id: values[0] === null ? null : Number(values[0]),
        lane_code: (values[1] as string) ?? null,
        origin_label: (values[2] as string) ?? null,
        destination_label: (values[3] as string) ?? null,
        status: "draft",
        equipment: String(values[5]),
        value_minor: Number(values[6]),
        currency: String(values[7]),
        created_at: NOW,
        updated_at: NOW,
      });
      return { rows: [{ id }] };
    }
    if (/UPDATE freight_loads SET status = 'tendered'/.test(sql)) {
      const row = state.freightLoads.find((l) => l.id === Number(values[0]));
      if (row) { row.status = "tendered"; row.updated_at = NOW; }
      return { rows: [] };
    }
    if (/UPDATE freight_loads SET status = 'assigned'/.test(sql)) {
      const row = state.freightLoads.find((l) => l.id === Number(values[0]));
      if (row) { row.status = "assigned"; row.updated_at = NOW; }
      return { rows: [] };
    }
    if (/UPDATE freight_loads SET status = \$2/.test(sql)) {
      const row = state.freightLoads.find((l) => l.id === Number(values[0]));
      if (row) { row.status = String(values[1]); row.updated_at = NOW; }
      return { rows: [] };
    }
    if (/FROM freight_loads f JOIN commerce\.merchant_portal/.test(sql)) {
      const ownerId = Number(values[0]);
      const rows = state.freightLoads
        .filter((l) => state.portals.some((p) => p.provider_id === l.shipper_provider_id && p.owner_user_id === ownerId))
        .map((l) => ({
          id: l.id, status: l.status, lane_code: l.lane_code,
          origin_label: l.origin_label, destination_label: l.destination_label,
          equipment: l.equipment, value_minor: l.value_minor, currency: l.currency,
          created_at: l.created_at, updated_at: l.updated_at,
        }));
      return { rows };
    }

    // -- business travel -------------------------------------------------------
    if (/SELECT id, status FROM business_travel_accounts WHERE id = \$1/.test(sql)) {
      const row = state.accounts.find((a) => a.id === Number(values[0]));
      return { rows: row ? [{ id: row.id, status: row.status }] : [] };
    }
    if (/INSERT INTO business_travel_accounts/.test(sql)) {
      const id = state.nextAccountId++;
      state.accounts.push({
        id,
        company_name: String(values[0]),
        billing_email: String(values[1]),
        status: "active",
        approval_mode: String(values[2]),
        service_mix: String(values[3]),
        monthly_budget_minor: values[4] === null ? null : Number(values[4]),
        created_by: Number(values[5]),
      });
      return { rows: [{ id }] };
    }
    if (/FROM business_travel_trips WHERE id = \$1 FOR UPDATE/.test(sql)) {
      const row = state.trips.find((t) => t.id === Number(values[0]));
      return {
        rows: row
          ? [{
              id: row.id, account_id: row.account_id,
              traveler_user_id: row.traveler_user_id,
              status: row.status, expense_state: row.expense_state,
            }]
          : [],
      };
    }
    if (/INSERT INTO business_travel_trips/.test(sql)) {
      const id = state.nextTripId++;
      state.trips.push({
        id,
        account_id: Number(values[0]),
        traveler_user_id: Number(values[1]),
        status: "requested",
        expense_state: "open",
        fare_minor: Number(values[2]),
        currency: String(values[3]),
        cost_center: (values[4] as string) ?? null,
        purpose: (values[5] as string) ?? null,
        requested_at: NOW,
      });
      return { rows: [{ id }] };
    }
    if (/UPDATE business_travel_trips SET expense_state = 'submitted'/.test(sql)) {
      const row = state.trips.find((t) => t.id === Number(values[0]));
      if (row) row.expense_state = "submitted";
      return { rows: [] };
    }
    if (/UPDATE business_travel_trips SET expense_state = 'reconciled'/.test(sql)) {
      const row = state.trips.find((t) => t.id === Number(values[0]));
      if (row) row.expense_state = "reconciled";
      return { rows: [] };
    }
    if (/UPDATE business_travel_trips SET status = 'approved'/.test(sql)) {
      const row = state.trips.find((t) => t.id === Number(values[0]));
      if (row) row.status = "approved";
      return { rows: [] };
    }
    if (/UPDATE business_travel_trips SET status = 'rejected'/.test(sql)) {
      const row = state.trips.find((t) => t.id === Number(values[0]));
      if (row) row.status = "rejected";
      return { rows: [] };
    }
    if (/FROM business_travel_trips t JOIN business_travel_accounts/.test(sql)) {
      const travelerId = Number(values[0]);
      const rows = state.trips
        .filter((t) => t.traveler_user_id === travelerId)
        .map((t) => ({
          id: t.id, account_id: t.account_id, status: t.status,
          expense_state: t.expense_state, fare_minor: t.fare_minor,
          currency: t.currency, cost_center: t.cost_center, purpose: t.purpose,
          requested_at: t.requested_at,
          company_name: state.accounts.find((a) => a.id === t.account_id)?.company_name ?? "",
        }));
      return { rows };
    }

    // -- healthcare_transport_bookings ----------------------------------------
    if (/SELECT id, status FROM healthcare_transport_bookings WHERE id = \$1 FOR UPDATE/.test(sql)) {
      const row = state.bookings.find((b) => b.id === Number(values[0]));
      return { rows: row ? [{ id: row.id, status: row.status }] : [] };
    }
    if (/INSERT INTO healthcare_transport_bookings/.test(sql)) {
      const id = state.nextBookingId++;
      state.bookings.push({
        id,
        patient_ref: String(values[0]),
        rider_user_id: Number(values[1]),
        program: String(values[2]),
        service_line: String(values[3]),
        schedule_mode: String(values[4]),
        mobility_needs: (values[5] as string) ?? null,
        appointment_at: (values[6] as string) ?? null,
        status: "scheduled",
        fare_minor: Number(values[7]),
        currency: String(values[8]),
        compliance_notes: null,
        created_at: NOW,
      });
      return { rows: [{ id }] };
    }
    if (/UPDATE healthcare_transport_bookings SET status = \$2/.test(sql)) {
      const row = state.bookings.find((b) => b.id === Number(values[0]));
      if (row) row.status = String(values[1]);
      return { rows: [] };
    }
    if (/SET compliance_notes = CASE/.test(sql)) {
      const row = state.bookings.find((b) => b.id === Number(values[0]));
      if (row) {
        row.compliance_notes =
          row.compliance_notes === null || row.compliance_notes.length === 0
            ? String(values[1])
            : `${row.compliance_notes}\n${values[1]}`;
      }
      return { rows: [{ compliance_notes: row?.compliance_notes ?? null }] };
    }
    if (/FROM healthcare_transport_bookings WHERE rider_user_id/.test(sql)) {
      const rows = state.bookings
        .filter((b) => b.rider_user_id === Number(values[0]))
        .map((b) => ({
          id: b.id, patient_ref: b.patient_ref, program: b.program,
          service_line: b.service_line, schedule_mode: b.schedule_mode,
          mobility_needs: b.mobility_needs, compliance_notes: b.compliance_notes,
          appointment_at: b.appointment_at, status: b.status,
          fare_minor: b.fare_minor, currency: b.currency, created_at: b.created_at,
        }));
      return { rows };
    }

    throw new Error(`unhandled SQL in fake pool: ${sql}`);
  };

  const client = { query: vi.fn(dispatch), release: vi.fn() };
  return {
    query: vi.fn(dispatch),
    connect: vi.fn(async () => client),
    _state: state,
  };
}

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

const OPERATOR = { id: 1, name: "Operator Ada", role: "admin", openId: "op-1" };
const NON_OPERATOR = { id: 2, name: "Regular Uche", role: "user", openId: "user-2" };
const CONSUMER_A = { id: 7, name: "Consumer Chi", role: "user", openId: "user-7", email: "chi@example.com" };
const CONSUMER_B = { id: 8, name: "Consumer Obi", role: "user", openId: "user-8", email: "obi@example.com" };

let pool: ReturnType<typeof buildFakePool>;

vi.mock("./db", () => ({
  getPool: async () => pool,
  getDb: async () => pool,
  DatabaseUnavailableError: class extends Error {},
}));

async function loadRouter() {
  vi.resetModules();
  const mod = await import("./_core/verticalOpsRouter");
  return mod.verticalOpsRouter;
}

function callerFor(router: Awaited<ReturnType<typeof loadRouter>>, user: unknown) {
  return router.createCaller({ user } as any);
}

beforeEach(() => {
  pool = buildFakePool();
});

// ---------------------------------------------------------------------------
// Authz
// ---------------------------------------------------------------------------

describe("authz", () => {
  it("rejects non-operators on operator mutations (FORBIDDEN)", async () => {
    const router = await loadRouter();
    const caller = callerFor(router, NON_OPERATOR);
    await expect(
      caller.tenderFreightLoad({ loadId: 1, idempotencyKey: "authz-tender-1" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller.approveTravelTrip({ tripId: 1, idempotencyKey: "authz-approve-1" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller.recordComplianceNote({ bookingId: 1, note: "n", idempotencyKey: "authz-note-1" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects unauthenticated callers (UNAUTHORIZED) on ops and actor surfaces", async () => {
    const router = await loadRouter();
    const caller = callerFor(router, null);
    await expect(
      caller.tenderFreightLoad({ loadId: 1, idempotencyKey: "authz-tender-2" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.myTravelTrips({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      caller.scheduleHealthcareBooking({
        patientRef: "P-1",
        idempotencyKey: "authz-sched-1",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects malformed idempotency keys (BAD_REQUEST)", async () => {
    const router = await loadRouter();
    const caller = callerFor(router, OPERATOR);
    await expect(
      caller.tenderFreightLoad({ loadId: 1, idempotencyKey: "short" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

// ---------------------------------------------------------------------------
// Freight
// ---------------------------------------------------------------------------

async function createLoad(caller: any, key = "freight-create-1") {
  return caller.createFreightLoad({
    laneCode: "LOS-ABV",
    originLabel: "Lagos Apapa",
    destinationLabel: "Abuja CBD",
    equipment: "box_truck",
    valueMinor: 2500000,
    idempotencyKey: key,
  });
}

describe("freight load lifecycle", () => {
  it("creates a load in draft and replays the same key without a second insert", async () => {
    const router = await loadRouter();
    const caller = callerFor(router, OPERATOR);
    const first = await createLoad(caller);
    expect(first).toMatchObject({ loadId: 1, status: "draft", replayed: false });
    expect(pool._state.freightLoads).toHaveLength(1);

    const replay = await createLoad(caller);
    expect(replay).toMatchObject({ loadId: 1, status: "draft", replayed: true });
    expect(pool._state.freightLoads).toHaveLength(1);

    const fresh = await createLoad(caller, "freight-create-2");
    expect(fresh.loadId).toBe(2);
    expect(pool._state.freightLoads).toHaveLength(2);
  });

  it("walks the full legal chain draft->tendered->assigned->picked_up->in_transit->delivered", async () => {
    const router = await loadRouter();
    const caller = callerFor(router, OPERATOR);
    await createLoad(caller);

    await expect(
      caller.tenderFreightLoad({ loadId: 1, idempotencyKey: "freight-tender-1" }),
    ).resolves.toMatchObject({ loadId: 1, status: "tendered", previousStatus: "draft" });
    await expect(
      caller.assignFreightCarrier({ loadId: 1, carrierProviderId: 501, idempotencyKey: "freight-assign-1" }),
    ).resolves.toMatchObject({ loadId: 1, status: "assigned", carrierProviderId: 501 });
    await expect(
      caller.transitionFreightLoad({ loadId: 1, targetStatus: "picked_up", idempotencyKey: "freight-tr-1" }),
    ).resolves.toMatchObject({ status: "picked_up", previousStatus: "assigned" });
    await expect(
      caller.transitionFreightLoad({ loadId: 1, targetStatus: "in_transit", idempotencyKey: "freight-tr-2" }),
    ).resolves.toMatchObject({ status: "in_transit", previousStatus: "picked_up" });
    await expect(
      caller.transitionFreightLoad({ loadId: 1, targetStatus: "delivered", idempotencyKey: "freight-tr-3" }),
    ).resolves.toMatchObject({ status: "delivered", previousStatus: "in_transit" });
    expect(pool._state.freightLoads[0].status).toBe("delivered");
  });

  it("rejects illegal edges with NOT_FOUND (P0002-style)", async () => {
    const router = await loadRouter();
    const caller = callerFor(router, OPERATOR);
    await createLoad(caller);

    // tender twice
    await caller.tenderFreightLoad({ loadId: 1, idempotencyKey: "freight-tender-1" });
    await expect(
      caller.tenderFreightLoad({ loadId: 1, idempotencyKey: "freight-tender-2" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // assign from non-tendered + skip-edge assigned->delivered
    await createLoad(caller, "freight-create-2");
    await expect(
      caller.assignFreightCarrier({ loadId: 2, carrierProviderId: 501, idempotencyKey: "freight-assign-2" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await caller.tenderFreightLoad({ loadId: 2, idempotencyKey: "freight-tender-3" });
    await caller.assignFreightCarrier({ loadId: 2, carrierProviderId: 501, idempotencyKey: "freight-assign-3" });
    await expect(
      caller.transitionFreightLoad({ loadId: 2, targetStatus: "delivered", idempotencyKey: "freight-tr-9" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // missing load
    await expect(
      caller.tenderFreightLoad({ loadId: 999, idempotencyKey: "freight-tender-9" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("enforces the carrier compliance hook (active service_providers only)", async () => {
    const router = await loadRouter();
    const caller = callerFor(router, OPERATOR);
    await createLoad(caller);
    await caller.tenderFreightLoad({ loadId: 1, idempotencyKey: "freight-tender-1" });

    await expect(
      caller.assignFreightCarrier({ loadId: 1, carrierProviderId: 999, idempotencyKey: "freight-assign-x" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      caller.assignFreightCarrier({ loadId: 1, carrierProviderId: 502, idempotencyKey: "freight-assign-y" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("cancels from any pre-delivered state with reason, never from delivered", async () => {
    const router = await loadRouter();
    const caller = callerFor(router, OPERATOR);
    await createLoad(caller);
    await caller.tenderFreightLoad({ loadId: 1, idempotencyKey: "freight-tender-1" });
    await caller.assignFreightCarrier({ loadId: 1, carrierProviderId: 501, idempotencyKey: "freight-assign-1" });
    await caller.transitionFreightLoad({ loadId: 1, targetStatus: "picked_up", idempotencyKey: "freight-tr-1" });

    await expect(
      caller.transitionFreightLoad({
        loadId: 1, targetStatus: "cancelled", reason: "shipper withdrew",
        idempotencyKey: "freight-cancel-1",
      }),
    ).resolves.toMatchObject({ status: "cancelled", previousStatus: "picked_up" });

    // cancel without reason fails input validation
    await createLoad(caller, "freight-create-2");
    await expect(
      caller.transitionFreightLoad({ loadId: 2, targetStatus: "cancelled", idempotencyKey: "freight-cancel-2" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // cancel from delivered is illegal
    await caller.tenderFreightLoad({ loadId: 2, idempotencyKey: "freight-tender-2" });
    await caller.assignFreightCarrier({ loadId: 2, carrierProviderId: 501, idempotencyKey: "freight-assign-2" });
    await caller.transitionFreightLoad({ loadId: 2, targetStatus: "picked_up", idempotencyKey: "freight-tr-2" });
    await caller.transitionFreightLoad({ loadId: 2, targetStatus: "in_transit", idempotencyKey: "freight-tr-3" });
    await caller.transitionFreightLoad({ loadId: 2, targetStatus: "delivered", idempotencyKey: "freight-tr-4" });
    await expect(
      caller.transitionFreightLoad({
        loadId: 2, targetStatus: "cancelled", reason: "too late",
        idempotencyKey: "freight-cancel-3",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects bad money: negative, float, non-NGN currency", async () => {
    const router = await loadRouter();
    const caller = callerFor(router, OPERATOR);
    await expect(
      caller.createFreightLoad({ valueMinor: -1, idempotencyKey: "freight-money-1" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.createFreightLoad({ valueMinor: 10.5, idempotencyKey: "freight-money-2" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.createFreightLoad({ valueMinor: 100, currency: "USD", idempotencyKey: "freight-money-3" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(pool._state.freightLoads).toHaveLength(0);
  });

  it("scopes myFreightLoads to the caller's merchant portal (cross-actor denied)", async () => {
    const router = await loadRouter();
    const ops = callerFor(router, OPERATOR);
    await ops.createFreightLoad({
      shipperProviderId: 501, laneCode: "LOS-ABV", valueMinor: 100,
      idempotencyKey: "freight-create-1",
    });

    const ownerView = await callerFor(router, CONSUMER_A).myFreightLoads({});
    expect(ownerView.loads).toHaveLength(1);
    expect(ownerView.loads[0]).toMatchObject({ id: 1, status: "draft", valueMinor: 100 });

    const otherView = await callerFor(router, CONSUMER_B).myFreightLoads({});
    expect(otherView.loads).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Business travel
// ---------------------------------------------------------------------------

async function createAccount(caller: any, key = "travel-acct-1") {
  return caller.createTravelAccount({
    companyName: "Acme Logistics Ltd",
    billingEmail: "travel@acme.example",
    monthlyBudgetMinor: 50000000,
    idempotencyKey: key,
  });
}

async function submitTrip(caller: any, accountId: number, key = "travel-trip-1") {
  return caller.submitTravelTrip({
    accountId,
    fareMinor: 125000,
    costCenter: "OPS-NG",
    purpose: "Depot audit",
    idempotencyKey: key,
  });
}

describe("business travel lifecycle", () => {
  it("creates an account and books a trip (requested/open), replay-safe", async () => {
    const router = await loadRouter();
    const caller = callerFor(router, CONSUMER_A);

    const account = await createAccount(caller);
    expect(account).toMatchObject({ accountId: 1, status: "active", replayed: false });
    const accountReplay = await createAccount(caller);
    expect(accountReplay).toMatchObject({ accountId: 1, replayed: true });
    expect(pool._state.accounts).toHaveLength(1);

    const trip = await submitTrip(caller, 1);
    expect(trip).toMatchObject({ tripId: 1, status: "requested", expenseState: "open" });
    const tripReplay = await submitTrip(caller, 1);
    expect(tripReplay).toMatchObject({ tripId: 1, replayed: true });
    expect(pool._state.trips).toHaveLength(1);
  });

  it("walks the expense machine open->submitted->reconciled and rejects skips", async () => {
    const router = await loadRouter();
    const traveler = callerFor(router, CONSUMER_A);
    const ops = callerFor(router, OPERATOR);
    await createAccount(traveler);
    await submitTrip(traveler, 1);

    // reconcile directly from open is illegal
    await expect(
      ops.reconcileTravelExpense({ tripId: 1, idempotencyKey: "travel-rec-0" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(
      traveler.submitTravelTrip({ tripId: 1, idempotencyKey: "travel-submit-1" }),
    ).resolves.toMatchObject({ tripId: 1, expenseState: "submitted" });

    // double submit is illegal
    await expect(
      traveler.submitTravelTrip({ tripId: 1, idempotencyKey: "travel-submit-2" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(
      ops.reconcileTravelExpense({ tripId: 1, idempotencyKey: "travel-rec-1" }),
    ).resolves.toMatchObject({ tripId: 1, expenseState: "reconciled" });

    // reconcile is terminal
    await expect(
      ops.reconcileTravelExpense({ tripId: 1, idempotencyKey: "travel-rec-2" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("approves/rejects only from requested; approval is terminal for reject", async () => {
    const router = await loadRouter();
    const traveler = callerFor(router, CONSUMER_A);
    const ops = callerFor(router, OPERATOR);
    await createAccount(traveler);
    await submitTrip(traveler, 1);
    await submitTrip(traveler, 1, "travel-trip-2");

    await expect(
      ops.approveTravelTrip({ tripId: 1, idempotencyKey: "travel-approve-1" }),
    ).resolves.toMatchObject({ tripId: 1, status: "approved", previousStatus: "requested" });
    // approved is no longer approvable/rejectable
    await expect(
      ops.approveTravelTrip({ tripId: 1, idempotencyKey: "travel-approve-2" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      ops.rejectTravelTrip({ tripId: 1, reason: "budget", idempotencyKey: "travel-reject-1" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(
      ops.rejectTravelTrip({ tripId: 2, reason: "out of policy", idempotencyKey: "travel-reject-2" }),
    ).resolves.toMatchObject({ tripId: 2, status: "rejected" });
    await expect(
      ops.approveTravelTrip({ tripId: 2, idempotencyKey: "travel-approve-3" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("pins expense submission to the owning traveler (cross-actor FORBIDDEN)", async () => {
    const router = await loadRouter();
    const traveler = callerFor(router, CONSUMER_A);
    await createAccount(traveler);
    await submitTrip(traveler, 1);

    await expect(
      callerFor(router, CONSUMER_B).submitTravelTrip({ tripId: 1, idempotencyKey: "travel-submit-x" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("scopes myTravelTrips to the caller", async () => {
    const router = await loadRouter();
    const traveler = callerFor(router, CONSUMER_A);
    await createAccount(traveler);
    await submitTrip(traveler, 1);

    const mine = await traveler.myTravelTrips({});
    expect(mine.trips).toHaveLength(1);
    expect(mine.trips[0]).toMatchObject({
      id: 1, status: "requested", expenseState: "open", fareMinor: 125000,
      companyName: "Acme Logistics Ltd",
    });
    const other = await callerFor(router, CONSUMER_B).myTravelTrips({});
    expect(other.trips).toHaveLength(0);
  });

  it("rejects bad money and requires exactly one of accountId/tripId", async () => {
    const router = await loadRouter();
    const traveler = callerFor(router, CONSUMER_A);
    await createAccount(traveler);

    await expect(
      traveler.submitTravelTrip({ accountId: 1, fareMinor: -5, idempotencyKey: "travel-money-1" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      traveler.submitTravelTrip({ accountId: 1, fareMinor: 1.5, idempotencyKey: "travel-money-2" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      traveler.submitTravelTrip({ accountId: 1, fareMinor: 100, currency: "USD", idempotencyKey: "travel-money-3" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      traveler.submitTravelTrip({ accountId: 1, idempotencyKey: "travel-shape-1" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      traveler.submitTravelTrip({ accountId: 1, tripId: 1, fareMinor: 100, idempotencyKey: "travel-shape-2" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // unknown account
    await expect(
      traveler.submitTravelTrip({ accountId: 999, fareMinor: 100, idempotencyKey: "travel-shape-3" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(pool._state.trips).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Healthcare transport
// ---------------------------------------------------------------------------

async function scheduleBooking(caller: any, key = "hc-sched-1") {
  return caller.scheduleHealthcareBooking({
    patientRef: "PAT-001",
    serviceLine: "patient_trip",
    scheduleMode: "scheduled",
    mobilityNeeds: "wheelchair",
    appointmentAt: "2030-06-02T09:00:00+01:00",
    fareMinor: 450000,
    idempotencyKey: key,
  });
}

describe("healthcare transport lifecycle", () => {
  it("schedules a booking (status scheduled) and replays the same key", async () => {
    const router = await loadRouter();
    const caller = callerFor(router, CONSUMER_A);

    const first = await scheduleBooking(caller);
    expect(first).toMatchObject({ bookingId: 1, status: "scheduled", scheduleMode: "scheduled" });
    const replay = await scheduleBooking(caller);
    expect(replay).toMatchObject({ bookingId: 1, replayed: true });
    expect(pool._state.bookings).toHaveLength(1);
    expect(pool._state.bookings[0].rider_user_id).toBe(12);
  });

  it("honors the schedule_mode enum and rejects invalid modes", async () => {
    const router = await loadRouter();
    const caller = callerFor(router, CONSUMER_A);
    await expect(
      caller.scheduleHealthcareBooking({
        patientRef: "PAT-002", scheduleMode: "same_day", idempotencyKey: "hc-sched-2",
      }),
    ).resolves.toMatchObject({ scheduleMode: "same_day" });
    await expect(
      caller.scheduleHealthcareBooking({
        patientRef: "PAT-003", scheduleMode: "weekly", idempotencyKey: "hc-sched-3",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("walks scheduled->en_route->arrived->completed and rejects skips", async () => {
    const router = await loadRouter();
    const traveler = callerFor(router, CONSUMER_A);
    const ops = callerFor(router, OPERATOR);
    await scheduleBooking(traveler);

    // skip-edge scheduled->arrived is illegal
    await expect(
      ops.transitionHealthcareBooking({ bookingId: 1, targetStatus: "arrived", idempotencyKey: "hc-tr-skip00" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(
      ops.transitionHealthcareBooking({ bookingId: 1, targetStatus: "en_route", idempotencyKey: "hc-tr-walk01" }),
    ).resolves.toMatchObject({ status: "en_route", previousStatus: "scheduled" });
    await expect(
      ops.transitionHealthcareBooking({ bookingId: 1, targetStatus: "arrived", idempotencyKey: "hc-tr-walk02" }),
    ).resolves.toMatchObject({ status: "arrived", previousStatus: "en_route" });
    await expect(
      ops.transitionHealthcareBooking({ bookingId: 1, targetStatus: "completed", idempotencyKey: "hc-tr-walk03" }),
    ).resolves.toMatchObject({ status: "completed", previousStatus: "arrived" });

    // terminal: cancel after completion is illegal
    await expect(
      ops.transitionHealthcareBooking({
        bookingId: 1, targetStatus: "cancelled", reason: "no show", idempotencyKey: "hc-tr-walk04",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("cancels pre-completed bookings only with a reason", async () => {
    const router = await loadRouter();
    const traveler = callerFor(router, CONSUMER_A);
    const ops = callerFor(router, OPERATOR);
    await scheduleBooking(traveler);

    await expect(
      ops.transitionHealthcareBooking({ bookingId: 1, targetStatus: "cancelled", idempotencyKey: "hc-cancel-0" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      ops.transitionHealthcareBooking({
        bookingId: 1, targetStatus: "cancelled", reason: "patient rescheduled",
        idempotencyKey: "hc-cancel-1",
      }),
    ).resolves.toMatchObject({ status: "cancelled", previousStatus: "scheduled" });
    expect(pool._state.bookings[0].status).toBe("cancelled");
  });

  it("appends compliance notes and rejects unknown bookings", async () => {
    const router = await loadRouter();
    const traveler = callerFor(router, CONSUMER_A);
    const ops = callerFor(router, OPERATOR);
    await scheduleBooking(traveler);

    await expect(
      ops.recordComplianceNote({ bookingId: 1, note: "PHI handling verified", idempotencyKey: "hc-note-1" }),
    ).resolves.toMatchObject({ bookingId: 1, complianceNotes: "PHI handling verified" });
    await expect(
      ops.recordComplianceNote({ bookingId: 1, note: "Driver HIPAA attested", idempotencyKey: "hc-note-2" }),
    ).resolves.toMatchObject({
      bookingId: 1,
      complianceNotes: "PHI handling verified\nDriver HIPAA attested",
    });

    await expect(
      ops.recordComplianceNote({ bookingId: 999, note: "ghost", idempotencyKey: "hc-note-3" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects bad money on scheduling", async () => {
    const router = await loadRouter();
    const caller = callerFor(router, CONSUMER_A);
    await expect(
      caller.scheduleHealthcareBooking({ patientRef: "P-1", fareMinor: -1, idempotencyKey: "hc-money-1" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.scheduleHealthcareBooking({ patientRef: "P-1", fareMinor: 2.5, idempotencyKey: "hc-money-2" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.scheduleHealthcareBooking({
        patientRef: "P-1", fareMinor: 100, currency: "USD", idempotencyKey: "hc-money-3",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(pool._state.bookings).toHaveLength(0);
  });

  it("scopes myHealthcareBookings to the caller", async () => {
    const router = await loadRouter();
    await scheduleBooking(callerFor(router, CONSUMER_A));

    const mine = await callerFor(router, CONSUMER_A).myHealthcareBookings({});
    expect(mine.bookings).toHaveLength(1);
    expect(mine.bookings[0]).toMatchObject({ id: 1, patientRef: "PAT-001", status: "scheduled" });
    const other = await callerFor(router, CONSUMER_B).myHealthcareBookings({});
    expect(other.bookings).toHaveLength(0);
  });
});
