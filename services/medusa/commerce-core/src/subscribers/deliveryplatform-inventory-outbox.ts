import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { DELIVERYPLATFORM_INVENTORY_OUTBOX_MODULE } from "../modules/deliveryplatform-inventory-outbox";
import type DeliveryPlatformInventoryOutboxService from "../modules/deliveryplatform-inventory-outbox/service";

type InventoryLevelEvent = { id?: string; order_id?: string };
type ReservationEvent = { id?: string; order_id?: string };

type QueryGraph = {
  graph(input: {
    entity: "inventory_level" | "reservation_item";
    fields: string[];
    filters: { id: string };
    withDeleted?: boolean;
  }): Promise<{ data: unknown[] }>;
};

type HydratedInventoryLevel = {
  id?: unknown;
  location_id?: unknown;
  inventory_item_id?: unknown;
  stocked_quantity?: unknown;
  reserved_quantity?: unknown;
  incoming_quantity?: unknown;
  updated_at?: unknown;
};

type HydratedReservation = {
  id?: unknown;
  location_id?: unknown;
  inventory_item_id?: unknown;
  quantity?: unknown;
  updated_at?: unknown;
};

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;

function boundedId(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new Error(`${label} must be a bounded Medusa identifier`);
  }
  return value;
}

function finiteQuantity(
  value: unknown,
  label: string,
  allowZero: boolean,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (allowZero ? value < 0 : value <= 0)
  ) {
    throw new Error(
      `${label} must be a ${allowZero ? "non-negative" : "positive"} finite number`,
    );
  }
  return value;
}

function sourceTimestamp(value: unknown): string {
  const date =
    value instanceof Date
      ? value
      : typeof value === "string"
        ? new Date(value)
        : null;
  if (!date || Number.isNaN(date.valueOf()))
    throw new Error("Medusa source record lacks a valid updated_at timestamp");
  return date.toISOString();
}

async function one<T>(
  query: QueryGraph,
  entity: "inventory_level" | "reservation_item",
  id: string,
  fields: string[],
  withDeleted = false,
): Promise<T> {
  const response = await query.graph({
    entity,
    fields,
    filters: { id },
    ...(withDeleted ? { withDeleted: true } : {}),
  });
  if (response.data.length !== 1)
    throw new Error(`${entity} ${id} could not be hydrated`);
  return response.data[0] as T;
}

async function hydrateInventoryLevel(query: QueryGraph, id: string) {
  const level = await one<HydratedInventoryLevel>(
    query,
    "inventory_level",
    id,
    [
      "id",
      "location_id",
      "inventory_item_id",
      "stocked_quantity",
      "reserved_quantity",
      "incoming_quantity",
      "updated_at",
    ],
  );
  return {
    inventory_level_id: boundedId(level.id, "inventory_level_id"),
    stock_location_id: boundedId(level.location_id, "stock_location_id"),
    inventory_item_id: boundedId(level.inventory_item_id, "inventory_item_id"),
    stocked_quantity: finiteQuantity(
      level.stocked_quantity,
      "stocked_quantity",
      true,
    ),
    reserved_quantity: finiteQuantity(
      level.reserved_quantity,
      "reserved_quantity",
      true,
    ),
    incoming_quantity: finiteQuantity(
      level.incoming_quantity,
      "incoming_quantity",
      true,
    ),
    source_updated_at: sourceTimestamp(level.updated_at),
  };
}

async function hydrateReservation(
  query: QueryGraph,
  id: string,
  orderId: unknown,
) {
  const reservation = await one<HydratedReservation>(
    query,
    "reservation_item",
    id,
    ["id", "location_id", "inventory_item_id", "quantity", "updated_at"],
  );
  return {
    reservation_id: boundedId(reservation.id, "reservation_id"),
    stock_location_id: boundedId(reservation.location_id, "stock_location_id"),
    inventory_item_id: boundedId(
      reservation.inventory_item_id,
      "inventory_item_id",
    ),
    order_id:
      orderId === undefined || orderId === null
        ? null
        : boundedId(orderId, "order_id"),
    quantity: finiteQuantity(reservation.quantity, "quantity", false),
    state: "active" as const,
    source_updated_at: sourceTimestamp(reservation.updated_at),
  };
}

export default async function deliveryPlatformInventoryOutboxSubscriber({
  event: { name, data },
  container,
}: SubscriberArgs<InventoryLevelEvent | ReservationEvent>) {
  const query = container.resolve(
    ContainerRegistrationKeys.QUERY,
  ) as QueryGraph;
  const outbox = container.resolve(
    DELIVERYPLATFORM_INVENTORY_OUTBOX_MODULE,
  ) as DeliveryPlatformInventoryOutboxService;
  const sourceId = boundedId(data.id, "event.id");

  switch (name) {
    case "inventory-level.created":
    case "inventory-level.updated": {
      const snapshot = await hydrateInventoryLevel(query, sourceId);
      await outbox.enqueue({
        type: "commerce.inventory.level.snapshot",
        data: snapshot,
      });
      return;
    }
    case "inventory-level.deleted": {
      const deleted = await one<HydratedInventoryLevel>(
        query,
        "inventory_level",
        sourceId,
        ["id", "location_id", "inventory_item_id", "updated_at"],
        true,
      );
      await outbox.enqueue({
        type: "commerce.inventory.level.snapshot",
        data: {
          inventory_level_id: boundedId(deleted.id, "inventory_level_id"),
          stock_location_id: boundedId(
            deleted.location_id,
            "stock_location_id",
          ),
          inventory_item_id: boundedId(
            deleted.inventory_item_id,
            "inventory_item_id",
          ),
          stocked_quantity: 0,
          reserved_quantity: 0,
          incoming_quantity: 0,
          source_updated_at: sourceTimestamp(deleted.updated_at),
        },
      });
      return;
    }
    case "reservation-item.created":
    case "reservation-item.updated": {
      const snapshot = await hydrateReservation(query, sourceId, data.order_id);
      await outbox.enqueue({
        type: "commerce.inventory.reservation.snapshot",
        data: snapshot,
      });
      return;
    }
    case "reservation-item.deleted": {
      const deleted = await one<HydratedReservation>(
        query,
        "reservation_item",
        sourceId,
        ["id", "updated_at"],
        true,
      );
      await outbox.enqueueReleasedReservation(
        boundedId(deleted.id, "reservation_id"),
        sourceTimestamp(deleted.updated_at),
      );
      return;
    }
    default:
      return;
  }
}

export const config: SubscriberConfig = {
  event: [
    "inventory-level.created",
    "inventory-level.updated",
    "inventory-level.deleted",
    "reservation-item.created",
    "reservation-item.updated",
    "reservation-item.deleted",
  ],
};
