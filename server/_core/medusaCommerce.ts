import { createHmac, timingSafeEqual } from "crypto";
import { Pool } from "pg";
import { ENV } from "./env";

let pool: Pool | null = null;

function database() {
  if (!ENV.databaseUrl)
    throw new Error("medusa_commerce_database_unconfigured");
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

function storeSecrets() {
  if (!ENV.medusaStoreWebhookSecretsJson) return new Map<string, string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(ENV.medusaStoreWebhookSecretsJson);
  } catch {
    throw new Error("medusa_event_secrets_invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("medusa_event_secrets_invalid");
  const values = new Map<string, string>();
  for (const [storeId, secret] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/.test(storeId) ||
      typeof secret !== "string" ||
      secret.length < 32 ||
      secret.length > 4096
    )
      throw new Error("medusa_event_secrets_invalid");
    values.set(storeId, secret);
  }
  return values;
}

export function verifyMedusaWebhookSignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
) {
  const received = `${header ?? ""}`.trim();
  const normalized = received.startsWith("sha256=")
    ? received.slice(7)
    : received;
  if (!/^[a-f0-9]{64}$/i.test(normalized)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const candidate = Buffer.from(normalized, "hex");
  return (
    candidate.length === expected.length && timingSafeEqual(candidate, expected)
  );
}

export class MedusaCommerceError extends Error {}

export async function ingestMedusaWebhook(input: {
  storeId: string;
  eventId: string;
  eventType: string;
  rawBody: Buffer;
  signature: string | undefined;
}) {
  if (!ENV.medusaEventIngressEnabled)
    throw new MedusaCommerceError("medusa_event_ingress_disabled");
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/.test(input.storeId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(input.eventId)
  )
    throw new MedusaCommerceError("medusa_event_identity_invalid");
  if (
    ![
      "commerce.order.placed",
      "commerce.order.cancelled",
      "commerce.fulfillment.ready",
      "commerce.fulfillment.delivered",
    ].includes(input.eventType)
  )
    throw new MedusaCommerceError("medusa_event_type_invalid");
  let payload: unknown;
  try {
    payload = JSON.parse(input.rawBody.toString("utf8"));
  } catch {
    throw new MedusaCommerceError("medusa_event_json_invalid");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new MedusaCommerceError("medusa_event_json_invalid");
  const secret = storeSecrets().get(input.storeId);
  if (
    !secret ||
    !verifyMedusaWebhookSignature(input.rawBody, input.signature, secret)
  )
    throw new MedusaCommerceError("medusa_event_signature_invalid");
  const result = await database().query<{ id: string }>(
    `SELECT commerce.ingest_medusa_event_for_store($1,$2,$3,$4::jsonb,public.digest($5,'sha256')) AS id`,
    [
      input.storeId,
      input.eventId,
      input.eventType,
      JSON.stringify(payload),
      input.rawBody,
    ],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new MedusaCommerceError("medusa_event_ingestion_failed");
  return { id };
}
