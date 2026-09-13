import { createHmac, timingSafeEqual } from "crypto";
import { Pool } from "pg";
import { ENV } from "./env";

type FulfillmentAction =
  | "accept"
  | "assign"
  | "dispatch"
  | "deliver"
  | "cancel"
  | "fail";
let pool: Pool | null = null;

function database() {
  if (!ENV.databaseUrl)
    throw new Error("commerce_fulfillment_database_unconfigured");
  if (!pool)
    pool = new Pool({
      connectionString: ENV.databaseUrl,
      ssl:
        ENV.isProduction && !ENV.databaseUrl.includes("sslmode=disable")
          ? {
              rejectUnauthorized: true,
              ...(ENV.databaseSslCa ? { ca: ENV.databaseSslCa } : {}),
            }
          : false,
      max: 6,
    });
  return pool;
}

export async function listCommerceFulfillmentRequests(input: {
  actorUserId: number;
  limit?: number;
}) {
  const result = await database().query<{
    id: string;
    provider_id: number;
    medusa_order_id: string;
    state: string;
    delivery_order_id: number | null;
    delivery_reference: string | null;
    requested_at: string;
    updated_at: string;
    failure_reason: string | null;
  }>(`SELECT * FROM commerce.list_fulfillment_requests($1,$2)`, [
    input.actorUserId,
    input.limit ?? 50,
  ]);
  return result.rows.map((row) => ({
    id: row.id,
    providerId: Number(row.provider_id),
    medusaOrderId: row.medusa_order_id,
    state: row.state,
    deliveryOrderId: row.delivery_order_id,
    deliveryReference: row.delivery_reference,
    requestedAt: row.requested_at,
    updatedAt: row.updated_at,
    failureReason: row.failure_reason,
  }));
}

export async function transitionCommerceFulfillment(input: {
  fulfillmentId: string;
  actorUserId: number;
  action: FulfillmentAction;
  idempotencyKey: string;
  detail?: Record<string, unknown>;
}) {
  const result = await database().query<{ state: string }>(
    `SELECT commerce.transition_fulfillment($1::uuid,$2,$3,$4::jsonb,$5) AS state`,
    [
      input.fulfillmentId,
      input.actorUserId,
      input.action,
      JSON.stringify(input.detail ?? {}),
      input.idempotencyKey,
    ],
  );
  return result.rows[0]?.state ?? "unknown";
}

type ExternalCommerceSecrets = Record<string, string>;

function externalCommerceSecrets(): ExternalCommerceSecrets {
  const raw = ENV.externalCommerceWebhookSecretsJson;
  if (!raw) return {};
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("external_commerce_webhook_secrets_invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("external_commerce_webhook_secrets_invalid");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 100) throw new Error("external_commerce_webhook_secrets_too_many");
  const result: ExternalCommerceSecrets = {};
  for (const [key, secret] of entries) {
    if (!/^[a-z][a-z0-9-]{2,63}$/.test(key) || typeof secret !== "string" || secret.length < 32) {
      throw new Error("external_commerce_webhook_secrets_invalid");
    }
    result[key] = secret;
  }
  return result;
}

function secureSignatureEquals(received: string | undefined, expected: string): boolean {
  const candidate = Buffer.from(`${received ?? ""}`.trim());
  const expectedBytes = Buffer.from(expected);
  return candidate.length === expectedBytes.length && timingSafeEqual(candidate, expectedBytes);
}

export async function ingestExternalCommerceWebhook(input: {
  connectionKey: string;
  externalEventId: string;
  eventType: "commerce.order.placed" | "commerce.order.cancelled" | "commerce.fulfillment.ready";
  signature: string | undefined;
  rawBody: Buffer;
  parsedBody: unknown;
}) {
  if (!ENV.externalCommerceIngressEnabled) {
    throw new Error("external_commerce_ingress_disabled");
  }
  if (!/^[a-z][a-z0-9-]{2,63}$/.test(input.connectionKey) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(input.externalEventId)) {
    throw new Error("external_commerce_event_identity_invalid");
  }
  if (!input.rawBody.length || !input.parsedBody || typeof input.parsedBody !== "object" || Array.isArray(input.parsedBody)) {
    throw new Error("external_commerce_event_payload_invalid");
  }
  const secret = externalCommerceSecrets()[input.connectionKey];
  if (!secret) throw new Error("external_commerce_connection_not_configured");
  const expected = `sha256=${createHmac("sha256", secret).update(input.rawBody).digest("hex")}`;
  if (!secureSignatureEquals(input.signature, expected)) throw new Error("external_commerce_signature_invalid");
  const result = await database().query<{ id: string }>(
    `SELECT commerce.ingest_external_platform_event($1,$2,$3,$4::jsonb,digest($5,'sha256')) AS id`,
    [input.connectionKey, input.externalEventId, input.eventType, JSON.stringify(input.parsedBody), input.rawBody],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error("external_commerce_ingestion_failed");
  return { id };
}

export async function registerExternalCommerceConnection(input: {
  actorUserId: number;
  providerId: number;
  connectionKey: string;
  platformName: string;
  inboundEnabled: boolean;
  outboundEnabled: boolean;
  inboundSigningSecretRef: string;
}) {
  const result = await database().query<{ id: string }>(
    `SELECT commerce.register_external_platform_connection($1,$2,$3,$4,$5,$6,$7) AS id`,
    [
      input.actorUserId,
      input.providerId,
      input.connectionKey,
      input.platformName,
      input.inboundEnabled,
      input.outboundEnabled,
      input.inboundSigningSecretRef,
    ],
  );
  return result.rows[0]?.id ?? "";
}

export async function assignCommerceFulfillmentDriver(input: {
  fulfillmentId: string;
  actorUserId: number;
  deliveryOrderId: number;
  driverId: number;
  idempotencyKey: string;
}) {
  const result = await database().query<{ state: string }>(
    `SELECT commerce.assign_fulfillment_delivery_driver($1::uuid,$2,$3,$4,$5) AS state`,
    [input.fulfillmentId, input.actorUserId, input.deliveryOrderId, input.driverId, input.idempotencyKey],
  );
  return result.rows[0]?.state ?? "unknown";
}

export async function upsertMedusaStoreConnection(input: {
  actorUserId: number;
  providerId: number;
  medusaStoreId: string;
  baseUrl: string;
  webhookSecretRef: string;
  active: boolean;
}) {
  await database().query(
    `SELECT commerce.upsert_medusa_store_connection($1,$2,$3,$4,$5,$6)`,
    [
      input.actorUserId,
      input.providerId,
      input.medusaStoreId,
      input.baseUrl,
      input.webhookSecretRef,
      input.active,
    ],
  );
}
