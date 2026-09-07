import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import { createHmac, randomUUID } from "crypto";

type OrderPayload = { id?: string; status?: string; fulfillment_status?: string; updated_at?: string };

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function forward(eventType: string, payload: OrderPayload) {
  const orderId = `${payload.id ?? ""}`.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/.test(orderId)) throw new Error("Medusa event lacks a bounded order identifier");
  const eventId = `medusa-${randomUUID()}`;
  const body = JSON.stringify({ order_id: orderId, data: { id: orderId, status: payload.status ?? null, fulfillment_status: payload.fulfillment_status ?? null, updated_at: payload.updated_at ?? null } });
  const secret = required("DELIVERYPLATFORM_MEDUSA_WEBHOOK_SECRET");
  const response = await fetch(required("DELIVERYPLATFORM_MEDUSA_INGRESS_URL"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Medusa-Store-Id": required("MEDUSA_STORE_ID"),
      "X-Medusa-Event-Id": eventId,
      "X-Medusa-Event-Type": eventType,
      "X-Medusa-Signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 202) throw new Error(`DeliveryPlatform event ingress rejected ${eventType} with HTTP ${response.status}`);
}

export default async function deliveryplatformCommerceSubscriber({ event: { name, data } }: SubscriberArgs<OrderPayload>) {
  const eventType = name === "order.placed" ? "commerce.order.placed" : name === "order.canceled" ? "commerce.order.cancelled" : name === "order.fulfillment_created" ? "commerce.fulfillment.ready" : name === "order.fulfillment_delivered" ? "commerce.fulfillment.delivered" : null;
  if (!eventType) return;
  await forward(eventType, data);
}

export const config: SubscriberConfig = {
  event: ["order.placed", "order.canceled", "order.fulfillment_created", "order.fulfillment_delivered"],
};
