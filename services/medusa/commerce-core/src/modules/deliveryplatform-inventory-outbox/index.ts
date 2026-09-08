import { Module } from "@medusajs/framework/utils";
import DeliveryPlatformInventoryOutboxService from "./service";

export const DELIVERYPLATFORM_INVENTORY_OUTBOX_MODULE =
  "deliveryplatformInventoryOutboxService";

export default Module(DELIVERYPLATFORM_INVENTORY_OUTBOX_MODULE, {
  service: DeliveryPlatformInventoryOutboxService,
});
