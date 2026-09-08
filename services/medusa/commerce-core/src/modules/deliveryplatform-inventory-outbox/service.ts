import { createHash, createHmac, randomUUID } from "crypto";
import { Pool, type PoolClient } from "pg";

const MAX_ATTEMPTS = 16;
const CLAIM_LIMIT = 50;
const LEASE_MILLISECONDS = 30_000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;

type Logger = {
  info(message: string): void;
  error(message: string): void;
  warn(message: string): void;
};

type InventoryLevelPayload = {
  inventory_level_id: string;
  stock_location_id: string;
  inventory_item_id: string;
  stocked_quantity: number;
  reserved_quantity: number;
  incoming_quantity: number;
  source_updated_at: string;
};

type ReservationPayload = {
  reservation_id: string;
  stock_location_id: string;
  inventory_item_id: string;
  order_id: string | null;
  quantity: number;
  state: "active" | "released";
  source_updated_at: string;
};

export type DeliveryPlatformInventoryPayload =
  | { type: "commerce.inventory.level.snapshot"; data: InventoryLevelPayload }
  | {
      type: "commerce.inventory.reservation.snapshot";
      data: ReservationPayload;
    };

type ClaimedEvent = {
  id: string;
  eventType: DeliveryPlatformInventoryPayload["type"];
  payload: DeliveryPlatformInventoryPayload;
  claimToken: string;
  attempts: number;
};

type OutboxRow = {
  id: string;
  event_type: ClaimedEvent["eventType"];
  payload: DeliveryPlatformInventoryPayload;
  claim_token: string;
  attempts: number;
};

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assertBoundedId(
  value: unknown,
  field: string,
  nullable = false,
): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new Error(`${field} must be a bounded Medusa identifier`);
  }
  return value;
}

function assertFiniteNonNegative(
  value: unknown,
  field: string,
  allowZero = true,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (allowZero ? value < 0 : value <= 0)
  ) {
    throw new Error(
      `${field} must be ${allowZero ? "non-negative" : "positive"} and finite`,
    );
  }
  return value;
}

function assertIsoTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`${field} must be an ISO-8601 timestamp`);
  }
  return value;
}

export function validateInventoryPayload(
  payload: DeliveryPlatformInventoryPayload,
): DeliveryPlatformInventoryPayload {
  if (!payload || typeof payload !== "object")
    throw new Error("inventory bridge payload must be an object");
  if (payload.type === "commerce.inventory.level.snapshot") {
    return {
      type: payload.type,
      data: {
        inventory_level_id: assertBoundedId(
          payload.data.inventory_level_id,
          "inventory_level_id",
        )!,
        stock_location_id: assertBoundedId(
          payload.data.stock_location_id,
          "stock_location_id",
        )!,
        inventory_item_id: assertBoundedId(
          payload.data.inventory_item_id,
          "inventory_item_id",
        )!,
        stocked_quantity: assertFiniteNonNegative(
          payload.data.stocked_quantity,
          "stocked_quantity",
        ),
        reserved_quantity: assertFiniteNonNegative(
          payload.data.reserved_quantity,
          "reserved_quantity",
        ),
        incoming_quantity: assertFiniteNonNegative(
          payload.data.incoming_quantity,
          "incoming_quantity",
        ),
        source_updated_at: assertIsoTimestamp(
          payload.data.source_updated_at,
          "source_updated_at",
        ),
      },
    };
  }
  if (payload.type === "commerce.inventory.reservation.snapshot") {
    if (payload.data.state !== "active" && payload.data.state !== "released") {
      throw new Error("reservation state must be active or released");
    }
    return {
      type: payload.type,
      data: {
        reservation_id: assertBoundedId(
          payload.data.reservation_id,
          "reservation_id",
        )!,
        stock_location_id: assertBoundedId(
          payload.data.stock_location_id,
          "stock_location_id",
        )!,
        inventory_item_id: assertBoundedId(
          payload.data.inventory_item_id,
          "inventory_item_id",
        )!,
        order_id: assertBoundedId(payload.data.order_id, "order_id", true),
        quantity: assertFiniteNonNegative(
          payload.data.quantity,
          "quantity",
          false,
        ),
        state: payload.data.state,
        source_updated_at: assertIsoTimestamp(
          payload.data.source_updated_at,
          "source_updated_at",
        ),
      },
    };
  }
  throw new Error("unsupported inventory bridge event type");
}

export function inventorySourceEventKey(
  payload: DeliveryPlatformInventoryPayload,
): string {
  const normalized = validateInventoryPayload(payload);
  const canonicalPayload = JSON.stringify(normalized);
  return `deliveryplatform:${createHash("sha256").update(canonicalPayload).digest("hex")}`;
}

export function inventoryBackoff(attempts: number, eventId: string): number {
  const boundedAttempt = Math.max(1, Math.min(attempts, MAX_ATTEMPTS));
  let digest = 0;
  for (let i = 0; i < eventId.length; i += 1)
    digest = (digest * 31 + eventId.charCodeAt(i)) >>> 0;
  const base = Math.min(300_000, 1_000 * 2 ** (boundedAttempt - 1));
  return base + (digest % 1_000);
}

export default class DeliveryPlatformInventoryOutboxService {
  private readonly pool: Pool;
  private readonly logger: Logger;

  constructor({ logger }: { logger: Logger }) {
    this.logger = logger;
    this.pool = new Pool({
      connectionString: requiredEnvironment("MEDUSA_DATABASE_URL"),
      max: 8,
      idleTimeoutMillis: 30_000,
      application_name: "deliveryplatform-medusa-inventory-outbox",
    });
  }

  async enqueue(payload: DeliveryPlatformInventoryPayload): Promise<string> {
    const normalized = validateInventoryPayload(payload);
    const sourceEventKey = inventorySourceEventKey(normalized);
    const id = randomUUID();
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO deliveryplatform_inventory_outbox (
         id, source_event_key, event_type, payload, source_occurred_at
       ) VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz)
       ON CONFLICT (source_event_key) DO UPDATE
       SET source_event_key = EXCLUDED.source_event_key
       RETURNING id`,
      [
        id,
        sourceEventKey,
        normalized.type,
        JSON.stringify(normalized),
        normalized.data.source_updated_at,
      ],
    );
    const outboxId = result.rows[0]?.id;
    if (!outboxId)
      throw new Error("failed to persist Medusa inventory outbox event");
    return outboxId;
  }

  async enqueueReleasedReservation(
    reservationId: string,
    sourceUpdatedAt: string,
  ): Promise<string> {
    const boundedReservationId = assertBoundedId(
      reservationId,
      "reservation_id",
    )!;
    const timestamp = assertIsoTimestamp(sourceUpdatedAt, "source_updated_at");
    const result = await this.pool.query<{
      payload: DeliveryPlatformInventoryPayload;
    }>(
      `SELECT payload
       FROM deliveryplatform_inventory_outbox
       WHERE event_type = 'commerce.inventory.reservation.snapshot'
         AND payload->'data'->>'reservation_id' = $1
       ORDER BY source_occurred_at DESC, created_at DESC
       LIMIT 1`,
      [boundedReservationId],
    );
    const prior = result.rows[0]?.payload;
    if (!prior || prior.type !== "commerce.inventory.reservation.snapshot") {
      throw new Error(
        `cannot release reservation ${boundedReservationId}: no prior hydrated snapshot`,
      );
    }
    return this.enqueue({
      type: "commerce.inventory.reservation.snapshot",
      data: {
        ...prior.data,
        reservation_id: boundedReservationId,
        state: "released",
        source_updated_at: timestamp,
      },
    });
  }

  private async claim(client: PoolClient): Promise<ClaimedEvent[]> {
    const result = await client.query<OutboxRow>(
      `WITH candidates AS (
         SELECT id
         FROM deliveryplatform_inventory_outbox
         WHERE (state = 'pending' AND next_attempt_at <= now())
            OR (state = 'processing' AND lease_expires_at <= now())
         ORDER BY next_attempt_at ASC, created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       UPDATE deliveryplatform_inventory_outbox o
       SET state = 'processing',
           claim_token = gen_random_uuid(),
           lease_expires_at = now() + ($2::bigint * interval '1 millisecond'),
           attempts = o.attempts + 1,
           updated_at = now()
       FROM candidates
       WHERE o.id = candidates.id
       RETURNING o.id, o.event_type, o.payload, o.claim_token, o.attempts`,
      [CLAIM_LIMIT, LEASE_MILLISECONDS],
    );
    return result.rows.map((row) => ({
      id: row.id,
      eventType: row.event_type,
      payload: validateInventoryPayload(row.payload),
      claimToken: row.claim_token,
      attempts: row.attempts,
    }));
  }

  private async complete(
    client: PoolClient,
    event: ClaimedEvent,
  ): Promise<boolean> {
    const result = await client.query(
      `UPDATE deliveryplatform_inventory_outbox
       SET state = 'delivered', claim_token = NULL, lease_expires_at = NULL,
           delivered_at = now(), last_error = NULL, updated_at = now()
       WHERE id = $1 AND state = 'processing' AND claim_token = $2 AND lease_expires_at > now()`,
      [event.id, event.claimToken],
    );
    return result.rowCount === 1;
  }

  private async fail(
    client: PoolClient,
    event: ClaimedEvent,
    error: unknown,
  ): Promise<boolean> {
    const description =
      error instanceof Error
        ? error.message.slice(0, 1000)
        : "unknown delivery error";
    const terminal = event.attempts >= MAX_ATTEMPTS;
    const result = await client.query(
      `UPDATE deliveryplatform_inventory_outbox
       SET state = CASE WHEN $3 THEN 'dead_letter' ELSE 'pending' END,
           claim_token = NULL,
           lease_expires_at = NULL,
           next_attempt_at = CASE
             WHEN $3 THEN next_attempt_at
             ELSE now() + ($4::bigint * interval '1 millisecond')
           END,
           last_error = $5,
           updated_at = now()
       WHERE id = $1 AND state = 'processing' AND claim_token = $2 AND lease_expires_at > now()`,
      [
        event.id,
        event.claimToken,
        terminal,
        inventoryBackoff(event.attempts, event.id),
        description,
      ],
    );
    return result.rowCount === 1;
  }

  private async deliver(event: ClaimedEvent): Promise<void> {
    const ingressUrl = requiredEnvironment(
      "DELIVERYPLATFORM_MEDUSA_INGRESS_URL",
    );
    const storeId = requiredEnvironment("MEDUSA_STORE_ID");
    const secret = requiredEnvironment(
      "DELIVERYPLATFORM_MEDUSA_WEBHOOK_SECRET",
    );
    const body = JSON.stringify(event.payload);
    const response = await fetch(ingressUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Medusa-Store-Id": storeId,
        "X-Medusa-Event-Id": `medusa-${event.id}`,
        "X-Medusa-Event-Type": event.eventType,
        "X-Medusa-Signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 202) {
      const responseText = (await response.text()).slice(0, 512);
      throw new Error(
        `DeliveryPlatform inventory ingress returned ${response.status}: ${responseText}`,
      );
    }
  }

  async deliverPending(): Promise<{
    claimed: number;
    delivered: number;
    failed: number;
    stale: number;
  }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const events = await this.claim(client);
      await client.query("COMMIT");
      let delivered = 0;
      let failed = 0;
      let stale = 0;
      for (const event of events) {
        try {
          await this.deliver(event);
          if (await this.complete(client, event)) delivered += 1;
          else stale += 1;
        } catch (error) {
          if (await this.fail(client, event, error)) failed += 1;
          else stale += 1;
          this.logger.error(
            `DeliveryPlatform inventory outbox delivery failed for ${event.id}: ${error instanceof Error ? error.message : "unknown error"}`,
          );
        }
      }
      return { claimed: events.length, delivered, failed, stale };
    } finally {
      client.release();
    }
  }
}
