import type { MedusaContainer } from "@medusajs/framework/types";
import { DELIVERYPLATFORM_INVENTORY_OUTBOX_MODULE } from "../modules/deliveryplatform-inventory-outbox";
import type DeliveryPlatformInventoryOutboxService from "../modules/deliveryplatform-inventory-outbox/service";

type Logger = {
  info(message: string): void;
  warn(message: string): void;
};

export default async function deliverDeliveryPlatformInventoryOutbox(
  container: MedusaContainer,
) {
  const logger = container.resolve("logger") as Logger;
  if ((process.env.MEDUSA_PROCESS_ROLE || "").trim().toLowerCase() !== "inventory-dispatcher") {
    logger.info("DeliveryPlatform inventory outbox delivery is owned by the dedicated inventory-dispatcher process");
    return;
  }
  const outbox = container.resolve(
    DELIVERYPLATFORM_INVENTORY_OUTBOX_MODULE,
  ) as DeliveryPlatformInventoryOutboxService;
  const result = await outbox.deliverPending();
  if (result.claimed > 0) {
    logger.info(
      `DeliveryPlatform inventory outbox claimed=${result.claimed} delivered=${result.delivered} failed=${result.failed} stale=${result.stale}`,
    );
  }
  if (result.failed > 0) {
    logger.warn(
      `DeliveryPlatform inventory outbox deferred ${result.failed} delivery attempt(s)`,
    );
  }
}

export const config = {
  name: "deliver-deliveryplatform-inventory-outbox",
  schedule: "* * * * *",
};
