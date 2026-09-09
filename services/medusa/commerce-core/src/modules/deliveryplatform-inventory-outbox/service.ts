import { createHash, createHmac, randomUUID } from "crypto";
import { Pool, type PoolClient } from "pg";

const MAX_ATTEMPTS = 16;
const DEFAULT_CLAIM_LIMIT = 2;
const MAX_CLAIM_LIMIT = 25;
const DEFAULT_LEASE_MILLISECONDS = 45_000;
const DEFAULT_DELIVERY_TIMEOUT_MILLISECONDS = 10_000;
const DELIVERY_COMPLETION_SAFETY_MILLISECONDS = 5_000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;

type InventoryOutboxRuntimeConfig = {
  poolMax: number;
  claimLimit: number;
  leaseMilliseconds: number;
  deliveryTimeoutMilliseconds: number;
  applicationName: string;
};

function boundedInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`${name} must be an integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function inventoryOutboxRuntimeConfig(): InventoryOutboxRuntimeConfig {
  const leaseMilliseconds = boundedInteger(
    "MEDUSA_INVENTORY_OUTBOX_LEASE_MS",
    DEFAULT_LEASE_MILLISECONDS,
    15_000,
    300_000,
  );
  const deliveryTimeoutMilliseconds = boundedInteger(
    "MEDUSA_INVENTORY_OUTBOX_DELIVERY_TIMEOUT_MS",
    DEFAULT_DELIVERY_TIMEOUT_MILLISECONDS,
    1_000,
    15_000,
  );
  const safeSequentialMaximum = Math.floor(
    (leaseMilliseconds - DELIVERY_COMPLETION_SAFETY_MILLISECONDS) /
      deliveryTimeoutMilliseconds,
  );
  if (safeSequentialMaximum < 1) {
    throw new Error(
      "MEDUSA_INVENTORY_OUTBOX_LEASE_MS is too short for the configured delivery timeout",
    );
  }
  const requestedClaimLimit = boundedInteger(
    "MEDUSA_INVENTORY_OUTBOX_CLAIM_LIMIT",
    DEFAULT_CLAIM_LIMIT,
    1,
    MAX_CLAIM_LIMIT,
  );
  const applicationRole =
    process.env.MEDUSA_PROCESS_ROLE?.trim().toLowerCase() || "shared";
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(applicationRole)) {
    throw new Error("MEDUSA_PROCESS_ROLE must be a bounded lowercase role name");
  }
  return {
    poolMax: boundedInteger("MEDUSA_INVENTORY_OUTBOX_POOL_MAX", 4, 1, 16),
    claimLimit: Math.min(requestedClaimLimit, safeSequentialMaximum),
    leaseMilliseconds,
    deliveryTimeoutMilliseconds,
    applicationName: `deliveryplatform-medusa-inventory-outbox-${applicationRole}`,
  };
}

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

export type InventoryOutboxMetrics = {
  readyUnits: number;
  processingUnits: number;
  expiredLeaseUnits: number;
  deadLetterUnits: number;
  oldestReadySeconds: number;
  poolTotal: number;
  poolIdle: number;
  poolWaiting: number;
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
  private readonly runtime: InventoryOutboxRuntimeConfig;

  constructor({ logger }: { logger: Logger }) {
    this.logger = logger;
    this.runtime = inventoryOutboxRuntimeConfig();
    this.pool = new Pool({
      connectionString: requiredEnvironment("MEDUSA_DATABASE_URL"),
      max: this.runtime.poolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      application_name: this.runtime.applicationName,
    });
    this.pool.on("error", (error) => {
      this.logger.error(
        `DeliveryPlatform inventory outbox PostgreSQL pool error: ${error.message}`,
      );
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
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
      [this.runtime.claimLimit, this.runtime.leaseMilliseconds],
    );
    return result.rows.map((row) => ({
      id: row.id,
      eventType: row.event_type,
      payload: validateInventoryPayload(row.payload),
      claimToken: row.claim_token,
      attempts: row.attempts,
    }));
  }

  private async complete(event: ClaimedEvent): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE deliveryplatform_inventory_outbox
       SET state = 'delivered', claim_token = NULL, lease_expires_at = NULL,
           delivered_at = now(), last_error = NULL, updated_at = now()
       WHERE id = $1 AND state = 'processing' AND claim_token = $2 AND lease_expires_at > now()`,
      [event.id, event.claimToken],
    );
    return result.rowCount === 1;
  }

  private async fail(event: ClaimedEvent, error: unknown): Promise<boolean> {
    const description =
      error instanceof Error
        ? error.message.slice(0, 1000)
        : "unknown delivery error";
    const terminal = event.attempts >= MAX_ATTEMPTS;
    const result = await this.pool.query(
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

  async metrics(): Promise<InventoryOutboxMetrics> {
    const result = await this.pool.query<{
      ready_units: string;
      processing_units: string;
      expired_lease_units: string;
      dead_letter_units: string;
      oldest_ready_seconds: string;
    }>(`
      SELECT
        count(*) FILTER (WHERE state = 'pending' AND next_attempt_at <= now())::text AS ready_units,
        count(*) FILTER (WHERE state = 'processing')::text AS processing_units,
        count(*) FILTER (WHERE state = 'processing' AND lease_expires_at <= now())::text AS expired_lease_units,
        count(*) FILTER (WHERE state = 'dead_letter')::text AS dead_letter_units,
        coalesce(
          greatest(0, extract(epoch FROM now() - min(created_at) FILTER (
            WHERE state = 'pending' AND next_attempt_at <= now()
          )))::bigint,
          0
        )::text AS oldest_ready_seconds
      FROM deliveryplatform_inventory_outbox
    `);
    const row = result.rows[0];
    if (!row) throw new Error("inventory outbox metrics query returned no row");
    const parseMetric = (value: string, name: string): number => {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error(`${name} must be a non-negative safe integer`);
      }
      return parsed;
    };
    return {
      readyUnits: parseMetric(row.ready_units, "ready_units"),
      processingUnits: parseMetric(row.processing_units, "processing_units"),
      expiredLeaseUnits: parseMetric(row.expired_lease_units, "expired_lease_units"),
      deadLetterUnits: parseMetric(row.dead_letter_units, "dead_letter_units"),
      oldestReadySeconds: parseMetric(row.oldest_ready_seconds, "oldest_ready_seconds"),
      poolTotal: this.pool.totalCount,
      poolIdle: this.pool.idleCount,
      poolWaiting: this.pool.waitingCount,
    };
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
      signal: AbortSignal.timeout(this.runtime.deliveryTimeoutMilliseconds),
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
    let events: ClaimedEvent[];
    try {
      await client.query("BEGIN");
      events = await this.claim(client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    let delivered = 0;
      let failed = 0;
      let stale = 0;
    for (const event of events) {
      try {
        await this.deliver(event);
        if (await this.complete(event)) delivered += 1;
        else stale += 1;
      } catch (error) {
        if (await this.fail(event, error)) failed += 1;
        else stale += 1;
        this.logger.error(
          `DeliveryPlatform inventory outbox delivery failed for ${event.id}: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
    }
    return { claimed: events.length, delivered, failed, stale };
  }
}
