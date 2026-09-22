import { createHash, randomBytes } from "crypto";
import type { PoolClient } from "pg";
import { Pool } from "pg";
import { ENV } from "./env";

type DeveloperScope =
  | "field_service:read"
  | "field_service:write"
  | "webhook:manage";

export type DeveloperIdentity = {
  apiKeyId: string;
  apiClientId: string;
  providerId: number | null;
  ownerUserId: number;
  scopes: DeveloperScope[];
};

let pool: Pool | null = null;

function database() {
  if (!ENV.databaseUrl) throw new Error("developer_api_database_unconfigured");
  if (!pool) {
    pool = new Pool({
      connectionString: ENV.databaseUrl,
      ssl:
        ENV.isProduction && !ENV.databaseUrl.includes("sslmode=disable")
          ? {
              rejectUnauthorized: true,
              ...(ENV.databaseSslCa ? { ca: ENV.databaseSslCa } : {}),
            }
          : false,
      // Bounded satellite pool (perf finding 10): capped at 5 connections.
      max: 5,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 30000,
      options: "-c statement_timeout=10000",
    });
  }
  return pool;
}

function one<T>(rows: T[], label: string): T {
  const row = rows[0];
  if (!row) throw new Error(`${label}_not_found`);
  return row;
}

function digest(value: string | Buffer) {
  return createHash("sha256").update(value).digest();
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const source = value as Record<string, unknown>;
  return `{${Object.keys(source)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(source[key])}`)
    .join(",")}}`;
}

function parseApiKey(rawValue: string): { prefix: string; secret: string } {
  const value = rawValue.trim();
  const match = /^((?:dpk_)[a-f0-9]{12})\.([A-Za-z0-9_-]{32,128})$/.exec(value);
  if (!match) throw new Error("developer_api_key_malformed");
  return { prefix: match[1], secret: match[2] };
}

export async function authenticateDeveloperApiKey(
  rawValue: string,
  requiredScope: DeveloperScope,
  client: PoolClient | Pool = database(),
): Promise<DeveloperIdentity> {
  const key = parseApiKey(rawValue);
  const result = await client.query<{
    api_key_id: string;
    api_client_id: string;
    provider_id: number | null;
    owner_user_id: number;
    scopes: DeveloperScope[];
  }>(`SELECT * FROM developer.authenticate_api_key($1,$2::bytea,$3)`, [
    key.prefix,
    digest(key.secret),
    requiredScope,
  ]);
  const row = one(result.rows, "developer_api_identity");
  return {
    apiKeyId: row.api_key_id,
    apiClientId: row.api_client_id,
    providerId: row.provider_id === null ? null : Number(row.provider_id),
    ownerUserId: Number(row.owner_user_id),
    scopes: row.scopes,
  };
}

export async function createDeveloperApiClient(input: {
  actorUserId: number;
  providerId: number;
  displayName: string;
}) {
  const result = await database().query<{ id: string }>(
    `SELECT developer.create_api_client($1,$2,$3) AS id`,
    [input.actorUserId, input.providerId, input.displayName],
  );
  return one(result.rows, "developer_api_client").id;
}

export async function createDeveloperApiKey(input: {
  actorUserId: number;
  apiClientId: string;
  scopes: DeveloperScope[];
  expiresAt: string | null;
}) {
  const prefix = `dpk_${randomBytes(6).toString("hex")}`;
  const secret = randomBytes(32).toString("base64url");
  const result = await database().query<{ id: string }>(
    `SELECT developer.create_api_key($1,$2::uuid,$3,$4::bytea,$5::text[],$6::timestamptz) AS id`,
    [
      input.actorUserId,
      input.apiClientId,
      prefix,
      digest(secret),
      input.scopes,
      input.expiresAt,
    ],
  );
  return {
    id: one(result.rows, "developer_api_key").id,
    key: `${prefix}.${secret}`,
  };
}

export async function listDeveloperApiClients(input: { actorUserId: number }) {
  const result = await database().query<{
    id: string;
    provider_id: number;
    display_name: string;
    state: string;
    created_at: string;
  }>(`SELECT * FROM developer.list_api_clients($1)`, [input.actorUserId]);
  return result.rows.map((row) => ({
    id: row.id,
    providerId: Number(row.provider_id),
    displayName: row.display_name,
    state: row.state,
    createdAt: row.created_at,
  }));
}

export async function listDeveloperApiKeys(input: {
  actorUserId: number;
  apiClientId: string;
}) {
  const result = await database().query<{
    id: string;
    key_prefix: string;
    scopes: DeveloperScope[];
    created_at: string;
    expires_at: string | null;
    revoked_at: string | null;
    last_used_at: string | null;
  }>(`SELECT * FROM developer.list_api_keys($1,$2::uuid)`, [
    input.actorUserId,
    input.apiClientId,
  ]);
  return result.rows.map((row) => ({
    id: row.id,
    keyPrefix: row.key_prefix,
    scopes: row.scopes,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
  }));
}

export async function listDeveloperWebhookEndpoints(input: {
  actorUserId: number;
  apiClientId: string;
}) {
  const result = await database().query<{
    id: string;
    url: string;
    event_types: string[];
    signing_secret_ref: string;
    active: boolean;
    created_at: string;
    disabled_at: string | null;
  }>(`SELECT * FROM developer.list_webhook_endpoints($1,$2::uuid)`, [
    input.actorUserId,
    input.apiClientId,
  ]);
  return result.rows.map((row) => ({
    id: row.id,
    url: row.url,
    eventTypes: row.event_types,
    signingSecretRef: row.signing_secret_ref,
    active: row.active,
    createdAt: row.created_at,
    disabledAt: row.disabled_at,
  }));
}

export async function revokeDeveloperApiKey(input: {
  actorUserId: number;
  apiKeyId: string;
}) {
  await database().query(`SELECT developer.revoke_api_key($1,$2::uuid)`, [
    input.actorUserId,
    input.apiKeyId,
  ]);
}

export async function createDeveloperWebhookEndpoint(input: {
  actorUserId: number;
  apiClientId: string;
  url: string;
  eventTypes: string[];
  signingSecretRef: string;
}) {
  const result = await database().query<{ id: string }>(
    `SELECT developer.create_webhook_endpoint($1,$2::uuid,$3,$4::text[],$5) AS id`,
    [
      input.actorUserId,
      input.apiClientId,
      input.url,
      input.eventTypes,
      input.signingSecretRef,
    ],
  );
  return one(result.rows, "developer_webhook_endpoint").id;
}

async function beginIdempotentRequest(
  client: PoolClient,
  identity: DeveloperIdentity,
  idempotencyKey: string,
  body: unknown,
) {
  const result = await client.query<{
    is_replay: boolean;
    response_status: number | null;
    response_body: Record<string, unknown> | null;
  }>(
    `SELECT * FROM developer.begin_idempotent_request($1::uuid,$2,$3::bytea)`,
    [identity.apiKeyId, idempotencyKey, digest(stableJson(body))],
  );
  return one(result.rows, "developer_idempotency");
}

async function completeIdempotentRequest(
  client: PoolClient,
  identity: DeveloperIdentity,
  idempotencyKey: string,
  status: number,
  body: Record<string, unknown>,
) {
  await client.query(
    `SELECT developer.complete_idempotent_request($1::uuid,$2,$3::smallint,$4::jsonb)`,
    [identity.apiKeyId, idempotencyKey, status, JSON.stringify(body)],
  );
}

export async function createPublicFieldServiceWorkOrder(input: {
  rawApiKey: string;
  idempotencyKey: string;
  customerId: number;
  serviceAreaId: string;
  title: string;
  description: string;
  serviceAddress: string;
  latitude: number | null;
  longitude: number | null;
  priority: "low" | "normal" | "high" | "urgent";
  scheduledStartAt: string | null;
  scheduledEndAt: string | null;
  sourceOrderId: number | null;
}) {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const identity = await authenticateDeveloperApiKey(
      input.rawApiKey,
      "field_service:write",
      client,
    );
    if (identity.providerId === null)
      throw new Error("developer_api_provider_scope_required");
    const replay = await beginIdempotentRequest(
      client,
      identity,
      input.idempotencyKey,
      input,
    );
    if (replay.is_replay) {
      await client.query("COMMIT");
      return {
        status: replay.response_status ?? 200,
        body: replay.response_body ?? {},
      };
    }
    const result = await client.query<{ id: string }>(
      `SELECT field_service.create_work_order($1,$2,$3::uuid,$4,$5,$6,$7,$8,$9::field_service.work_order_priority,$10::timestamptz,$11::timestamptz,$12,$13,$14) AS id`,
      [
        input.customerId,
        identity.providerId,
        input.serviceAreaId,
        input.title,
        input.description,
        input.serviceAddress,
        input.latitude,
        input.longitude,
        input.priority,
        input.scheduledStartAt,
        input.scheduledEndAt,
        input.sourceOrderId,
        identity.ownerUserId,
        input.idempotencyKey,
      ],
    );
    const body = {
      id: one(result.rows, "field_service_work_order").id,
      status: "requested",
    };
    await completeIdempotentRequest(
      client,
      identity,
      input.idempotencyKey,
      201,
      body,
    );
    await client.query("COMMIT");
    return { status: 201, body };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listPublicFieldServiceWorkOrders(input: {
  rawApiKey: string;
  limit: number;
  updatedBefore: string | null;
}) {
  const identity = await authenticateDeveloperApiKey(
    input.rawApiKey,
    "field_service:read",
  );
  const result = await database().query<{
    id: string;
    reference: string;
    state: string;
    priority: string;
    scheduled_start_at: string | null;
    scheduled_end_at: string | null;
    updated_at: string;
  }>(
    `SELECT * FROM developer.public_list_field_service_work_orders($1::uuid,$2,$3::timestamptz)`,
    [identity.apiClientId, input.limit, input.updatedBefore],
  );
  return result.rows.map((row) => ({
    id: row.id,
    reference: row.reference,
    state: row.state,
    priority: row.priority,
    scheduled_start_at: row.scheduled_start_at,
    scheduled_end_at: row.scheduled_end_at,
    updated_at: row.updated_at,
  }));
}

export async function getPublicFieldServiceWorkOrder(input: {
  rawApiKey: string;
  workOrderId: string;
}) {
  const identity = await authenticateDeveloperApiKey(
    input.rawApiKey,
    "field_service:read",
  );
  const result = await database().query<{ detail: Record<string, unknown> }>(
    `SELECT developer.public_field_service_work_order($1::uuid,$2::uuid) AS detail`,
    [identity.apiClientId, input.workOrderId],
  );
  return one(result.rows, "field_service_work_order").detail;
}

export function isDeveloperApiError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return /developer_api_key_malformed|developer_api_provider_scope_required|authentication failed|scope denied|invalid API authentication input|idempotency|not found|operator role required|invalid/.test(
    message,
  );
}
