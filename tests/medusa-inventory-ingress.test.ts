import { describe, expect, it } from "vitest";
import {
  MedusaCommerceError,
  parseInventoryLevelSnapshot,
  parseReservationSnapshot,
} from "../server/_core/medusaCommerce";

const levelPayload = {
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

const reservationPayload = {
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

describe("hydrated Medusa inventory ingress", () => {
  it("accepts only complete bounded level and reservation snapshots", () => {
    expect(parseInventoryLevelSnapshot(levelPayload)).toEqual(
      levelPayload.data,
    );
    expect(parseReservationSnapshot(reservationPayload)).toEqual(
      reservationPayload.data,
    );
  });

  it("rejects a header/payload type mismatch and invalid financial quantity", () => {
    expect(() => parseInventoryLevelSnapshot(reservationPayload)).toThrow(
      MedusaCommerceError,
    );
    expect(() =>
      parseReservationSnapshot({
        ...reservationPayload,
        data: { ...reservationPayload.data, quantity: 0 },
      }),
    ).toThrow("quantity");
  });

  it("rejects malformed identifiers and invalid source timestamps", () => {
    expect(() =>
      parseInventoryLevelSnapshot({
        ...levelPayload,
        data: { ...levelPayload.data, inventory_item_id: "invalid id" },
      }),
    ).toThrow("item_id");
    expect(() =>
      parseReservationSnapshot({
        ...reservationPayload,
        data: { ...reservationPayload.data, source_updated_at: "not-a-date" },
      }),
    ).toThrow("source_updated_at");
  });
});
