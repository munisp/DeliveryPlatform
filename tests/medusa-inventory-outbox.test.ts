import { describe, expect, it } from "vitest";
import {
  inventoryBackoff,
  inventorySourceEventKey,
  validateInventoryPayload,
  type DeliveryPlatformInventoryPayload,
} from "../services/medusa/commerce-core/src/modules/deliveryplatform-inventory-outbox/service";

const level: DeliveryPlatformInventoryPayload = {
  type: "commerce.inventory.level.snapshot",
  data: {
    inventory_level_id: "ilevel_milk_001",
    stock_location_id: "sloc_warehouse_001",
    inventory_item_id: "iitem_milk_001",
    stocked_quantity: 10,
    reserved_quantity: 3,
    incoming_quantity: 5,
    source_updated_at: "2026-09-08T10:00:00.000Z",
  },
};

const reservation: DeliveryPlatformInventoryPayload = {
  type: "commerce.inventory.reservation.snapshot",
  data: {
    reservation_id: "res_milk_001",
    stock_location_id: "sloc_warehouse_001",
    inventory_item_id: "iitem_milk_001",
    order_id: "order_milk_001",
    quantity: 3,
    state: "active",
    source_updated_at: "2026-09-08T10:01:00.000Z",
  },
};

describe("Medusa inventory durable outbox", () => {
  it("accepts only bounded hydrated inventory snapshots", () => {
    expect(validateInventoryPayload(level)).toEqual(level);
    expect(validateInventoryPayload(reservation)).toEqual(reservation);
    expect(() =>
      validateInventoryPayload({
        ...level,
        data: { ...level.data, stocked_quantity: -1 },
      }),
    ).toThrow("stocked_quantity");
    expect(() =>
      validateInventoryPayload({
        ...reservation,
        data: { ...reservation.data, state: "unknown" as "active" },
      }),
    ).toThrow("reservation state");
  });

  it("derives a stable outbox identity for exact retries while preserving conflicting same-timestamp snapshots", () => {
    expect(inventorySourceEventKey(level)).toEqual(
      inventorySourceEventKey({ ...level, data: { ...level.data } }),
    );
    expect(inventorySourceEventKey(level)).not.toEqual(
      inventorySourceEventKey({
        ...level,
        data: { ...level.data, stocked_quantity: 11 },
      }),
    );
  });

  it("uses deterministic bounded retry delays", () => {
    expect(inventoryBackoff(1, "event-a")).toBe(inventoryBackoff(1, "event-a"));
    expect(inventoryBackoff(1, "event-a")).toBeGreaterThanOrEqual(1_000);
    expect(inventoryBackoff(16, "event-a")).toBeLessThanOrEqual(300_999);
    expect(inventoryBackoff(40, "event-a")).toBe(
      inventoryBackoff(16, "event-a"),
    );
  });
});
