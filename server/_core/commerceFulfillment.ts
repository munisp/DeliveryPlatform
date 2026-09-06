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
