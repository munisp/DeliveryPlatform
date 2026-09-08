import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/_core/auth", () => ({
  getSessionToken: vi.fn(),
}));

import { getSessionToken } from "@/lib/_core/auth";
import {
  calculateVehicleBounds,
  loadDurableVehiclePositions,
  vehicleIntegrityTone,
} from "../lib/mobile/vehicle-tracking";

const validPosition = {
  work_order_id: "order-001",
  external_reference: "CAR-001",
  subject_user_id: 27,
  observed_at: "2026-09-08T01:00:00.000Z",
  longitude: 3.3792,
  latitude: 6.5244,
  accuracy_m: 8,
  integrity_score: 92,
  source: "telematics",
};

describe("loadDurableVehiclePositions", () => {
  beforeEach(() => {
    vi.mocked(getSessionToken).mockResolvedValue("verified-session-token");
  });

  it("uses the authenticated central operations snapshot and discards malformed positions", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue(
        JSON.stringify({
          positions: [
            validPosition,
            { ...validPosition, work_order_id: "order-invalid", latitude: 101 },
          ],
        }),
      ),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const positions = await loadDurableVehiclePositions(
      "https://platform.example.test/",
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://platform.example.test/api/operations/snapshot",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer verified-session-token",
          accept: "application/json",
        }),
      }),
    );
    expect(positions).toEqual([
      expect.objectContaining({
        workOrderId: "order-001",
        longitude: 3.3792,
        latitude: 6.5244,
      }),
    ]);
  });

  it("fails closed when the central platform endpoint has not been configured", async () => {
    await expect(loadDurableVehiclePositions("  ")).rejects.toThrow(
      "Configure the authenticated central Platform API URL",
    );
  });
});

describe("vehicle map bounds and integrity display", () => {
  it("expands a single durable position into a usable native map bounding box", () => {
    const bounds = calculateVehicleBounds([
      {
        workOrderId: "order-001",
        externalReference: "CAR-001",
        subjectUserId: 27,
        observedAt: "2026-09-08T01:00:00.000Z",
        longitude: 3.3792,
        latitude: 6.5244,
        accuracyM: 8,
        integrityScore: 92,
        source: "telematics",
      },
    ]);

    expect(bounds).not.toBeNull();
    expect(bounds?.[0]).toBeCloseTo(3.3752, 8);
    expect(bounds?.[1]).toBeCloseTo(6.5204, 8);
    expect(bounds?.[2]).toBeCloseTo(3.3832, 8);
    expect(bounds?.[3]).toBeCloseTo(6.5284, 8);
    expect(vehicleIntegrityTone(92)).toBe("#22C55E");
    expect(vehicleIntegrityTone(65)).toBe("#F59E0B");
    expect(vehicleIntegrityTone(20)).toBe("#EF4444");
  });
});
