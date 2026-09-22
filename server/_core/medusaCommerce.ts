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
      max: 5,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 30000,
      options: "-c statement_timeout=10000",
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

type InventoryLevelSnapshot = {
  inventory_level_id: string;
  stock_location_id: string;
  inventory_item_id: string;
  stocked_quantity: number;
  reserved_quantity: number;
  incoming_quantity: number;
  source_updated_at: string;
};

type ReservationSnapshot = {
  reservation_id: string;
  stock_location_id: string;
  inventory_item_id: string;
  order_id: string | null;
  quantity: number;
  state: "active" | "released";
  source_updated_at: string;
};

const MEDUSA_ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;

function inventorySnapshotId(
  value: unknown,
  field: string,
  nullable = false,
): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !MEDUSA_ENTITY_ID.test(value)) {
    throw new MedusaCommerceError(`medusa_inventory_${field}_invalid`);
  }
  return value;
}

function inventorySnapshotQuantity(
  value: unknown,
  field: string,
  positive = false,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (positive ? value <= 0 : value < 0)
  ) {
    throw new MedusaCommerceError(`medusa_inventory_${field}_invalid`);
  }
  return value;
}

function inventorySnapshotTimestamp(value: unknown): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new MedusaCommerceError("medusa_inventory_source_updated_at_invalid");
  }
  return value;
}

function inventorySnapshotData(
  payload: unknown,
  expectedType:
    | "commerce.inventory.level.snapshot"
    | "commerce.inventory.reservation.snapshot",
): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new MedusaCommerceError("medusa_event_json_invalid");
  }
  if ((payload as Record<string, unknown>).type !== expectedType) {
    throw new MedusaCommerceError("medusa_inventory_payload_type_mismatch");
  }
  const data = (payload as Record<string, unknown>).data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new MedusaCommerceError("medusa_inventory_snapshot_data_invalid");
  }
  return data as Record<string, unknown>;
}

export function parseInventoryLevelSnapshot(
  payload: unknown,
): InventoryLevelSnapshot {
  const data = inventorySnapshotData(
    payload,
    "commerce.inventory.level.snapshot",
  );
  return {
    inventory_level_id: inventorySnapshotId(
      data.inventory_level_id,
      "level_id",
    )!,
    stock_location_id: inventorySnapshotId(
      data.stock_location_id,
      "stock_location_id",
    )!,
    inventory_item_id: inventorySnapshotId(data.inventory_item_id, "item_id")!,
    stocked_quantity: inventorySnapshotQuantity(
      data.stocked_quantity,
      "stocked_quantity",
    ),
    reserved_quantity: inventorySnapshotQuantity(
      data.reserved_quantity,
      "reserved_quantity",
    ),
    incoming_quantity: inventorySnapshotQuantity(
      data.incoming_quantity,
      "incoming_quantity",
    ),
    source_updated_at: inventorySnapshotTimestamp(data.source_updated_at),
  };
}

export function parseReservationSnapshot(
  payload: unknown,
): ReservationSnapshot {
  const data = inventorySnapshotData(
    payload,
    "commerce.inventory.reservation.snapshot",
  );
  const state = data.state;
  if (state !== "active" && state !== "released") {
    throw new MedusaCommerceError("medusa_inventory_reservation_state_invalid");
  }
  return {
    reservation_id: inventorySnapshotId(data.reservation_id, "reservation_id")!,
    stock_location_id: inventorySnapshotId(
      data.stock_location_id,
      "stock_location_id",
    )!,
    inventory_item_id: inventorySnapshotId(data.inventory_item_id, "item_id")!,
    order_id: inventorySnapshotId(data.order_id, "order_id", true),
    quantity: inventorySnapshotQuantity(data.quantity, "quantity", true),
    state,
    source_updated_at: inventorySnapshotTimestamp(data.source_updated_at),
  };
}

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
      "commerce.inventory.level.snapshot",
      "commerce.inventory.reservation.snapshot",
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
  if (input.eventType === "commerce.inventory.level.snapshot") {
    const snapshot = parseInventoryLevelSnapshot(payload);
    const result = await database().query<{ applied: boolean }>(
      `SELECT applied
       FROM commerce.ingest_medusa_inventory_level_snapshot_for_store(
         $1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,public.digest($10,'sha256')
       )`,
      [
        input.storeId,
        input.eventId,
        snapshot.inventory_level_id,
        snapshot.stock_location_id,
        snapshot.inventory_item_id,
        snapshot.stocked_quantity,
        snapshot.reserved_quantity,
        snapshot.incoming_quantity,
        snapshot.source_updated_at,
        input.rawBody,
      ],
    );
    if (result.rows.length !== 1)
      throw new MedusaCommerceError("medusa_inventory_level_ingestion_failed");
    return { id: input.eventId };
  }

  if (input.eventType === "commerce.inventory.reservation.snapshot") {
    const snapshot = parseReservationSnapshot(payload);
    const result = await database().query<{ applied: boolean }>(
      `SELECT applied
       FROM commerce.ingest_medusa_inventory_reservation_snapshot_for_store(
         $1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,public.digest($10,'sha256')
       )`,
      [
        input.storeId,
        input.eventId,
        snapshot.reservation_id,
        snapshot.stock_location_id,
        snapshot.inventory_item_id,
        snapshot.order_id,
        snapshot.quantity,
        snapshot.state,
        snapshot.source_updated_at,
        input.rawBody,
      ],
    );
    if (result.rows.length !== 1)
      throw new MedusaCommerceError(
        "medusa_inventory_reservation_ingestion_failed",
      );
    return { id: input.eventId };
  }

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
