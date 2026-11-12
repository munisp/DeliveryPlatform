import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P3-R consumer ride-hailing tests. Pool-boundary mocks only: SQL is
 * intercepted by regex handlers and all quote/state math is asserted
 * against the real module code (integer kobo, no floats).
 */

type QueryCall = { text: string; values: unknown[] };
type Handler = {
  pattern: RegExp;
  respond: (text: string, values: unknown[]) => unknown[];
};

const mocks = vi.hoisted(() => {
  const state = {
    handlers: [] as Handler[],
    calls: [] as QueryCall[],
    getVerifiedDriverAccess: vi.fn(),
  };
  return { state };
});

function routeQuery(text: string, values: unknown[] = []) {
  mocks.state.calls.push({ text, values });
  for (const handler of mocks.state.handlers) {
    if (handler.pattern.test(text)) {
      return { rows: handler.respond(text, values), rowCount: 1 };
    }
  }
  return { rows: [], rowCount: 0 };
}

vi.mock("../server/db", () => ({
  getPool: vi.fn(async () => ({
    query: (text: string, values?: unknown[]) => routeQuery(text, values),
    connect: async () => ({
      query: (text: string, values?: unknown[]) => routeQuery(text, values),
      release: () => undefined,
    }),
  })),
}));

vi.mock("../server/_core/driverOnboarding", () => ({
  getVerifiedDriverAccess: mocks.state.getVerifiedDriverAccess,
}));

// Router assembly is not under test here — stub the trpc builder to keep the
// harness free of the policy/hotCache import chain.
vi.mock("../server/_core/trpc", () => {
  const procedure: any = {
    input: () => procedure,
    query: () => ({}),
    mutation: () => ({}),
  };
  return {
    router: (routes: unknown) => routes,
    authenticatedProcedure: procedure,
  };
});

import {
  acceptRideOffer,
  assertRideTransition,
  computeRideQuoteAmounts,
  estimateRideDurationSeconds,
  haversineDistanceMeters,
  rateTrip,
  requestRide,
  transitionRide,
  type RideFareRule,
} from "../server/_core/consumerRide";

const RULE: RideFareRule = {
  fareRuleId: "11111111-1111-1111-1111-111111111111",
  baseKobo: 50000n,
  perKmKobo: 25000n,
  perMinuteKobo: 1500n,
  minimumKobo: 150000n,
  cancellationKobo: 0n,
  demandCapBasisPoints: 15000,
};

const REQUEST_INPUT = {
  consumerUserId: 42,
  pickupLat: 6.5244,
  pickupLng: 3.3792,
  pickupAddress: "1 Marina Road, Lagos Island",
  destinationLat: 6.6018,
  destinationLng: 3.3515,
  destinationAddress: "2 Allen Avenue, Ikeja",
  idempotencyKey: "rq-test-key-0001",
};

function resetState() {
  mocks.state.handlers.length = 0;
  mocks.state.calls.length = 0;
  mocks.state.getVerifiedDriverAccess.mockReset();
}

function callsMatching(pattern: RegExp): QueryCall[] {
  return mocks.state.calls.filter((call) => pattern.test(call.text));
}

describe("computeRideQuoteAmounts (integer kobo)", () => {
  it("satisfies the fare_quote CHECK: total = base+distance+time+demand+taxes", () => {
    const amounts = computeRideQuoteAmounts(RULE, 12_345, 1_800, 12_000);
    expect(amounts.totalKobo).toBe(
      amounts.baseKobo +
        amounts.distanceKobo +
        amounts.timeKobo +
        amounts.demandKobo +
        amounts.taxesAndFeesKobo,
    );
  });

  it("uses integer floor division (no float rounding up)", () => {
    const amounts = computeRideQuoteAmounts(RULE, 999, 61);
    // distance: 25000 * 999 / 1000 = 24975 (floor, not 25000)
    expect(amounts.distanceKobo).toBe(24975n);
    // time: 1500 * 61 / 60 = 1525 (floor, not 1525.5)
    expect(amounts.timeKobo).toBe(1525n);
  });

  it("itemises the minimum-fare uplift into taxes_and_fees_kobo", () => {
    const amounts = computeRideQuoteAmounts(RULE, 100, 60);
    // base 50000 + distance 2500 + time 1500 = 54000 < minimum 150000
    expect(amounts.taxesAndFeesKobo).toBe(96000n);
    expect(amounts.totalKobo).toBe(150000n);
  });

  it("clamps demand at the zone cap and defaults to zero demand", () => {
    const capped = computeRideQuoteAmounts(RULE, 10_000, 600, 999_999);
    const zeroDemand = computeRideQuoteAmounts(RULE, 10_000, 600);
    expect(zeroDemand.demandKobo).toBe(0n);
    const subtotal = capped.baseKobo + capped.distanceKobo + capped.timeKobo;
    expect(capped.demandKobo).toBe((subtotal * 15000n) / 10000n);
  });
});

describe("distance / duration estimates", () => {
  it("computes haversine distance in integer meters", () => {
    const meters = haversineDistanceMeters(6.5244, 3.3792, 6.6018, 3.3515);
    expect(Number.isInteger(meters)).toBe(true);
    expect(meters).toBeGreaterThan(8_000);
    expect(meters).toBeLessThan(12_000);
  });

  it("enforces a 60s minimum duration", () => {
    expect(estimateRideDurationSeconds(0)).toBe(60);
    expect(estimateRideDurationSeconds(8_000)).toBe(1_000);
  });
});

describe("assertRideTransition", () => {
  it("allows rider cancel pre-pickup and complete from in_progress", () => {
    expect(() => assertRideTransition("cancel", "requested")).not.toThrow();
    expect(() => assertRideTransition("cancel", "driver_reserved")).not.toThrow();
    expect(() => assertRideTransition("complete", "in_progress")).not.toThrow();
  });

  it("rejects invalid edges and terminal states", () => {
    expect(() => assertRideTransition("complete", "requested")).toThrow(
      /ride_transition_invalid/,
    );
    expect(() => assertRideTransition("cancel", "in_progress")).toThrow(
      /ride_transition_invalid/,
    );
    expect(() => assertRideTransition("cancel", "completed")).toThrow(
      /ride_trip_terminal/,
    );
    expect(() => assertRideTransition("complete", "cancelled")).toThrow(
      /ride_trip_terminal/,
    );
  });
});

describe("requestRide", () => {
  beforeEach(resetState);

  it("replays an already-processed idempotency key without inserts", async () => {
    mocks.state.handlers.push(
      {
        pattern: /FROM public\.consumer_processed_events/,
        respond: () => [
          {
            result_json: {
              tripId: "22222222-2222-2222-2222-222222222222",
            },
          },
        ],
      },
      {
        pattern: /FROM mobility\.ride_trip WHERE id = \$1/,
        respond: () => [
          { id: "22222222-2222-2222-2222-222222222222", state: "requested" },
        ],
      },
      {
        pattern: /JOIN mobility\.fare_quote/,
        respond: () => [{ total_kobo: "150000" }],
      },
    );
    const result = await requestRide(REQUEST_INPUT);
    expect(result.replayed).toBe(true);
    expect(result.tripId).toBe("22222222-2222-2222-2222-222222222222");
    expect(result.totalKobo).toBe("150000");
    expect(callsMatching(/INSERT INTO mobility\.ride_trip/)).toHaveLength(0);
  });

  it("fails closed outside a LAG dispatch zone", async () => {
    // No handlers -> zone lookup returns zero rows.
    await expect(requestRide(REQUEST_INPUT)).rejects.toThrow(
      /ride_zone_unavailable/,
    );
    expect(callsMatching(/INSERT INTO mobility\.fare_quote/)).toHaveLength(0);
  });

  it("inserts quote, trip, mirror, event and dedupe record in one tx", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.state.handlers.push(
      {
        pattern: /FROM mobility\.service_zone/,
        respond: () => [
          {
            zone_id: "33333333-3333-3333-3333-333333333333",
            zone_code: "LAG-ISLAND",
            display_name: "Lagos Island",
            fare_rule_id: RULE.fareRuleId,
            base_kobo: "50000",
            per_km_kobo: "25000",
            per_minute_kobo: "1500",
            minimum_kobo: "150000",
            cancellation_kobo: "0",
            demand_cap_basis_points: 15000,
          },
        ],
      },
      {
        pattern: /INSERT INTO mobility\.fare_quote/,
        respond: () => [{ id: "44444444-4444-4444-4444-444444444444" }],
      },
      {
        pattern: /INSERT INTO mobility\.ride_trip/,
        respond: () => [{ id: "55555555-5555-5555-5555-555555555555" }],
      },
    );
    const result = await requestRide(REQUEST_INPUT);
    expect(result.replayed).toBe(false);
    expect(result.state).toBe("requested");
    expect(result.tripId).toBe("55555555-5555-5555-5555-555555555555");
    // mirror + event + dedupe record + transaction markers
    expect(callsMatching(/INSERT INTO public\.rider_trips/)).toHaveLength(1);
    expect(callsMatching(/INSERT INTO mobility\.trip_event/)).toHaveLength(1);
    expect(
      callsMatching(/INSERT INTO public\.consumer_processed_events/),
    ).toHaveLength(1);
    expect(callsMatching(/^BEGIN$/)).toHaveLength(1);
    expect(callsMatching(/^COMMIT$/)).toHaveLength(1);
    // matching worker URL unset -> fail-closed warn-once, no dispatch
    expect(result.matchingDispatched).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // Second request warns no further (warn-once module flag).
    await requestRide({ ...REQUEST_INPUT, idempotencyKey: "rq-test-key-0002" });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});

const TRIP_ROW = {
  id: "66666666-6666-6666-6666-666666666666",
  rider_user_id: 42,
  state: "in_progress",
  zone_id: "33333333-3333-3333-3333-333333333333",
  fare_quote_id: "44444444-4444-4444-4444-444444444444",
  pickup_address: "1 Marina Road",
  destination_address: "2 Allen Avenue",
  assigned_driver_user_id: 7,
  requested_at: "2026-01-01T00:00:00Z",
  started_at: "2026-01-01T00:05:00Z",
  completed_at: null,
  cancellation_actor: null,
  cancellation_code: null,
  state_version: "3",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

describe("transitionRide", () => {
  beforeEach(resetState);

  it("cancels from a cancellable state and updates the mirror", async () => {
    mocks.state.handlers.push({
      pattern: /FROM mobility\.ride_trip\s+WHERE id = \$1 AND rider_user_id = \$2\s+FOR UPDATE/,
      respond: () => [{ ...TRIP_ROW, state: "requested" }],
    });
    const result = await transitionRide({
      tripId: TRIP_ROW.id,
      action: "cancel",
      cancellationCode: "changed_plans",
      idempotencyKey: "rq-cancel-key-01",
      consumerUserId: 42,
    });
    expect(result.state).toBe("cancelled");
    expect(result.replayed).toBe(false);
    const update = callsMatching(/UPDATE mobility\.ride_trip/);
    expect(update).toHaveLength(1);
    expect(update[0].values[2]).toBe("changed_plans");
    expect(callsMatching(/UPDATE public\.rider_trips/)).toHaveLength(1);
  });

  it("completes: runs mojaloop with deterministic rq-/rt-/rp- ids", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);
    mocks.state.handlers.push(
      {
        pattern: /FROM mobility\.ride_trip\s+WHERE id = \$1 AND rider_user_id = \$2\s+FOR UPDATE/,
        respond: () => [{ ...TRIP_ROW }],
      },
      {
        pattern: /SELECT total_kobo FROM mobility\.fare_quote/,
        respond: () => [{ total_kobo: "150000" }],
      },
    );
    const result = await transitionRide({
      tripId: TRIP_ROW.id,
      action: "complete",
      idempotencyKey: "rq-complete-key1",
      consumerUserId: 42,
    });
    expect(result.state).toBe("completed_pending_payment");
    expect(result.paymentReference).toBe(`rp-${TRIP_ROW.id}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { body: string; headers: Record<string, string> },
    ];
    expect(url).toContain("/payments");
    expect(init.headers["X-Internal-Service-Token"]).toBeDefined();
    const body = JSON.parse(init.body);
    expect(body.quoteId).toBe(`rq-${TRIP_ROW.id}`);
    expect(body.transferId).toBe(`rt-${TRIP_ROW.id}`);
    expect(body.paymentReference).toBe(`rp-${TRIP_ROW.id}`);
    expect(body.amountMinor).toBe("150000");
    // crash-window guard: dedupe record written AFTER successful initiation
    expect(
      callsMatching(/INSERT INTO public\.consumer_processed_events/),
    ).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it("replays a completed trip without re-initiating payment", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mocks.state.handlers.push(
      {
        pattern: /FOR UPDATE/,
        respond: () => [{ ...TRIP_ROW, state: "completed" }],
      },
      {
        pattern: /FROM public\.consumer_processed_events/,
        respond: () => [
          { result_json: { paymentReference: `rp-${TRIP_ROW.id}` } },
        ],
      },
    );
    const result = await transitionRide({
      tripId: TRIP_ROW.id,
      action: "complete",
      idempotencyKey: "rq-complete-key1",
      consumerUserId: 42,
    });
    expect(result.replayed).toBe(true);
    expect(result.paymentReference).toBe(`rp-${TRIP_ROW.id}`);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("surfaces payment_initiation_failed and leaves no dedupe record", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, text: async () => "boom" })),
    );
    mocks.state.handlers.push(
      {
        pattern: /FOR UPDATE/,
        respond: () => [{ ...TRIP_ROW }],
      },
      {
        pattern: /SELECT total_kobo FROM mobility\.fare_quote/,
        respond: () => [{ total_kobo: "150000" }],
      },
    );
    await expect(
      transitionRide({
        tripId: TRIP_ROW.id,
        action: "complete",
        idempotencyKey: "rq-complete-key1",
        consumerUserId: 42,
      }),
    ).rejects.toThrow(/payment_initiation_failed/);
    expect(
      callsMatching(/INSERT INTO public\.consumer_processed_events/),
    ).toHaveLength(0);
    vi.unstubAllGlobals();
  });
});

describe("rateTrip", () => {
  beforeEach(resetState);

  it("replays by (author, key) before hitting the SQL function", async () => {
    mocks.state.handlers.push({
      pattern: /FROM mobility\.trip_feedback/,
      respond: () => [{ id: "77777777-7777-7777-7777-777777777777" }],
    });
    const result = await rateTrip({
      tripId: TRIP_ROW.id,
      score: 5,
      tags: ["smooth"],
      idempotencyKey: "rq-rate-key-0001",
      consumerUserId: 42,
    });
    expect(result.replayed).toBe(true);
    expect(callsMatching(/submit_trip_feedback/)).toHaveLength(0);
  });

  it("maps 23505 to trip_already_rated", async () => {
    mocks.state.handlers.push({
      pattern: /submit_trip_feedback/,
      respond: () => {
        const error = new Error("duplicate key") as Error & { code?: string };
        error.code = "23505";
        throw error;
      },
    });
    await expect(
      rateTrip({
        tripId: TRIP_ROW.id,
        score: 4,
        tags: [],
        idempotencyKey: "rq-rate-key-0002",
        consumerUserId: 42,
      }),
    ).rejects.toThrow(/trip_already_rated/);
  });
});

describe("acceptRideOffer", () => {
  beforeEach(resetState);

  it("fails closed for unverified drivers", async () => {
    mocks.state.getVerifiedDriverAccess.mockResolvedValue(null);
    await expect(
      acceptRideOffer({
        offerId: "88888888-8888-8888-8888-888888888888",
        idempotencyKey: "rq-accept-key-01",
        driverUserId: 7,
      }),
    ).rejects.toThrow(/driver_not_verified/);
    expect(callsMatching(/accept_driver_offer/)).toHaveLength(0);
  });

  it("delegates to mobility.accept_driver_offer for verified drivers", async () => {
    mocks.state.getVerifiedDriverAccess.mockResolvedValue({
      applicationId: 1,
      verificationCaseId: 2,
    });
    mocks.state.handlers.push({
      pattern: /FROM mobility\.accept_driver_offer/,
      respond: () => [
        {
          trip_id: TRIP_ROW.id,
          driver_user_id: 7,
          new_trip_state: "driver_reserved",
        },
      ],
    });
    const result = await acceptRideOffer({
      offerId: "88888888-8888-8888-8888-888888888888",
      idempotencyKey: "rq-accept-key-01",
      driverUserId: 7,
    });
    expect(result.tripId).toBe(TRIP_ROW.id);
    expect(result.state).toBe("driver_reserved");
  });
});
