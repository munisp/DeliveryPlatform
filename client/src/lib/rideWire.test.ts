import { describe, expect, it } from "vitest";

import {
  formatRideFare,
  generateRideActionKey,
  isRideTerminalState,
  normalizeRideQuote,
  normalizeRideTripDetail,
  normalizeRideTrips,
  rideStateLabel,
} from "./rideWire";

const CONSUMER_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

describe("rideWire normalizers", () => {
  it("normalizes snake_case trip lists and drops malformed rows", () => {
    const trips = normalizeRideTrips([
      {
        trip_id: "t1",
        state: "requested",
        pickup_address: "A",
        destination_address: "B",
        requested_at: "2026-01-01T00:00:00Z",
      },
      { trip_id: "t2" }, // missing state -> dropped
      "garbage",
      null,
    ]);
    expect(trips).toHaveLength(1);
    expect(trips[0].tripId).toBe("t1");
    expect(trips[0].isTerminal).toBe(false);
  });

  it("normalizes detail payloads with camelCase tolerance", () => {
    const detail = normalizeRideTripDetail({
      trip: {
        tripId: "t1",
        state: "completed",
        pickupAddress: "A",
        destinationAddress: "B",
        assignedDriverUserId: 7,
      },
      quote: {
        quoteId: "q1",
        baseKobo: "50000",
        distanceKobo: "250000",
        timeKobo: "45000",
        demandKobo: "0",
        taxesAndFeesKobo: "0",
        totalKobo: "345000",
        quotedDistanceM: 10000,
        quotedDurationS: 1800,
      },
      events: [
        {
          id: "e1",
          sequenceNo: 1,
          eventType: "trip.requested",
          actorKind: "rider",
          nextState: "requested",
          occurredAt: "2026-01-01T00:00:00Z",
        },
      ],
      paymentReference: "rp-t1",
    });
    expect(detail).not.toBeNull();
    expect(detail?.trip.assignedDriverUserId).toBe(7);
    expect(detail?.quote?.totalKobo).toBe("345000");
    expect(detail?.events).toHaveLength(1);
    expect(detail?.paymentReference).toBe("rp-t1");
  });

  it("returns null for detail payloads without a trip", () => {
    expect(normalizeRideTripDetail({ quote: null })).toBeNull();
    expect(normalizeRideQuote({ totalKobo: "not-a-number" })).toBeNull();
  });
});

describe("fare formatting + states", () => {
  it("formats minor kobo as exact ₦", () => {
    expect(formatRideFare("150000")).toBe("₦1,500.00");
    expect(formatRideFare("24975")).toBe("₦249.75");
  });

  it("labels and terminal states", () => {
    expect(rideStateLabel("completed_pending_payment")).toBe(
      "Completing payment",
    );
    expect(isRideTerminalState("completed")).toBe(true);
    expect(isRideTerminalState("in_progress")).toBe(false);
  });

  it("generates spec-conformant unique action keys", () => {
    const a = generateRideActionKey("complete", "trip-1");
    const b = generateRideActionKey("complete", "trip-1");
    expect(a).toMatch(CONSUMER_KEY_RE);
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(128);
  });
});
