import { describe, expect, it } from "vitest";
import { trackingStateForTest } from "../client/src/lib/useRoleScopedTracking";

const first = {
  cursor: 10,
  orderId: 42,
  observedAt: "2026-09-10T10:00:00.000Z",
  latitude: 6.5244,
  longitude: 3.3792,
  accuracyM: 8,
  etaSeconds: 600,
};

describe("role-scoped tracking client", () => {
  it("rejects malformed and out-of-range cursor payloads", () => {
    expect(trackingStateForTest.parseTrackingPayload({ cursor: -1, deltas: [] })).toBeNull();
    expect(
      trackingStateForTest.parseTrackingPayload({
        cursor: 1,
        deltas: [{ ...first, latitude: 91 }],
      }),
    ).toEqual({ cursor: 1, deltas: [] });
  });

  it("classifies tracking freshness without trusting future or invalid timestamps", () => {
    const now = Date.parse("2026-09-10T10:02:00.000Z");
    expect(trackingStateForTest.freshnessFor("2026-09-10T10:01:45.000Z", now)).toBe("fresh");
    expect(trackingStateForTest.freshnessFor("2026-09-10T10:01:10.000Z", now)).toBe("aging");
    expect(trackingStateForTest.freshnessFor("2026-09-10T09:59:00.000Z", now)).toBe("stale");
    expect(trackingStateForTest.freshnessFor("not-a-date", now)).toBe("unknown");
  });

  it("bounds reconnect delay even when jitter is applied", () => {
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      const delay = trackingStateForTest.reconnectDelay(attempt);
      expect(delay).toBeGreaterThanOrEqual(1_000);
      expect(delay).toBeLessThanOrEqual(15_000);
    }
  });

  it("keeps only the newest delta for an authorized order and bounds rendered state", () => {
    const reconciled = trackingStateForTest.applyDeltas(
      [first],
      [
        { ...first, cursor: 12, observedAt: "2026-09-10T10:00:03.000Z", etaSeconds: 540 },
        { ...first, orderId: 43, cursor: 11, observedAt: "2026-09-10T10:00:02.000Z" },
      ],
    );

    expect(reconciled).toHaveLength(2);
    expect(reconciled[0]).toMatchObject({ orderId: 42, cursor: 12, etaSeconds: 540 });
    expect(reconciled[1]).toMatchObject({ orderId: 43, cursor: 11 });
  });
});
