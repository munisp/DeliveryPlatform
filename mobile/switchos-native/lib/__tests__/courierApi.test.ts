/**
 * P4-N courier API — Node-level wire/logic tests (vitest).
 *
 * Covers: request shaping (offline queue SyncAction), Hermes-safe
 * idempotency keys (CONSUMER_IDEMPOTENCY_KEY_RE pattern), offline-queue
 * payload round-trip, decline-reason enum, error mapping, and the
 * courier_assignments replica mapper. Hooks are not exercised (native
 * modules absent); the bridge target is mocked.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/trpc", () => ({ trpc: {} }));
vi.mock("@/lib/money", async () => await vi.importActual("../money"));
vi.mock("@/lib/consumer", async () => await vi.importActual("../consumer"));

import {
  buildCourierQueuedAction,
  COURIER_DECLINE_REASONS,
  COURIER_IDEMPOTENCY_KEY_RE,
  COURIER_QUEUE_LANE,
  isCourierDeclineReason,
  mapCourierApiError,
  mapCourierReplicaOrderRow,
  newCourierIdempotencyKey,
  parseCourierQueuedPayload,
} from "../courierApi";

describe("courier idempotency keys", () => {
  it("matches the server regex and UUID-v4 shape", () => {
    const key = newCourierIdempotencyKey("coa");
    expect(COURIER_IDEMPOTENCY_KEY_RE.test(key)).toBe(true);
    expect(key).toMatch(
      /^coa-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("is unique across generations (Hermes Math.random path)", () => {
    const keys = new Set(Array.from({ length: 300 }, () => newCourierIdempotencyKey("cod")));
    expect(keys.size).toBe(300);
  });
});

describe("decline reason enum", () => {
  it("mirrors the server 7-value enum", () => {
    expect(COURIER_DECLINE_REASONS).toHaveLength(7);
    expect(isCourierDeclineReason("fare_insufficient")).toBe(true);
    expect(isCourierDeclineReason("bad_weather")).toBe(false);
  });
});

describe("offline queue fallback (driver_delivery lane)", () => {
  const now = new Date("2026-11-12T10:00:00.000Z");

  it("shapes an accept-offer SyncAction with embedded idempotency key", () => {
    const action = buildCourierQueuedAction({
      accountId: "courier:7",
      kind: "courier_accept_offer",
      offerId: "4b0f7b9e-2c1d-4e5f-8a9b-0c1d2e3f4a5b",
      now,
    });
    expect(action.lane).toBe(COURIER_QUEUE_LANE);
    expect(action.lane).toBe("driver_delivery");
    expect(action.type).toBe("courier_accept_offer");
    expect(action.attempts).toBe(0);
    expect(action.createdAt).toBe(now.toISOString());
    const payload = parseCourierQueuedPayload(action.payload);
    expect(payload.offerId).toBe("4b0f7b9e-2c1d-4e5f-8a9b-0c1d2e3f4a5b");
    expect(COURIER_IDEMPOTENCY_KEY_RE.test(payload.idempotencyKey)).toBe(true);
    expect(action.id).toBe(`courier_accept_offer-${payload.idempotencyKey}`);
  });

  it("shapes a decline-offer action with a validated reason", () => {
    const action = buildCourierQueuedAction({
      accountId: "courier:7",
      kind: "courier_decline_offer",
      offerId: "4b0f7b9e-2c1d-4e5f-8a9b-0c1d2e3f4a5b",
      reason: "pickup_distance_unprofitable",
      now,
    });
    const payload = parseCourierQueuedPayload(action.payload);
    expect(payload.kind).toBe("courier_decline_offer");
    expect(payload.reason).toBe("pickup_distance_unprofitable");
  });

  it("rejects decline queueing without a valid reason", () => {
    expect(() =>
      buildCourierQueuedAction({
        accountId: "courier:7",
        kind: "courier_decline_offer",
        offerId: "x",
        reason: "bad_weather" as never,
        now,
      }),
    ).toThrow("courier_decline_reason_required");
  });

  it("parse round-trips and rejects unknown kinds / bad keys", () => {
    const action = buildCourierQueuedAction({
      accountId: "a",
      kind: "courier_accept_offer",
      offerId: "o",
      now,
    });
    expect(parseCourierQueuedPayload(action.payload).kind).toBe("courier_accept_offer");
    expect(() => parseCourierQueuedPayload(JSON.stringify({ kind: "nope" }))).toThrow(
      "courier_queue_unknown_kind",
    );
    expect(() =>
      parseCourierQueuedPayload(
        JSON.stringify({ kind: "courier_accept_offer", idempotencyKey: "bad key!" }),
      ),
    ).toThrow("courier_queue_bad_idempotency_key");
  });
});

describe("error mapping", () => {
  it.each([
    ["driver_not_verified", "driver_not_verified"],
    ["ride_offer_not_acceptable", "offer_not_acceptable"],
    ["ride_trip_not_found", "not_found"],
    ["TRPCError FORBIDDEN: nope", "forbidden"],
    ["CONFLICT: state_version", "conflict"],
    ["Failed to fetch", "offline"],
    ["totally different", "unknown"],
  ])("maps %s -> %s", (message, expected) => {
    expect(mapCourierApiError(new Error(message))).toBe(expected);
  });
});

describe("courier_assignments replica mapper", () => {
  it("maps assigned-order rows (text ids -> number, snake -> camel)", () => {
    const assignment = mapCourierReplicaOrderRow({
      id: "88",
      order_number: "ORD-0088",
      status: "out_for_delivery",
      pickup_address: "12 Broad St",
      delivery_address: "4 Adeola Odeku",
      estimated_delivery_time: "2026-11-12T12:00:00.000Z",
      created_at: "2026-11-12T09:30:00.000Z",
    });
    expect(assignment.orderId).toBe(88);
    expect(assignment.pickupAddress).toBe("12 Broad St");
    expect(assignment.status).toBe("out_for_delivery");
  });
});
